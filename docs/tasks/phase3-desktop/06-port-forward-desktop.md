---
prd: prds/phase3-desktop.md
status: done
---
# 任务：端口转发桌面侧（Rust 本机 TCP 监听 + 隧道桥接 + 界面）

> **修订注（2026-11-03，用户拍板 · 决策 C）**：本任务的**界面部分按已确认的前端设计重写**：
> ① **web 形态只渲染说明卡 + 「安装桌面端」按钮**（点击开 ModalShell 安装指引弹窗），**无列表 / 新建 / 停止等任何管理操作**（原口径「web 形态下该区只做管理与说明」作废——管理动作只在桌面形态出现）；
> ② **桌面形态完整管理**：新建**只填容器端口**、列表按「容器端口 → 本机端口」呈现、开启 / 关闭本机监听、停止转发、开启后显示 `http://127.0.0.1:<port>` 与复制按钮；
> ③ **本机端口规则**：默认 = 容器端口、可编辑、**不可为空**、被占自动换空闲端口并**显示实际值**、**允许 <1024**（OS 差异见 ADR 0014 第 4 节）。
> **Rust 部分与 CSP 闸门条款保留不变**；本机端口由**桌面端**持有（后端不感知），与「宿主零端口」口径一致。
>
> **修订注（2026-11-03，实现轮确认 · 监听生命周期）**：实现时确认了一条与原稿相反的口径——**单条隧道断开只关掉那一条本机连接，不关本机监听**；监听器**活到用户显式停止**（`stop_forward` / 「停止转发」）为止。**原稿「隧道 WS 断开 → 关本机监听」一句已按实现修订**（理由：监听是「用户开启的一项能力」，不是「某一次连接的产物」——一条连接失败就撤掉监听，用户得反复重开）。本任务全文（步骤 1、完成标准第 4 条）按此口径执行；同一口径已同步进 [[conventions/console-frontend.md|网页控制台前端约定]] 的「端口转发」小节。
>
> **更新注（2026-11-04）**：本任务交付的**端口转发界面**已由 **2026-11-04 追加轮「端口转发区 UI 重构轮」**的表格化重构替代（卡片行 → 五列表格，小圆点状态 + Tooltip，监听生命周期改全手动）；**界面口径以追加轮为准**，本文下文的界面描述保留为实现轮留档，不大改。

## 目标

桌面端把后端的转发能力变成「本机回环上的一个可用端口」：Rust 核心在 `127.0.0.1` 起监听，每来一条连接就开一条隧道 WS 并做字节桥接；前端提供端口转发的管理界面（**完整管理只在桌面形态**；web 形态只渲染说明卡与「安装桌面端」指引）。**端口选择权与冲突处理全部在桌面端**——默认取容器端口、用户可改、被占自动换。

## 涉及文件

- 新增 `apps/desktop/src-tauri/src/forward.rs` — 本机监听 + 隧道桥接（监听模型 / 端口规则 / 隧道协议 / 关闭码分类）
- 新增 `apps/desktop/src-tauri/src/commands.rs` — 三个 Tauri 命令（`start_forward` / `stop_forward` / `forward_listeners`）
- 改 `apps/desktop/src-tauri/src/main.rs` — 注册三个命令、挂 `ForwardManager` 状态（动态 CSP 部分沿用 03）
- 改 `apps/desktop/src-tauri/Cargo.toml` — 引入 `tokio-tungstenite` / `tokio-util` / `futures-util` 等依赖
- 改 `apps/web/frontend/src/components/workbench/SandboxDetailDialog.tsx` — 抽屉底部的「端口转发」区
- 新增 `apps/web/frontend/src/components/workbench/PortForwardPanel.tsx` + `.test.tsx` — 转发区组件（桌面形态完整管理 / web 形态说明卡）
- 新增 `apps/web/frontend/src/components/workbench/PortForwardInstallDialog.tsx` — 「安装桌面端」指引弹窗（ModalShell）
- 改 `apps/web/frontend/src/api/client.ts` + `api/types.ts` — 三条转发 REST 与 `ForwardModel`（**无本机端口字段**）
- 新增 `apps/web/frontend/src/lib/port-forward.ts` + `.test.ts` — 转发纯逻辑（地址推导、状态文案、本机端口校验）
- 新增 `apps/web/frontend/src/lib/desktop-forward.ts` — 桌面 IPC 桥（`invoke` 三个命令 + 订阅两个状态事件）
- 改 `apps/web/frontend/README.md` — 标识表与接口一览
- 改 `docs/conventions/console-frontend.md` — 新增「端口转发」小节

