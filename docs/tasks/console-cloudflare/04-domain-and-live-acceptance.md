---
prd: prds/console-cloudflare.md
status: doing
---
# 任务：域名绑定与公网真机浏览器验收

> 需求见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。
> 本任务把 `dev.sankabox.com` 绑到 Worker 上，并做**公网真机浏览器**全功能验收——这是本轮唯一一次「按真实生产形态」端到端点通的验证。
> **本任务进行中（doing，2026-11-11 起）**——**域名绑定已完成、HTTP 层验收已过**；**剩余 = 用户浏览器真机验收八步**（须在用户侧真实浏览器执行）。详见文末「进展（2026-11-11）」。
> **2026-11-12 追加**：**改名 `dev-sandbox` 后域名已重绑并复验 200**（`service` `forces replacement`、约 2 秒解绑窗口）——**验收状态不变，仍为 `doing`**；详见文末「改名后的域名重绑与复验（2026-11-12）」。

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

- [ ] `main.tf` 落 `cloudflare_workers_custom_domain`：`hostname = dev.sankabox.com`、`script_name` 指向 03 轮 Worker、`zone_id` 取自 zone data。
- [ ] **部署顺序**：`wrangler deploy` **先**、`terraform apply` **后**（顺序在 `infra/README.md` 写明）。
- [ ] DNS 路线已确认并留档（同账号自动建记录 / 不同账号改走 `routes` + 手工 record）。
- [ ] `terraform state list` 与 `terraform plan` 核对：**恰为** zone data + `workers_custom_domain`，**无 `workers_script`**。
- [ ] `https://dev.sankabox.com` **返回控制台页面**（不是 404、不是裸 JSON、不是 Cloudflare 错误页）。
- [ ] 真机八步全部走通：引导面板 → 填地址令牌（先体检）→ 工作台 → **健康 ok、无降级文案** → 列表 / 新建（含镜像选择器）/ 详情 / 终端（连上敲命令、断连重连）/ 停止 / 删除 → 模板 → 文件注入 → 运行期文件面板 → **剪贴板可用**。
- [ ] **无 CORS 预检失败**、**无混合内容告警**。
- [ ] `infra/RESULTS.md` **证据留档**齐备（时间点、URL、逐条结果、指针）。

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
- **验收状态不变**：**本任务仍为 `doing`**——**剩余 = 用户浏览器真机验收八步**（须在用户侧真实浏览器执行），清单见上文「剩余 = 用户浏览器真机验收八步」。
