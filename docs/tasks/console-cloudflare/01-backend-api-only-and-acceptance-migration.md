---
prd: prds/console-cloudflare.md
status: done
---
# 任务：后端纯 API 化 + 验收套件迁独立静态源

> 需求见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。
> **本任务已收口（done，2026-11-11）**——后端纯 API 化、前端删降级分支、验收套件迁独立静态源三段全部落地；下文的实施要点是**施工单**，也是验收核对清单；**最终门禁数字、提交链与实施偏差见文末「进展（收口）」**。

## 目标

**一次性删干净后端「托管前端」的能力链**（后端源码 + 前端类型与文案 + 全部后端测试 + 代码区文档），并把 **51 条验收用例迁到独立本地静态源**，让「**页面 origin ≠ 后端 origin**」成为验收基线。门禁全绿。

两条硬口径：

1. **删干净，不留兼容层**——`console_mounted` 是**破坏性变更**，不双写、不保留旧字段、不按客户端版本返回。
2. **验收形态与生产同构**——生产是「前端在 CF 域名、后端在 API 域名」，验收就必须是「页面在本地静态源、后端在另一个 origin」。

## 涉及文件

### 后端（服务端包 `apps/web/backend/src/sandbox_console/`）

- `app.py` — 删 `StaticFiles` import 与挂载链、四个 dist 常量、两个 dist 解析函数、`_mount_console` 与调用点；改写模块头 / `create_app` docstring。
- `schemas.py` — `HealthResponse` 删 `console_mounted` 字段。
- `routes/health.py` — 删字段读取与传参；删 `Request` 形参与 import；docstring 去掉「前端是否挂载」。
- `auth.py` — `BearerAuthMiddleware` 与 `_install_connection_middleware` 的注释口径改写。
- `__main__.py` — 启动 docstring 口径改写。
- `tests/` — 新增根路径 404 用例、改写健康检查用例、删静态资源鉴权用例、删 27 处 `SANDBOX_CONSOLE_DIST` 注入。

### 前端（`apps/web/frontend/`）

- `src/api/types.ts` — 删 `console_mounted` 字段。
- `src/components/workbench/Workbench.tsx` — 删降级分支（health 成功即 `ok`）。
- `src/components/workbench/AppShell.tsx` — `HealthState` 删 `'degraded'`。
- `src/components/workbench/Sidebar.tsx` — **样式分支零改动**。
- 各 mock（`src/api/client.test.ts`、`Workbench.test.tsx`、`ConnectionSetup.test.tsx`、`SettingsDialog.test.tsx`、`Sidebar.test.tsx`）同步。
- `tests/helpers/api.ts` — 删字段。
- 新增「health 正常 ⇒ 健康态恒 `ok`、无 `degraded` 分支」用例。

### 验收套件（`apps/web/frontend/tests/`）

- 新增 `tests/helpers/static.ts`；改 `tests/playwright.config.ts`、`tests/helpers/connection.ts`、`tests/helpers/server.ts`、`tests/helpers/paths.ts`、`tests/global-setup.ts`、`tests/global-teardown.ts`；改 **10 处**相对 URL 的 `page.request.*`（**勘误**：施工单原写 8 处，实际 10 处）；改写 `specs/06-boundary.spec.ts` 的单端口用例；新增 `specs/13-static-frontend.spec.ts`。

### 代码区文档（本任务一并同步）

- 仓库根 `README.md`（前端托管行）
- `apps/web/backend/API.md`（四处）
- `apps/web/frontend/README.md`（四处 + 静态源说明）
- `apps/web/backend/sandbox-console.service`（前端托管段）
- `apps/pyproject.toml`（`description`）
- `apps/web/frontend/tests/README.md`（补静态源段）

## 实施要点

### 一、后端：删能力链

**`app.py`**

| 位置 | 动作 |
|---|---|
| `:13` | 删 `StaticFiles` import |
| `:47-56` | 删四个常量：`BACKEND_DIR` / `WEB_DIR` / `FRONTEND_DIST_DIR` / `ENV_CONSOLE_DIST`（**删前先 grep `BACKEND_DIR` 的悬空引用**——其余常量名可能被别处引用） |
| `:63-81` | 删两个 dist 解析函数 |
| `:229` / `:230` | 删 `_mount_console` 的调用点 |
| `:270-283` | 删 `_mount_console` 函数本体 |
| 模块头 / `create_app` docstring | 口径改写为「本服务只提供 `/api`、不再托管静态资源，前端由 Cloudflare Workers 独立托管（见 ADR 0019）」 |

