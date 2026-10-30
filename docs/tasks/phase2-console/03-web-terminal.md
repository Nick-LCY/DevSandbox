---
prd: prds/phase2-console.md
status: todo
---
# 任务：网页终端（伪终端会话与 WebSocket 桥接）

## 目标
实现网页终端的服务端部分：在沙箱容器内跑起带真实 TTY 的交互式 shell，宿主侧用伪终端承载，通过 WebSocket 与浏览器双向桥接。同一沙箱可开多个独立终端；浏览器断开后会话由服务保留，重连可重新附着且现场不丢；服务重启则会话全部失效。

## 完成标准
- [ ] 新增 `platform/src/sandbox_platform/server/terminal.py`（会话管理器）、`platform/src/sandbox_platform/server/sessions.py`（会话表）、`platform/src/sandbox_platform/server/routes/terminal.py`（路由）。
- [ ] 核心包 `daemon.py` 新增流式执行入口（如 `exec_pty`）：以沙箱用户身份在沙箱容器内执行交互式 shell（`docker exec -it`），宿主侧分配伪终端并返回「进程句柄 + 主端文件描述符」；执行身份、环境变量与权限构造复用 `UserDaemon` 既有方法，不另起一套特权逻辑。
- [ ] 容器内进程拿到真实 TTY：行编辑（历史、回车、Ctrl-C）生效，全屏程序（`top`、`vim`）可正常渲染；验收以容器内实际交互输出为准，不接受「假终端」凑数。
- [ ] 同一沙箱可同时开多个独立终端：每个会话一个独立 exec 进程与伪终端，互不影响；一个会话的输入不串到另一个会话。
- [ ] 窗口大小同步：浏览器上报 `{"type":"resize","cols":..,"rows":..}`，服务端设置宿主伪终端窗口大小并触发尺寸转发到容器内 TTY；验收以容器内 `tput cols` / `tput rows` 的输出与浏览器窗口一致为准。
- [ ] 断线语义：浏览器断开后 exec 进程不退出，服务继续把输出写入环形缓冲；重连携带同一 `session_id` 时先回放缓冲再接实时流，终端现场不丢。
- [ ] 服务重启语义：启动时读取会话表，把全部记录标记为 `orphaned` 并清理（按记录的进程号终止遗留 exec 进程，仅当该进程命令行含本次会话标记时才终止，避免误杀复用进程号），随后删除会话表文件；重启后旧 `session_id` 不可再附着。
- [ ] 会话表持久化到平台数据目录 `<平台数据根>/terminal-sessions/<session_id>.json`，字段：`session_id`、`sandbox_name`、`container_name`、`system_user`、`created_at`、`last_attached_at`、`state`、`exit_code`、`pid`、`cols`、`rows`、`attached_count`；会话创建、退出、附着与断开时落盘。
- [ ] 接口：`POST /api/terminal/sessions`（新建会话，返回 `session_id` 与初始窗口大小）、`GET /api/terminal/sessions?sandbox=`（列出该沙箱的会话）、`WS /api/terminal/sessions/{session_id}`（附着）。
- [ ] 终端协议固定：客户端二进制帧 = 终端输入字节；客户端文本帧 = `{"type":"resize","cols":..,"rows":..}`；服务端二进制帧 = 终端输出字节；服务端文本帧 = `{"type":"hello","session_id":..,"sandbox":..,"cols":..,"rows":..}` / `{"type":"exit","code":n}` / `{"type":"error","message":".."}`。
- [ ] 沙箱不存在、未运行或容器已被删除时，创建会话直接失败并给出中文错误，不创建空会话；会话表只登记真实存在的会话。
- [ ] 单元测试 `platform/tests/test_terminal_sessions.py`：会话表读写与原子落盘、会话创建与附着状态流转、断线后会话保留、缓冲回放、窗口大小设置（用伪终端直接断言 winsize）、会话退出后状态与退出码落盘、服务重启后孤儿会话被清理。
- [ ] 接口文档 `platform/src/sandbox_platform/API.md` 增补终端接口与 WebSocket 协议章节（含帧类型对照表）。
- [ ] 降级备选只记录不实施：若自研伪终端方案受阻，另立任务评估容器内 `abduco` / `dtach` 保活方案（需改沙箱镜像并重建），本任务不引入该依赖、不改任何镜像。

## 依赖
- 依赖 [[tasks/phase2-console/01-service-core-api.md|01 控制面服务骨架与沙箱管理接口]]（应用骨架、路由注册约定、lifespan 清理钩子）。
- 依赖一期已落地的 `UserDaemon`（[[tasks/sandbox-platform/04-lifecycle-core-cli.md|04 生命周期核心模块与 CLI]]）。
