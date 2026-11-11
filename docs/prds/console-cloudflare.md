# 控制台前端托管到 Cloudflare（Workers + 静态资产）

> 日期：2026-11-11
> 二期需求见 [[prds/phase2-console.md]]，三期需求见 [[prds/phase3-desktop.md]]，运行期文件传输轮见 [[prds/runtime-file-transfer.md]]
> 本轮任务集见 [[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]
> 决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]（**已接受**）

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
- **域名层纳入 IaC**：Terraform 管理 Cloudflare 域名层，代码放本仓 `infra/`，**远端状态存 S3 兼容对象存储**（MinIO；端点 / 桶 / 凭据**待用户提供**，配置先用占位）。
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
- **`backend.hcl` 占位**：`backend "s3"` 空块 + `backend.hcl.example` 占位文件——`bucket` / `key`（带 workspace 前缀）/ `region` / `endpoint` / **`use_path_style = true`** / `skip_credentials_validation` / `skip_region_validation` / `skip_requesting_account_id` / `skip_metadata_api_check`。**MinIO 必须 path style + 四个 skip**，否则 `terraform init` 会直接卡住。
- **凭据只走环境变量**：`TF_VAR_*` 传变量、`AWS_*` 传后端凭据；**无真实凭据入库**。
- **单一所有者原则**：`main.tf` 的资源清单**恰为** `cloudflare_zone` data + `cloudflare_workers_custom_domain` 资源——**不声明 `cloudflare_workers_script`**（脚本与资产归 `wrangler`）。文件头注释写明这条原则。
- **部署顺序**：`wrangler deploy` **先**、`terraform apply` **后**——域名资源要指向一个**已存在**的 Worker。

### ⑥ 发版节奏

- **先发后端、再发前端**；允许**短暂不兼容窗口**：旧前端读到 `console_mounted` 为 `undefined` 时判「未挂载」，只显示降级文案，**不崩**。
- 反序（先发前端、后发后端）会命中新前端读旧后端——新前端不读该字段，正常；但**后端先发**是本轮推荐顺序，因为它保留了旧前端的可降级行为。

## 验收标准

### 后端

- [ ] 全仓 grep `StaticFiles` / `app.mount` / `SANDBOX_CONSOLE_DIST` / `console_mounted` / `BACKEND_DIR` / `FRONTEND_DIST_DIR` / `_mount_console` **零命中**（后端源码与后端测试目录）。
- [ ] `GET /api/health` 的响应字段集合**恰为** `{status, version, data_root_configured}`（用 `set(body) == {...}` 断言，不逐字段断言）。
- [ ] `GET /` 返回 **404** 且响应体**不含** `<html`；`GET /assets/*` 返回 **404**。
- [ ] 后端测试目录中 `SANDBOX_CONSOLE_DIST` **零命中**（原 27 处 `monkeypatch.setenv` 全部删除）。
- [ ] 令牌闸**行为不变**：`/api` 无令牌仍 **401**（原文案不变）；非 `/api` 路径不拦令牌闸、但 `/` 本身 **404**（不是 401）。
- [ ] 后端 `pytest` **全绿** + `ruff` **rc=0**（记录新的 passed 数；基线 330）。

### 前端

- [ ] `src/` 目录 grep `console_mounted` **零命中**；**零构建期注入**（构建产物不写死后端地址）。
- [ ] `typecheck` **双零错**（web 与桌面两套）+ `vitest` **全绿**（记录新的 passed 数；基线 664）+ `build` 成功。
- [ ] 桌面端 `cargo check` **0 警告** + `cargo test` **47** 不回归。

### 验收套件

- [ ] 静态源绑 **`127.0.0.1`**（且 `--strictPort`）；**页面 origin ≠ 后端 origin**（断言写进 `global-setup` 交叉校验，不等即抛错）。
- [ ] `06-boundary` 的单端口用例改为**负向断言 + 正向对照**。
- [ ] 新增 `13-static-frontend.spec.ts` **2 条**。
- [ ] `10-auth-connection.spec.ts` **10 条全过**且**断言零改动**。
- [ ] e2e 全量 **53 passed / 0 failed / 0 flaky / 0 skipped**，**连续两轮全绿**（记录耗时；基线 51）。

### Terraform 与 Cloudflare

- [ ] `terraform fmt -check -recursive` **无输出** + `terraform validate` 通过。
- [ ] 资源清单**恰为** zone data + `workers_custom_domain`，**无 `workers_script`**。
- [ ] `backend "s3"` 配置齐全、值全部是**占位**；`.terraform.lock.hcl` **入库**；`*.tfvars` / `*.tfstate` **未入库**。
- [ ] `wrangler deploy` 成功。
- [ ] `https://dev.sankabox.com` **返回控制台页面**。

### 真机浏览器验收

- [ ] 从 CF 域名连 `https://sandbox-api.sankabox.com`，全功能可用：引导面板 → 填地址与令牌 → 工作台 → 健康 `ok` 且**无降级文案** → 列表 / 新建（含镜像选择器）/ 详情 / 网页终端（连上、敲命令、断开重连）/ 停止 / 删除 / 模板 / 文件注入 / 运行期文件面板 → 剪贴板可用。
- [ ] **无 CORS 预检失败**、**无混合内容告警**。

### 文档与治理

- [ ] **ADR 0019 落档**（已接受）并**单向取代 ADR 0013 第 6 节**；[[architecture/decisions/README.md|决策清单]] 同步（新增 0019 行 + 0013 行加标注）。
- [ ] [[current-state.md|看板]] 同步（活跃需求 + 任务看板 + TODO）。
- [ ] [[glossary.md|词汇表]] 补三条词条（控制台前端托管 / Workers 静态资产 / 后端纯 API 化）。
- [ ] [[prds/README.md|PRD 清单]] 与 [[tasks/README.md|任务清单]] 同步。
- [ ] 代码区文档同步：仓库根 `README.md`、`apps/web/backend/API.md`、`apps/web/frontend/README.md`、`apps/web/backend/sandbox-console.service`、`apps/web/frontend/tests/README.md`。
- [ ] **历史不改写清单**：[[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 本体、[[prds/phase2-console.md|二期 PRD]]、[[tasks/phase2-console/01-service-core-api.md|二期任务 01]] **保持原样**。

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
