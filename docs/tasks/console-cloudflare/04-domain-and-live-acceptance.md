---
prd: prds/console-cloudflare.md
status: done
---
# 任务：域名绑定与公网真机浏览器验收

> 需求见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。
> 本任务把 `dev.sankabox.com` 绑到 Worker 上，并做**公网真机浏览器**全功能验收——这是本轮唯一一次「按真实生产形态」端到端点通的验证。
> **本任务已收口（done，2026-11-12）**——**域名绑定、HTTP 层验收、用户浏览器真机八步全部通过**；收口轮**零代码改动、零提交**（只做文档核销与留档）。最终验收记录见文末「浏览器真机验收通过（2026-11-12，用户执行）」，全轮留档见 [[tasks/console-cloudflare/RESULTS.md|控制台前端托管到 Cloudflare 全轮收口留档]]。
> **历史口径保留（不改写）**：2026-11-11 的「域名绑定已完成、HTTP 层验收已过」见文末「进展（2026-11-11）」；2026-11-12 的「改名 `dev-sandbox` 后域名已重绑并复验 200」见文末「改名后的域名重绑与复验（2026-11-12）」。

## 目标

1. 在 Terraform 里落 `cloudflare_workers_custom_domain`，把 **`dev.sankabox.com`** 绑到 03 轮部署出来的 Worker；
2. 核对 Terraform 的**资源清单**与**计划**，确认**没有** `workers_script` 混进来；
3. 从公网域名做**真机浏览器全功能验收**（八步），并把**证据留档**到 `RESULTS.md`。

## 涉及文件

- `infra/main.tf` — 落 `cloudflare_workers_custom_domain` 资源（`hostname` / `script_name` / `zone_id`）。
- `infra/README.md` — 补部署顺序与 DNS 路线说明。
- `infra/RESULTS.md` — **新增**：本轮验收证据留档（时间点、URL、逐条结果、截图/日志指针）。

## 实施要点

### `main.tf` 的域名资源

```
resource "cloudflare_workers_custom_domain" "console" {
  zone_id     = data.cloudflare_zone.sankabox.id
  hostname    = "dev.sankabox.com"
  script_name = <03 轮的 Worker 名>
}
```

- `zone_id` **取自 `data.cloudflare_zone`**，不硬编码；
- `script_name` **指向 03 轮已部署的 Worker**。

### 顺序（有据）

- **`wrangler deploy` 先、`terraform apply` 后**——域名资源要指向一个**已存在**的 Worker；反序会失败或指向不存在的 Worker。
- **DNS**：zone 与 Worker **同账号** ⇒ `workers_custom_domain` **自动创建 DNS 记录**；**不同账号** ⇒ 改走 **`routes` + 手工 DNS record** 路线，并把这一分叉**留档**在 `infra/README.md` 与 `RESULTS.md` 里（此时资源清单不再是「恰为两项」，须在留档中说明原因）。

### 资源清单核对

- `terraform state list` 与 `terraform plan` 核对：资源清单**恰为** zone data + `workers_custom_domain`，**无 `workers_script`**；
- 同时确认 `terraform plan` 的**变更集为空或仅含预期项**（避免 apply 时顺手改出别的东西）。

### 真机验收八步（浏览器）

从 `https://dev.sankabox.com` 打开，连接 `https://sandbox-api.sankabox.com`：

1. **引导面板**——未配置态出现（后端地址 + 令牌输入）；
2. **填地址与令牌**，保存并连接，**先做体检**（连接前的健康探活）；
3. **工作台**——侧栏与工作区正常渲染；
4. **健康 `ok`，无降级文案**——「前端产物未挂载」这类文案**不得出现**（后端已无 `console_mounted` 字段）；
5. **沙箱生命周期**——列表 / **新建**（含**镜像选择器**）/ **详情** / **网页终端**（连上 → **敲命令** → **断开** → **重连**）/ **停止** / **删除**；
6. **模板**——模板区可用；
7. **文件注入**——创建时注入声明可用；
8. **运行期文件面板**——浏览 / 下载 / 上传可用；
9. **剪贴板**——终端剪贴板快捷键可用（**依赖安全上下文**：CF 域名是 https，安全上下文成立）。

### 负面观察项

- **无 CORS 预检失败**（浏览器控制台无 preflight 报错）；
- **无混合内容告警**（https 页面不加载 http 资源；后端是 https，终端 WS 走 wss）。

