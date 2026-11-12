# infra/worker/ —— Cloudflare Workers 项目

控制台前端的**部署载体**：Cloudflare **Workers + 静态资产**（不是 Pages）。

- Worker 名：**`sandbox-console-web`**
- 自定义域名：**`dev.sankabox.com`**（**不由本项目配**——见下）
- 静态资产来源：`../../apps/web/frontend/dist`（前端构建产物）

> **单一所有者原则**（见 [infra/README.md](../README.md) 第 2 节）：
> 脚本与静态资产归 **`wrangler`**（本目录），zone / 自定义域名归 **Terraform**（`infra/`）。
> ⇒ 本目录**不出现**任何域名配置。

---

## 1. 部署顺序（硬约束）

**`wrangler deploy` 先 → `terraform apply` 后。**

原因：自定义域名资源要指向一个**已经存在**的 Worker；脚本不存在时
`terraform apply` 会失败（找不到 script）。完整口径见
[infra/README.md 第 3 节「部署顺序（硬约束）」](../README.md#3-部署顺序硬约束)。

```
1) 构建前端 + 部署 Worker + 上传静态资产   cd infra/worker && pnpm run deploy
2) 绑定自定义域名（Terraform）                cd infra && terraform apply
```

反向顺序（先 `terraform apply`）会失败或指向不存在的 Worker，**不要尝试**。

---

## 2. 凭据注入（绝不入库）

- **Cloudflare API Token 只走环境变量 `CLOUDFLARE_API_TOKEN`**，**绝不入库**
  （不入 `wrangler.toml`、不入 `package.json`、不入任何提交物）。
- Token 权限需覆盖 **Zone:Read + DNS:Edit + Workers 写**，
  范围**尽量限定到 `sankabox.com` 这一个 zone**（不要用全账号 token）。
- `wrangler.toml` 里的 `account_id` 是 **Account ID**（32 位小写 hex），
  **非机密**、可入库——它**不是** token，别混。

```bash
export CLOUDFLARE_API_TOKEN='<API Token>'
```

> 没有 Token ⇒ `pnpm run deploy` **跑不了**（会卡在登录/鉴权）。
> `pnpm run deploy:dry`（`--dry-run`）**不发真实部署**，只做配置与打包校验。

---

## 3. 常用命令

```bash
cd infra/worker

pnpm install                # 装依赖（锁文件 pnpm-lock.yaml 入库，与前端包分离）

pnpm run dev                # 本地起 Worker 预览（不作门禁）

pnpm run deploy:dry         # 干跑：wrangler deploy --dry-run（不发真实部署）

pnpm run deploy             # 正式部署：先构建前端，再 wrangler deploy
```

> `deploy` 把前端构建**串进同一条命令**
> （`pnpm --dir ../../apps/web/frontend run build && wrangler deploy`），
> 避免出现「以为部署了新前端、其实还是旧 `dist`」的经典坑。
>
> Node 环境按仓库惯例走 **nvm use 22**（`package.json` 的 `engines.node >= 22`）。

---

## 4. 文件说明

| 文件 | 作用 |
|---|---|
| `package.json` | `wrangler` 装在 **devDependency**（**不进前端包的依赖树**）+ scripts（`dev` / `deploy` / `deploy:dry`） |
| `pnpm-lock.yaml` | **独立锁文件并入库**（与前端包分离） |
| `wrangler.toml` | `name` / `main` / `compatibility_date` / `account_id` / `[assets]`（`directory` / `binding` / `run_worker_first=false` / `not_found_handling=none`） |
| `src/index.js` | **纯 JS ESM 极简 passthrough**：非资产路径 **404**（不写业务逻辑、不代理 API） |
| `.gitignore` | 忽略 `node_modules/`、`.wrangler/` |

---

## 5. 首次部署记录（2026-11-12 已部署）

> **当前状态：已部署**（Cloudflare API Token 已到位，走环境变量注入，**未入库**）。

| 项 | 值 |
|---|---|
| Cloudflare 账号（Account ID） | `c6f014ff9f682f99502c1046d5e85ca1` |
| Worker 名 | `sandbox-console-web` |
| `workers.dev` 地址 | `https://sandbox-console-web.nucbox.workers.dev` |
| 自定义域名 | `https://dev.sankabox.com`（**已生效**，HTTP 200） |
| 上传资产数 | **123** 个文件 |
| 部署日期 | **2026-11-12** |
| Worker 版本 id | `2d8b29ba-c5c7-49f3-8a06-2ede41fa9613` |

> 部署命令：`cd infra/worker && pnpm run deploy`（前端 build + `wrangler deploy`）。
> **注意**：改前端代码后要**重新跑**这条命令，`terraform apply` **不会**重新上传资产。
>
> 部署完成后，**同步补记**到 [infra/README.md](../README.md) 第 5 节
> （「首次部署记录」）。
