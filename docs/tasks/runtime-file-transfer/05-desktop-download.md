---
prd: prds/runtime-file-transfer.md
status: doing
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

> 2026-11-09：本机 Linux **无法执行**本清单；已细化为 **15 条**全文收录于文末「进展」的「Windows 真机验证清单（15 条，待用户执行）」节。**06 轮已于 2026-11-09 收口**——但**本清单仍未验**（唯一开口），**待用户 Windows 真机执行**。**未验不宣称完成**：本机是 Linux，Playwright 覆盖不到 Tauri IPC 与原生对话框，**这一段只能由 Windows 真机补**。

## 完成标准

- [x] `Cargo.toml` 加 `reqwest`（**rustls-tls + stream 特性，不引 OpenSSL**）与 `tauri-plugin-dialog`；**不引入 OpenSSL**。— **偏离**：`stream` 特性经核实**无用已去除**（`Response::chunk()` 在 reqwest 0.12.28 不受 `stream` 门控），依赖树无 OpenSSL / aws-lc-rs（详见文末「reqwest 选型」）。
- [x] dialog 插件已注册、**capabilities 已补 dialog 权限**——`main.rs` 注册 `tauri_plugin_dialog::init()`；`capabilities/default.json` **只加** `dialog:allow-save`（open / message 不放）。
- [x] Rust 下载落盘命令实现：带令牌流式下载 → 写入**用户所选路径**；令牌**不落盘**——`download.rs` 的 `download_to_disk`，同目录临时名 + `rename` 原子写；令牌走 invoke 参数，不落盘 / 不进日志 / 不进 URL。
- [x] 新增 Rust 代码**无 unwrap / 越界索引**，错误一律 `Result` 收口（release `panic = "abort"` 下的硬要求）——非测试 Rust **零 `unwrap` / `expect`**。
- [x] 命令已注册；前端 IPC 封装走 `window.__TAURI_INTERNALS__.invoke`（**不引 `@tauri-apps/api`**，保持 web 形态产物与依赖树不被 Tauri 污染）——抽公共层 `desktop-ipc.ts`，`desktop-forward` 改走该层（**行为零变化**）。
- [x] 前端**形态分支**接通：桌面走 `invoke`、web 走 `fetch` + blob（**不导航 blob: URL**）；**上传路径两形态共用 `<input type="file">`，Rust 上传零改动**——`FileBrowserPanel` 桌面分支接线（关闭抽屉 / 切沙箱取消在途 + 退订）。
- [ ] **Windows 真机验证清单已产出并逐条验过**（上传选文件 / 保存框 / 中文文件名 / 大文件 / 中途取消 / 错误路径），结果留档。——**清单已产出（15 条，见文末「进展」），但本机 Linux 无法验证，未验不计完成**；**06 轮已于 2026-11-09 收口，本清单仍待用户 Windows 真机执行**（全轮唯一开口）。
- [x] 门禁：`cargo check` 零警告、`cargo test` 全绿；前端 vitest / typecheck / build 全绿——`cargo test` **47 passed**（基线 25 → +22，0 警告）；前端 **vitest 651 passed**（基线 633 → +18）、typecheck 双零错、build 成功；后端 / 核心包零改动。
- [x] **命令行零改动**；**创建时注入通道零改动**——本轮只动 `apps/desktop/` 与 `apps/web/frontend/src/lib/`、`FileBrowserPanel`，后端 / 核心包 / CLI 零改动。

## 依赖

- 依赖 [[tasks/runtime-file-transfer/03-server-file-endpoints.md|03 服务端文件传输接口]]（下载端点与响应头）。
- 与 [[tasks/runtime-file-transfer/04-frontend-file-panel.md|04 前端文件浏览面板]] **可并行**；形态分支需与 04 的面板对接——**04 已于 2026-11-09 收口**，`FileBrowserPanel` 的 `desktop` 分支是留桩（`TODO(05)`，不发请求、无行为），本任务接线时替换该分支。
- rustls 栈与 CSP 约束见 [[architecture/decisions/0015-桌面壳与连接配置抽象.md|0015 桌面壳与连接配置抽象]]。

---

## 进展（2026-11-09）

> **本轮状态：doing（代码侧收口，Windows 真机待验）。** 完成标准含「Windows 真机验证清单已产出并逐条验过」——本机 Linux 只能验证代码门禁，**真机项未验，按纪律不宣称完成**；剩余 = Windows 真机清单（**待用户执行**；**06 轮已于 2026-11-09 收口，本清单是其唯一开口**）。
>
> **Linux 侧已全绿**：`cargo test` **47 passed**（基线 25 → +22，0 警告）、前端 **vitest 651 passed**（基线 633 → +18）、typecheck 双零错、build 成功；后端 / 核心包零改动。

