---
prd: prds/phase3-desktop.md
status: done
---
# 任务：首次真实 tag 发布

## 目标

在发布工作流已交付的基础上，选择并推送第一个符合版本约束的 `vX.Y.Z` tag，完成一次真实的 Windows 安装包构建、Cloudflare Worker 部署与 GitHub 正式 Release 创建。

发布策略：本仓库由单人维护，推送与五个版本字段一致的 `vX.Y.Z` tag 即视为正式发布触发动作；不配置 `production` Environment required reviewers，也不配置 `v*.*.*` tag 保护 / 部署规则。workflow 中的 `production` Environment（若保留）仅用于部署记录分类，不作为审批或安全门禁。完整口径见 [[conventions/release-process.md|发布流程约定]]。

## 完成标准

- [x] 单人维护者确认目标 `v0.1.0`，核对版本字段后将 annotated tag push 到目标仓库；commit `169724a` 已推送，且包含先前批准的 `ac39271`。
- [x] `build-windows` 成功：版本校验、前端 typecheck/tests、Rust tests、Windows x64 NSIS build 与 artifact 上传全部通过；构建不需要 `CLOUDFLARE_API_TOKEN`，并产出经校验的 `web-frontend-dist` artifact。
- [x] `deploy-worker` 成功：下载并校验 `web-frontend-dist`，使用 `CLOUDFLARE_API_TOKEN` 完成最终 `pnpm exec wrangler deploy`；token 只在该 deploy 步骤可见，不引入 Terraform 步骤；Cloudflare deploy job 成功。
- [x] 核对 Worker 发布遵守 `production-worker-deploy` 并发组的串行语义；workflow 使用固定 SHA 的 actions，Rust 工具链为显式 `1.90.0`。
- [x] `create-release` 成功：GitHub 正式 Release 创建完成，并附加 x64 NSIS 安装包。
- [x] 发布后核对 Release 资产可下载；资产为 `DevSandbox-0.1.0-windows-x64-setup.exe`，大小 **4,452,313 bytes**；安装包未签名，SmartScreen 告警按已接受限制记录，不把它误判为发布失败。

## 执行实证（2026-11-25 UTC）

- **Tag / commit**：annotated tag `v0.1.0` 已推送；commit `169724a` 已推送，且已将先前批准的 `ac39271` 一并推送。
- **GitHub Actions**：run `45567316929` 成功；`build-windows`、`deploy-worker`、`create-release` 均 success，Cloudflare deploy job 成功。
- **正式 Release**：<https://github.com/Nick-LCY/DevSandbox/releases/tag/v0.1.0>
- **安装包**：`DevSandbox-0.1.0-windows-x64-setup.exe`，**4,452,313 bytes**，已作为 Release 资产并可下载。
- **验证边界**：安装包未签名；本次记录只确认发布资产可下载，不代表用户已安装、启动或连接验证。仍需手工安装验证。

## 依赖

- 依赖 [[tasks/phase3-desktop/10-release-workflow.md|10 发布工作流与桌面端下载入口]] 已完成。
- 由单人维护者选择版本并执行 tag push；已执行 `v0.1.0` 发布并完成 Cloudflare 与 GitHub Release 核对，详见本节「执行实证」。安装包仍需手工安装验证。
