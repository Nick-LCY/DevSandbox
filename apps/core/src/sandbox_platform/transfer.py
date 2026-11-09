"""运行期文件传输（上传 / 下载 / 探测 / 目录列表）。

机制依据：ADR 0018（运行期文件传输机制选型）——主通道是沙箱免 root 守护进程下的
``docker exec -i`` + 容器内 ``sh`` / ``cat``，**复用端口转发轮已生产验证的字节泵资产**
（``daemon.spawn_stream`` + ``forwarding.BytePump``：stderr 排空、短写循环、
进程组回收三个坑照抄，不重踩）。**零新增第三方依赖、零新增进程模型。**

本模块是**能力本体**，与 ``forwarding.py`` 平级：路径校验、上传、探测、下载字节泵、
目录列表都在这里；服务端（03 轮）只做编排与转译，命令行与创建时注入通道零改动。

**五条硬口径（ADR 0018 第 7 节，逐条对应本模块实现）**：

1. **路径一律 argv 直传**：``docker exec … cat -- <path>``、``rm -f -- <临时名>``，
   路径**绝不**拼进 ``sh -c`` 的脚本文本。``sh -c`` 只用于**固定脚本**，路径经
   ``"$1"`` 位置参数传入（实测：含换行的路径拼进脚本文本会被拆碎，argv 直传正常）。
2. **错误分类只按 stderr 关键词子串**：dash 与 busybox ash 的措辞与退出码都不同
   （父目录缺失：dash ``Directory nonexistent`` rc=2 / busybox ``nonexistent
   directory`` rc=1），**不按整句、不按退出码**。stderr 原文**只进日志**，
   不进错误文案；报错文本里的临时名一律换成**用户的目标路径**。
3. **上传是「同目录临时名 → mv 原子替换」**：临时名必须与目标同目录（跨设备 ``mv``
   走 copy + unlink，非原子、中途失败留半截文件）；**目标为已存在目录必须前置拒绝**
   （实测 ``mv 临时名 目录`` rc=0 假成功，文件被搬进目录里）；失败路径由**平台侧**
   显式清理临时文件（``cat`` 不会自清理）。
4. **探测必须分层**：目录 / 普通文件 / FIFO·设备·套接字·其他特殊文件可区分，
   **特殊文件一律拒**（FIFO 会挂死 ``cat``，``/dev/null`` 会静默返回 0 字节空下载）。
   字节数取 ``stat -L -c %s``（O(1)），``wc -c < file`` 为兜底。
5. **「cat 收到干净 EOF」≠「数据完整」**：宿主侧一旦关掉 exec 的 stdin（客户端
   中断 / 管道断了），容器内的 ``cat`` 收到的是**干净 EOF**、退出码 0——此时若
   无条件 ``mv``，**半截文件就落在目标路径上**（03 轮真机实测：250 MiB 上传
   60 s 掐断后目标留下 189,726,720 字节）。因此上传脚本在 ``mv`` **之前**核对
   临时文件的**实际字节数**与**期望字节数**（期望值经 argv 直传）：不符就删掉
   临时名、打标记、**非零退出**，**目标路径原样不动**（保住「原子替换」承诺）。
   **没有期望值**（调用方给不出长度）时**跳过校验**——此时仍有残余风险，见
   :meth:`FileTransferManager.upload` 的说明。

**符号链接语义（ADR 0018 第 7 节第 9 条，两处口径刻意不同，不得「顺手统一」）**：

- **类型探测跟随符号链接**：``test -d`` / ``test -f`` / ``test -p`` 等**都跟随**，
  链接按它指向的目标判类型；字节数与 mtime 也取**目标**的值（``stat -L``）。
  本模块的探测脚本里 ``stat`` **一律带 ``-L``**，正是为了与 ``test`` 的跟随口径
  对齐——不带 ``-L`` 时 ``stat`` 取到的是**链接自身**的大小与时间戳。
- **上传的 rename 不跟随末端符号链接**：``mv`` 替换的是**链接本身**，链接指向的
  文件不受影响（这是「临时名 + mv」模式的**防写穿**关键，不可省）。

另有一条**有意为之**的取舍：``stat -L -c %s``（跟随）而非 ``stat -c %s``（不跟随）。
ADR 第 3 节把 ``stat -c %s`` 列为取大小的首选，指的是「O(1) 的 stat 而不是
``wc -c < file`` 的全量读」；本模块在保留 O(1) 属性的前提下统一到**跟随**口径，
与同一段脚本里的类型判定保持一致（否则符号链接会拿到「链接路径字符串的长度」）。
"""

from __future__ import annotations

import logging
import operator
import os
import posixpath
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Iterable, Protocol

from .daemon import UserDaemon
from .errors import TransferError
from .forwarding import BytePump
from .metadata import SandboxMetadata

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- 探测类型
# 探测脚本输出的类型标记 → 平台侧的类型常量。分层判定（ADR 0018 第 3 节）：
# 「不存在 / 目录 / 普通文件 / 特殊文件（FIFO·设备·套接字）」必须可区分——
# PRD 草案的「-d / -f / else missing」把 FIFO 与「不存在」混在一起，达不到目的。
KIND_FILE = "file"
KIND_DIR = "dir"
KIND_FIFO = "fifo"
KIND_CHARDEV = "chardev"
KIND_BLOCKDEV = "blockdev"
KIND_SOCKET = "socket"
KIND_SYMLINK = "symlink"
KIND_SPECIAL = "special"
KIND_MISSING = "missing"

#: 探测脚本的类型标记 → 类型常量
_PROBE_KINDS: dict[str, str] = {
    "file": KIND_FILE,
    "dir": KIND_DIR,
    "fifo": KIND_FIFO,
    "chardev": KIND_CHARDEV,
    "blockdev": KIND_BLOCKDEV,
    "socket": KIND_SOCKET,
    "symlink": KIND_SYMLINK,
    "special": KIND_SPECIAL,
    "missing": KIND_MISSING,
}

#: 列表记录的类型标记（容器内 find 脚本产出）→ 类型常量
_LIST_KINDS: dict[str, str] = {
    "f": KIND_FILE,
    "d": KIND_DIR,
    "x": KIND_SPECIAL,
}

#: **只允许下载的类型**：普通文件。目录 / 特殊文件 / 不存在一律拒
#: （这是**类型检查**，不是路径限制）。
DOWNLOADABLE_KINDS = (KIND_FILE,)