### 交付物

| 文件 | 改动 |
|---|---|
| `apps/desktop/src-tauri/Cargo.toml` | 改：`reqwest = "0.12"`（`default-features = false` + `rustls-tls`，**不引 OpenSSL / aws-lc-rs**；`stream` 特性经核实无用已去除）+ `tauri-plugin-dialog = "2"` |
| `apps/desktop/src-tauri/src/download.rs` | **新建**：`download_to_disk`（原生保存框 → 带令牌流式 GET → 同目录临时名 + `rename` 原子写）、`cancel_download`（幂等取消 + 删临时文件）、`DownloadManager`（登记 / 取消 / `cancel_all`）、`TempGuard`（Drop 删临时名）、进度事件与纯函数（`event_name` / `event_scope` / `length_mismatch`） |
| `apps/desktop/src-tauri/src/main.rs` | 改：注册 `tauri_plugin_dialog::init()` + `download_to_disk` / `cancel_download` 命令；退出路径（`Destroyed` / `ExitRequested`）调 `cancel_all` |
| `apps/desktop/src-tauri/capabilities/default.json` | 改：**只加** `dialog:allow-save`（open / message 不放） |
| `apps/web/frontend/src/lib/desktop-ipc.ts` | **新建**：桌面 IPC 公共层（`invokeDesktop` / `listenDesktopEvent` / `toError` / `desktopInternals`），统一走 `window.__TAURI_INTERNALS__.invoke` |
| `apps/web/frontend/src/lib/desktop-forward.ts` | 改：改走 `desktop-ipc.ts` 公共层，**端口转发行为零变化** |
| `apps/web/frontend/src/lib/desktop-file.ts` | **新建**：`pickDownloadPath`（原生保存框，`defaultPath` = 条目名，取消 → `null` 静默）、`downloadToDisk`（`download_to_disk` + 事件订阅）、`cancelDownload`、`listenDownloadEvents`、事件名 / 载荷类型 |
| `apps/web/frontend/src/lib/desktop-file.test.ts` | **新建**：桌面下载纯逻辑与 IPC 用例（保存框取消 / 事件名 / 载荷 / 取消 / 退订等） |
| `apps/web/frontend/src/components/workbench/FileBrowserPanel.tsx` | 改：桌面分支接线（保存框 → `download_to_disk` → 进度事件；关闭抽屉 / 切沙箱取消在途并退订；代次 / `open` 重校验防串） |
| `apps/web/frontend/src/components/workbench/FileBrowserPanel.test.tsx` | 改：桌面分支用例（不再留桩） |

### 令牌模式（一句话）

令牌**每次由前端经 invoke 参数传入**（与端口转发同款），只活在这一次命令的栈上，**不落盘、不进日志、不进 URL**；落盘的只有用户自选的目标文件。

### 事件协议（一句话）

进度经 `download://<作用域>/<downloadId>` 事件回传，**100 ms 节流**，载荷含 `phase`（`progress` / `done` / `error` / `cancelled`）/ `loaded` / `total` / `path` / `target_path`（另有 `download_id` / `sandbox` / `message`）；文件名不进事件名（事件名只允许字母数字与 `-` `/` `:` `_`），文件维度由载荷携带，多文件并行互不串扰。

### 审查一轮 + 修复一轮（2026-11-09）

审查结论：**1 Critical + 5 Warning**，另点出「不留半截文件 / 不完整判定」两承诺**零测试**；**修复一轮 9 项全部落地**。

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | **Critical** | **订阅 IPC 往返窗口逃过收口**——前端订阅事件是 IPC 往返，抽屉在这段窗口里关掉时，`cancel_download` 可能早于 `download_to_disk` 登记 | 收口路径**重校验 `generation` / `open`**；旧代次 / 抽屉已关的异步收尾静默退出 |
| 2 | Warning | **取消早于登记会丢失** | 管理器保留**短期、有界**的 `early_cancels` 集合：后来的 `register` 命中即按取消收口 |
| 3 | Warning | **错误体读取不可取消**（可能拖住取消 / 退出） | `read_error_body` 用 `select!` 接取消信号 + **8 s 上限** |
| 4 | Warning | **finish / 窗口生命周期泄漏**（命令 future 被 drop 时登记残留） | **RAII 登记守卫**（`DownloadRegistration` Drop 收登记）+ `Destroyed` / `ExitRequested` 调 `cancel_all` |
| 5 | Warning | **sandbox 名可 path 注入**（拼进事件名 / 路径） | sandbox 名校验 `[A-Za-z0-9_-]+`，非法直接拒绝 |
| 6 | Warning | **Windows `rename` 报错不可辨** | `rename` 失败**可读化**（固定中文文案），并**前置拒绝目标为已存在目录** |
| 7 | 测试缺口 | 「**不留半截文件**」承诺零测试 | `TempGuard` Drop / `commit` 的**真目录用例**（成功才 rename、失败 / 取消删临时名） |
| 8 | 测试缺口 | 「**不完整判定**」承诺零测试 | `length_mismatch` 提为**纯函数**并补单测（实际字节 ≠ `Content-Length`） |
| 9 | 配套 | 取消 / 收口 / 事件载荷的边界行为 | 事件名与作用域字符替换的等价用例、取消幂等、退订用例 |

