"""代码分层契约测试：核心模块不得含命令行解析与直接输出。

三个方向的约束：

- 核心包（``apps/core/src/sandbox_platform/``）：不含 argparse 与 print。
- 服务端包（``apps/web/backend/src/sandbox_console/``）：不含 argparse、print，
  也不直接拼宿主命令——宿主交互一律经核心包。
- 命令行（``apps/cli/``）：薄壳，只做参数解析、调用核心与输出。

依赖方向单向：核心包不得引用服务端包（核心不认识界面与服务）。
"""

from __future__ import annotations

import importlib
import re
import sys
from pathlib import Path

import pytest

import sandbox_platform

# 本文件在 apps/core/tests/ 下：
#   parents[0] = tests
#   parents[1] = core（核心包根）
#   parents[2] = apps（工作区根）
APPS_DIR = Path(__file__).resolve().parents[2]

CORE_DIR = APPS_DIR / "core" / "src" / "sandbox_platform"
CLI_DIR = APPS_DIR / "cli"
BACKEND_DIR = APPS_DIR / "web" / "backend" / "src" / "sandbox_console"

# 服务端不得出现的写法：服务端只做编排与转译，宿主交互一律经核心包
FORBIDDEN_SERVER_PATTERNS = (
    r"\bcommand\.run\b",
    r"\bsandbox_platform\.command\b",
    r"\bfrom\s+\.{1,2}command\b",
    r"\bsubprocess\b",
    r"\bos\.system\b",
    r"\bos\.popen\b",
    r"\bshell\s*=\s*True\b",
    r"\bsudo\b",
    r"\bdocker\b",
)


def _core_sources() -> list[Path]:
    return sorted(CORE_DIR.rglob("*.py"))


def _cli_sources() -> list[Path]:
    return sorted(CLI_DIR.rglob("*.py"))


def _server_sources() -> list[Path]:
    """服务端源码清单。

    服务端源码目录不存在时**跳过**（核心包独立检出的场景：仓库里只有
    ``apps/core``，没有服务端包，服务端分层约束无从谈起，不该误红）。
    目录存在但为空仍按原样断言失败。
    """
    if not BACKEND_DIR.is_dir():
        pytest.skip("服务端源码目录不存在（核心包独立检出场景），跳过服务端分层约束")
    return sorted(BACKEND_DIR.rglob("*.py"))


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
    """服务端源码内不出现 argparse（服务端不做命令行参数解析）。"""
    sources = _server_sources()
    assert sources, "服务端目录为空"
    offenders = [str(path) for path in sources if "argparse" in path.read_text(encoding="utf-8")]
    assert offenders == []


def test_server_layer_has_no_print_call() -> None:
    """服务端源码内不出现 print( 调用（输出一律走日志）。"""
    sources = _server_sources()
    assert sources, "服务端目录为空"
    offenders = [str(path) for path in sources if "print(" in path.read_text(encoding="utf-8")]
    assert offenders == []


def test_server_layer_does_not_call_host_commands() -> None:
    """服务端不直接拼宿主命令：宿主交互一律经核心包。

    禁令覆盖：核心命令封装（``command.run``）、进程与 shell 逃逸
    （``subprocess`` / ``os.system`` / ``os.popen`` / ``shell=True``）、
    以及特权命令与容器客户端（``sudo`` / ``docker``）。
    """
    sources = _server_sources()
    assert sources, "服务端目录为空"
    offenders: list[str] = []
    for path in sources:
        text = path.read_text(encoding="utf-8")
        for pattern in FORBIDDEN_SERVER_PATTERNS:
            if re.search(pattern, text):
                offenders.append(f"{path.name}: {pattern}")
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
    """导入核心包不会连带导入命令行模块。

    依赖方向单向：核心包不认识命令行薄壳
    （命令行调用核心包，反向引用会把核心包拖到界面层上）。
    """
    importlib.reload(sandbox_platform)
    assert _loaded_cli_modules() == []


def test_core_does_not_reference_server_package() -> None:
    """核心包源码不引用服务端包。

    依赖方向单向：服务端包 ``sandbox_console`` 依赖核心包 ``sandbox_platform``，
    反向引用会把核心包拖到界面层上。
    """
    offenders = [
        str(path)
        for path in _core_sources()
        if "sandbox_console" in path.read_text(encoding="utf-8")
    ]
    assert offenders == []


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
