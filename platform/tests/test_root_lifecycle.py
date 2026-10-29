"""宿主级生命周期测试（需要真实 root 权限）。

覆盖：创建 → 关闭 → 启动 → 删除 全链路、容器内可见范围、跨沙箱权限拒绝、
并发创建的子 ID 段不重叠、删除幂等。测试数据全部落在 ``SANDBOX_PLATFORM_HOME``
重定向的临时目录，测试自带清理。
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import pytest

from sandbox_platform import CreateRequest, SandboxService, UserContext
from sandbox_platform.daemon import UserDaemon
from sandbox_platform.userspace import SystemUser, UserSpaceManager

pytestmark = pytest.mark.root


def _docker_cli_image() -> str:
    """取一个带 docker 客户端的镜像（容器内需要 docker 命令）。

    优先用平台基础镜像：它在宿主已构建好，属平台自建镜像，由宿主导入即可，
    不用经代理下载（大镜像走代理会明显拖慢测试）。
    """
    for candidate in ("sandbox-platform/base:0.2.0",):
        inspect = subprocess.run(
            ["docker", "image", "inspect", candidate],
            capture_output=True,
            check=False,
        )
        if inspect.returncode == 0:
            return candidate
    result = subprocess.run(
        ["docker", "version", "--format", "{{.Server.Version}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    version = result.stdout.strip()
    return f"docker:{version}-cli" if version else "docker:cli"


def _daemon_for(service: SandboxService, metadata) -> UserDaemon:
    """按元数据构造守护进程操作入口。"""
    context = UserContext(
        user=metadata.system_user,
        uid=metadata.uid,
        gid=metadata.gid,
        home=Path(metadata.home),
    )
    return UserDaemon(context, service.privilege)


def _cleanup(service: SandboxService, name: str) -> None:
    """测试自清理：删除沙箱并兜底删除系统用户。"""
    try:
        service.delete(name)
    except Exception:  # noqa: BLE001,S110 - 清理兜底：失败也不阻断后续回收
        pass
    metadata = service.find(name)
    if metadata is not None:
        manager = UserSpaceManager(service.config, service.privilege)
        manager.remove_subid_range(metadata.system_user)
        user = SystemUser(
            name=metadata.system_user,
            uid=metadata.uid,
            gid=metadata.gid,
            home=Path(metadata.home),
        )
        if manager.user_exists(user.name):
            manager.remove_user(user)


def _subid_entries(user_name: str) -> list[str]:
    """读宿主子 ID 文件里某用户的条目。"""
    entries: list[str] = []
    for path in ("/etc/subuid", "/etc/subgid"):
        try:
            content = Path(path).read_text(encoding="utf-8")
        except OSError:
            continue
        for line in content.splitlines():
            if line.startswith(f"{user_name}:"):
                entries.append(line.strip())
    return entries


def _path_exists(path: str | Path) -> bool:
    """判断宿主路径是否存在（沙箱用户家目录不可直接读，需要特权回退）。"""
    try:
        return Path(path).exists()
    except PermissionError:
        result = subprocess.run(
            ["sudo", "-n", "test", "-e", str(path)], capture_output=True, check=False
        )
        return result.returncode == 0


def test_full_lifecycle_create_stop_start_delete(
    service: SandboxService, external_dir: Path, require_root: None
) -> None:
    """全链路：创建 → 关闭 → 启动 → 删除，并校验回收清单。"""
    name = "sboxfull"
    external = external_dir
    payload = external / "keep.txt"
    payload.write_text("原样保留", encoding="utf-8")

    request = CreateRequest(
        name=name,
        image=_docker_cli_image(),
        mount_declarations=(f"{external}:/data:ro",),
        command=("sleep", "infinity"),
    )
    result = service.create(request)
    metadata = result.metadata
    daemon = _daemon_for(service, metadata)

    try:
        # ① 用户、子 ID 段、单元、守护进程
        assert service.userspace.user_exists(metadata.system_user)
        assert _subid_entries(metadata.system_user), "子 ID 段未登记"
        assert Path(metadata.unit_path).name == "docker.service"
        assert _path_exists(metadata.unit_path)
        assert daemon.is_active()
        assert daemon.socket_ready()

        # ② 沙箱用户身份下 docker ps 只看到本沙箱容器
        listed = daemon.docker(["ps", "-a", "--format", "{{.Names}}"])
        assert listed.stdout.split() == [metadata.container_name]

        # ③ 容器内 docker ps 只看到自己
        inside = daemon.exec_in_container(
            metadata.container_name, ["docker", "ps", "-a", "--format", "{{.Names}}"]
        )
        assert inside.ok, inside.output
        assert inside.stdout.split() == [metadata.container_name]

        # ④ 容器内挂载点：套接字 + 用户声明挂载
        inspect = daemon.docker(
            ["inspect", "--format", "{{json .Mounts}}", metadata.container_name]
        )
        mounts = json.loads(inspect.stdout.strip())
        destinations = sorted(item["Destination"] for item in mounts)
        assert destinations == ["/data", "/var/run/docker.sock"]

        # ⑤ 关闭：容器停，用户/守护进程/家目录/子 ID 段/外部目录全保留
        service.stop(name)
        assert not daemon.container_running(metadata.container_name)
        assert daemon.is_active()
        assert service.userspace.user_exists(metadata.system_user)
        assert _path_exists(metadata.home)
        assert _subid_entries(metadata.system_user)
        assert payload.read_text(encoding="utf-8") == "原样保留"

        # ⑥ 启动：同一子 ID 段、同一守护进程、挂载目录内容原样
        restarted = service.start(name)
        assert restarted.subid_start == metadata.subid_start
        assert restarted.subid_length == metadata.subid_length
        assert restarted.system_user == metadata.system_user
        assert daemon.container_running(metadata.container_name)
        assert payload.read_text(encoding="utf-8") == "原样保留"

        # ⑦ 删除：平台资源全部回收，外部目录原样存在
        deleted = service.delete(name)
        assert deleted.existed is True
        assert not service.userspace.user_exists(metadata.system_user)
        assert not _path_exists(metadata.home)
        assert not _path_exists(metadata.unit_path)
        assert not _subid_entries(metadata.system_user)
        assert not daemon.container_exists(metadata.container_name)
        assert service.find(name) is None
        assert external.is_dir()
        assert payload.read_text(encoding="utf-8") == "原样保留"

        # ⑧ 幂等：重复删除不报错
        again = service.delete(name)
        assert again.existed is False
        assert again.removed == ()
    finally:
        _cleanup(service, name)


def test_sandbox_without_mounts_only_has_socket(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """未声明挂载的沙箱只挂套接字一个挂载点。"""
    name = "sboxbare"
    request = CreateRequest(
        name=name,
        image="busybox",
        command=("sleep", "infinity"),
    )
    result = service.create(request)
    metadata = result.metadata
    daemon = _daemon_for(service, metadata)
    try:
        inspect = daemon.docker(
            ["inspect", "--format", "{{json .Mounts}}", metadata.container_name]
        )
        mounts = json.loads(inspect.stdout.strip())
        assert [item["Destination"] for item in mounts] == ["/var/run/docker.sock"]
        assert metadata.mounts == []
    finally:
        _cleanup(service, name)


def test_cross_sandbox_socket_access_denied(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """访问其他沙箱用户的套接字路径被拒绝（权限错误，不是超时）。"""
    first = "sboxperma"
    second = "sboxpermb"
    service.create(
        CreateRequest(name=first, image="busybox", command=("sleep", "infinity"))
    )
    service.create(
        CreateRequest(name=second, image="busybox", command=("sleep", "infinity"))
    )
    try:
        first_meta = service.get(first)
        second_meta = service.get(second)
        first_daemon = _daemon_for(service, first_meta)
        other_socket = second_meta.socket_path

        # 宿主侧：以沙箱用户身份直连别人的套接字 → 权限拒绝
        connect_script = "\n".join(
            [
                "import socket",
                "s = socket.socket(socket.AF_UNIX)",
                f"s.connect('{other_socket}')",
            ]
        )
        probe = first_daemon.run_as_user(
            ["python3", "-c", connect_script],
            check=False,
            timeout=30,
        )
        assert not probe.ok
        assert "Permission denied" in probe.stderr or "Errno 13" in probe.stderr

        # 可见范围：沙箱 A 的守护进程看不到沙箱 B 的容器
        visible = first_daemon.docker(["ps", "-a", "--format", "{{.Names}}"])
        assert second_meta.container_name not in visible.stdout.split()
        assert first_meta.container_name in visible.stdout.split()

        # 容器侧：访问别人的套接字路径必须快速失败，不能挂住
        started = time.monotonic()
        inside = first_daemon.exec_in_container(
            first_meta.container_name,
            ["docker", "-H", f"unix://{other_socket}", "ps"],
            timeout=30,
        )
        elapsed = time.monotonic() - started
        assert not inside.ok
        assert elapsed < 20, f"访问其他沙箱套接字疑似超时（{elapsed:.1f} 秒）"
    finally:
        _cleanup(service, first)
        _cleanup(service, second)


def test_concurrent_creates_use_distinct_users_and_subid_ranges(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """两个并发创建的沙箱拥有不同系统用户与不重叠的子 ID 段。"""
    names = ["sboxconc1", "sboxconc2"]
    try:
        from concurrent.futures import ThreadPoolExecutor

        def create(name: str) -> None:
            worker = SandboxService(service.config, service.privilege)
            worker.create(
                CreateRequest(name=name, image="busybox", command=("sleep", "infinity"))
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(create, name) for name in names]
            for future in futures:
                future.result()

        metas = [service.get(name) for name in names]
        assert metas[0].system_user != metas[1].system_user
        first = (metas[0].subid_start, metas[0].subid_length)
        second = (metas[1].subid_start, metas[1].subid_length)
        assert first != second
        overlaps = (
            first[0] < second[0] + second[1] and second[0] < first[0] + first[1]
        )
        assert not overlaps, f"子 ID 段重叠：{first} 与 {second}"
    finally:
        for name in names:
            _cleanup(service, name)


def test_stop_keeps_dependencies_by_default(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """关闭沙箱默认一并停止依赖容器，保留用户与家目录。"""
    name = "sboxdep"
    service.create(
        CreateRequest(
            name=name,
            image=_docker_cli_image(),
            command=("sleep", "infinity"),
        )
    )
    try:
        metadata = service.get(name)
        daemon = _daemon_for(service, metadata)
        dependency = daemon.run_container(
            name=f"{name}-dep",
            image=_docker_cli_image(),
            mounts=[],
            network=metadata.network_name,
            command=("sleep", "infinity"),
        )
        assert dependency.ok, dependency.output
        assert daemon.container_running(f"{name}-dep")

        # 沙箱容器内可以操作本沙箱的依赖容器
        inside = daemon.exec_in_container(
            metadata.container_name,
            ["docker", "ps", "-a", "--format", "{{.Names}}"],
        )
        assert inside.ok, inside.output
        assert set(inside.stdout.split()) == {metadata.container_name, f"{name}-dep"}
        operate = daemon.exec_in_container(
            metadata.container_name, ["docker", "restart", f"{name}-dep"]
        )
        assert operate.ok, operate.output

        stopped = service.stop(name)
        assert not daemon.container_running(metadata.container_name)
        assert not daemon.container_running(f"{name}-dep")
        assert f"{name}-dep" in stopped.dependency_containers
        assert service.userspace.user_exists(metadata.system_user)

        # 显式保留依赖容器时，依赖容器继续运行
        # 语义：start 只恢复沙箱容器；依赖容器由使用方（agent）自行拉起
        service.start(name)
        daemon.start_container(f"{name}-dep")
        assert daemon.container_running(f"{name}-dep")
        service.stop(name, stop_dependencies=False)
        assert daemon.container_running(f"{name}-dep")
    finally:
        _cleanup(service, name)


def test_reclaim_plan_lists_live_dependency_container(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """删除前的回收清单并入实时扫描到的依赖容器，删除后依赖容器被回收。"""
    name = "sboxplan"
    service.create(
        CreateRequest(
            name=name,
            image=_docker_cli_image(),
            command=("sleep", "infinity"),
        )
    )
    try:
        metadata = service.get(name)
        daemon = _daemon_for(service, metadata)
        dependency = daemon.run_container(
            name=f"{name}-dep",
            image=_docker_cli_image(),
            mounts=[],
            network=metadata.network_name,
            command=("sleep", "infinity"),
        )
        assert dependency.ok, dependency.output

        plan = service.reclaim_plan(name)
        joined = " ".join(plan.items)
        assert f"{name}-dep" in joined, "回收清单里没有实时扫描到的依赖容器"

        deleted = service.delete(name)
        assert deleted.existed is True
        assert not daemon.container_exists(f"{name}-dep")
    finally:
        _cleanup(service, name)


def test_user_specified_network_is_not_reclaimed_by_platform(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """用户指定的网络只接入不回收：平台不把它列入回收结果。"""
    name = "sboxnet"
    service.create(
        CreateRequest(
            name=name,
            image=_docker_cli_image(),
            command=("sleep", "infinity"),
            network_name="custom-net",
        )
    )
    try:
        metadata = service.get(name)
        assert metadata.network_owned is False
        assert metadata.network_name == "custom-net"

        plan = service.reclaim_plan(name)
        assert "平台不回收" in " ".join(plan.items)

        deleted = service.delete(name)
        assert not any(item.startswith("网络 ") for item in deleted.removed)
        assert not any("网络" in item for item in deleted.failed)
    finally:
        _cleanup(service, name)


def test_create_fails_when_proxy_unreachable(
    service: SandboxService, require_root: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """代理不可达时创建直接失败（不降级直连），且不留下沙箱残留。"""
    from sandbox_platform import LifecycleError

    name = "sboxproxy"
    monkeypatch.setattr(service.proxy, "ensure_running", lambda *a, **k: False)
    monkeypatch.setattr(
        service.proxy,
        "probe",
        lambda: _proxy_probe_failure(),
    )
    try:
        with pytest.raises(LifecycleError) as excinfo:
            service.create(
                CreateRequest(name=name, image=_docker_cli_image(), command=("sleep", "infinity"))
            )
        message = str(excinfo.value)
        assert "镜像代理未就绪" in message
        assert "不做降级直连" in message
        assert service.find(name) is None
    finally:
        _cleanup(service, name)


def _proxy_probe_failure():
    """构造一个「代理不可达」的探测结果。"""
    from sandbox_platform import ProxyProbe

    return ProxyProbe(tcp=False, http=False, detail="连接被拒绝")