## 完成标准

- [x] `main.tf` 落 `cloudflare_workers_custom_domain`：`hostname = dev.sankabox.com`、**`service`** 指向 03 轮 Worker（**provider v5 的字段名**，语义同 v4 的 `script_name`）、`zone_id` 取自 zone data。
- [x] **部署顺序**：`wrangler deploy` **先**、`terraform apply` **后**（顺序在 `infra/README.md` 第 3 节写明，且标为**硬约束**）。
- [x] DNS 路线已确认并留档（同账号自动建记录 / 不同账号改走 `routes` + 手工 record）——**实测同账号**，由 `data "cloudflare_zone"` 的 `filter.account.id` 子过滤在 plan 期强制。
- [x] `terraform state list` 与 `terraform plan` 核对：**恰为** zone data + `workers_custom_domain`，**无 `workers_script`**（改名与重绑后**复验仍恒为 2 项**）。
- [x] `https://dev.sankabox.com` **返回控制台页面**（不是 404、不是裸 JSON、不是 Cloudflare 错误页）——**首探即 200**，内容与 `workers.dev` **byte 级一致**。
- [x] 真机八步全部走通：引导面板 → 填地址令牌（先体检）→ 工作台 → **健康 ok、无降级文案** → 列表 / 新建（含镜像选择器）/ 详情 / 终端（连上敲命令、断连重连）/ 停止 / 删除 → 模板 → 文件注入 → 运行期文件面板 → **剪贴板可用**——**2026-11-12 由用户在真实浏览器逐条执行、全部通过**。
- [x] **无 CORS 预检失败**、**无混合内容告警**（用户浏览器控制台观察）。
- [x] **证据留档齐备**（时间点、URL、逐条结果、指针）——**留档落在 `docs/tasks/console-cloudflare/RESULTS.md`**（证据归文档库；`infra/README.md` 只留部署与改名记录）。**偏离说明**：施工单原写 `infra/RESULTS.md`，实际**未在 `infra/` 建该文件**——`infra/` 是 IaC 代码目录，不放验收叙事。

## 依赖

