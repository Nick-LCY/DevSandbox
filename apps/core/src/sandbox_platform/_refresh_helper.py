"""文件注入副本刷新 helper（窄用途、仅标准库、随包分发）。

**它是什么**：一个自包含的可信脚本，由核心包经**既有 ``Privilege`` 通道**
（root 直跑，否则 ``sudo -n``）以「**受信绝对路径 + ``python -I``**」调用：

    <sys.executable> -I <包目录>/_refresh_helper.py '<JSON 元数据>'

``python -I`` 是隔离模式：``PYTHONPATH`` 与用户 site 目录都不生效，而且
**脚本所在目录不会进 ``sys.path``**（``-I`` 隐含 ``-P``）——因此本文件
**不得 import 包内任何模块**，必须自包含（只用标准库）。

**它做什么**：把宿主源的新内容读进平台私有的匿名暂存（spool），再**降到沙箱
用户身份**把新内容写回托管副本（单文件原位覆盖 / 目录递归镜像）。

**它不做什么**：不装系统组件、不读配置、不动宿主原件（只读）、不备份、不回滚、
不承诺原子性。

失败分类（stdout 恒为**一行** JSON；正文与 traceback 一律不外泄）：

======================  ====  ==========================================
分类码                  退出码  含义
======================  ====  ==========================================
``OK``                   0    刷新成功
``SOURCE_UNSAFE``       10    源侧问题（缺失 / 不可读 / 受限 / 符号链接 /
                              非常规文件 / 读期间不稳定）：**目标零改动**
``DESTINATION_UNSAFE``  20    目的侧问题（根身份 / 种类不符 / 符号链接 /
                              冒名硬链接）：**目标零改动**
``PARTIAL``             30    已进入写入阶段后失败：**可能部分更新**，
                              停止后续更新与镜像删除，不回滚，可重试
``INTERNAL``            40    helper 自身问题（参数 / 暂存 / 降权 / 崩溃）
======================  ====  ==========================================

stdout 形如 ``{"code":"OK"}``；失败时附带一个**不含路径、不含正文**的
``reason`` 细分码（如 ``{"code":"SOURCE_UNSAFE","reason":"source_missing"}``）。

**调用契约（与 02 任务的 wire contract）**：请求是一个 JSON 对象，只含元数据：

- ``source_path``：宿主源绝对路径（已按创建时口径校验过词法范围）；
- ``staged_path``：托管副本绝对路径（写目标）；
- ``kind``：``file`` 或 ``directory``；
- ``staged_dev`` / ``staged_ino``：托管副本根的 ``st_dev`` / ``st_ino``
  （写入时逐一核对，防止写到冒名副本）；
- ``uid`` / ``gid``：写入要降到的沙箱用户身份；
- ``forbidden_roots``：**已解析**的受限根清单（宿主敏感清单 + 任何已存在的
  沙箱用户家目录 + 平台数据根；核心侧 fail-closed 取齐后传入）；
- ``spool_root``：平台私有暂存目录（匿名 spool 落在这里）。

JSON 的投递方式：**优先 stdin**（既有 ``run`` 走 ``stdin_text``，管道干净、
不进 ``ps`` 命令行）；**既有 ``run`` 没有可用 stdin 时退到 argv**，作为
**单个** argv 元素传入。两种方式本文件都接受，且**只认一个来源**。

**为什么写在这个包里**：它随 ``sandbox-platform-core`` 发布包分发，调用方用
``Path(sandbox_platform.__file__).with_name("_refresh_helper.py")`` 取到绝对
路径即可——不需要 ``/usr/local`` 安装、不新增 env 配置、不新增 sudo 宽规则。
"""

from __future__ import annotations

import errno
import json
import os
import stat
import sys
import tempfile
from dataclasses import dataclass

# ---------------------------------------------------------------- 固定契约

#: 源 / 目标的种类
KIND_FILE = "file"
KIND_DIRECTORY = "directory"

#: 失败分类码
CODE_OK = "OK"
CODE_SOURCE_UNSAFE = "SOURCE_UNSAFE"
CODE_DESTINATION_UNSAFE = "DESTINATION_UNSAFE"
CODE_PARTIAL = "PARTIAL"
CODE_INTERNAL = "INTERNAL"

