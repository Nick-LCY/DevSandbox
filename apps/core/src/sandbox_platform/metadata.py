"""沙箱元数据存储。

元数据落在平台数据根目录下（默认 ``/var/lib/sandbox-platform``，可用环境变量
``SANDBOX_PLATFORM_HOME`` 重定向），每个沙箱一个目录一个 JSON 文件。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import PlatformConfig
from .errors import ConfigError, ValidationError
from .images import IMAGE_SOURCE_AUTO
from .mounts import MountSpec

logger = logging.getLogger(__name__)

STATE_RUNNING = "running"
STATE_STOPPED = "stopped"
STATE_DELETED = "deleted"

STATE_LABELS = {
    STATE_RUNNING: "运行中",
    STATE_STOPPED: "已停止",
    STATE_DELETED: "已删除",
}

#: 注入条目的种类（与 ``files._refresh_helper`` 的 ``KIND_*`` 同款取值）
INJECTION_KIND_FILE = "file"
INJECTION_KIND_DIRECTORY = "directory"

#: 注入条目的合法种类集合
INJECTION_KINDS = (INJECTION_KIND_FILE, INJECTION_KIND_DIRECTORY)


@dataclass(frozen=True)
class InjectionRecord:
    """一条注入声明记录（**实例事实**，additive 元数据）。

    这是「文件注入副本手动刷新」轮新增的**可选**元数据块：创建沙箱时把
    **已校验的**宿主源路径与托管副本的**文件身份**一并记下，刷新时据此
    定位「这一条」的源与副本。

    字段：

    - ``entry_id``：条目标识（**稳定**：同一组输入恒等，落盘后不再变）；
    - ``source_path``：已校验的宿主源绝对路径（**实例事实**，不反查模板）；
    - ``staged_path``：托管副本绝对路径（落在沙箱用户家目录里）；
    - ``container_path``：容器内目标路径（只读挂载点）；
    - ``kind``：``file`` / ``directory``；
    - ``dev`` / ``ino``：托管副本根的 ``st_dev`` / ``st_ino``（**目标文件
      身份**：刷新时核对，防写穿到冒名副本）。

    **旧实例没有这块记录**：缺这条记录的沙箱**不迁移、不补录**，仍可正常
    查看 / 管理 / 删除，只是没有可刷新的条目。
    """

    entry_id: str
    source_path: str
    staged_path: str
    container_path: str
    kind: str
    dev: int = 0
    ino: int = 0


def injection_entry_id(
    index: int,
    source_path: str,
    staged_path: str,
    container_path: str,
) -> str:
    """生成**稳定**的注入条目标识。

    稳定性口径：同一组（序号, 源路径, 副本路径, 容器路径）**恒等**——
    重启、重启平台服务、重新读出元数据都拿到同一个 id；不同条目必不同
    （含序号与四条路径的摘要）。
    """
    payload = "\x00".join(
        [str(index), source_path, staged_path, container_path]
    ).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()[:12]
    return f"inj-{index}-{digest}"


def _injection_from_dict(item: Any) -> InjectionRecord | None:
    """从字典还原一条注入记录；**字段缺失或类型不对一律跳过**。

    宽容口径与元数据整体一致（未知 / 缺失字段不炸）：一条坏记录不该让
    整个沙箱读不出来。跳过的记录会在日志里留痕。
    """
    if not isinstance(item, dict):
        return None
    values: dict[str, Any] = {}
    for key in ("entry_id", "source_path", "staged_path", "container_path", "kind"):
        raw = item.get(key)
        if not isinstance(raw, str) or not raw:
            return None
        values[key] = raw
    if values["kind"] not in INJECTION_KINDS:
        return None
    for key in ("dev", "ino"):
        raw = item.get(key, 0)
        if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
            raw = 0
        values[key] = raw
    return InjectionRecord(**values)


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
    image_source: str = IMAGE_SOURCE_AUTO
    state: str = STATE_STOPPED
    network_owned: bool = True
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)
    mounts: list[MountSpec] = field(default_factory=list)
    files: list[MountSpec] = field(default_factory=list)
    #: 注入声明记录（**additive**：旧实例缺省为空列表，既有读取零回归）
    injections: list[InjectionRecord] = field(default_factory=list)
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
        data["files"] = [
            {
                "host_path": mount.host_path,
                "container_path": mount.container_path,
                "read_only": mount.read_only,
                "role": mount.role,
            }
            for mount in self.files
        ]
        data["injections"] = [
            {
                "entry_id": item.entry_id,
                "source_path": item.source_path,
                "staged_path": item.staged_path,
                "container_path": item.container_path,
                "kind": item.kind,
                "dev": item.dev,
                "ino": item.ino,
            }
            for item in self.injections
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
        files = [
            MountSpec(
                host_path=item["host_path"],
                container_path=item["container_path"],
                read_only=bool(item.get("read_only", False)),
                role=item.get("role", "file"),
            )
            for item in data.get("files", [])
        ]
        known = {f for f in cls.__dataclass_fields__}
        payload = {key: value for key, value in data.items() if key in known}
        payload["mounts"] = mounts
        payload["files"] = files
        injections: list[InjectionRecord] = []
        for item in data.get("injections") or []:
            record = _injection_from_dict(item)
            if record is None:
                logger.warning("注入声明记录字段不合法，已跳过：%r", item)
                continue
            injections.append(record)
        payload["injections"] = injections
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
                "请确保运行用户对数据根目录可写（目录须已存在），"
                "或用 SANDBOX_PLATFORM_HOME 指向当前用户可写目录"
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
