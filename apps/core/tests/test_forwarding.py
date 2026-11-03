"""端口转发编排的单元测试（不依赖宿主特权资源）。

宿主级交互（容器起停、镜像准备、exec 字节泵）全部走假守护进程，
用例只钉平台自己那一层：容器规格、命令构造、记录读写与生命周期语义。
"""

from __future__ import annotations

import json
import os
import signal
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from sandbox_platform import (
    BytePump,
    ForwardError,
    ForwardRecord,
    NotFoundError,
    PortForwardManager,
    SandboxMetadata,
    SandboxService,
    SystemUser,
    ValidationError,
)
from sandbox_platform.command import CommandResult
from sandbox_platform.errors import ForwardError as ForwardErrorFromErrors
from sandbox_platform.forwarding import (
    LABEL_FORWARD_ID,
    LABEL_FORWARD_ROLE,
    LABEL_FORWARD_SANDBOX,
    ROLE_FORWARD,
)

# 钉版转发镜像（统一镜像代理拉取用的引用）
FORWARD_IMAGE = (
    "alpine/socat:1.8.1.3@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed"
)


# ---------------------------------------------------------------- 假宿主
class FakeStream:
    """假字节流。"""

    def __init__(self) -> None:
        self.buffer = bytearray()
        self.closed = False

    def write(self, data: bytes) -> int:
        if self.closed:
            return 0
        self.buffer.extend(data)
        return len(data)

    def read(self, size: int = -1) -> bytes:
        if not self.buffer:
            return b""
        chunk = bytes(self.buffer[:size] if size and size > 0 else self.buffer)
        del self.buffer[: len(chunk)]
        return chunk

    def close(self) -> None:
        self.closed = True


class FakeProcess:
    """假子进程（字节泵句柄）。"""

    def __init__(self) -> None:
        self.stdin = FakeStream()
        self.stdout = FakeStream()
        self.stderr = FakeStream()
        self.pid = 4242
        self.returncode: int | None = None
        self.terminated = False

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = -15

    def kill(self) -> None:
        self.terminated = True
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int | None:
        return self.returncode