# ---------------------------------------------------------------- 失败分类
# 失败分类码（``TransferError.reason``）：服务端按它映射 HTTP 状态码，
# 不必去解析异常文案。
REASON_INVALID_PATH = "invalid_path"
REASON_PARENT_MISSING = "parent_missing"
REASON_PARENT_NOT_DIRECTORY = "parent_not_directory"
REASON_PARENT_NOT_WRITABLE = "parent_not_writable"
REASON_READONLY = "readonly"
REASON_TARGET_IS_DIR = "target_is_dir"
REASON_NOT_FOUND = "not_found"
REASON_NOT_REGULAR = "not_regular"
REASON_SANDBOX_STOPPED = "sandbox_stopped"
REASON_EXEC_FAILED = "exec_failed"
REASON_WRITE_FAILED = "write_failed"
REASON_NO_RUNTIME = "no_runtime"
#: 守护进程/宿主侧失败（docker 客户端连不上守护进程）——**不是**容器内的失败
REASON_DAEMON_UNREACHABLE = "daemon_unreachable"
#: 上传临时名已被占用（noclobber 撞名）：临时名不是我们建的
REASON_TEMP_NAME_EXISTS = "temp_name_exists"
#: **上传的字节数与期望值不符**：临时文件量到的字节数 ≠ 期望字节数
#: （典型成因：客户端中断上传 / 请求体被截断）。临时名已删、**目标未被替换**
REASON_SIZE_MISMATCH = "size_mismatch"
#: 期望字节数本身非法（负数 / 不是整数）：调用方的参数错误
REASON_INVALID_SIZE = "invalid_size"

# ---------------------------------------------------------------- 固定中文文案
# 错误文案**固定**：容器内的 stderr 原文只进日志，不回显调用方。
# 措辞与既有转发错误常量同一风格（「问题：细节」）。
MSG_PATH_EMPTY = "容器内路径不能为空"
MSG_PATH_NOT_ABSOLUTE = "容器内路径必须是绝对路径"
MSG_PATH_HAS_NUL = "容器内路径不能包含空字节"
MSG_PARENT_MISSING = "目标父目录不存在，请先创建"
MSG_PARENT_NOT_DIRECTORY = "目标父目录不是目录"
MSG_PARENT_NOT_WRITABLE = "目标目录不可写"
MSG_READONLY_FS = "路径所在挂载为只读"
MSG_TARGET_IS_DIR = "目标是一个目录，不能作为上传目标"
MSG_IS_DIRECTORY = "目标是目录"
MSG_NOT_A_DIRECTORY = "目标不是目录，不能列目录"
MSG_NOT_REGULAR = "目标不是普通文件，不能下载"
MSG_NOT_FOUND = "文件不存在"
MSG_EXEC_FAILED = "容器内命令执行失败"
MSG_EXEC_TIMEOUT = "容器内命令执行超时"
MSG_WRITE_FAILED = "文件写入中断"
MSG_SANDBOX_STOPPED = "沙箱已停止，无法传输文件"
MSG_NO_RUNTIME = "传输编排未装配沙箱侧能力，无法访问沙箱"
MSG_DAEMON_UNREACHABLE = "守护进程无法连接 Docker，容器内命令未执行"
MSG_TEMP_NAME_EXISTS = "目标目录里的临时文件名已被占用，请重试"
#: 字节数不符的固定文案（**不透露容器内的 stderr 原文**，只说结果）
MSG_SIZE_MISMATCH = "上传中断，目标文件未完整写入"
#: 期望字节数非法的固定文案
MSG_INVALID_SIZE = "期望字节数非法"

#: stderr 关键词子串 → （失败分类码, 固定中文文案）。
#:
#: **只按关键词子串分类，不按整句、不按退出码**：同一类错误在 dash 与 busybox ash
#: 下的措辞与退出码都不同（ADR 0018 第 7 节第 6 条 / 实测 D-15）。措辞样本来自
#: 01 轮真机实测：父目录缺失 ``Directory nonexistent``（dash）/ ``nonexistent
#: directory``（busybox）；权限不足 ``Permission denied``；只读挂载 ``Read-only file
#: system``；目录 ``Is a directory``（GNU）/ ``read error: Is a directory``（busybox）；
#: 不存在 ``No such file or directory``（GNU）/ ``can't open '…': No such file or
#: directory``（busybox）。
#:
#: 顺序即优先级：**守护进程/宿主侧失败排在最前**，再判只读挂载与权限不足，
#: 再判父目录缺失，最后才是「不存在」。
#:
#: **为什么守护进程侧要排在最前**：docker 客户端连不上守护进程时报的
#: ``permission denied while trying to connect to the Docker daemon socket`` 里
#: **也带 permission denied**——若按容器内的关键词归类，会把宿主侧故障误报成
#: 「目标目录不可写」（分类码与文案全错，而且会把用户的排查方向带偏）。
_ERROR_KEYWORDS: tuple[tuple[str, str, str], ...] = (
    # 守护进程 / 宿主侧失败（**必须排在容器内关键词之前**）
    (
        "cannot connect to the docker daemon",
        REASON_DAEMON_UNREACHABLE,
        MSG_DAEMON_UNREACHABLE,
    ),
    (
        "docker daemon socket",
        REASON_DAEMON_UNREACHABLE,
        MSG_DAEMON_UNREACHABLE,
    ),
    (
        "is the docker daemon running",
        REASON_DAEMON_UNREACHABLE,
        MSG_DAEMON_UNREACHABLE,
    ),
    (
        "error during connect",
        REASON_DAEMON_UNREACHABLE,
        MSG_DAEMON_UNREACHABLE,
    ),
    # 容器内
    #
    # **字节数不符**：这条标记是**平台自己打的**（上传脚本里的 ``printf``），
    # 不是容器内 shell 的措辞——所以它与其它关键词不一样，**任何镜像上都一样**。
    # 排在容器内关键词的最前面：它是「上传被截断」的**确定性证据**，
    # 不该被别的措辞盖掉。
    ("size mismatch", REASON_SIZE_MISMATCH, MSG_SIZE_MISMATCH),
    ("read-only file system", REASON_READONLY, MSG_READONLY_FS),
    ("permission denied", REASON_PARENT_NOT_WRITABLE, MSG_PARENT_NOT_WRITABLE),
    # noclobber 撞名：临时名已存在（dash ``cannot create …: File exists`` /
    # busybox ``can't create '…': File exists``）
    ("file exists", REASON_TEMP_NAME_EXISTS, MSG_TEMP_NAME_EXISTS),
    (
        "cannot overwrite existing file",
        REASON_TEMP_NAME_EXISTS,
        MSG_TEMP_NAME_EXISTS,
    ),
    ("nonexistent", REASON_PARENT_MISSING, MSG_PARENT_MISSING),
    ("directory nonexistent", REASON_PARENT_MISSING, MSG_PARENT_MISSING),
    ("is a directory", REASON_TARGET_IS_DIR, MSG_IS_DIRECTORY),
    ("not a directory", REASON_PARENT_NOT_DIRECTORY, MSG_PARENT_NOT_DIRECTORY),
    ("no such file or directory", REASON_NOT_FOUND, MSG_NOT_FOUND),
    ("is not running", REASON_SANDBOX_STOPPED, MSG_SANDBOX_STOPPED),
)

