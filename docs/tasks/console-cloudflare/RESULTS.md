# 控制台前端托管到 Cloudflare 全轮收口留档

> **留档说明**
> - 本文件是**控制台前端托管到 Cloudflare**轮（01~05）的**全轮收口留档**：结论、各轮提交链、门禁数字、部署实证、真机验收记录、已知边界与留白。体例参考 [[tasks/runtime-file-transfer/RESULTS.md|运行期文件传输全轮留档]]，但**只写结论与数字**，不复述各任务文件的过程。
> - **当前状态（2026-11-12）**：**01~05 全部收口、全部 done**——**唯一开口已闭合**：04 轮的**公网真机浏览器八步**由**用户于 2026-11-12 在真实浏览器执行、全部通过**；**全轮无遗留开口**。
> - **留档口径**：本文只写**已实测**的数字；凡「未做 / 未验 / 刻意保留」一律显式标出（见第六节「已知边界与留白」），不与「已闭合」混写。
> - **代码改动**：收口轮（05）**零代码改动**；全轮的代码改动集中在 01 / 03 轮（提交链见第七节）。
> - 关联：任务集 [[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]、需求 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]、决策 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]、看板 [[current-state.md|当前状态]]。

## 一、结论（一句话）

**全轮收口，机制与实现均成立**：载体 = **Cloudflare Workers + 静态资产**（**不是 Pages**），自定义域名 **`dev.sankabox.com`**；后端**纯 API 化**（`GET /` 与 `/assets/*` 一律 404、`/api/health` 删 `console_mounted`——**破坏性变更、无兼容层**）；**单一所有者原则**守住（Terraform 只管域名层，脚本与资产归 `wrangler`）；**真机验收通过**——**用户于 2026-11-12 在真实浏览器逐条执行八步、全部通过，控制台无 CORS 预检失败、无混合内容告警**。

## 二、轮次总表（01~05）

| 轮 | 主题 | 状态 | 交付（要点） | 提交链 |
|---|---|---|---|---|
| 01 | 后端纯 API 化 + 验收套件迁独立静态源 | **done**（2026-11-11 收口） | 删干净后端「托管前端」能力链（`StaticFiles` 挂载链 / `SANDBOX_CONSOLE_DIST` / 四个 dist 常量 / `_mount_console`）+ `/api/health` 删 `console_mounted` + 前端删降级分支 + **验收套件迁独立本地静态源**（**页面 origin ≠ 后端 origin**，与生产跨源形态同构）+ 用例 **51 → 53** 条；审查一轮**零 Critical**（6 条 Warning 全部修复后合入） | `b7b87eb` → `589b843` → `07d4872` → `3afa682` → `6bc84fb` → `734e0dd` → `d99963e` / `6ee6037` / `a9495db`（后三笔为审查修复轮） |
| 02 | Terraform 底座（`infra/`） | **done**（2026-11-11 收口） | `infra/` 目录骨架 + cloudflare provider **精确 pin `5.28.1`** + `.terraform.lock.hcl` **入库** + **零凭据入库** + **单一所有者原则**写死在 `main.tf` 文件头；审查一轮**零 Critical**（4 条 Warning 全部修复后合入）；**增量**：状态后端切 **真实 AWS S3**（删 `endpoint` / `use_path_style` / 五个 `skip_*`，MinIO 变体留注释块） | `e408740`（底座）→ `62b1555`（审查修复）→ `f6ab90c`（切 AWS 原生） |
| 03 | Cloudflare Workers 项目与手动部署链 | **done**（2026-11-11 收口） | `infra/worker/` Workers 项目（`wrangler` 4.160.1 / `wrangler.toml` 含 `account_id` 与 `[assets]` 绑 `dist` / 极简 ESM passthrough / 独立 `pnpm-lock`）+ **`deploy` 脚本**（先 build 再 deploy，一条命令）+ **真实部署链四步全通**（`init` → `plan` → `pnpm run deploy` → `apply`） | `43b0bba`（脚手架）→ `b779dba`（部署留痕） |
| 04 | 域名绑定与公网真机浏览器验收 | **done**（2026-11-12 收口） | `cloudflare_workers_custom_domain` 落 **`dev.sankabox.com`** + `terraform state list` **恒 2 项**、**无 `workers_script`** + **HTTP 层验收已过**（首探即 200 / 内容与 workers.dev byte 级一致 / 资产直出 200 / 非资产路径 404）+ **用户浏览器真机八步全部通过**（本轮**零代码改动、零提交**） | `04de972`（改名与锁；域名重绑与真机验收**本身零提交**） |
| 05 | 文档收口与 PRD 验收逐条核销 | **done**（2026-11-12 收口） | **复核** ADR 0019 与实际交付一致 + 决策清单 / 总览 / 词汇表 / 看板 / PRD·任务清单复核 + 代码区文档同步 + **PRD 验收逐条核销挂证据** + 历史不改写清单复核 + **本留档 `RESULTS.md`** | 纯文档若干（见第七节） |