class FakeDaemon:
    """假守护进程：只记账，不碰宿主。

    故障注入：``remove_failures`` 里的容器删不掉，``inspect_failures`` 里的容器
    探测失败（模拟沙箱守护进程不可达）。
    """

    def __init__(self, network: str = "demo-net") -> None:
        self.network = network
        self.containers: dict[str, dict[str, object]] = {}
        self.commands: list[list[str]] = []
        self.spawned: list[list[str]] = []
        self.available_images = {FORWARD_IMAGE}
        # 故障注入
        self.remove_failures: set[str] = set()
        self.inspect_failures: set[str] = set()
        self.run_delay = 0.0

    # 镜像
    def image_exists(self, image: str) -> bool:
        return image in self.available_images

    def pull_image(self, image: str, timeout: int = 900) -> CommandResult:
        self.available_images.add(image)
        return CommandResult(("docker", "pull", image), 0, "", "")

    # 网络
    def network_exists(self, name: str) -> bool:
        return name == self.network

    # 容器
    def container_exists(self, name: str) -> bool:
        return name in self.containers

    def container_running(self, name: str) -> bool:
        return bool(self.containers.get(name, {}).get("running"))

    def container_labels(self, name: str) -> dict[str, str]:
        container = self.containers.get(name)
        if container is None:
            return {}
        return dict(container.get("labels", {}))

    def container_names_by_label(self, label: str) -> list[str]:
        key, _, value = label.partition("=")
        names = []
        for name, container in self.containers.items():
            labels = dict(container.get("labels", {}))
            if key in labels and (not value or labels[key] == value):
                names.append(name)
        return sorted(names)

    def containers_on_network(self, network: str) -> list[str]:
        return sorted(
            name
            for name, container in self.containers.items()
            if container.get("network") == network
        )

    def docker(
        self, args: list[str] | tuple[str, ...], check: bool = False, timeout: int = 600
    ) -> CommandResult:
        argv = [str(item) for item in args]
        self.commands.append(argv)
        if argv[:1] == ["run"]:
            if self.run_delay:
                time.sleep(self.run_delay)
            name = argv[argv.index("--name") + 1]
            labels: dict[str, str] = {}
            for index, item in enumerate(argv):
                if item == "--label":
                    key, _, value = argv[index + 1].partition("=")
                    labels[key] = value
            network = argv[argv.index("--network") + 1] if "--network" in argv else ""
            self.containers[name] = {"running": True, "labels": labels, "network": network}
            return CommandResult(tuple(argv), 0, "container-id", "")
        if argv[:1] == ["ps"]:
            # docker ps -a --filter name=<名字> --format {{.Names}}
            name = ""
            if "--filter" in argv:
                _, _, value = argv[argv.index("--filter") + 1].partition("=")
                name = value
            if name and name in self.inspect_failures:
                return CommandResult(
                    tuple(argv), 125, "", "Cannot connect to the Docker daemon"
                )
            names = sorted(item for item in self.containers if not name or name in item)
            text = "".join(f"{item}\n" for item in names)
            return CommandResult(tuple(argv), 0, text, "")
        if argv[:1] == ["inspect"]:
            name = argv[1] if len(argv) > 1 else ""
            if name in self.inspect_failures:
                return CommandResult(
                    tuple(argv), 125, "", "Cannot connect to the Docker daemon"
                )
            if name in self.containers:
                return CommandResult(tuple(argv), 0, "container-id", "")
            return CommandResult(tuple(argv), 1, "", f"No such object: {name}")
        return CommandResult(tuple(argv), 0, "container-id", "")

    def start_container(self, name: str, timeout: int = 120) -> CommandResult:
        container = self.containers.get(name)
        if container is not None:
            container["running"] = True
        return CommandResult(("docker", "start", name), 0, "", "")

    def stop_container(self, name: str, timeout: int = 120) -> CommandResult:
        container = self.containers.get(name)
        if container is not None:
            container["running"] = False
        return CommandResult(("docker", "stop", name), 0, "", "")

    def kill_container(self, name: str, timeout: int = 120) -> CommandResult:
        container = self.containers.get(name)
        if container is not None:
            container["running"] = False
        return CommandResult(("docker", "kill", name), 0, "", "")

    def remove_container(
        self, name: str, force: bool = True, timeout: int = 120
    ) -> CommandResult:
        if name in self.remove_failures:
            return CommandResult(("docker", "rm", name), 1, "", "cannot remove container")
        self.containers.pop(name, None)
        return CommandResult(("docker", "rm", name), 0, "", "")

    def spawn_stream(self, argv: list[str] | tuple[str, ...]) -> FakeProcess:
        self.spawned.append([str(item) for item in argv])
        return FakeProcess()


# ---------------------------------------------------------------- 夹具
def _metadata(name: str = "demo") -> SandboxMetadata:
    return SandboxMetadata(
        name=name,
        system_user=f"sandbox-{name}",
        uid=1001,
        gid=1001,
        home=f"/home/sandbox-{name}",
        subid_start=165536,
        subid_length=65536,
        image="busybox",
        socket_path="/run/user/1001/docker.sock",
        socket_mount_path="/var/run/docker.sock",
        container_name=f"sandbox-{name}",
        container_id="abc123def456",
        network_name=f"{name}-net",
        unit_path=f"/home/sandbox-{name}/.config/systemd/user/docker.service",
    )


@pytest.fixture
def daemon() -> FakeDaemon:
    """假守护进程。"""
    return FakeDaemon()


@pytest.fixture
def wired(
    service: SandboxService, daemon: FakeDaemon, monkeypatch: pytest.MonkeyPatch
) -> SandboxService:
    """把沙箱服务接到假守护进程上（宿主级交互全部走假实现）。"""
    service.store.save(_metadata("demo"))
    monkeypatch.setattr(service, "_daemon_for", lambda metadata: daemon)
    # 沙箱容器视为在跑（转发只对运行中的沙箱成立）
    daemon.containers["sandbox-demo"] = {
        "running": True,
        "labels": {},
        "network": "demo-net",
    }
    return service


@pytest.fixture
def manager(wired: SandboxService) -> PortForwardManager:
    """转发编排入口。"""
    return wired.forwards


