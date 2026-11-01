"""命令行的回归测试（实跑命令行薄壳，不导入命令行模块）。

命令行薄壳的契约：缺必填参数时给中文提示并以退出码 2 退出；``--help`` 正常退出。
这两条用 ``subprocess`` 实跑命令行验证——命令行只做参数解析与输出，
不碰宿主资源，跑起来不需要任何特权。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

CLI_PATH = Path(__file__).resolve().parents[1] / "cli" / "sandboxctl.py"


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    """实跑命令行，返回进程结果。"""
    return subprocess.run(
        [sys.executable, str(CLI_PATH), *args],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def test_missing_image_fails_with_chinese_message() -> None:
    """缺 --image：中文提示 + 退出码 2（默认镜像已退役，没有兜底镜像）。"""
    result = run_cli("create", "demo")
    assert result.returncode == 2
    assert "必须显式指定沙箱镜像" in result.stderr
    assert "默认镜像已退役" in result.stderr


def test_blank_image_fails_with_chinese_message() -> None:
    """--image 传空串：与缺失同义，同样是中文提示 + 退出码 2。"""
    result = run_cli("create", "demo", "--image", "")
    assert result.returncode == 2
    assert "必须显式指定沙箱镜像" in result.stderr


def test_help_exits_successfully() -> None:
    """--help 正常退出（退出码 0），不受缺镜像拦截影响。"""
    result = run_cli("--help")
    assert result.returncode == 0
    assert "sandboxctl" in result.stdout
