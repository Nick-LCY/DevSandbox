# 发布流程约定

桌面端与控制台前端的发布链约定。适用对象：`.github/workflows/release.yml`、`scripts/verify-release-version.mjs`、Cloudflare Worker 部署与 GitHub Release 创建。

## 维护模式与发布触发

- **本仓库由单人维护**：没有多人评审流，也没有第二人把关环节。
- **正式发布 = 推送一个 `vX.Y.Z` tag**：tag 版本与下列五个版本字段逐一一致即可推送，推送该 tag 即视为正式发布触发动作。
- **不配置 `production` Environment 的 required reviewers**。
- **不配置 `v*.*.*` tag 保护 / 部署规则**（不做 tag 限制，也不做 tag 触发限制）。
- 由此，**首次发布的唯一外部前置是「准备好版本号并 push tag」**，不存在「先在 GitHub Settings 配置审批与保护规则」这一步。

## `production` Environment 的定位

- workflow 的 `deploy-worker` job 可声明 `environment: production`，**仅作为 Worker 部署记录的分类标签**——便于在 Actions 列表与部署记录里区分生产发布。
- 它**不是审批门禁、不是安全门禁**：不阻塞发布，不要求人工批准，**不设置 required reviewers**。
- 该 Environment 是**可选**的：若仓库中不保留它，发布链（构建 → Worker 部署 → 创建 Release）同样正常工作。

## 凭据与最小暴露面

- `CLOUDFLARE_API_TOKEN` 存放在目标仓库 secrets 中。
- 该 token **只在最终 `pnpm exec wrangler deploy` 步骤注入**；checkout、artifact 下载与校验、依赖安装等更早步骤不可见。
- 构建侧（`build-windows`）不接触任何 Cloudflare 生产凭据。

## 版本一致性

`scripts/verify-release-version.mjs` 将 tag 版本与五个字段逐一比对，全部一致才放行：

- `apps/desktop/package.json`
- `apps/web/frontend/package.json`
- `infra/worker/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.toml`

## 产物与已知限制

- Windows x64 NSIS 安装包**未签名可接受**；SmartScreen 告警属于已知限制，**不作为发布失败条件**。
- 桌面端 release profile 的 `panic = "abort"` 处置见 [[tasks/phase3-desktop/RESULTS.md|三期留档]] 与 [[current-state.md|当前状态]] 的 TODO 区（与本约定无冲突）。

## 版本发布记录

- `v0.2.0`（2026-11-26）：五个版本字段已改，随「终端交互增强」即将发布；tag、Actions run 与 Worker 部署结果待回填。

## 状态口径（不得越界声明）

- **workflow 文件已交付 ≠ 已发布**：只有真实 `vX.Y.Z` tag 触发的 run 才能作为线上部署与 Release 成功的证据。
- 未 push 真实 tag 之前，不得声称 Cloudflare Worker 已线上部署、GitHub 正式 Release 已创建。
- 首次真实 tag 发布的任务与留档见 [[tasks/phase3-desktop/11-first-tag-release.md|首次真实 tag 发布]] 与 [[tasks/phase3-desktop/RESULTS.md|三期留档]]。