# ---------------------------------------------------------------- 容器内脚本
# **固定脚本**：路径一律经 ``"$1"``（必要时 ``"$2"``）位置参数传入，
# **绝不**把路径拼进脚本文本（实测：含换行 / 引号的路径拼进去会被 shell 拆碎）。
#
# 探测脚本（分层判定，单次 exec）：
#   -d 目录 → -f 普通文件（取 ``stat -L -c %s`` 大小、``-c %Y`` mtime）→
#   -p FIFO → -c 字符设备 → -b 块设备 → -S 套接字 → -L 符号链接（悬空链接）→
#   -e 其余特殊文件 → 兜底「不存在」。
#
# ``stat`` 一律带 ``-L``（跟随符号链接）：与 ``test`` 系列的跟随口径保持一致，
# 否则符号链接会拿到**链接自身**的大小与时间戳（ADR 0018 第 7 节第 9 条）。
# ``wc -c < "$1"`` 只在 ``stat`` 不可用时兜底（要读完整个文件，O(1) 的 stat 优先）。
PROBE_SCRIPT = """
if [ -d "$1" ]; then
  printf 'dir\\n'
elif [ -f "$1" ]; then
  size=0
  mtime=0
  info=$(stat -L -c '%s %Y' "$1" 2>/dev/null) || info=''
  if [ -n "$info" ]; then
    size=${info%% *}
    mtime=${info##* }
  else
    size=$(wc -c < "$1" 2>/dev/null) || size=0
  fi
  printf 'file\\t%s\\t%s\\n' "$size" "$mtime"
elif [ -p "$1" ]; then
  printf 'fifo\\n'
elif [ -c "$1" ]; then
  printf 'chardev\\n'
elif [ -b "$1" ]; then
  printf 'blockdev\\n'
elif [ -S "$1" ]; then
  printf 'socket\\n'
elif [ -L "$1" ]; then
  printf 'symlink\\n'
elif [ -e "$1" ]; then
  printf 'special\\n'
else
  printf 'missing\\n'
fi
"""

# 上传脚本（固定）：``set -C`` + ``cat > "$1"`` + **字节数核对** + ``mv "$1" "$2"``。
#   - ``$1`` = **与目标同目录**的临时名，``$2`` = 用户的目标路径，
#     ``$3`` = **期望字节数**（**可选**：不给 / 给空串就**跳过核对**）；
#   - ``set -C``（noclobber）：重定向走 **O_EXCL**，**临时名已存在就不写**——
#     实测 dash 与 busybox ash 都生效（``cannot create …: File exists`` /
#     ``can't create '…': File exists``）。不加它时，若临时名被**预先放了个
#     符号链接**（指向别处），``cat > "$1"`` 会**顺着链接写穿**到链接目标
#     （实测：链接指向的文件被写脏）；
#   - ``|| exit $?``：写入失败就不执行 ``mv``（不拿半截文件去覆盖目标），
#     并**保留 cat 的退出码**（实测：dash 的重定向失败 rc=2 / busybox rc=1，
#     与修复前一致）；
#   - ``cat`` 从 exec 的 stdin 收字节（``docker exec -i``）；
#   - **字节数核对（``$3`` 给了才做）**：``cat`` 写完后量临时文件的实际字节数
#     （``wc -c < "$1"``），与期望值不等就 ``rm -f -- "$1"`` + 打标记
#     （``size mismatch``）+ **非零退出**，**不执行 ``mv``**；
#   - 临时名与目标同目录 ⇒ ``mv`` 是同设备 rename，**原子替换**；
#   - rename **不跟随**末端符号链接 ⇒ 替换的是链接本身（防写穿）。
#
# **为什么必须有字节数核对**（03 轮真机实测暴露的缺陷）：宿主侧一旦关掉 exec 的
# stdin（客户端中断上传 / 管道断了），容器内的 ``cat`` 收到的是**干净 EOF**、
# **rc=0**——此时若无条件 ``mv``，**半截文件就落在目标路径上**（实测：250 MiB
# 上传 60 s 掐断后目标留下 189,726,720 字节、临时名已清、无 exec 残留）。
# 期望字节数由**调用方**（服务端从请求头 ``Content-Length`` 取）经 **argv 直传**
# 进来，脚本是**固定文本**、**不拼接路径也不拼接数值**。
#
# **为什么用 ``wc -c < "$1"``**（而不是 ``stat -c %s``）：01 轮打样实测**四个镜像
# 都有 ``wc``**（``sandbox-platform/base:0.3.0`` / ``debian:bookworm-slim`` /
# ``alpine:latest`` / ``alpine/socat:1.8.1.3``），而 ``wc -c < file`` 是 **POSIX
# 写法**、dash 与 busybox ash 行为一致。代价是**要读完整个文件**（O(n)，与探测
# 脚本里 ``stat`` 的 O(1) 不同）——上传场景下文件刚写完、页缓存里，代价可接受。
# ``wc`` 缺失 / 量不出来时 ``actual`` 为空 ⇒ **按不符处理**（fail-closed：
# 宁可报错，也不把没核对过的文件 ``mv`` 到目标上）。
#
# **noclobber 撞名的处置**（临时名已存在）：走**既有错误路径**——按 stderr
# 关键词归类成 :data:`REASON_TEMP_NAME_EXISTS`，不重试。**不重试**的理由：字节流
# 是**流式**的（内存有界，不整文件进内存），已写出去的字节无法重放，重试就得
# 整份缓冲——与「大文件不占内存」的硬前提冲突。**也不删那个路径**：它不是我们
# 建的（可能是别人放的符号链接或文件），平台没有资格替用户删。
UPLOAD_SCRIPT = """
set -C
cat > "$1" || exit $?
if [ -n "$3" ]; then
  actual=$(wc -c < "$1" 2>/dev/null) || actual=""
  actual=${actual##* }
  if [ -z "$actual" ] || [ "$actual" != "$3" ]; then
    rm -f -- "$1"
    printf 'rtf upload: size mismatch (expected %s, actual %s)\\n' "$3" "${actual:-unknown}" >&2
    exit 1
  fi
fi
mv "$1" "$2"
"""

