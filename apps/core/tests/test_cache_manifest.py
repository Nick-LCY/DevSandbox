"""镜像缓存清单扫描器的单元测试。

纯解析函数全覆盖（零文件系统、零特权依赖）+ 特权路径走可注入伪通道
（本地代跑、剥离 sudo 前缀、可注入失败 / 超时），root / 非 root 两档
行为一致。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from sandbox_platform import (
    CacheScanError,
    CommandError,
    PlatformConfig,
)
from sandbox_platform.cache_manifest import (
    HEAD_BYTES,
    HEAD_MARKER,
    MANIFEST_BODY_MAX_BYTES,
    CacheFileInfo,
    ManifestShape,
    RegistryCacheScanner,
    _parse_batch_output,
    assemble_images,
    blob_forward_relpath,
    blob_ttl_seconds,
    cache_file_relpath,
    classify_manifest_document,
    extract_header_digest,
    extract_json_document,
    manifest_ttl_seconds,
    parse_cache_key,
    parse_key_head,
    scan_manifest_records,
    scan_snapshot,
    verify_manifest_bytes,
)
from sandbox_platform.command import CommandResult
from sandbox_platform.userspace import Privilege

NOW = 1_800_000_000.0  # 2027-01-15 08:00:00 UTC
# 二进制噪声以换行收尾：真机形态是「二进制头 + \n + KEY: 行」；噪声里带
# ``0x7B``（{）字节——真机 python manifest 条目实证，回归「花括号在二进制头」
# 的误判路径
BINARY_NOISE = (
    b"\x05\x00\x00\x00" + b"\xff" * 8 + b"\x1c{\x00" + b"\x00" * 295 + b"\n"
)
DAY = 24 * 3600


# ---------------------------------------------------------------- 小工具
def _dg(seed: str) -> str:
    """确定性生成一个合法摘要（sha256:<64hex>）。"""
    return "sha256:" + hashlib.sha256(seed.encode()).hexdigest()


def _index_doc(amd64_digest: str, extra_entries: list | None = None) -> dict:
    """多架构 index 文档（OCI index 与 docker manifest list 同构）。"""
    entries = [
        {
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": amd64_digest,
            "platform": {"os": "linux", "architecture": "amd64"},
        }
    ]
    if extra_entries:
        entries.extend(extra_entries)
    return {"schemaVersion": 2, "manifests": entries}


def _image_doc(config_digest: str, layer_digests: list[str]) -> dict:
    """单架构 manifest 文档（config + layers）。"""
    return {
        "schemaVersion": 2,
        "config": {
            "mediaType": "application/vnd.oci.image.config.v1+json",
            "digest": config_digest,
        },
        "layers": [
            {"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": d}
            for d in layer_digests
        ],
    }


def _json_bytes(doc: dict) -> bytes:
    """紧凑 JSON 字节（manifest 内容寻址的原料）。"""
    return json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()


class CacheFixture:
    """合成缓存目录 / 扫描快照的双料夹具。

    同一份内容描述既可以落成真实目录（IO 路径测试），也可以直接产出
    ``scan_snapshot`` 需要的三份产物（纯解析测试），保证两条路径的输入
    完全同构。
    """

    def __init__(self) -> None:
        self.content: dict[str, bytes] = {}
        self.mtimes: dict[str, float] = {}

    # ------------------------------------------------------------ 条目构造
    def add_manifest(
        self,
        repo: str,
        doc: dict,
        *,
        mtime: float,
        ref: str | None = None,
        bind_tag_digest: bool = True,
        tamper_body: bool = False,
        break_body: bool = False,
    ) -> str:
        """添加一个 manifest/index 条目，返回其真实内容摘要。

        ``ref=None`` 用 digest 键（KEY 行携带真实内容摘要，自洽）；``ref``
        是标签时用标签键并默认写入 ``docker-content-digest`` 响应头绑定。
        ``tamper_body`` 让 JSON 字节与 digest 不一致；``break_body`` 让清单
        体不可解析。
        """
        json_bytes = _json_bytes(doc)
        digest = hashlib.sha256(json_bytes).hexdigest()
        if ref is None:
            key = f"/v2/{repo}/manifests/sha256:{digest}"
        else:
            key = f"/v2/{repo}/manifests/{ref}"
        if tamper_body:
            json_bytes = json_bytes[:-1] + b" "
        body = b"{broken" if break_body else json_bytes
        headers = (
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: application/vnd.oci.image.index.v1+json\r\n"
        )
        if ref is not None and bind_tag_digest:
            headers += f"docker-content-digest: sha256:{digest}\r\n".encode()
        headers += b"docker-distribution-api-version: registry/2.0\r\n"
        self._add(key, headers + b"\r\n" + body + b"trailing-junk", mtime)
        return f"sha256:{digest}"

    def add_blob(
        self, repo: str, digest: str, *, mtime: float, padding: int = 64
    ) -> None:
        """添加一个 blob 条目（存在性由前向公式判定，内容无关紧要）。"""
        key = f"/v2/{repo}/blobs/{digest}"
        headers = b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n"
        self._add(key, headers + b"\x00" * padding, mtime)

    def add_dirty_file(self, name: str, mtime: float = NOW - 60) -> None:
        """非 32 位 hex 文件名（临时 / 半截文件）。"""
        relpath = f"x/yy/{name}"
        self.content[relpath] = b"partial-download"
        self.mtimes[relpath] = mtime

    def add_no_key_file(self, mtime: float = NOW - 60) -> str:
        """32 位 hex 文件名但没有 ``KEY:`` 头（脏条目）。"""
        name = hashlib.md5(b"no-key-entry").hexdigest()
        relpath = f"{name[-1]}/{name[-3:-1]}/{name}"
        self.content[relpath] = BINARY_NOISE + b"HTTP/1.1 200 OK\r\n\r\nbody"
        self.mtimes[relpath] = mtime
        return relpath

    def _add(self, key: str, content: bytes, mtime: float) -> None:
        relpath = cache_file_relpath(key)
        self.content[relpath] = BINARY_NOISE + b"KEY: " + key.encode() + b"\n" + content
        self.mtimes[relpath] = mtime

    # ------------------------------------------------------------ 两种出口
    def write(self, cache_dir: Path) -> None:
        """落成真实目录（IO 路径测试用）。"""
        for relpath, content in self.content.items():
            path = cache_dir / relpath
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        for relpath, mtime in self.mtimes.items():
            path = cache_dir / relpath
            if path.exists():
                os.utime(path, (mtime, mtime))

    def snapshot(
        self,
    ) -> tuple[dict[str, CacheFileInfo], dict[str, bytes], dict[str, bytes]]:
        """产出 ``scan_snapshot`` 的三份产物（与 IO 层同构，脏名被枚举层滤除）。"""
        files: dict[str, CacheFileInfo] = {}
        heads: dict[str, bytes] = {}
        bodies: dict[str, bytes] = {}
        for relpath, content in self.content.items():
            if not _valid_relpath(relpath):
                continue  # 枚举层跳过脏文件名
            files[relpath] = CacheFileInfo(
                relpath=relpath, size=len(content), mtime=self.mtimes[relpath]
            )
            head = content[:HEAD_BYTES]
            heads[relpath] = head
            if _head_says_manifest(head):
                bodies[relpath] = content
        return files, heads, bodies

    def result(self, *, skipped_names: int = 0):
        """直接跑纯聚合入口。"""
        files, heads, bodies = self.snapshot()
        return scan_snapshot(files, heads, bodies, NOW, skipped_names)


def _valid_relpath(relpath: str) -> bool:
    name = relpath.rsplit("/", 1)[-1]
    return len(name) == 32 and all(ch in "0123456789abcdef" for ch in name)


def _head_says_manifest(head: bytes) -> bool:
    ref = parse_key_head(head)
    return ref is not None and ref.kind == "manifests"


def _add_full_chain(
    fixture: CacheFixture,
    repo: str = "library/postgres",
    tag: str | None = None,
    *,
    index_mtime: float,
    child_mtime: float,
    blob_mtime: float = NOW - 3600,
) -> tuple[str, str, list[str]]:
    """构造「index → amd64 manifest → config+layers」完整链，返回摘要三元组。"""
    config, layer1, layer2 = _dg(f"{repo}-cfg"), _dg(f"{repo}-l1"), _dg(f"{repo}-l2")
    child_digest = fixture.add_manifest(
        repo, _image_doc(config, [layer1, layer2]), mtime=child_mtime
    )
    index_digest = fixture.add_manifest(
        repo, _index_doc(child_digest), mtime=index_mtime, ref=tag
    )
    fixture.add_blob(repo, config, mtime=blob_mtime)
    fixture.add_blob(repo, layer1, mtime=blob_mtime)
    fixture.add_blob(repo, layer2, mtime=blob_mtime)
    return index_digest, child_digest, [config, layer1, layer2]


# ---------------------------------------------------------------- 布局公式与前向路径
def test_layout_formula_matches_real_machine_anchor() -> None:
    """布局公式以真机实证条目为锚：md5 末 1 位 / 倒数第 3-2 位 / 全串。"""
    # 真机 rclone blob：md5(键) = da797b74…，文件在 cache/f/d6/ 下（已 test -f 命中）
    key = (
        "/v2/rclone/rclone/blobs/"
        "sha256:f8b05032f26d469c0fd009191ff7f540875fece5ccbddabaa45a3b2ba7336d93"
    )
    assert cache_file_relpath(key) == "f/d6/da797b74f686f979f3e6467ae967ed6f"


def test_blob_forward_relpath_matches_real_machine_anchor() -> None:
    """前向验证路径与真机 ``test -f`` 命中的路径一致。"""
    relpath = blob_forward_relpath(
        "rclone/rclone",
        "sha256:f8b05032f26d469c0fd009191ff7f540875fece5ccbddabaa45a3b2ba7336d93",
    )
    assert relpath == "f/d6/da797b74f686f979f3e6467ae967ed6f"


# ---------------------------------------------------------------- KEY: 头解析
def test_parse_cache_key_three_forms() -> None:
    """blob / manifest 按 digest / manifest 按标签三种形态。"""
    blob = parse_cache_key("/v2/library/nginx/blobs/sha256:" + "a" * 64)
    assert blob is not None
    assert (blob.repo, blob.kind, blob.digest, blob.tag) == (
        "library/nginx",
        "blobs",
        "sha256:" + "a" * 64,
        None,
    )

    by_digest = parse_cache_key("/v2/rclone/rclone/manifests/sha256:" + "b" * 64)
    assert by_digest is not None
    assert by_digest.is_by_digest is True

    by_tag = parse_cache_key("/v2/library/postgres/manifests/16-alpine")
    assert by_tag is not None
    assert (by_tag.repo, by_tag.kind, by_tag.digest, by_tag.tag) == (
        "library/postgres",
        "manifests",
        None,
        "16-alpine",
    )


@pytest.mark.parametrize(
    "key",
    [
        "/v2/library/nginx/blobs/sha512:" + "a" * 128,  # 只认 sha256 hex
        "/v2/library/nginx/blobs/sha256:" + "A" * 64,  # 大写 hex 不合法
        "/v2/library/nginx/blobs/sha256:abc",  # 截断 digest
        "/v2/library/nginx/manifests/.bad-tag",  # 标签首字符越界
        "/v2/library/nginx/manifests/" + "x" * 200,  # 标签超长
        "/v2/Library/Nginx/blobs/sha256:" + "a" * 64,  # 仓库必须小写
        "/v2/library/nginx/other/sha256:" + "a" * 64,  # 未知类型
        "/v2/library/nginx",  # 缺类型段
        "/not-v2/library/nginx/manifests/latest",  # 前缀不对
        "",
    ],
)
def test_parse_cache_key_rejects_dirty(key: str) -> None:
    """脏键一律 ``None``（跳过、不报错）。"""
    assert parse_cache_key(key) is None


def test_parse_key_head_finds_line_after_binary_header() -> None:
    """真机形态：nginx 二进制头（含 0xFF）之后才有 KEY 行，按行锚定命中。"""
    key = "/v2/library/postgres/manifests/16-alpine"
    head = BINARY_NOISE + b"KEY: " + key.encode() + b"\nHTTP/1.1 200 OK\r\n"
    ref = parse_key_head(head)
    assert ref is not None
    assert ref.tag == "16-alpine"


def test_parse_key_head_rejects_head_without_key_line() -> None:
    """无 KEY 行的头解析为 ``None``。"""
    assert parse_key_head(BINARY_NOISE + b"HTTP/1.1 200 OK\r\n\r\n") is None


# ---------------------------------------------------------------- manifest 体解析
def test_extract_json_document_bytes_are_exact() -> None:
    """截出的 JSON 字节与文件内容逐字节一致（sha256 自洽校验的前提）。"""
    doc = {"schemaVersion": 2, "manifests": []}
    payload = _json_bytes(doc)
    content = (
        BINARY_NOISE
        + b"KEY: /v2/a/b/manifests/latest\nHTTP/1.1 200 OK\r\n\r\n"
        + payload
        + b"\r\njunk"
    )
    extracted = extract_json_document(content)
    assert extracted is not None
    parsed, exact = extracted
    assert parsed == doc
    assert exact == payload
    assert verify_manifest_bytes(exact, f"sha256:{hashlib.sha256(payload).hexdigest()}")


def test_extract_json_document_rejects_garbage() -> None:
    """无花括号 / 断裂 JSON / 顶层非对象都返回 ``None``。"""
    assert extract_json_document(b"HTTP/1.1 200 OK\r\n\r\nno braces") is None
    assert extract_json_document(b"\r\n\r\n{broken") is None
    assert extract_json_document(b"\r\n\r\n[1,2,3]") is None


def test_extract_header_digest_case_insensitive() -> None:
    """真机响应头是小写 ``docker-content-digest:``，大小写不敏感解析。"""
    digest = _dg("nginx")
    content = (
        BINARY_NOISE
        + b"KEY: /v2/library/postgres/manifests/16-alpine\n"
        + b"HTTP/1.1 200 OK\r\n"
        + f"docker-content-digest: {digest}\r\n".encode()
        + b"\r\n{}"
    )
    assert extract_header_digest(content) == digest
    upper = content.replace(b"docker-content-digest:", b"Docker-Content-Digest:")
    assert extract_header_digest(upper) == digest


def test_extract_header_digest_absent_or_after_body() -> None:
    """头里没有就是没有；JSON 体里出现同名字样不算响应头。"""
    assert extract_header_digest(b"HTTP/1.1 200 OK\r\n\r\n{}") is None
    body_contains = (
        b"HTTP/1.1 200 OK\r\n\r\n"
        + b'{"x":"docker-content-digest: sha256:'
        + b"0" * 64
        + b'"}'
    )
    assert extract_header_digest(body_contains) is None


def test_classify_index_selects_amd64_and_skips_attestation() -> None:
    """多架构 index 解析到 linux/amd64，attestation（unknown 平台）跳过。"""
    amd64 = _dg("amd64")
    attestation = _dg("attestation")
    doc = _index_doc(
        amd64,
        [
            {
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "digest": attestation,
                "platform": {"os": "unknown", "architecture": "unknown"},
            }
        ],
    )
    shape = classify_manifest_document(doc)
    assert shape == ManifestShape(kind="index", amd64_digest=amd64)


def test_classify_index_without_amd64_is_unusable() -> None:
    """没有 linux/amd64 平台的 index → ``None``（整条落榜）。"""
    arm_only = {
        "schemaVersion": 2,
        "manifests": [
            {"digest": _dg("arm64"), "platform": {"os": "linux", "architecture": "arm64"}}
        ],
    }
    assert classify_manifest_document(arm_only) is None
    assert classify_manifest_document({"manifests": []}) is None


def test_classify_single_arch_manifest_lists_config_and_layers() -> None:
    """单架构 manifest → config + layers 清单（去重保序）。"""
    config, layer1, layer2 = _dg("cfg"), _dg("l1"), _dg("l2")
    shape = classify_manifest_document(_image_doc(config, [layer1, layer2, layer1]))
    assert shape is not None
    assert shape.kind == "image"
    assert shape.blob_digests == (config, layer1, layer2)


def test_classify_rejects_incomplete_blob_declarations() -> None:
    """config 缺失 / layer digest 形态非法 / 结构不对 → ``None``。"""
    config, layer = _dg("cfg"), _dg("l1")
    assert classify_manifest_document({"layers": [{"digest": layer}]}) is None
    broken_layer = {"config": {"digest": config}, "layers": [{"digest": "sha256:zz"}]}
    assert classify_manifest_document(broken_layer) is None
    assert classify_manifest_document({"config": {"digest": config}}) is None


def test_verify_manifest_bytes_detects_tamper() -> None:
    """内容寻址自洽性：字节改一位即不通过。"""
    payload = _json_bytes({"a": 1})
    digest = f"sha256:{hashlib.sha256(payload).hexdigest()}"
    assert verify_manifest_bytes(payload, digest) is True
    assert verify_manifest_bytes(payload + b" ", digest) is False
    assert verify_manifest_bytes(payload, "sha256:" + "0" * 64) is False


# ---------------------------------------------------------------- 有效期分层
def test_manifest_ttl_by_digest_and_blob_are_60d() -> None:
    """按 digest 引用的 manifest 与 blob 都是 60d（nginx 全局规则）。"""
    ref = parse_cache_key("/v2/library/nginx/manifests/sha256:" + "a" * 64)
    assert manifest_ttl_seconds(ref) == 60 * DAY
    assert blob_ttl_seconds() == 60 * DAY


@pytest.mark.parametrize(
    ("tag", "expected"),
    [
        ("stable", 10 * 60),  # primary 前缀
        ("nightly", 10 * 60),
        ("production", 10 * 60),
        ("test", 10 * 60),
        ("test-suite", 10 * 60),  # 前缀语义（nginx 正则不锚定结尾）
        ("unstable", 3600),  # 「stable」不在开头，不命中 primary
        ("3.12-slim", 60 * DAY),  # 版本式标签（≥3 个数字/点字符）
        ("5.2.37", 60 * DAY),
        ("1.2", 60 * DAY),
        ("16", 3600),  # 只有一个数字段 → 默认 1h
        ("16-alpine", 3600),
        ("latest", 3600),
    ],
)
def test_manifest_tag_tiers(tag: str, expected: int) -> None:
    """标签分层复刻真机 nginx：primary 10m / 版本式 60d / 其余 1h。"""
    ref = parse_cache_key(f"/v2/library/postgres/manifests/{tag}")
    assert manifest_ttl_seconds(ref) == expected


# ---------------------------------------------------------------- 条目聚合
def test_assemble_multi_arch_chain_with_merged_sources() -> None:
    """多架构完整链：标签条目与 digest 条目同 digest 归并，字段完整。"""
    fixture = CacheFixture()
    index_digest, child_digest, blobs = _add_full_chain(
        fixture, tag="v2", index_mtime=NOW - 120, child_mtime=NOW - 60
    )
    fixture.add_manifest(
        "library/postgres", _index_doc(child_digest), mtime=NOW - 30
    )  # digest 直拉的同内容条目
    result = fixture.result()
    index_images = [image for image in result.images if image.digest == index_digest]
    assert len(index_images) == 1
    image = index_images[0]
    assert image.tags == ("v2",)
    # 总大小 = index 文件 + 平台 manifest 文件 + config + 两层 layer（实际字节）
    relpaths = [
        cache_file_relpath(
            f"/v2/library/postgres/manifests/sha256:{index_digest.split(':')[-1]}"
        ),
        cache_file_relpath(
            f"/v2/library/postgres/manifests/sha256:{child_digest.split(':')[-1]}"
        ),
        *[blob_forward_relpath("library/postgres", d) for d in blobs],
    ]
    assert image.total_size_bytes == sum(
        len(fixture.content[relpath]) for relpath in relpaths
    )
    assert image.cached_at == "2027-01-15T07:59:30Z"


def test_assemble_merges_two_tags_pointing_to_same_digest() -> None:
    """两个标签指向同一 digest → 归并为一条，标签列表排序聚合。"""
    fixture = CacheFixture()
    child_digest = fixture.add_manifest(
        "library/nginx", _image_doc(_dg("cfg"), [_dg("l1")]), mtime=NOW - 120
    )
    index_digest = fixture.add_manifest(
        "library/nginx", _index_doc(child_digest), mtime=NOW - 100, ref="alpine"
    )
    fixture.add_manifest(
        "library/nginx", _index_doc(child_digest), mtime=NOW - 80, ref="latest"
    )
    fixture.add_blob("library/nginx", _dg("cfg"), mtime=NOW - 60)
    fixture.add_blob("library/nginx", _dg("l1"), mtime=NOW - 60)

    index_images = [
        image for image in fixture.result().images if image.digest == index_digest
    ]
    assert len(index_images) == 1
    assert index_images[0].tags == ("alpine", "latest")


def test_assemble_digest_pull_only_has_empty_tags() -> None:
    """digest 直拉的 index 上榜且标签列表为空。"""
    fixture = CacheFixture()
    index_digest, _child, _blobs = _add_full_chain(
        fixture, index_mtime=NOW - 60, child_mtime=NOW - 60
    )
    images = fixture.result().images
    index_images = [image for image in images if image.digest == index_digest]
    assert len(index_images) == 1
    assert index_images[0].tags == ()


def test_assemble_expired_tag_drops_tag_but_digest_entry_stays() -> None:
    """标签条目过期（1h 分层）落标签绑定；同内容的 digest 条目仍上榜。"""
    fixture = CacheFixture()
    config, layer1, layer2 = _dg("cfg"), _dg("l1"), _dg("l2")
    child_digest = fixture.add_manifest(
        "library/postgres", _image_doc(config, [layer1, layer2]), mtime=NOW - 60
    )
    index_doc = _index_doc(child_digest)
    index_digest = fixture.add_manifest(
        "library/postgres", index_doc, mtime=NOW - 7200, ref="16"
    )  # 「16」是 1h 分层，2 小时前缓存 → 已过期
    fixture.add_manifest("library/postgres", index_doc, mtime=NOW - 60)
    fixture.add_blob("library/postgres", config, mtime=NOW - 60)
    fixture.add_blob("library/postgres", layer1, mtime=NOW - 60)
    fixture.add_blob("library/postgres", layer2, mtime=NOW - 60)

    images = fixture.result().images
    index_images = [image for image in images if image.digest == index_digest]
    assert len(index_images) == 1, "同内容的 digest 直拉条目仍应上榜"
    assert index_images[0].tags == (), "过期的标签绑定不得出现在标签列表"
    assert all("16" not in image.tags for image in images)


def test_assemble_all_expired_entries_drop_off() -> None:
    """整组条目都超过 60d → 全部落榜（PRD 验收 7 的「过期不误导」）。"""
    fixture = CacheFixture()
    _add_full_chain(
        fixture,
        index_mtime=NOW - 61 * DAY,
        child_mtime=NOW - 61 * DAY,
        blob_mtime=NOW - 61 * DAY,
    )
    assert fixture.result().images == ()


def test_assemble_versionish_tag_survives_beyond_one_hour() -> None:
    """版本式标签（60d 分层）超过 1h 仍存活——分层口径的正例。"""
    fixture = CacheFixture()
    child_digest = fixture.add_manifest(
        "library/python",
        _image_doc(_dg("py-cfg"), [_dg("py-l1")]),
        mtime=NOW - 7200,
    )
    slim_digest = fixture.add_manifest(
        "library/python", _index_doc(child_digest), mtime=NOW - 7200, ref="3.12-slim"
    )
    fixture.add_blob("library/python", _dg("py-cfg"), mtime=NOW - 3600)
    fixture.add_blob("library/python", _dg("py-l1"), mtime=NOW - 3600)
    slim_images = [
        image for image in fixture.result().images if image.digest == slim_digest
    ]
    assert len(slim_images) == 1
    assert slim_images[0].tags == ("3.12-slim",)


def test_assemble_missing_blob_drops_entry() -> None:
    """blob 不在缓存 → 整条落榜（保守口径，绝不把不完整说成已缓存）。"""
    fixture = CacheFixture()
    config, layer1, layer2 = _dg("cfg"), _dg("l1"), _dg("l2")
    child_digest = fixture.add_manifest(
        "library/postgres", _image_doc(config, [layer1, layer2]), mtime=NOW - 60
    )
    fixture.add_manifest(
        "library/postgres", _index_doc(child_digest), mtime=NOW - 60
    )
    fixture.add_blob("library/postgres", config, mtime=NOW - 60)
    fixture.add_blob("library/postgres", layer1, mtime=NOW - 60)
    # layer2 故意缺席
    assert fixture.result().images == ()


def test_assemble_expired_blob_drops_entry() -> None:
    """blob 超过 60d 有效期 → 整条落榜。"""
    fixture = CacheFixture()
    _add_full_chain(
        fixture,
        index_mtime=NOW - 60,
        child_mtime=NOW - 60,
        blob_mtime=NOW - (61 * DAY),
    )
    assert fixture.result().images == ()


def test_assemble_index_without_cached_amd64_child_drops_entry() -> None:
    """index 在、linux/amd64 平台 manifest 不在缓存 → 整条落榜。"""
    fixture = CacheFixture()
    config, layer = _dg("cfg"), _dg("l1")
    fixture.add_manifest(
        "library/postgres",
        _index_doc("sha256:" + "c" * 64),  # 平台 manifest 没有对应缓存条目
        mtime=NOW - 60,
    )
    fixture.add_blob("library/postgres", config, mtime=NOW - 60)
    fixture.add_blob("library/postgres", layer, mtime=NOW - 60)
    assert fixture.result().images == ()


def test_assemble_single_arch_manifest_direct() -> None:
    """单架构镜像：直接验该 manifest 的全部 blob，齐全才上榜。"""
    fixture = CacheFixture()
    config, layer = _dg("cfg"), _dg("l1")
    digest = fixture.add_manifest(
        "rclone/rclone", _image_doc(config, [layer]), mtime=NOW - 60
    )
    fixture.add_blob("rclone/rclone", config, mtime=NOW - 60)
    fixture.add_blob("rclone/rclone", layer, mtime=NOW - 60)
    images = fixture.result().images
    assert len(images) == 1
    assert images[0].digest == digest
    assert images[0].tags == ()
    relpaths = [
        cache_file_relpath(f"/v2/rclone/rclone/manifests/sha256:{digest.split(':')[-1]}"),
        blob_forward_relpath("rclone/rclone", config),
        blob_forward_relpath("rclone/rclone", layer),
    ]
    assert images[0].total_size_bytes == sum(
        len(fixture.content[relpath]) for relpath in relpaths
    )


# ---------------------------------------------------------------- 纯解析阶段计数
def test_scan_manifest_records_and_counters() -> None:
    """可用记录 / blob 计数 / 脏条目跳过计数。"""
    fixture = CacheFixture()
    config, layer = _dg("cfg"), _dg("l1")
    fixture.add_manifest("rclone/rclone", _image_doc(config, [layer]), mtime=NOW - 60, ref="latest")
    fixture.add_manifest("rclone/rclone", _image_doc(config, [layer]), mtime=NOW - 60)
    fixture.add_blob("rclone/rclone", config, mtime=NOW - 60)
    fixture.add_manifest(
        "dirty/repo",
        _image_doc(config, [layer]),
        mtime=NOW - 60,
        tamper_body=True,  # 自洽性校验失败
    )
    fixture.add_manifest(
        "dirty/repo",
        _image_doc(config, [layer]),
        mtime=NOW - 60,
        ref="broken",
        break_body=True,  # 清单体不可解析
    )
    fixture.add_manifest(
        "dirty/repo",
        _image_doc(config, [layer]),
        mtime=NOW - 60,
        ref="no-bind",
        bind_tag_digest=False,  # tag 条目没有 digest 绑定头
    )
    no_key = fixture.add_no_key_file()

    files, heads, bodies = fixture.snapshot()
    records, blob_files, skipped = scan_manifest_records(files, heads, bodies)
    assert len(records) == 2
    assert blob_files == 1
    assert skipped == 4  # tamper / broken / no-bind / 无 KEY
    assert no_key not in bodies


def test_scan_snapshot_payload_and_counters() -> None:
    """聚合入口的载荷与计数出口。"""
    fixture = CacheFixture()
    _add_full_chain(fixture, index_mtime=NOW - 60, child_mtime=NOW - 60)
    fixture.add_dirty_file("tmp.0001")
    fixture.add_no_key_file()
    result = fixture.result(skipped_names=1)
    assert result.total_files == 6  # 5 个合法条目 + 1 个无 KEY 条目（脏名被滤除）
    assert result.skipped_files == 2  # 1 个脏文件名 + 1 个无 KEY 条目
    assert len(result.images) == 2  # index 条目 + 平台 manifest 条目
    payload = result.to_payload()
    assert payload["generated_at"] == "2027-01-15T08:00:00Z"
    assert payload["total_files"] == result.total_files
    assert {image["repo"] for image in payload["images"]} == {"library/postgres"}
    assert set(payload["images"][0]) == {
        "repo",
        "tags",
        "digest",
        "total_size_bytes",
        "cached_at",
    }


def test_assemble_images_is_deterministic() -> None:
    """同输入多次聚合结果一致（排序确定性）。"""
    fixture = CacheFixture()
    _add_full_chain(fixture, index_mtime=NOW - 60, child_mtime=NOW - 60)
    files, heads, bodies = fixture.snapshot()
    records, _blobs, _skipped = scan_manifest_records(files, heads, bodies)
    first = assemble_images(records, files, NOW)
    second = assemble_images(records, files, NOW)
    assert first == second


# ---------------------------------------------------------------- 特权路径（可注入伪通道）
class FakePrivilegedChannel:
    """替身 ``run``：记录调用并本地代跑（剥离 sudo 前缀，夹具归测试用户）。

    两档（root / 非 root）行为一致：不依赖真实 sudo，又能端到端验证命令
    形态（前缀、超时封顶）与批量协议。可注入失败 / 超时。
    """

    def __init__(
        self,
        *,
        fail_substring: str | None = None,
        timeout_substring: str | None = None,
    ) -> None:
        self.calls: list[tuple[list[str], int | None]] = []
        self.fail_substring = fail_substring
        self.timeout_substring = timeout_substring

    def __call__(
        self, argv, *, env=None, check=False, timeout=None, cwd=None, stdin_text=None
    ) -> CommandResult:
        args = [str(item) for item in argv]
        self.calls.append((args, timeout))
        joined = " ".join(args)
        if self.fail_substring and self.fail_substring in joined:
            return CommandResult(tuple(args), 1, "", "注入的命令失败")
        if self.timeout_substring and self.timeout_substring in joined:
            raise CommandError(tuple(args), 124, "", "", message="命令超时（30 秒）")
        while args[:2] == ["sudo", "-n"]:
            args = args[2:]
        completed = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, check=False
        )
        return CommandResult(
            tuple(args), completed.returncode, completed.stdout, completed.stderr
        )


@pytest.fixture
def cache_root(tmp_path: Path) -> Path:
    """带独立数据根的缓存目录（tmp/registry-proxy/cache）。"""
    return tmp_path / "registry-proxy" / "cache"


@pytest.fixture
def scanner(tmp_path: Path) -> RegistryCacheScanner:
    """指向临时数据根的扫描器（特权前缀固定开启，便于断言命令形态）。"""
    config = PlatformConfig.from_env({"SANDBOX_PLATFORM_HOME": str(tmp_path)})
    return RegistryCacheScanner(config, Privilege(enabled=True))


def _force_privileged(scanner: RegistryCacheScanner, monkeypatch) -> None:
    """让直读路径失败，强制走特权回退（权限同构，无需按档造真实权限差）。"""

    def _denied(*_args, **_kwargs):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(scanner, "_enumerate_direct", _denied)
    monkeypatch.setattr(scanner, "_read_direct", _denied)


def test_scan_missing_cache_dir_returns_empty_without_error(
    scanner: RegistryCacheScanner,
) -> None:
    """缓存目录不存在（代理从未拉起）→ 空清单、零计数、不报错。"""
    result = scanner.scan(now=NOW)
    assert result.images == ()
    assert result.total_files == 0
    assert result.blob_files == 0
    assert result.skipped_files == 0


def test_scan_direct_path_never_uses_privileged_channel(
    scanner: RegistryCacheScanner, cache_root: Path, monkeypatch
) -> None:
    """目录可读时全程零特权调用（对齐 certificate_ready 的直读优先）。"""
    fixture = CacheFixture()
    _add_full_chain(fixture, index_mtime=NOW - 60, child_mtime=NOW - 60)
    fixture.write(cache_root)
    channel = FakePrivilegedChannel()
    monkeypatch.setattr("sandbox_platform.cache_manifest.run", channel)

    result = scanner.scan(now=NOW)
    assert len(result.images) == 2  # index 条目 + 平台 manifest 条目
    assert channel.calls == [], "可读目录不应动用特权通道"


def test_scan_privileged_fallback_end_to_end(
    scanner: RegistryCacheScanner, cache_root: Path, monkeypatch
) -> None:
    """直读失败 → 特权回退端到端：枚举 1 条 find + 头/体各 1 条批量 sh。"""
    fixture = CacheFixture()
    config, layer = _dg("cfg"), _dg("l1")
    fixture.add_manifest(
        "library/nginx", _image_doc(config, [layer]), mtime=NOW - 60, ref="latest"
    )
    fixture.add_blob("library/nginx", config, mtime=NOW - 60)
    fixture.add_blob("library/nginx", layer, mtime=NOW - 60)
    fixture.add_dirty_file("partial.tmp")
    fixture.write(cache_root)

    channel = FakePrivilegedChannel()
    monkeypatch.setattr("sandbox_platform.cache_manifest.run", channel)
    _force_privileged(scanner, monkeypatch)

    result = scanner.scan(now=NOW)

    # 命令形态：三条特权命令，全部带 sudo 前缀、全部 30 秒封顶
    assert len(channel.calls) == 3
    assert all(argv[:2] == ["sudo", "-n"] for argv, _timeout in channel.calls)
    assert all(timeout == 30 for _argv, timeout in channel.calls)
    assert "find" in channel.calls[0][0] and "-printf" in channel.calls[0][0]
    limits = sorted(int(argv[-1]) for argv, _t in channel.calls if "sh" in argv)
    assert limits == [HEAD_BYTES, MANIFEST_BODY_MAX_BYTES]

    # 结果与直读路径同构：脏文件名被枚举层跳过、清单 1 条、blob 计 2
    assert len(result.images) == 1
    assert result.images[0].tags == ("latest",)
    assert result.blob_files == 2
    assert result.skipped_files == 1  # 脏文件名


def test_scan_enumeration_failure_raises_cache_scan_error(
    scanner: RegistryCacheScanner, cache_root: Path, monkeypatch
) -> None:
    """枚举命令失败 / 超时 → 整场失败抛 ``CacheScanError``（不静默回空）。"""
    fixture = CacheFixture()
    fixture.add_no_key_file()
    fixture.write(cache_root)

    fail_channel = FakePrivilegedChannel(fail_substring="find")
    monkeypatch.setattr("sandbox_platform.cache_manifest.run", fail_channel)
    _force_privileged(scanner, monkeypatch)
    with pytest.raises(CacheScanError, match="枚举"):
        scanner.scan(now=NOW)

    timeout_channel = FakePrivilegedChannel(timeout_substring="find")
    monkeypatch.setattr("sandbox_platform.cache_manifest.run", timeout_channel)
    with pytest.raises(CacheScanError, match="枚举"):
        scanner.scan(now=NOW)


def test_scan_batch_read_failure_raises_cache_scan_error(
    scanner: RegistryCacheScanner, cache_root: Path, monkeypatch
) -> None:
    """批量读命令失败 / 超时 → 整场失败抛 ``CacheScanError``。"""
    fixture = CacheFixture()
    fixture.add_no_key_file()
    fixture.write(cache_root)

    fail_channel = FakePrivilegedChannel(fail_substring="sandbox-cache-batch-read")
    monkeypatch.setattr("sandbox_platform.cache_manifest.run", fail_channel)
    _force_privileged(scanner, monkeypatch)
    with pytest.raises(CacheScanError, match="批量读取"):
        scanner.scan(now=NOW)

    timeout_channel = FakePrivilegedChannel(timeout_substring="sandbox-cache-batch-read")
    monkeypatch.setattr("sandbox_platform.cache_manifest.run", timeout_channel)
    with pytest.raises(CacheScanError, match="批量读取"):
        scanner.scan(now=NOW)


def test_scan_skips_dirty_entries_without_error(
    scanner: RegistryCacheScanner, cache_root: Path
) -> None:
    """脏条目（坏文件名 / 无 KEY / 断裂 JSON）只影响计数、不报错。"""
    fixture = CacheFixture()
    config, layer = _dg("cfg"), _dg("l1")
    fixture.add_manifest(
        "library/nginx", _image_doc(config, [layer]), mtime=NOW - 60, ref="latest"
    )
    fixture.add_blob("library/nginx", config, mtime=NOW - 60)
    fixture.add_blob("library/nginx", layer, mtime=NOW - 60)
    fixture.add_dirty_file("half-written")
    fixture.add_no_key_file()
    fixture.add_manifest(
        "dirty/repo", _image_doc(config, [layer]), mtime=NOW - 60, ref="broken",
        break_body=True,
    )
    fixture.write(cache_root)

    result = scanner.scan(now=NOW)
    assert len(result.images) == 1
    assert result.skipped_files == 3  # 脏文件名 + 无 KEY + 断裂 JSON


def test_scan_untraversable_cache_dir_falls_back_to_privileged(
    scanner: RegistryCacheScanner, cache_root: Path, monkeypatch
) -> None:
    """目录存在但探测受阻（EACCES）→ 不吞空清单、不裸抛，走特权回退实扫。

    ``is_dir()`` / ``exists()`` 对「上级目录 0700 不可穿越」的形态随版本
    漂移（吞成 False 或裸抛 PermissionError），任何一种都会让特权回退
    永不触发、踩「空清单比失败更糟」红线——只有 stat 的 ENOENT 才算
    「不存在」，这里钉住不可穿越必须走回退链。
    """

    class _UntraversableDir(Path):
        """指向真实缓存目录的伪路径：``stat`` 一律 EACCES。

        真实路径部分留给特权通道（``str()`` 后 ``find`` 仍能实扫），只有
        「探测 / 直读」被卡——模拟服务用户无法穿越上级目录的真实形态。
        """

        def stat(self, **_kwargs):
            raise PermissionError(13, "模拟上级目录不可穿越")

    fixture = CacheFixture()
    config, layer = _dg("cfg"), _dg("l1")
    fixture.add_manifest(
        "library/nginx", _image_doc(config, [layer]), mtime=NOW - 60, ref="latest"
    )
    fixture.add_blob("library/nginx", config, mtime=NOW - 60)
    fixture.add_blob("library/nginx", layer, mtime=NOW - 60)
    fixture.write(cache_root)

    untraversable = _UntraversableDir(cache_root)
    monkeypatch.setattr(
        RegistryCacheScanner,
        "cache_dir",
        property(lambda _self: untraversable),
    )
    channel = FakePrivilegedChannel()
    monkeypatch.setattr("sandbox_platform.cache_manifest.run", channel)
    # 上级不可穿越 ⇒ 直读枚举 / 直读写文件同样 EACCES，两路都强制受阻
    _force_privileged(scanner, monkeypatch)

    result = scanner.scan(now=NOW)

    # 特权回退被真实触发（而非静默空清单 / 裸抛 500）：find 枚举先行
    assert channel.calls, "不可穿越目录必须触发特权回退，而非静默空清单"
    assert "find" in channel.calls[0][0] and "-printf" in channel.calls[0][0]
    assert len(result.images) == 1
    assert result.images[0].tags == ("latest",)
    assert result.blob_files == 2
    assert result.skipped_files == 0


@pytest.mark.parametrize(
    ("exc_factory", "scenario"),
    [
        pytest.param(
            lambda: OSError(5, "模拟读取中途 EIO"), "读取中途 EIO", id="eio-midway"
        ),
        pytest.param(
            lambda: FileNotFoundError(2, "模拟读取间隙消失"),
            "读取间隙消失",
            id="vanished",
        ),
    ],
)
def test_scan_direct_read_oserror_skips_entry(
    exc_factory, scenario, scanner: RegistryCacheScanner, monkeypatch
) -> None:
    """直读中途 OSError（非 FileNotFoundError 也能咬住）→ 按脏条目计 skipped。

    读取失败只损失该条目的头（blob 计数 -1、skipped +1），镜像仍按前向
    公式完整装配，且绝不动用特权通道（单文件脏 ≠ 整批失败）：错误语义
    闭环，服务端拿到 200 + 真实计数而非 500。
    """
    assert scenario  # 参数化说明已生效
    fixture = CacheFixture()
    config, layer = _dg("cfg"), _dg("l1")
    fixture.add_manifest(
        "library/nginx", _image_doc(config, [layer]), mtime=NOW - 60, ref="latest"
    )
    fixture.add_blob("library/nginx", config, mtime=NOW - 60)
    fixture.add_blob("library/nginx", layer, mtime=NOW - 60)
    fixture.write(scanner.cache_dir)
    poisoned_relpath = cache_file_relpath(f"/v2/library/nginx/blobs/{config}")
    poisoned_path = scanner.cache_dir / poisoned_relpath

    real_open = Path.open
    opened = {"poisoned": 0}

    class _MidReadFailure:
        """伪装句柄：open 成功、``read`` 中途抛 OSError（模拟 EIO / 消失）。"""

        def __init__(self, handle) -> None:
            self._handle = handle

        def read(self, _limit: int) -> bytes:
            raise exc_factory()

        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return self._handle.__exit__(*exc_info)

    def _flaky_open(self, *args, **kwargs):
        handle = real_open(self, *args, **kwargs)
        if self == poisoned_path:
            opened["poisoned"] += 1
            return _MidReadFailure(handle)
        return handle

    monkeypatch.setattr(Path, "open", _flaky_open)
    channel = FakePrivilegedChannel()
    monkeypatch.setattr("sandbox_platform.cache_manifest.run", channel)

    result = scanner.scan(now=NOW)

    assert opened["poisoned"] == 1, "中毒文件只被头读路径碰到一次"
    assert channel.calls == [], "单文件读取失败不应整批转特权"
    assert len(result.images) == 1  # blob 在枚举表里 → 前向存在性成立
    assert result.images[0].tags == ("latest",)
    assert result.blob_files == 1  # 中毒 blob 的头没读到，计数 -1
    assert result.skipped_files == 1  # 消失 / 读取失败按脏条目入账（头对账）


def test_scan_privileged_vanished_file_counts_skipped(
    scanner: RegistryCacheScanner, cache_root: Path, monkeypatch
) -> None:
    """特权路竞态消失（枚举到、批量读时没了）→ 同口径计 skipped。

    与直读 FileNotFoundError 同一账本：特权批量脚本对已消失的文件不产出
    标记，scan 头对账把它计入 skipped_files——直读 / 特权两路统计口径
    一致（消失的文件也计 skipped）。
    """
    fixture = CacheFixture()
    config, layer = _dg("cfg"), _dg("l1")
    fixture.add_manifest(
        "library/nginx", _image_doc(config, [layer]), mtime=NOW - 60, ref="latest"
    )
    fixture.add_blob("library/nginx", config, mtime=NOW - 60)
    fixture.add_blob("library/nginx", layer, mtime=NOW - 60)
    fixture.write(cache_root)
    victim_relpath = cache_file_relpath(f"/v2/library/nginx/blobs/{config}")
    victim_path = scanner.cache_dir / victim_relpath

    class _VanishingChannel(FakePrivilegedChannel):
        """首条批量读命令执行前移除目标文件（模拟枚举后竞态消失）。"""

        def __init__(self, victim: Path) -> None:
            super().__init__()
            self._victim = victim
            self.vanished = False

        def __call__(self, argv, **kwargs):
            joined = " ".join(str(item) for item in argv)
            if not self.vanished and "sandbox-cache-batch-read" in joined:
                self._victim.unlink()
                self.vanished = True
            return super().__call__(argv, **kwargs)

    channel = _VanishingChannel(victim_path)
    monkeypatch.setattr("sandbox_platform.cache_manifest.run", channel)
    _force_privileged(scanner, monkeypatch)

    result = scanner.scan(now=NOW)

    assert channel.vanished, "竞态消失发生在特权批量读之前"
    assert len(result.images) == 1  # blob 文件仍在枚举表 → 镜像装配不受影响
    assert result.images[0].tags == ("latest",)
    assert result.blob_files == 1
    assert result.skipped_files == 1  # 特权批量读缺标记 → 头对账入账


# ---------------------------------------------------------------- 批量协议解析
def test_batch_parse_marker_collision_skips_without_corruption() -> None:
    """标记串撞进载荷 → 相应记录安全跳过，不产生错误关联。"""
    path_a, path_b = f"a/aa/{'a' * 32}", f"b/bb/{'b' * 32}"
    payload_b = base64.b64encode(b"0123456789").decode()
    poisoned = (
        f"{HEAD_MARKER}{path_a}\n"
        + base64.b64encode(b"0123456789" * 4).decode()[:7]  # 断在四字符组中间
        + f"{HEAD_MARKER}{path_b}\n"  # 撞进 A 的载荷里
        + payload_b
        + "\n"
    )
    chunks = _parse_batch_output(poisoned, [path_a, path_b], HEAD_BYTES)
    assert path_a not in chunks, "被污染的记录安全跳过，绝不张冠李戴"
    assert chunks[path_b] == b"0123456789", "未被波及的记录完好无损"


def test_batch_parse_missing_marker_and_oversize_skip() -> None:
    """缺失标记（竞态消失）与超限载荷都按跳过处理。"""
    paths = [f"a/aa/{'a' * 32}", f"b/bb/{'b' * 32}"]
    only_b = f"{HEAD_MARKER}{paths[1]}\n{base64.b64encode(b'hello').decode()}\n"
    chunks = _parse_batch_output(only_b, paths, HEAD_BYTES)
    assert list(chunks) == [paths[1]]
    big = f"{HEAD_MARKER}{paths[0]}\n{base64.b64encode(b'x' * 2048).decode()}\n"
    assert _parse_batch_output(big, [paths[0]], 1024) == {}
    assert _parse_batch_output(big, [paths[0]], 2048) == {paths[0]: b"x" * 2048}


def test_batch_parse_decodes_all_files_in_order() -> None:
    """正常协议：按期望顺序逐条解码，字节与写入内容一致。"""
    fixture = CacheFixture()
    config, layer = _dg("cfg"), _dg("l1")
    fixture.add_manifest(
        "library/nginx", _image_doc(config, [layer]), mtime=NOW - 60, ref="latest"
    )
    fixture.add_blob("library/nginx", config, mtime=NOW - 60)
    fixture.add_blob("library/nginx", layer, mtime=NOW - 60)
    relpaths = sorted(fixture.content)
    script_input = "".join(
        f"{HEAD_MARKER}{relpath}\n"
        + base64.b64encode(fixture.content[relpath][:HEAD_BYTES]).decode()
        + "\n"
        for relpath in relpaths
    )
    chunks = _parse_batch_output(script_input, relpaths, HEAD_BYTES)
    assert sorted(chunks) == relpaths
    for relpath in relpaths:
        assert chunks[relpath] == fixture.content[relpath][:HEAD_BYTES]
