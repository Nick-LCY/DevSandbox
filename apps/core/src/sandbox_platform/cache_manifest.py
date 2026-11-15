"""镜像代理缓存清单扫描器（``RegistryProxyManager`` 的邻居能力）。

统一镜像代理（``rpardini/docker-registry-proxy``）把拉过的镜像内容按 nginx
``proxy_cache`` 落盘在宿主 ``<数据根>/registry-proxy/cache``。本模块把这份
落盘事实扫描成「已完整缓存的镜像清单」：**清单只收保守口径下的完整条目**
——manifest 条目在缓存 + 该 manifest 声明的全部 blob（config + layers）在
缓存。任何失败态都只让条目落榜，绝不把不完整的东西说成已缓存。

缓存目录事实（上游 nginx 配置 + 真机双向实证）：

- 缓存键 = 原始请求 URI（``proxy_cache_key $uri``，302 重定向后键不变）；
- 文件名 = ``md5(键)``（小写 32 位 hex），``levels=1:2`` 三级布局：
  ``cache/<md5 末 1 位>/<md5 倒数第 3-2 位>/<32 位 md5 全串>``；
- 前向验证：``md5("/v2/<repo>/blobs/sha256:<digest>")`` 拼出三级路径即可判
  blob 是否在缓存（真机 ``test -f`` 命中实证）；
- 反向枚举：每个缓存文件在一段 nginx 二进制头之后存有明文 ``KEY: <键>`` 行
  （真机实测偏移约 337 字节），读文件头即可拿到 repo + 类型 + 引用，
  **无需算哈希**；tag 键的条目靠存储的上游响应头 ``docker-content-digest:``
  （小写，大小写不敏感解析）绑定到 digest；
- manifest 体 = 存储的上游响应（``\\r\\n\\r\\n`` 之后）+ JSON，直接对 JSON
  字节做 sha256 即可核对 digest（内容寻址自洽性校验）。

有效期口径（对齐真机容器内 nginx 配置，全部按条目年龄 = now − mtime 判定）：

- ``proxy_ignore_headers Cache-Control ...``：上游缓存头被忽略，有效期全部
  来自 nginx 静态规则；
- manifest 按 digest 引用（``manifests/sha256:…``）→ 60d；
- manifest 按标签引用 → 分层：``(stable|nightly|production|test)`` 前缀命中
  → 10m；标签含 ≥3 个「数字或点」字符（版本式标签，复刻 nginx 正则
  ``(\\d|\\.)+.*(\\d|\\.)+.*(\\d|\\.)+``）→ 60d；其余 → 1h；
- blob（按 digest）→ 60d；
- ``inactive=60d``：全条目 60 天未访问被回收——mtime 口径下与最长分层同值，
  不单独短于任何条目有效期。

实现纪律（对齐 ``proxy.py`` 的 ``cache_size_bytes`` / ``certificate_ready``）：

- **纯解析与特权 IO 分离**：本模块的解析、聚合、有效期判定全部是纯函数
  （零文件系统、零特权依赖），:func:`scan_snapshot` 是唯一聚合入口；
- 特权 IO 只做三件事：目录枚举、文件头批量读、manifest 体批量读。先走
  直读，``PermissionError`` 回退既有特权通道（``Privilege.wrap``，非 root
  即 ``sudo -n``），批量协议一次读完全部文件（避免逐文件 sudo 抖动），
  每条宿主命令 **30 秒超时封顶**；
- 脏条目（非 32 位 hex 文件名、``KEY:`` 缺失/不可解析、清单体损坏、digest
  自洽性不通过、blob 不全、条目过期）一律**跳过、不报错**，只影响条目数；
- 整场失败（枚举 / 批量读命令失败或超时）抛 :class:`CacheScanError`，
  由调用方决定降级形态（服务端将映射成 503，不静默回空清单）。

边界（刻意不做）：本模块**无任何 GC 入口**（GC 是后续独立轮次的活，将来
直接复用这里的纯解析底座）；不含命令行解析与输出（分层契约测试盯防）。
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .command import run
from .config import PlatformConfig
from .errors import CacheScanError, CommandError
from .userspace import Privilege

logger = logging.getLogger(__name__)

# 单条宿主命令的超时封顶（对齐 proxy.CACHE_SIZE_TIMEOUT 的纪律）
SCAN_COMMAND_TIMEOUT = 30
# 文件头读取量：真机实测 ``KEY:`` 行偏移约 337 字节，1024 字节留足余量
HEAD_BYTES = 1024
# manifest 体单文件读取上限：真实 index/manifest 只有几 KB，256KiB 是宽裕的
# 脏数据护栏（blob 文件可能几百 MB，绝不整读，只读头）
MANIFEST_BODY_MAX_BYTES = 256 * 1024
# 批量读协议的记录起始标记（冷门字符串 + 定长路径，按期望序逐个搜索定位）
HEAD_MARKER = "@SANDBOX-CACHE-HEAD@"

# 一天的秒数（有效期口径里的「d」）
_DAY = 24 * 3600
# blob 与 manifest 按 digest 引用的有效期（nginx 全局 200/206 60d）
TTL_BY_DIGEST = 60 * _DAY
# manifest 标签分层：primary 标签 10m、版本式标签 60d、其余 1h
# （真机 nginx.manifest.caching.config.conf 的三段 location）
TTL_MANIFEST_PRIMARY = 10 * 60
TTL_MANIFEST_DEFAULT = 3600
# nginx inactive=60d：mtime 口径下与最长分层同值，不构成更短的有效期
INACTIVE_TTL = 60 * _DAY

# primary 标签前缀（真机 nginx：location ~ ^/v2/(.*)/manifests/(stable|...)）
PRIMARY_TAG_PREFIXES = ("stable", "nightly", "production", "test")
# digest 形态：sha256 + 64 位小写 hex
_DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}")
# 标签字符集（distribution spec：[A-Za-z0-9_][A-Za-z0-9._-]{0,127}）
_TAG_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]{0,127}")
# 缓存键（原始请求 URI）的骨架：/v2/<repo>/(blobs|manifests)/<ref>
# repo 贪婪回溯语义与 nginx ``^/v2/(.*)/manifests/`` 一致
_KEY_URI_RE = re.compile(
    r"/v2/(?P<repo>[a-z0-9._-]+(?:/[a-z0-9._-]+)*)/(?P<kind>blobs|manifests)/(?P<ref>.+)"
)
# 缓存文件头里的 KEY: 明文行（前面是 nginx 二进制头 + 换行，按行锚定匹配）
_KEY_LINE_RE = re.compile(rb"^KEY: (/v2/[^\r\n]+)$", re.MULTILINE)
# 存储响应头里的 digest 绑定（上游头是小写、CRLF 结尾，大小写不敏感）
_HEADER_DIGEST_RE = re.compile(
    rb"^docker-content-digest:[ \t]*(sha256:[0-9a-f]{64})[ \t]*\r?$",
    re.IGNORECASE | re.MULTILINE,
)

MANIFEST_KIND_BLOBS = "blobs"
MANIFEST_KIND_MANIFESTS = "manifests"

_INDEX_PLATFORM_OS = "linux"
_INDEX_PLATFORM_ARCH = "amd64"


# ---------------------------------------------------------------- 纯解析：布局公式
def cache_filename(key: str) -> str:
    """缓存键 → 缓存文件名：``md5(键)`` 的小写 32 位 hex。"""
    return hashlib.md5(key.encode("utf-8")).hexdigest()  # noqa: S324 - nginx 同源算法


def cache_file_relpath(key: str) -> str:
    """缓存键 → 相对缓存目录的三级路径（nginx ``levels=1:2``）。

    ``cache/<md5 末 1 位>/<md5 倒数第 3-2 位>/<32 位 md5 全串>``。
    """
    digest = cache_filename(key)
    return f"{digest[-1]}/{digest[-3:-1]}/{digest}"


def is_sha256_digest(value: str) -> bool:
    """是否为合法的 ``sha256:<64 位小写 hex>`` 摘要。"""
    return _DIGEST_RE.fullmatch(value) is not None


def is_valid_tag(value: str) -> bool:
    """是否为合法的 registry 标签。"""
    return _TAG_RE.fullmatch(value) is not None


def blob_forward_relpath(repo: str, digest: str) -> str:
    """blob 的前向验证路径。

    ``md5("/v2/<repo>/blobs/<digest>")`` 拼三级布局——不依赖反向枚举即可判
    定某个 blob 是否在缓存（真机 ``test -f`` 双向命中实证）。
    """
    return cache_file_relpath(f"/v2/{repo}/blobs/{digest}")


# ---------------------------------------------------------------- 纯解析：KEY: 头
@dataclass(frozen=True)
class CacheKeyRef:
    """一条 ``KEY:`` 头解析出的缓存键引用。

    ``kind`` 是 ``blobs`` / ``manifests``；digest 与 tag 二者必居其一：
    digest 形态（``sha256:…``）填 ``digest``，标签形态填 ``tag``。
    """

    repo: str
    kind: str
    digest: str | None = None
    tag: str | None = None

    @property
    def is_by_digest(self) -> bool:
        """是否按 digest 引用（决定 manifest 的有效期分层）。"""
        return self.digest is not None


def parse_key_head(head: bytes) -> CacheKeyRef | None:
    """从缓存文件头字节里解析 ``KEY:`` 行。

    头部前面是 nginx 二进制结构，因此按行锚定搜索 ``^KEY: …``。解析不出、
    引用形态非法（digest 不是 64 位 hex、标签字符集越界、仓库路径非法）一律
    返回 ``None``——调用方按脏条目跳过，不报错。
    """
    match = _KEY_LINE_RE.search(head)
    if match is None:
        return None
    return parse_cache_key(match.group(1).decode("ascii", errors="replace"))


def parse_cache_key(key: str) -> CacheKeyRef | None:
    """解析缓存键（原始请求 URI）→ 结构化引用。

    合法形态::

        /v2/<repo>/blobs/sha256:<64hex>       # blob（只认 sha256 hex）
        /v2/<repo>/manifests/sha256:<64hex>   # manifest 按 digest
        /v2/<repo>/manifests/<tag>            # manifest 按标签

    其余形态（其它摘要算法的 blob、越界标签、带查询串等）返回 ``None``。
    """
    match = _KEY_URI_RE.fullmatch(key)
    if match is None:
        return None
    repo = match.group("repo")
    kind = match.group("kind")
    ref = match.group("ref")
    if kind == MANIFEST_KIND_BLOBS:
        if not is_sha256_digest(ref):
            return None
        return CacheKeyRef(repo=repo, kind=kind, digest=ref)
    if kind == MANIFEST_KIND_MANIFESTS:
        if ref.startswith("sha256:"):
            if not is_sha256_digest(ref):
                return None
            return CacheKeyRef(repo=repo, kind=kind, digest=ref)
        if not is_valid_tag(ref):
            return None
        return CacheKeyRef(repo=repo, kind=kind, tag=ref)
    return None


# ---------------------------------------------------------------- 纯解析：manifest 体
@dataclass(frozen=True)
class ManifestShape:
    """一个 manifest/index 文档解析出的结构。

    ``kind`` 为 ``index``（多架构）时只有 ``amd64_digest`` 有值——平台
    manifest 的 digest；``kind`` 为 ``image``（单架构）时是 config 与
    layers 的 blob 清单。解析不到 amd64 / blob 声明不全时整个文档不可用
    （调用方让条目落榜）。
    """

    kind: str
    amd64_digest: str | None = None
    config_digest: str | None = None
    layer_digests: tuple[str, ...] = ()

    @property
    def blob_digests(self) -> tuple[str, ...]:
        """该 manifest 声明的全部 blob（config + layers，去重保序）。"""
        if self.config_digest is None:
            return ()
        seen: dict[str, None] = {}
        for item in (self.config_digest, *self.layer_digests):
            seen.setdefault(item, None)
        return tuple(seen)


def extract_json_document(content: bytes) -> tuple[dict, bytes] | None:
    """从缓存文件字节里截出 JSON 文档（响应头与二进制头在它前面）。

    对每个 ``{`` 逐个尝试 ``raw_decode``（容忍尾部多余字节），第一个能解析
    出对象的起点胜出：nginx 二进制头里偶发 ``0x7B`` 字节（真机 python
    manifest 条目实证），单靠「第一个花括号」会误判；解析不出返回 ``None``。
    用 latin-1 解码是为了字节透明（1 字符 = 1 字节）：截出的 ``bytes`` 与
    文件里的 JSON 字节逐字节一致，可直接拿去做 sha256 自洽性校验；结构化
    字段（digest、平台名）都是 ASCII，不受影响。二进制头里若真撞出一个
    「能解析的对象」，下游 digest 自洽性校验也必然拦下（sha256 对不上）。
    """
    text = content.decode("latin-1")
    decoder = json.JSONDecoder()
    start = text.find("{")
    while start >= 0:
        try:
            obj, end = decoder.raw_decode(text, start)
        except ValueError:
            start = text.find("{", start + 1)
            continue
        if isinstance(obj, dict):
            return obj, content[start : start + (end - start)]
        start = text.find("{", start + 1)
    return None


def classify_manifest_document(doc: dict) -> ManifestShape | None:
    """把 manifest/index JSON 文档分类并提取结构。

    - 多架构 index（有 ``manifests`` 数组，docker manifest list 与 OCI
      index 同构）：解析到 ``linux/amd64`` 平台的 manifest digest；没有
      amd64 描述项 → ``None``（整条落榜）；
    - 单架构 manifest：取 config + layers 的 blob digest 清单，声明不全
      或 digest 形态非法 → ``None``。
    """
    manifests = doc.get("manifests")
    if isinstance(manifests, list):
        return _classify_index(manifests)
    config = doc.get("config")
    layers = doc.get("layers")
    if not isinstance(config, dict) or not isinstance(layers, list):
        return None
    config_digest = config.get("digest")
    if not isinstance(config_digest, str) or not is_sha256_digest(config_digest):
        return None
    layer_digests = []
    for layer in layers:
        if not isinstance(layer, dict):
            return None
        digest = layer.get("digest")
        if not isinstance(digest, str) or not is_sha256_digest(digest):
            return None
        layer_digests.append(digest)
    return ManifestShape(
        kind="image",
        config_digest=config_digest,
        layer_digests=tuple(layer_digests),
    )


def _classify_index(entries: list) -> ManifestShape | None:
    """多架构 index → linux/amd64 平台 manifest 的 digest。"""
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        digest = entry.get("digest")
        if not isinstance(digest, str) or not is_sha256_digest(digest):
            continue
        platform = entry.get("platform")
        if not isinstance(platform, dict):
            continue
        if (
            platform.get("os") == _INDEX_PLATFORM_OS
            and platform.get("architecture") == _INDEX_PLATFORM_ARCH
        ):
            return ManifestShape(kind="index", amd64_digest=digest)
    return None


def verify_manifest_bytes(json_bytes: bytes, digest: str) -> bool:
    """manifest 的内容寻址自洽性：JSON 字节的 sha256 应等于 digest。

    这一条把「缓存文件确实是对应 digest 的那份 manifest」钉死：KEY 行、
    响应头与 JSON 体三者互相印证，任一被篡改都过不了。
    """
    if not is_sha256_digest(digest):
        return False
    actual = f"sha256:{hashlib.sha256(json_bytes).hexdigest()}"
    return actual == digest


def extract_header_digest(content: bytes) -> str | None:
    """从存储的上游响应头里取 ``docker-content-digest:`` 绑定值。

    tag 键条目绑定 tag → digest 的唯一来源（真机响应头为小写，按大小写
    不敏感解析）。按行锚定在全内容上搜索：JSON 体里不会出现「整行恰好是
    这个头形态」的行（JSON 键行带引号前缀），二进制头的花括号字节也无碍。
    找不到返回 ``None``。
    """
    match = _HEADER_DIGEST_RE.search(content)
    if match is None:
        return None
    return match.group(1).decode("ascii")


# ---------------------------------------------------------------- 纯解析：有效期分层
def manifest_ttl_seconds(ref: CacheKeyRef) -> int:
    """manifest 条目的有效期（秒），按引用形态分层（对齐真机 nginx 规则）。

    - 按 digest 引用 → 60d（nginx 全局 ``proxy_cache_valid 200 206 60d``）；
    - 按标签引用 → primary 前缀（stable/nightly/production/test）10m；
      版本式标签（含 ≥3 个「数字或点」字符）60d；其余 1h。

    版本式判定复刻 nginx 正则
    ``((\\d|\\.)+.*)(\\d|\\.)+.*((\\d|\\.)+)``：三条可留任意间隙的「数字/点」
    串存在 ⟺ 标签里「数字或点」字符 ≥ 3。
    """
    if ref.digest is not None:
        return TTL_BY_DIGEST
    tag = ref.tag or ""
    if tag.startswith(PRIMARY_TAG_PREFIXES):
        return TTL_MANIFEST_PRIMARY
    if sum(1 for ch in tag if ch.isdigit() or ch == ".") >= 3:
        return TTL_BY_DIGEST
    return TTL_MANIFEST_DEFAULT


def blob_ttl_seconds() -> int:
    """blob 条目的有效期（秒）：60d。"""
    return TTL_BY_DIGEST


# ---------------------------------------------------------------- 纯解析：条目聚合
@dataclass(frozen=True)
class CacheFileInfo:
    """枚举到的一个缓存文件（特权枚举的产物）。"""

    relpath: str
    size: int
    mtime: float


@dataclass(frozen=True)
class ManifestRecord:
    """一条可用的 manifest 缓存条目（纯解析阶段的产物）。

    ``digest`` 是该 manifest 的内容摘要：digest 键条目来自 KEY 行，
    tag 键条目来自响应头的 ``docker-content-digest`` 绑定；两者的 JSON
    字节都已通过 sha256 自洽性校验。
    """

    ref: CacheKeyRef
    digest: str
    relpath: str
    size: int
    mtime: float
    shape: ManifestShape


@dataclass(frozen=True)
class CachedImage:
    """清单里的一条已完整缓存镜像。

    ``digest`` 是顶层摘要（多架构即 index 摘要、单架构即 manifest 摘要），
    与标签解析、digest 直拉的缓存键一致；``total_size_bytes`` 是完整缓存链
    中各文件的实际字节数之和（顶层 manifest + 多架构时的平台 manifest +
    config + layers，按内容摘要去重）；``cached_at`` 是参与条目的 manifest
    缓存文件里最新的 mtime（ISO 8601 UTC）。
    """

    repo: str
    tags: tuple[str, ...]
    digest: str
    total_size_bytes: int
    cached_at: str


@dataclass(frozen=True)
class CacheScanResult:
    """一次扫描的完整结果。

    ``total_files`` 是枚举到的合法缓存文件数；``blob_files`` 是其中识别为
    blob 的条目数；``skipped_files`` 是脏条目数（文件名不合法、``KEY:``
    缺失/不可解析、清单体损坏、digest 自洽性不通过）——跳过只影响条目数、
    不报错。
    """

    generated_at: str
    images: tuple[CachedImage, ...]
    total_files: int
    blob_files: int
    skipped_files: int

    def to_payload(self) -> dict:
        """JSON 友好的载荷（服务端端点直接可用）。"""
        return {
            "generated_at": self.generated_at,
            "images": [
                {
                    "repo": image.repo,
                    "tags": list(image.tags),
                    "digest": image.digest,
                    "total_size_bytes": image.total_size_bytes,
                    "cached_at": image.cached_at,
                }
                for image in self.images
            ],
            "total_files": self.total_files,
            "blob_files": self.blob_files,
            "skipped_files": self.skipped_files,
        }


def scan_manifest_records(
    files: dict[str, CacheFileInfo],
    heads: dict[str, bytes],
    bodies: dict[str, bytes],
) -> tuple[tuple[ManifestRecord, ...], int, int]:
    """纯解析阶段：文件清单 + 头字节 + manifest 体字节 → 可用记录与计数。

    返回 ``(records, blob_files, skipped_files)``。blob 只靠头识别（存在性
    校验走前向公式，不需要 blob 的头之外的信息）；manifest 需要 JSON 体：
    解析、digest 绑定、自洽性校验、结构分类任何一步失败都按脏条目跳过。
    """
    blob_files = 0
    skipped = 0
    records: list[ManifestRecord] = []
    for relpath, head in sorted(heads.items()):
        ref = parse_key_head(head)
        if ref is None:
            skipped += 1
            continue
        if ref.kind == MANIFEST_KIND_BLOBS:
            blob_files += 1
            continue
        body = bodies.get(relpath)
        extracted = extract_json_document(body) if body is not None else None
        if extracted is None:
            skipped += 1
            continue
        doc, json_bytes = extracted
        digest = ref.digest or extract_header_digest(body)
        if digest is None or not verify_manifest_bytes(json_bytes, digest):
            skipped += 1
            continue
        shape = classify_manifest_document(doc)
        if shape is None:
            skipped += 1
            continue
        info = files.get(relpath)
        if info is None:
            skipped += 1
            continue
        records.append(
            ManifestRecord(
                ref=ref,
                digest=digest,
                relpath=relpath,
                size=info.size,
                mtime=info.mtime,
                shape=shape,
            )
        )
    return tuple(records), blob_files, skipped


def assemble_images(
    records: tuple[ManifestRecord, ...],
    files: dict[str, CacheFileInfo],
    now: float,
) -> tuple[CachedImage, ...]:
    """纯聚合阶段：manifest 记录 + 文件清单 → 已完整缓存的镜像条目。

    同仓库多标签指向同一 digest 归并为一条（标签列表聚合，只收未过期的
    标签绑定）；digest 直拉的条目标签列表为空。完整链任一环缺失或过期
    （manifest 分层 10m/1h/60d、blob 60d）→ 整条落榜，不报错。
    """
    groups: dict[tuple[str, str], list[ManifestRecord]] = {}
    for record in records:
        groups.setdefault((record.ref.repo, record.digest), []).append(record)

    images: list[CachedImage] = []
    for (repo, digest), group in sorted(groups.items()):
        alive = [r for r in group if now - r.mtime <= manifest_ttl_seconds(r.ref)]
        if not alive:
            continue
        # digest 键的记录优先做锚（它本身就是内容寻址的一致性来源），路径
        # 排序兜底保证确定性
        alive.sort(key=lambda r: (0 if r.ref.is_by_digest else 1, r.relpath))
        anchor = alive[0]

        chain_sizes: dict[str, int] = {digest: anchor.size}
        blob_digests: tuple[str, ...] = ()
        if anchor.shape.kind == "index":
            child = _resolve_amd64_child(groups, repo, anchor.shape.amd64_digest, now)
            if child is None:
                continue
            chain_sizes[child.digest] = child.size
            blob_digests = child.shape.blob_digests
        else:
            blob_digests = anchor.shape.blob_digests

        total = sum(chain_sizes.values())
        complete = True
        for blob_digest in blob_digests:
            info = files.get(blob_forward_relpath(repo, blob_digest))
            if info is None or now - info.mtime > blob_ttl_seconds():
                complete = False
                break
            total += info.size
        if not complete:
            continue

        tags = sorted({r.ref.tag for r in alive if r.ref.tag is not None})
        cached_at = _format_utc(max(r.mtime for r in alive))
        images.append(
            CachedImage(
                repo=repo,
                tags=tuple(tags),
                digest=digest,
                total_size_bytes=total,
                cached_at=cached_at,
            )
        )
    return tuple(images)


def _resolve_amd64_child(
    groups: dict[tuple[str, str], list[ManifestRecord]],
    repo: str,
    child_digest: str | None,
    now: float,
) -> ManifestRecord | None:
    """在缓存里找 index 声明的 linux/amd64 平台 manifest（须是单架构体）。"""
    if child_digest is None:
        return None
    child_group = groups.get((repo, child_digest))
    if not child_group:
        return None
    for child in child_group:
        if child.shape.kind != "image":
            continue
        if now - child.mtime <= manifest_ttl_seconds(child.ref):
            return child
    return None


def scan_snapshot(
    files: dict[str, CacheFileInfo],
    heads: dict[str, bytes],
    bodies: dict[str, bytes],
    now: float,
    skipped_names: int = 0,
) -> CacheScanResult:
    """纯聚合入口：特权 IO 的三份产物 → 完整扫描结果。

    ``files`` 是枚举到的合法缓存文件（键为相对路径）；``heads`` 是文件头
    字节（键同上）；``bodies`` 是 manifest 条目的完整字节。三者由 IO 层
    产出，本函数零文件系统、零特权依赖。
    """
    records, blob_files, skipped = scan_manifest_records(files, heads, bodies)
    images = assemble_images(records, files, now)
    return CacheScanResult(
        generated_at=_format_utc(now),
        images=images,
        total_files=len(files),
        blob_files=blob_files,
        skipped_files=skipped_names + skipped,
    )


def _format_utc(epoch: float) -> str:
    """epoch 秒 → ISO 8601 UTC 文本（秒精度）。"""
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- 特权 IO
# 批量读协议：cd 到缓存目录后逐文件输出「标记行 + 头字节的 base64 单行 + 换行」。
# 用 base64 包一层是因为缓存文件头是二进制（含 0xFF 等非 UTF-8 字节），而宿主
# 命令封装按文本收集输出：裸二进制会解码失败、换行翻译还会破坏 JSON 字节的
# sha256 自洽校验；base64 后纯 ASCII、无回车，文本通道安全。一次 sudo 跑完
# 整个目录，避免逐文件 sudo 抖动。解析端按期望的标记序列逐个搜索定位
# （引导式解析），标记串撞上文件内容的概率被期望路径 + base64 合法性双重钉死。
_BATCH_READ_SCRIPT = (
    'cd "$1" || exit 9\n'
    "find . -type f | LC_ALL=C sort | while IFS= read -r p; do\n"
    f'    printf \'{HEAD_MARKER}%s\\n\' "${{p#./}}"\n'
    '    head -c "$2" -- "$p" 2>/dev/null | base64 -w 0\n'
    "    printf '\\n'\n"
    "done\n"
)


class RegistryCacheScanner:
    """镜像代理缓存目录的扫描器（``RegistryProxyManager`` 的邻居能力）。

    用法::

        scanner = RegistryCacheScanner(config)
        result = scanner.scan()

    失败语义：整场失败（枚举 / 批量读失败或超时）抛 :class:`CacheScanError`；
    脏条目只让条目落榜（见 :attr:`CacheScanResult.skipped_files`）。
    """

    def __init__(
        self,
        config: PlatformConfig | None = None,
        privilege: Privilege | None = None,
    ) -> None:
        self.config = config or PlatformConfig.from_env()
        self.privilege = privilege or Privilege()

    @property
    def cache_dir(self) -> Path:
        """代理缓存目录（``<数据根>/registry-proxy/cache``）。"""
        return self.config.proxy_cache_dir

    def scan(self, now: float | None = None) -> CacheScanResult:
        """扫描缓存目录，产出已完整缓存的镜像清单。

        特权 IO 分三步、每步尽量一次批量完成，宿主命令 30 秒超时封顶：
        ① 枚举文件（直读失败回退特权 ``find``）；② 全量文件头批量读；
        ③ manifest 体批量读（由头部解析出的 manifest 条目清单驱动）。
        """
        if now is None:
            now = time.time()
        files, skipped_names = self._enumerate_cache_files()
        heads = self._read_file_heads(sorted(files)) if files else {}
        manifest_relpaths = [
            relpath
            for relpath, head in sorted(heads.items())
            if _head_is_manifest(head)
        ]
        bodies = (
            self._read_manifest_bodies(manifest_relpaths) if manifest_relpaths else {}
        )
        # 头对账：枚举到但头没读到（直读消失 / 中途 OSError 脏跳、特权路缺
        # 标记）→ 统一按「消失的文件计 skipped」入账，与特权路空 base64
        # （头解析失败跳过）口径对称——两路统计口径一致。体缺失无需对账：
        # 两路的缺失体都会被 scan_manifest_records 按「manifest 无体」跳过。
        skipped_names += len(files) - len(heads)
        result = scan_snapshot(files, heads, bodies, now, skipped_names)
        logger.info(
            "镜像缓存扫描完成：%d 个文件（blob %d、脏条目 %d），清单 %d 条",
            result.total_files,
            result.blob_files,
            result.skipped_files,
            len(result.images),
        )
        return result

    # ---------------------------------------------------------------- 枚举
    def _enumerate_cache_files(self) -> tuple[dict[str, CacheFileInfo], int]:
        """枚举缓存文件 → ``(文件表, 脏文件名数)``。

        目录确实不存在（``ENOENT``）返回空表（对齐 ``cache_size_bytes`` 的
        「不存在按 0 计」）；目录存在但探测受阻（如上级目录 0700 不可穿越的
        ``EACCES``）绝不吞成「不存在」——一律落入下方直读 → 特权回退链
        （与 ``_enumerate_direct`` 的 ``OSError`` 处理对齐），否则特权回退
        永不触发，踩「空清单比失败更糟」红线。叶子目录属主是容器内 nginx
        用户映射（0700），服务用户直读必败：先试直读，``PermissionError``
        回退特权 ``find``。非 32 位 hex 文件名（临时 / 半截文件）按脏条目
        跳过、计数、不报错。
        """
        cache_dir = self.cache_dir
        try:
            cache_dir.stat()
        except FileNotFoundError:
            # 只认 stat 的 ENOENT 为「目录不存在」。不能用 is_dir() /
            # exists() 区分：两者对 EACCES 的形态随版本漂移——要么吞成
            # False（静默空清单），要么把 PermissionError 裸抛出 scan()
            # （500）——两个形态都绕开了特权回退链。
            return {}, 0
        except OSError as exc:
            logger.info("缓存目录探测受阻（%s），转入直读 → 特权回退链", exc)
        try:
            return self._enumerate_direct(cache_dir)
        except (PermissionError, OSError) as exc:
            logger.info("缓存目录直读失败，回退特权枚举：%s", exc)
        try:
            return self._enumerate_privileged(cache_dir)
        except CommandError as exc:
            raise CacheScanError(f"枚举镜像缓存目录失败：{exc}") from exc

    def _enumerate_direct(self, cache_dir: Path) -> tuple[dict[str, CacheFileInfo], int]:
        """直读枚举（root 或目录可读时零特权）。键为三级相对路径。"""
        found: dict[str, CacheFileInfo] = {}
        skipped = 0
        for level1 in sorted(os.scandir(cache_dir), key=lambda e: e.name):
            if not level1.is_dir(follow_symlinks=False):
                continue
            for level2 in sorted(os.scandir(level1.path), key=lambda e: e.name):
                if not level2.is_dir(follow_symlinks=False):
                    continue
                for entry in sorted(os.scandir(level2.path), key=lambda e: e.name):
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    stat = entry.stat(follow_symlinks=False)
                    if not _is_cache_filename(entry.name):
                        skipped += 1
                        continue
                    relpath = f"{level1.name}/{level2.name}/{entry.name}"
                    found[relpath] = CacheFileInfo(
                        relpath=relpath,
                        size=stat.st_size,
                        mtime=stat.st_mtime,
                    )
        return found, skipped

    def _enumerate_privileged(
        self, cache_dir: Path
    ) -> tuple[dict[str, CacheFileInfo], int]:
        """特权枚举：一条 ``find -printf`` 拿到全部文件的路径 + 大小 + mtime。

        ``%P`` 输出相对缓存目录的三级路径；单行格式非法按脏条目跳过，
        命令本身失败才算整场失败。
        """
        result = run(
            self.privilege.wrap(
                ["find", str(cache_dir), "-type", "f", "-printf", "%P\t%s\t%T@\n"]
            ),
            check=False,
            timeout=SCAN_COMMAND_TIMEOUT,
        )
        if not result.ok:
            raise CommandError(
                result.argv, result.returncode, result.stdout, result.stderr
            )
        found: dict[str, CacheFileInfo] = {}
        skipped = 0
        for line in result.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) != 3:
                skipped += 1
                continue
            relpath, size_text, mtime_text = parts
            name = relpath.rsplit("/", 1)[-1]
            try:
                size = int(size_text)
                mtime = float(mtime_text)
            except ValueError:
                skipped += 1
                continue
            if not _is_cache_filename(name):
                skipped += 1
                continue
            found[relpath] = CacheFileInfo(relpath=relpath, size=size, mtime=mtime)
        return found, skipped

    # ---------------------------------------------------------------- 批量读
    def _read_file_heads(self, relpaths: list[str]) -> dict[str, bytes]:
        """全量文件头批量读（``KEY:`` 行解析的输入）。"""
        return self._read_batch(relpaths, HEAD_BYTES)

    def _read_manifest_bodies(self, relpaths: list[str]) -> dict[str, bytes]:
        """manifest 体批量读（只读头解析出的 manifest 条目，绝不碰 blob）。"""
        return self._read_batch(relpaths, MANIFEST_BODY_MAX_BYTES)

    def _read_batch(self, relpaths: list[str], limit: int) -> dict[str, bytes]:
        """一次批量读多个缓存文件的前 ``limit`` 字节。

        先试直读（root / 文件可读时零特权）；任何一个文件 ``PermissionError``
        即整批转特权通道（缓存文件权限同构，逐文件试探没有意义）。文件在
        读取间隙消失（``FileNotFoundError``）或读取中途 ``OSError``（EIO、
        枚举后被替换成目录的竞态等）按脏条目口径跳过：不入账，由
        :meth:`scan` 的头对账统一计入 ``skipped_files``，与特权路「空
        base64 → 头解析失败跳过」的统计口径对称。
        """
        if not relpaths:
            return {}
        try:
            return self._read_direct(relpaths, limit)
        except PermissionError as exc:
            logger.info("缓存文件直读失败，回退特权批量读：%s", exc)
        try:
            return self._read_privileged(relpaths, limit)
        except CommandError as exc:
            raise CacheScanError(f"批量读取缓存文件失败：{exc}") from exc

    def _read_direct(self, relpaths: list[str], limit: int) -> dict[str, bytes]:
        """直读批量（零特权）。

        单文件 ``PermissionError`` 原样上抛（由 :meth:`_read_batch` 整批转
        特权通道裁决）；其余 ``OSError``——文件消失（``FileNotFoundError``）、
        读取中途 ``EIO``、枚举后被替换成目录的竞态（``IsADirectoryError``）
        ——一律就地按脏条目跳过：不入账（文件不进 ``chunks``），由
        :meth:`scan` 头对账计入 ``skipped_files``，绝不裸穿 ``scan()``
        破坏 ``CacheScanError`` → 503 的错误语义。
        """
        chunks: dict[str, bytes] = {}
        for relpath in relpaths:
            path = self.cache_dir / relpath
            try:
                with path.open("rb") as handle:
                    chunks[relpath] = handle.read(limit)
            except PermissionError:
                # 权限问题绝不就地吞：整批转特权通道（_read_batch 裁决）
                raise
            except OSError:
                # 消失 / EIO / 竞态替换：按脏条目跳过（不入账 → scan 对账）
                continue
        return chunks

    def _read_privileged(self, relpaths: list[str], limit: int) -> dict[str, bytes]:
        """特权批量读：一条 ``sh -c`` 脚本跑完全部文件（标记协议见模块头）。"""
        result = run(
            self.privilege.wrap(
                [
                    "sh",
                    "-c",
                    _BATCH_READ_SCRIPT,
                    "sandbox-cache-batch-read",
                    str(self.cache_dir),
                    str(limit),
                ]
            ),
            check=False,
            timeout=SCAN_COMMAND_TIMEOUT,
        )
        if not result.ok:
            raise CommandError(
                result.argv, result.returncode, result.stdout, result.stderr
            )
        return _parse_batch_output(result.stdout, relpaths, limit)


def _is_cache_filename(name: str) -> bool:
    """缓存文件名是否合法：32 位小写 hex（临时 / 半截文件不是）。"""
    return len(name) == 32 and all(ch in "0123456789abcdef" for ch in name)


def _head_is_manifest(head: bytes) -> bool:
    """文件头是否属于 manifest 条目（决定要不要读完整内容）。"""
    ref = parse_key_head(head)
    return ref is not None and ref.kind == MANIFEST_KIND_MANIFESTS


def _parse_batch_output(
    output: str, relpaths: list[str], limit: int
) -> dict[str, bytes]:
    """解析批量读脚本的文本输出（引导式解析，纯函数）。

    脚本按 ``LC_ALL=C sort`` 的顺序逐文件输出「标记行 + base64 单行 + 换行」，
    解析端按期望路径的同一顺序逐个搜索标记；数据段终止于**下一个任意标记
    行**（枚举差异产生的非期望文件也在内），保证载荷不会吞进后续记录。标记
    串即使撞上文件内容也只会让对应文件的 base64 解码失败（按脏条目跳过），
    不会把 A 文件的字节算到 B 头上。某文件未产出标记（读取间隙消失等）→
    跳过；解码后超过 ``limit``（协议错位）→ 跳过。
    """
    ordered = sorted(relpaths, key=lambda item: item.encode("utf-8"))
    # 全部标记行的（起点，数据段起点）——包括非期望文件的
    marker_starts: list[tuple[int, int]] = []
    scan_pos = 0
    while True:
        idx = output.find(HEAD_MARKER, scan_pos)
        if idx < 0:
            break
        line_end = output.find("\n", idx)
        if line_end < 0:
            break
        marker_starts.append((idx, line_end + 1))
        scan_pos = line_end + 1

    chunks: dict[str, bytes] = {}
    cursor = 0
    for path in ordered:
        marker = f"{HEAD_MARKER}{path}\n"
        idx = output.find(marker, cursor)
        if idx < 0:
            continue  # 该文件未产出头部（读取间隙消失等）
        data_start = idx + len(marker)
        end = len(output)
        for start, data in marker_starts:
            if start >= data_start:
                end = start
                break
        line = output[data_start:end]
        if line.endswith("\n"):
            line = line[:-1]
        try:
            data = base64.b64decode(line, validate=True)
        except ValueError:
            continue  # 协议错位 / 标记撞车：按脏条目跳过
        if len(data) <= limit:
            chunks[path] = data
        cursor = data_start
    return chunks
