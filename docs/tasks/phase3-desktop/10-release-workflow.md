---
prd: prds/phase3-desktop.md
status: done
---
# 任务：同版本 tag 发布工作流与桌面端下载入口

## 目标

为同一个 `vX.Y.Z` tag 建立 Windows 桌面端发布链：先在 Windows runner 上完成版本校验、前端门禁、Rust tests 与 x64 NSIS 构建，再部署 Cloudflare Worker，最后创建带安装包附件的 GitHub Release；同时让网页端的「安装桌面端」入口直接指向 Releases 页面。

## 实施结果

- `.github/workflows/release.yml` 监听精确形式的 `v*.*.*` tag，并按 `build-windows → deploy-worker → create-release` 串行执行。
- `scripts/verify-release-version.mjs` 将 tag 版本与以下五个字段逐一比对：
  - `apps/desktop/package.json`
  - `apps/web/frontend/package.json`
  - `infra/worker/package.json`
  - `apps/desktop/src-tauri/tauri.conf.json`
  - `apps/desktop/src-tauri/Cargo.toml`
- `build-windows` 只使用构建所需的仓库内容权限，不注入 Cloudflare 生产凭据；它运行前端 `typecheck`、`typecheck:tests`、tests 与桌面端 Rust tests，并由 Tauri build 生成前端 `dist`。构建后校验 `index.html` 与非空文件集，上传已校验的 `web-frontend-dist` artifact；x64 NSIS 安装包另行上传。
- `deploy-worker` 下载并再次校验 `web-frontend-dist`，直接把该 artifact 放回 `apps/web/frontend/dist`；部署步骤执行 `pnpm exec wrangler deploy`，不重新构建前端。`CLOUDFLARE_API_TOKEN` 只挂在最终部署步骤，checkout、artifact 下载 / 校验、依赖安装等更早步骤均不可见该 token；不运行 Terraform。
- Worker 发布 job 保留 GitHub Environment `production` 作为部署记录分类（若仓库保留该 Environment）。按单人维护仓库的发布策略，不配置 required reviewers，也不配置 `v*.*.*` tag 保护 / 部署规则；`environment` 不是审批或安全门禁。完整口径见 [[conventions/release-process.md|发布流程约定]]。
- 不同 tag 的 Worker 发布使用 `production-worker-deploy` 并发组，`cancel-in-progress: false`，因此 Worker 发布排队串行；job 依赖仍保证 `build-windows → deploy-worker → create-release`。
- 除 Rust 工具链外的 `uses:` action 均固定 commit SHA：checkout `11bd71901bbe5b1630ceea73d27597364c9af683`、pnpm/action-setup `7088e561eb65bb68695d245aa206f005ef30921d`、setup-node `49933ea5288caeca8642d1e84afbd3f7d6820020`、upload-artifact `ea165f8d65b6e75b540449e92b4886f43607fa02`、download-artifact `d3f86a106a0bac45b974a628896c90dbdf5c8093`；Rust 使用显式 `1.90.0`，目标为 `x86_64-pc-windows-msvc`。
- Release job 使用 GitHub token 创建正式 Release，并附加 `DevSandbox-<version>-windows-x64-setup.exe`；未签名 Windows 安装包可接受，SmartScreen 告警属于已知限制。
- 网页端口转发区的「安装桌面端」改为新标签打开 `https://github.com/Nick-LCY/DevSandbox/releases`，不再打开旧安装说明弹窗。

## 完成标准

- [x] 同一 `vX.Y.Z` tag 能按 `build-windows → deploy-worker → create-release` 串联 Windows x64 NSIS build/tests、Cloudflare Worker deploy 与 GitHub Release 创建步骤；Worker 发布并发组保持串行。
- [x] 版本校验覆盖桌面、前端、Worker、Tauri 配置与 Cargo manifest 共五个字段。
- [x] `build-windows` 不注入 Cloudflare 生产凭据，生成并校验 `web-frontend-dist` artifact；`deploy-worker` 下载该 artifact，且不重新构建前端。
- [x] `CLOUDFLARE_API_TOKEN` 只在最终 `pnpm exec wrangler deploy` 步骤可见，不依赖 Terraform。
- [x] `production` Environment（若保留）仅作为 Worker 部署记录分类；按单人维护仓库策略，不配置 required reviewers 或 tag 保护规则，不把 `environment` 声明当作审批或安全门禁。
- [x] workflow 的 actions 使用固定 commit SHA，Rust 工具链显式为 `1.90.0`；前端 typecheck/tests 与 Rust tests 已通过，未声称 workflow 已经在真实 tag 上跑过。
- [x] 网页端安装入口指向 GitHub Releases 并使用新标签打开。
- [x] 未签名 Windows 安装包的接受口径已写入发布流程；不把代码签名当作发布阻塞条件。

## 当前边界

本任务只代表发布工作流与入口改造已交付。首次真实 `vX.Y.Z` tag 发布、Worker 线上部署和 GitHub Release 线上创建尚未执行；`production` Environment（若保留）仅作部署记录分类，不配置 required reviewers 或 `v*.*.*` tag 保护 / 部署规则，也不作为审批或安全门禁；后续动作见 [[tasks/phase3-desktop/11-first-tag-release.md|首次真实 tag 发布]]。

## 依赖

- 依赖 [[tasks/phase3-desktop/08-windows-package.md|08 Windows 打包]] 的 NSIS 与 Windows 目标口径。
- 依赖 [[tasks/phase3-desktop/09-acceptance-and-docs.md|09 验收回归与文档收口]] 的前端与桌面功能基线。
