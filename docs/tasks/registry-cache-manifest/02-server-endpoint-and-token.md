---
prd: prds/registry-cache-manifest.md
status: done
---
# 任务：服务端缓存清单端点与受限令牌

> 需求见 [[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
> 依赖 01 的扫描器（单测可先以**伪扫描器注入**开发，实机联调等 01）。
> text 格式存在的理由：**基础镜像只有 curl 没有 jq，禁止让 bash 解析 JSON**——服务端义务是提供预渲染文本。

## 目标

### 一、端点 `GET /api/proxy/cache/images`

- 挂 `apps/web/backend/src/sandbox_console/routes/proxy.py`（既有 `APIRouter(prefix="/proxy")`）旁；
- `?format=json|text`：缺省 `json`；非法值 **422**（API.md 写明随 06 落库）；
  - **json**：生成时间戳 + 清单数组（字段同 PRD 验收 5：仓库 / 标签列表 / digest / 总大小 / 缓存时间），`Content-Type: application/json`；
  - **text**：**预渲染文本**（`text/plain`）：表头 + 逐行条目 + 生成时间——bash（`cached-images`）直接输出可读；
- 调核心包扫描器（01）；**扫描按需执行 + TTL 内存缓存钉 60 秒**，json 与 text **共享同一份**扫描结果（同一生成时间戳）；
- 扫描 **30 秒封顶**（对齐核心包 `cache_size_bytes` 纪律）；
- **失败语义**：特权读失败或超时 → **503 + 固定中文文案**，**不静默回空清单**（空清单会误导「没有缓存」）。

### 二、受限令牌凭据文件

- 平台数据根下新文件 **`cache-images-token.json`**（钉名；0600；随机值带 **`sbxr_`** 前缀，与 `sbx_` / `sbxt_` 同族；启动幂等——已存在不覆盖；仿 `console-token.json` 先例，见 `auth.py` `TOKEN_FILENAME`）；
- **不得**放进 `<数据根>/registry-proxy/` 子树（root 属主排除区）；
- **缺失 / 损坏不阻断服务启动**：打 WARNING、受限读径 401——与主令牌「缺了起不来」刻意不同。

### 三、`BearerAuthMiddleware` 双凭据限界（`apps/web/backend/src/sandbox_console/auth.py`）

- 扩展为识别**两种凭据**：请求期与两个值比对（**常量时间**）；主令牌机制与现状完全不变；
- **受限令牌仅**对 `GET /api/proxy/cache/images` 这一条只读读径有效（按**路由 + 方法**限界放行）；其余路径与任何非 GET 方法一律 401（含 `POST /api/auth/ticket` 换票据——票据是全权能力）；
- **轮换语义**（PRD 20 的服务端半边）：运行中的服务**无需重启**，重写凭据文件后旧令牌立即 401、新令牌生效（机制自定：每请求读文件或 mtime 失效缓存皆可，以实测为准）。

### 四、单测（`apps/web/backend/tests/`，如 `test_cache_images.py`）

- 鉴权矩阵逐格覆盖（见完成标准 PRD 12）、两格式、422、503、TTL 行为（可注入时钟 / 伪扫描器）、凭据文件幂等与健壮性、401 固定文案不泄露宿主路径与文件名。

## 完成标准

- [x] （PRD 8）**401 负例**：无凭据 401、错误完整令牌 401、错误受限令牌 401；固定中文文案，**不泄露宿主路径与文件名**（单测断言响应体不含路径 / 文件名）。
- [x] （PRD 9）`?format=json`（缺省同）返回 JSON：生成时间戳 + 清单数组，字段同验收 5；`Content-Type: application/json`（单测）。
- [x] （PRD 10）`?format=text` 返回预渲染文本（`text/plain`）：表头 + 逐行条目 + 生成时间，bash 直接输出可读；与 json 来自**同一份扫描结果**（同一生成时间戳）（单测）。
- [x] （PRD 11）`format` 非法值 → **422**（单测钉行为；「API.md 写明」部分随 06 的 PRD 29 落库）。
- [x] （PRD 12）**鉴权矩阵**：完整令牌对新端点与既有全部 API 一切照旧 200；受限令牌**仅** `GET /api/proxy/cache/images` 200——对其余路径（实测至少 `GET /api/proxy/status`、`GET /api/sandboxes`、`GET /api/health`）与任何非 GET 方法（实测对新端点 POST 一次）一律 **401**；受限令牌**不能换票据**（`POST /api/auth/ticket` 401）（单测逐格覆盖）。
- [x] （PRD 13）**凭据文件**：平台数据根下（**不在** `registry-proxy/` 子树）、权限 0600、随机值（`sbxr_` 前缀）、启动幂等（已存在不覆盖）；文件缺失 / 损坏时服务**照常启动**（WARNING + 受限读径 401），不阻断（单测覆盖正常 / 已存在 / 缺失 / 损坏四情形）。
- [x] （PRD 14）**TTL 缓存**：扫描按需执行、TTL 钉 60 秒——TTL 内重复请求生成时间戳不变、过期后重扫时间戳更新；json 与 text 共享同一缓存（单测以可注入时钟钉）。
- [x] （PRD 15）**失败语义**：特权读失败或超时（30 秒封顶，对齐 `cache_size_bytes` 纪律）→ 端点 **503 + 固定中文文案**，**不静默回空清单**（单测以伪扫描器注入失败 / 超时）。
- [x] **轮换（PRD 20 服务端半边）**：运行中重写凭据文件后旧令牌立即 401、新令牌生效，无需重启服务（单测或实测记录）。
- [x] 门禁：服务端 pytest 全绿（≥ 基线）+ ruff rc=0；`apps/cli` 零改动。**——已核销（2026-11-15）：服务端 pytest 全量 381 passed / 0 failed（基线 348 + 新增 32 + 收尾补 1）、ruff rc=0；`apps/cli` 与 `docs/` 零改动，详见进展节。**

## 依赖

- 依赖 [[tasks/registry-cache-manifest/01-core-cache-scanner.md|01 核心包缓存扫描器]]（端点调用扫描器；单测可先以伪扫描器注入开发，实机联调等 01）。
- 需求：[[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。

## 进展（2026-11-15 收口）

> **任务完成（status: done）。** 完成标准逐条核销（门禁数字注记见清单末条）。交付分两个提交：**`ab95fa1` 主实现** + **`dea6828` 审查收尾**；reviewer 结论「通过（无 Critical）」，五项设计取舍全部裁决接受，两项审查建议已随收尾提交落实。单测全走**伪扫描器注入**（任务书允许），真实特权通道扫描的端到端验证随 03 注入链路一起验。

### 交付落位（提交 `ab95fa1` 主实现 + `dea6828` 审查收尾）

- **端点 `GET /api/proxy/cache/images`**（`routes/proxy.py`）：`?format=json|text` 缺省 `json`；非法值**手动判定 422**——框架 `RequestValidationError` 处理器把非缺字段校验统一映射 400，`Literal` 声明式校验不可用，故放弃。
- **json 格式**：`to_payload`（生成时间戳 + 清单数组）。
- **text 格式**：预渲染文本——表头 + 逐条目块 + 生成时间 + **两则防误读尾注**：① `total_size_bytes` 是「拉取该条所需的链字节」，条目间共享 blob、不可求和当缓存占用；② 同一镜像可能出现 index 条目 + 平台 manifest 条目两行——**落实任务 01 审查裁决**。
- **TTL 内存缓存 `CacheImagesCache`**：钉 60 秒——单调时钟可注入、扫描器工厂可注入、**失败不入缓存**、json / text 共享同一实例同一时间戳。
- **失败语义**：`CacheScanError` → **503 固定中文文案**，异常原文只进日志、不进响应体。
- **凭据文件 `cache-images-token.json`**：数据根下钉名、0600 原子写、`sbxr_` 前缀；启动幂等——已存在不覆盖、缺失 → 生成、损坏 → WARNING + 保留原文件 + 受限读径 401，**不阻断启动**。
- **`BearerAuthMiddleware` 双凭据**：`classify_bearer` 先比完整令牌再读受限文件，两处均 `token_matches` 常量时间比较；受限令牌按**路由 + 方法双限界**，仅放行 `GET /api/proxy/cache/images`；401 复用主令牌同一句固定文案，不泄露路径 / 文件名；**主令牌行为零变化**。
- **轮换语义**：每请求重读凭据文件——无需重启，旧令牌立即 401、新令牌生效。
- **`dea6828`（审查收尾）**：AST 令牌契约白名单两份名字集补 `restricted`；受限放行改严格全等 `GET`，并补小写 `get` 被拒用例。

### 审查结论与取舍登记

- reviewer 结论：**通过（无 Critical）**。
- **五项取舍全部裁决接受**：每请求重读凭据文件、凭据文件损坏不重新生成、中间件层 401（路由不执行）、HEAD 与小写 `get` 拒绝、无锁并发双扫不加锁。
- 两项审查建议（AST 令牌契约白名单补 `restricted`、受限放行改严格全等 `GET` + 小写 `get` 被拒用例）已随 `dea6828` 落实。

### 门禁

- 服务端 pytest 全量 **381 passed / 0 failed**（基线 348 + 新增 32 + 收尾补 1）；ruff **rc=0**；`apps/cli` 与 `docs/` **零改动**。

### 实机联调说明

- 单测全走**伪扫描器注入**（任务书允许）；真实特权通道扫描的端到端验证随 03 注入链路一起验。

### 遗留登记（非本轮缺陷）

- **每请求重读凭据文件**复用 `read_token_file`，带 stat + chmod 写副作用：权限可能漂移，且 chmod 持续失败时未认证探测流量可放大 WARNING 日志——reviewer 判**非阻断**，登记备查。
