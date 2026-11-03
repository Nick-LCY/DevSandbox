---
prd: prds/phase3-desktop.md
status: done
---
# 任务：端口转发服务端接口（转发管理 REST + 隧道 WebSocket）

> **修订注（2026-11-03，用户拍板 · 决策 C）**：本任务按 [[architecture/decisions/0014-端口转发机制选型.md|ADR 0014]] 第二次修订（链路两点化、**后端宿主机零端口**）改写。关键变化：
> ① **隧道桥接目标变更**——从「连 `127.0.0.1:<宿主端口>`」改为「`docker exec -i <转发容器> socat - TCP:<沙箱容器名>:<端口>`（在沙箱守护进程下执行）」；
> ② **连接断开 → exec 进程立即回收**（不留僵尸 exec 进程）；
> ③ **REST 与模型去掉 `host_port`**；
> ④ 生命周期语义保留（启动清理遗留转发）。
> 其余条款照旧；被取代的原文在上文逐条列出（留档）。

## 目标

把核心包的转发编排能力包成服务端接口：三条转发管理 REST（列表 / 建立 / 停止）+ 一条隧道 WebSocket（用户机 ⇄ 沙箱的字节通道）。服务端只做编排与转译，能力本体在核心包。**后端宿主不发布、不监听任何转发端口**——它是纯中继。

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
   - `DELETE /api/forwards/{id}` → 停止转发（停并删容器 + 删记录；**无「释放端口」动作**——宿主侧不再有端口）。
2. **隧道 WS**：`/api/forward/tunnel/{forward_id}`
   - 鉴权走 `Authorization: Bearer`（Rust 侧能设头，不需要票据）；
   - 转发不存在或已停止 → 关闭码 `1008`；
   - **正常：服务端在沙箱守护进程下起字节泵**——`docker exec -i <转发容器> socat - TCP:<沙箱容器名>:<端口>`，把该进程的 stdin/stdout 与 WS 做双向字节泵（**不再连 `127.0.0.1:<宿主端口>`**）；
   - 帧：二进制 = 透传字节；文本 = `{"type":"hello",...}` / `{"type":"error","message":"..."}`；
   - 任一侧 EOF → 关另一侧；**连接断开 → 该 exec 进程立即回收**（不留僵尸 exec 进程）。
3. **生命周期**：`app.py` 的 lifespan 里装配转发管理器；启动时调用核心包的「清理遗留转发」入口（与 `purge_leftover_sessions` 同处、同款语义）；服务退出时关掉所有活动隧道（并回收对应 exec 进程）。
4. **模型**：`ForwardModel`（**id / sandbox / container_port / state / created_at / updated_at**，**无 `host_port`**）；`ForwardCreateRequest`（sandbox / port，`extra="forbid"`）。
5. **测试**：三条 REST 的正常与错误路径；隧道 WS 的鉴权失败、转发不存在、正常字节透传、任一侧关闭的收敛、**exec 进程在断开后被回收**。

## 完成标准

- [x] `GET /api/forwards` 返回裸数组；`POST /api/forwards` 按 `{sandbox, port}` 建立并返回记录；`DELETE /api/forwards/{id}` 停止转发。
- [x] 沙箱不存在 / 已停止 / 端口非法时返回明确的中文错误（`detail`），不抛未捕获异常。
- [x] 隧道 WS 无令牌 / 错令牌被拒；转发不存在 / 已停止 → 关闭码 `1008`。
- [x] 隧道正常时字节双向透传（测试里用回显服务验字节一致），任一侧关闭后另一侧随之关闭，**且对应的 `docker exec` 字节泵进程被回收**。
- [x] 服务启动时清理上次遗留的转发容器与记录（与终端会话的遗留清理同款语义）。
- [x] **后端宿主不持有转发端口**：服务端不监听任何转发用端口、不连 `127.0.0.1:<宿主端口>`；响应模型与 API.md 中**不出现 `host_port` / 宿主端口字段**。
- [x] 服务端 pytest 全绿且新增转发用例；ruff（`E4/E7/E9/F`）退出码 0。
- [x] 服务端代码不含转发编排逻辑本体（编排在核心包），分层契约测试红线不触发。
- [x] `apps/web/backend/API.md` 新增「端口转发接口」章节：三条 REST 的入参 / 出参 / 错误口径、隧道 WS 的路径 / 鉴权 / 帧协议 / 关闭码、**字节泵机制（`docker exec -i`）与 exec 进程回收语义**、生命周期语义表（**不含宿主端口**）。

