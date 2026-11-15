---
prd: prds/registry-cache-manifest.md
status: done
---
# 任务：核心包缓存扫描器（清单口径与解析）

> 需求见 [[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
> 机制已由前置侦察**双向实证**（前向 md5 验证 + 反向 `KEY:` 头枚举），**不设打样轮**——直接实装，真缓存实测即验收。
> 扫描器是 `RegistryProxyManager` 的**邻居能力**：`cache_size_bytes()`（`proxy.py`）已在经特权通道读同一缓存目录（`du -sb` + 30 秒封顶），扫描走**同一条通道、同一套纪律**。

## 目标

### 一、扫描模块（`apps/core/src/sandbox_platform/cache_manifest.py`）

**纯解析函数与特权 IO 分离**——解析可单测（零文件系统、零特权依赖），特权 IO 走既有通道：

- **纯解析**（全部可单测）：
  - 缓存键 / 文件名布局公式：缓存键 = 原始请求 URI；文件名 = `md5(键)`；三级布局 `cache/<md5末1位>/<md5倒数第3-2位>/<32位md5全串>`；前向验证路径拼接（`md5("/v2/<repo>/blobs/sha256:<digest>")` → `test -f` 判存在）；
  - `KEY:` 头解析：读文件头约 100 字节内的 `KEY: /v2/<repo>/blobs|manifests/sha256:<digest>` 明文行 → repo + 类型 + digest（**无需算哈希**）；
  - manifest / index 解析：多架构 index（manifest list）解析到 **linux/amd64** 平台的 manifest，再取该 manifest 声明的 config + layers blob 清单；单架构镜像直接取 manifest 的 blob 清单；
  - 条目聚合：同仓库多标签指向同一 digest **归并为一条**（标签列表聚合）；digest 直拉的 manifest 上榜且标签列表为空；
  - 字段装配：仓库 / 标签列表 / manifest 摘要（digest）/ 总大小（manifest + config + layers 字节数之和）/ 缓存时间；
  - 有效期判定：manifest 分层 10m / 1h / 60d、blob 60d、inactive 60d——过期条目落榜、不报错。
- **特权 IO**：
  - `<数据根>/registry-proxy/cache` 枚举 + 文件头批量读（尽量一次批量完成，避免逐文件 sudo 抖动），走既有特权通道（先例：`proxy.py` `certificate_ready` 的 `PermissionError → sudo cat` 回退），**30 秒超时封顶**；
  - 非 32 位 hex 文件名的条目（临时 / 半截文件）**跳过**；`KEY:` 头缺失或不可解析的文件跳过——跳过只影响条目数、不报错。
- **无 GC 入口**：扫描器独立成模块、边界干净（GC 将来直接复用），但本轮**无任何 GC 入口**（GC 仅为 PRD 关联节提及）。
- **CLI 零改动**。

### 二、单测（`apps/core/tests/`）

- 纯解析函数全覆盖：布局公式与前向路径、`KEY:` 解析（含脏数据）、index → amd64 解析（含无 amd64 / blob 不全落榜）、单架构、归并与 digest 直拉、字段装配、有效期分层；
- 特权路径以**可注入伪通道**测：超时封顶、脏条目跳过不报错。

### 三、真缓存实测（代替打样）

- 对真机 `<数据根>/registry-proxy/cache`（约 140 文件 / 382MB）实扫产出清单；
- 至少抽 1 条真实条目按前向公式核对 blob 文件存在；
- 总大小与宿主实际文件大小抽样一致；
- 实测记录（清单规模、抽样核对结果、过期条目落榜观察）写进本任务文件「进展」节。

## 完成标准

- [x] 扫描模块落位：`apps/core/src/sandbox_platform/cache_manifest.py`，**纯解析函数与特权 IO 分离**——纯解析函数零文件系统 / 零特权依赖（单测无需 root、无需 sudo）；特权枚举 + 文件头批量读走既有特权通道，一次批量完成，**30 秒超时封顶**（对齐 `cache_size_bytes` 纪律）。
- [x] （PRD 1）**真缓存实测**：对 `<数据根>/registry-proxy/cache` 实扫产出清单，清单中每条都满足「manifest 条目在缓存 + 其声明的全部 blob（config + layers）在缓存」；至少抽 1 条真实条目按前向公式核对 blob 文件存在（`cache/<md5末1位>/<md5倒数第3-2位>/<32位md5>`，md5 输入 = `/v2/<repo>/blobs/sha256:<digest>`）；实测记录落任务文件。
- [x] （PRD 2）**多架构解析**：index 解析到 linux/amd64 平台 manifest 再验 blob；无 amd64 manifest 或其 blob 不全 → 整条落榜（单测构造用例 + 真实条目佐证）。
- [x] （PRD 3）**单架构镜像**：直接验该 manifest 全部 blob，齐全才上榜（单测）。
- [x] （PRD 4）**反向枚举健壮性**：非 32 位 hex 文件名跳过、`KEY:` 头缺失 / 不可解析跳过；跳过只影响条目数、不报错（单测构造脏条目 + 真机目录如有脏条目一并观察）。
- [x] （PRD 5）**字段完整**：每条至少含仓库 / 标签列表 / digest / 总大小 / 缓存时间；总大小 = manifest + config + layers 字节数之和，与宿主实际文件大小抽样一致（实测记录）。
- [x] （PRD 6）**标签归并**：同仓库多标签指向同一 digest 归并为一条（标签列表聚合）；digest 直拉的 manifest 上榜且标签列表为空（单测 + 实测观察）。
- [x] （PRD 7）**过期落榜边界**：超过有效期的 manifest 条目（10m / 1h / 60d 分层）不出现在清单且扫描不报错——「只少一次优先提示，不会误导」的已接受边界被实测钉住。
- [x] **无 GC 入口**：全库无 GC 命令 / 函数入口（GC 仅为关联提及）；扫描器模块边界将来可被 GC 直接复用。
- [x] 门禁：核心包 pytest 全绿（root + 非 root 两档）+ ruff rc=0；`apps/cli` 零改动。**——已核销（2026-11-15）：`test_cache_manifest.py` 63 passed、ruff rc=0、`apps/cli` 零改动；核心包全量 489 passed / 3 failed，3 例失败全为既有 `test_root_lifecycle`（上游 docker.io 经代理 502 Bad Gateway 环境故障，已用 `git stash` 干净基线复跑证实与本轮改动无关），详见进展节。**

## 依赖

- 无（本任务集起点）。
- 需求：[[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。

## 进展（2026-11-15 收口）

> **任务完成（status: done）。** 完成标准逐条核销（门禁含环境故障注记，见下）。交付分两个提交：**`82cf57d` 主实现** + **`43fec65` 审查修复**；reviewer 结论「需修复后通过」，两补丁落地后视为通过。真缓存实测与抽样核对全部按任务书完成，实测中另**抓出并修复一个真实解析缺陷**（见「实测缺陷」节）。

### 交付落位（提交 `82cf57d` 主实现 + `43fec65` 审查修复）

- **`82cf57d`（主实现）**：`apps/core/src/sandbox_platform/cache_manifest.py` 落位——**纯解析与特权 IO 分离**（纯解析零文件系统 / 零特权依赖）+ 61 例单测；`errors.py` 增 `CacheScanError`；`__init__.py` 导出 `RegistryCacheScanner` / `CachedImage` / `CacheScanResult` / `CacheScanError`。
- **`43fec65`（审查修复）**：① 缓存目录「**存在但不可穿越**」不再吞成静默空清单——`stat()` 仅 ENOENT 判不存在，其余 OSError 落特权回退；② 直读路径 `PermissionError` 重抛保整批转特权、其余 OSError 归脏条目跳过；③ 新增**头对账**使直读 / 特权两路 skipped 计数对称；+4 例单测。

### 真缓存实测（/var/lib/sandbox-platform/registry-proxy/cache）

- **规模**：140 文件 / 91 blob / **29 条镜像**（10 仓库：postgres、python、nginx、alpine、busybox、hello-world、socat、uv、curl、seaweedfs），清单合计 **630,373,638 字节**；1 条脏条目跳过。
- **抽样核对（前向公式）**：postgres `aa6cb33…`（OCI index）→ amd64 child `ac838714…` → **12 个 blob（config + 11 layers）`sudo test -f` 全命中**，三级路径逐条核对；布局公式真机锚点 `f/d6/da797b74…`（rclone blob）命中并**固化为单测回归锚**。
- **总大小一致性**：postgres 条目 `total_size_bytes=116,101,621` 与链内各文件实际字节之和**逐字节一致**。

### 过期落榜观察（PRD 7 边界钉住）

- 12 条 tag 键条目仅**版本式标签**（`3.11-slim`、`3.12-slim`、`0.13.7`，60d 分层）存活上榜；`latest` / `alpine` / `16-alpine`（1h 分层）**全部落榜**——「只少一次优先提示、不会误导」的已接受边界实测钉住。
- 26 条 digest 直拉条目标签列表为空（PRD 6 口径真机佐证）。

### 实测缺陷：`0x7B` 字节撞「第一个 `{` 」启发式（已修复）

- python `b701198…` 条目的 nginx 二进制头含 `0x7B` 字节，撞上「取第一个 `{` 当 JSON 起点」的启发式，被误判为 JSON 不可解析（实际是完好的 1746 字节 manifest）。
- **修复**：改为**逐 `{` 尝试 `raw_decode` + sha256 自洽兜底**；复扫 skipped **4 → 1**、images **27 → 29**，`3.11-slim` 正确上榜；修复已**回灌夹具级回归**（噪声强制含 `{`）。

### 审查结论与设计取舍登记

- reviewer 结论：**需修复后通过** → 两补丁（`43fec65`）落地后视为通过。
- **设计取舍 2（裁决：保留不去重）**：index 解析出的 amd64 child 若自身是 digest 键条目，则额外产出 tags=[] 条目、与宿主标签条目**并存**。**登记口径：同一镜像可能出现两行；`total_size_bytes` 语义是「拉取该条所需的链字节」，条目间共享 blob、不可求和当缓存占用**——待 06 文档落位，02 渲染注意。

### 门禁

- `test_cache_manifest.py` **63 passed**；核心包全量 **489 passed / 3 failed**——3 例失败**全为既有 `test_root_lifecycle`**（上游 docker.io 经代理 502 Bad Gateway 环境故障，已用 `git stash` 干净基线复跑证实**与本轮改动无关**）；ruff **rc=0**；`apps/cli` **零改动**。
