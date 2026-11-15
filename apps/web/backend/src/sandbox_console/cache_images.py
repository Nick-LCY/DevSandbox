"""镜像缓存清单的服务端半边：TTL 内存缓存与 text 预渲染。

机制落核心包、接口在服务端（先例：运行期文件传输）：扫描能力本体是核心包的
``RegistryCacheScanner``（特权通道读 ``<数据根>/registry-proxy/cache``，30 秒
封顶纪律由它保证），这里只做两件服务端自己的事：

- **TTL 内存缓存（钉 60 秒）**：扫描按需执行，TTL 内重复请求复用同一份
  ``CacheScanResult``——json 与 text 两种格式**共享同一份结果**（同一生成
  时间戳）。扫描失败（``CacheScanError``）原样上抛、**不入缓存**（端点映射
  503），下一次请求立即重试，绝不把失败缓存成「空清单」。
- **text 预渲染**：沙箱内 ``cached-images`` 是纯 bash + curl，**没有 jq**，
  禁止让 bash 解析 JSON——服务端义务是提供直接可读的文本（表头 + 逐行条目
  + 生成时间 + 防误读说明）。
- **tags=only 视图（0.4.1 轮新增）**：``?tags=only`` 只保留标签列表非空的
  条目（json 与 text 同参数同语义）；text 在该视图渲染成 docker images
  风格表格（IMAGE / ID / SIZE / CACHED TIME，服务端预渲染，bash 零解析）。

服务端**不另设扫描超时**：30 秒封顶由核心包保证（``SCAN_COMMAND_TIMEOUT``，
对齐 ``cache_size_bytes`` 同款纪律），这里不放大也不重复实现。

并发口径：缓存实例不做加锁——同步路由跑在线程池里，TTL 过期瞬间的并发请求
最坏各扫一次（扫描幂等、成本可控），正确性不受影响，不值得为此引入锁。
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from sandbox_platform import CacheScanResult

# TTL 钉 60 秒：避免每次请求都扫盘；当前缓存仅百余文件，但 max_size=32g
# 会涨，TTL 兜底（PRD 14）。json 与 text 共享同一份缓存。
CACHE_IMAGES_TTL_SECONDS = 60.0


class CacheImagesCache:
    """扫描按需执行 + TTL 内存缓存（时钟可注入，单测钉 TTL 行为）。

    ``scanner_factory`` 每次返回一个新扫描器（正常路径是绑定应用配置的
    ``RegistryCacheScanner``；单测注入伪扫描器）。``clock`` 缺省单调时钟
    （与票据过期判定同款纪律，不受系统时间调整影响）。
    """

    def __init__(
        self,
        scanner_factory: Callable[[], Any],
        *,
        clock: Callable[[], float] = time.monotonic,
        ttl_seconds: float = CACHE_IMAGES_TTL_SECONDS,
    ) -> None:
        self._scanner_factory = scanner_factory
        self._clock = clock
        self._ttl_seconds = ttl_seconds
        self._result: CacheScanResult | None = None
        self._fetched_at: float | None = None

    def get(self) -> CacheScanResult:
        """取当前清单：缓存新鲜直接复用；过期或首次按需扫描。

        新鲜判定 ``< ttl``：恰好到达 TTL 即过期重扫（钉「60 秒」的严格口径）。
        扫描失败（``CacheScanError``）原样上抛，失败**不入缓存**——下一次
        请求立即重试，绝不静默回空清单。
        """
        now = self._clock()
        if (
            self._result is not None
            and self._fetched_at is not None
            and now - self._fetched_at < self._ttl_seconds
        ):
            return self._result
        result = self._scanner_factory().scan()
        self._result = result
        self._fetched_at = self._clock()
        return result


# ---------------------------------------------------------------- tags=only 视图（过滤 + 表格渲染）


def filter_tag_only(result: CacheScanResult) -> CacheScanResult:
    """tags=only 视图的装配层过滤：只保留标签列表非空的条目。

    口径（用户拍板）：``?tags=only`` 只返回 ``tags`` 非空的条目——digest 直拉
    条目与「index 条目 + 平台 manifest 条目」里的无标签行全部滤除。三计数与
    生成时间戳**原样保留**：它们描述的是这次扫描本身，不是过滤后的视图。
    """
    return CacheScanResult(
        generated_at=result.generated_at,
        images=tuple(image for image in result.images if image.tags),
        total_files=result.total_files,
        blob_files=result.blob_files,
        skipped_files=result.skipped_files,
    )


# 十进制（1000 进制）单位序列，仿 docker images 的人读大小；TB 作兜底封顶位。
_SIZE_UNITS_DECIMAL = ("B", "kB", "MB", "GB", "TB")


def format_size_decimal(size_bytes: int) -> str:
    """十进制（1000 进制）人读大小：``63.9MB`` / ``5.8kB`` / ``933B``。

    与 console 前端的 ``formatBytes``（KiB / MiB，二进制 1024 进制）**刻意
    并存两套**：表格仿 docker images 的观感，docker 用十进制；console 视图
    维持二进制不动，互不影响。1 位小数、整数不带小数点（``1kB`` 不是
    ``1.0kB``）。
    """
    size = float(size_bytes)
    unit_index = len(_SIZE_UNITS_DECIMAL) - 1
    for index, unit_name in enumerate(_SIZE_UNITS_DECIMAL):
        if size < 1000.0:
            unit_index = index
            break
        size /= 1000.0
    unit = _SIZE_UNITS_DECIMAL[unit_index]
    if unit == "B":
        return f"{int(size)}B"
    text = f"{size:.1f}"
    if text.endswith(".0"):
        text = text[:-2]
    return f"{text}{unit}"


def format_cached_time(cached_at: str) -> str:
    """``cached_at``（ISO 8601 UTC）→ ``YYYY-MM-DD HH:mm:ss``（UTC 口径）。

    核心包产出的 ``cached_at`` 形如 ``2026-11-06T15:35:14Z``，解析后按 UTC
    墙钟渲染（**不落服务端本地时区**）；非 UTC 偏移的输入防御性归一到 UTC
    （数据源本就 UTC，实测不触发）。解析失败原样返回——脏数据不炸渲染。
    """
    try:
        moment = datetime.fromisoformat(cached_at)
    except ValueError:
        return cached_at
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%d %H:%M:%S")


def render_cache_images_tag_only_table(result: CacheScanResult) -> str:
    """tags=only 视图的 text 渲染：docker images 风格表格（服务端预渲染）。

    布局（用户拍板口径）：

    - 轻表头一行：条目数 / 表格行数 + 「清单生成时间：…」（PRD「text 含生成
      时间」在 tag-only 视图的承载形态）；
    - 列：IMAGE（``{repo}:{tag}``，同一条目多标签展开为多行，ID/SIZE/TIME
      重复）、ID（digest 去 ``sha256:`` 前缀后的前 12 位）、SIZE（十进制人
      读）、CACHED TIME（``YYYY-MM-DD HH:mm:ss``，UTC）；
    - 列宽按批内最长值对齐（含列表头；ljust + 两空格分隔，行尾不留空白），
      行按 repo、tag 排序保证稳定输出；
    - 表格后一行尾注：SIZE 语义防误读。默认 text 的两则尾注里的「两行现象」
      注在 tag-only 视图**不适用**（无标签行已被滤除），不再渲染。

    空态给明确文案（默认 text 同款纪律：绝不让 bash 把「没有输出」误读成
    「没有缓存」）。纯函数零 IO：输入一份扫描结果，输出一份文本。
    """
    expanded = [
        (image.repo, tag, image) for image in result.images for tag in image.tags
    ]
    expanded.sort(key=lambda item: (item[0], item[1]))
    rows = [
        (
            f"{repo}:{tag}",
            image.digest.removeprefix("sha256:")[:12],
            format_size_decimal(image.total_size_bytes),
            format_cached_time(image.cached_at),
        )
        for repo, tag, image in expanded
    ]
    header = ("IMAGE", "ID", "SIZE", "CACHED TIME")
    widths = [
        max([len(title), *[len(row[column]) for row in rows]])
        for column, title in enumerate(header)
    ]
    lines = [
        f"已缓存镜像 {len(result.images)} 条（表格 {len(rows)} 行）"
        f"｜ 清单生成时间：{result.generated_at}",
    ]
    if not rows:
        lines.append("（当前没有带标签的已缓存镜像）")
    else:
        lines.append(
            "  ".join(
                title.ljust(width) for title, width in zip(header, widths, strict=True)
            ).rstrip()
        )
        lines.extend(
            "  ".join(
                cell.ljust(width) for cell, width in zip(row, widths, strict=True)
            ).rstrip()
            for row in rows
        )
    lines.append("SIZE 为拉取该条所需链字节，条目间共享 blob，不可求和当缓存占用")
    return "\n".join(lines) + "\n"


def render_cache_images_text(result: CacheScanResult) -> str:
    """把扫描结果渲染成 bash 直接可读的预渲染文本（``text/plain``）。

    布局：表头（标题 + 生成时间 + 条目/文件计数）→ 逐行条目（仓库 / 标签 /
    摘要 / 链大小 / 缓存时间，条目间以横线分隔）→ 尾注两则。空清单给明确的
    空态文案——**绝不**让 bash 把「没有输出」误读成「没有缓存」。

    尾注防误读（任务 01 审查裁决口径）：

    - ``total_size_bytes`` 是**拉取该条所需链**（manifest + config + layers）
      的字节数；条目之间共享 blob，**不可求和当缓存占用**；
    - 同一镜像可能出现「index 条目 + 平台 manifest 条目」两行（后者标签列表
      为空）——二者摘要不同，属正常。
    """
    lines = [
        "镜像缓存清单（仅收录已完整缓存的镜像）",
        f"生成时间：{result.generated_at}",
        (
            f"镜像条目：{len(result.images)} 条"
            f"（缓存文件 {result.total_files} 个：blob {result.blob_files}、"
            f"跳过脏条目 {result.skipped_files} 个）"
        ),
    ]
    if not result.images:
        lines.append("（当前没有已完整缓存的镜像）")
    else:
        separator = "-" * 64
        for image in result.images:
            tags = "、".join(image.tags) if image.tags else "（无标签）"
            lines.extend(
                [
                    separator,
                    f"仓库：{image.repo}",
                    f"标签：{tags}",
                    f"摘要：{image.digest}",
                    f"链大小：{image.total_size_bytes} 字节（total_size_bytes）",
                    f"缓存时间：{image.cached_at}",
                ]
            )
        lines.append(separator)
    lines.extend(
        [
            "说明：total_size_bytes（链大小）是拉取该条目所需链"
            "（manifest + config + layers）的字节数；条目之间共享 blob，"
            "不可把各条链大小求和当作缓存占用。",
            "注记：同一镜像可能出现「index 条目 + 平台 manifest 条目」两行，"
            "后者标签列表为空。",
        ]
    )
    return "\n".join(lines) + "\n"