## 依赖

- 依赖 [[tasks/phase3-desktop/04-port-forward-core.md|04 端口转发核心包能力]]。
- 依赖 [[tasks/phase3-desktop/02-backend-token-and-cors.md|02 连接层后端改造]] 的鉴权中间件（隧道 WS 走同一条 Bearer 通道）。
- 协议依据：[[architecture/decisions/0014-端口转发机制选型.md|ADR 0014]] 第 3、5、6 节（**第二次修订，决策 C**）。

## 进展（2026-11-03）

**状态：done。** 已实现并通过「审查 + 修复轮」。

### 实现摘要

- 新增 `apps/web/backend/src/sandbox_console/routes/forwards.py`：三条转发管理 REST（`GET /api/forwards` **裸数组**、`POST /api/forwards` 入参 `{sandbox, port}`、`DELETE /api/forwards/{forward_id}`）+ 隧道 WebSocket（`/api/forward/tunnel/{forward_id}`，握手带 `Authorization: Bearer`）。
- 新增 `apps/web/backend/src/sandbox_console/forwards.py`：服务端**装配层**——活动隧道登记表（`TunnelRegistry`）、字节泵搬运（读写循环、stderr 尾部取用）、字节泵 I/O **专用线程池**、四个关闭码常量。**能力本体仍在核心包**，这里只做编排与转译。
- 改 `auth.py`：新增 **WebSocket Bearer 清单**（`WEBSOCKET_BEARER_PATHS`）——中间件在握手前校验 Bearer，路由再核一道（纵深防御）；**两份清单**（终端 WS 的豁免清单 / 隧道 WS 的 Bearer 清单）都没登记的 WS 路由仍按 fail-closed 拒握手。
- 改 `deps.py`：转发编排入口取**生命周期服务持有的那一个**（不另建实例）+ 活动隧道登记表的依赖注入（只有 WS 版）。
- 改 `schemas.py`：`ForwardCreateRequest`（`extra="forbid"`）/ `ForwardModel`（id / sandbox / container_port / state / created_at / updated_at，**无 `host_port`**）/ `ForwardDeleteResponse`（removed / failed）。
- 改 `errors.py`：转发链路的**固定中文文案表** + `classify_forward_error`（异常 → 状态码 + 固定文案）+ `forward_tunnel_error_detail`（隧道错误帧文案，与 REST 同一口径）。
- 改 `app.py`：lifespan 里**启动时清理遗留转发**（`purge_leftover`，与终端会话的遗留清理同处、同款语义；失败只记日志、不阻断启动）、**退出时关掉全部活动隧道**（字节泵进程一并回收）。
- 改 `routes/__init__.py`：注册转发路由。
- 新增 `apps/web/backend/tests/test_forwards.py`：**44 条**转发 / 鉴权用例。
- 改 `apps/web/backend/API.md`：新增**第 15 章「端口转发接口」**（三条 REST 的入参 / 出参 / 错误口径表、隧道 WS 的路径 / 鉴权 / 帧协议 / 关闭码表、字节泵机制与 exec 进程回收语义、生命周期语义表——**不含宿主端口**）。
- **核心包连带改了一处**（本轮修复的落点）：`apps/core/src/sandbox_platform/forwarding.py` 的 `BytePump` 增加 **stderr 排空**（后台守护线程持续读走 stderr，只留尾部 8KB）——exec 的失败原因只在 stderr 里，没人排空时写满管道会把子进程卡死，隧道表现为「静默 hang」。

### 审查修复轮（2 Critical + 6 Warning）

