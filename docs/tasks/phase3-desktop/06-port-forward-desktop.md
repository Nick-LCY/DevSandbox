---
prd: prds/phase3-desktop.md
status: todo
---
# 任务：端口转发桌面侧（Rust 本机 TCP 监听 + 隧道桥接 + 界面）

## 目标

桌面端把后端的转发能力变成「本机回环上的一个可用端口」：Rust 核心在 `127.0.0.1` 起监听，每来一条连接就开一条隧道 WS 并做字节桥接；前端提供端口转发的管理与「在桌面端开启」界面。

## 涉及文件

- 新增 `apps/desktop/src-tauri/src/forward.rs` — 本机监听 + 隧道桥接
- 新增 `apps/desktop/src-tauri/src/commands.rs` — Tauri 命令
- 改 `apps/desktop/src-tauri/src/main.rs` — 命令注册、动态 CSP
- 改 `apps/desktop/src-tauri/tauri.conf.json` — `frontendDist`、打包目标、权限白名单
- 改 `apps/web/frontend/src/components/workbench/SandboxDetailDialog.tsx` — 端口转发区
- 新增 `apps/web/frontend/src/components/workbench/PortForwardPanel.tsx` — 转发区组件
- 改 `apps/web/frontend/src/api/client.ts` — 转发三条 REST 与隧道地址推导
- 新增 `apps/web/frontend/src/lib/port-forward.ts` + `.test.ts` — 转发纯逻辑（地址推导、状态文案）
- 改 `apps/web/frontend/README.md` — 标识表与接口一览
- 改 `docs/conventions/console-frontend.md` — 新增「端口转发」小节

## 实施步骤

1. **Rust 核心**：
   - `TcpListener::bind("127.0.0.1:<本地端口>")`（端口自动分配，可由用户指定）；
   - 每条 accept 到的连接 → 开一条隧道 WS（`tokio-tungstenite`，带 `Authorization: Bearer`）→ 双向字节泵；
   - 任一侧结束 → 关另一侧 → 关本机连接；
   - 隧道 WS 断开 → 关本机监听并向上报状态（通过 Tauri 事件）。
2. **Tauri 命令**：`start_forward(forward_id, backend_base_url, token, local_port?)` → 返回本地端口；`stop_forward(forward_id)`。**Rust 侧不落盘令牌**（连接时由前端经 IPC 传入）。
3. **动态 CSP**：连接配置变更时由 Rust 侧设置 CSP，把 `http(s)://<后端host>:*` 与 `ws(s)://<后端host>:*` 加进 `connect-src`；不整体关闭 CSP。
4. **前端界面**：沙箱详情抽屉新增「端口转发」区——列表（沙箱内已建的转发）、新建（选沙箱 + 填容器端口）、停止、每条的「在桌面端开启 / 关闭」。
   - 「在桌面端开启」是 Tauri 专属动作：**web 形态下不渲染该按钮**（不静默失败）；web 形态下该区只做管理与说明，写明「访问沙箱端口需要桌面应用」。
   - 结果反馈走 toast（来源标识 `port-forward`）；本地校验红字留在抽屉内就地展示。
5. **纯逻辑收敛**：`src/lib/port-forward.ts` 负责转发地址推导与状态文案，配单元测试。
6. **标识**：新增标识遵守 `page-<页面>-<元素>` 规范并登记进 README 标识表。

## 完成标准

- [ ] 桌面端开启转发后，桌面机 `127.0.0.1:<本地端口>` 可访问沙箱内该端口上的服务；该监听**不出本机**。
- [ ] Rust 侧不落盘令牌（连接时由前端经 IPC 传入，进程退出即失效）。
- [ ] 隧道断开 / 用户停止转发后，本机监听被关闭，不留僵尸监听。
- [ ] 同一沙箱的多个端口可同时转发、互不串扰；同一转发的多条并发连接互不串扰。
- [ ] 端口转发界面落在沙箱详情抽屉，遵守 [[conventions/console-frontend.md|网页控制台前端约定]]（Base UI、令牌色、toast、`data-testid`、抽屉外壳复用）。
- [ ] web 形态下不渲染「在桌面端开启」按钮，且界面写明访问端口需要桌面应用（与已退役的 URL 代理明确区分）。
- [ ] `src/lib/port-forward.ts` 有单元测试；前端 `vitest` / `typecheck` / `typecheck:tests` / `build` 全绿。
- [ ] `docs/conventions/console-frontend.md` 新增「端口转发」小节，写清界面位置、按钮的形态差异、toast 来源标识与标识命名。

## 依赖

- 依赖 [[tasks/phase3-desktop/05-port-forward-server-api.md|05 端口转发服务端接口]]。
- 依赖 [[tasks/phase3-desktop/03-frontend-connection-layer.md|03 连接层前端改造]]（连接配置与基址推导）。
- 依赖 [[tasks/phase3-desktop/01-prototype-and-spike.md|01 打样轮]] 的 P2（Tauri 壳可启动）与 P4（出包路径）。
- 实现依据：[[architecture/decisions/0014-端口转发机制选型.md|ADR 0014]]、[[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]]。