# ---------------------------------------------------------------- 容器规格与命令构造
def test_forward_container_name_follows_template(manager: PortForwardManager) -> None:
    """转发容器名是 <沙箱名>-fwd-<容器端口>。"""
    assert manager.container_name("demo", 8080) == "demo-fwd-8080"


def test_forward_container_labels_carry_platform_marks(
    manager: PortForwardManager,
) -> None:
    """转发容器带平台标签（枚举与回收靠它）。"""
    record = ForwardRecord(id="abc123def456", sandbox="demo", container_port=8080)
    labels = manager.container_labels(record)
    assert labels[LABEL_FORWARD_ROLE] == ROLE_FORWARD
    assert labels[LABEL_FORWARD_ID] == "abc123def456"
    assert labels[LABEL_FORWARD_SANDBOX] == "demo"


def test_forward_run_args_publish_no_port(manager: PortForwardManager) -> None:
    """转发容器**不发布任何端口**：启动参数里没有 -p / --publish。"""
    record = ForwardRecord(id="abc123def456", sandbox="demo", container_port=8080)
    args = manager.run_args(record, network="demo-net")
    assert "-p" not in args
    assert "--publish" not in args
    assert not any(item.startswith("--publish=") for item in args)


def test_forward_run_args_override_entrypoint_and_idle(
    manager: PortForwardManager,
) -> None:
    """转发镜像的 ENTRYPOINT 是 socat：必须显式覆盖并跑常驻空转命令。"""
    record = ForwardRecord(id="abc123def456", sandbox="demo", container_port=8080)
    args = manager.run_args(record, network="demo-net")
    assert args[0] == "run"
    assert "--restart=no" in args
    assert args[args.index("--entrypoint") + 1] == "/bin/sh"
    assert args[-2:] == ["-c", "exec tail -f /dev/null"]
    assert manager.config.forward_image in args


def test_exec_command_bridges_forward_container_to_sandbox(
    manager: PortForwardManager,
) -> None:
    """字节泵命令：docker exec -i <转发容器> socat - TCP:<沙箱容器>:<端口>。"""
    record = ForwardRecord(id="abc123def456", sandbox="demo", container_port=8080)
    assert manager.exec_command(record) == [
        "docker",
        "exec",
        "-i",
        "demo-fwd-8080",
        "socat",
        "-",
        "TCP:sandbox-demo:8080",
    ]


def test_forward_image_is_pinned_to_digest(service: SandboxService) -> None:
    """转发镜像钉 digest（跨机器一致）。"""
    assert service.config.forward_image == FORWARD_IMAGE
    assert "@sha256:" in service.config.forward_image


