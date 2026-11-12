# 控制台前端托管到 Cloudflare（Workers + 静态资产）

> 日期：2026-11-11
> 二期需求见 [[prds/phase2-console.md]]，三期需求见 [[prds/phase3-desktop.md]]，运行期文件传输轮见 [[prds/runtime-file-transfer.md]]
> 本轮任务集见 [[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]
> 决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]（**已接受**）
> **核销状态（2026-11-12）：验收标准 27 条已逐条核销完毕（27 / 27，证据见下文「验收标准」）**——全轮 01~05 全部 done；全轮留档见 [[tasks/console-cloudflare/RESULTS.md|控制台前端托管到 Cloudflare 全轮收口留档]]。

## 背景

网页控制台的前端与后端**至今同源同进程**：后端用 `StaticFiles` 把前端构建产物（`dist`）挂在 `/`，健康自检 `/api/health` 回一个 `console_mounted` 字段告诉前端「产物挂上了没」，前端据此决定是进工作台还是显示降级文案「前端产物未挂载」。这条同源同进程的链路从二期起一直没断过。

它带来三个痛点：

1. **后端被迫兼做静态服务器**——一个纯 API 服务要额外承担静态资源托管职责：`StaticFiles` 挂载、`SANDBOX_CONSOLE_DIST` 目录发现、目录缺失时跳过挂载并告警、`console_mounted` 自检字段、降级文案，全部是「为了把前端塞进来」而存在的能力链。
2. **验收套件绑死同源前提**——Playwright 套件的 `baseURL` 直接指向后端，`storageState` 的 origin 就是后端 origin，页面里的 `page.request` 用的都是**相对 URL**（`/api/...`）。这套形态**只验证了「后端能同时当 API 和静态服务器」**，从未验证过生产上真正要用的「前端在别处、后端只提供 API」的形态。
3. **前端不能独立发版**——改一行前端也要动后端进程（重启服务、连带影响 API 可用性），前后端无法各自按节奏发布。

另外两条现实约束：

