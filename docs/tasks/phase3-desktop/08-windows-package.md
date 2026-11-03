---
prd: prds/phase3-desktop.md
status: todo
---
# 任务：Windows 打包产物与冒烟

## 目标

产出可安装的 Windows 桌面应用，并在干净 Windows 机器上完成安装与冒烟。目标平台只承诺 Windows（Tauri + WebView2）。

## 涉及文件

- 改 `apps/desktop/src-tauri/tauri.conf.json` — 打包目标（NSIS）、图标、`webviewInstallMode`、版本号
- 改 `apps/desktop/package.json` — 构建脚本（`tauri build`）
- 新增 `apps/desktop/README.md` — 构建说明、出包路径、已知限制（未签名、WebView2 要求）
- 新增 `.github/workflows/desktop-windows.yml`（**仅当 P4 裁决走 GitHub Actions 时**）
- 改 `docs/current-state.md` — 记录出包路径与产物形态

## 实施步骤

1. **打包配置**：NSIS 安装包（可选 MSI）；`frontendDist` 指向 `apps/web/frontend/dist`；应用图标齐备；`webviewInstallMode` 按 P4 结论选（Evergreen 静默安装 / 离线安装包 / 提示用户自装）。
2. **出包**：按 P4 裁决的路径执行（GitHub Actions `windows-latest` 或用户自有 Windows 机器）；记录环境、耗时与产物路径。
3. **干净机冒烟**：在未装过本应用的 Windows 机器上：安装 → 启动 → 出现连接引导态 → 填入后端地址与令牌 → 连上后端 → 沙箱列表可见 → 打开终端 → 剪贴板快捷键可用 → 端口转发开启后本机 `127.0.0.1:<端口>` 可访问。
4. **限制明示**：安装包未做代码签名（无证书），SmartScreen 可能告警；README 里写明。

## 完成标准

- [ ] Windows 安装包产出成功（NSIS），产物入库或归档到约定位置。
- [ ] 在干净 Windows 机器上安装成功、启动成功、无控制台窗口残留。
- [ ] 冒烟链路全过：连接引导 → 填配置 → 连上后端 → 沙箱列表 → 网页终端 → 剪贴板 → 端口转发本机访问。
- [ ] `apps/desktop/README.md` 写明构建命令、出包路径、WebView2 要求、未签名限制、Linux / macOS 不承诺。
- [ ] 出包路径有可重复执行的说明（脚本或 CI 配置），不依赖口头知识。
- [ ] 桌面端产物与 web 形态产物来自**同一份前端源码**（无第二份前端）。

## 依赖

- 依赖 [[tasks/phase3-desktop/01-prototype-and-spike.md|01 打样轮]] 的 P2 / P4 结论。
- 依赖 [[tasks/phase3-desktop/03-frontend-connection-layer.md|03]] 与 [[tasks/phase3-desktop/06-port-forward-desktop.md|06]] 的功能就位。
- 依赖 [[tasks/phase3-desktop/07-acceptance-tokenization.md|07]] 提供的令牌获取方式（冒烟时用真实令牌或测试令牌）。
- 显式依赖 [[tasks/phase3-desktop/03-frontend-connection-layer.md|03]] 与 [[tasks/phase3-desktop/06-port-forward-desktop.md|06]] 的 CSP 闸门已闭合（`app.security.csp` 不得为 `null`，见 [[architecture/decisions/0015-桌面壳与连接配置抽象.md#7. 打样轮临时偏离（2026-11-03）|0015 打样轮临时偏离节]]）；**出包前必须核验**。
