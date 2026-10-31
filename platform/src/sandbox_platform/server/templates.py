"""启动模板库：模板元数据的落盘、内置种子注入与删除墓碑。

模板库落在平台数据根目录下的 ``templates/`` 目录，一个模板一个 JSON 文件：
``templates/<模板标识>.json``。模板标识由服务端生成，与名称解耦——重命名只改
名称，不动标识，前端也不必处理标识变化。

**字段「是否出现过」是模板语义的一部分**：模板应用语义是「出现字段整体替换、
缺失字段保持现状」，因此落盘只导出用户真正填过的字段（``exclude_unset=True``），
不做全量默认导出——否则「没填」与「填了空值」无法区分。

内置模板以常量形式声明（:data:`BUILTIN_TEMPLATES`），服务启动时按标识注入：
同标识文件已存在不覆盖、命中墓碑的标识不复活。墓碑落在
``templates/.builtin/state.json``，记录被用户删掉的内置模板标识。
``.builtin`` 是点开头的隐藏目录，不参与用户模板枚举。

本模块只管落盘与种子，不碰宿主与容器：模板是一份配置文本而已。
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sandbox_platform import ConfigError, PlatformConfig
from sandbox_platform.metadata import utc_now

logger = logging.getLogger(__name__)

# 模板库目录名（相对平台数据根）
TEMPLATES_DIRNAME = "templates"

# 内置模板状态子目录：点开头的隐藏目录，不参与用户模板枚举
BUILTIN_DIRNAME = ".builtin"

# 内置模板墓碑文件名（落在内置状态子目录下）
BUILTIN_STATE_FILENAME = "state.json"

# 模板标识前缀（标识由服务端生成，不接受客户端指定）
TEMPLATE_ID_PREFIX = "tpl_"

# 内置模板种子：常量元组，**本期为空**（只落地机制，不预置真实模板内容）。
# 每条的形状：``{"id": ..., "name": ..., "config": {...}}``。
# 将来加一条内置模板即自动生效：启动注入与列表读取都会补上
# （同标识已存在不覆盖、命中墓碑的不复活）。
BUILTIN_TEMPLATES: tuple[dict[str, Any], ...] = ()


def templates_dir(config: PlatformConfig) -> Path:
    """模板库目录：``<平台数据根>/templates``。"""
    return config.home / TEMPLATES_DIRNAME


def prepare_templates_dir(config: PlatformConfig) -> Path:
    """准备模板库目录（幂等）。"""
    path = templates_dir(config)
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ConfigError(f"模板库目录不可写：{path}（{exc}）") from exc
    return path


def new_template_id() -> str:
    """生成模板标识：``tpl_`` + 12 位十六进制随机串。"""
    return f"{TEMPLATE_ID_PREFIX}{secrets.token_hex(6)}"


def builtin_template_ids() -> set[str]:
    """内置模板标识集合。

    按当前常量实时计算（不在导入时固化）：常量被替换后立即生效。
    """
    ids: set[str] = set()
    for item in BUILTIN_TEMPLATES:
        if not isinstance(item, dict):
            continue
        raw = item.get("id")
        if raw:
            ids.add(str(raw))
    return ids


@dataclass
class TemplateRecord:
    """一条启动模板的元数据（模板库的一个文件）。"""

    id: str
    name: str
    config: dict[str, Any] = field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        """转为可 JSON 序列化的字典。"""
        return {
            "id": self.id,
            "name": self.name,
            "config": dict(self.config),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TemplateRecord:
        """从字典还原（缺字段按空值补齐，坏数据不炸）。"""
        raw_config = data.get("config")
        config = dict(raw_config) if isinstance(raw_config, dict) else {}
        return cls(
            id=_as_text(data.get("id")),
            name=_as_text(data.get("name")),
            config=config,
            created_at=_as_text(data.get("created_at")),
            updated_at=_as_text(data.get("updated_at")),
        )


class TemplateStore:
    """启动模板库：一个模板一个 JSON 文件，原子替换写入。"""

    def __init__(self, config: PlatformConfig) -> None:
        self.config = config

    @property
    def directory(self) -> Path:
        """模板库目录。"""
        return templates_dir(self.config)

    @property
    def builtin_state_path(self) -> Path:
        """内置模板墓碑文件路径：``templates/.builtin/state.json``。"""
        return self.directory / BUILTIN_DIRNAME / BUILTIN_STATE_FILENAME

    def path_for(self, template_id: str) -> Path:
        """单个模板的记录文件路径（标识非法直接报错）。"""
        if not _valid_template_id(template_id):
            raise ConfigError(f"模板标识非法：{template_id!r}")
        return self.directory / f"{template_id}.json"

    def save(self, record: TemplateRecord) -> Path:
        """写入模板记录（原子替换，文件权限 0600）。"""
        target = self.path_for(record.id)
        return _write_json_atomic(target, record.to_dict(), label="模板库")

    def load(self, template_id: str) -> TemplateRecord | None:
        """读取模板记录；不存在、标识非法或内容损坏都返回 ``None``。"""
        if not _valid_template_id(template_id):
            return None
        path = self.directory / f"{template_id}.json"
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.error("模板记录损坏，按不存在处理：%s", path)
            return None
        if not isinstance(data, dict):
            return None
        record = TemplateRecord.from_dict(data)
        if not record.id:
            # 记录内容不完整：以文件名（模板标识）为准
            record.id = template_id
        return record

    def list_all(self) -> list[TemplateRecord]:
        """列出全部用户模板（只扫顶层 ``*.json``，按标识排序）。"""
        directory = self.directory
        if not directory.is_dir():
            return []
        try:
            files = sorted(directory.glob("*.json"))
        except OSError as exc:
            raise ConfigError(f"模板库目录不可读：{directory}（{exc}）") from exc
        result: list[TemplateRecord] = []
        for path in files:
            record = self.load(path.stem)
            if record is not None:
                result.append(record)
        return result

    def delete(self, template_id: str) -> bool:
        """删除模板记录；返回是否确实删掉了东西。"""
        if not _valid_template_id(template_id):
            return False
        path = self.directory / f"{template_id}.json"
        try:
            path.unlink()
        except FileNotFoundError:
            return False
        except OSError as exc:
            logger.error("删除模板记录失败：%s（%s）", path, exc)
            return False
        return True

    def mark_builtin_deleted(self, template_id: str) -> None:
        """记下「这个内置模板被用户删了」（写墓碑），后续注入不再复活它。"""
        keys = self.builtin_deleted_keys()
        if template_id in keys:
            return
        keys.add(template_id)
        _write_json_atomic(
            self.builtin_state_path,
            {"deleted": sorted(keys)},
            label="内置模板墓碑",
        )

    def builtin_deleted_keys(self) -> set[str]:
        """读墓碑：已被删除的内置模板标识集合（坏数据按空集处理）。"""
        path = self.builtin_state_path
        if not path.is_file():
            return set()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.error("内置模板墓碑文件损坏，按空集处理：%s", path)
            return set()
        if not isinstance(data, dict):
            return set()
        raw = data.get("deleted")
        if not isinstance(raw, list):
            return set()
        return {str(item) for item in raw}


def ensure_builtin_templates(config: PlatformConfig) -> list[str]:
    """注入内置模板种子（幂等），返回本次实际注入的标识列表。

    三条跳过规则：命中墓碑（用户删过）不复活、同标识文件已存在不覆盖、
    标识非法不注入。目录不可用或单条写入失败时只记日志，不抛异常——
    种子注入失败不阻断服务启动。
    """
    store = TemplateStore(config)
    try:
        prepare_templates_dir(config)
    except ConfigError as exc:
        logger.error("内置模板注入跳过：%s", exc)
        return []
    deleted = store.builtin_deleted_keys()
    injected: list[str] = []
    for item in BUILTIN_TEMPLATES:
        if not isinstance(item, dict):
            logger.error("内置模板条目格式非法，已跳过：%r", item)
            continue
        template_id = _as_text(item.get("id")).strip()
        if not template_id or not _valid_template_id(template_id):
            logger.error("内置模板标识非法，已跳过：%r", item.get("id"))
            continue
        if template_id in deleted:
            # 用户删过：记着墓碑，不再复活
            continue
        if store.load(template_id) is not None:
            # 已有同标识文件（用户改过名或改过内容）：不覆盖
            continue
        now = utc_now()
        raw_config = item.get("config")
        record = TemplateRecord(
            id=template_id,
            name=_as_text(item.get("name")),
            config=dict(raw_config) if isinstance(raw_config, dict) else {},
            created_at=now,
            updated_at=now,
        )
        try:
            store.save(record)
        except ConfigError as exc:
            logger.error("内置模板写入失败（%s）：%s", template_id, exc)
            continue
        injected.append(template_id)
    return injected


def _valid_template_id(template_id: str) -> bool:
    """模板标识是否可用（拒绝路径穿越与隐藏目录名）。"""
    if not template_id or template_id.startswith("."):
        return False
    return Path(template_id).name == template_id


def _as_text(value: Any) -> str:
    """把落盘里的值取成文本（空值归一成空串）。"""
    if value is None:
        return ""
    return str(value)


def _write_json_atomic(path: Path, payload: dict[str, Any], *, label: str) -> Path:
    """原子写 JSON 文件：写临时文件 → 改权限 0600 → 原子替换。

    进程中断不留半截文件；文件权限与平台其他元数据一致（0600）。
    """
    directory = path.parent
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ConfigError(f"{label}目录不可写：{directory}（{exc}）") from exc
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - 临时文件需改权限后原子替换
        "w", encoding="utf-8", dir=directory, prefix=".template-", suffix=".tmp", delete=False
    )
    try:
        with handle:
            handle.write(text)
            handle.write("\n")
        os.chmod(handle.name, 0o600)
        os.replace(handle.name, path)
    except BaseException:
        Path(handle.name).unlink(missing_ok=True)
        raise
    return path
