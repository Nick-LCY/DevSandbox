#!/usr/bin/env python3
"""三期打样探针（P1 / P3）：免 root 守护进程下的端口发布与转发镜像拉取判定。

探针环境完全复用核心包既有机制：

- ``UserSpaceManager``：探针用户、子 UID/GID 段、systemd 用户单元、linger 保活；
- ``RegistryProxyManager``：统一镜像代理的拉起与探活、合并 CA 束安装；
- ``UserDaemon``：以探针用户身份操作免 root 守护进程（docker / systemctl --user）；
- ``ImageManager``：镜像经统一镜像代理拉取（失败才回退宿主注入）。

判定口径：

- **P1**：免 root 守护进程下 ``docker run -p 127.0.0.1:<宿主端口>:<容器端口>``，
  判据是「宿主 ``ss -ltn`` 出现该端口」且「宿主 ``curl 127.0.0.1:<端口>``
  能连到容器内目标服务」。不成立时用 ``fallback-b`` 验证备案路径：
  转发容器不发布端口，宿主侧用 ``docker exec -i <容器> socat - TCP:<目标>:<端口>``
  建立双向字节流。
- **P3**：转发镜像（``alpine/socat``，钉 digest）能否经统一镜像代理拉进
  探针用户的免 root 守护进程。

用法（仓库根目录执行）::

    uv run --project apps/core python apps/desktop/scripts/probe_rootless_port_forward.py setup
    uv run --project apps/core python apps/desktop/scripts/probe_rootless_port_forward.py p3
    uv run --project apps/core python apps/desktop/scripts/probe_rootless_port_forward.py p1
    uv run --project apps/core python apps/desktop/scripts/probe_rootless_port_forward.py fallback-b
    uv run --project apps/core python apps/desktop/scripts/probe_rootless_port_forward.py teardown
"""

from __future__ import annotations

import argparse
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
CORE_SRC = REPO_ROOT / "apps" / "core" / "src"
if str(CORE_SRC) not in sys.path:  # 允许直接 `python apps/desktop/scripts/...` 执行
    sys.path.insert(0, str(CORE_SRC))

from sandbox_platform.command import CommandResult, run  # noqa: E402
from sandbox_platform.config import PlatformConfig  # noqa: E402
from sandbox_platform.daemon import UserContext, UserDaemon  # noqa: E402
from sandbox_platform.errors import CommandError  # noqa: E402
from sandbox_platform.images import ImageManager  # noqa: E402
from sandbox_platform.proxy import RegistryProxyManager  # noqa: E402
from sandbox_platform.userspace import UserSpaceManager  # noqa: E402

# ---------------------------------------------------------------- 探针常量
PROBE_USER = "fwdprobe"
PROBE_NET = "probe-fwd-net"
C_SANDBOX = "probe-sandbox"
C_FWD = "probe-fwd"
SANDBOX_PORT = 8080
FWD_PORT = 8080
HOST_PORT_RANGE = (18000, 18999)

# 命令超时的统一退出码（与核心包 command.run 的约定一致：124）
TIMEOUT_RC = 124

# 「沙箱侧」容器里的 HTTP 响应器命令：socat 的 EXEC 形态，每来一条连接吐一份预置响应。
# 用它代替 busybox httpd：alpine/socat 的 busybox 没编 httpd。
SANDBOX_HTTP_COMMAND = (
    "printf 'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\n"
    "Content-Length: 8\\r\\nConnection: close\\r\\n\\r\\nprobe-ok\\n' > /tmp/resp; "
    "exec socat TCP-LISTEN:8080,fork,reuseaddr EXEC:'/bin/cat /tmp/resp'"
)

# 转发镜像：alpine/socat 1.8.1.3，digest 由 registry API 核对（见 RESULTS.md）
FWD_IMAGE = (
    "alpine/socat:1.8.1.3@sha256:"
    "466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed"
)


def section(title: str) -> None:
    """打印一个小节标题。"""
    print()
    print(f"===== {title} =====", flush=True)


