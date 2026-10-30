---
prd: prds/phase2-console.md
status: done
---
# 任务：网页终端（伪终端会话与 WebSocket 桥接）

> 实测结论：全部完成标准通过。新增 `platform/src/sandbox_platform/server/terminal.py`（会话管理器）、`server/sessions.py`（会话表）、`server/routes/terminal.py`（路由）；核心包 `daemon.py` 新增流式执行入口（`spawn_pty` / `exec_pty` / `exec_pty_shell`），宿主侧分配伪终端承载容器内的交互式 shell，容器内进程拿到真实 TTY。接口文档 `platform/src/sandbox_platform/API.md` 第 12 节增补终端接口与 WebSocket 帧协议。命令行 `platform/cli/sandboxctl.py` 源码一行未改。
>
> 审查修复轮（2026-10-30）：reviewer 结论「需修复后合并」，已按清单修完 1 项严重问题 + 7 项中等问题 + 8 项采纳建议。最重的一条是**输入写阻塞导致的终端双向死锁**：伪终端主端是阻塞的，用户粘贴大文本或容器内进程停止读 stdin 时，I/O 线程卡在 `write` 上不再读主端 → 输出写满 → 容器内 shell 卡写 → 两边互等，Ctrl-C 都送不进去。现在伪终端主端改为非阻塞，写不进去就留着字节等下一个「可写事件」，I/O 线程因此永远不会停止读输出。第二条是**容器内 shell 残留**：杀宿主侧 `docker exec` 客户端并不会终止容器内的 bash，服务重启后容器里会堆积无主 shell。现在会话关闭与启动清理都会按注入的环境标识在容器内收掉残留进程，接口文档第 12.4 节「容器内进程一并收掉」的承诺成立。其余：清理遗留进程改用「进程身份指纹（进程组号 + 启动时刻）+ 杀前复核」防进程号复用误杀、僵尸进程立即判定不再白等 3 秒宽限期、`terminate` 幂等且必须带会话标识复核、附着计数不再多减、输入超限改丢最新字节并给客户端发提示帧、会话数加全局与单沙箱上限并回收空闲会话、窗口大小变更纳入落盘、启动清理加跨实例保护（记录带 `host_pid`，另一个实例还在用就不动它）。
>
> 关键实现约定：宿主交互一律收敛在核心包（`daemon.py`），服务层只做编排与转译；伪终端主端非阻塞，写侧永不阻塞；会话表的落盘走后台线程的合并写，事件循环线程不做文件 I/O；会话上限与空闲回收时长都是常量，可用环境变量覆盖。

## 目标
实现网页终端的服务端部分：在沙箱容器内跑起带真实 TTY 的交互式 shell，宿主侧用伪终端承载，通过 WebSocket 与浏览器双向桥接。同一沙箱可开多个独立终端；浏览器断开后会话由服务保留，重连可重新附着且现场不丢；服务重启则会话全部失效。

## 完成标准
- [x] 新增 `platform/src/sandbox_platform/server/terminal.py`（会话管理器）、`platform/src/sandbox_platform/server/sessions.py`（会话表）、`platform/src/sandbox_platform/server/routes/terminal.py`（路由）。
- [x] 核心包 `daemon.py` 新增流式执行入口（如 `exec_pty`）：以沙箱用户身份在沙箱容器内执行交互式 shell（`docker exec -it`），宿主侧分配伪终端并返回「进程句柄 + 主端文件描述符」；执行身份、环境变量与权限构造复用 `UserDaemon` 既有方法，不另起一套特权逻辑。
- [x] 容器内进程拿到真实 TTY：行编辑（历史、回车、Ctrl-C）生效，全屏程序（`top`、`vim`）可正常渲染；验收以容器内实际交互输出为准，不接受「假终端」凑数。
- [x] 同一沙箱可同时开多个独立终端：每个会话一个独立 exec 进程与伪终端，互不影响；一个会话的输入不串到另一个会话。
- [x] 窗口大小同步：浏览器上报 `{"type":"resize","cols":..,"rows":..}`，服务端设置宿主伪终端窗口大小并触发尺寸转发到容器内 TTY；验收以容器内 `tput cols` / `tput rows` 的输出与浏览器窗口一致为准。
- [x] 断线语义：浏览器断开后 exec 进程不退出，服务继续把输出写入环形缓冲；重连携带同一 `session_id` 时先回放缓冲再接实时流，终端现场不丢。
- [x] 服务重启语义：启动时读取会话表，把全部记录标记为 `orphaned` 并清理（按记录的进程号终止遗留 exec 进程，仅当该进程命令行含本次会话标记时才终止，避免误杀复用进程号；再按同一个标识收掉容器内残留的 shell），随后删除会话表文件；重启后旧 `session_id` 不可再附着。
- [x] 会话表持久化到平台数据目录 `<平台数据根>/terminal-sessions/<session_id>.json`，字段：`session_id`、`sandbox_name`、`container_name`、`system_user`、`created_at`、`last_attached_at`、`state`、`exit_code`、`pid`、`cols`、`rows`、`attached_count`、`host_pid`；会话创建、退出、附着、断开与窗口大小变更时落盘。
- [x] 接口：`POST /api/terminal/sessions`（新建会话，返回 `session_id` 与初始窗口大小）、`GET /api/terminal/sessions?sandbox=`（列出该沙箱的会话）、`WS /api/terminal/sessions/{session_id}`（附着）。
- [x] 终端协议固定：客户端二进制帧 = 终端输入字节；客户端文本帧 = `{"type":"resize","cols":..,"rows":..}`；服务端二进制帧 = 终端输出字节；服务端文本帧 = `{"type":"hello","session_id":..,"sandbox":..,"cols":..,"rows":..}` / `{"type":"exit","code":n}` / `{"type":"error","message":".."}`。
- [x] 沙箱不存在、未运行或容器已被删除时，创建会话直接失败并给出中文错误，不创建空会话；会话表只登记真实存在的会话。
- [x] 单元测试 `platform/tests/test_terminal_sessions.py`：会话表读写与原子落盘、会话创建与附着状态流转、断线后会话保留、缓冲回放、窗口大小设置（用伪终端直接断言 winsize）、会话退出后状态与退出码落盘、服务重启后孤儿会话被清理。
- [x] 接口文档 `platform/src/sandbox_platform/API.md` 增补终端接口与 WebSocket 协议章节（含帧类型对照表）。
- [x] 降级备选只记录不实施：若自研伪终端方案受阻，另立任务评估容器内 `abduco` / `dtach` 保活方案（需改沙箱镜像并重建），本任务不引入该依赖、不改任何镜像。

## 依赖
- 依赖 [[tasks/phase2-console/01-service-core-api.md|01 控制面服务骨架与沙箱管理接口]]（应用骨架、路由注册约定、lifespan 清理钩子）。
- 依赖一期已落地的 `UserDaemon`（[[tasks/sandbox-platform/04-lifecycle-core-cli.md|04 生命周期核心模块与 CLI]]）。