#: 分类码 → 退出码
EXIT_BY_CODE: dict[str, int] = {
    CODE_OK: 0,
    CODE_SOURCE_UNSAFE: 10,
    CODE_DESTINATION_UNSAFE: 20,
    CODE_PARTIAL: 30,
    CODE_INTERNAL: 40,
}

#: 单次读写的块大小
CHUNK_SIZE = 1 << 20

#: 请求 JSON 的字节上限（只含元数据，正常远小于此）
MAX_PAYLOAD_BYTES = 1 << 20

#: 副本里的普通文件权限
FILE_MODE = 0o600
#: 副本里的目录权限
DIR_MODE = 0o700


class HelperError(Exception):
    """带失败分类与细分原因的内部异常。"""

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class Request:
    """一次刷新的全部输入（只含元数据）。"""

    source_path: str
    staged_path: str
    kind: str
    staged_dev: int
    staged_ino: int
    uid: int
    gid: int
    forbidden_roots: tuple[str, ...]
    spool_root: str


@dataclass(frozen=True)
class Entry:
    """源树清单里的一项。

    ``relpath`` 为相对源根的路径（根本身是空串）；文件的字节在 spool 里的
    位置是 ``offset``、长度是 ``size``（**元数据留内存**，spool 只存字节）。
    """

    relpath: str
    kind: str
    offset: int = 0
    size: int = 0


# ---------------------------------------------------------------- 路径工具


def _normalize(path: str) -> str:
    """词法归一化：折叠 ``.`` / ``..``，并把前导多斜杠压成一个。

    与既有 ``mounts.normalize_host_path`` 同一口径（``os.path.normpath`` 会
    原样保留**恰好两个**前导斜杠，``//etc/shadow`` 那种变体得靠这里压平）。
    """
    norm = os.path.normpath(path)
    if norm.startswith("//"):
        norm = "/" + norm.lstrip("/")
    return norm


def _is_under(path: str, base: str) -> bool:
    """路径是否等于 ``base`` 或落在 ``base`` 之下。"""
    if path == base:
        return True
    return path.startswith(base.rstrip("/") + "/")


def _hits_forbidden(path: str, roots: tuple[str, ...]) -> bool:
    """路径是否命中受限根清单。"""
    return any(_is_under(path, root) for root in roots)


def _open_dir_chain(path: str) -> int:
    """逐段打开一个目录路径，返回末段目录的 fd。

    **每段都带 ``O_NOFOLLOW``**：祖先路径允许在进入 helper 之前就被解析成
    真实路径（``os.path.realpath`` 已解析过），但**解析之后**若有人把某一段
    换成符号链接，这里会直接失败——不在打开时追随后续替换。

    失败时抛 ``OSError``，由调用方翻译成分类码。
    """
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split("/"):
            if not part:
                continue
            next_fd = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=fd,
            )
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


# ---------------------------------------------------------------- 请求解析


def _read_payload(argv: list[str]) -> dict:
    """读取请求 JSON（只含元数据）。

    - ``argv`` 有一个元素 ⇒ **argv 模式**（整份 JSON 作为单个 argv 元素）；
    - ``argv`` 为空 ⇒ **stdin 模式**（读管道）。

    两种方式**只认一个**；都拿不到就是参数错误。
    """
    if len(argv) == 1:
        raw = argv[0]
    elif not argv:
        if sys.stdin is None or sys.stdin.isatty():
            raise HelperError(CODE_INTERNAL, "bad_arguments")
        raw = sys.stdin.read(MAX_PAYLOAD_BYTES + 1)
        if len(raw) > MAX_PAYLOAD_BYTES:
            raise HelperError(CODE_INTERNAL, "payload_too_large")
    else:
        raise HelperError(CODE_INTERNAL, "bad_arguments")
    try:
        payload = json.loads(raw)
    except ValueError:
        raise HelperError(CODE_INTERNAL, "bad_payload") from None
    if not isinstance(payload, dict):
        raise HelperError(CODE_INTERNAL, "bad_payload")
    return payload


