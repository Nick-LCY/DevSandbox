#!/usr/bin/env python3
"""sandboxctl —— 沙箱平台命令行薄壳。

只做三件事：解析参数、调用 ``sandbox_platform`` 核心模块、打印结果。
所有生命周期逻辑都在 ``sandbox_platform`` 包内。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shlex
import sys
import unicodedata
from pathlib import Path

if __package__ in (None, ""):  # pragma: no cover - 直接以脚本方式运行时的兜底
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sandbox_platform import (
    RECLAIM_UNTOUCHED_NOTE,
    AlreadyExistsError,
    CreateRequest,
    NotFoundError,
    PlatformConfig,
    SandboxError,
    SandboxService,
    describe_mounts,
)


# ---------------------------------------------------------------- 输出辅助
def display_width(text: str) -> int:
    """按终端显示宽度计算字符串宽度（中文按两格计）。"""
    width = 0
    for char in text:
        width += 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
    return width


def pad(text: str, width: int) -> str:
    """按显示宽度右侧补空格。"""
    return text + " " * max(0, width - display_width(text))


def echo(message: str = "") -> None:
    """标准输出。"""
    sys.stdout.write(message + "\n")


def echo_error(message: str) -> None:
    """错误输出。"""
    sys.stderr.write(message + "\n")


# ---------------------------------------------------------------- 参数解析
def build_parser() -> argparse.ArgumentParser:
    """构造参数解析器。"""
    parser = argparse.ArgumentParser(
        prog="sandboxctl",
        description="沙箱平台命令行：创建 / 启动 / 关闭 / 删除 / 列表",
    )
    subparsers = parser.add_subparsers(dest="action", required=True)

    create = subparsers.add_parser("create", help="创建沙箱")
    create.add_argument("name", help="沙箱名（小写字母、数字、连字符、下划线）")
    create.add_argument(
        "--image",
        required=True,
        help="沙箱镜像（必填：默认镜像已退役，必须显式指定）",
    )
    create.add_argument(
        "--mount",
        action="append",
        default=[],
        metavar="宿主路径:容器路径[:ro]",
        help="用户声明挂载，可重复；平台不创建也不清理宿主目录",
    )
    create.add_argument("--command", help="容器启动命令（覆盖镜像默认入口，如 \"sleep infinity\"）")
    create.add_argument(
        "--env",
        action="append",
        default=[],
        metavar="键=值",
        help="容器环境变量，可重复；键名只允许字母、数字与下划线",
    )
    create.add_argument("--workdir", help="容器工作目录")
    create.add_argument(
        "--network",
        help="网桥网络名（默认 <沙箱名>-net）；用户指定的网络由用户自己创建与回收，平台只接入",
    )

    start = subparsers.add_parser("start", help="启动已存在的沙箱")
    start.add_argument("name", help="沙箱名")

    stop = subparsers.add_parser("stop", help="关闭沙箱")
    stop.add_argument("name", help="沙箱名")
    stop.add_argument(
        "--keep-dependencies",
        action="store_true",
        help="保留依赖容器运行（默认一并停止依赖容器）",
    )

    delete = subparsers.add_parser("delete", help="删除沙箱")
    delete.add_argument("name", help="沙箱名")
    delete.add_argument("--yes", action="store_true", help="跳过交互确认，直接执行")

    listing = subparsers.add_parser("list", help="列出全部沙箱")
    listing.add_argument("--json", action="store_true", help="以 JSON 输出")

    return parser


def parse_env_pairs(pairs: list[str]) -> dict[str, str]:
    """解析 ``键=值`` 形式的参数。"""
    env: dict[str, str] = {}
    for item in pairs:
        if "=" not in item:
            raise SystemExit(f"--env 取值非法（应为 键=值）：{item}")
        key, value = item.split("=", 1)
        env[key.strip()] = value
    return env


# ---------------------------------------------------------------- 子命令
def command_create(service: SandboxService, args: argparse.Namespace) -> int:
    """创建沙箱。"""
    command = shlex.split(args.command) if args.command else None
    request = CreateRequest(
        name=args.name,
        image=args.image,
        mount_declarations=tuple(args.mount),
        command=tuple(command) if command else None,
        env=parse_env_pairs(args.env),
        workdir=args.workdir,
        network_name=args.network,
    )
    result = service.create(request)

    echo(f"沙箱 {result.metadata.name} 创建完成")
    echo()
    echo("创建步骤：")
    for index, step in enumerate(result.steps, start=1):
        echo(f"  {index}. {step}")
    echo()
    echo(f"系统用户：{result.metadata.system_user}（uid={result.metadata.uid}）")
    echo(f"子 UID/GID 段：{result.metadata.subid_start}:{result.metadata.subid_length}")
    echo(f"沙箱容器：{result.metadata.container_name}（{result.metadata.container_id[:12]}）")
    echo(f"沙箱镜像：{result.metadata.image}")
    echo()
    echo("连接方式：")
    echo(f"  套接字：{result.connection.socket_path}")
    echo(f"  查看容器：{result.connection.docker_command}")
    echo(f"  进入沙箱：{result.connection.exec_command}")
    for note in result.connection.notes:
        echo(f"  提示：{note}")
    return 0


def command_start(service: SandboxService, args: argparse.Namespace) -> int:
    """启动沙箱。"""
    metadata = service.start(args.name)
    echo(f"沙箱 {metadata.name} 已启动")
    echo(f"  沙箱容器：{metadata.container_name}（{metadata.container_id[:12]}）")
    echo(f"  套接字：{metadata.socket_path}")
    echo(f"  挂载清单：{describe_mounts(metadata.mounts)}")
    return 0


def command_stop(service: SandboxService, args: argparse.Namespace) -> int:
    """关闭沙箱。"""
    metadata = service.stop(args.name, stop_dependencies=not args.keep_dependencies)
    echo(f"沙箱 {metadata.name} 已关闭")
    echo(f"  沙箱容器：{metadata.container_name}")
    if metadata.dependency_containers:
        action = "已一并停止" if not args.keep_dependencies else "保持运行"
        echo(f"  依赖容器：{', '.join(metadata.dependency_containers)}（{action}）")
    echo("  保留：系统用户、守护进程、家目录、子 UID/GID 段、用户声明挂载的宿主机目录")
    return 0


def command_delete(service: SandboxService, args: argparse.Namespace) -> int:
    """删除沙箱。"""
    plan = service.reclaim_plan(args.name)
    echo(f"即将删除沙箱 {args.name}")
    echo("平台将回收以下资源：")
    if plan.items:
        for item in plan.items:
            echo(f"  - {item}")
    else:
        echo("  - （沙箱不存在，没有可回收的资源）")
    echo()
    echo(f"注意：{RECLAIM_UNTOUCHED_NOTE}")
    if plan.user_mounts:
        echo("以下宿主目录由用户自行管理，平台不创建、不删除、不修改：")
        for path in plan.user_mounts:
            echo(f"  - {path}")
    echo()

    if not args.yes:
        if not sys.stdin.isatty():
            echo_error("非交互环境必须显式加 --yes 才会执行删除")
            return 2
        answer = input(f"确认删除沙箱 {args.name}？输入 yes 确认：").strip().lower()
        if answer != "yes":
            echo("已取消删除")
            return 0

    result = service.delete(args.name)
    if not result.existed:
        echo(f"沙箱 {result.name} 不存在，无需删除")
        return 0
    echo(f"沙箱 {result.name} 已删除，回收清单：")
    for item in result.removed:
        echo(f"  - {item}")
    if result.failed:
        echo("以下资源未能回收：")
        for item in result.failed:
            echo(f"  ! {item}")
    echo(f"注意：{RECLAIM_UNTOUCHED_NOTE}")
    return 1 if result.failed else 0


def command_list(service: SandboxService, args: argparse.Namespace) -> int:
    """列出全部沙箱。"""
    sandboxes = service.list()
    if args.json:
        echo(
            json.dumps(
                [metadata.to_dict() for metadata in sandboxes],
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    headers = ["沙箱名", "状态", "系统用户", "套接字路径", "挂载清单", "容器 ID"]
    rows = [
        [
            metadata.name,
            metadata.state_label,
            metadata.system_user,
            metadata.socket_path,
            metadata.mount_summary,
            metadata.container_id[:12] if metadata.container_id else "-",
        ]
        for metadata in sandboxes
    ]
    widths = [display_width(header) for header in headers]
    for row in rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], display_width(cell))

    echo("  ".join(pad(header, widths[index]) for index, header in enumerate(headers)).rstrip())
    echo("  ".join("-" * widths[index] for index in range(len(headers))))
    for row in rows:
        echo("  ".join(pad(cell, widths[index]) for index, cell in enumerate(row)).rstrip())
    if not rows:
        echo("（暂无沙箱）")
    return 0


# ---------------------------------------------------------------- 入口
def main(argv: list[str] | None = None) -> int:
    """命令行入口。"""
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s %(name)s：%(message)s",
    )
    parser = build_parser()
    args = parser.parse_args(argv)
    config = PlatformConfig.from_env(os.environ)
    service = SandboxService(config)
    handlers = {
        "create": command_create,
        "start": command_start,
        "stop": command_stop,
        "delete": command_delete,
        "list": command_list,
    }
    handler = handlers[args.action]
    try:
        return handler(service, args)
    except NotFoundError as exc:
        echo_error(f"错误：{exc}")
        return 1
    except AlreadyExistsError as exc:
        echo_error(f"错误：{exc}")
        return 1
    except SandboxError as exc:
        echo_error(f"错误：{exc}")
        return 1
    except KeyboardInterrupt:  # pragma: no cover
        echo_error("已中断")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
