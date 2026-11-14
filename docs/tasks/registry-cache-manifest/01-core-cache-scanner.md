---
prd: prds/registry-cache-manifest.md
status: todo
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

- [ ] 扫描模块落位：`apps/core/src/sandbox_platform/cache_manifest.py`，**纯解析函数与特权 IO 分离**——纯解析函数零文件系统 / 零特权依赖（单测无需 root、无需 sudo）；特权枚举 + 文件头批量读走既有特权通道，一次批量完成，**30 秒超时封顶**（对齐 `cache_size_bytes` 纪律）。
- [ ] （PRD 1）**真缓存实测**：对 `<数据根>/registry-proxy/cache` 实扫产出清单，清单中每条都满足「manifest 条目在缓存 + 其声明的全部 blob（config + layers）在缓存」；至少抽 1 条真实条目按前向公式核对 blob 文件存在（`cache/<md5末1位>/<md5倒数第3-2位>/<32位md5>`，md5 输入 = `/v2/<repo>/blobs/sha256:<digest>`）；实测记录落任务文件。
- [ ] （PRD 2）**多架构解析**：index 解析到 linux/amd64 平台 manifest 再验 blob；无 amd64 manifest 或其 blob 不全 → 整条落榜（单测构造用例 + 真实条目佐证）。
- [ ] （PRD 3）**单架构镜像**：直接验该 manifest 全部 blob，齐全才上榜（单测）。
- [ ] （PRD 4）**反向枚举健壮性**：非 32 位 hex 文件名跳过、`KEY:` 头缺失 / 不可解析跳过；跳过只影响条目数、不报错（单测构造脏条目 + 真机目录如有脏条目一并观察）。
- [ ] （PRD 5）**字段完整**：每条至少含仓库 / 标签列表 / digest / 总大小 / 缓存时间；总大小 = manifest + config + layers 字节数之和，与宿主实际文件大小抽样一致（实测记录）。
- [ ] （PRD 6）**标签归并**：同仓库多标签指向同一 digest 归并为一条（标签列表聚合）；digest 直拉的 manifest 上榜且标签列表为空（单测 + 实测观察）。
- [ ] （PRD 7）**过期落榜边界**：超过有效期的 manifest 条目（10m / 1h / 60d 分层）不出现在清单且扫描不报错——「只少一次优先提示，不会误导」的已接受边界被实测钉住。
- [ ] **无 GC 入口**：全库无 GC 命令 / 函数入口（GC 仅为关联提及）；扫描器模块边界将来可被 GC 直接复用。
- [ ] 门禁：核心包 pytest 全绿（root + 非 root 两档）+ ruff rc=0；`apps/cli` 零改动。

## 依赖

- 无（本任务集起点）。
- 需求：[[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