# 目录列表脚本（固定）：``find … -exec sh -c '…' sh {} +`` **单次 exec** 产出
# **NUL 结尾**的记录（类型 / 大小 / mtime / 名称，字段 TAB 分隔）。
#
# 为什么这么写（01 轮实测结论）：
#   - 记录以 NUL 结尾：NUL 是文件名里唯一不可能出现的字节 ⇒ **换行名、空格名、
#     中文名、引号、反斜杠、制表符全部保真**（行分隔的写法会被换行名劈成两条）；
#   - 解析只按**前 3 个 TAB** 切，后面的全归文件名（名字里可能有 TAB）；
#   - **禁用** ``find -printf``（busybox 不支持）、``find -print0`` + ``read -d``
#     循环（dash 与 busybox ash 都没有 ``read -d``）、``ls -l`` / ``ls -A`` 列解析
#     （换行名被劈开、GNU 与 busybox 列宽不同）；
#   - GNU 与 busybox 的输出格式**完全一致**，解析侧只需一套代码。
#
# 大小取 ``stat -L -c %s``（O(1)）而不是 ``wc -c < "$p"``（要读完整个文件）：
# 列一次目录不该把目录里每个文件都读一遍（ADR 0018 第 3 节）。
LIST_SCRIPT = """
find "$1" -maxdepth 1 -mindepth 1 -exec sh -c 'for p do
  n=${p##*/}
  if [ -d "$p" ]; then
    m=$(stat -L -c %Y "$p" 2>/dev/null) || m=0
    printf "d\\t0\\t%s\\t%s\\0" "$m" "$n"
  elif [ -f "$p" ]; then
    info=$(stat -L -c "%s %Y" "$p" 2>/dev/null) || info=""
    if [ -n "$info" ]; then
      s=${info%% *}
      m=${info##* }
    else
      s=$(wc -c < "$p" 2>/dev/null) || s=0
      m=0
    fi
    printf "f\\t%s\\t%s\\t%s\\0" "$s" "$m" "$n"
  else
    m=$(stat -L -c %Y "$p" 2>/dev/null) || m=0
    printf "x\\t0\\t%s\\t%s\\0" "$m" "$n"
  fi
done' sh {} +
"""

# ---------------------------------------------------------------- 运行参数
#: 容器内非交互命令（探测 / 列表）的等待上限（秒）
EXEC_TIMEOUT = 120
#: 上传收尾（stdin 关掉后等 ``cat`` + ``mv`` 走完）的等待上限（秒）
UPLOAD_FINISH_TIMEOUT = 300
#: 容器内命令输出的读取块大小
EXEC_CHUNK = 65536
#: 下载字节流的默认读取块大小
DOWNLOAD_CHUNK = 65536
#: 下载流读完之后等 exec 退出码的等待上限（秒）
DOWNLOAD_STATUS_TIMEOUT = 5
#: 取 stderr 尾部前的**短等**上限（秒）：排空线程还没跑完就等一下
#: （见 :func:`_stderr_tail_with_drain`）
STDERR_DRAIN_WAIT = 0.5
#: 短等的轮询间隔（秒）
STDERR_DRAIN_POLL = 0.01
#: 临时文件名前缀（容器内可见，便于兜底扫描与人工排查）
TEMP_PREFIX = ".rtf-tmp-"


# ---------------------------------------------------------------- 依赖协议
class TransferRuntime(Protocol):
    """传输编排依赖的沙箱侧能力（由生命周期服务实现）。

    与 ``forwarding.SandboxRuntime`` 同款：核心包用协议描述依赖方向，传输编排
    不认识界面层，也不直接碰宿主命令，只经沙箱的免 root 守护进程操作容器。
    """

    def get(self, name: str) -> SandboxMetadata:
        """取沙箱元数据（不存在抛 ``NotFoundError``）。"""
        ...

    def daemon_for(self, name: str) -> UserDaemon:
        """取沙箱对应的守护进程操作入口。"""
        ...


# ---------------------------------------------------------------- 数据类
@dataclass(frozen=True)
class ProbeResult:
    """路径探测结果。

    ``kind`` 是分层判定的结果（见 ``KIND_*``）：目录 / 普通文件 / FIFO·设备·
    套接字·其他特殊文件 / 符号链接 / 不存在。**特殊文件一律不放行**（FIFO 会挂死
    ``cat``，``/dev/null`` 会静默返回 0 字节空下载）。

    ``size`` / ``mtime`` 只有普通文件才有值（跟随符号链接取**目标**的值）。
    """

    path: str
    kind: str
    size: int | None = None
    mtime: int | None = None

    @property
    def is_regular_file(self) -> bool:
        """是不是普通文件（唯一允许下载的类型）。"""
        return self.kind in DOWNLOADABLE_KINDS


@dataclass(frozen=True)
class ListEntry:
    """目录列表条目。

    字段：**名称 / 类型 / 字节数 / 修改时间**。``kind`` 取 ``KIND_*``：
    ``file`` / ``dir`` / ``special``（容器内 find 脚本产出的 ``f`` / ``d`` / ``x``）。
    """

    name: str
    kind: str
    size: int = 0
    mtime: int = 0


@dataclass
class DownloadStream:
    """下载字节流（调用方流式读）。

    **内存有界**：容器内的字节经字节泵**逐块**流出，调用方读多少取多少，
    整文件不进内存（200 MiB 与 1 GiB 的宿主峰值 RSS 相同，实测见 01 轮留档）。

    **使用前必须调 :meth:`raise_for_status`**：``cat`` 的失败原因**只在 stderr
    里**（退出码非零但没有异常），不调就当成功——调用方会把一次失败下载当成
    「空文件」。调用顺序：:meth:`read` 读到 EOF → :meth:`raise_for_status` →
    :meth:`close`。

    调用方**必须**关闭它（``close()`` 或用 ``with``）：否则 exec 进程不退，
    容器内的 ``cat`` 也一直挂着。
    """

    path: str
    size: int | None
    pump: BytePump

    def read(self, size: int = DOWNLOAD_CHUNK) -> bytes:
        """读一块字节；对端关闭后返回空字节。"""
        return self.pump.read(size)

    def close(self) -> None:
        """关闭字节流（回收 exec 进程，按进程组）。"""
        self.pump.close()

    def raise_for_status(self) -> None:
        """流读完之后调用：exec 失败时抛分类后的异常。

        ``cat`` 的失败原因只在 stderr 里（``cat`` 对目录报 ``Is a directory``，
        对不存在的路径报 ``No such file or directory``）。正常读完时退出码为 0，
        不抛异常。

        **退出码可能要等一下才拿得到**：读到 EOF 时 exec 进程可能还没退
        （docker 客户端还在收尾），这里补等一小段；等不到就**不给失败结论**
        （宁可放过，也不误报）。

        **stderr 尾部要等排空线程跑完**：stdout 的 EOF 与 stderr 排空线程收尾
        **几乎同时发生**，立刻取尾部可能拿到**空串**——失败就被降级成通用文案，
        ``not_found`` 之类的分类码**丢失**。这里取尾部前**短等**一下排空线程
        （与转发轮的 ``pump_failure_reason()`` 同款解法）。
        """
        returncode = self.pump.process.poll()
        if returncode is None:
            try:
                returncode = self.pump.process.wait(timeout=DOWNLOAD_STATUS_TIMEOUT)
            except subprocess.TimeoutExpired:
                return
        if returncode is None or returncode == 0:
            return
        stderr = _stderr_tail_with_drain(self.pump)
        logger.warning("下载失败（%s）：%s", self.path, stderr)
        raise classify_stderr(stderr, self.path)

    def __enter__(self) -> DownloadStream:
        """上下文管理器入口。"""
        return self

    def __exit__(self, *exc_info: object) -> None:
        """上下文管理器出口：异常也要回收进程。"""
        self.close()


