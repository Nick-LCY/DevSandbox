# 0019. 控制台前端托管到 Cloudflare Workers

- 日期：2026-11-11
- 状态：已接受
- **取代范围**：本决策**单向取代** [[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 第 6 节「Cloudflare 静态托管的退役」。**ADR 0013 本体的历史表述不改写**——那一节的记录（「原『前后端分离部署』里的 Cloudflare 静态站托管正式退役……将来若重提静态托管，按新需求独立立项」）**作为历史事实保留**，本决策即是那次「重提」的独立立项。
- 需求见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]；任务集见 [[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]。

## 背景

网页控制台的前端与后端**至今同源同进程**：后端用 `StaticFiles` 把前端 `dist` 挂在 `/`，`/api/health` 回 `console_mounted` 告诉前端产物挂上了没，前端据此决定进工作台还是显示「前端产物未挂载」的降级文案。三个痛点随之而来：

1. **后端被迫兼做静态服务器**——一条完整的能力链（挂载、目录发现、环境变量覆盖、目录缺失时跳过并告警、自检字段、降级文案）只为「把前端塞进来」而存在；
2. **验收套件绑死同源前提**——Playwright 的 `baseURL` 直指后端、`storageState` 的 origin 就是后端 origin、页面里的 `page.request` 全用相对 URL。**从未验证过生产真正要用的「前端在别处、后端只提供 API」的形态**；
3. **前端不能独立发版**——改一行前端也要重启后端进程。

同时，两条现实约束决定了方案形态：

- **本仓零 IaC**——仓库里没有 Terraform；唯一的反代（Traefik）在外部 infra 仓。Cloudflare 侧要纳入版本管理，就必须在**本仓**引入 IaC。
- **治理冲突**——ADR 0013 第 6 节曾把 Cloudflare 静态托管「正式退役、不再规划、不再留待办」，并写明「将来若重提静态托管，按新需求独立立项」。本轮就是那次重提。

前置条件已经具备，不需要额外改造连接层：前端用**哈希路由**（不依赖服务端回退）、Vite `base: './'`（相对基址，同一份 `dist` 在任意静态源下都能解析 `/assets/*`）、请求基址**恒为绝对地址**（ADR 0015 决策 D 已废除「空基址 = 同源」）、后端 **CORS 任意来源**（ADR 0013 第二次修订）。结论：**同一份 `dist` 放到任意静态源都开箱可用，业务代码零改动**。

## 决策

### 1. 载体 = Cloudflare Workers + 静态资产（**不是 Pages**），域名 `dev.sankabox.com`

- 用 **Workers + `[assets]` 静态资产绑定**承载前端；**不用 Pages**。
- 自定义域名 **`dev.sankabox.com`**。
- Worker 脚本是**纯 JS ESM 极简 passthrough**（非资产路径 404）；静态资产由 Workers 的 assets 绑定直接服务；`run_worker_first = false`、`not_found_handling = none`（哈希路由不需要回退规则）。
- `wrangler.toml` 的 `account_id` **非机密、可入库**；**API Token 只走环境变量** `CLOUDFLARE_API_TOKEN`，绝不入库。

### 2. 后端纯 API 化；健康检查删 `console_mounted`（破坏性变更，无兼容层）

- **后端只提供 `/api`**，不再托管任何静态资源：删除 `StaticFiles` 挂载链、`SANDBOX_CONSOLE_DIST` 目录发现与相关常量与解析函数、`_mount_console` 及其调用点。
- **`/api/health` 删除 `console_mounted` 字段**（响应字段集合恰为 `{status, version, data_root_configured}`）。这是**破坏性变更**：**不留兼容层**——不双写、不保留旧字段、不按客户端版本返回。
- `GET /` 与 `GET /assets/*` 一律 **404**，由验收用例**双向钉死**（静态源根 200 且含控制台页面标识，后端根 404 且不含 `<html`）。
- **令牌闸行为不变**：`/api` 无令牌仍 401；非 `/api` 路径不拦令牌闸、但 `/` 本身 404。
- 前端相应**只删降级分支**（`HealthState` 删 `'degraded'`），连接层**零改动**。

### 3. 验收套件迁到独立本地静态源（与生产跨源形态同构）

- Playwright 套件的 `baseURL` 改指**独立本地静态源**（`vite preview --host 127.0.0.1 --port <CONSOLE_STATIC_PORT> --strictPort`）；**页面 origin ≠ 后端 origin**，`storageState` 的 origin = 静态源、连接配置的后端基址 = 后端——**刻意不同源**。
- `--strictPort` 是硬要求（防静默换端口毁掉 `storageState` 的 origin 注入）；绑 `127.0.0.1` 是硬要求（保剪贴板的安全上下文）。
- 8 处相对 URL 的 `page.request.*` 改后端绝对地址；`06-boundary` 的单端口用例改写为**负向断言 + 正向对照**；新增 `13-static-frontend.spec.ts` 2 条。

### 4. 单一所有者原则：Terraform 管域名层，`wrangler` 管脚本与资产

- **Terraform 只管**：`cloudflare_zone`（data）与 `cloudflare_workers_custom_domain`（resource）。**不声明 `cloudflare_workers_script`**——脚本与静态资产归 `wrangler`。
- **IaC 代码入本仓 `infra/`**：**单个 root module + workspace**（不做多环境矩阵）。`versions.tf` 固定 `required_version >= 1.9`、provider **精确 pin**、`.terraform.lock.hcl` **入库**。
- **远端状态存 S3 兼容对象存储**（MinIO）：`backend "s3"` 空块 + `backend.hcl.example` 占位（`bucket` / `key` 带 workspace 前缀 / `region` / `endpoint` / **`use_path_style = true`** / 四个 `skip_*`）。**MinIO 必须 path style + 四个 skip**，否则 `terraform init` 卡住。**端点 / 桶 / region / 凭据待用户提供**，配置先用**占位**。
- **凭据只走环境变量**（`TF_VAR_*` 传变量、`AWS_*` 传后端凭据）；**无真实凭据入库**；`*.tfvars` / `*.tfstate` **不入库**。

### 5. 部署顺序：`wrangler deploy` 先、`terraform apply` 后

域名资源要指向一个**已存在**的 Worker ⇒ 顺序固定为 **`wrangler deploy` → `terraform apply`**。

### 6. 手动部署，不做 CI

部署 = 手动 `wrangler deploy` + 手动 `terraform apply`；**本轮不引入流水线**。

### 7. 发版节奏：先发后端、再发前端；允许短暂不兼容窗口

**先发后端再发前端**，允许**短暂不兼容窗口**：旧前端读到 `console_mounted` 为 `undefined` 时判「未挂载」，**只显示降级文案、不崩**。

## 影响

- **健康检查契约是破坏性变更**：`/api/health` 少一个字段。任何依赖 `console_mounted` 的外部消费者（监控、脚本、第三方探活）**必须同步改**——本轮**刻意不留兼容层**，代价是这条契约**破坏性**而非演进式。
- **前后端版本不再原子一致**：发布解耦是本轮的核心收益，但也意味着**存在版本错配窗口**。缓解手段是「先发后端再发前端」+ 旧前端的降级文案**不崩**；但**反序发布（先发前端）会把新前端配旧后端**——新前端不读该字段、正常，故反序也安全，只是不推荐。
- **令牌是唯一凭据，暴露面提示**：后端**仍只走既有 Traefik 链路**，本轮**不做公网暴露架构改造**；但前端现在在公网域名上、由陌生来源的浏览器执行——**跨源页面能向本后端发请求并读到响应**（ADR 0013 第二次修订已放开的 CORS），**取数据仍需令牌**。**暴露面与令牌策略不动，是本轮明确接受的现状**；令牌保密仍是唯一准入边界。
- **验收基建改动面大**：验收套件的 `baseURL`、`storageState`、8 处 `page.request`、多条 spec 的语义都要改；**这是把「同源」这个从未被验证的隐含前提从基线里拿掉的必要成本**，也是本轮最容易出回归的地方（因此门禁要求**连续两轮全绿**）。
- **`/api/health` 语义收窄**：健康自检现在**只反映后端自身**（版本、数据根），**不再反映前端是否可用**——前端可用性由 CF 域名侧独立判断。
- **部署链引入新角色**：`wrangler`（脚本与资产）与 `terraform`（域名层）**两个所有者**；顺序错（先 `terraform apply`）会失败或指向不存在的 Worker。本仓从此**多一份 IaC 资产**（`infra/`），需要纳入版本管理与审阅。
- **远端状态后端是新增依赖**：MinIO 的 S3 兼容语义与 AWS 不完全一致（**必须 path style**），`terraform init` 的行为依赖四个 `skip_*`；**这是已知的兼容性成本**，换取「状态不落在本机磁盘」。

## 相关决策

- [[architecture/decisions/0013-三期定位改定与认证重启.md|0013 三期定位改定与认证重启]] — **本决策取代其第 6 节**（「Cloudflare 静态托管的退役」）：那一节的历史表述**不改写**，本决策是它明写的「重提后按新需求独立立项」的那个新需求。其余结论（三期 = 桌面端打包 + 端口转发、CORS 任意来源、准入边界 = 令牌 + 票据）**不受影响**。
- [[architecture/decisions/0015-桌面壳与连接配置抽象.md|0015 桌面壳与连接配置抽象]] — **复用其连接层抽象**：哈希路由、`base: './'`、恒绝对请求基址、「空基址 = 同源」已废除。这四条正是本轮「业务代码零改动、同一份 `dist` 任意静态源开箱可用」的**前提**；桌面壳 `frontendDist` 独立，**本轮零改动**。
- [[architecture/decisions/0009-二期控制台服务化与范围裁剪.md|0009 二期控制台服务化与范围裁剪]] — 二期把控制台做成「同源同进程」的形态（本轮拆掉的是它的静态托管部分）；其「命令行不服务化」等其余裁剪不受影响。
- 需求：[[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]；任务集：[[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]；术语见 [[glossary.md|词汇表]]；看板见 [[current-state.md|当前状态]]。