- **2 Critical**：① **错误帧 / HTTP `detail` 全部改固定中文文案**——核心异常原文（容器客户端输出、宿主绝对路径、多行文本）**只进日志**（带日志键便于排查），不再按措辞截取原文（截取对没有括号的原文完全失效，会把整段原文回显出去）；② **`SandboxError` 在隧道侧统一收敛到 `1008`**——转发不存在 / 已停止 / 记录损坏 / 沙箱已删一律「错误帧 + 1008」，不与 `1011`（字节泵异常结束）混。
- **6 Warning**：① **镜像拉不到 → 503**（`ImageNotFoundError` 走 `classify_forward_error`，文案「转发镜像不可用（镜像拉不到）」；400 只留给真正的入参非法）；② **字节泵 I/O 走独立线程池（32 线程）**——不与事件循环默认执行器抢线程（并发隧道一多会互相等线程饿死，REST 接口也被拖慢）；③ **stderr 排空与失败原因帧**——排空线程与 stdout 的 EOF 几乎同时发生，取尾部要等一小会儿（否则原因帧就丢了）；给客户端的是**固定文案帧**，stderr 原文只进日志；④ **关闭竞态收敛**——登记表带「正在关闭」标志：服务退出后新来的连接立即按 1001 关掉、字节泵照常回收，不留既没被登记也没被关掉的野隧道；⑤ **新增关闭码 `1011`**——字节泵异常结束用 1011，客户端按「可重试」处理（此前只能被 1000 / 1008 混掉，客户端分不出「链路暂不可用」与「正常收尾」）；⑥ **异常路径也必须收泵收尾**——连接断开 / 桥接异常时：取消并等待两个搬运任务 → 按进程组回收字节泵 → 摘登记表；回收与关闭失败只记日志，不阻断收尾。

### 门禁

- 服务端 pytest：**289 passed**（含**新增 44 条**转发 / 鉴权用例，`apps/web/backend/tests/test_forwards.py`）。
- 核心包 pytest：**292 passed**（较 04 的 288 增加 4 条 `BytePump` stderr 排空用例）。
- ruff（`E4/E7/E9/F`）：退出码 **0**。
- 分层契约测试：**10 passed**，红线不触发（服务端不含转发编排逻辑本体）。
- 命令行 `apps/cli/`、前端 `apps/web/frontend/`、桌面壳：**零改动**。

### 协议要点（客户端要对齐的口径）

- **固定文案错误帧**：隧道的错误帧是 `{"type":"error","message":"<固定文案>"}`，REST 的 `detail` 同款；核心异常原文只进日志。常见文案：「端口转发不存在或已失效」「沙箱已停止，无法建立端口转发（请先启动沙箱）」「转发镜像不可用（镜像拉不到）」「字节泵异常结束（转发链路执行失败），详见服务日志」。
- **帧协议**：**二进制帧 = 透传字节**；**文本帧 = 控制帧**（`hello` / `error`）。
- **关闭码**：**1000** 正常收尾（任一侧 EOF / 断开，服务端把另一侧也收掉）；**1001** 服务退出兜底（服务端主动关活动隧道，客户端据此重连）；**1008** 策略违规（鉴权未过 / 转发不存在 / 已停止 / 记录损坏 / 沙箱已删）；**1011** 字节泵异常结束（exec 失败，**客户端按可重试处理**）。注意：鉴权失败是**握手在 accept 之前被拒**——生产环境（uvicorn）表现为 HTTP 403、关闭码不送达，TestClient 下是 `WebSocketDisconnect(1008)`，那是测试语义。
- **专用线程池取舍**：字节泵读写是**阻塞式裸管道 I/O**，一律放线程里做；**不与事件循环默认执行器抢线程**（默认池容量只有十几个，且 REST 接口共用它 → 并发隧道一多就饿死、REST 被拖慢）。代价：**超过 32 条并发隧道会排队等待**（一条隧道最多占 2 个线程：读 + 写）；本期不做多路复用（一条 WS 对一条 TCP 连接）。