# ---------------------------------------------------------------- 路径校验
def validate_container_path(path: str) -> str:
    """校验容器内路径（**绝对路径**、**词法校验**、**无黑名单**）。

    口径（ADR 0018 第 2 节 / PRD）：

    - **绝对路径**：容器内路径必须以 ``/`` 开头；
    - **词法校验**：只按字符串判断，**不解析符号链接、不跟随、不访问文件系统**；
    - **无黑名单、全部允许**（用户拍板）：不设路径黑名单，容器内的权限由容器
      自身的用户与文件系统决定；``..`` 这类相对跳转也**不拦**（不是路径限制）；
    - **拒绝 NUL**：NUL 字节无法作为 argv 传给容器内命令。

    校验失败抛 :class:`TransferError`（固定中文文案）。
    """
    if not isinstance(path, str) or not path:
        raise TransferError(MSG_PATH_EMPTY, reason=REASON_INVALID_PATH)
    if "\x00" in path:
        raise TransferError(MSG_PATH_HAS_NUL, reason=REASON_INVALID_PATH)
    if not path.startswith("/"):
        raise TransferError(
            f"{MSG_PATH_NOT_ABSOLUTE}：{path}", reason=REASON_INVALID_PATH
        )
    return path


def _match_stderr(stderr: str, path: str) -> TransferError | None:
    """按 stderr 关键词子串匹配失败类别；认不出返回 ``None``。

    **只按关键词子串，不按整句、不按退出码**（dash 与 busybox ash 的措辞与
    退出码都不同）。这是 :func:`classify_stderr` 与上传失败路径共用的判定核心：
    上传时容器内 ``cat`` 可能先失败（``Permission denied`` / ``Read-only file
    system``），宿主侧的写入会先抛 ``BrokenPipeError``——必须先看 stderr 再决定
    归类，不能一律当「写入中断」。
    """
    text = stderr.lower()
    for keyword, reason, message in _ERROR_KEYWORDS:
        if keyword in text:
            return TransferError(f"{message}：{path}", reason=reason)
    return None


def classify_stderr(stderr: str, path: str) -> TransferError:
    """按容器内 stderr 的**关键词子串**归类失败，返回对应的异常。

    **只按关键词子串，不按整句、不按退出码**（dash 与 busybox ash 的措辞与
    退出码都不同）。**stderr 原文不进错误文案**——文案是固定中文串 + 用户给的
    目标路径（容器报错指向的是临时名或链接，不回显）。
    """
    return _match_stderr(stderr, path) or TransferError(
        f"{MSG_EXEC_FAILED}：{path}", reason=REASON_EXEC_FAILED
    )


def _temp_path(target: str) -> str:
    """生成**与目标同目录**的临时名。

    **必须同目录**：跨设备 ``mv`` 走 copy + unlink（rename 必 EXDEV），**非原子、
    中途失败留半截文件**。名字带进程号，便于定位与兜底扫描。

    **随机段 16 位十六进制（64 bit）**：临时名是「同目录里的一个我们自己起的
    文件名」，撞名意味着写错文件或写到别人的文件上。随机段从 8 位加长到 16 位
    （碰撞概率从 1/2³² 降到 1/2⁶⁴），配合上传脚本里的 ``set -C``（noclobber
    走 O_EXCL）**双保险**：即便撞名，``cat > 临时名`` 也会**写不进去**而不是
    覆盖别人的文件。
    """
    parent = posixpath.dirname(target) or "/"
    random_part = uuid.uuid4().hex[:16]
    return posixpath.join(parent, f"{TEMP_PREFIX}{os.getpid():x}-{random_part}")


def _parse_int(value: str) -> int | None:
    """解析一个整数字段（解析不了返回 ``None``）。"""
    text = value.strip()
    if not text.isdigit():
        return None
    return int(text)


def _normalize_expected_bytes(expected_bytes: int | None) -> int | None:
    """把期望字节数规整成 ``int | None``（``None`` = 不做字节数核对）。

    **非法值直接报错**（负数 / 不是整数）：期望字节数是要**拿进容器内做核对**的
    契约值，放任一个负数进去会让容器内的比较永远不符（每次上传都失败），
    或者让一个非整数（小数 / 字符串）把脚本的比较变成语义走样的字符串比较。
    失败抛 :class:`TransferError`（固定中文文案 + :data:`REASON_INVALID_SIZE`）。

    **只接受整数**：``operator.index`` 接受 ``int``（含 ``bool``）与其它实现了
    ``__index__`` 的整数型对象，**拒绝**小数与字符串（``int(1.5)`` 会静默截断成
    1——那是错值，不是调用方的意图）。
    """
    if expected_bytes is None:
        return None
    try:
        value = operator.index(expected_bytes)
    except TypeError as exc:
        raise TransferError(MSG_INVALID_SIZE, reason=REASON_INVALID_SIZE) from exc
    if value < 0:
        raise TransferError(MSG_INVALID_SIZE, reason=REASON_INVALID_SIZE)
    return value


def _stderr_tail_with_drain(
    pump: BytePump, wait_seconds: float = STDERR_DRAIN_WAIT
) -> str:
    """取字节泵的 stderr 尾部；排空线程还没收尾就**短等**一下再取。

    **为什么要等**：stderr 排空线程与 stdout 的 EOF **几乎同时发生**——读到
    EOF 时立刻取尾部，可能拿到**空串**。后果不是「少一句日志」，而是**失败被
    降级**：分类拿不到关键词就退化成通用文案，``not_found`` / ``readonly`` 这类
    **分类码直接丢失**（服务端据此映射 HTTP 状态码，丢了就映射错）。

    **只在排空线程还活着且尾部还是空时才等**（正常成功的流不受影响；已收尾的
    泵立即返回）。等待是**短等**（默认 0.5 s，10 ms 一轮），与转发轮的
    ``pump_failure_reason()`` 同款解法（那边是 async 版，本模块是同步版）。

    **stderr 原文只进日志**：返回值只用于分类与告警，不回显给调用方。
    """
    tail = pump.stderr_tail
    if tail or not getattr(pump, "stderr_drain_alive", False):
        return tail
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        time.sleep(STDERR_DRAIN_POLL)
        tail = pump.stderr_tail
        if tail or not getattr(pump, "stderr_drain_alive", False):
            break
    return tail


def _write_all(pump: BytePump, chunk: bytes) -> int:
    """把一块字节写进字节泵（**短写循环**：一次 ``write`` 不一定写完）。

    返回实际写入的字节数（写满即返回）。

    管道已关时 ``write`` 可能抛 ``ValueError``（``I/O operation on closed file``），
    统一收口成 ``OSError``：调用方只该看到「写入失败」这一类失败。
    """
    view = chunk
    total = 0
    while view:
        try:
            written = pump.write(view)
        except (OSError, ValueError) as exc:
            raise OSError("字节泵写入失败") from exc
        if written <= 0:
            raise OSError("字节泵已关闭，写入失败")
        view = view[written:]
        total += written
    return total


