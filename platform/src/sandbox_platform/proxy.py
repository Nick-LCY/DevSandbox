"""统一镜像代理（registry cache proxy）的控制面管理。

代理用上游项目 ``rpardini/docker-registry-proxy``（版本钉在 0.8.0），以宿主 root
守护进程容器方式运行：监听宿主回环 ``127.0.0.1:3128``；缓存目录与 CA 目录落在
平台数据根 ``<home>/registry-proxy/`` 下（``SANDBOX_PLATFORM_HOME`` 重定向时跟随）。

沙箱侧通过免 root 守护进程的 systemd 单元注入代理环境变量实现透明缓存：

- ``HTTPS_PROXY`` / ``HTTP_PROXY`` 指向 ``http://127.0.0.1:<port>``
  （免 root 守护进程在 ``--detach-netns`` 模式下留在宿主网络命名空间，
  用宿主回环地址访问代理容器；slirp 网关 10.0.2.2 只在沙箱容器内可达）；
- ``NO_PROXY`` 放行本地地址；
- ``SSL_CERT_FILE`` 指向「系统 CA 束 + 代理 CA」合并后的单个文件。

沙箱内 ``docker pull`` 无需任何额外操作即自动经代理并命中缓存。

代理不可达时**不做降级直连**（用户已拍板）：创建流程直接失败并给出明确报错。

上游依据（0.8.0）：

- 镜像：``rpardini/docker-registry-proxy:0.8.0``（Docker Hub 与 GHCR 同源同版本）；
- 端口：容器内 3128（上游 ``EXPOSE 3128``，客户端只应使用这一个端口）；
- 环境变量：``REGISTRIES``（空格分隔的被拦截仓库清单，docker.io 由上游内置处理）、
  ``AUTH_REGISTRIES``、``ENABLE_MANIFEST_CACHE`` 等；
- 卷：``/docker_mirror_cache``（镜像层缓存）、``/ca``（CA 与私钥，必须持久化）；
- CA：代理把证书写在 ``/ca/ca.crt``，同时通过 ``http://<host>:3128/ca.crt`` 对外提供；
  私钥在 ``/ca/ca.key``。
"""

from __future__ import annotations

import fcntl
import json
import logging
import socket
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .command import run
from .config import DEFAULT_PROXY_PORT, PlatformConfig
from .errors import ProxyError
from .userspace import Privilege, SystemUser, ca_bundle_path

logger = logging.getLogger(__name__)

# 代理容器名（默认端口用固定名；换端口时加后缀，避免与既有实例抢端口）
PROXY_CONTAINER_NAME = "sandbox-platform-registry-proxy"
# 代理容器内部的固定路径（上游约定）
PROXY_CACHE_MOUNT = "/docker_mirror_cache"
PROXY_CA_MOUNT = "/ca"
PROXY_INTERNAL_PORT = 3128
# 上游写在 CA 卷里的文件名
CA_CERT_FILENAME = "ca.crt"
CA_KEY_FILENAME = "ca.key"
# 健康检查参数
HEALTH_TCP_TIMEOUT = 3
HEALTH_HTTP_TIMEOUT = 5


def proxy_container_name(port: int) -> str:
    """代理容器名：默认端口用固定名，其它端口加端口后缀。"""
    if port == DEFAULT_PROXY_PORT:
        return PROXY_CONTAINER_NAME
    return f"{PROXY_CONTAINER_NAME}-{port}"


@dataclass(frozen=True)
class ProxyProbe:
    """一次健康探测的结果。"""

    tcp: bool
    http: bool
    detail: str

    @property
    def healthy(self) -> bool:
        """端口可连且能取到代理 CA 证书才算健康。"""
        return self.tcp and self.http