> `tauri.conf.json` 的 CSP 闸门已由 03 闭合（非 `null`），本轮**零改动**。

## 实施步骤

1. **Rust 核心**：
   - `TcpListener::bind("127.0.0.1:<本机端口>")`——**本机端口默认 = 容器端口，用户可指定**（见第 4 步的端口规则）；
   - 每条 accept 到的连接 → 开一条隧道 WS（`tokio-tungstenite`，带 `Authorization: Bearer`）→ 双向字节泵；
   - 任一侧结束 → 关另一侧 → 关本机连接；
   - **单条隧道 WS 断开 → 只关那一条本机连接**，并上报**连接级**状态（`forward://connection`）；**本机监听保留**，活到用户显式 `stop_forward`（或「停止转发」）为止。**（原口径「隧道 WS 断开 → 关本机监听」已按实现修订**——监听是用户开启的能力，不是单次连接的产物；理由见文首修订注。）
   - **转发级致命失败**（后端不可达 / 令牌无效 / 转发不存在或已停止——都发生在**隧道建立阶段**）→ 上报**转发级**状态（`forward://state`），**监听器同样保留**（用户改完配置可再发起一次连接重试）。
2. **Tauri 命令**：`start_forward(forward_id, backend_base_url, token, local_port?)` → 返回**实际生效的本机端口**（含「被占自动换」后的值）；`stop_forward(forward_id)`。**Rust 侧不落盘令牌**（连接时由前端经 IPC 传入）。
3. **动态 CSP**：连接配置变更时由 Rust 侧设置 CSP，把 `http(s)://<后端host>:*` 与 `ws(s)://<后端host>:*` 加进 `connect-src`；不整体关闭 CSP。
4. **本机端口规则**（决策 C）：
   - **默认 = 容器端口**；
   - **可编辑、不可为空**（空值视为非法输入，表单层拦截）；
   - **被占自动换空闲端口**：目标端口已被占用时自动改用空闲端口；
   - **显示实际值**：界面展示的必须是**实际监听端口**，不得显示用户输入值；
   - **允许 <1024**：不做端口范围限制（Windows 可绑、macOS 现代版可绑、Linux 非 root 不可绑；目标平台 Windows 为主；若在 Linux 上绑定低端口失败须**明确报错**，不静默失败）。
5. **前端界面**：入口是**沙箱详情抽屉的「端口转发」区**。
   - **web 形态**：**只渲染一张说明卡 + 一个「安装桌面端」按钮**；点击打开 **ModalShell** 安装指引弹窗。**不渲染列表 / 新建 / 停止等任何管理操作**（管理动作需要桌面端，直接在网页上做会给出「建了却连不上」的半截功能）。说明卡写明「访问沙箱端口需要桌面应用」（与已退役的 URL 代理明确区分）。
   - **桌面形态**：**完整管理**——新建转发**只填容器端口**（本机端口默认等于容器端口，可改）；列表按「**容器端口 → 本机端口**」呈现；每条支持**开启 / 关闭本机监听**、**停止转发**；开启后显示 `http://127.0.0.1:<port>` 与**复制**按钮。
   - 结果反馈走 toast（来源标识 `port-forward`）；本地校验红字留在抽屉内就地展示。
6. **纯逻辑收敛**：`src/lib/port-forward.ts` 负责转发地址推导、状态文案与本机端口校验（空值 / 非法值 / 展示实际端口），配单元测试。
7. **标识**：新增标识遵守 `page-<页面>-<元素>` 规范并登记进 README 标识表。

## 完成标准