def _close_stdin(process: "subprocess.Popen[bytes]") -> None:
    """关掉 exec 的 stdin（让容器内的 ``cat`` 看到 EOF，进而执行 ``mv``）。"""
    stream = process.stdin
    if stream is None:
        return
    try:
        stream.close()
    except OSError:  # pragma: no cover - 管道已断（失败路径上正常）
        pass


def _wait_exit(process: "subprocess.Popen[bytes]", timeout: float) -> int:
    """等 exec 进程退出，返回退出码。"""
    returncode = process.wait(timeout=timeout)
    return 0 if returncode is None else returncode


# ---------------------------------------------------------------- 编排入口
class FileTransferManager:
    """运行期文件传输编排入口。

    能力本体全在本类：路径校验、上传（临时名 + ``mv`` 覆盖）、探测、下载字节泵、
    目录列表。服务端（03 轮）只做编排与转译。

    依赖注入风格与 ``PortForwardManager`` 一致：沙箱侧能力由构造参数注入
    （``service=``），没装配时用到才报错，不在导入期炸。
    """

    def __init__(self, service: TransferRuntime | None = None) -> None:
        self.service = service

    # ---------------------------------------------------------------- 上传
    def upload(
        self,
        sandbox: str,
        target_path: str,
        chunks: Iterable[bytes],
        expected_bytes: int | None = None,
    ) -> int:
        """把字节流写入容器内的目标路径，返回**写入的字节数**。

        实现链（ADR 0018 第 2 节）：

        1. **前置探测**（两次 exec）：父目录必须已存在（平台**不主动创建父目录**，
           缺失即报错引导）；目标本身**不能是已存在目录**（实测 ``mv 临时名 目录``
           rc=0 假成功，文件被搬进目录里 → 必须前置拦截，**不依赖 ``mv -T``**，
           busybox 不支持）；
        2. ``cat > 同目录临时名`` 写入字节（``docker exec -i``，stdin 收字节）；
        3. **核对字节数**（仅当 ``expected_bytes`` 给了）：临时文件的实际字节数
           与期望值不等 ⇒ 删临时名 + 报错 + **不执行 ``mv``**；
        4. ``mv 临时名 目标`` **原子替换**（同目录 ⇒ 同设备 rename）。

        ``expected_bytes``：**期望写入的字节数**（调用方拿得到总长度时传入，
        服务端从请求头 ``Content-Length`` 取）。它经 **argv 直传**给容器内的
        上传脚本（脚本的 ``"$3"`` 位置参数），**不拼进脚本文本**。

        - **给了期望值** ⇒ 容器内 ``cat`` 写完后先量临时文件的实际字节数
          （``wc -c < 临时名``），**不等就不 ``mv``**：删临时名、打 ``size
          mismatch`` 标记、非零退出 ⇒ 平台侧归类成
          :data:`REASON_SIZE_MISMATCH`（固定文案「上传中断，目标文件未完整
          写入」），**目标路径原样不动**（原文件保留，不会被半截内容覆盖）；
        - **没给期望值**（``None``）⇒ **跳过核对**，行为与修复前完全一致
          （argv 里也不带校验参数）。**残余风险**：**没有长度信息的中断仍可能在
          目标路径留下半截文件**——客户端中断上传时宿主侧会关掉 exec 的 stdin，
          容器内的 ``cat`` 收到**干净 EOF**、rc=0（03 轮真机实测：250 MiB 上传
          60 s 掐断后目标留下 189,726,720 字节）。调用方拿得到总长度时
          **应当传** ``expected_bytes``。

        语义：

        - **目标已存在 = 覆盖**（用户拍板）；目标文件自身只读（``0444``）**不报错**
          （父目录可写时被静默覆盖，实测 root 与非 root 同）；
        - **符号链接指向目录时一律拒**（保守）：探测**跟随**符号链接 ⇒ 判为目录 ⇒
          前置拒绝。ADR 0018 第 7 节第 9 条里「上传 rename 不跟随末端符号链接」
          指的是**替换动作**（换的是链接本身，不是链接指向的文件），与这里的
          **前置类型判定**是两件事，刻意不合并；
        - 失败 / 中断 → **平台侧显式清理临时文件**（``rm -f -- <临时名>``，
          best-effort）：实测 exec 被杀时容器内会留下半截临时文件，``cat`` 不会
          自清理。**例外**：noclobber 撞名（临时名已存在）时那个路径不是我们建的，
          不清理（见 :data:`REASON_TEMP_NAME_EXISTS`）；
        - **临时名防写穿**：容器内脚本先 ``set -C``（noclobber 走 O_EXCL），
          临时名被**预先放个符号链接**时写不进去（实测 dash 与 busybox ash 都
          挡住；不加 noclobber 时实测会顺着链接写穿到链接目标）；临时名随机段
          **16 位十六进制**（64 bit）；
        - **不保留原目标的属主/权限**：``mv`` 换的是文件本身，新文件的权限随临时
          名走（不是原目标的）。要保留得用 ``chmod --reference``（busybox 无此
          选项）——本轮**不做**，列为待办；
        - **大小不限**：字节流边写边计数，不整文件进内存。

        失败抛 :class:`TransferError`（固定中文文案 + 失败分类码）。
        """
        target = validate_container_path(target_path)
        expected = _normalize_expected_bytes(expected_bytes)
        daemon, container = self._resolve(sandbox)

        # 前置探测一：父目录必须已存在（平台不主动创建父目录）
        parent = posixpath.dirname(target) or "/"
        parent_probe = self._probe(daemon, container, parent)
        if parent_probe.kind == KIND_MISSING:
            raise TransferError(
                f"{MSG_PARENT_MISSING}：{parent}", reason=REASON_PARENT_MISSING
            )
        if parent_probe.kind != KIND_DIR:
            raise TransferError(
                f"{MSG_PARENT_NOT_DIRECTORY}：{parent}",
                reason=REASON_PARENT_NOT_DIRECTORY,
            )

        # 前置探测二：目标本身不能是已存在目录
        target_probe = self._probe(daemon, container, target)
        if target_probe.kind == KIND_DIR:
            raise TransferError(
                f"{MSG_TARGET_IS_DIR}：{target}", reason=REASON_TARGET_IS_DIR
            )

        temp = _temp_path(target)
        # 路径一律 argv 直传：临时名与目标路径各占一个 argv 元素，
        # 脚本文本是固定的（路径经 "$1" / "$2" 位置参数传入）。
        # 期望字节数也走 argv（"$3" 位置参数）——**不给就不带这个参数**，
        # 脚本里的 ``[ -n "$3" ]`` 为假 ⇒ 跳过字节数核对。
        argv = [
            "docker",
            "exec",
            "-i",
            container,
            "sh",
            "-c",
            UPLOAD_SCRIPT,
            "sh",
            temp,
            target,
        ]
        if expected is not None:
            argv.append(str(expected))
        process = daemon.spawn_stream(argv)
        pump = BytePump(process=process, forward_id=f"upload:{sandbox}")
        written = 0
        failure: BaseException | None = None
        returncode = 0
        try:
            for chunk in chunks:
                if not chunk:
                    continue
                written += _write_all(pump, chunk)
            # 关 stdin：容器内的 cat 读到 EOF 结束，随后 mv 执行
            _close_stdin(process)
            returncode = _wait_exit(process, UPLOAD_FINISH_TIMEOUT)
        except BaseException as exc:  # noqa: BLE001 - 统一收口成 TransferError
            failure = exc
        finally:
            # 关闭字节泵：进程已退出时只收尾排空线程，仍在跑时按进程组回收
            pump.close()

        if failure is not None:
            stderr = _stderr_tail_with_drain(pump)
            if stderr:
                logger.warning(
                    "上传中断（沙箱 %s，目标 %s）：%s", sandbox, target, stderr
                )
            # **先按 stderr 关键词归类**：容器内的 ``cat > 临时名`` 可能先失败
            # （父目录不可写 / 只读挂载 / 父目录缺失），宿主侧的写入随之抛
            # ``BrokenPipeError``——不能一律当「写入中断」，否则三类失败的
            # 固定文案全被吞掉（ADR 0018 第 8 节）。
            classified = _match_stderr(stderr, target)
            # **再决定要不要清理**：noclobber 撞名（临时名已存在）时那个路径
            # **不是我们建的**（可能是别人放的符号链接或文件），不能当自己的
            # 残骸删掉——平台没有资格替用户删。
            if classified is None or classified.reason != REASON_TEMP_NAME_EXISTS:
                # 失败路径：平台侧显式清理临时文件（不留残骸）
                self._remove_temp(daemon, container, temp)
            if classified is not None:
                raise classified from failure
            if isinstance(failure, subprocess.TimeoutExpired):
                raise TransferError(
                    f"{MSG_EXEC_TIMEOUT}：{target}", reason=REASON_EXEC_FAILED
                ) from failure
            if isinstance(failure, OSError):
                raise TransferError(
                    f"{MSG_WRITE_FAILED}：{target}", reason=REASON_WRITE_FAILED
                ) from failure
            raise failure

        if returncode != 0:
            stderr = _stderr_tail_with_drain(pump)
            logger.warning("上传失败（沙箱 %s，目标 %s）：%s", sandbox, target, stderr)
            classified = classify_stderr(stderr, target)
            # 同上：撞名时那个路径不是我们建的，不清理
            if classified.reason != REASON_TEMP_NAME_EXISTS:
                # 失败路径：平台侧显式清理临时文件（不留残骸）
                self._remove_temp(daemon, container, temp)
            raise classified
        return written

    # ---------------------------------------------------------------- 探测
    def probe(self, sandbox: str, path: str) -> ProbeResult:
        """探测容器内路径的类型与字节数（**分层判定**，单次 exec）。

        分支：**不存在 / 目录 / 普通文件（附字节数）/ 特殊文件（FIFO·设备·
        套接字·其他）**，符号链接按**跟随**口径判类型（取目标的值）。

        失败抛 :class:`TransferError`（固定中文文案）。
        """
        target = validate_container_path(path)
        daemon, container = self._resolve(sandbox)
        return self._probe(daemon, container, target)

    def _probe(
        self, daemon: UserDaemon, container: str, target: str
    ) -> ProbeResult:
        """探测实现（调用方已解析好守护进程与容器名）。"""
        returncode, stdout, stderr = self._exec_capture(
            daemon, container, ["sh", "-c", PROBE_SCRIPT, "sh", target]
        )
        if returncode != 0:
            logger.warning(
                "探测路径 %s 失败（沙箱容器 %s）：%s", target, container, stderr
            )
            raise classify_stderr(stderr, target)
        return _parse_probe(target, stdout)

    # ---------------------------------------------------------------- 下载
    def download(self, sandbox: str, path: str) -> DownloadStream:
        """起一条下载字节流（``cat -- <path>``），由调用方流式读。

        **前置探测是必须项，不是优化**（实测）：FIFO 会把 exec **挂死**（GNU 与
        busybox 都挂，一条请求就能占住一条 exec 进程）；``/dev/null`` 会「成功地」
        返回一个 0 字节的空下载。所以**只放行普通文件**：目录 / 特殊文件 /
        不存在各自报错。

        **探测到的字节数只是提示，不是契约**：文件在探测与 ``cat`` 之间被改写，
        实际流出的字节数就与探测值不一致（要严格一致得在流里核对长度，本轮
        **不做**，列为待办）。

        返回的 :class:`DownloadStream` 必须由调用方关闭（否则 exec 进程不退）。
        """
        target = validate_container_path(path)
        daemon, container = self._resolve(sandbox)
        probe = self._probe(daemon, container, target)
        if probe.kind == KIND_MISSING:
            raise TransferError(
                f"{MSG_NOT_FOUND}：{target}", reason=REASON_NOT_FOUND
            )
        if probe.kind == KIND_DIR:
            raise TransferError(
                f"{MSG_IS_DIRECTORY}：{target}", reason=REASON_TARGET_IS_DIR
            )
        if probe.kind not in DOWNLOADABLE_KINDS:
            raise TransferError(
                f"{MSG_NOT_REGULAR}：{target}", reason=REASON_NOT_REGULAR
            )
        # 路径 argv 直传；``--`` 挡住「以 - 开头的路径」被当成选项
        # （路径是绝对路径，理论上不会以 - 开头，双保险）。
        argv = ["docker", "exec", "-i", container, "cat", "--", target]
        process = daemon.spawn_stream(argv)
        pump = BytePump(process=process, forward_id=f"download:{sandbox}")
        return DownloadStream(path=target, size=probe.size, pump=pump)

    # ---------------------------------------------------------------- 列表
    def list(self, sandbox: str, dir_path: str) -> list[ListEntry]:
        """列出容器内目录的条目（**单次 find exec**，NUL 分隔记录）。

        条目字段：**名称 / 类型 / 字节数 / 修改时间**；**隐藏文件（``.`` 开头）
        包含在内**（``find`` 不做过滤）。

        名字里的**空格 / 中文 / 换行 / 引号 / 反斜杠 / 制表符**都保真（记录以 NUL
        结尾，解析只按前 3 个 TAB 切）。名字按 UTF-8 显式解码，非法字节用替代符
        （不靠 locale 默认解码承载文件名）。

        **前置判定（目标必须是目录）**：``find <普通文件> -maxdepth 1 -mindepth 1``
        **静默返回空**（rc=0、无输出）——调用方会把「列了一个文件」误读成
        「目录是空的」。因此先做一次 ``-d`` 判定（一次探测 exec）：不是目录就
        按既有分类码/文案体系报错（复用 :data:`REASON_NOT_REGULAR`，文案按场景
        取「目标不是目录」），**不新造概念**。

        失败抛 :class:`TransferError`（固定中文文案）。
        """
        target = validate_container_path(dir_path)
        daemon, container = self._resolve(sandbox)
        # 前置判定：目标必须是目录（find 对普通文件路径静默返回空，会被误读）
        probe = self._probe(daemon, container, target)
        if probe.kind == KIND_MISSING:
            raise TransferError(
                f"{MSG_NOT_FOUND}：{target}", reason=REASON_NOT_FOUND
            )
        if probe.kind != KIND_DIR:
            raise TransferError(
                f"{MSG_NOT_A_DIRECTORY}：{target}", reason=REASON_NOT_REGULAR
            )
        returncode, stdout, stderr = self._exec_capture(
            daemon, container, ["sh", "-c", LIST_SCRIPT, "sh", target]
        )
        if returncode != 0:
            logger.warning(
                "列目录失败（沙箱容器 %s，目录 %s）：%s", container, target, stderr
            )
            raise classify_stderr(stderr, target)
        return _parse_list_entries(target, stdout)

    # ---------------------------------------------------------------- 内部辅助
    def _resolve(self, sandbox: str) -> tuple[UserDaemon, str]:
        """取沙箱的守护进程入口与容器名。"""
        if self.service is None:
            raise TransferError(MSG_NO_RUNTIME, reason=REASON_NO_RUNTIME)
        metadata = self.service.get(sandbox)
        daemon = self.service.daemon_for(sandbox)
        return daemon, metadata.container_name

    def _exec_capture(
        self,
        daemon: UserDaemon,
        container: str,
        argv: list[str],
        timeout: float | None = None,
    ) -> tuple[int, bytes, str]:
        """在容器内跑一条命令并收集输出。

        返回 ``(退出码, stdout 原始字节, stderr 文本)``。

        **stdout 按字节取回**：文件名可能不是合法 UTF-8，宿主侧**显式**用 UTF-8
        解码（非法字节用替代符），不靠 locale 默认解码（实测 D-14）。

        **超时**：读 stdout 是阻塞读（容器内命令不退出就一直在读），光等
        ``wait`` 超时管不到它——因此挂一个**看门狗定时器**：到点就把字节泵
        关掉（顺带按进程组回收 exec），读循环随即收尾，按「命令超时」报错。

        **看门狗关泵与主线程读 stdout 是跨线程竞态**：看门狗线程
        ``pump.close()`` 会关掉 stdout，主线程阻塞在 ``pump.read()`` 上就可能
        撞上 ``ValueError: read of closed file``（不是 ``TransferError`` 形态，
        会漏成裸异常）。因此读的那一步**单独包住** ``OSError`` / ``ValueError``：
        看门狗已置位就是**超时**（收口成「命令执行超时」），没置位也收口成
        传输失败——本方法只抛 :class:`TransferError`。
        """
        limit = EXEC_TIMEOUT if timeout is None else timeout
        process = daemon.spawn_stream(["docker", "exec", container, *argv])
        pump = BytePump(process=process, forward_id="transfer")
        timed_out = threading.Event()

        def _on_timeout() -> None:
            timed_out.set()
            pump.close()

        watchdog = threading.Timer(limit, _on_timeout)
        watchdog.daemon = True
        watchdog.start()
        chunks: list[bytes] = []
        returncode = 0
        try:
            while True:
                try:
                    chunk = pump.read(EXEC_CHUNK)
                except (OSError, ValueError) as exc:
                    # 看门狗线程关泵与本线程的读撞上了（见上文说明）
                    if timed_out.is_set():
                        raise subprocess.TimeoutExpired(
                            cmd="docker exec", timeout=limit
                        ) from exc
                    raise TransferError(
                        MSG_EXEC_FAILED, reason=REASON_EXEC_FAILED
                    ) from exc
                if not chunk:
                    break
                chunks.append(chunk)
            if timed_out.is_set():
                raise subprocess.TimeoutExpired(cmd="docker exec", timeout=limit)
            returncode = _wait_exit(process, limit)
        except subprocess.TimeoutExpired as exc:
            raise TransferError(MSG_EXEC_TIMEOUT, reason=REASON_EXEC_FAILED) from exc
        finally:
            watchdog.cancel()
            pump.close()
        return returncode, b"".join(chunks), pump.stderr_tail

    def _remove_temp(
        self, daemon: UserDaemon, container: str, temp: str
    ) -> None:
        """清理容器内的临时文件（best-effort：清不掉只告警，不影响主流程）。

        ``rm`` 同样**argv 直传**（不拼进 ``sh -c``）：临时名带随机串，拼进脚本文本
        反而多一处风险。
        """
        try:
            result = daemon.exec_in_container(
                container, ["rm", "-f", "--", temp], check=False, timeout=60
            )
        except Exception as exc:  # pragma: no cover - 宿主命令异常（超时等）
            logger.warning("清理临时文件失败：%s（%s）", temp, exc)
            return
        if not result.ok:
            logger.warning("清理临时文件失败：%s（%s）", temp, result.output.strip())