def show(title: str, text: str) -> None:
    """原样打印一段命令输出（留档用）。"""
    print(f"--- {title} ---", flush=True)
    print(text.rstrip(), flush=True)


def host_command(argv: list[str], timeout: int = 60) -> subprocess.CompletedProcess[str]:
    """在宿主上执行一条命令并回收输出。

    超时不算异常：转成退出码 :data:`TIMEOUT_RC` 的失败结果，让调用方按
    「这一步没做出来」处理（记现象 → 输出「不成立」裁决），而不是让整轮
    以 traceback 收场——「不成立时也要有备案裁决」是探针的设计意图。
    """
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        return subprocess.CompletedProcess(
            argv,
            TIMEOUT_RC,
            _decode_stream(exc.stdout),
            _decode_stream(exc.stderr),
        )


def _decode_stream(value: str | bytes | None) -> str:
    """把超时异常里的输出统一成文本（subprocess 在文本模式下给的也可能是字节）。"""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def now_rfc3339() -> str:
    """当前时刻的 RFC3339 文本（用于按时间窗取代理访问日志）。"""
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def daemon_docker(
    daemon: UserDaemon,
    argv: list[str],
    *,
    timeout: int = 600,
) -> CommandResult:
    """执行守护进程侧 docker 命令。

    超时（核心包把 :class:`subprocess.TimeoutExpired` 转成 :class:`CommandError`）
    或命令缺失时抛 :class:`RuntimeError`：这属于**环境问题**，必须直接报错退出，
    不能让它一路走到「主路径不成立」的裁决。
    """
    try:
        return daemon.docker(argv, check=False, timeout=timeout)
    except CommandError as exc:
        raise RuntimeError(f"守护进程侧命令失败（超时或命令缺失）：{exc}") from exc


def privileged_run(argv: list[str]) -> CommandResult:
    """执行一条宿主命令；超时 / 命令缺失转成失败结果，不抛异常。

    回收环节要的是「做完没有」的结论，不是异常栈：某一步超时也要把剩下的
    回收动作跑完并如实报出来。
    """
    try:
        return run(argv, check=False)
    except CommandError as exc:
        return CommandResult(
            argv=tuple(exc.argv),
            returncode=exc.returncode,
            stdout=exc.stdout,
            stderr=exc.stderr or str(exc),
        )


def pick_host_port(start: int, end: int) -> int:
    """在给定区间里挑一个当前可绑定的宿主回环端口。"""
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    raise RuntimeError(f"{start}~{end} 区间内没有空闲端口")