def _parse_request(payload: dict) -> Request:
    """校验并装配请求。字段缺失或类型不对一律算内部错误。"""

    def need_str(key: str) -> str:
        value = payload.get(key)
        if not isinstance(value, str) or not value:
            raise HelperError(CODE_INTERNAL, "bad_payload")
        return value

    def need_int(key: str) -> int:
        value = payload.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise HelperError(CODE_INTERNAL, "bad_payload")
        return value

    kind = need_str("kind")
    if kind not in (KIND_FILE, KIND_DIRECTORY):
        raise HelperError(CODE_INTERNAL, "bad_payload")
    uid = need_int("uid")
    gid = need_int("gid")
    if uid == 0:
        # 沙箱用户永远不是 root：把写入降到 root 等于没降权
        raise HelperError(CODE_INTERNAL, "bad_payload")
    raw_roots = payload.get("forbidden_roots", [])
    if not isinstance(raw_roots, list):
        raise HelperError(CODE_INTERNAL, "bad_payload")
    roots: list[str] = []
    for item in raw_roots:
        if not isinstance(item, str) or not item:
            raise HelperError(CODE_INTERNAL, "bad_payload")
        normalized = _normalize(item)
        if normalized not in roots:
            roots.append(normalized)
    source_path = need_str("source_path")
    staged_path = need_str("staged_path")
    spool_root = need_str("spool_root")
    for path in (source_path, staged_path, spool_root):
        if not _normalize(path).startswith("/"):
            raise HelperError(CODE_INTERNAL, "bad_payload")
    if _normalize(source_path) == _normalize(staged_path):
        raise HelperError(CODE_INTERNAL, "bad_payload")
    return Request(
        source_path=source_path,
        staged_path=staged_path,
        kind=kind,
        staged_dev=need_int("staged_dev"),
        staged_ino=need_int("staged_ino"),
        uid=uid,
        gid=gid,
        forbidden_roots=tuple(roots),
        spool_root=spool_root,
    )


# ---------------------------------------------------------------- 源侧：校验与读取


def _resolve_source(request: Request) -> tuple[str, str, os.stat_result]:
    """解析源的真实位置并做词法 + 真实路径双重受限校验。

    只解析**祖先**（``realpath`` 作用在父目录上）：祖先里允许有符号链接
    （那属于「已校验安全的祖先路径解析」），但**源自身是符号链接即拒绝**。
    """
    source = _normalize(request.source_path)
    if not source.startswith("/") or source == "/":
        raise HelperError(CODE_SOURCE_UNSAFE, "bad_path")
    parent = os.path.dirname(source)
    name = os.path.basename(source)
    if not name:
        raise HelperError(CODE_SOURCE_UNSAFE, "bad_path")
    if _hits_forbidden(source, request.forbidden_roots):
        raise HelperError(CODE_SOURCE_UNSAFE, "restricted")
    real_parent = os.path.realpath(parent)
    if not real_parent.startswith("/"):
        raise HelperError(CODE_SOURCE_UNSAFE, "bad_path")
    real_source = f"{real_parent}/{name}"
    if _hits_forbidden(real_source, request.forbidden_roots):
        raise HelperError(CODE_SOURCE_UNSAFE, "restricted")
    try:
        source_stat = os.lstat(real_source)
    except FileNotFoundError:
        raise HelperError(CODE_SOURCE_UNSAFE, "source_missing") from None
    except OSError:
        raise HelperError(CODE_SOURCE_UNSAFE, "unreadable") from None
    if stat.S_ISLNK(source_stat.st_mode):
        raise HelperError(CODE_SOURCE_UNSAFE, "source_symlink")
    if request.kind == KIND_FILE and not stat.S_ISREG(source_stat.st_mode):
        raise HelperError(CODE_SOURCE_UNSAFE, "source_kind_mismatch")
    if request.kind == KIND_DIRECTORY and not stat.S_ISDIR(source_stat.st_mode):
        raise HelperError(CODE_SOURCE_UNSAFE, "source_kind_mismatch")
    return real_parent, name, source_stat


def _open_source(request: Request, parent_fd: int, name: str) -> int:
    """在父目录 fd 下**不跟随**地打开源自身。"""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    if request.kind == KIND_DIRECTORY:
        flags |= os.O_DIRECTORY
    try:
        return os.open(name, flags, dir_fd=parent_fd)
    except FileNotFoundError:
        raise HelperError(CODE_SOURCE_UNSAFE, "source_missing") from None
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise HelperError(CODE_SOURCE_UNSAFE, "source_symlink") from None
        raise HelperError(CODE_SOURCE_UNSAFE, "unreadable") from None


