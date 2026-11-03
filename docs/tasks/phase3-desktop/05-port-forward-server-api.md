---
prd: prds/phase3-desktop.md
status: todo
---
# 任务：端口转发服务端接口（转发管理 REST + 隧道 WebSocket）

## 目标

把核心包的转发编排能力包成服务端接口：三条转发管理 REST（列表 / 建立 / 停止）+ 一条隧道 WebSocket（后端 ⇄ 桌面端的字节通道）。服务端只做编排与转译，能力本体在核心包。

## 涉及文件

- 新增 `apps/web/backend/src/sandbox_console/routes/forwards.py` — 三条 REST + 隧道 WS
- 新增 `apps/web/backend/src/sandbox_console/forwarding.py`（或等价位置）— 转发管理器装配与生命周期钩子
- 改 `apps/web/backend/src/sandbox_console/routes/__init__.py` — 注册路由
- 改 `apps/web/backend/src/sandbox_console/app.py` — lifespan 里装配转发管理器、启动时清理遗留转发
- 改 `apps/web/backend/src/sandbox_console/deps.py` — 转发管理器依赖
- 改 `apps/web/backend/src/sandbox_console/schemas.py` — 请求 / 响应模型
- 改 `apps/web/backend/src/sandbox_console/errors.py` — 错误映射（沙箱不存在 / 端口非法 / 转发不存在）
- 新增 `apps/web/backend/tests/test_forwards.py` — 用例
- 改 `apps/web/backend/API.md` — 新增「端口转发接口」章节

## 实施步骤

1. **REST**：
   - `GET /api/forwards` → 裸数组；
   - `POST /api/forwards` → 入参 `{sandbox, port}`；沙箱不存在 / 已停止 / 端口非法 → 明确错误；
   - `DELETE /api/forwards/{id}` → 停止转发（停并删容器 + 释放端口 + 删记录）。
2. **隧道 WS**：`/api/forward/tunnel/{forward_id}`
   - 鉴权走 `Authorization: Bearer`（Rust 侧能设头，不需要票据）；
   - 转发不存在或已停止 → 关闭码 `1008`；
   - 正常：服务端连 `127.0.0.1:<宿主端口>`，与 WS 做双向字节泵；
   - 帧：二进制 = 透传字节；文本 = `{"type":"hello",...}` / `{"type":"error","message":"..."}`；
   - 任一侧 EOF → 关另一侧。
3. **生命周期**：`app.py` 的 lifespan 里装配转发管理器；启动时调用核心包的「清理遗留转发」入口（与 `purge_leftover_sessions` 同处、同款语义）；服务退出时关掉所有活动隧道。
4. **模型**：`ForwardModel`（id / sandbox / container_port / host_port / state / created_at / updated_at）；`ForwardCreateRequest`（sandbox / port，`extra="forbid"`）。
5. **测试**：三条 REST 的正常与错误路径；隧道 WS 的鉴权失败、转发不存在、正常字节透传、任一侧关闭的收敛。

## 完成标准

- [ ] `GET /api/forwards` 返回裸数组；`POST /api/forwards` 按 `{sandbox, port}` 建立并返回记录；`DELETE /api/forwards/{id}` 停止转发。
- [ ] 沙箱不存在 / 已停止 / 端口非法时返回明确的中文错误（`detail`），不抛未捕获异常。
- [ ] 隧道 WS 无令牌 / 错令牌被拒；转发不存在 / 已停止 → 关闭码 `1008`。
- [ ] 隧道正常时字节双向透传（测试里用回显服务验字节一致），任一侧关闭后另一侧随之关闭。
- [ ] 服务启动时清理上次遗留的转发容器与记录（与终端会话的遗留清理同款语义）。
- [ ] 服务端 pytest 全绿且新增转发用例；ruff（`E4/E7/E9/F`）退出码 0。
- [ ] 服务端代码不含转发编排逻辑本体（编排与端口分配在核心包），分层契约测试红线不触发。
- [ ] `apps/web/backend/API.md` 新增「端口转发接口」章节：三条 REST 的入参 / 出参 / 错误口径、隧道 WS 的路径 / 鉴权 / 帧协议 / 关闭码、生命周期语义表。

## 依赖

- 依赖 [[tasks/phase3-desktop/04-port-forward-core.md|04 端口转发核心包能力]]。
- 依赖 [[tasks/phase3-desktop/02-backend-token-and-cors.md|02 连接层后端改造]] 的鉴权中间件（隧道 WS 走同一条 Bearer 通道）。
- 协议依据：[[architecture/decisions/0014-端口转发机制选型.md|ADR 0014]] 第 5、6 节。