- [x] **（2026-11-04 真机复验通过）** 桌面端开启转发后，桌面机 `127.0.0.1:<本机端口>` 可访问沙箱内该端口上的服务；该监听**不出本机**。**（用户实测：桌面端开启转发后本机端口可访问沙箱服务；整体验收由用户实际使用确认，无其他问题。）**
- [x] **本机端口规则成立**：默认 = 容器端口；可编辑且**不可为空**；被占时**自动换空闲端口**并**显示实际值**；**允许 <1024**（Linux 低端口绑定失败时明确报错）。
- [x] Rust 侧不落盘令牌（连接时由前端经 IPC 传入，进程退出即失效）。
- [x] **监听生命周期**：**单条隧道断开只关那一条本机连接**，**本机监听保留到用户显式停止**（`stop_forward` / 「停止转发」）才关，不留僵尸监听。（**原口径「隧道断开 → 关本机监听」已按实现修订**——见文首修订注与文末「进展」。）
- [x] 同一沙箱的多个端口可同时转发、互不串扰；同一转发的多条并发连接互不串扰（**每条连接各开一条隧道 WS**）。
- [x] 端口转发界面落在沙箱详情抽屉，遵守 [[conventions/console-frontend.md|网页控制台前端约定]]（Base UI、令牌色、toast、`data-testid`、抽屉外壳复用）。
- [x] **web 形态下只渲染说明卡 + 「安装桌面端」按钮**（点击开 ModalShell 安装指引弹窗），**不渲染列表 / 新建 / 停止任何管理操作**。
- [x] **桌面形态下管理能力完整**：新建只填容器端口、列表按「容器端口 → 本机端口」呈现、开启 / 关闭本机监听、停止转发、开启后显示 `http://127.0.0.1:<port>` 与复制按钮。
- [x] `src/lib/port-forward.ts` 有单元测试；前端 `vitest` / `typecheck` / `typecheck:tests` / `build` 全绿（vitest **527 条** / typecheck **双零错** / build **成功**）。
- [x] **（本轮文档环节完成，2026-11-03）** `docs/conventions/console-frontend.md` 新增「端口转发」小节，写清界面位置、**web / 桌面两形态的差异**、本机端口规则、toast 来源标识与标识命名。
- [x] `apps/desktop/src-tauri/tauri.conf.json` 的 `app.security.csp` 已收敛为动态生成值，不得为 `null`（[[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]] 打样轮临时偏离的闭合闸门）。

## 依赖

- 依赖 [[tasks/phase3-desktop/05-port-forward-server-api.md|05 端口转发服务端接口]]。
- 依赖 [[tasks/phase3-desktop/03-frontend-connection-layer.md|03 连接层前端改造]]（连接配置与基址推导）。
- 依赖 [[tasks/phase3-desktop/01-prototype-and-spike.md|01 打样轮]] 的 P2（Tauri 壳可启动）与 P4（出包路径）。
- 实现依据：[[architecture/decisions/0014-端口转发机制选型.md|ADR 0014]]（第二次修订，决策 C）、[[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]]。

## 进展（2026-11-03）

**状态：done（2026-11-04 真机复验通过）。** 已实现并通过「审查 + 修复轮」；**完成标准第 1 条（真机连通）与整体验收已于 2026-11-04 在 Windows 11 真机 + 真后端复验通过**（收口记录见文末）。

### 实现摘要

- 新增 `apps/desktop/src-tauri/src/forward.rs`——本机监听 + 隧道桥接：
  - **监听模型**：**一个「已开启的转发」= 一个本机 `TcpListener`**（`127.0.0.1:<本机端口>`，**只绑回环**）；**每条 accept 到的连接各开一条隧道 WS**（`ws(s)://<后端host>/api/forward/tunnel/<forward_id>`，握手带 `Authorization: Bearer`）——**一条 WS 对一条 TCP 连接**，不做多路复用。
  - **监听生命周期（本轮确认的正式口径）**：**单条隧道断开只关那一条本机连接**（上报连接级事件 `forward://connection`），**本机监听保留**，活到用户显式 `stop_forward` / 「停止转发」为止；**转发级致命失败**（后端不可达 / 令牌无效 / 转发不存在或已停止——都发生在隧道建立阶段）上报转发级事件 `forward://state`，**监听器同样保留**。
  - **本机端口规则**：默认 = 容器端口；可编辑、**不可为空**（前端表单拦 + Rust 侧拒）；**被占自动换空闲端口**（首选端口不中就从 `18000` 起扫），返回并显示**实际生效**的端口；**允许 <1024**——绑不上且属权限问题时**明确报错**（Linux 非 root 绑低端口），不静默失败。
  - **关闭码分类**：`1000` 正常收尾 / `1001` 服务退出（可重连）/ `1008` 策略违规（令牌无效、转发不存在或已停止，**不可重试**）/ `1011` 字节泵异常结束（**可重试**）；分类与固定中文文案在 Rust 侧落地。
  - **令牌不落盘**：令牌每次由前端经 IPC 传入，只活在内存（进程退出即失效）；Rust 侧只落**后端基址**（`csp.rs` 的 `CspState`，供动态 CSP 用）。