> 各轮的逐条明细与全部过程数字见对应任务文件：[[tasks/console-cloudflare/01-backend-api-only-and-acceptance-migration.md|01]]、[[tasks/console-cloudflare/02-terraform-base.md|02]]、[[tasks/console-cloudflare/03-cloudflare-workers-deploy.md|03]]、[[tasks/console-cloudflare/04-domain-and-live-acceptance.md|04]]、[[tasks/console-cloudflare/05-docs-and-adr.md|05]]。

## 三、全轮门禁数字（最终态，2026-11-12）

| 门禁 | 结果 | 沿革 |
|---|---|---|
| 服务端 pytest | **332 passed** + `ruff` **rc=0** | 基线 330 → 01 轮 **332**（+2：根路径 404 与健康字段集合钉死） |
| 核心包 pytest | 非 root **370 passed** / root **23 passed** | 全轮未变 |
| 前端 vitest | **665 passed** | 基线 664 → 01 轮 **665**（+1 新用例） |
| 前端 typecheck | `typecheck` 与 `typecheck:tests` **双零错** | 全轮未变 |
| 前端 build | **成功** | 全轮未变 |
| 桌面端 `cargo test` | **47 passed** | 全轮未变 |
| e2e（Playwright 全量） | **53 passed / 0 failed / 0 flaky / 0 skipped**——**连续四轮全绿** | 基线 51 → 01 轮 **53**（+2：`13-static-frontend`） |
| Terraform `fmt -check -recursive` | **无输出** | 02 轮起；03 / 04 轮复跑仍无输出 |
| Terraform `validate` | **通过** | 02 轮起；03 / 04 轮复跑仍通过 |

> 收口轮（05）**零代码改动** ⇒ 上表数字**沿用 01 轮实测值**，未重跑。

## 四、部署实证

| 项 | 实测值 |
|---|---|
| Worker 名 | **`dev-sandbox`**（2026-11-12 由 `sandbox-console-web` 改定；**旧 Worker 已删**，旧地址 → **404** / Cloudflare **error 1042**） |
| `workers.dev` 地址 | **`https://dev-sandbox.nucbox.workers.dev`** |
| 自定义域名 | **`https://dev.sankabox.com`** → **200**；body 含 `page-layout-title` 与 `assets/index-*.js`；与 `workers.dev` 内容 **byte 级一致**（同一 sha256） |
| 上传资产数 | **123** |
| Worker 版本 id | **`9e12fa39-d92b-48ed-8e8a-ea6978fbb4f7`** |
| Terraform 状态清单 | **`terraform state list` 恒为 2 项**（zone data + `workers_custom_domain`）、**无 `workers_script`** ⇒ **单一所有者原则守住** |
| 远端状态对象 | **`dev-sandbox/terraform.tfstate`**（桶 **`terraform-654654240294-ap-southeast-1-an`**，region `ap-southeast-1`，**AWS 默认端点**）——由旧前缀 `console-cloudflare/terraform.tfstate` **服务端复制迁移**，旧前缀**已清空删除** |
| 状态锁 | **S3 原生锁已开启**（`backend.hcl` 的 `use_lockfile = true`）；锁对象 **`dev-sandbox/terraform.tfstate.tflock`** **实测生成并正常释放、无残留**（需 Terraform **>= 1.10**，本机 **v1.15.8**） |
| 部署顺序（硬约束） | **`wrangler deploy` 先 → `terraform apply` 后**——域名资源要指向一个**已存在**的 Worker |

## 五、真机验收记录（2026-11-12，用户执行）

| 项 | 内容 |
|---|---|
| 执行方 | **用户**（真实浏览器，真后端 `https://sandbox-api.sankabox.com`） |
| 日期 | **2026-11-12** |
| 覆盖 | **八步逐条通过**：① 引导面板出现 → ② 填 `https://sandbox-api.sankabox.com` 与令牌并保存连接 → ③ 工作台正常渲染 → ④ 健康自检 **`ok`**、**无降级文案** → ⑤ 沙箱生命周期（列表 / 新建（含镜像选择器）/ 详情 / 网页终端**连上敲命令、断开重连** / 停止 / 删除）→ ⑥ 模板 → ⑦ 文件注入 → ⑧ 运行期文件面板 → ⑨ 终端剪贴板 `Ctrl+Shift+C` / `Ctrl+Shift+V` 可用 |
| 负面观察项 | 浏览器控制台**无 CORS 预检失败**、**无混合内容告警** |
| 代码改动 | **零**——本轮只做真机验证与文档收口 |
| 状态变更 | 04 任务 `doing` → **`done`**；全轮 **01~05 全部 done** |

> **口径保留**：「未验不宣称完成」的纪律**未放松**——八步未过期间 04 维持 `doing`、全轮不宣称收口；本次是由**用户真实浏览器执行后补齐**才闭合。

## 六、已知边界与留白