- **本仓零 IaC**：仓库里没有 Terraform、Ansible 等基础设施即代码；唯一的反代（Traefik）在**外部 infra 仓**，仓库内只留了一份参考单元 `apps/web/backend/sandbox-console.service`。本轮要把 Cloudflare 侧的域名层纳入版本管理，就必须在**本仓引入 IaC**。
- **治理上存在历史冲突**：[[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 第 6 节「Cloudflare 静态托管的退役」明写「原『前后端分离部署』里的 Cloudflare 静态站托管**正式退役**，不再规划、不再留待办……将来若重提静态托管，按新需求独立立项」。本轮就是那次「重提」：**独立立项、单向取代**。ADR 0013 的历史表述**不改写**，由 ADR 0019 单向取代（取代关系只写在 ADR 0019 与决策清单里）。

## 目标

- **前端托管到 Cloudflare**：载体 = **Cloudflare Workers + 静态资产**（**不是 Pages**），自定义域名 **`dev.sankabox.com`**。
- **后端纯 API 化**：把「托管前端」这条能力链**整体删除、不留兼容层**——`StaticFiles` 挂载链、`SANDBOX_CONSOLE_DIST` 目录发现、`console_mounted` 字段、前端降级文案全部下线；后端只提供 `/api`。
- **域名层纳入 IaC**：Terraform 管理 Cloudflare 域名层，代码放本仓 `infra/`，**远端状态存真实 AWS S3**（**用户于 2026-11-11 改定，不再用 MinIO**；region `ap-southeast-1`、桶 `terraform-654654240294-ap-southeast-1-an`、**AWS 默认端点**；**桶归属账号与本机凭据账号不一致（403），三选一待拍板**）。
- **验收套件迁到独立本地静态源**：Playwright 套件的 `baseURL` 改指本地静态源，**页面 origin ≠ 后端 origin**——**与生产跨源形态同构**，把「同源」这个隐含前提从验收基线里彻底拿掉。
- **前端可独立发版**：前端改动不再需要重启后端进程。
- **前置条件已具备（不需要额外改造连接层）**：
  - 前端用**哈希路由**（`#/sandboxes/...`）⇒ 不依赖服务端回退规则；
  - Vite `base: './'`（相对基址）⇒ 同一份 `dist` 在**任意静态源**下都能正确解析 `/assets/*`；
  - 请求基址**恒为绝对地址**（ADR 0015 决策 D：「空基址 = 同源」已废除）；
  - 后端 **CORS 任意来源**（ADR 0013 第二次修订）⇒ 跨源直连成立。
  - 结论：**同一份 `dist` 放到任意静态源都开箱可用，业务代码零改动**。

## 非目标

- **桌面端零改动**：Tauri 的 `frontendDist` 是独立装载路径，与本轮的静态托管无关，**不动**。
- **平台端到端基建零改动**：`apps/web/e2e/`（平台侧 sample-page 套件）不参与本轮，**不动**。
- **不做 CI**：部署 = **手动** `wrangler deploy` + `terraform apply`；本轮不引入流水线。
- **不做后端公网暴露的架构改造**：后端仍走既有 Traefik 链路（`sandbox-api.sankabox.com`），**暴露面与令牌策略不动**。
- **不做 `console_mounted` 兼容层**：健康检查接口**破坏性变更**，不保留旧字段、不做双写、不做「按客户端版本返回」。
- **不做多环境 IaC 矩阵**：**单个 root module + workspace**，不铺 staging / prod 多套。
- **Terraform 不接管 Worker 脚本**：脚本与静态资产归 `wrangler` 管（**单一所有者原则**，见「方案 ⑤」）。
- **不改连接层业务代码**：基址推导、WebSocket 地址推导、令牌与票据、CORS 口径**一律不动**。

## 方案

### ① 后端纯 API 化

- 删除整条「后端托管前端」的能力链：`StaticFiles` import 与挂载调用、四个 dist 相关常量（`BACKEND_DIR` / `WEB_DIR` / `FRONTEND_DIST_DIR` / `ENV_CONSOLE_DIST`）、两个 dist 目录解析函数、`_mount_console` 函数与其调用点。
- `/api/health` **删除 `console_mounted` 字段**（响应字段集合恰为 `{status, version, data_root_configured}`）；`HealthResponse` 模型同步删字段。
- **`GET /` 与 `GET /assets/*` 一律返回 404**（后端不再有任何静态路由）——由验收用例**双向钉死**：静态源根返回 200 且含控制台页面标识，后端根返回 404 且**不含** `<html`。
- **令牌闸行为不变**：`/api` 无令牌仍 401（原文案不变）；非 `/api` 路径不拦令牌闸，但 `/` 本身 404。
- 口径改写：`app.py` 模块头、`create_app` docstring、`__main__.py` 启动 docstring、`auth.py` 的 `BearerAuthMiddleware` 与 `_install_connection_middleware` 注释统一写成「本服务只提供 `/api`、不再托管静态资源，前端由 Cloudflare Workers 独立托管（见 ADR 0019）」——**注释只说现在是什么，不写历史**。

### ② 前端仅删降级分支

- `types.ts` 删除 `console_mounted` 字段；`HealthState` 删除 `'degraded'` 态；`Workbench.tsx` 删除降级分支（健康检查成功即 `ok`）；`Sidebar.tsx` 的样式分支**零改动**（`'degraded'` 分支随类型一并消失，样式实现不动）。
- **零构建期注入**：不需要在构建时把后端地址写进产物。
- **连接层零改动**。
- 哈希路由 ⇒ **无需服务端回退规则**（Workers 侧的 `not_found_handling` 可以直接用 `none`）。

### ③ 验收套件迁独立静态源

- **新增 `tests/helpers/static.ts`**：用 `vite preview --host 127.0.0.1 --port <CONSOLE_STATIC_PORT> --strictPort` 起一个**独立本地静态源**（`cwd` = `apps/web/frontend`），复用既有 `helpers/server.ts` 的「端口等待 + 进程启停」套路。
  - **`--strictPort` 是硬要求**：端口被占时**直接失败**，不静默换端口——否则 `storageState` 注入的 origin 与实际 origin 不一致，整套套件会在一个错的 origin 上跑。
  - **绑 `127.0.0.1` 是硬要求**：保证是**安全上下文**（`http://127.0.0.1` 与 `localhost` 同为 secure context），剪贴板 API 在非安全上下文不可用。
- **`playwright.config.ts` 的 `baseURL` 改指静态源 origin**。
- **`helpers/connection.ts` 的 `writeStorageState` 改为 `({pageOrigin, backendPort})`**：`storageState` 的 origin = **静态源**，连接配置里的后端基址 = **后端**——**两者刻意不同源**，与生产形态（前端在 CF 域名、后端在 API 域名）同构。
- **`helpers/server.ts` 删掉 `SANDBOX_CONSOLE_DIST` 注入**（后端不再托管前端）；`helpers/paths.ts` 的 `CONSOLE_DIST_DIR` 保留但**只作注释口径**。
- **`global-setup` 起静态源**并扩展交叉断言：静态源**实际端口 == 配置端口**、`storageState` origin **== `baseURL` origin**，不等即抛错；`global-teardown` 停静态源。
- **先冒烟再全量**：起 preview → 开 `/` → 断言页面标识可见 + assets 的 js 请求 200；再跑 `10-auth-connection`（10 条）与 `06-boundary`。
  - **回退口径**：若 `vite preview` 在 `base: './'` 下冒烟不过，回退为**自写极简 Node 静态服务器**（`node:http` + `fs` + mime 表 + SPA 回退，约 60 行）；**不得用 `http-server`**。
- **8 处相对 URL 的 `page.request.*` 改后端绝对地址**（`02-local-image.spec.ts:101`、`03-terminal.spec.ts:120/269/278`、`05-reclaim.spec.ts:154`、`06-boundary.spec.ts:95/100/106/107`、`09-terminal-clipboard.spec.ts:108`）——相对 URL 在页面 origin 变成静态源后会打到静态源而不是后端。
- **`06-boundary` 的单端口用例改写为「负向断言 + 正向对照」**：后端根 404 不含 `<html`；后端 `/assets/*` 404；静态源根 200 含控制台页面标识（**正向对照**）；`gotoDetail` 后页面照常进详情且页面 origin 已是静态源。
- **新增 `specs/13-static-frontend.spec.ts`（2 条）**：静态源根 200 含控制台页面标识；后端根 404 不含 HTML。
- **`10-auth-connection.spec.ts` 代码零改动**：`page.goto('/')` 的相对路径语义自动变为静态源根；其 `page.request` 本就是绝对地址。

### ④ Cloudflare 侧：Workers + 静态资产

- **载体 = Workers + 静态资产（`[assets]`），不是 Pages**。
- Worker 脚本是**纯 JS ESM 极简 passthrough**（非资产路径返回 404）；静态资产由 Workers 的 assets 绑定直接服务。
- `wrangler.toml`：`name`、`main = src/index.js`、`compatibility_date`（填当天）、`account_id`（**非机密，可入库**）、`[assets]` 的 `directory` 指向前端 `dist`、`binding = ASSETS`、`run_worker_first = false`、`not_found_handling = none`（哈希路由不需要回退）。
- **API Token 只走环境变量** `CLOUDFLARE_API_TOKEN`，**绝不入库**。

### ⑤ Terraform 底座

- **目录**：本仓新增 `infra/`——**单个 root module + workspace**（不做多环境矩阵）。
- **`versions.tf`**：`required_version >= 1.9`；cloudflare provider **精确 pin**；`.terraform.lock.hcl` **入库**。
- **`backend.hcl` 占位**：`backend "s3"` 空块 + `backend.hcl.example` 占位文件——`bucket` / `key`（带 workspace 前缀）/ `region` / `workspace_key_prefix`。**2026-11-11 改定为真实 AWS S3**：`endpoint` / `use_path_style` / 四个 `skip_*` **不设**（走 AWS 默认端点与原生校验）；**MinIO 变体作为注释块保留**在 `backend.hcl.example` 里（若回退到 MinIO，照抄该块）。
- **凭据只走环境变量**：`TF_VAR_*` 传变量、`AWS_*` 传后端凭据；**无真实凭据入库**。
- **单一所有者原则**：`main.tf` 的资源清单**恰为** `cloudflare_zone` data + `cloudflare_workers_custom_domain` 资源——**不声明 `cloudflare_workers_script`**（脚本与资产归 `wrangler`）。文件头注释写明这条原则。
- **部署顺序**：`wrangler deploy` **先**、`terraform apply` **后**——域名资源要指向一个**已存在**的 Worker。

### ⑥ 发版节奏

- **先发后端、再发前端**；允许**短暂不兼容窗口**：旧前端读到 `console_mounted` 为 `undefined` 时判「未挂载」，只显示降级文案，**不崩**。
- 反序（先发前端、后发后端）会命中新前端读旧后端——新前端不读该字段，正常；但**后端先发**是本轮推荐顺序，因为它保留了旧前端的可降级行为。

## 验收标准

> **核销状态（2026-11-12）：全部逐条核销完毕。** 每条均挂证据；证据分四类——**门禁数字**（01 轮实测）、**部署实证**（03 / 04 轮实测）、**用户验收**（2026-11-12 用户真实浏览器八步全过）、**全轮留档**（[[tasks/console-cloudflare/RESULTS.md|控制台前端托管到 Cloudflare 全轮收口留档]]）。
> **勾选总数 = 27 条（27 / 27）**；**与原始口径有偏离的条目已按实际核销并注明**（唯一一处：**Terraform 与 Cloudflare 第 3 条**的远端状态后端——实际远超原占位口径，属**增强**）。

### 后端

- [x] 全仓 grep `StaticFiles` / `app.mount` / `SANDBOX_CONSOLE_DIST` / `console_mounted` / `BACKEND_DIR` / `FRONTEND_DIST_DIR` / `_mount_console` **零命中**（后端源码与后端测试目录）——**门禁**：01 轮审查一轮**零 Critical**、**6 条 Warning 全部修复后合入**；**27 处** `SANDBOX_CONSOLE_DIST` 注入全删（分布 `02×2` / `03×8` / `files×2` / `templates×6` / `images_proxy×1` / `forwards×5` / `terminal_sessions×3`）；证据见 [[tasks/console-cloudflare/01-backend-api-only-and-acceptance-migration.md|任务 01]] 文末「进展（收口）」。
- [x] `GET /api/health` 的响应字段集合**恰为** `{status, version, data_root_configured}`（用 `set(body) == {...}` 断言，不逐字段断言）——**门禁**：服务端 **332 passed** + `ruff` **rc=0**。
- [x] `GET /` 返回 **404** 且响应体**不含** `<html`；`GET /assets/*` 返回 **404**——**门禁**：新增用例钉死（**+2 passed**），并由 `13-static-frontend.spec.ts` 做**负向断言 + 正向对照**双保险。
- [x] 后端测试目录中 `SANDBOX_CONSOLE_DIST` **零命中**（原 27 处 `monkeypatch.setenv` 全部删除）——同上，**grep 全查零漏网**。
- [x] 令牌闸**行为不变**：`/api` 无令牌仍 **401**（原文案不变）；非 `/api` 路径不拦令牌闸、但 `/` 本身 **404**（不是 401）——**门禁**：原 `test_static_assets_are_not_blocked_by_auth` 用例改写为「不带 `Authorization` 请求 `/` → 404」。
- [x] 后端 `pytest` **全绿** + `ruff` **rc=0**（记录新的 passed 数；基线 330）——**门禁**：**332 passed**（基线 330 → **+2**）+ `ruff` **rc=0**。

### 前端

- [x] `src/` 目录 grep `console_mounted` **零命中**；**零构建期注入**（构建产物不写死后端地址）——**门禁**：前端删降级分支（`HealthState` 无 `'degraded'`、`Workbench.tsx` 无降级分支、`Sidebar.tsx` 样式分支零改动）+ mocks 全部同步；**零构建期注入**（请求基址恒从连接配置推导，见 ADR 0015 决策 D）。
- [x] `typecheck` **双零错**（web 与桌面两套）+ `vitest` **全绿**（记录新的 passed 数；基线 664）+ `build` 成功——**门禁**：vitest **665 passed**（基线 664 → **+1** 新用例）、typecheck **双零错**、build **成功**。
- [x] 桌面端 `cargo check` **0 警告** + `cargo test` **47** 不回归——**门禁**：`cargo test` **47 passed**（**本轮桌面端零改动**，零改动确认）；`cargo check` 0 警告在 01 轮门禁表内沿用既有结论（本轮无桌面端代码变更，无新增警告面）。

### 验收套件

- [x] 静态源绑 **`127.0.0.1`**（且 `--strictPort`）；**页面 origin ≠ 后端 origin**（断言写进 `global-setup` 交叉校验，不等即抛错）——**门禁**：`global-setup` 交叉断言「静态源实际端口 == 配置端口」+「`storageState` origin == `baseURL` origin」；**`vite preview` 冒烟一次通过**（回退方案未启用）。
- [x] `06-boundary` 的单端口用例改为**负向断言 + 正向对照**——**门禁**：后端根 404 且不含 `<html` + 后端 `/assets/*` 404 + 静态源根 200 含控制台页面标识（正向对照）+ `gotoDetail` 后页面照常进详情。
- [x] 新增 `13-static-frontend.spec.ts` **2 条**——**门禁**：用例数 51 → **53**（+2）。
- [x] `10-auth-connection.spec.ts` **10 条全过**且**断言零改动**——**门禁**：**代码零改动**（`page.goto('/')` 的相对路径语义自动变为静态源根），10 条全过。
- [x] e2e 全量 **53 passed / 0 failed / 0 flaky / 0 skipped**，**连续两轮全绿**（记录耗时；基线 51）——**门禁**：**53 passed / 0 failed / 0 flaky / 0 skipped**，**连续四轮全绿**（首轮两轮各 **10.1m**；审查修复轮复跑两轮 **603s / 602s**）。

### Terraform 与 Cloudflare

- [x] `terraform fmt -check -recursive` **无输出** + `terraform validate` 通过——**门禁**：02 轮门禁全绿（审查修复轮复跑仍全绿）；03 / 04 轮（改名与重绑）复跑**仍无输出 + 仍通过**。
- [x] 资源清单**恰为** zone data + `workers_custom_domain`，**无 `workers_script`**——**部署实证**：`terraform state list` **恒为 2 项**（含 2026-11-12 改名重绑后复验），**无 `workers_script`** ⇒ **单一所有者原则守住**。
- [x] `backend "s3"` 配置齐全、值全部是**占位**；`.terraform.lock.hcl` **入库**；`*.tfvars` / `*.tfstate` **未入库**。**远端状态后端 = 真实 AWS S3**（`ap-southeast-1`、**不设 `endpoint`**、**不设 `use_path_style`**、**不设四个 `skip_*`**）；**桶归属账号与本机凭据账号不一致（403）**，需先拍板（见 [[tasks/console-cloudflare/02-terraform-base.md|任务 02]] 文末「增量（2026-11-11）」）。
  - **按实际核销（超出原占位口径，属增强）**：① **真实 `backend.hcl` 已落本机、**不入库**（`.gitignore` 已忽略，**零凭据入库**）；② 远端状态后端**已是真实 AWS S3**（**不再用 MinIO**：删 `endpoint` / `use_path_style` / 五个 `skip_*`，MinIO 变体留注释块）；③ **跨账号 403 已解除**——走**方案 c**（桶**同账号** IAM 用户 `TerraformUser` 的 AK/SK 经 `infra/.env` 注入，**未入库、未回显**）⇒ 真实 `init` **成功**；④ **S3 原生锁已开**（`backend.hcl` 设 `use_lockfile = true`，锁对象 `dev-sandbox/terraform.tfstate.tflock` **实测生成并正常释放**）——**这一条超出原口径，属增强**。
- [x] `wrangler deploy` 成功——**部署实证**：**成功**——Worker **`dev-sandbox`**、地址 **`https://dev-sandbox.nucbox.workers.dev`**、**123 资产**、版本 id **`9e12fa39-d92b-48ed-8e8a-ea6978fbb4f7`**；`deploy` 脚本**先 build 再 deploy，一条命令**（避免「以为部署了新前端、其实还是旧 `dist`」）。
- [x] `https://dev.sankabox.com` **返回控制台页面**——**部署实证**：**首探即 200**（证书即时签发），body 含 `page-layout-title` 与 `assets/index-*.js`，与 `workers.dev` 内容 **byte 级一致**（同一 sha256）；资产直出 **200**、非资产路径 **404**。

### 真机浏览器验收

- [x] 从 CF 域名连 `https://sandbox-api.sankabox.com`，全功能可用：引导面板 → 填地址与令牌 → 工作台 → 健康 `ok` 且**无降级文案** → 列表 / 新建（含镜像选择器）/ 详情 / 网页终端（连上、敲命令、断开重连）/ 停止 / 删除 / 模板 / 文件注入 / 运行期文件面板 → 剪贴板可用。
  - **用户验收（2026-11-12）**：**用户于真实浏览器逐条执行八步、全部通过**（引导面板 → 填 `https://sandbox-api.sankabox.com` 与令牌 → 工作台 → 健康 `ok` **无降级文案** → 沙箱生命周期（含终端**连上敲命令、断开重连**）/ 停止 / 删除 → 模板 → 文件注入 → 运行期文件面板 → 剪贴板 `Ctrl+Shift+C` / `Ctrl+Shift+V` 可用）。证据见 [[tasks/console-cloudflare/04-domain-and-live-acceptance.md|任务 04]] 文末「浏览器真机验收通过（2026-11-12，用户执行）」。
- [x] **无 CORS 预检失败**、**无混合内容告警**——**用户验收（2026-11-12）**：浏览器控制台**无 preflight 报错**、**无混合内容告警**（https 页面不加载 http 资源；后端为 https，终端 WS 走 wss）。

### 文档与治理

- [x] **ADR 0019 落档**（已接受）并**单向取代 ADR 0013 第 6 节**；[[architecture/decisions/README.md|决策清单]] 同步（新增 0019 行 + 0013 行加标注）——**已核销**：ADR 0019 于**立项日（2026-11-11）**落档、状态**已接受**；取代关系**只写在 ADR 0019 与决策清单**；**ADR 0013 本体历史表述不改写**。
- [x] [[current-state.md|看板]] 同步（活跃需求 + 任务看板 + TODO）——**已核销**：2026-11-12 同步为「01~05 全部 done、用户验收通过」口径，看板含 **RESULTS 指针**。
- [x] [[glossary.md|词汇表]] 补三条词条（控制台前端托管 / Workers 静态资产 / 后端纯 API 化）——**已核销**：三条词条已入册。
- [x] [[prds/README.md|PRD 清单]] 与 [[tasks/README.md|任务清单]] 同步——**已核销**：两条清单已补本轮条目与「01~05 全部 done」状态。
- [x] 代码区文档同步：仓库根 `README.md`、`apps/web/backend/API.md`、`apps/web/frontend/README.md`、`apps/web/backend/sandbox-console.service`、`apps/web/frontend/tests/README.md`——**已核销**：前四项在 **01 轮**同步；根 `README.md` 的 **`infra/` 目录行**与**前端部署命令口径**在 **05 轮**补齐；`apps/web/frontend/README.md` 的 **CF 形态与 `pnpm run deploy` 口径**在 **05 轮**补齐。
- [x] **历史不改写清单**：[[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 本体、[[prds/phase2-console.md|二期 PRD]]、[[tasks/phase2-console/01-service-core-api.md|二期任务 01]] **保持原样**——**已核销**：三者**零改动**（ADR 0013 仅**追加指向性标注**，**历史表述一字未改**）；ADR 0018 及其任务集**本轮零改动**。

## 相关文档

- 任务集：[[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]] — 01~05 五个任务与依赖顺序。
- 决策：[[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019 控制台前端托管到 Cloudflare Workers]] — 载体选型、单一所有者原则、破坏性变更与代价。
- 被取代的条目：[[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 第 6 节「Cloudflare 静态托管的退役」——**历史表述不改写**，由 ADR 0019 单向取代。
- 连接层复用：[[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015 桌面壳与连接配置抽象]] — 哈希路由、`base: './'`、恒绝对请求基址（本轮「业务代码零改动」的前提）。
- 认证与 CORS：[[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] — CORS 任意来源、准入边界 = 令牌 + 票据（跨源直连成立的前提）。
- 二期需求：[[prds/phase2-console.md]] — 控制面服务化与网页控制台的原始形态（本轮拆掉的是它的「同源同进程」部分）。
- 三期需求：[[prds/phase3-desktop.md]] — 桌面端打包与端口转发（本轮**零改动**）。
- 架构总览：[[architecture/overview.md]] — 分层结构与代码布局。
- 前端约定：[[conventions/console-frontend.md]] — 界面约定（本轮前端改动只删降级分支，不新增界面元素）。
- 词汇表：[[glossary.md]] — 文档库统一术语。
- 当前状态：[[current-state.md]] — 看板与 TODO。
