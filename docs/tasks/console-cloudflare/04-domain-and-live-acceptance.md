---
prd: prds/console-cloudflare.md
status: todo
---
# 任务：域名绑定与公网真机浏览器验收

> 需求见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。
> 本任务把 `dev.sankabox.com` 绑到 Worker 上，并做**公网真机浏览器**全功能验收——这是本轮唯一一次「按真实生产形态」端到端点通的验证。

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

- **MinIO S3 远端状态配置**（端点 / 桶 / region / 凭据）——`terraform init` 的前置。
- **Cloudflare API Token**（`CLOUDFLARE_API_TOKEN`）与 **Account ID**。
- **zone 与账号是否同账号**的确认——决定 DNS 走自动建记录还是手工 record 路线。