- 新增 `apps/desktop/src-tauri/src/commands.rs`——三个 Tauri 命令：`start_forward`（**幂等**：同一条转发重复开启直接返回现有端口；返回**实际生效**的本机端口）/ `stop_forward`（关监听 + 关全部连接）/ `forward_listeners`（前端刷新后回填「已开启」的行）。
- 改 `apps/desktop/src-tauri/src/main.rs`——注册三个命令、挂 `ForwardManager` 状态（进程内单例）；`tauri.conf.json` **零改动**（CSP 闸门已由 03 闭合）。
- 改 `apps/desktop/src-tauri/Cargo.toml`——引入 `tokio-tungstenite`（隧道 WS 客户端，`rustls-tls-webpki-roots` 走纯 Rust TLS，Windows 出包不依赖系统 OpenSSL）/ `tokio-util`（`CancellationToken`）/ `futures-util`。
- 新增 `apps/web/frontend/src/lib/port-forward.ts`（+ `.test.ts`）——端口校验（**不拦低端口**）、「容器端口 → 本机端口」映射文案、本机地址拼接、监听状态四色语义、开启成功文案（**被占换端口时要说清实际值**）。
- 新增 `apps/web/frontend/src/lib/desktop-forward.ts`——桌面 IPC 桥：`window.__TAURI_INTERNALS__.invoke`（**不引 `@tauri-apps/api`**，web 形态的构建产物与依赖树不被 Tauri 污染）+ 两个事件订阅（订阅失败静默降级，不把界面带崩）。
- 新增 `apps/web/frontend/src/components/workbench/PortForwardPanel.tsx`（+ `.test.tsx`）——端口转发区：**web 形态只渲染说明卡 + 「安装桌面端」按钮**（不读转发记录、不渲染任何管理操作）；**桌面形态完整管理**（新建 / 列表 / 开启·关闭本机监听 / 停止转发 / 本机地址 + 复制）。
- 新增 `apps/web/frontend/src/components/workbench/PortForwardInstallDialog.tsx`——「安装桌面端」指引弹窗（**ModalShell**，三步：拿安装包 / 填后端地址与令牌 / 开启转发后访问）。
- 改 `apps/web/frontend/src/components/workbench/SandboxDetailDialog.tsx`——抽屉**底部**挂「端口转发」区。
- 改 `apps/web/frontend/src/api/client.ts` + `api/types.ts`——三条转发 REST（`GET /api/forwards` / `POST /api/forwards` / `DELETE /api/forwards/{id}`）与 `ForwardModel`（**无本机端口字段**——本机端口只在桌面端存在）。
- 改 `apps/web/frontend/README.md`——标识表新增「端口转发」一行（`page-forward-*`）。
- 改 `docs/conventions/console-frontend.md`——新增「端口转发」小节（**本轮文档环节完成**）。

### 审查修复轮（2 Critical + 8 Warning）

以下按**修复后的落点**复述（条目措辞以审查记录为准）：

- **2 Critical**：① **监听生命周期口径改写**——原口径「隧道 WS 断开 → 关本机监听」改为「**单条隧道断开只关该连接，监听器保留到用户显式停止**」（监听是用户开启的能力，不是单次连接的产物；否则一次失败就撤监听、用户得反复重开）；② **界面显示的必须是实际端口**——被占自动换端口后**不得回显用户输入值**，开启成功提示与行内地址一律用 Rust 返回的**实际生效端口**。
- **8 Warning**：① **隧道首帧校验**——服务端 accept 后**首帧必须是 hello**，不是 hello（或直接是错误帧）就按**固定中文错误帧**上报并关掉这一条连接；② **错误帧直接展示**——服务端文本错误帧（`{"type":"error","message":…}`）的文案**直接展示**，不改写措辞、不追加解释；③ **Bearer 鉴权**——握手带 `Authorization: Bearer <token>`（桌面 Rust 侧能设头，**不用一次性票据**），令牌**不落盘**；④ **关闭码四类语义**——`1000/1001/1008/1011` 在 Rust 侧分类（可重试 / 不可重试分清），文案固定；⑤ **只绑回环 + 被占自动换**——监听只绑 `127.0.0.1`，被占时从 `18000` 起扫空闲端口并**只显示实际值**；⑥ **低端口明确报错**——`<1024` 属权限问题时**明确报错**，不静默换端口、不静默失败；⑦ **幂等**——`start_forward` 对同一条转发重复开启**直接返回现有端口**（不重复起监听），`forward_listeners` 供刷新后回填；⑧ **停止转发先收监听**——「停止转发」= **先 `stop_forward` 再 `DELETE`**（顺序不能反），且连接级事件与转发级事件**分两路**上报，连接级收场不动监听器。

