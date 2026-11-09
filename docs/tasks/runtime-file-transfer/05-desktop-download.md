---
prd: prds/runtime-file-transfer.md
status: todo
---
# 任务：桌面端下载落盘（原生「保存为」）

> 需求见 [[prds/runtime-file-transfer.md|运行期文件传输 PRD]]。**依赖 03 的接口契约**；与 04 可并行。

## 目标

让**桌面形态**的下载走**原生「保存为」对话框**：用户在保存框里选路径 → Rust 侧带令牌把文件下载下来落盘。

web 形态下载是标准浏览器行为（`fetch` → blob → `a[download]`），**桌面形态不能沿用它**——桌面壳的 CSP 只在 `img-src` 放行 blob，导航 blob: URL 会被拦；且桌面形态要的是**原生保存框**，不是浏览器的下载条。

## 涉及文件

- 改 `apps/desktop/Cargo.toml` — 加 `reqwest`（**rustls-tls + stream 特性，不引 OpenSSL**）与 `tauri-plugin-dialog`
- 改 `apps/desktop/src-tauri/tauri.conf.json`（或等价配置）— 注册 dialog 插件
- 改 `apps/desktop/src-tauri/capabilities/` — **补 dialog 权限**
- 改 `apps/desktop/src-tauri/src/` — **新增 Rust 下载落盘命令**（带令牌流式下载 → 写用户所选路径）
- 改 `apps/desktop/src-tauri/src/main.rs`（或命令注册处）— **注册命令**
- 改 `apps/web/frontend/src/lib/` — **前端桌面 IPC 封装**与**形态分支**（桌面走 `invoke`、web 走 `fetch` + blob）

## 口径

- **依赖**：`reqwest` 用 **rustls-tls + stream 特性**，**不引 OpenSSL**——对齐既有 rustls 栈（三期已因缺 crypto provider 踩过一次，见 [[tasks/phase3-desktop/RESULTS.md|三期留档]] 第十节）。
- **落盘路径 = 用户所选**（保存框返回值），不由前端拼路径。
- **令牌**：随命令参数传入，**不落盘**（沿用既有「Rust 侧不落盘令牌」口径）。
- **`panic = "abort"`**：release profile 配了 `panic = "abort"`，**新增 Rust 代码禁 unwrap / 越界索引**，错误一律 `Result` 收口。
- **前端形态分支**：桌面走 `invoke`、web 走 `fetch` + blob——**上传路径不受影响**（两形态共用 `<input type="file">`，**Rust 上传零改动**）。

## Windows 真机验证清单（本机无法验，必须产出并逐条验过）

- [ ] 上传：文件选择控件能打开、能选到文件。
- [ ] 下载：原生「保存为」对话框能弹出、能选路径、文件确实落到所选路径。
- [ ] 中文文件名：中文名文件的上传与下载都正常。
- [ ] 大文件：大文件传输不卡死、不崩溃（内存与耗时记一笔）。
- [ ] 中途取消：上传中取消、下载中取消都干净收口（不留半截文件、不留挂死任务）。
- [ ] 令牌无效 / 后端不可达：给出明确错误，不闪退。

**未验不宣称完成**：本机是 Linux，Playwright 覆盖不到 Tauri IPC 与原生对话框，**这一段只能由 Windows 真机补**。

## 完成标准

- [ ] `Cargo.toml` 加 `reqwest`（**rustls-tls + stream 特性，不引 OpenSSL**）与 `tauri-plugin-dialog`；**不引入 OpenSSL**。
- [ ] dialog 插件已注册、**capabilities 已补 dialog 权限**。
- [ ] Rust 下载落盘命令实现：带令牌流式下载 → 写入**用户所选路径**；令牌**不落盘**。
- [ ] 新增 Rust 代码**无 unwrap / 越界索引**，错误一律 `Result` 收口（release `panic = "abort"` 下的硬要求）。
- [ ] 命令已注册；前端 IPC 封装走 `window.__TAURI_INTERNALS__.invoke`（**不引 `@tauri-apps/api`**，保持 web 形态产物与依赖树不被 Tauri 污染）。
- [ ] 前端**形态分支**接通：桌面走 `invoke`、web 走 `fetch` + blob（**不导航 blob: URL**）；**上传路径两形态共用 `<input type="file">`，Rust 上传零改动**。
- [ ] **Windows 真机验证清单已产出并逐条验过**（上传选文件 / 保存框 / 中文文件名 / 大文件 / 中途取消 / 错误路径），结果留档。
- [ ] 门禁：`cargo check` 零警告、`cargo test` 全绿；前端 vitest / typecheck / build 全绿。
- [ ] **命令行零改动**；**创建时注入通道零改动**。

## 依赖

- 依赖 [[tasks/runtime-file-transfer/03-server-file-endpoints.md|03 服务端文件传输接口]]（下载端点与响应头）。
- 与 [[tasks/runtime-file-transfer/04-frontend-file-panel.md|04 前端文件浏览面板]] **可并行**；形态分支需与 04 的面板对接——**04 已于 2026-11-09 收口**，`FileBrowserPanel` 的 `desktop` 分支是留桩（`TODO(05)`，不发请求、无行为），本任务接线时替换该分支。
- rustls 栈与 CSP 约束见 [[architecture/decisions/0015-桌面壳与连接配置抽象.md|0015 桌面壳与连接配置抽象]]。
