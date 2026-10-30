"""代码分层契约测试：核心模块不得含命令行解析与直接输出。"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import sandbox_platform

CORE_DIR = Path(sandbox_platform.__file__).resolve().parent
PROJECT_DIR = CORE_DIR.parents[1]
CLI_DIR = PROJECT_DIR / "cli"
SERVER_DIR = CORE_DIR / "server"


def _core_sources() -> list[Path]:
    return sorted(CORE_DIR.rglob("*.py"))


def _cli_sources() -> list[Path]:
    return sorted(CLI_DIR.rglob("*.py"))


def _server_sources() -> list[Path]:
    return sorted(SERVER_DIR.rglob("*.py"))


def test_core_has_no_argparse() -> None:
    """核心模块源码内不出现 argparse。"""
    offenders = [
        str(path) for path in _core_sources() if "argparse" in path.read_text(encoding="utf-8")
    ]
    assert offenders == []


def test_core_has_no_print_call() -> None:
    """核心模块源码内不出现 print( 调用。"""
    offenders = [
        str(path) for path in _core_sources() if "print(" in path.read_text(encoding="utf-8")
    ]
    assert offenders == []


def test_server_layer_has_no_argparse() -> None:
    """服务层源码内不出现 argparse（服务层不做命令行参数解析）。"""
    sources = _server_sources()
    assert sources, "服务层目录为空"
    offenders = [str(path) for path in sources if "argparse" in path.read_text(encoding="utf-8")]
    assert offenders == []


def test_server_layer_has_no_print_call() -> None:
    """服务层源码内不出现 print( 调用（输出一律走日志）。"""
    sources = _server_sources()
    assert sources, "服务层目录为空"
    offenders = [str(path) for path in sources if "print(" in path.read_text(encoding="utf-8")]
    assert offenders == []


def test_server_layer_does_not_call_host_commands() -> None:
    """服务层不直接拼宿主命令：宿主交互一律经核心包。"""
    offenders = []
    for path in _server_sources():
        text = path.read_text(encoding="utf-8")
        if "command.run" in text or "sandbox_platform.command" in text:
            offenders.append(str(path))
    assert offenders == []


def test_control_plane_has_no_version_control_command() -> None:
    """控制面不做任何版本控制操作。"""
    targets = [*_core_sources(), *sorted(CORE_DIR.rglob("*.md")), *_cli_sources()]
    offenders = [str(path) for path in targets if "git " in path.read_text(encoding="utf-8")]
    assert offenders == []


def _loaded_cli_modules() -> list[str]:
    """已导入的、来自命令行目录的模块。"""
    loaded: list[str] = []
    for name, module in list(sys.modules.items()):
        origin = getattr(module, "__file__", None)
        if not origin:
            continue
        try:
            resolved = Path(origin).resolve()
        except OSError:
            continue
        if resolved.parent == CLI_DIR.resolve():
            loaded.append(name)
    return loaded


def test_core_import_does_not_pull_in_cli() -> None:
    """导入核心包不会连带导入命令行模块。"""
    importlib.reload(sandbox_platform)
    assert _loaded_cli_modules() == []


def test_unit_tests_do_not_import_cli() -> None:
    """测试代码不导入命令行模块。"""
    test_dir = Path(__file__).resolve().parent
    offenders = []
    for path in sorted(test_dir.glob("*.py")):
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith(("import ", "from ")) and "sandboxctl" in stripped:
                offenders.append(f"{path.name}: {stripped}")
    assert offenders == []


def test_cli_is_thin_shell() -> None:
    """命令行薄壳只做参数解析、调用核心与输出。"""
    sources = _cli_sources()
    assert sources, "命令行目录为空"
    text = "\n".join(path.read_text(encoding="utf-8") for path in sources)
    assert "argparse" in text
    assert "sandbox_platform" in text
    assert "SandboxService" in text
