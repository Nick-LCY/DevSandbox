---
prd: prds/console-cloudflare.md
status: todo
---
# 任务：Cloudflare Workers 项目与手动部署链

> 需求见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。
> **本任务完成「首次部署成功」**——`workers.dev` 地址能返回控制台页面。

## 目标

在 `infra/worker/` 下建 **Cloudflare Workers 项目**，接入 `wrangler`，把**手动部署链**跑通到**首次 `wrangler deploy` 成功**。

载体 = **Workers + 静态资产**（**不是 Pages**）：Worker 脚本是**纯 JS ESM 极简 passthrough**，前端构建产物由 Workers 的 `[assets]` 绑定直接服务。

## 涉及文件

```
infra/worker/
├── package.json          # wrangler 装为 devDependency + scripts
├── wrangler.toml         # name / main / compatibility_date / account_id / [assets]
└── src/
    └── index.js           # 纯 JS ESM 极简 passthrough
```

- `infra/README.md` —— **记录首次部署的账号 / Worker 名 / 地址**（本任务补写）。

## 实施要点

### `wrangler` 的位置

- **`wrangler` 装在 `infra/worker/package.json` 的 `devDependency`**；
- **不进 `apps/web/frontend` 的依赖树**——前端包的依赖树保持干净，不被部署工具污染。

### `package.json` 的 scripts

| script | 行为 | 门禁 |
|---|---|---|
| `dev` | `wrangler dev`（本地起 Worker 预览） | **不作门禁** |
| `deploy` | **先 `pnpm --dir ../../apps/web/frontend run build`，再 `wrangler deploy`** —— **一条命令**完成「构建前端 + 部署 Worker + 上传静态资产」 | **是** |
| `deploy:dry` | 干跑（不发真实部署，或用 `--dry-run`） | 否 |

> `deploy` 把前端构建**串进同一条命令**，避免出现「以为部署了新前端、其实还是旧 `dist`」的经典坑。

### `wrangler.toml`

| 键 | 值 | 说明 |
|---|---|---|
| `name` | Worker 名 | 与 04 轮 `workers_custom_domain` 的 `script_name` 对应 |
| `main` | `src/index.js` | 入口 |
| `compatibility_date` | **填当天**（2026-11-11） | Workers 运行时兼容日期 |
| `account_id` | 用户提供的 Cloudflare Account ID | **非机密，可入库** |
| `[assets].directory` | `../../apps/web/frontend/dist` | 静态资产来源 |
| `[assets].binding` | `ASSETS` | 绑定名 |
| `[assets].run_worker_first` | `false` | 资产请求**不经** Worker 函数（直出） |
| `[assets].not_found_handling` | `none` | **哈希路由不需要回退规则**（前端用 `#/sandboxes/...`） |

### `src/index.js`

- **纯 JS ESM**（无 TypeScript、无构建步骤——这个 Worker 不做逻辑，只做 passthrough）；
- **非资产路径返回 404**；
- 不写业务逻辑、不碰令牌、不代理 API——**API 一律直连后端**（跨源由后端 CORS 放行）。

### 凭据

- **API Token 只走环境变量 `CLOUDFLARE_API_TOKEN`**，**绝不入库**（不入 `wrangler.toml`、不入 `package.json`、不入任何提交物）。

## 完成标准

- [ ] `infra/worker/package.json` 存在，`wrangler` 在 **devDependency**；`apps/web/frontend` 的依赖树**未引入** wrangler。
- [ ] scripts 齐备：`dev`（不作门禁）/ `deploy`（**先 build 再 deploy，一条命令**）/ `deploy:dry`。
- [ ] `wrangler.toml` 九项齐备（`name` / `main` / `compatibility_date`=2026-11-11 / `account_id` / `[assets].directory` / `binding` / `run_worker_first=false` / `not_found_handling=none`）。
- [ ] `src/index.js` 是**纯 JS ESM 极简 passthrough**，非资产路径 **404**。
- [ ] **无 API Token 入库**（仓库内 grep `CLOUDFLARE_API_TOKEN` 只出现在文档与脚本说明里，不出现在任何取值处）。
- [ ] `infra/worker/` 有独立锁文件并入库（与前端包分离）。
- [ ] **门禁**：Terraform `fmt` / `validate` **仍过**（02 轮成果不回归）+ 前端 `build` **成功** + **`wrangler deploy` 成功**。
- [ ] `workers.dev` 地址**可访问且返回控制台页面**（不是 404、不是裸 JSON）。
- [ ] `infra/README.md` 记录**首次部署**的账号 / Worker 名 / 地址。

## 依赖

- 依赖 [[tasks/console-cloudflare/02-terraform-base.md|02 Terraform 底座]]（目录约定、凭据注入口径）。
- 下游：[[tasks/console-cloudflare/04-domain-and-live-acceptance.md|04 域名绑定与真机验收]]（04 的 `workers_custom_domain` 要指向**本轮建出来的** Worker ⇒ 部署顺序 `wrangler deploy` → `terraform apply`）。
- 决策依据：[[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]] 第 1 / 4 / 5 节。
- 需求：[[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]；任务集：[[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]。

## 待用户提供（阻塞项）

- **Cloudflare API Token**（环境变量 `CLOUDFLARE_API_TOKEN` 注入）——缺它则 `wrangler deploy` 无法执行。
- **Cloudflare Account ID**（写进 `wrangler.toml` 的 `account_id`，非机密）。