# ---------------------------------------------------------------- 建立与幂等
def test_create_starts_container_with_platform_labels(
    manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """建立转发：转发容器由沙箱守护进程起，接沙箱网络、带平台标签。"""
    record = manager.create("demo", 8080)
    assert record.sandbox == "demo"
    assert record.container_port == 8080
    container = daemon.containers["demo-fwd-8080"]
    assert container["running"] is True
    assert container["network"] == "demo-net"
    labels = dict(container["labels"])
    assert labels[LABEL_FORWARD_ROLE] == ROLE_FORWARD
    assert labels[LABEL_FORWARD_ID] == record.id
    assert labels[LABEL_FORWARD_SANDBOX] == "demo"


def test_create_is_idempotent(manager: PortForwardManager, daemon: FakeDaemon) -> None:
    """同一沙箱同一端口重复建立：复用既有记录与容器，不重复起容器。"""
    first = manager.create("demo", 8080)
    second = manager.create("demo", 8080)
    assert second.id == first.id
    runs = [cmd for cmd in daemon.commands if cmd[:1] == ["run"]]
    assert len(runs) == 1


def test_create_reuses_record_after_container_gone(
    manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """记录还在但容器没了（沙箱停止过）：按记录幂等重建容器。"""
    first = manager.create("demo", 8080)
    daemon.containers.pop("demo-fwd-8080")
    second = manager.create("demo", 8080)
    assert second.id == first.id
    assert "demo-fwd-8080" in daemon.containers


def test_create_rejects_invalid_port(manager: PortForwardManager) -> None:
    """端口非法直接拒绝，不落任何宿主副作用。"""
    with pytest.raises(ValidationError):
        manager.create("demo", 0)
    with pytest.raises(ValidationError):
        manager.create("demo", 70000)


def test_create_rejects_missing_sandbox(manager: PortForwardManager) -> None:
    """沙箱不存在直接报错。"""
    with pytest.raises(NotFoundError):
        manager.create("ghost", 8080)


def test_create_rejects_stopped_sandbox(
    manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """沙箱已停止时转发链路不成立。"""
    daemon.containers["sandbox-demo"]["running"] = False
    with pytest.raises(ForwardError):
        manager.create("demo", 8080)


# ---------------------------------------------------------------- 停止与回收
def test_stop_removes_container_and_record(
    manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """停止转发：停并删转发容器 + 删记录。"""
    record = manager.create("demo", 8080)
    result = manager.stop(record.id)
    assert "demo-fwd-8080" not in daemon.containers
    assert manager.find(record.id) is None
    assert any("转发容器" in item for item in result.removed)
    assert any("转发记录" in item for item in result.removed)


def test_sandbox_stop_stops_forward_container_but_keeps_record(
    wired: SandboxService, daemon: FakeDaemon
) -> None:
    """沙箱停止：该沙箱的转发容器一并停止，转发记录保留。"""
    record = wired.forwards.create("demo", 8080)
    wired.stop("demo")
    assert daemon.containers["demo-fwd-8080"]["running"] is False
    assert "demo-fwd-8080" in daemon.containers  # 只停止，不删除
    kept = wired.forwards.get(record.id)
    assert kept.state == "stopped"


def test_reclaim_plan_lists_forward_resources(
    wired: SandboxService, manager: PortForwardManager
) -> None:
    """回收清单列出转发容器与转发记录。"""
    record = manager.create("demo", 8080)
    plan = wired.reclaim_plan("demo")
    joined = " ".join(plan.items)
    assert "转发容器 demo-fwd-8080" in joined
    assert f"转发记录 {record.id}" in joined


def test_delete_sandbox_reclaims_forward_container_and_record(
    wired: SandboxService, manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """删除沙箱：转发容器与转发记录一并回收。"""
    record = manager.create("demo", 8080)
    result = wired.delete("demo")
    assert "demo-fwd-8080" not in daemon.containers
    assert manager.find(record.id) is None
    assert any("转发容器 demo-fwd-8080" in item for item in result.removed)
    assert any(f"转发记录 {record.id}" in item for item in result.removed)


def test_purge_leftover_cleans_containers_and_records(
    wired: SandboxService, manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """清理上次遗留：转发容器与转发记录全部清掉（服务重启即丢）。"""
    record = manager.create("demo", 8080)
    daemon.containers["demo-fwd-9999"] = {
        "running": True,
        "labels": {LABEL_FORWARD_ROLE: ROLE_FORWARD},
        "network": "demo-net",
    }
    result = manager.purge_leftover()
    assert "demo-fwd-8080" not in daemon.containers
    assert "demo-fwd-9999" not in daemon.containers
    assert manager.find(record.id) is None
    assert any("转发容器" in item for item in result.removed)
    assert any("转发记录" in item for item in result.removed)


# ---------------------------------------------------------------- 记录读写
def test_record_file_is_private_and_atomic(
    manager: PortForwardManager, service: SandboxService
) -> None:
    """转发记录落 <平台数据根>/forwards/<id>.json，权限 0600，内容完整。"""
    record = manager.create("demo", 8080)
    path = service.config.forward_root / f"{record.id}.json"
    assert path.is_file()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["id"] == record.id
    assert data["sandbox"] == "demo"
    assert data["container_port"] == 8080
    assert data["state"] == "running"
    assert data["created_at"]
    assert data["updated_at"]
    # 没有宿主端口字段
    assert "host_port" not in data
    # 原子替换：目录里不留临时文件
    assert [item.name for item in service.config.forward_root.iterdir()] == [path.name]


def test_corrupted_record_is_reported_and_skipped(
    manager: PortForwardManager, service: SandboxService
) -> None:
    """损坏的记录文件：单条读取报错，整批枚举跳过，遗留清理一并删掉。"""
    broken = service.config.forward_root / "deadbeefdead.json"
    service.config.forward_root.mkdir(parents=True, exist_ok=True)
    broken.write_text("{不是合法 JSON", encoding="utf-8")
    with pytest.raises(ValidationError):
        manager.get("deadbeefdead")
    assert manager.list() == []
    manager.purge_leftover()
    assert not broken.exists()


def test_forward_id_must_be_safe(manager: PortForwardManager) -> None:
    """转发标识会拼进记录文件路径：非法标识直接拒绝。"""
    with pytest.raises(ValidationError):
        manager.get("../../etc/passwd")


# ---------------------------------------------------------------- 字节泵
def test_open_byte_pump_runs_exec_command(
    manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """字节泵在沙箱守护进程下起 exec 进程；关闭即刻回收进程。"""
    record = manager.create("demo", 8080)
    pump = manager.open_byte_pump(record)
    assert daemon.spawned[-1] == [
        "docker",
        "exec",
        "-i",
        "demo-fwd-8080",
        "socat",
        "-",
        "TCP:sandbox-demo:8080",
    ]
    pump.write(b"ping")
    assert pump.read() == b""
    pump.close()
    assert pump.process.terminated is True
    assert pump.alive is False


# ---------------------------------------------------------------- 坏记录：不能拖垮整批
def test_non_dict_record_file_is_skipped(
    manager: PortForwardManager, service: SandboxService
) -> None:
    """合法 JSON 但不是对象（``[1,2,3]``）：整批枚举跳过并告警，不抛异常。"""
    service.config.forward_root.mkdir(parents=True, exist_ok=True)
    broken = service.config.forward_root / "aaaaaaaaaaaa.json"
    broken.write_text("[1,2,3]", encoding="utf-8")
    assert manager.list() == []
    # 遗留清理照样跑得完（坏文件也一并清掉）
    manager.purge_leftover()
    assert not broken.exists()


def test_non_dict_record_does_not_break_sandbox_reclaim(
    wired: SandboxService, service: SandboxService
) -> None:
    """坏记录不拖垮整批：回收清单与删除都走完，不抛异常。"""
    service.config.forward_root.mkdir(parents=True, exist_ok=True)
    (service.config.forward_root / "aaaaaaaaaaaa.json").write_text(
        "[1,2,3]", encoding="utf-8"
    )
    plan = wired.reclaim_plan("demo")
    assert plan.sandbox_name == "demo"
    result = wired.delete("demo")
    assert result.name == "demo"


def test_record_with_invalid_id_is_skipped(
    manager: PortForwardManager, service: SandboxService
) -> None:
    """记录里的标识非法：整批枚举跳过，单条读取按「文件损坏」处理。"""
    service.config.forward_root.mkdir(parents=True, exist_ok=True)
    (service.config.forward_root / "aaaaaaaaaaaa.json").write_text(
        json.dumps(
            {"id": "../../etc/passwd", "sandbox": "demo", "container_port": 8080}
        ),
        encoding="utf-8",
    )
    assert manager.list() == []
    with pytest.raises(ValidationError):
        manager.get("aaaaaaaaaaaa")


def test_invalid_record_does_not_break_sandbox_delete(
    wired: SandboxService, service: SandboxService
) -> None:
    """标识非法的记录：回收清单不抛，沙箱删除流程走完（不中断）。"""
    service.config.forward_root.mkdir(parents=True, exist_ok=True)
    (service.config.forward_root / "aaaaaaaaaaaa.json").write_text(
        json.dumps({"id": "非法标识", "sandbox": "demo", "container_port": 8080}),
        encoding="utf-8",
    )
    plan = wired.reclaim_plan("demo")
    assert plan.sandbox_name == "demo"
    result = wired.delete("demo")
    assert result.name == "demo"


# ---------------------------------------------------------------- 同名容器：只动平台自建的
def test_platform_container_with_stale_id_is_rebuilt(
    manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """同名平台容器（标签齐、标识对不上）：按遗留处理，删掉重建。"""
    daemon.containers["demo-fwd-8080"] = {
        "running": True,
        "labels": {LABEL_FORWARD_ROLE: ROLE_FORWARD, LABEL_FORWARD_ID: "deadbeefdead"},
        "network": "demo-net",
    }
    record = manager.create("demo", 8080)
    labels = daemon.container_labels("demo-fwd-8080")
    assert labels[LABEL_FORWARD_ID] == record.id
    assert labels[LABEL_FORWARD_ROLE] == ROLE_FORWARD


def test_foreign_container_with_same_name_is_never_deleted(
    manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """同名非平台容器（用户自建）：平台不删它，报容器名冲突。"""
    daemon.containers["demo-fwd-8080"] = {
        "running": True,
        "labels": {"user.label": "mine"},
        "network": "demo-net",
    }
    with pytest.raises(ForwardError) as excinfo:
        manager.create("demo", 8080)
    assert "重名" in str(excinfo.value)
    # 原容器完好
    assert "demo-fwd-8080" in daemon.containers
    assert daemon.containers["demo-fwd-8080"]["running"] is True


# ---------------------------------------------------------------- 容器删不掉：记录保留
def test_record_kept_when_container_removal_fails(
    manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """容器删不掉：记录**保留**（不删），失败如实上报，不留孤儿容器。"""
    record = manager.create("demo", 8080)
    daemon.remove_failures.add("demo-fwd-8080")
    result = manager.stop(record.id)
    assert manager.find(record.id) is not None
    assert any("删除失败" in item for item in result.failed)
    assert not any("转发容器" in item for item in result.removed)


def test_reclaim_keeps_record_when_container_removal_fails(
    wired: SandboxService, manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """沙箱删除时容器删不掉：记录保留，回收清单的 failed 里如实上报。"""
    record = manager.create("demo", 8080)
    daemon.remove_failures.add("demo-fwd-8080")
    result = wired.delete("demo")
    assert manager.find(record.id) is not None
    assert any("转发容器" in item and "删除失败" in item for item in result.failed)


# ---------------------------------------------------------------- 探测失败：不宣称已删除
def test_unreachable_daemon_does_not_claim_container_removed(
    manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """沙箱守护进程不可达：探测失败按失败处理，不宣称容器已删除。"""
    record = manager.create("demo", 8080)
    daemon.inspect_failures.add("demo-fwd-8080")
    result = manager.stop(record.id)
    assert not any("转发容器" in item for item in result.removed)
    assert any("探测失败" in item for item in result.failed)
    # 记录也保留（容器还在，不能当已回收）
    assert manager.find(record.id) is not None


# ---------------------------------------------------------------- 跨实例保护
def test_purge_leftover_skips_records_of_other_live_instance(
    manager: PortForwardManager, daemon: FakeDaemon, service: SandboxService
) -> None:
    """属于另一个仍活着的服务实例的转发：清理时不动（同终端会话表语义）。"""
    record = manager.create("demo", 8080)
    path = service.config.forward_root / f"{record.id}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["host_pid"] = os.getppid()  # 另一个还活着的进程
    path.write_text(json.dumps(data), encoding="utf-8")
    result = manager.purge_leftover()
    assert manager.find(record.id) is not None
    assert "demo-fwd-8080" in daemon.containers
    assert not any(record.id in item for item in result.removed)


def test_purge_leftover_removes_temp_file_residue(
    manager: PortForwardManager, service: SandboxService
) -> None:
    """写入过程残留的临时文件（``.forward-*.tmp``）一并清掉。"""
    service.config.forward_root.mkdir(parents=True, exist_ok=True)
    residue = service.config.forward_root / ".forward-abcd1234.tmp"
    residue.write_text("半截 JSON", encoding="utf-8")
    manager.purge_leftover()
    assert not residue.exists()


# ---------------------------------------------------------------- 回收清单：转发容器不重复列
def test_reclaim_plan_does_not_list_forward_container_as_dependency(
    wired: SandboxService,
    manager: PortForwardManager,
    daemon: FakeDaemon,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """转发容器只在转发清单里出现，不重复列成「依赖容器」。"""
    daemon.containers["user-dep"] = {
        "running": True,
        "labels": {},
        "network": "demo-net",
    }
    manager.create("demo", 8080)
    monkeypatch.setattr(
        wired,
        "_resolve_user",
        lambda metadata: SystemUser("sandbox-demo", 1001, 1001, Path("/home/sandbox-demo")),
    )
    monkeypatch.setattr(wired, "_daemon_for_user", lambda user: daemon)
    plan = wired.reclaim_plan("demo")
    dependency_items = [item for item in plan.items if item.startswith("依赖容器")]
    assert dependency_items
    assert all("demo-fwd-8080" not in item for item in dependency_items)
    assert any("转发容器 demo-fwd-8080" in item for item in plan.items)


# ---------------------------------------------------------------- 并发：管理器串行化
def test_create_is_serialized_across_threads(
    manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """并发建立：管理器串行化，同一沙箱同一端口只起一个容器、只留一条记录。"""
    daemon.run_delay = 0.05
    results: list[object] = []

    def worker() -> None:
        try:
            results.append(manager.create("demo", 8080))
        except Exception as exc:  # pragma: no cover - 失败会在断言里暴露
            results.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    ids = {item.id for item in results if isinstance(item, ForwardRecord)}
    assert len(ids) == 1
    runs = [cmd for cmd in daemon.commands if cmd[:1] == ["run"]]
    assert len(runs) == 1


# ---------------------------------------------------------------- 异常归位
def test_forward_error_lives_in_errors_module() -> None:
    """ForwardError 归位 errors.py（仓库的业务异常都在那儿）。"""
    assert ForwardError is ForwardErrorFromErrors
    assert ForwardError.__module__ == "sandbox_platform.errors"


# ---------------------------------------------------------------- 字节泵：进程组回收
def _process_alive(pid: int) -> bool:
    """进程还活着（僵尸不算：僵尸只是等父进程回收）。"""
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError:
        return False
    try:
        state = text[text.rindex(")") + 1 :].split()[0]
    except (ValueError, IndexError):
        return False
    return state != "Z"


def test_byte_pump_close_reaps_whole_process_group() -> None:
    """关闭字节泵按**进程组**回收：孙进程一并收掉，不留孤儿。"""
    code = (
        "import subprocess, sys\n"
        "child = subprocess.Popen(['sleep', '60'])\n"
        "print(child.pid, flush=True)\n"
        "sys.stdin.read()\n"
    )
    process = subprocess.Popen(
        [sys.executable, "-c", code],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
        start_new_session=True,
    )
    grandchild = int(process.stdout.readline().decode().strip())
    assert _process_alive(grandchild)
    try:
        with BytePump(process=process, forward_id="abc123def456") as pump:
            assert pump.alive
        assert process.poll() is not None
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and _process_alive(grandchild):
            time.sleep(0.05)
        assert not _process_alive(grandchild)
    finally:
        try:
            os.kill(grandchild, signal.SIGKILL)
        except OSError:
            pass


def test_byte_pump_context_manager_closes_process(
    manager: PortForwardManager, daemon: FakeDaemon
) -> None:
    """字节泵是上下文管理器：退出即回收进程（异常路径也回收）。"""
    record = manager.create("demo", 8080)
    with manager.open_byte_pump(record) as pump:
        assert pump.alive
    assert pump.process.terminated is True
    assert pump.alive is False


def test_spawn_stream_starts_new_session(monkeypatch: pytest.MonkeyPatch) -> None:
    """字节泵子进程自带新会话：关闭时能按进程组整体回收。"""
    from sandbox_platform import daemon as daemon_module
    from sandbox_platform.daemon import UserContext, UserDaemon
    from sandbox_platform.userspace import Privilege

    captured: dict[str, object] = {}

    def fake_popen(command: list[str], **kwargs: object) -> FakeProcess:
        captured["command"] = command
        captured.update(kwargs)
        return FakeProcess()

    monkeypatch.setattr(daemon_module.subprocess, "Popen", fake_popen)
    user_daemon = UserDaemon(
        UserContext(
            user="sandbox-demo",
            uid=1001,
            gid=1001,
            home=Path("/home/sandbox-demo"),
        ),
        Privilege(enabled=False),
    )
    user_daemon.spawn_stream(["docker", "exec", "-i", "demo-fwd-8080", "socat", "-", "TCP:x:1"])
    assert captured["start_new_session"] is True