- 依赖 [[tasks/console-cloudflare/03-cloudflare-workers-deploy.md|03 Cloudflare Workers 部署]]（Worker 必须**已存在**）。
- 与 [[tasks/console-cloudflare/01-backend-api-only-and-acceptance-migration.md|01 后端纯 API 化]] 有事实依赖：后端须已是**纯 API 形态**（否则第 4 步「无降级文案」不成立、根路径不是 404）。
- 下游：[[tasks/console-cloudflare/05-docs-and-adr.md|05 文档收口]]（本任务产出 PRD 验收标准里「真机浏览器验收」与「Terraform 与 Cloudflare」两节的证据）。
- 决策依据：[[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]] 第 1 / 5 节。
- 需求：[[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]；任务集：[[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]。

## 待用户提供（阻塞项）

> **前两项已到位（2026-11-11），第三项本就无需人工确认——部署侧阻塞全部解除。**

- **S3 远端状态配置**（**2026-11-11 改定：真实 AWS S3**——region `ap-southeast-1`、桶 `terraform-654654240294-ap-southeast-1-an`、**AWS 默认端点**）——**已到位**：桶属账号 `654654240294` 的 IAM 用户 `TerraformUser` 凭据经 `infra/.env` 注入（**未入库、未回显**）⇒ **方案 c 落地**，`terraform init` **成功**。
- **Cloudflare API Token**（`CLOUDFLARE_API_TOKEN`）——**已到位**（**只走环境变量、不入库**）；**Account ID 已到位**（`c6f014ff9f682f99502c1046d5e85ca1`，非机密）。
- **zone 与账号是否同账号**的确认——**已由 `data "cloudflare_zone"` 的 `filter.account.id` 子过滤在 plan 期强制**（查不到 zone 即失败）⇒ **无需人工确认**；本轮 `plan` **实证命中**（zone data 正常解析）。

---

## 进展（2026-11-11）

> **本任务状态：doing（2026-11-11 起）。** **域名绑定已完成、HTTP 层验收已过**（部署侧全部到位）；**剩余 = 用户浏览器真机验收八步**。

### 域名绑定与 HTTP 层验收（已过）

| 项 | 结果 |
|---|---|
| 域名绑定 | **已完成**——`terraform apply` **成功**（**1 added**），`cloudflare_workers_custom_domain` 落 **`dev.sankabox.com`**，指向 03 轮 Worker **`sandbox-console-web`** |
| 资源清单 | `terraform state list` **恰 2 项**（zone data + `workers_custom_domain`）、**无 `workers_script`** ⇒ **单一所有者原则守住** |
| 根路径 | `https://dev.sankabox.com` **首探即 200**（**证书即时签发**）；body 含 **`page-layout-title`** 与 **`assets/index-*.js`** |
| 内容一致性 | 与 `workers.dev` 地址内容 **byte 级一致**（**同 sha256**）⇒ 域名层只改写入口，**产物本身未被改动** |
| 资产直出 | `assets/index-DFpMAFde.js` **200**（**635 KB**）⇒ `[assets]` 直出链路成立（`run_worker_first = false`） |
| 非资产路径 | **404** ⇒ 极简 passthrough worker 的兜底行为成立 |

### 一处环境现象（非部署缺陷）

- **现象**：**开发机出口**到 `dev.sankabox.com` **偶发丢包**——**12 次探测中 11 次成功、1 次超时**，另有 **1 次 TLS `unexpected eof`**；`cf-ray` 落 **LAX**，而 `workers.dev` 走代理落 **SIN**。
- **判定**：**开发机出口路由抖动**，**非部署缺陷**（同一时段 `workers.dev` 侧稳定可达、产物 byte 级一致）。
- **处置**：**建议浏览器复验**——以用户侧真实浏览器观察为准。

### 剩余 = 用户浏览器真机验收八步

> 须在**用户侧真实浏览器**打开 `https://dev.sankabox.com`，连接 `https://sandbox-api.sankabox.com`：

1. **引导面板**——未配置态出现（后端地址 + 令牌输入）；
2. **填地址与令牌**——填 `https://sandbox-api.sankabox.com` 与令牌，**保存并连接**，**先做健康自检**（连接前的探活）；
3. **健康自检 `ok`**——界面**无「前端产物未挂载」文案**；
4. **沙箱生命周期**——列表 / **新建**（含**镜像选择器**）/ **详情** / **网页终端**（连上 → **敲命令** → **断开** → **重连**）/ **停止** / **删除**；
5. **模板**——模板区可用；
6. **文件注入**——创建时注入声明可用；
7. **运行期文件面板**——浏览 / 下载 / 上传可用；
8. **终端剪贴板**——`Ctrl+Shift+C` / `Ctrl+Shift+V` 可用（https 安全上下文成立）。

- **负面观察项**：浏览器控制台**无 CORS 预检失败**、**无混合内容告警**。

### 部署侧备注

- **宿主后端仍跑旧版时无阻断**：**新前端不读 `console_mounted`** ⇒ 后端尚未切到纯 API 版也**不影响**本次新前端的功能验证。
- **建议**：宿主后端**择机更新到纯 API 版**；届时**旧 web 形态随之下线根路径页面**（后端 `GET /` 与 `/assets/*` 一律 **404**）⇒ 旧入口不再可用，**更新前需确认无人在用旧入口**。

### 改名后的域名重绑与复验（2026-11-12）

> **本节为追加记，不改写上文 2026-11-11 的绑定与验收记录。** **起因**：**用户拍板**——项目标识统一改为 **`dev-sandbox`**（原 Worker 名 `sandbox-console-web` 太难认），**域名绑定随之重指向新 Worker**。

| 项 | 结果 |
|---|---|
| 重绑原因 | Worker 名 `sandbox-console-web` → **`dev-sandbox`** ⇒ `cloudflare_workers_custom_domain.service` 指向变更 |
| plan 形态 | **`service` 变更为 `forces replacement`** ⇒ 计划形态为 **destroy + create**，中间有**约 2 秒的短暂解绑窗口** |
| apply 结果 | **`Resources: 1 added, 0 changed, 1 destroyed.`** ⇒ 域名已指向新 Worker |
| 资源清单 | `terraform state list` **恒为 2 项**（zone data + `workers_custom_domain`）、**无 `workers_script`** ⇒ **单一所有者原则守住** |
| 复验 | `https://dev.sankabox.com` **200**；内容与 `https://dev-sandbox.nucbox.workers.dev` **byte 级一致**（同一 sha256） |
| 旧 Worker | **`sandbox-console-web` 已删**（旧地址 → **404**、Cloudflare **error code 1042**） |

- **改名细节**（状态对象前缀迁移、**S3 原生锁开启**、提交 `04de972`）见 [[tasks/console-cloudflare/03-cloudflare-workers-deploy.md|任务 03]] 文末「改名（2026-11-12）」。
- **验收状态不变**：**本任务仍为 `doing`**——**剩余 = 用户浏览器真机验收八步**（须在用户侧真实浏览器执行），清单见上文「剩余 = 用户浏览器真机验收八步」。**（此处为 2026-11-12 当时的记录；**已由下文「浏览器真机验收通过（2026-11-12，用户执行）」收口**——本任务现为 `done`。）**

---

## 浏览器真机验收通过（2026-11-12，用户执行）

> **本节为收口记，不改写上文 2026-11-11 的绑定与验收记录。** **执行方 = 用户**（真实浏览器 + 真后端）；**本轮零代码改动、零提交**（只做文档核销与留档）。

### 八步逐条结果

| # | 步骤 | 结果 |
|---|---|---|
| 1 | **引导面板** | **通过**——未配置态出现（后端地址 + 令牌输入） |
| 2 | **填地址与令牌**（`https://sandbox-api.sankabox.com` + 令牌，保存并连接，先做健康自检） | **通过** |
| 3 | **工作台** | **通过**——侧栏与工作区正常渲染 |
| 4 | **健康自检 `ok`，无降级文案** | **通过**——健康态为 `ok`，界面**无「前端产物未挂载」文案**（新前端不读 `console_mounted`） |
| 5 | **沙箱生命周期**（列表 / 新建含镜像选择器 / 详情 / 网页终端**连上敲命令 → 断开 → 重连** / 停止 / 删除） | **通过** |
| 6 | **模板** | **通过**——模板区可用 |
| 7 | **文件注入** | **通过**——创建时注入声明可用 |
| 8 | **运行期文件面板** | **通过**——浏览 / 下载 / 上传可用 |
| 9 | **终端剪贴板**（`Ctrl+Shift+C` / `Ctrl+Shift+V`） | **通过**（https 安全上下文成立） |

### 负面观察项

| 项 | 结果 |
|---|---|
| **CORS 预检失败** | **无**——浏览器控制台未见 preflight 报错 |
| **混合内容告警** | **无**——https 页面未加载 http 资源；后端为 https，终端 WS 走 wss |

### 收口结论

- **本任务状态：doing → done（2026-11-12）**——**唯一开口（用户浏览器真机八步）已闭合**，**全轮 01~05 全部 done**。
- **代码改动：零**；**提交：零**——本轮只做真机验证与文档收口。
- **留档指针**：全轮收口留档见 [[tasks/console-cloudflare/RESULTS.md|控制台前端托管到 Cloudflare 全轮收口留档]]（第五节「真机验收记录」）；PRD 核销见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]] 的「验收标准」。