def _spool_regular(spool, fd: int, expected: os.stat_result) -> tuple[int, int]:
    """把一个普通文件的内容读完进 spool，并核对读期间的身份与稳定性。

    返回 ``(在 spool 里的偏移, 字节数)``。
    """
    offset = spool.tell()
    total = 0
    while True:
        chunk = os.read(fd, CHUNK_SIZE)
        if not chunk:
            break
        spool.write(chunk)
        total += len(chunk)
    spool.flush()
    after = os.fstat(fd)
    if (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ) != (
        expected.st_dev,
        expected.st_ino,
        expected.st_size,
        expected.st_mtime_ns,
    ):
        raise HelperError(CODE_SOURCE_UNSAFE, "source_unstable")
    if total != expected.st_size:
        raise HelperError(CODE_SOURCE_UNSAFE, "source_unstable")
    return offset, total


def _scan_directory(
    request: Request,
    spool,
    dir_fd: int,
    dir_stat: os.stat_result,
    real_dir: str,
    rel_prefix: str,
    entries: list[Entry],
) -> None:
    """递归枚举源目录树：符号链接与非常规文件一律拒绝。

    枚举与读取都走 **dirfd + ``O_NOFOLLOW``**，并用**实际 ``fstat``** 与枚举
    时的身份逐一比对——中途被换成符号链接或换了文件都判失败，不会读错内容。
    """
    before = (dir_stat.st_mtime_ns, dir_stat.st_size, dir_stat.st_nlink)
    items: list[tuple[str, str, os.stat_result]] = []
    with os.scandir(dir_fd) as scanner:
        for item in scanner:
            if item.is_symlink():
                raise HelperError(CODE_SOURCE_UNSAFE, "source_symlink_in_tree")
            if item.is_dir(follow_symlinks=False):
                kind = KIND_DIRECTORY
            elif item.is_file(follow_symlinks=False):
                kind = KIND_FILE
            else:
                raise HelperError(CODE_SOURCE_UNSAFE, "special_file_in_tree")
            items.append((item.name, kind, item.stat(follow_symlinks=False)))
    for name, kind, item_stat in items:
        rel = f"{rel_prefix}/{name}" if rel_prefix else name
        member_real = f"{real_dir}/{name}"
        if _hits_forbidden(member_real, request.forbidden_roots):
            raise HelperError(CODE_SOURCE_UNSAFE, "restricted")
        if kind == KIND_DIRECTORY:
            try:
                child_fd = os.open(
                    name,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=dir_fd,
                )
            except OSError:
                raise HelperError(CODE_SOURCE_UNSAFE, "source_incomplete") from None
            try:
                child_stat = os.fstat(child_fd)
                if not stat.S_ISDIR(child_stat.st_mode) or (
                    child_stat.st_dev,
                    child_stat.st_ino,
                ) != (item_stat.st_dev, item_stat.st_ino):
                    raise HelperError(CODE_SOURCE_UNSAFE, "source_changed")
                entries.append(Entry(rel, KIND_DIRECTORY))
                _scan_directory(
                    request,
                    spool,
                    child_fd,
                    child_stat,
                    member_real,
                    rel,
                    entries,
                )
            finally:
                os.close(child_fd)
        else:
            try:
                file_fd = os.open(
                    name,
                    os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                    dir_fd=dir_fd,
                )
            except OSError:
                raise HelperError(CODE_SOURCE_UNSAFE, "source_incomplete") from None
            try:
                file_stat = os.fstat(file_fd)
                if not stat.S_ISREG(file_stat.st_mode) or (
                    file_stat.st_dev,
                    file_stat.st_ino,
                ) != (item_stat.st_dev, item_stat.st_ino):
                    raise HelperError(CODE_SOURCE_UNSAFE, "source_changed")
                offset, size = _spool_regular(spool, file_fd, file_stat)
                entries.append(Entry(rel, KIND_FILE, offset, size))
            finally:
                os.close(file_fd)
    after = os.fstat(dir_fd)
    if (after.st_mtime_ns, after.st_size, after.st_nlink) != before:
        raise HelperError(CODE_SOURCE_UNSAFE, "source_unstable")