class Probe:
    """探针环境（用户 + 守护进程 + 代理）的操作入口。"""

    def __init__(self) -> None:
        self.config = PlatformConfig.from_env()
        self.userspace = UserSpaceManager(self.config)
        self.proxy = RegistryProxyManager(self.config)
        self.images = ImageManager(self.config)
        self.user = self.userspace.lookup_user(PROBE_USER)
        self.daemon: UserDaemon | None = None
        if self.user is not None:
            self.daemon = UserDaemon(
                UserContext(
                    user=self.user.name,
                    uid=self.user.uid,
                    gid=self.user.gid,
                    home=self.user.home,
                )
            )

    # ---------------------------------------------------------------- 搭建
    def setup(self) -> None:
        """建探针用户、子 ID 段、合并 CA 束、systemd 用户单元并启动守护进程。"""
        section("探针环境搭建")
        user = self.userspace.ensure_user(PROBE_USER)
        self.user = user
        print(f"探针用户：{user.name}（uid={user.uid} gid={user.gid}，家目录 {user.home}）")

        subid = self.userspace.allocate_subid_range(PROBE_USER)
        print(f"子 UID/GID 段：{subid.start}:{subid.length}（{subid.start}~{subid.end}）")

        section("统一镜像代理（核心包 RegistryProxyManager）")
        ready = self.proxy.ensure_running(timeout=120)
        status = self.proxy.status()
        print(f"代理容器：{self.proxy.container_name}")
        print(f"代理健康：{status.healthy}（tcp={status.tcp_ok} ca={status.ca_fetchable}）")
        print(f"代理明细：{status.detail}")
        print(f"代理地址：{status.proxy_url}")
        print(f"证书就绪：{status.certificate_ready}")
        print(f"缓存占用：{status.cache_size_bytes} 字节")
        if not ready:
            raise RuntimeError("统一镜像代理未就绪，后续拉取会失败")

        bundle = self.proxy.install_ca_bundle(user)
        print(f"合并 CA 束已安装：{bundle}")

        unit_path = self.userspace.write_docker_unit(user)
        print(f"systemd 用户单元已写入：{unit_path}")

        linger = self.userspace.enable_linger(PROBE_USER)
        print(f"linger 保活：{'已开启' if linger else '开启失败'}")

        self.daemon = UserDaemon(
            UserContext(user=user.name, uid=user.uid, gid=user.gid, home=user.home)
        )
        assert self.daemon is not None
        self._wait_user_bus(user.uid)
        show(
            "systemctl --user daemon-reload",
            self.daemon.systemctl(["daemon-reload"]).output,
        )
        show(
            "systemctl --user enable docker.service",
            self.daemon.systemctl(["enable", "docker.service"]).output,
        )
        show(
            "systemctl --user start docker.service",
            self.daemon.systemctl(["start", "docker.service"]).output,
        )
        if not self._wait_socket(user.uid):
            show(
                "systemctl --user status docker.service",
                self.daemon.systemctl(["status", "docker.service", "--no-pager"]).output,
            )
            raise RuntimeError("免 root 守护进程未就绪")
        print(f"免 root 守护进程就绪，套接字：{self.daemon.context.socket_path}")

    def _wait_user_bus(self, uid: int, timeout: int = 90) -> None:
        """等用户级 systemd 起来（linger 生效后由 user@<uid>.service 拉起）。

        只等 ``/run/user/<uid>`` 出现不够：目录先建、总线套接字后到，
        早一步发 systemctl 会得到「Failed to connect to user scope bus」。
        """
        assert self.daemon is not None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            probe = self.daemon.systemctl(["show", "--property=Version"], check=False)
            if probe.ok and probe.stdout.strip():
                print(f"用户级 systemd 就绪：{probe.stdout.strip()}")
                return
            time.sleep(1)
        raise RuntimeError(f"/run/user/{uid} 的用户级 systemd 总线未就绪")

    def _wait_socket(self, uid: int, timeout: int = 90) -> bool:
        """等免 root 守护进程套接字就绪。"""
        assert self.daemon is not None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.daemon.socket_ready():
                return True
            time.sleep(1)
        return False

    def require_daemon(self) -> UserDaemon:
        """取出守护进程操作入口（未搭建则报错）。"""
        if self.daemon is None:
            raise RuntimeError("探针守护进程未搭建，请先执行 setup")
        return self.daemon

    # ---------------------------------------------------------------- 环境信息
    def environment_report(self) -> None:
        """打印版本、守护进程环境变量与 docker info 的网络相关字段。"""
        daemon = self.require_daemon()
        section("环境信息")

        show(
            "宿主 docker version（server）",
            host_command(["docker", "version", "--format", "{{.Server.Version}}"]).stdout.strip(),
        )
        show(
            "rootlesskit 版本",
            host_command(["rootlesskit", "--version"]).stdout.strip(),
        )
        show(
            "dockerd-rootless.sh 版本",
            host_command(["dockerd-rootless.sh", "--version"]).stdout.strip(),
        )
        show(
            "免 root 守护进程版本（docker version --format '{{.Server.Version}}'）",
            daemon.docker(["version", "--format", "{{.Server.Version}}"]).stdout.strip(),
        )
        show(
            "守护进程单元环境变量（systemctl --user show docker --property=Environment）",
            daemon.systemctl(["show", "docker.service", "--property=Environment"]).stdout.strip(),
        )
        show(
            "守护进程单元关键属性（Delegate / SubState / FragmentPath）",
            daemon.systemctl(
                [
                    "show",
                    "docker.service",
                    "--property=Delegate",
                    "--property=SubState",
                    "--property=FragmentPath",
                ]
            ).stdout.strip(),
        )
        info = daemon.docker(["info"]).stdout
        print("--- docker info（网络与网络相关字段摘录）---")
        for line in info.splitlines():
            lowered = line.lower()
            if any(
                key in lowered
                for key in (
                    "server version",
                    "root dir",
                    "storage driver",
                    "cgroup",
                    "network",
                    "proxy",
                    "docker root dir",
                    "name:",
                )
            ):
                print(line.rstrip())

    # ---------------------------------------------------------------- P3
    def p3(self) -> None:
        """P3：转发镜像经统一镜像代理拉进免 root 守护进程。"""
        daemon = self.require_daemon()
        section("P3：转发镜像经统一镜像代理拉取")

        print(f"目标镜像引用（tag + digest 钉版）：{FWD_IMAGE}")
        already = daemon.image_exists(FWD_IMAGE)
        print(f"拉取前守护进程里是否已有该镜像：{already}")
        if already:
            show(
                "docker rmi（先清掉上一轮留下的镜像，保证这次是干净拉取）",
                daemon.docker(["rmi", FWD_IMAGE], timeout=300).output,
            )

        before = self.proxy.status().cache_size_bytes
        print(f"拉取前代理缓存占用：{before} 字节")

        first_since = now_rfc3339()
        show(
            "免 root 守护进程 docker pull（经统一镜像代理）",
            daemon_docker(daemon, ["pull", FWD_IMAGE], timeout=900).output,
        )
        exists = daemon.image_exists(FWD_IMAGE)
        print(f"拉取后守护进程里是否有该镜像：{exists}")
        if not exists:
            raise RuntimeError(f"拉取后守护进程里没有该镜像：{FWD_IMAGE}")
        show(
            "镜像详情（docker image inspect）",
            daemon_docker(
                daemon,
                [
                    "image",
                    "inspect",
                    FWD_IMAGE,
                    "--format",
                    # Go template 不认 \n，要换行得用 {{println}}（\n 会被原样打印）
                    "Id={{.Id}}{{println}}RepoDigests={{json .RepoDigests}}{{println}}Size={{.Size}}",
                ],
            ).stdout.strip(),
        )
        after = self.proxy.status().cache_size_bytes
        print(f"拉取后代理缓存占用：{after} 字节（增量 {after - before} 字节）")

        section("P3：代理命中情况（代理容器访问日志摘录）")
        print("【首次拉取】")
        first_hits = self._proxy_image_lines(since=first_since)
        print(f"首次拉取时间窗内的代理条目数：{len(first_hits)}")
        for line in first_hits:
            print(line)
        if not first_hits:
            print("（该时间窗内代理访问日志里没有匹配 alpine/socat 的条目）")

        # 二次拉取：先把镜像从守护进程里删掉再拉，验证代理缓存命中（不走上游）
        rmi = daemon_docker(daemon, ["rmi", FWD_IMAGE], timeout=300)
        show("docker rmi（从守护进程里删掉刚拉的镜像，为二次拉取做准备）", rmi.output)
        if not rmi.ok:
            raise RuntimeError(f"删除镜像失败，二次拉取不是干净拉取：{rmi.output}")
        second_since = now_rfc3339()
        show(
            "免 root 守护进程 docker pull（二次：验证代理缓存命中）",
            daemon_docker(daemon, ["pull", FWD_IMAGE], timeout=900).output,
        )
        second_hits = self._proxy_image_lines(since=second_since)
        print("【二次拉取】")
        print(f"二次拉取时间窗内的代理条目数：{len(second_hits)}")
        for line in second_hits:
            print(line)
        if not second_hits:
            print("（该时间窗内代理访问日志里没有匹配 alpine/socat 的条目）")
        hit_lines = [line for line in second_hits if '"upstream_cache_status":"HIT"' in line]
        print(f"二次拉取命中代理缓存（upstream_cache_status=HIT）的条目数：{len(hit_lines)}")

    def _proxy_image_lines(self, since: str | None = None) -> list[str]:
        """取代理访问日志里与转发镜像（alpine/socat）相关的条目。

        两个口径要点：

        - **时间窗**：``since`` 给定时只取该时刻之后的日志（按二次拉取的时间窗
          取日志增量），不在整段历史日志上数；
        - **请求类型**：过滤条件覆盖 **manifest 与 blobs 两类请求**。镜像拉取除了
          manifest 还要逐个取 layer（blobs），只数 manifest 会漏掉大部分条目。

        只取 JSON 格式的访问日志行（以 ``{`` 开头）：代理的 nginx 错误/告警行里
        也会出现镜像名与请求路径，混进来会把条目数算虚。
        """
        argv = ["docker", "logs", "--tail", "5000"]
        if since:
            argv.extend(["--since", since])
        argv.append(self.proxy.container_name)
        logs = host_command(argv, timeout=60)
        return [
            line
            for line in (logs.stdout + logs.stderr).splitlines()
            if line.strip().startswith("{")
            and "socat" in line
            and ("manifest" in line or "blobs" in line)
        ]

    # ---------------------------------------------------------------- P1
    def _ensure_image(self) -> str:
        """确保转发镜像在守护进程里可用（优先经代理拉取，失败回退宿主注入）。"""
        daemon = self.require_daemon()
        source = self.images.ensure_image(FWD_IMAGE, daemon)
        print(f"镜像来源标记（remote=经代理拉取 / injected=宿主注入 / present=已在）：{source}")
        return source

    def _cleanup_probe_containers(self) -> None:
        """清掉上一轮探针容器与网络。"""
        daemon = self.require_daemon()
        for name in (C_FWD, C_SANDBOX):
            if daemon.container_exists(name):
                result = daemon_docker(daemon, ["rm", "-f", name], timeout=120)
                if result.ok:
                    print(f"已删除容器 {name}")
                else:
                    print(f"未能删除容器 {name}：{result.output.strip()}")
        if daemon.network_exists(PROBE_NET):
            result = daemon_docker(daemon, ["network", "rm", PROBE_NET], timeout=120)
            if result.ok:
                print(f"已删除网络 {PROBE_NET}")
            else:
                print(f"未能删除网络 {PROBE_NET}：{result.output.strip()}")

    def _create_network(self, daemon: UserDaemon, name: str) -> None:
        """创建探针网络；失败直接报错退出。

        网络没建起来，后续容器全部跑不通——不查退出码就会把环境问题一路带到
        「主路径不成立」的裁决上去。
        """
        result = daemon_docker(daemon, ["network", "create", name])
        show(f"docker network create {name}", result.output)
        if result.ok:
            print(f"已创建网络 {name}")
            return
        if daemon.network_exists(name):
            print(f"网络 {name} 已存在（沿用）")
            return
        raise RuntimeError(f"创建网络 {name} 失败：{result.output}")

    def _require_container_running(self, daemon: UserDaemon, name: str) -> None:
        """确认容器确实在运行；不成立直接报错退出。

        ``docker run -d`` 退出码为 0 只说明容器被创建并启动过，容器进程随即退出
        也是 0；不查运行状态，就会把「环境问题」误判成「主路径不成立」。
        """
        try:
            running = daemon.container_running(name)
        except CommandError as exc:
            raise RuntimeError(f"查询容器 {name} 运行状态失败：{exc}") from exc
        if running:
            print(f"容器 {name} 在运行")
            return
        state = daemon_docker(
            daemon, ["inspect", "--format", "{{.State.Status}}", name], timeout=60
        ).stdout.strip()
        logs = daemon_docker(daemon, ["logs", "--tail", "20", name], timeout=60).output
        raise RuntimeError(
            f"容器 {name} 未在运行（状态：{state or '未知'}）\n容器日志尾部：\n{logs}"
        )

    def _run_sandbox_container(self) -> None:
        """起「沙箱侧」探针容器：容器内跑一个 HTTP 服务。

        转发镜像（alpine/socat）的 ENTRYPOINT 是 socat、且 busybox 没有 httpd，
        所以这里用 ``--entrypoint sh`` 起一个 socat 的 EXEC 形态 HTTP 响应器：
        监听 8080，每来一条连接就把预置的 HTTP 响应吐回去。
        """
        daemon = self.require_daemon()
        self._create_network(daemon, PROBE_NET)
        result = daemon_docker(
            daemon,
            [
                "run",
                "-d",
                "--name",
                C_SANDBOX,
                "--network",
                PROBE_NET,
                "--entrypoint",
                "sh",
                FWD_IMAGE,
                "-c",
                SANDBOX_HTTP_COMMAND,
            ],
        )
        show("docker run -d --name probe-sandbox（容器内 HTTP 服务，8080）", result.output)
        if not result.ok:
            raise RuntimeError(f"启动沙箱侧探针容器 {C_SANDBOX} 失败：{result.output}")
        self._require_container_running(daemon, C_SANDBOX)
        time.sleep(3)
        show(
            "容器内自检（wget 127.0.0.1:8080）",
            daemon_docker(
                daemon,
                ["exec", C_SANDBOX, "wget", "-qO-", "http://127.0.0.1:8080/"],
                timeout=60,
            ).output,
        )

    def _run_fwd_container(self, host_port: int) -> None:
        """起「转发侧」探针容器：socat 转发 + 端口发布。"""
        daemon = self.require_daemon()
        result = daemon_docker(
            daemon,
            [
                "run",
                "-d",
                "--name",
                C_FWD,
                "--network",
                PROBE_NET,
                "-p",
                f"127.0.0.1:{host_port}:{FWD_PORT}",
                "--entrypoint",
                "socat",
                FWD_IMAGE,
                f"TCP-LISTEN:{FWD_PORT},fork,reuseaddr",
                f"TCP:{C_SANDBOX}:{SANDBOX_PORT}",
            ],
        )
        show("docker run -d --name probe-fwd（socat 转发 + -p 发布宿主回环）", result.output)
        if not result.ok:
            raise RuntimeError(f"启动转发侧探针容器 {C_FWD} 失败：{result.output}")
        self._require_container_running(daemon, C_FWD)
        time.sleep(3)

    def p1(self) -> None:
        """P1：免 root 守护进程下的端口发布判定。"""
        self.require_daemon()
        section("P1：免 root 守护进程 -p 端口发布判定")
        self._ensure_image()
        self._cleanup_probe_containers()
        host_port = pick_host_port(*HOST_PORT_RANGE)
        print(f"选定宿主回环端口：127.0.0.1:{host_port}")

        self._run_sandbox_container()
        self._run_fwd_container(host_port)

        section("判定一：宿主 ss -ltn 是否出现该端口")
        ss = host_command(["ss", "-ltn"])
        show("ss -ltn（全文）", ss.stdout)
        published = any(
            line.split()[3] == f"127.0.0.1:{host_port}" for line in ss.stdout.splitlines() if len(line.split()) >= 4
        )
        print(f"判定一结果：{'出现' if published else '未出现'} 127.0.0.1:{host_port}")
        phenomena: list[str] = []
        if ss.returncode == TIMEOUT_RC:
            phenomena.append(f"ss -ltn 超时（{TIMEOUT_RC} 秒）：{(ss.stderr or '').strip()}")

        section("判定二：宿主 curl 127.0.0.1:<端口> 是否连通容器内服务")
        curl = host_command(["curl", "-sS", "--max-time", "10", f"http://127.0.0.1:{host_port}/"])
        show("curl -sS http://127.0.0.1:%d/" % host_port, (curl.stdout + curl.stderr).strip())
        reached = "probe-ok" in curl.stdout
        print(f"判定二结果：{'连通（拿到容器内服务的响应体）' if reached else '不通'}")
        if curl.returncode == TIMEOUT_RC:
            phenomena.append(f"curl 超时（{TIMEOUT_RC} 秒）：{(curl.stderr or '').strip()}")

        section("P1 裁决")
        if published and reached:
            print("P1 裁决：主路径成立（-p 在宿主回环真的产生监听且可连通）")
            return
        print("P1 裁决：主路径不成立（转 Fallback B 备案路径）")
        if phenomena:
            print("现象记录（供备案裁决用）：")
            for item in phenomena:
                print(f"  - {item}")
        else:
            print("现象记录：端口未出现 / 不通（ss 与 curl 的原始输出已在上方留档）")

    # ---------------------------------------------------------------- Fallback B
    def fallback_b(self) -> None:
        """Fallback B：转发容器不发布端口，用 docker exec 管道做双向字节流。"""
        daemon = self.require_daemon()
        section("Fallback B：不发布端口，宿主侧 docker exec -i 建双向字节流")
        self._ensure_image()
        self._cleanup_probe_containers()
        host_port = pick_host_port(*HOST_PORT_RANGE)
        print(f"选定宿主回环端口：127.0.0.1:{host_port}")

        self._run_sandbox_container()

        # 转发容器不发布端口，只在沙箱网络里监听
        result = daemon_docker(
            daemon,
            [
                "run",
                "-d",
                "--name",
                C_FWD,
                "--network",
                PROBE_NET,
                "--entrypoint",
                "socat",
                FWD_IMAGE,
                f"TCP-LISTEN:{FWD_PORT},fork,reuseaddr",
                f"TCP:{C_SANDBOX}:{SANDBOX_PORT}",
            ],
        )
        show("docker run -d --name probe-fwd（**无 -p**，只在沙箱网络内监听）", result.output)
        if not result.ok:
            raise RuntimeError(f"启动转发侧探针容器 {C_FWD} 失败：{result.output}")
        self._require_container_running(daemon, C_FWD)
        time.sleep(3)

        section("判定一：宿主 ss -ltn 不应出现该端口（未发布）")
        ss = host_command(["ss", "-ltn"])
        published = any(
            line.split()[3] == f"127.0.0.1:{host_port}"
            for line in ss.stdout.splitlines()
            if len(line.split()) >= 4
        )
        print(f"判定一结果：{'出现（异常，仍发布了端口）' if published else '未出现（符合预期）'} 127.0.0.1:{host_port}")
        phenomena: list[str] = []
        if ss.returncode == TIMEOUT_RC:
            phenomena.append(f"ss -ltn 超时（{TIMEOUT_RC} 秒）：{(ss.stderr or '').strip()}")

        section("判定二：docker exec -i 字节管道是否连通容器内服务")
        request = "GET / HTTP/1.0\r\nHost: probe-sandbox\r\n\r\n"
        try:
            result = run(
                daemon.user_argv(
                    [
                        "docker",
                        "exec",
                        "-i",
                        C_FWD,
                        "socat",
                        "-",
                        f"TCP:{C_SANDBOX}:{SANDBOX_PORT}",
                    ]
                ),
                check=False,
                timeout=60,
                stdin_text=request,
            )
        except CommandError as exc:
            # 超时（核心包把 TimeoutExpired 转成 CommandError）或命令不可用：
            # 转成「备案路径不成立 + 现象」，不让整轮以 traceback 收场
            # （备案路径的裁决必须留档）。
            print("判定二结果：不通（docker exec -i 执行失败）")
            print()
            print("Fallback B 裁决：备案路径不成立")
            print(f"现象记录：{exc}")
            return
        show(
            "printf 'GET / HTTP/1.0' | docker exec -i probe-fwd socat - TCP:probe-sandbox:8080",
            result.output,
        )
        reached = "probe-ok" in result.stdout
        print(f"判定二结果：{'连通（管道拿到容器内服务的响应体）' if reached else '不通'}")
        if result.returncode == TIMEOUT_RC:
            phenomena.append(f"docker exec -i 超时（{TIMEOUT_RC} 秒）")

        print()
        if reached:
            print("Fallback B 裁决：备案路径成立")
        else:
            print("Fallback B 裁决：备案路径不成立")
            if phenomena:
                print("现象记录：")
                for item in phenomena:
                    print(f"  - {item}")
            else:
                print("现象记录：管道未拿到容器内服务的响应体（原始输出已在上方留档）")

    # ---------------------------------------------------------------- 回收
    def teardown(self) -> None:
        """回收探针创建的全部宿主资源。"""
        section("探针回收")
        user = self.userspace.lookup_user(PROBE_USER)
        if user is None:
            print(f"探针用户 {PROBE_USER} 不存在，跳过容器回收")
        else:
            self.user = user
            self.daemon = UserDaemon(
                UserContext(user=user.name, uid=user.uid, gid=user.gid, home=user.home)
            )
            self._cleanup_probe_containers()

            show(
                "systemctl --user disable --now docker.service",
                self.daemon.systemctl(["disable", "--now", "docker.service"]).output,
            )
            unit_path = self.userspace.unit_path(user)
            # 特权前缀一律走核心包 Privilege.wrap：以 root 运行时它不加 `sudo`
            # （root 环境下 sudo 未必存在，硬拼 `sudo -n` 会直接报错）。
            removed = privileged_run(
                self.userspace.privilege.wrap(["rm", "-f", str(unit_path)])
            )
            if removed.ok:
                print(f"已删除单元文件 {unit_path}")
            else:
                print(f"未能删除单元文件 {unit_path}：{removed.output.strip()}")
            wants_path = user.home / ".config/systemd/user/default.target.wants/docker.service"
            removed_wants = privileged_run(
                self.userspace.privilege.wrap(["rm", "-f", str(wants_path)])
            )
            if removed_wants.ok:
                print(f"已删除单元软链 {wants_path}")
            else:
                print(f"未能删除单元软链 {wants_path}：{removed_wants.output.strip()}")
            self.daemon.systemctl(["daemon-reload"], check=False)
            print(f"linger 状态（关闭前）：{self.userspace.linger_state(PROBE_USER)}")
            self.userspace.disable_linger(PROBE_USER)
            print("已关闭 linger")

            self.userspace.remove_subid_range(PROBE_USER)
            print("已清除 /etc/subuid 与 /etc/subgid 中的探针条目")
            user_removed = self.userspace.remove_user(user, remove_home=True)
            print(f"探针用户与家目录回收：{'成功' if user_removed else '未完全成功'}")

        section("回收结果校验")
        checks = [
            ("探针用户不存在", not self.userspace.user_exists(PROBE_USER)),
            (
                "/etc/subuid 无探针条目",
                PROBE_USER
                not in privileged_run(
                    self.userspace.privilege.wrap(["cat", "/etc/subuid"])
                ).stdout,
            ),
            (
                "/etc/subgid 无探针条目",
                PROBE_USER
                not in privileged_run(
                    self.userspace.privilege.wrap(["cat", "/etc/subgid"])
                ).stdout,
            ),
        ]
        uid = self.user.uid if self.user else 0
        # 家目录取自系统用户信息（getent passwd），不写死 /home/<用户名>：
        # 家目录不在默认路径时，写死的路径会让校验假通过。
        home = self.user.home if self.user else Path(f"/home/{PROBE_USER}")
        checks.append(
            (
                "探针家目录已删除",
                not privileged_run(
                    self.userspace.privilege.wrap(["test", "-d", str(home)])
                ).ok,
            )
        )
        checks.append(
            ("用户运行时目录已回收", not Path(f"/run/user/{uid}").exists())
        )
        unit_gone = not privileged_run(
            self.userspace.privilege.wrap(
                ["test", "-f", str(home / ".config/systemd/user/docker.service")]
            )
        ).ok
        checks.append(("用户级 systemd 单元已删除", unit_gone))
        for name, ok in checks:
            print(f"  [{'通过' if ok else '不通过'}] {name}")


def main() -> int:
    """命令行入口。"""
    parser = argparse.ArgumentParser(description="三期打样探针（P1 / P3）")
    parser.add_argument(
        "phase",
        choices=["setup", "env", "p1", "p3", "fallback-b", "teardown"],
        help="探针阶段",
    )
    args = parser.parse_args()
    probe = Probe()
    if args.phase == "setup":
        probe.setup()
    elif args.phase == "env":
        probe.environment_report()
    elif args.phase == "p1":
        probe.p1()
    elif args.phase == "p3":
        probe.p3()
    elif args.phase == "fallback-b":
        probe.fallback_b()
    elif args.phase == "teardown":
        probe.teardown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
