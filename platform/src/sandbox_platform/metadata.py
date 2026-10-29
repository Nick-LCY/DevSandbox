"""沙箱元数据存储。

元数据落在平台数据根目录下（默认 ``/var/lib/sandbox-platform``，可用环境变量
``SANDBOX_PLATFORM_HOME`` 重定向），每个沙箱一个目录一个 JSON 文件。
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import PlatformConfig
from .errors import ConfigError, ValidationError
from .mounts import MountSpec

STATE_RUNNING = "running"
STATE_STOPPED = "stopped"
STATE_DELETED = "deleted"

STATE_LABELS = {
    STATE_RUNNING: "运行中",
    STATE_STOPPED: "已停止",
    STATE_DELETED: "已删除",
}


def utc_now() -> str:
    """当前 UTC 时间戳（ISO 8601）。"""
    return datetime.now(UTC).isoformat(timespec="seconds")


@dataclass
class SandboxMetadata:
    """单个沙箱的完整元数据。"""

    name: str
    system_user: str
    uid: int
    gid: int
    home: str
    subid_start: int
    subid_length: int
    image: str
    socket_path: str
    socket_mount_path: str
    container_name: str
    container_id: str
    network_name: str
    unit_path: str
    state: str = STATE_STOPPED
    network_owned: bool = True
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)
    mounts: list[MountSpec] = field(default_factory=list)
    dependency_containers: list[str] = field(default_factory=list)
    labels: dict[str, str] = field(default_factory=dict)
    command: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    workdir: str = ""

    # ---------------------------------------------------------------- 序列化
    def to_dict(self) -> dict[str, Any]:
        """转为可 JSON 序列化的字典。"""
        data = asdict(self)
        data["mounts"] = [
            {
                "host_path": mount.host_path,
                "container_path": mount.container_path,
                "read_only": mount.read_only,
                "role": mount.role,
            }
            for mount in self.mounts
        ]
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SandboxMetadata:
        """从字典还原。"""
        mounts = [
            MountSpec(
                host_path=item["host_path"],
                container_path=item["container_path"],
                read_only=bool(item.get("read_only", False)),
                role=item.get("role", "user"),
            )
            for item in data.get("mounts", [])
        ]
        known = {f for f in cls.__dataclass_fields__}
        payload = {key: value for key, value in data.items() if key in known}
        payload["mounts"] = mounts
        return cls(**payload)

    # ---------------------------------------------------------------- 便捷属性
    @property
    def state_label(self) -> str:
        """状态中文标签。"""
        return STATE_LABELS.get(self.state, self.state)

    @property
    def mount_summary(self) -> str:
        """挂载清单文本。"""
        if not self.mounts:
            return "（无）"
        return ", ".join(mount.describe() for mount in self.mounts)

    def touch(self) -> None:
        """刷新更新时间戳。"""
        self.updated_at = utc_now()


class MetadataStore:
    """沙箱元数据仓库。"""

    def __init__(self, config: PlatformConfig) -> None:
        self.config = config

    # ---------------------------------------------------------------- 路径
    @property
    def root(self) -> Path:
        """元数据根目录。"""
        return self.config.sandbox_root

    def sandbox_dir(self, name: str) -> Path:
        """单个沙箱的工作目录。

        兜底断言：沙箱名不得含路径分隔符，防止元数据目录被写到数据根之外。
        """
        if Path(name).name != name or name in ("", ".", ".."):
            raise ValidationError(f"沙箱名非法（不得含路径分隔符）：{name!r}")
        return self.config.sandbox_dir(name)

    def path_for(self, name: str) -> Path:
        """单个沙箱的元数据文件路径。"""
        return self.sandbox_dir(name) / "metadata.json"

    # ---------------------------------------------------------------- 读写
    def exists(self, name: str) -> bool:
        """沙箱元数据是否存在。"""
        return self.path_for(name).is_file()

    def save(self, metadata: SandboxMetadata) -> Path:
        """写入元数据（原子替换）。"""
        metadata.touch()
        directory = self.sandbox_dir(metadata.name)
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except PermissionError as exc:
            raise ConfigError(
                f"平台数据根目录不可写：{self.root}。"
                "请以 root 运行控制面，或用 SANDBOX_PLATFORM_HOME 指向当前用户可写目录"
            ) from exc
        target = self.path_for(metadata.name)
        payload = json.dumps(metadata.to_dict(), ensure_ascii=False, indent=2, sort_keys=True)
        handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - 临时文件需手动改权限后原子替换
            "w", encoding="utf-8", dir=directory, prefix=".metadata-", suffix=".tmp", delete=False
        )
        try:
            with handle:
                handle.write(payload)
                handle.write("\n")
            os.chmod(handle.name, 0o600)
            os.replace(handle.name, target)
        except BaseException:
            Path(handle.name).unlink(missing_ok=True)
            raise
        return target

    def load(self, name: str) -> SandboxMetadata | None:
        """读取元数据；不存在返回 ``None``。"""
        path = self.path_for(name)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValidationError(f"沙箱元数据文件损坏：{path}") from exc
        return SandboxMetadata.from_dict(data)

    def list_all(self) -> list[SandboxMetadata]:
        """列出全部沙箱元数据，按名称排序。"""
        if not self.root.is_dir():
            return []
        result: list[SandboxMetadata] = []
        for directory in sorted(self.root.iterdir()):
            if not directory.is_dir():
                continue
            path = directory / "metadata.json"
            if not path.is_file():
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                result.append(SandboxMetadata.from_dict(data))
            except (json.JSONDecodeError, KeyError, TypeError):
                continue
        return result

    def delete(self, name: str) -> bool:
        """删除沙箱元数据目录；返回是否确实删除了东西。"""
        directory = self.sandbox_dir(name)
        try:
            if not directory.exists():
                return False
        except OSError:
            return False
        for child in sorted(directory.iterdir()):
            if child.is_dir():
                for sub in sorted(child.rglob("*"), reverse=True):
                    if sub.is_file() or sub.is_symlink():
                        sub.unlink(missing_ok=True)
                    elif sub.is_dir():
                        sub.rmdir()
                child.rmdir()
            else:
                child.unlink(missing_ok=True)
        directory.rmdir()
        return True