def _read_source(request: Request, spool) -> list[Entry]:
    """完整枚举并读完源的新内容，返回源树清单。

    **任何失败都在写入阶段之前抛出**：读不全 / 枚举不全一律不进写入阶段，
    目标一个字节都不动。空目录是「枚举成功且结果为空」的独立情况，不是失败。
    """
    real_parent, name, source_stat = _resolve_source(request)
    try:
        parent_fd = _open_dir_chain(real_parent)
    except OSError:
        raise HelperError(CODE_SOURCE_UNSAFE, "unreadable") from None
    try:
        source_fd = _open_source(request, parent_fd, name)
        try:
            opened = os.fstat(source_fd)
            if (opened.st_dev, opened.st_ino) != (
                source_stat.st_dev,
                source_stat.st_ino,
            ):
                raise HelperError(CODE_SOURCE_UNSAFE, "source_changed")
            if request.kind == KIND_FILE:
                if not stat.S_ISREG(opened.st_mode):
                    raise HelperError(CODE_SOURCE_UNSAFE, "source_kind_mismatch")
                offset, size = _spool_regular(spool, source_fd, opened)
                return [Entry("", KIND_FILE, offset, size)]
            if not stat.S_ISDIR(opened.st_mode):
                raise HelperError(CODE_SOURCE_UNSAFE, "source_kind_mismatch")
            entries = [Entry("", KIND_DIRECTORY)]
            _scan_directory(
                request,
                spool,
                source_fd,
                opened,
                f"{real_parent}/{name}",
                "",
                entries,
            )
            return entries
        finally:
            os.close(source_fd)
    finally:
        os.close(parent_fd)


# ---------------------------------------------------------------- 目的侧：写入


def _probe_child(dir_fd: int, name: str) -> str:
    """探测子项类型：``missing`` / ``regular`` / ``other``。

    只读、不跟随符号链接；FIFO 之类靠 ``O_NONBLOCK`` 不会阻塞。
    """
    try:
        fd = os.open(
            name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=dir_fd,
        )
    except FileNotFoundError:
        return "missing"
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM):
            return "other"
        raise
    try:
        child_stat = os.fstat(fd)
    finally:
        os.close(fd)
    return "regular" if stat.S_ISREG(child_stat.st_mode) else "other"


def _list_names(dir_fd: int) -> list[str]:
    """列出一个目录 fd 下的直接子项名。"""
    names: list[str] = []
    with os.scandir(dir_fd) as scanner:
        for item in scanner:
            names.append(item.name)
    return names


def _remove_child(dir_fd: int, name: str) -> None:
    """删掉一个子项（文件 / 符号链接 / 目录树）。

    只删**这一项本身**：符号链接删的是链接，不是它指向的东西。
    """
    try:
        os.unlink(name, dir_fd=dir_fd)
        return
    except OSError as exc:
        if exc.errno not in (errno.EISDIR, errno.EPERM, errno.EACCES):
            raise
    try:
        child_fd = os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=dir_fd,
        )
    except OSError:
        os.unlink(name, dir_fd=dir_fd)
        return
    try:
        for child_name in _list_names(child_fd):
            _remove_child(child_fd, child_name)
    finally:
        os.close(child_fd)
    os.rmdir(name, dir_fd=dir_fd)


def _copy_from_spool(out_fd: int, spool_fd: int, entry: Entry) -> None:
    """把 spool 里的一段字节写到目标 fd。"""
    os.lseek(spool_fd, entry.offset, os.SEEK_SET)
    remaining = entry.size
    while remaining > 0:
        chunk = os.read(spool_fd, min(CHUNK_SIZE, remaining))
        if not chunk:
            raise HelperError(CODE_PARTIAL, "spool_truncated")
        written = 0
        while written < len(chunk):
            written += os.write(out_fd, chunk[written:])
        remaining -= len(chunk)


def _open_child_dir(root_fd: int, rel: str) -> int:
    """按相对路径打开子目录（逐段 ``O_NOFOLLOW``）。"""
    fd = os.dup(root_fd)
    try:
        if rel:
            for part in rel.split("/"):
                next_fd = os.open(
                    part,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=fd,
                )
                os.close(fd)
                fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def _ensure_child_dir(dir_fd: int, name: str) -> int:
    """确保子项存在且是目录；类型不对的旧物先删掉再重建。"""
    try:
        return os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=dir_fd,
        )
    except FileNotFoundError:
        pass
    except OSError as exc:
        if exc.errno not in (errno.ENOTDIR, errno.ELOOP, errno.EEXIST):
            raise
        _remove_child(dir_fd, name)
    try:
        os.mkdir(name, DIR_MODE, dir_fd=dir_fd)
    except FileExistsError:
        pass
    return os.open(
        name,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        dir_fd=dir_fd,
    )


