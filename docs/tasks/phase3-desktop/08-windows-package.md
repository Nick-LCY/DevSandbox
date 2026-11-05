---
prd: prds/phase3-desktop.md
status: done
---
# 任务：Windows 打包产物与冒烟

## 目标

产出可安装的 Windows 桌面应用，并在干净 Windows 机器上完成安装与冒烟。目标平台只承诺 Windows（Tauri + WebView2）。

## 涉及文件

- 改 `apps/desktop/src-tauri/tauri.conf.json` — 打包目标（NSIS）、图标、`webviewInstallMode`、版本号
- 改 `apps/desktop/package.json` — 构建脚本（`tauri build`）
- 新增 `apps/desktop/README.md` — 构建说明、出包路径、已知限制（未签名、WebView2 要求）**（实际落地情况：构建说明 / 出包路径 / WebView2 要求已写；**未签名限制与「仅 Windows 承诺」两条已于 2026-11-04 由并行改动补齐**，见完成标准）**
- 新增 `.github/workflows/desktop-windows.yml`（**仅当 P4 裁决走 GitHub Actions 时**）
- 改 `docs/current-state.md` — 记录出包路径与产物形态

## 实施步骤

1. **打包配置**：NSIS 安装包（可选 MSI）；`frontendDist` 指向 `apps/web/frontend/dist`；应用图标齐备；`webviewInstallMode` 按 P4 结论选（Evergreen 静默安装 / 离线安装包 / 提示用户自装）。
2. **出包**：按 P4 裁决的路径执行（GitHub Actions `windows-latest` 或用户自有 Windows 机器）；记录环境、耗时与产物路径。
3. **干净机冒烟**：在未装过本应用的 Windows 机器上：安装 → 启动 → 出现连接引导态 → 填入后端地址与令牌 → 连上后端 → 沙箱列表可见 → 打开终端 → 剪贴板快捷键可用 → 端口转发开启后本机 `127.0.0.1:<端口>` 可访问。
4. **限制明示**：安装包未做代码签名（无证书），SmartScreen 可能告警；README 里写明。

## 完成标准

- [x] Windows 安装包产出成功（NSIS）：Windows 11 产出 `setup.exe` 约 **3.7 MB**，落在**默认路径** `apps\desktop\src-tauri\target\release\bundle\nsis\`。**（原措辞「产物入库或归档到约定位置」按实际口径改写：产物**不入库**——`src-tauri/target/` 已被 `.gitignore` 忽略，按默认路径随构建留存即可。）**
- [x] 在 Windows 11 机器上安装成功、启动成功、无控制台窗口残留。**（口径说明：冒烟环境为**用户自有 Windows 11 机器**；原措辞「干净 Windows 机器」中「全新、未装过本应用」这一属性本轮**未另行记录**，不据此声称「干净机」结论。）**
- [x] 冒烟链路全过：连接引导 → 填配置 → 连上后端 → 沙箱列表 → 网页终端 → 剪贴板 → 端口转发本机访问。**（用户确认冒烟通过——安装、启动、连接、使用均无问题；各环节的实测分别由 03 远端形态真机全链路（连接引导 / 填配置 / 连上后端 / 沙箱列表 / 网页终端）、P2 三项冒烟（剪贴板读写双向）与 06 真机连通（本机 `127.0.0.1:<端口>` 访问沙箱服务）覆盖。）**
- [x] `apps/desktop/README.md` 写明构建命令序列、出包路径、WebView2 要求（前置环境 + 运行时策略）、Linux 侧只保证源码可构建 / 出包必须在 Windows。**（**未签名 / SmartScreen 告警**与 **仅 Windows 承诺**两条限制说明**已由并行改动补入 `apps/desktop/README.md`（2026-11-04）**——见下方遗留项的闭合说明。）**
- [x] **遗留（已闭合）**：**未签名导致的 SmartScreen 告警**、**Linux / macOS 不承诺**这两条限制原先尚未显式写入 `apps/desktop/README.md`（该文件在 `docs/` 之外，08 轮按约束不改动，留待 09 收口轮或后续补齐）。**2026-11-04 由并行改动补齐**——README 增补「未签名 / SmartScreen 告警」与「仅 Windows 承诺」两条限制说明，**本遗留项消除**。**未签名告警本身属预期行为**（无代码签名证书），用户已确认不构成问题。
- [x] 出包路径有可重复执行的说明（脚本或 CI 配置），不依赖口头知识。**（以 `apps/desktop/README.md` 的「Windows 构建指引 / 构建命令序列 / 产物位置」为准；路径②——用户自有 Windows 机器本地构建——已实际跑通。）**
- [x] 桌面端产物与 web 形态产物来自**同一份前端源码**（无第二份前端）。**（`tauri.conf.json` 的 `build.frontendDist` 直接指向 `apps/web/frontend/dist`，出包时由 `beforeBuildCommand` 从同一份源码重建前端产物。）**

## 依赖

- 依赖 [[tasks/phase3-desktop/01-prototype-and-spike.md|01 打样轮]] 的 P2 / P4 结论。
- 依赖 [[tasks/phase3-desktop/03-frontend-connection-layer.md|03]] 与 [[tasks/phase3-desktop/06-port-forward-desktop.md|06]] 的功能就位。
- 依赖 [[tasks/phase3-desktop/07-acceptance-tokenization.md|07]] 提供的令牌获取方式（冒烟时用真实令牌或测试令牌）。
- 显式依赖 [[tasks/phase3-desktop/03-frontend-connection-layer.md|03]] 与 [[tasks/phase3-desktop/06-port-forward-desktop.md|06]] 的 CSP 闸门已闭合（`app.security.csp` 不得为 `null`，见 [[architecture/decisions/0015-桌面壳与连接配置抽象.md#7. 打样轮临时偏离（2026-11-03）|0015 打样轮临时偏离节]]）；**出包前必须核验**。

## 收口（2026-11-04）

- **用户确认：冒烟通过**——安装、启动、连接、使用均无问题。
- **产物**：NSIS 安装包 `setup.exe`，约 **3.7 MB**（Windows 11），落在**默认路径** `apps\desktop\src-tauri\target\release\bundle\nsis\`；**产物不入库**（`src-tauri/target/` 在 `.gitignore` 里）。
- **构建耗时：未统计**——本轮未采集 `pnpm install` / 前端 `pnpm build` / `pnpm tauri build` 各自的墙钟耗时；**用户明确接受，此前留档如实空缺即可，不再待补**。
- **未签名告警属预期行为**（无代码签名证书，Windows SmartScreen 可能提示），用户确认不构成问题。
- **出包路径**：路径②（用户自有 Windows 机器本地构建），与 [[tasks/phase3-desktop/RESULTS.md|三期留档]] 第七节 P4 的正式记录一致；**路径①（GitHub Actions）仍未验**（仓库无远端、无 `.github`）。
- **冒烟环境**：用户自有 Windows 11 机器；**是否为全新、未装过本应用的机器，本轮未另行记录**——不据此声称「干净机」结论。
- **状态**：todo → done。**遗留一条文档补齐项**（README 补写未签名 / SmartScreen 与仅 Windows 承诺），见完成标准——**该遗留项已于 2026-11-04 由并行改动补齐消除**。