# ---------------------------------------------------------------- 解析
def _parse_probe(target: str, stdout: bytes) -> ProbeResult:
    """解析探测脚本的输出。"""
    text = stdout.decode("utf-8", errors="replace").strip()
    if not text:
        raise TransferError(f"{MSG_EXEC_FAILED}：{target}", reason=REASON_EXEC_FAILED)
    fields = text.split("\t")
    kind = _PROBE_KINDS.get(fields[0].strip())
    if kind is None:
        raise TransferError(f"{MSG_EXEC_FAILED}：{target}", reason=REASON_EXEC_FAILED)
    size = _parse_int(fields[1]) if len(fields) > 1 else None
    mtime = _parse_int(fields[2]) if len(fields) > 2 else None
    return ProbeResult(path=target, kind=kind, size=size, mtime=mtime)


def _parse_list_entries(target: str, stdout: bytes) -> list[ListEntry]:
    """解析列表脚本的输出（NUL 分隔的记录）。

    记录形状：``类型 \\t 字节数 \\t 修改时间 \\t 名称``。解析**只按前 3 个 TAB
    切**——后面的全归文件名（名字里可能有 TAB）。
    """
    entries: list[ListEntry] = []
    for record in stdout.split(b"\x00"):
        if not record:
            continue
        text = record.decode("utf-8", errors="replace")
        fields = text.split("\t", 3)
        if len(fields) < 4:
            logger.warning("列表记录字段不全，跳过（目录 %s）：%r", target, record)
            continue
        type_token, size_text, mtime_text, name = fields
        entries.append(
            ListEntry(
                name=name,
                kind=_LIST_KINDS.get(type_token.strip(), KIND_SPECIAL),
                size=_parse_int(size_text) or 0,
                mtime=_parse_int(mtime_text) or 0,
            )
        )
    return entries