def _write_member_file(
    request: Request,
    dir_fd: int,
    name: str,
    entry: Entry,
    spool_fd: int,
) -> None:
    """写一个成员文件：类型不对的旧物先删，常规文件**原位**覆盖。"""
    status = _probe_child(dir_fd, name)
    if status == "other":
        _remove_child(dir_fd, name)
        status = "missing"
    if status == "missing":
        fd = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK,
            FILE_MODE,
            dir_fd=dir_fd,
        )
    else:
        fd = os.open(
            name,
            os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=dir_fd,
        )
    try:
        child_stat = os.fstat(fd)
        if not stat.S_ISREG(child_stat.st_mode):
            raise HelperError(CODE_PARTIAL, "target_kind_mismatch")
        os.ftruncate(fd, 0)
        _copy_from_spool(fd, spool_fd, entry)
        os.fchown(fd, request.uid, request.gid)
        os.fchmod(fd, FILE_MODE)
    finally:
        os.close(fd)


def _delete_extras(
    dir_fd: int,
    rel_prefix: str,
    dirs: dict[str, Entry],
    files: dict[str, Entry],
) -> None:
    """删掉目标里源已不存在的成员（镜像删除）。

    只在**本条托管副本内部**删；源里真实存在的空目录在 ``dirs`` 里，
    **保留目录本身**，只清掉它的内容。
    """
    for name in _list_names(dir_fd):
        rel = f"{rel_prefix}/{name}" if rel_prefix else name
        if rel in dirs:
            child_fd = os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=dir_fd,
            )
            try:
                _delete_extras(child_fd, rel, dirs, files)
            finally:
                os.close(child_fd)
            continue
        if rel in files:
            continue
        _remove_child(dir_fd, name)


def _mirror_directory(
    request: Request,
    root_fd: int,
    manifest: list[Entry],
    spool_fd: int,
) -> None:
    """把源树镜像到目标目录：保留根，递归增改删。

    顺序：**先写后删**——写入阶段失败时，删除阶段根本不会开始。
    """
    dirs: dict[str, Entry] = {}
    files: dict[str, Entry] = {}
    for entry in manifest:
        if entry.kind == KIND_DIRECTORY:
            dirs[entry.relpath] = entry
        else:
            files[entry.relpath] = entry
    # 目录：按深度从浅到深建好（浅的先建，深的自然有父目录）
    for rel in sorted(dirs, key=lambda item: (item.count("/"), item)):
        if rel == "":
            continue
        parent_rel, _, base = rel.rpartition("/")
        parent_fd = _open_child_dir(root_fd, parent_rel)
        try:
            child_fd = _ensure_child_dir(parent_fd, base)
            try:
                os.fchown(child_fd, request.uid, request.gid)
                os.fchmod(child_fd, DIR_MODE)
            finally:
                os.close(child_fd)
        finally:
            os.close(parent_fd)
    # 文件
    for rel in sorted(files):
        parent_rel, _, base = rel.rpartition("/")
        parent_fd = _open_child_dir(root_fd, parent_rel)
        try:
            _write_member_file(request, parent_fd, base, files[rel], spool_fd)
        finally:
            os.close(parent_fd)
    # 镜像删除
    _delete_extras(root_fd, "", dirs, files)


