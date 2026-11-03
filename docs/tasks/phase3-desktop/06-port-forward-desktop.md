---
prd: prds/phase3-desktop.md
status: todo
---
# 任务：端口转发桌面侧（Rust 本机 TCP 监听 + 隧道桥接 + 界面）

> **修订注（2026-11-03，用户拍板 · 决策 C）**：本任务的**界面部分按已确认的前端设计重写**：
> ① **web 形态只渲染说明卡 + 「安装桌面端」按钮**（点击开 ModalShell 安装指引弹窗），**无列表 / 新建 / 停止等任何管理操作**（原口径「web 形态下该区只做管理与说明」作废——管理动作只在桌面形态出现）；
> ② **桌面形态完整管理**：新建**只填容器端口**、列表按「容器端口 → 本机端口」呈现、开启 / 关闭本机监听、停止转发、开启后显示 `http://127.0.0.1:<port>` 与复制按钮；
> ③ **本机端口规则**：默认 = 容器端口、可编辑、**不可为空**、被占自动换空闲端口并**显示实际值**、**允许 <1024**（OS 差异见 ADR 0014 第 4 节）。
> **Rust 部分与 CSP 闸门条款保留不变**；本机端口由**桌面端**持有（后端不感知），与「宿主零端口」口径一致。

## 目标

桌面端把后端的转发能力变成「本机回环上的一个可用端口」：Rust 核心在 `127.0.0.1` 起监听，每来一条连接就开一条隧道 WS 并做字节桥接；前端提供端口转发的管理界面（**完整管理只在桌面形态**；web 形态只渲染说明卡与「安装桌面端」指引）。**端口选择权与冲突处理全部在桌面端**——默认取容器端口、用户可改、被占自动换。

## 涉及文件

- 新增 `apps/desktop/src-tauri/src/forward.rs` — 本机监听 + 隧道桥接
- 新增 `apps/desktop/src-tauri/src/commands.rs` — Tauri 命令
- 改 `apps/desktop/src-tauri/src/main.rs` — 命令注册、动态 CSP
- 改 `apps/desktop/src-tauri/tauri.conf.json` — `frontendDist`、打包目标、权限白名单
- 改 `apps/web/frontend/src/components/workbench/SandboxDetailDialog.tsx` — 端口转发区
- 新增 `apps/web/frontend/src/components/workbench/PortForwardPanel.tsx` — 转发区组件（桌面形态完整管理 / web 形态说明卡）
- 新增 `apps/web/frontend/src/components/workbench/PortForwardInstallDialog.tsx` — 「安装桌面端」指引弹窗（ModalShell）
- 改 `apps/web/frontend/src/api/client.ts` — 转发三条 REST 与隧道地址推导
- 新增 `apps/web/frontend/src/lib/port-forward.ts` + `.test.ts` — 转发纯逻辑（地址推导、状态文案、本机端口校验）
- 改 `apps/web/frontend/README.md` — 标识表与接口一览
- 改 `docs/conventions/console-frontend.md` — 新增「端口转发」小节

## 实施步骤

1. **Rust 核心**：
   - `TcpListener::bind("127.0.0.1:<本机端口>")`——**本机端口默认 = 容器端口，用户可指定**（见第 4 步的端口规则）；
   - 每条 accept 到的连接 → 开一条隧道 WS（`tokio-tungstenite`，带 `Authorization: Bearer`）→ 双向字节泵；
   - 任一侧结束 → 关另一侧 → 关本机连接；
   - 隧道 WS 断开 → 关本机监听并向上报状态（通过 Tauri 事件）。
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

- [ ] 桌面端开启转发后，桌面机 `127.0.0.1:<本机端口>` 可访问沙箱内该端口上的服务；该监听**不出本机**。
- [ ] **本机端口规则成立**：默认 = 容器端口；可编辑且**不可为空**；被占时**自动换空闲端口**并**显示实际值**；**允许 <1024**（Linux 低端口绑定失败时明确报错）。
- [ ] Rust 侧不落盘令牌（连接时由前端经 IPC 传入，进程退出即失效）。
- [ ] 隧道断开 / 用户停止转发后，本机监听被关闭，不留僵尸监听。
- [ ] 同一沙箱的多个端口可同时转发、互不串扰；同一转发的多条并发连接互不串扰。
- [ ] 端口转发界面落在沙箱详情抽屉，遵守 [[conventions/console-frontend.md|网页控制台前端约定]]（Base UI、令牌色、toast、`data-testid`、抽屉外壳复用）。
- [ ] **web 形态下只渲染说明卡 + 「安装桌面端」按钮**（点击开 ModalShell 安装指引弹窗），**不渲染列表 / 新建 / 停止任何管理操作**。
- [ ] **桌面形态下管理能力完整**：新建只填容器端口、列表按「容器端口 → 本机端口」呈现、开启 / 关闭本机监听、停止转发、开启后显示 `http://127.0.0.1:<port>` 与复制按钮。
- [ ] `src/lib/port-forward.ts` 有单元测试；前端 `vitest` / `typecheck` / `typecheck:tests` / `build` 全绿。
- [ ] `docs/conventions/console-frontend.md` 新增「端口转发」小节，写清界面位置、**web / 桌面两形态的差异**、本机端口规则、toast 来源标识与标识命名。
- [ ] `apps/desktop/src-tauri/tauri.conf.json` 的 `app.security.csp` 已收敛为动态生成值，不得为 `null`（[[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]] 打样轮临时偏离的闭合闸门）。

## 依赖

- 依赖 [[tasks/phase3-desktop/05-port-forward-server-api.md|05 端口转发服务端接口]]。
- 依赖 [[tasks/phase3-desktop/03-frontend-connection-layer.md|03 连接层前端改造]]（连接配置与基址推导）。
- 依赖 [[tasks/phase3-desktop/01-prototype-and-spike.md|01 打样轮]] 的 P2（Tauri 壳可启动）与 P4（出包路径）。
- 实现依据：[[architecture/decisions/0014-端口转发机制选型.md|ADR 0014]]（第二次修订，决策 C）、[[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]]。