class RegistryProxyManager:
    """统一镜像代理的拉起、探活与 CA 分发。"""

    def __init__(
        self,
        config: PlatformConfig | None = None,
        privilege: Privilege | None = None,
    ) -> None:
        self.config = config or PlatformConfig.from_env()
        self.privilege = privilege or Privilege()
        self.last_error = ""

    # ---------------------------------------------------------------- 名称与路径
    @property
    def container_name(self) -> str:
        """代理容器名。"""
        return proxy_container_name(self.config.proxy_port)

    @property
    def proxy_url(self) -> str:
        """沙箱守护进程访问代理用的 URL。"""
        return f"http://{self.config.proxy_address}:{self.config.proxy_port}"

    @property
    def ca_certificate_path(self) -> Path:
        """宿主上的代理 CA 证书路径（对应容器内 ``/ca/ca.crt``）。"""
        return self.config.proxy_ca_dir / CA_CERT_FILENAME

    @property
    def ca_key_path(self) -> Path:
        """宿主上的代理 CA 私钥路径（对应容器内 ``/ca/ca.key``）。"""
        return self.config.proxy_ca_dir / CA_KEY_FILENAME

    # ---------------------------------------------------------------- 目录
    def ensure_directories(self) -> None:
        """创建缓存目录与 CA 目录（幂等）。"""
        for path in (self.config.proxy_cache_dir, self.config.proxy_ca_dir):
            run(
                self.privilege.wrap(["install", "-d", "-m", "0755", str(path)]),
                check=True,
            )

    # ---------------------------------------------------------------- 镜像
    def host_image_exists(self) -> bool:
        """宿主 root 守护进程里是否已有代理镜像。"""
        return run(
            self.privilege.wrap(["docker", "image", "inspect", self.config.proxy_image]),
            check=False,
        ).ok

    def ensure_image(self) -> bool:
        """确保代理镜像在宿主上就位（首启自动拉取一次）。"""
        if self.host_image_exists():
            return True
        logger.info("拉取代理镜像：%s", self.config.proxy_image)
        result = run(
            self.privilege.wrap(["docker", "pull", self.config.proxy_image]),
            check=False,
            timeout=900,
        )
        if not result.ok:
            logger.error("拉取代理镜像失败：%s", result.output.strip())
            return False
        return True

    # ---------------------------------------------------------------- 容器
    def container_exists(self) -> bool:
        """代理容器是否存在。"""
        return run(
            self.privilege.wrap(
                ["docker", "inspect", "--type", "container", self.container_name]
            ),
            check=False,
        ).ok

    def container_running(self) -> bool:
        """代理容器是否在运行。"""
        result = run(
            self.privilege.wrap(
                ["docker", "inspect", "--format", "{{.State.Running}}", self.container_name]
            ),
            check=False,
        )
        return result.ok and result.stdout.strip() == "true"

    def _bind_mounts_match(self) -> bool:
        """既有容器的绑定挂载是否与当前配置一致。

        数据根被重定向过（例如测试用临时目录）时，容器的挂载会指向旧路径，
        此时必须重建容器，否则缓存与 CA 会写到错误的地方。
        """
        result = run(
            self.privilege.wrap(
                ["docker", "inspect", "--format", "{{json .Mounts}}", self.container_name]
            ),
            check=False,
        )
        if not result.ok:
            return False
        try:
            mounts = json.loads(result.stdout.strip() or "[]")
        except json.JSONDecodeError:
            return False
        found = {
            item.get("Source"): item.get("Destination")
            for item in mounts
            if isinstance(item, dict)
        }
        expected = {
            str(self.config.proxy_cache_dir): PROXY_CACHE_MOUNT,
            str(self.config.proxy_ca_dir): PROXY_CA_MOUNT,
        }
        return all(found.get(source) == destination for source, destination in expected.items())

    def _run_container(self) -> bool:
        """拉起代理容器。"""
        args = [
            "docker",
            "run",
            "-d",
            "--name",
            self.container_name,
            "--restart",
            "unless-stopped",
            "-p",
            f"127.0.0.1:{self.config.proxy_port}:{PROXY_INTERNAL_PORT}",
            "-e",
            f"REGISTRIES={' '.join(self.config.proxy_registries)}",
            "-e",
            "ENABLE_MANIFEST_CACHE=true",
            "-v",
            f"{self.config.proxy_cache_dir}:{PROXY_CACHE_MOUNT}",
            "-v",
            f"{self.config.proxy_ca_dir}:{PROXY_CA_MOUNT}",
            self.config.proxy_image,
        ]
        result = run(self.privilege.wrap(args), check=False, timeout=300)
        if not result.ok:
            self.last_error = result.output.strip()
            logger.error("启动代理容器失败：%s", self.last_error)
            return False
        return True

    def ensure_running(self, timeout: int = 120) -> bool:
        """幂等拉起代理并等到健康。

        返回 ``True`` 表示代理已在跑且健康；``False`` 表示拉起失败或健康检查不通过。
        调用方必须据此失败——代理不可达时不走降级直连。

        并发调用由文件锁串行化：两个沙箱同时创建时只能有一个去建容器。
        """
        self.config.lock_root.mkdir(parents=True, exist_ok=True)
        lock_path = self.config.lock_root / "registry-proxy.lock"
        with open(lock_path, "a+") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                return self._ensure_running_locked(timeout)
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _ensure_running_locked(self, timeout: int) -> bool:
        """临界区内的拉起实现（调用方必须已持有代理锁）。"""
        self.ensure_directories()
        self.last_error = ""
        if self.container_exists():
            if not self._bind_mounts_match():
                logger.warning("代理容器挂载与当前配置不一致，重建容器")
                self.remove()
            elif not self.container_running():
                logger.info("代理容器已存在但未运行，启动它")
                started = run(
                    self.privilege.wrap(["docker", "start", self.container_name]),
                    check=False,
                    timeout=120,
                )
                if not started.ok:
                    # 起不动的容器（比如端口被占）不能一直占着名字：删掉重建
                    self.last_error = started.output.strip()
                    logger.warning("代理容器启动失败，删除后重建：%s", self.last_error)
                    self.remove()
        if not self.container_exists():
            if not self.ensure_image():
                return False
            if not self._run_container():
                return False

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            probe = self.probe()
            if probe.healthy:
                self.harden_ca_permissions()
                logger.info("镜像代理已就绪：%s", self.proxy_url)
                return True
            time.sleep(2)
        logger.error("镜像代理未在 %s 秒内就绪：%s", timeout, self.proxy_url)
        return False

    def stop(self) -> bool:
        """停止代理容器（不删除）。"""
        result = run(
            self.privilege.wrap(["docker", "stop", self.container_name]),
            check=False,
            timeout=120,
        )
        return result.ok

    def remove(self) -> bool:
        """删除代理容器。"""
        result = run(
            self.privilege.wrap(["docker", "rm", "-f", self.container_name]),
            check=False,
            timeout=120,
        )
        return result.ok

    # ---------------------------------------------------------------- 健康检查
    def probe(self) -> ProxyProbe:
        """健康探测：端口可连 + 能从代理取到 CA 证书。"""
        tcp_ok, tcp_detail = self._tcp_probe()
        if not tcp_ok:
            return ProxyProbe(tcp=False, http=False, detail=tcp_detail)
        http_ok, http_detail = self._http_probe()
        return ProxyProbe(tcp=True, http=http_ok, detail=http_detail)

    def health_check(self) -> bool:
        """代理是否健康。"""
        return self.probe().healthy

    def _tcp_probe(self) -> tuple[bool, str]:
        """TCP 连接探测。"""
        try:
            with socket.create_connection(
                ("127.0.0.1", self.config.proxy_port), timeout=HEALTH_TCP_TIMEOUT
            ):
                return True, f"127.0.0.1:{self.config.proxy_port} 可连接"
        except OSError as exc:
            return False, f"127.0.0.1:{self.config.proxy_port} 连接失败：{exc}"

    def _http_probe(self) -> tuple[bool, str]:
        """HTTP 探测：向代理取 CA 证书（顺便验证代理链路与证书生成都正常）。"""
        url = f"http://127.0.0.1:{self.config.proxy_port}/ca.crt"
        # 显式清空代理设置，避免宿主自身的 http_proxy 环境变量干扰探测
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(url, timeout=HEALTH_HTTP_TIMEOUT) as response:
                payload = response.read()
        except (urllib.error.URLError, OSError, ValueError) as exc:
            return False, f"取 CA 证书失败（{url}）：{exc}"
        if b"BEGIN CERTIFICATE" not in payload:
            return False, f"CA 响应不是证书（{url}）"
        return True, f"CA 证书可取（{url}，{len(payload)} 字节）"

    # ---------------------------------------------------------------- CA
    def harden_ca_permissions(self) -> None:
        """收紧 CA 私钥权限（0600），证书保持 0644。"""
        run(
            self.privilege.wrap(["chmod", "0600", str(self.ca_key_path)]),
            check=False,
        )
        run(
            self.privilege.wrap(["chmod", "0644", str(self.ca_certificate_path)]),
            check=False,
        )

    def read_ca_certificate(self) -> str:
        """读代理 CA 证书文本。"""
        path = self.ca_certificate_path
        try:
            return path.read_text(encoding="utf-8")
        except PermissionError:
            result = run(self.privilege.wrap(["cat", str(path)]), check=False)
            if not result.ok:
                raise ProxyError(f"读不到代理 CA 证书：{path}") from None
            return result.stdout
        except FileNotFoundError:
            raise ProxyError(f"代理 CA 证书不存在：{path}") from None

    def read_system_ca_bundle(self) -> str:
        """读宿主系统 CA 束文本。"""
        path = self.config.system_ca_bundle
        try:
            return path.read_text(encoding="utf-8")
        except PermissionError:
            result = run(self.privilege.wrap(["cat", str(path)]), check=False)
            if not result.ok:
                raise ProxyError(f"读不到系统 CA 束：{path}") from None
            return result.stdout
        except FileNotFoundError:
            raise ProxyError(f"系统 CA 束不存在：{path}") from None

    def install_ca_bundle(self, user: SystemUser) -> Path:
        """把「系统 CA 束 + 代理 CA」合并成单个文件，装到沙箱用户家目录。

        合并而不是只放代理 CA：沙箱里访问非代理目标（业务 API、数据库等）时
        仍需要系统根证书；只信任代理 CA 会让非代理 TLS 全部失败。

        文件属主是沙箱用户、权限 0644：免 root 守护进程以该用户身份运行，
        必须能读到它（``SSL_CERT_FILE`` 指向该文件）。
        """
        system_ca = self.read_system_ca_bundle()
        proxy_ca = self.read_ca_certificate()
        bundle = system_ca.rstrip() + "\n" + proxy_ca.rstrip() + "\n"

        target = ca_bundle_path(user.home)
        self.config.temp_root.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - 临时文件需 install 到用户目录
            "w",
            encoding="utf-8",
            dir=self.config.temp_root,
            prefix="ca-bundle-",
            suffix=".crt",
            delete=False,
        )
        with handle:
            handle.write(bundle)
        temp_path = Path(handle.name)
        try:
            run(
                self.privilege.wrap(
                    [
                        "install",
                        "-d",
                        "-o",
                        user.name,
                        "-g",
                        user.name,
                        "-m",
                        "0755",
                        str(target.parent),
                    ]
                ),
                check=True,
            )
            run(
                self.privilege.wrap(
                    [
                        "install",
                        "-o",
                        user.name,
                        "-g",
                        user.name,
                        "-m",
                        "0644",
                        str(temp_path),
                        str(target),
                    ]
                ),
                check=True,
            )
        finally:
            temp_path.unlink(missing_ok=True)
        logger.info("已安装合并 CA 束：%s（属主 %s）", target, user.name)
        return target
