"""终端会话表：会话元数据的落盘与遗留记录清理。

会话表是本期唯一新增的持久化数据，落在平台数据根目录下的
``terminal-sessions/<session_id>.json``。表里只登记会话元数据；伪终端与容器内
进程存活在服务进程内存中，服务重启即失效（与「服务重启会话全丢」的口径一致）。

服务启动时（应用 lifespan 调用 :func:`purge_leftover_sessions`）把表里全部记录
标记为孤儿并清理：按记录里的宿主进程号终止遗留进程，仅当该进程命令行含本次
会话标识时才终止，避免误杀被复用的进程号；再按同一个会话标识把容器内残留的
shell 收掉（杀宿主侧 exec 客户端收不掉容器内进程）；随后删除记录文件。

记录里带 ``host_pid``（建会话的服务进程号）：同一个平台数据根可能被两个服务
实例共用，启动清理时发现记录属于**另一个还活着的实例**，就不动它——那个实例
正在用这些会话，误杀会打断别人的终端。
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from sandbox_platform import ConfigError, PlatformConfig, pid_alive, terminate_pty_process
from sandbox_platform.metadata import utc_now

logger = logging.getLogger(__name__)

TERMINAL_SESSIONS_DIRNAME = "terminal-sessions"

# 会话状态
SESSION_STATE_RUNNING = "running"
SESSION_STATE_EXITED = "exited"
SESSION_STATE_ORPHANED = "orphaned"

# 会话结束原因：区分「容器内进程自己退出」与「被人为关掉」，
# 客户端据此提示成功还是失败（主动关闭不该报成异常退出）。
SESSION_EXIT_REASON_EXITED = "exited"  # 容器内进程自己退出
SESSION_EXIT_REASON_CLOSED_BY_USER = "closed_by_user"  # 用户主动关闭
SESSION_EXIT_REASON_RECLAIMED = "reclaimed"  # 空闲回收
SESSION_EXIT_REASON_SHUTDOWN = "shutdown"  # 服务退出兜底

# 清理遗留会话时可选的「容器内进程清理」回调：
# (沙箱名, 容器名, 会话标识) -> None
ContainerSessionKiller = Callable[[str, str, str], None]


def sessions_dir(config: PlatformConfig) -> Path:
    """终端会话表目录：``<平台数据根>/terminal-sessions``。"""
    return config.home / TERMINAL_SESSIONS_DIRNAME


def prepare_sessions_dir(config: PlatformConfig) -> Path:
    """准备终端会话表目录（幂等）。"""
    path = sessions_dir(config)
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ConfigError(f"终端会话表目录不可写：{path}（{exc}）") from exc
    return path


@dataclass
class TerminalSessionRecord:
    """一条终端会话的元数据（会话表的一行）。"""

    session_id: str
    sandbox_name: str
    container_name: str
    system_user: str
    created_at: str
    last_attached_at: str
    state: str
    exit_code: int | None
    pid: int
    cols: int
    rows: int
    attached_count: int
    # 建会话的服务进程号：启动清理时用来判断「这条记录是不是另一个实例的」
    host_pid: int = 0
    # 结束原因（未结束为空）：见 SESSION_EXIT_REASON_* 常量
    exit_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """转为可 JSON 序列化的字典。"""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TerminalSessionRecord:
        """从字典还原（缺字段按空值补齐，坏数据不炸）。"""
        return cls(
            session_id=str(data.get("session_id", "")),
            sandbox_name=str(data.get("sandbox_name", "")),
            container_name=str(data.get("container_name", "")),
            system_user=str(data.get("system_user", "")),
            created_at=str(data.get("created_at", "")),
            last_attached_at=str(data.get("last_attached_at", "")),
            state=str(data.get("state", SESSION_STATE_RUNNING)),
            exit_code=None if data.get("exit_code") is None else int(data["exit_code"]),
            pid=int(data.get("pid", 0) or 0),
            cols=int(data.get("cols", 0) or 0),
            rows=int(data.get("rows", 0) or 0),
            attached_count=int(data.get("attached_count", 0) or 0),
            host_pid=int(data.get("host_pid", 0) or 0),
            # 旧记录文件没有这个字段：按空值补齐（不炸）
            exit_reason=None if data.get("exit_reason") is None else str(data["exit_reason"]),
        )


class TerminalSessionTable:
    """终端会话表：每个会话一个 JSON 文件，原子替换写入。"""

    def __init__(self, config: PlatformConfig) -> None:
        self.config = config

    @property
    def directory(self) -> Path:
        """会话表目录。"""
        return sessions_dir(self.config)

    def path_for(self, session_id: str) -> Path:
        """单个会话的记录文件路径。"""
        if Path(session_id).name != session_id or session_id in ("", ".", ".."):
            raise ConfigError(f"会话标识非法：{session_id!r}")
        return self.directory / f"{session_id}.json"

    def save(self, record: TerminalSessionRecord) -> Path:
        """写入会话记录（原子替换）。"""
        directory = self.directory
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ConfigError(f"终端会话表目录不可写：{directory}（{exc}）") from exc
        target = self.path_for(record.session_id)
        payload = json.dumps(record.to_dict(), ensure_ascii=False, indent=2, sort_keys=True)
        handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - 临时文件需改权限后原子替换
            "w", encoding="utf-8", dir=directory, prefix=".session-", suffix=".tmp", delete=False
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

    def load(self, session_id: str) -> TerminalSessionRecord | None:
        """读取会话记录；不存在返回 ``None``。"""
        path = self.path_for(session_id)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.error("终端会话记录损坏，按不存在处理：%s", path)
            return None
        if not isinstance(data, dict):
            return None
        record = TerminalSessionRecord.from_dict(data)
        if not record.session_id:
            # 记录内容不完整：以文件名（会话标识）为准
            record.session_id = session_id
        return record

    def list_all(self) -> list[TerminalSessionRecord]:
        """列出全部会话记录，按会话标识排序。"""
        directory = self.directory
        if not directory.is_dir():
            return []
        result: list[TerminalSessionRecord] = []
        try:
            files = sorted(directory.glob("*.json"))
        except OSError as exc:
            raise ConfigError(f"终端会话表目录不可读：{directory}（{exc}）") from exc
        for path in files:
            record = self.load(path.stem)
            if record is not None:
                result.append(record)
        return result

    def delete(self, session_id: str) -> bool:
        """删除会话记录；返回是否确实删掉了东西。"""
        path = self.path_for(session_id)
        try:
            path.unlink()
        except FileNotFoundError:
            return False
        except OSError as exc:
            logger.error("删除终端会话记录失败：%s（%s）", path, exc)
            return False
        return True


def purge_leftover_sessions(
    config: PlatformConfig,
    *,
    container_killer: ContainerSessionKiller | None = None,
) -> list[str]:
    """清理上次遗留的终端会话记录，返回被清理的会话标识。

    服务重启后终端会话全部失效：全部记录标记为孤儿，按记录的宿主进程号终止
    遗留进程（仅当该进程命令行含本次会话标识时才终止，避免误杀复用的进程号），
    再按会话标识把容器内残留的 shell 收掉（杀宿主侧 exec 客户端收不掉容器内
    进程），随后删除记录文件。单个记录处理失败只记日志，不影响服务启动。

    记录属于**另一个还活着的服务实例**时跳过：那个实例正在用这些会话，
    误杀会打断别人的终端。容器已被删除时静默跳过。
    """
    table = TerminalSessionTable(config)
    directory = table.directory
    if not directory.is_dir():
        return []
    try:
        files = sorted(directory.glob("*.json"))
    except OSError as exc:
        raise ConfigError(f"终端会话表目录不可读：{directory}（{exc}）") from exc
    removed: list[str] = []
    for path in files:
        try:
            record = table.load(path.stem)
        except ConfigError as exc:
            logger.error("遗留终端会话记录不可读，直接删除：%s（%s）", path, exc)
            record = None
        if record is not None and _owned_by_other_instance(record):
            logger.info(
                "终端会话 %s 属于另一个仍在运行的服务实例（进程号 %s），跳过清理",
                record.session_id,
                record.host_pid,
            )
            continue
        if record is not None:
            record.state = SESSION_STATE_ORPHANED
            try:
                table.save(record)
            except ConfigError as exc:
                logger.error("标记孤儿终端会话失败：%s（%s）", record.session_id, exc)
            if record.pid:
                if terminate_pty_process(record.pid, record.session_id):
                    logger.info(
                        "已终止遗留终端进程：%s（会话 %s）", record.pid, record.session_id
                    )
            if container_killer is not None:
                _kill_container_session(container_killer, record)
        # 按文件路径删除：记录内容损坏时也要删得掉
        try:
            path.unlink()
        except OSError as exc:
            logger.error("删除遗留终端会话记录失败：%s（%s）", path, exc)
            continue
        removed.append(path.stem)
    return removed


def _owned_by_other_instance(record: TerminalSessionRecord) -> bool:
    """这条记录是不是另一个仍在运行的服务实例建的。

    判据：记录的 ``host_pid`` 不是本进程，且那个进程号还活着。
    """
    if not record.host_pid or record.host_pid == os.getpid():
        return False
    return pid_alive(record.host_pid)


def _kill_container_session(
    container_killer: ContainerSessionKiller, record: TerminalSessionRecord
) -> None:
    """按会话标识收掉容器内残留的进程（失败只记日志）。"""
    try:
        container_killer(
            record.sandbox_name, record.container_name, record.session_id
        )
    except Exception as exc:  # pragma: no cover - 清理失败不影响服务启动
        logger.warning(
            "清理容器 %s 内的遗留终端会话 %s 失败：%s",
            record.container_name,
            record.session_id,
            exc,
        )


def new_session_record(
    *,
    session_id: str,
    sandbox_name: str,
    container_name: str,
    system_user: str,
    pid: int,
    cols: int,
    rows: int,
    host_pid: int | None = None,
) -> TerminalSessionRecord:
    """新建一条会话记录（状态：运行中，尚未附着过）。"""
    now = utc_now()
    return TerminalSessionRecord(
        session_id=session_id,
        sandbox_name=sandbox_name,
        container_name=container_name,
        system_user=system_user,
        created_at=now,
        last_attached_at=now,
        state=SESSION_STATE_RUNNING,
        exit_code=None,
        pid=pid,
        cols=cols,
        rows=rows,
        attached_count=0,
        host_pid=os.getpid() if host_pid is None else host_pid,
        exit_reason=None,
    )