| # | 边界 / 留白 | 性质 | 说明 |
|---|---|---|---|
| 1 | **开发机出口偶发丢包** | **环境现象，非部署缺陷** | 到 `dev.sankabox.com` 的探测 **12 次中 11 次成功、1 次超时**，另有 1 次 TLS `unexpected eof`；`cf-ray` 落 **LAX**，而 `workers.dev` 走代理落 **SIN** ⇒ 判为**开发机出口路由抖动**（同一时段 `workers.dev` 侧稳定可达、产物 byte 级一致）。**用户侧真机浏览器八步全过**进一步证伪「部署缺陷」 |
| 2 | **宿主后端仍跑旧版** | **不阻断，择机更新** | **新前端不读 `console_mounted`** ⇒ 后端尚未切到纯 API 版**不影响**本次新前端的功能验证；**择机更新到纯 API 版**后，**旧 web 形态的根路径页面随之下线**（后端 `GET /` 与 `/assets/*` 一律 **404**）⇒ 旧入口不再可用，**更新前需确认无人在用旧入口** |
| 3 | **桌面端旧安装包内嵌旧前端** | **重打包即愈，代码无需改动** | 旧包内嵌的是**改码前的前端产物**（仍读 `console_mounted`）⇒ 状态灯会因该字段**缺失 / =false** 显示降级文案。**代码修复已在本轮 01 落库**（前端删降级分支）⇒ **只需重新打包**（在 Windows 机器拉取分支后重打包），**无需改码** |
| 4 | **状态锁已开，但当前以单人操作为主** | **刻意保留** | **S3 原生锁**（`use_lockfile = true`）已开、锁对象实测正常；但当前**部署多由单人执行**，并发冲突的暴露面小 ⇒ 保留现状，**并发部署成为常态时再复核**（注意：进程被强杀会**残留**锁对象，须人工确认无其它 Terraform 在跑后删除） |
| 5 | **未 push** | **已知留白，不阻断** | 本分支**领先 `origin/main` 20+ 提交**、**尚未 push** ⇒ 桌面端重打包等跨机动作**须先 push**，再到 Windows 机器拉取 |

## 七、提交链

| 轮 | 提交 | 说明 |
|---|---|---|
| 01 | `b7b87eb` | 后端纯 API 化（删前端托管能力链） |
| 01 | `589b843` | 前端删降级分支（后端不再托管前端） |
| 01 | `07d4872` | 验收迁静态源**第一步**（页面与后端不同源） |
| 01 | `3afa682` | **第二步**：相对 URL 改绝对（相对路径会打到静态源） |
| 01 | `6bc84fb` | **第三步**：钉死静态源与后端的分工契约 + 新增 `13-static-frontend` |
| 01 | `734e0dd` | 前端 README 口径补同步（降级态已删） |
| 01 | `d99963e` / `6ee6037` / `a9495db` | 审查修复轮：启动失败早报 / 用例改 React 挂载后标识 / README 与路由注释口径 |
| 02 | `e408740` | **Terraform 底座**：`infra/` 目录骨架 + provider 精确 pin `5.28.1` + lock 入库 + 单一所有者红线注释 |
| 02 | `62b1555` | **审查修复轮**：4 条 Warning 全部修复（workspace 路径口径 / `account_id` 注入口径 / Token 权限补 `DNS:Edit` / README 断链） |
| 02 | `f6ab90c` | `backend.hcl.example` **切 AWS 原生**：删 `endpoint` / `use_path_style` / 五个 `skip_*`（MinIO 变体留注释块） |
| 03 | `43b0bba` | **`infra/worker/` Workers 项目脚手架**（`wrangler` 4.160.1 + `wrangler.toml` + 极简 ESM worker + 独立 `pnpm-lock`） |
| 03 | `b779dba` | **部署留痕**：`infra/README.md` 补首次部署记录 + `infra/worker/README.md` 补已部署记录 |
| 04 | `04de972` | **项目标识改定 `dev-sandbox`**（状态对象前缀 + Worker 名 + **开启 S3 原生锁** + 顺带修正 `terraform.tfvars.example` 里的旧 Worker 名 + `infra/README.md` 补改名留档） |
| 05 | 纯文档若干 | 收口轮：PRD 验收逐条核销 + 词汇表三词条 + 总览 / 看板 / 任务清单同步 + 根 `README.md` 补 `infra/` 行与前端部署口径 + 本留档 `RESULTS.md` |

> **04 轮的域名绑定与真机验收本身零提交**——`terraform apply` 只改远端状态；**05 轮零代码改动**。

---

> **收口记（2026-11-12）**：**01~05 全部 done、全轮无遗留开口。** 唯一开口（04 轮的公网真机浏览器八步）已由**用户于 2026-11-12 在真实浏览器逐条执行、全部通过**而闭合；控制台**无 CORS 预检失败、无混合内容告警**。
>
> **看板与任务集同步**：[[current-state.md|当前状态]]（活跃需求 / 任务看板 / TODO 段）与 [[tasks/console-cloudflare/README.md|任务集 README]]（状态行 / 任务表）已同步为「01~05 全部 done，2026-11-12 收口」。