**`schemas.py`** — `:365` 删 `console_mounted` 字段。

**`routes/health.py`** — `:25` 删字段读取、`:30` 删传参；`:17` docstring 去掉「前端是否挂载」；**删 `Request` 形参与对应 import**（删掉 `:25` 之后 `Request` 不再被使用，留着会变成未使用导入）。

**`auth.py` / `__main__.py`** — `BearerAuthMiddleware` 与 `_install_connection_middleware` 注释、`__main__.py` 启动 docstring，同一口径改写。

> **注释纪律**：**只说现在是什么，不写历史**。不写「以前挂过前端」「原来是 StaticFiles」这类叙事——历史归 [[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 与 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。

### 二、后端测试

- **新增「根路径 404」用例**：`GET /` → **404** 且响应体**不含** `<html`；`GET /assets/x` → **404**。
- **改写 `test_health_endpoint`**：删 `console_mounted` 断言、删 `default_console_dist_dir` 断言及其 import；新增 **`set(body) == {status, version, data_root_configured}`** 断言（**用集合断言**，不逐字段——字段集合「恰为」这三个才是契约）。
- **删 `test_server_auth.py:126-138` 的 `test_static_assets_are_not_blocked_by_auth` 整用例**，替换为「**非 `/api` 路径不拦令牌闸、但根路径本身 404**」：**不带 `Authorization` 请求 `/` → 404**（**不是 401**）。
- **删 27 处 `monkeypatch.setenv("SANDBOX_CONSOLE_DIST", ...)`**（分布以 grep 实测为准）：`test_server_api` 2、`test_server_auth` 8、`test_server_files` 2、`test_server_templates` 6、`test_server_images_proxy` 1、`test_forwards` 5、`test_terminal_sessions` 3。
- **其余断言零改动**。

### 三、前端：只删降级分支

- `types.ts` 删字段；`Workbench.tsx` 删降级分支（**health 成功即 `ok`**）；`AppShell.tsx` 的 `HealthState` 删 `'degraded'`；`Sidebar.tsx` 的**样式分支零改动**。
- **mocks 同步**：`client.test.ts` 3 处、`Workbench.test.tsx` 9 处、`ConnectionSetup.test.tsx` 1、`SettingsDialog.test.tsx` 1、`Sidebar.test.tsx` 3 处——`'degraded'` → `'ok'`。
- `tests/helpers/api.ts` 删字段。
- 新增「**health 正常 ⇒ 健康态恒 `ok`、无 `degraded` 分支**」用例。

### 四、验收迁移（三步走，**每步单独提交并记录通过数**）

#### 第一步：起独立静态源（基座）

- **新增 `tests/helpers/static.ts`**：`vite preview --host 127.0.0.1 --port <CONSOLE_STATIC_PORT，可被环境变量覆盖> --strictPort`，`cwd` = `apps/web/frontend`；**复用 `helpers/server.ts` 的端口等待与进程启停套路**（不另起一套）。
  - **`--strictPort` 是硬要求**：端口被占时**直接失败**，不静默换端口——换端口会毁掉 `storageState` 的 origin 注入，整套套件会在错的 origin 上跑。
  - **绑 `127.0.0.1` 是硬要求**：保**安全上下文**——剪贴板 API 在非安全上下文不可用。
- `playwright.config.ts` 的 **`baseURL` 改指静态源 origin**。
- `helpers/connection.ts` 的 `writeStorageState` 改为 **`({pageOrigin, backendPort})`**：`storageState` 的 origin = **静态源**；连接配置里的后端基址 = **后端**——**两者刻意不同源**。
- `helpers/server.ts` **删 `SANDBOX_CONSOLE_DIST` 注入**（后端不再托管前端）。
- `helpers/paths.ts` 的 `CONSOLE_DIST_DIR` **保留**但**只作注释口径**（不再作为后端环境变量注入源）。
- `global-setup.ts` **起静态源**并扩展**交叉断言**：静态源**实际端口 == 配置端口**；`storageState` origin **== `baseURL` origin**；不等即**抛错**。`global-teardown.ts` **停静态源**。
- **先冒烟再跑组**：起 preview → 开 `/` → 断言 `page-layout-title` 可见 + assets 的 js 请求 **200**；再跑 `10-auth-connection`（**10 条**）与 `06-boundary`。
  - **回退口径**：若 `vite preview` 在 `base: './'` 下冒烟不过，**回退为自写极简 node 静态服务器**（`node:http` + `fs` + mime 表 + SPA 回退，约 60 行）；**不得用 `http-server`**。

#### 第二步：10 处相对 URL 改后端绝对地址（**勘误**：施工单原写 8 处）

页面 origin 变成静态源后，**相对 URL 的 `page.request` 会打到静态源而不是后端**。以下 **10 处**改为**后端绝对地址**（行号以**最终 grep 实测**为准；原施工单行号已按实测勘误）：

| 文件 | 行 |
|---|---|
| `specs/02-local-image.spec.ts` | `101` |
| `specs/03-terminal.spec.ts` | `120` / `269` / `278` |
| `specs/05-reclaim.spec.ts` | `159`（**勘误**：原写 `154`） |
| `specs/06-boundary.spec.ts` | `96` / `101` / `109` / `110`（**勘误**：原写 `95` / `100` / `106` / `107`） |
| `specs/09-terminal-clipboard.spec.ts` | `108` |

改完跑 `02` / `03` / `05` / `09` 四组。

#### 第三步：06-boundary 改写 + 新增 13-static-frontend + 全量复跑

- **`06-boundary` 的单端口用例改写为「负向断言 + 正向对照」**：
  - 后端根 **404**、响应体**不含** `<html`；
  - 后端 `/assets/*` **404**；
  - **静态源根 200**、含 `page-layout-title`（**正向对照**——负向断言必配正向对照）；
  - `gotoDetail` 后页面**照常进详情**，且页面 origin **已是静态源**。
- **新增 `specs/13-static-frontend.spec.ts`（2 条）**：静态源根 200 含 `page-layout-title`；后端根 404 不含 HTML。
- **全量复跑**。
- **`10-auth-connection.spec.ts` 代码零改动**：`page.goto('/')` 的相对路径语义**自动变为静态源根**；其 `page.request` **本就**是绝对地址。

### 五、代码区文档同步

| 文件 | 位置 | 动作 |
|---|---|---|
| 仓库根 `README.md` | `:102` | 改写「前端托管」行 |
| `apps/web/backend/API.md` | `:637` / `:663` / `:720` / `:1036` | 四处改写 |
| `apps/web/frontend/README.md` | `:6` / `:41` / `:47` / `:55` / `:192` | 五处改写（含 `SANDBOX_CONSOLE_DIST` 环境变量表那一行） |
| `apps/web/backend/sandbox-console.service` | `:129-134` | 「前端托管」段**删掉**，换成一句：「前端由 Cloudflare Workers 独立托管，本服务只提供 `/api`（根路径返回 404）」 |
| `apps/pyproject.toml` | `:3` | `description` 删「前端构建产物托管」 |
| `apps/web/frontend/tests/README.md` | — | 补「静态源」段（起静态源、origin 语义、与生产同构） |

> **禁止改写历史**：[[prds/phase2-console.md|二期 PRD]] 与 [[tasks/phase2-console/01-service-core-api.md|二期任务 01]] **保持原样**（这两个在 `docs/` 下，**本任务不该碰**）。[[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 本体同样**不改写**。

## 完成标准

### 后端

- [ ] `app.py` 无 `StaticFiles` import、无 `app.mount`、无四个 dist 常量、无两个 dist 解析函数、无 `_mount_console`（**全仓 grep 零命中**）。
- [ ] `schemas.py` 与 `routes/health.py` 无 `console_mounted`；`routes/health.py` 无 `Request` 形参与未使用 import。
- [ ] `GET /api/health` 响应字段集合**恰为** `{status, version, data_root_configured}`（`set(body)` 断言）。
- [ ] `GET /` **404** 且**不含** `<html`；`GET /assets/*` **404**。
- [ ] 后端测试目录 `SANDBOX_CONSOLE_DIST` **零命中**（27 处 `monkeypatch.setenv` 全删）。
- [ ] 令牌闸**行为不变**：`/api` 无令牌 **401**（原文案）；非 `/api` 不拦令牌闸但 `/` **404**。
- [ ] `app.py` / `auth.py` / `__main__.py` 的口径注释统一为「只提供 `/api`、前端由 Cloudflare Workers 独立托管」，**只说现在是什么**。

### 前端

- [ ] `src/` 零 `console_mounted`；`HealthState` 无 `'degraded'`；`Workbench.tsx` 无降级分支；`Sidebar.tsx` 样式分支零改动。
- [ ] mocks 全部同步（`'degraded'` → `'ok'`）；新增「health 正常 ⇒ 健康态恒 `ok`」用例。
- [ ] `tests/helpers/api.ts` 零 `console_mounted`。

### 验收套件

- [ ] 静态源绑 **`127.0.0.1`** 且 `--strictPort`；`CONSOLE_STATIC_PORT` 可被环境变量覆盖。
- [ ] **`page.origin` ≠ 后端 origin**（`global-setup` 交叉断言：实际端口 == 配置端口、`storageState` origin == `baseURL` origin，不等即抛错）。
- [ ] `storageState` origin = 静态源，连接配置后端基址 = 后端（**刻意不同源**）。
- [ ] **10 处**相对 URL 的 `page.request.*` 已改后端绝对地址（**勘误**：施工单原写 8 处；实际分布 `02×1` / `03×3` / `05×1` / `06×4` / `09×1`，**grep 全查零漏网**）。
- [ ] `06-boundary` 单端口用例 = **负向断言 + 正向对照**。
- [ ] 新增 `specs/13-static-frontend.spec.ts` **2 条**。
- [ ] `10-auth-connection.spec.ts` **断言零改动**、**10 条全过**。
- [ ] `global-teardown` 停静态源（无残留进程 / 端口占用）。

### 代码区文档

- [ ] 根 `README.md` / `API.md`（四处）/ 前端 `README.md`（五处）/ `sandbox-console.service` / `pyproject.toml` / `tests/README.md` 全部同步。
- [ ] **历史不改写**：[[prds/phase2-console.md]]、[[tasks/phase2-console/01-service-core-api.md]]、[[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 保持原样。

### 门禁

- [ ] 后端 `pytest` **全绿** + `ruff` **rc=0**（**记录新 passed 数**；基线 **330**）。
- [ ] 核心包 **370 / 23** 不回归。
- [ ] 前端 `vitest` **全绿**（**记录新数**；基线 **664**）+ `typecheck` **双零错** + `build` 成功。
- [ ] 桌面端 `cargo check` **0 警告** + `cargo test` **47** 不回归。
- [ ] e2e 全量 **53 passed / 0 failed / 0 flaky / 0 skipped**，**连续两轮全绿**（**记录耗时**；基线 51）。

## 依赖

- **无**。与 [[tasks/console-cloudflare/02-terraform-base.md|02 Terraform 底座]] **可并行**（零文件重叠）。
- 决策依据：[[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]（纯 API 化与破坏性变更）、[[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]]（哈希路由 / `base: './'` / 恒绝对基址 ⇒「业务代码零改动」的前提）。
- 需求：[[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]；任务集：[[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]。

---

## 进展（收口）

> **本任务状态：done（2026-11-11 收口）。** 后端纯 API 化落地、验收套件迁独立静态源的跨源形态成立；审查一轮**零 Critical**、**6 条 Warning 全部修复后合入**；门禁全绿、**e2e 全量四轮全绿**。

### 交付结论

- **后端纯 API 化落地**：删干净「托管前端」能力链（`StaticFiles` 挂载链 / `SANDBOX_CONSOLE_DIST` / 四个 dist 常量与两个解析函数 / `_mount_console`）——`GET /` 与 `GET /assets/*` 一律 **404**。
- **health 契约破坏性变更落地**：`console_mounted` 字段**已删**，响应字段集合**恰为** `{status, version, data_root_configured}`（集合断言钉死），**不留兼容层**。
- **前端降级分支已删**：health 成功即 `ok`，`HealthState` 无 `'degraded'`。
- **验收套件迁独立静态源**：**页面 origin ≠ 后端 origin** 成为验收基线（**与生产跨源形态同构**）；`global-setup` 交叉断言（静态源实际端口 == 配置端口、`storageState` origin == `baseURL` origin）。
- **验收用例数**：51 → **53**（新增 `specs/13-static-frontend.spec.ts` **2 条**）。

### 审查结论与修复轮

- **审查（reviewer）一轮**：**零 Critical**、**6 条 Warning** ⇒ 结论「**修复后合入**」。
- **修复轮 = 3 个提交**：

| 提交 | 内容 |
|---|---|
| `d99963e` | 启动失败早报——端口占用与进程退出立刻说人话（不再干等超时） |
| `6ee6037` | 静态源分工用例改用 **React 挂载后**的标识（不再拿静态外壳占位当证据） |
| `a9495db` | 前端 README 与路由注释口径同步——静态源怎么起、端口别撞 |

### 门禁最终数字

| 门禁 | 结果 |
|---|---|
| 服务端 pytest | **332 passed**（基线 330 → +2）+ **ruff rc=0** |
| 核心包 pytest | 非 root **370 passed** / root **23 passed**（一次全跑 **9m31s**） |
| 前端 vitest | **665 passed**（基线 664 → **+1 新用例**） |
| 前端 typecheck | `typecheck` 与 `typecheck:tests` **双零错** |
| 前端 build | **成功** |
| 桌面端 cargo test | **47 passed**（**零改动确认**） |
| e2e（Playwright 全量） | **53 passed / 0 failed / 0 flaky / 0 skipped**——首轮两轮各 **10.1m**；审查修复轮复跑两轮 **603s / 602s**；**共四轮全绿** |

### 提交链

| 提交 | 内容 |
|---|---|
| `b7b87eb` | 后端纯 API 化（删前端托管能力链） |
| `589b843` | 前端删降级分支（后端不再托管前端） |
| `07d4872` | 验收迁静态源**第一步**（页面与后端不同源） |
| `3afa682` | **第二步**：相对 URL 改绝对（相对路径会打到静态源） |
| `6bc84fb` | **第三步**：钉死静态源与后端的分工契约 + 新增 `13-static-frontend` |
| `734e0dd` | 前端 README 口径补同步（降级态已删） |
| `d99963e` / `6ee6037` / `a9495db` | 审查修复轮：启动失败早报 / 用例改 React 挂载后标识 / README 与路由注释口径 |

### 实施偏差与说明（如实登记）

1. **任务书自相矛盾一处**：施工单既写「**第一步跑 `06-boundary` 全绿才进第二步**」，又把「`06-boundary` 的相对 URL 改造」划归**第二步**——两处互斥。**按文件:行分配执行**：第一步（`07d4872`）跑完 `06-boundary` 时，**唯一失败点恰好落在第二步声明的改造范围内**（相对 URL 打到了静态源）；第二步（`3afa682`）完成后 `06-boundary` **2/2 全绿**。
2. **相对 URL 改造实为 10 处而非施工单写的 8 处**（`02×1` / `03×3` / `05×1` / `06×4` / `09×1`）——**grep 全查零漏网**；本文上方「第二步」标题、「涉及文件」与「完成标准」中的「8 处」**一并勘误为 10 处**。
3. **`vite preview` 冒烟一次通过**，**未启用**「自写极简 node 静态服务器」回退方案（回退口径保留在施工单里，实际未触发）。
4. **`dist/index.html` 的 `page-layout-title` 是静态外壳占位元素**（React 挂载后才被替换），拿它断言「工作台在」恒真 ⇒ `13-static-frontend` 已改用 **React 挂载后标识**（`page-sandbox-list-title` / `page-connection-setup`）断言真实挂载。
5. **遗留（不改写历史）**：`apps/web/frontend/RESULTS.md:416` 仍有旧示例（`CONSOLE_TEST_PORT=8200`），系**二期历史留档**，按「不改写历史」原则保留。
6. **一次 e2e 超时的根因**：先前被 kill 的跑批**残留 `acc-*` 沙箱**，致收尾 delete 卡等待；**清残留后正常**，与本轮改动无关（环境事件，非回归）。

### 收口留档索引

- 任务集索引与状态：[[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]。
- 决策依据：[[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]（纯 API 化与破坏性变更）。
