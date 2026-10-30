"""终端会话表的最小实现：只做目录准备与遗留记录清理。

与二期任务 03（网页终端）的衔接点：这里只提供「服务启动时作废上次遗留的
终端会话记录」这一钩子位；会话的登记、更新、查询，以及按记录里的宿主进程号
终止遗留 exec 进程（仅当该进程命令行含本次会话标记时才终止，避免误杀复用的
进程号），由任务 03 在本文件扩展。
"""

from __future__ import annotations

import logging
from pathlib import Path

from sandbox_platform import PlatformConfig

logger = logging.getLogger(__name__)

TERMINAL_SESSIONS_DIRNAME = "terminal-sessions"


def sessions_dir(config: PlatformConfig) -> Path:
    """终端会话表目录：``<平台数据根>/terminal-sessions``。"""
    return config.home / TERMINAL_SESSIONS_DIRNAME


def prepare_sessions_dir(config: PlatformConfig) -> Path:
    """准备终端会话表目录（幂等）。"""
    path = sessions_dir(config)
    path.mkdir(parents=True, exist_ok=True)
    return path


def purge_leftover_sessions(config: PlatformConfig) -> list[str]:
    """清理上次遗留的终端会话记录，返回被清理的会话标识。

    服务重启后终端会话全部失效：遗留记录一律作废并删除。删除失败只记日志，
    不影响服务启动。
    """
    path = sessions_dir(config)
    if not path.is_dir():
        return []
    removed: list[str] = []
    for record in sorted(path.glob("*.json")):
        try:
            record.unlink()
        except OSError as exc:
            logger.error("删除遗留终端会话记录失败：%s（%s）", record, exc)
            continue
        removed.append(record.stem)
    return removed
