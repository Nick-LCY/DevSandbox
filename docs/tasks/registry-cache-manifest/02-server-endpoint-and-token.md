---
prd: prds/registry-cache-manifest.md
status: todo
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

- [ ] （PRD 8）**401 负例**：无凭据 401、错误完整令牌 401、错误受限令牌 401；固定中文文案，**不泄露宿主路径与文件名**（单测断言响应体不含路径 / 文件名）。
- [ ] （PRD 9）`?format=json`（缺省同）返回 JSON：生成时间戳 + 清单数组，字段同验收 5；`Content-Type: application/json`（单测）。
- [ ] （PRD 10）`?format=text` 返回预渲染文本（`text/plain`）：表头 + 逐行条目 + 生成时间，bash 直接输出可读；与 json 来自**同一份扫描结果**（同一生成时间戳）（单测）。
- [ ] （PRD 11）`format` 非法值 → **422**（单测钉行为；「API.md 写明」部分随 06 的 PRD 29 落库）。
- [ ] （PRD 12）**鉴权矩阵**：完整令牌对新端点与既有全部 API 一切照旧 200；受限令牌**仅** `GET /api/proxy/cache/images` 200——对其余路径（实测至少 `GET /api/proxy/status`、`GET /api/sandboxes`、`GET /api/health`）与任何非 GET 方法（实测对新端点 POST 一次）一律 **401**；受限令牌**不能换票据**（`POST /api/auth/ticket` 401）（单测逐格覆盖）。
- [ ] （PRD 13）**凭据文件**：平台数据根下（**不在** `registry-proxy/` 子树）、权限 0600、随机值（`sbxr_` 前缀）、启动幂等（已存在不覆盖）；文件缺失 / 损坏时服务**照常启动**（WARNING + 受限读径 401），不阻断（单测覆盖正常 / 已存在 / 缺失 / 损坏四情形）。
- [ ] （PRD 14）**TTL 缓存**：扫描按需执行、TTL 钉 60 秒——TTL 内重复请求生成时间戳不变、过期后重扫时间戳更新；json 与 text 共享同一缓存（单测以可注入时钟钉）。
- [ ] （PRD 15）**失败语义**：特权读失败或超时（30 秒封顶，对齐 `cache_size_bytes` 纪律）→ 端点 **503 + 固定中文文案**，**不静默回空清单**（单测以伪扫描器注入失败 / 超时）。
- [ ] **轮换（PRD 20 服务端半边）**：运行中重写凭据文件后旧令牌立即 401、新令牌生效，无需重启服务（单测或实测记录）。
- [ ] 门禁：服务端 pytest 全绿（≥ 基线）+ ruff rc=0；`apps/cli` 零改动。

## 依赖

- 依赖 [[tasks/registry-cache-manifest/01-core-cache-scanner.md|01 核心包缓存扫描器]]（端点调用扫描器；单测可先以伪扫描器注入开发，实机联调等 01）。
- 需求：[[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