### 门禁

- 前端 `vitest`：**527 条全绿**。
- 前端 `typecheck` 与 `typecheck:tests`：**双零错**。
- 前端 `build`：**成功**。
- Rust `cargo check`：**0 警告**；`cargo test`：**20 通过**。
- 后端与核心包：**零改动**（本轮只动桌面壳与前端）。

### 协议对接清单（客户端要对齐的口径）

- **关闭码**：`1000` 正常收尾 / `1001` 服务退出（**可重连**）/ `1008` 策略违规（令牌无效、转发不存在或已停止——**不可重试**，提示检查配置或转发状态）/ `1011` 字节泵异常结束（**可重试**）。
- **首帧 hello**：客户端握手后**先发一条 `{"type":"hello"}`**；**服务端首帧必须是 hello**，不是 hello 就按错误帧处理。
- **固定文案错误帧直接展示**：文本帧 `{"type":"error","message":"<固定中文文案>"}`——**直接展示**，不改写措辞。
- **Bearer 鉴权**：握手带 `Authorization: Bearer <token>`（**不用一次性票据**；浏览器侧那条票据路径只服务终端 WS）。
- **帧类型**：**二进制 = 透传字节**，**文本 = 控制帧**（hello / error）。
- **REST 不带本机端口**：转发记录只有 id / sandbox / container_port / state / created_at / updated_at——**本机端口只存在于桌面端**（链路两点化，后端宿主零端口）。

### 收口（2026-11-04，Windows 11 真机 + 真后端）

> **状态：done。** 完成标准第 1 条（真机连通）与整体验收均已通过。

- **真机连通通过**：用户在 Windows 11 真机上开启转发后，**桌面机 `127.0.0.1:<本机端口>` 可访问沙箱内该端口上的服务**，且监听**不出本机**——完成标准第 1 条闭合。
- **整体验收**：用户实际使用确认**无其他问题**——终端、转发等功能实际使用均正常。
- **同轮相关结论**：P2 三项控制台冒烟（`oklch` 配色 / `window.isSecureContext` / 剪贴板读写）真机全过、P4 出包路径②正式可交付、P5 无提装——均记在 [[tasks/phase3-desktop/RESULTS.md|三期留档]]；03 全链路的**远端形态**同轮实测通过（[[tasks/phase3-desktop/03-frontend-connection-layer.md|任务 03]] **已于 2026-11-04 按用户拍板的「偏离记录」口径闭合**：远端形态通过即闭合，本机形态不单独实测，留待该场景实际出现时再验证）。
- **与追加轮的关系（界面口径以追加轮为准）**：本任务交付的**卡片行界面**已由 **2026-11-04 追加轮「端口转发区 UI 重构轮」**的**表格化重构**替代（转发列表由卡片行改为五列表格：本地端口 / 容器端口 / 本地状态 / 容器状态 / 操作（同步·编辑·删除三个单 icon 按钮）；状态改小圆点 + Tooltip；行 = 后端记录 ∪ 本机监听并集（孤儿行可见、可同步重建）；本机监听生命周期改全手动，本机端口与转发同建同删；新增工作台层 10 秒合并轮询）。**原卡片行口径以追加轮为准**——上文「实施步骤 5」与「完成标准」的界面描述保留为实现轮留档，不大改。追加轮门禁：前端 vitest **585 passed** / typecheck 0 / build 过（故上文「vitest 527 条」的基线已被追加轮取代）。
- **另一追加轮无耦合**：「桌面壳 dev 刷新修复轮」（2026-11-04，needs_csp_reload 桌面端 dev 恒 false，cargo test 26 passed）修的是桌面壳 dev 形态的无限整页刷新，与本任务的端口转发能力**无耦合**，不影响本任务结论。