def _write_single_file(
    request: Request,
    parent_fd: int,
    name: str,
    manifest: list[Entry],
    spool_fd: int,
) -> None:
    """单文件目标：**原位覆盖**，保持挂载身份（同一 inode）。"""
    entry = manifest[0]
    try:
        probe_fd = os.open(
            name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=parent_fd,
        )
    except FileNotFoundError:
        raise HelperError(CODE_DESTINATION_UNSAFE, "target_missing") from None
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise HelperError(CODE_DESTINATION_UNSAFE, "target_symlink") from None
        raise HelperError(CODE_DESTINATION_UNSAFE, "target_unreadable") from None
    try:
        probe_stat = os.fstat(probe_fd)
    finally:
        os.close(probe_fd)
    if not stat.S_ISREG(probe_stat.st_mode):
        raise HelperError(CODE_DESTINATION_UNSAFE, "target_kind_mismatch")
    if (probe_stat.st_dev, probe_stat.st_ino) != (request.staged_dev, request.staged_ino):
        raise HelperError(CODE_DESTINATION_UNSAFE, "target_identity_mismatch")
    if probe_stat.st_nlink != 1:
        # 冒名硬链接：原位写会同时改到另一份副本
        raise HelperError(CODE_DESTINATION_UNSAFE, "target_hardlinked")
    try:
        fd = os.open(
            name,
            os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=parent_fd,
        )
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise HelperError(CODE_DESTINATION_UNSAFE, "target_symlink") from None
        raise HelperError(CODE_DESTINATION_UNSAFE, "target_unreadable") from None
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise HelperError(CODE_DESTINATION_UNSAFE, "target_kind_mismatch")
        if (opened.st_dev, opened.st_ino) != (request.staged_dev, request.staged_ino):
            raise HelperError(CODE_DESTINATION_UNSAFE, "target_identity_mismatch")
        os.ftruncate(fd, 0)
        _copy_from_spool(fd, spool_fd, entry)
        os.fchown(fd, request.uid, request.gid)
        os.fchmod(fd, FILE_MODE)
    finally:
        os.close(fd)


def _write_target(request: Request, manifest: list[Entry], spool_fd: int) -> None:
    """目的侧校验 + 写入（**只在降权后的子进程里调用**）。"""
    staged = _normalize(request.staged_path)
    if not staged.startswith("/") or staged == "/":
        raise HelperError(CODE_DESTINATION_UNSAFE, "bad_path")
    parent = os.path.dirname(staged)
    name = os.path.basename(staged)
    if not name:
        raise HelperError(CODE_DESTINATION_UNSAFE, "bad_path")
    real_parent = os.path.realpath(parent)
    try:
        parent_fd = _open_dir_chain(real_parent)
    except OSError:
        raise HelperError(CODE_DESTINATION_UNSAFE, "target_unreachable") from None
    try:
        if request.kind == KIND_FILE:
            _write_single_file(request, parent_fd, name, manifest, spool_fd)
            return
        try:
            root_fd = os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=parent_fd,
            )
        except FileNotFoundError:
            raise HelperError(CODE_DESTINATION_UNSAFE, "target_missing") from None
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                raise HelperError(CODE_DESTINATION_UNSAFE, "target_symlink") from None
            raise HelperError(CODE_DESTINATION_UNSAFE, "target_unreachable") from None
        try:
            root_stat = os.fstat(root_fd)
            if not stat.S_ISDIR(root_stat.st_mode):
                raise HelperError(CODE_DESTINATION_UNSAFE, "target_kind_mismatch")
            if (root_stat.st_dev, root_stat.st_ino) != (
                request.staged_dev,
                request.staged_ino,
            ):
                raise HelperError(CODE_DESTINATION_UNSAFE, "target_identity_mismatch")
            _mirror_directory(request, root_fd, manifest, spool_fd)
            os.fchown(root_fd, request.uid, request.gid)
            os.fchmod(root_fd, DIR_MODE)
        finally:
            os.close(root_fd)
    finally:
        os.close(parent_fd)


# ---------------------------------------------------------------- 降权与子进程


def _drop_privileges(request: Request) -> None:
    """清附加组并**不可逆**降成沙箱用户身份。

    root 进程里 ``setuid`` 会把 uid / euid / suid / fsuid 一并改成目标 uid，
    因此**再也回不到 root**——这正是要的：写入阶段全程以沙箱用户身份进行。
    """
    if os.geteuid() == 0:
        os.setgroups([])
    os.setgid(request.gid)
    os.setuid(request.uid)
    if os.getuid() != request.uid or os.getgid() != request.gid:
        raise OSError("降权未生效")
    if os.geteuid() == 0:
        raise OSError("降权未生效")