### 最终门禁

| 门禁 | 结果 |
|---|---|
| `cargo test`（桌面端） | **47 passed**（基线 **25** → **+22**），**0 警告**；非测试 Rust 零 `unwrap` / `expect` |
| 前端 `pnpm test`（vitest） | **651 passed**（基线 **633** → **+18**） |
| 前端 `pnpm typecheck` / `typecheck:tests` | **零错** |
| 前端 `pnpm build` | **成功** |
| 后端 / 核心包 | **零改动**（本轮不涉及） |

### reqwest 选型（为什么是 0.12 而不是 0.13）

- **0.13 改了 rustls 特性名**（`rustls-tls` 系列被重排），且**默认会拉 `aws-lc-rs`**——与既有「显式只用 `ring`」的 rustls 栈（`rustls = { features = ["ring"] }`）不一致，出包会多带一套 crypto provider。
- **0.12 的 `rustls-tls` 正好对齐既有栈**：纯 Rust、`ring` 担任 crypto provider、**不引 OpenSSL**、**不引 `aws-lc-rs`**；依赖树已核对。
- **`stream` 特性经核实无用**：流式读用的 `Response::chunk()` 在 **reqwest 0.12.28** 里不受 `stream` 门控（只有未使用的 `bytes_stream()` 需要它），故 `default-features = false` 之外只留 `rustls-tls`。
- 配上 `default-features = false`：不要 native-tls / 系统代理 / charset / http2。

### Windows 真机验证清单（15 条，待用户执行）

> **本机 Linux 无法验证**，以下条目**全部待用户 Windows 真机执行**，结果留档到 06 轮。**未验不宣称完成。**

- [ ] 1. 原生「保存为」对话框能弹出。
- [ ] 2. 保存框默认名 = 列表条目名。
- [ ] 3. 保存框内取消 → **静默**（无提示、无文件落盘、无挂死任务）。
- [ ] 4. 落盘文件 sha256 与容器内文件**逐字节一致**。
- [ ] 5. 同名目标文件 → 覆盖成功（保存框确认后落盘为新内容）。
- [ ] 6. 中文路径 / 中文文件名下载正常（`filename*` 与保存框默认名都正确）。
- [ ] 7. 大文件 **≥ 1 GiB** 下载不卡死、不崩溃（内存与耗时记一笔）。
- [ ] 8. 多文件**并行**下载，各自进度互不串扰（事件名带下载标识 / 沙箱作用域）。
- [ ] 9. 下载**中途取消**（关闭抽屉 / 切沙箱）→ 不留半截文件、不留临时文件、不留挂死任务。
- [ ] 10. **上传回归**：桌面形态上传仍走 `<input type="file">`，行为与 04 一致（Rust 上传零改动）。
- [ ] 11. 错误路径（令牌无效 / 后端不可达 / 容器内是目录）→ 给出明确中文错误，**不闪退**。
- [ ] 12. **关窗退出**：在途下载被取消、临时文件清理、进程干净退出。
- [ ] 13. **IPv6** 后端地址（如 `http://[::1]:8000`）下载正常。
- [ ] 14. **形态对照**：同一文件 web 形态（浏览器下载条 / blob）与桌面形态（原生保存框）行为各自正确。
- [ ] 15. 界面**零说明文字**（无副标题 / 解释性文案，沿用 04 口径）。

### 偏离与未做

- **未跑 `cargo fmt`**：工具链**未安装 rustfmt 组件**，沿用现有风格（未新增格式化差异）。
- **保存框打开期间的界面反馈态未做**：属于审查 Suggestion 级（保存框是原生模态，用户感知由系统对话框承担），本轮不做。
- **`stream` 特性去除**：与任务书原文「rustls-tls + stream」有一处偏离，理由见上「reqwest 选型」；**不引 OpenSSL** 的硬约束成立（依赖树无 OpenSSL / `aws-lc-rs`）。
- **`cargo test` 含新增 Rust 测试**：`cargo test` 数字含 `download.rs` 内联单测；非测试代码零 `unwrap` / `expect`（`panic = "abort"` 纪律）。