### 遗留（不阻断）

- **开发机出口偶发丢包**（12 探 11 中 1 超时 + 1 次 TLS `unexpected eof`）——**已判定为环境现象、非部署缺陷**；**用户侧真机浏览器八步全过**进一步证伪「部署缺陷」。
- **宿主后端仍跑旧版**——**不阻断**（新前端不读 `console_mounted`）；**择机更新到纯 API 版**后，**旧 web 形态的根路径页面随之下线**（后端 `GET /` 与 `/assets/*` 一律 404），**更新前需确认无人在用旧入口**。
  - **已解决（2026-11-12）**：宿主已更新至 **`c45192b`** 纯 API 版（05849be → c45192b），**验证全绿**——`/api/health` 字段恰为 `{data_root_configured, status, version}`、`GET /` 404、无令牌 401、`/api/sandboxes` 200、外部 `https://sandbox-api.sankabox.com` 401/200 正常、`https://dev.sankabox.com` 200；**零影响落地**（重启时运行中沙箱容器 0 个，启动清扫仅清 2 条陈旧会话记录 + 2 个遗留转发容器，数据根未动）。上文原表述**不改写**。
- **桌面端旧安装包内嵌旧前端**——状态灯会因 `console_mounted` 缺失 / =false 显示降级文案；**代码修复已在本轮 01 落库，无需改码**，**重新打包即愈**（跨机动作须先 push 分支，见 [[current-state.md|当前状态]] 的 TODO 段）。
  - **条件就绪（2026-11-12）**：用户**已完成 push**（`origin/main` 已含全部提交）⇒ **Windows 机器拉取后重打包即可修复状态灯**。