def _child_report(write_fd: int, code: str, reason: str) -> None:
    """把子进程的结果写回父进程（只传分类码与细分码，不传路径与正文）。"""
    payload = json.dumps(
        {"code": code, "reason": reason},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    try:
        os.write(write_fd, payload.encode("utf-8"))
    except OSError:
        pass


def _write_phase(request: Request, spool, manifest: list[Entry]) -> tuple[str, str]:
    """在独立子进程里降权并写入目标。

    父进程（仍是 root）负责清理暂存；子进程降权后只做「校验 + 写入」，
    **失败不回滚、不续跑**。
    """
    read_fd, write_fd = os.pipe()
    try:
        pid = os.fork()
    except OSError:
        os.close(read_fd)
        os.close(write_fd)
        return CODE_INTERNAL, "fork_failed"
    if pid == 0:  # pragma: no cover - 子进程分支
        os.close(read_fd)
        try:
            _drop_privileges(request)
        except OSError:
            _child_report(write_fd, CODE_INTERNAL, "drop_failed")
            os._exit(EXIT_BY_CODE[CODE_INTERNAL])
        try:
            _write_target(request, manifest, spool.fileno())
        except HelperError as exc:
            _child_report(write_fd, exc.code, exc.reason)
            os._exit(EXIT_BY_CODE.get(exc.code, EXIT_BY_CODE[CODE_PARTIAL]))
        except BaseException:
            _child_report(write_fd, CODE_PARTIAL, "write_failed")
            os._exit(EXIT_BY_CODE[CODE_PARTIAL])
        _child_report(write_fd, CODE_OK, "ok")
        os._exit(EXIT_BY_CODE[CODE_OK])
    os.close(write_fd)
    chunks: list[bytes] = []
    try:
        while True:
            chunk = os.read(read_fd, 4096)
            if not chunk:
                break
            chunks.append(chunk)
            if sum(len(item) for item in chunks) > 65536:
                break
    except OSError:
        pass
    finally:
        os.close(read_fd)
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
    raw = b"".join(chunks).decode("utf-8", "replace").strip()
    if not raw:
        # 子进程没来得及回报：写入阶段可能已经开始，保守按「可能部分更新」
        return CODE_PARTIAL, "child_crashed"
    try:
        payload = json.loads(raw)
    except ValueError:
        return CODE_PARTIAL, "child_crashed"
    code = payload.get("code")
    reason = payload.get("reason")
    if not isinstance(code, str) or code not in EXIT_BY_CODE:
        return CODE_PARTIAL, "child_crashed"
    return code, reason if isinstance(reason, str) else "unknown"


# ---------------------------------------------------------------- 入口


def _open_spool(spool_root: str):
    """打开平台私有的匿名暂存文件（``tempfile.TemporaryFile``）。

    **只存新内容，不是备份**：文件用完即随句柄关闭而消失，磁盘上不留名字。
    """
    try:
        os.makedirs(spool_root, mode=DIR_MODE, exist_ok=True)
        os.chmod(spool_root, DIR_MODE)
    except OSError:
        pass
    return tempfile.TemporaryFile(dir=spool_root)


def _emit(code: str, reason: str | None = None) -> int:
    """输出**唯一一行** JSON 结果并返回退出码。"""
    payload: dict[str, str] = {"code": code}
    if reason and code != CODE_OK:
        payload["reason"] = reason
    try:
        sys.stdout.write(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            + "\n"
        )
        sys.stdout.flush()
    except OSError:
        # 输出通道本身坏了也不能吐 traceback：静默失败，退出码照样是分类码
        pass
    return EXIT_BY_CODE.get(code, EXIT_BY_CODE[CODE_INTERNAL])


def main(argv: list[str]) -> int:
    """helper 入口：解析请求 → 读源 → 降权写目标 → 输出一行结果。"""
    try:
        return _run(argv)
    except BaseException:
        # 兜底：任何意外都归内部错误，**不吐 traceback**（正文与内部细节不外泄）
        return _emit(CODE_INTERNAL, "unexpected")


def _run(argv: list[str]) -> int:
    """真正的执行流程（异常在 :func:`main` 里兜底）。"""
    try:
        request = _parse_request(_read_payload(argv))
    except HelperError as exc:
        return _emit(exc.code, exc.reason)
    except Exception:
        return _emit(CODE_INTERNAL, "bad_payload")
    try:
        spool = _open_spool(request.spool_root)
    except Exception:
        return _emit(CODE_INTERNAL, "spool_failed")
    try:
        try:
            manifest = _read_source(request, spool)
        except HelperError as exc:
            return _emit(exc.code, exc.reason)
        except Exception:
            return _emit(CODE_SOURCE_UNSAFE, "unreadable")
        spool.flush()
        code, reason = _write_phase(request, spool, manifest)
    finally:
        try:
            spool.close()
        except Exception:
            pass
    return _emit(code, reason)


if __name__ == "__main__":  # pragma: no cover - 脚本入口
    sys.exit(main(sys.argv[1:]))
