---
prd: prds/console-terminal-emulator.md
status: done
---
# 任务：接入协议换代（attach / snapshot）

> 需求见 [[prds/console-terminal-emulator.md|控制台终端全步方案 + 前端实例常驻]]；决策见 [[architecture/decisions/0020-控制台终端采用后端模拟器与快照接入.md|ADR 0020]]；模拟器本身见 [[tasks/console-terminal-emulator/01-server-emulator.md|01 服务端常驻终端模拟器]]。
> 帧表与兼容矩阵的权威口径是 `apps/web/backend/API.md` 12.3，本页只记交付与口径。

## 目标

### 一、后端（`routes/terminal.py`）

- **握手换代**：客户端先发 `{"type":"attach","cols","rows"}`（第一个控制帧）→ 服务端把会话（**伪终端 + 模拟器**）对齐到该尺寸 → 等**静默窗口**（0.12 s 无输出 / 上限 0.8 s，让容器内程序把重绘做完）→ 下发 `{"type":"snapshot",part,parts,data,cols,rows,pwd}` 分片（**48 KiB 原文切片**、base64 后约 64 KiB，不越中间代理单帧上限）→ 续实时流。
- **几何三者一致**：先改模拟器、再改 PTY；PTY 改不动就回滚模拟器；模拟器改不动则两边都不改。
- **旧客户端回退**：1 秒内没收到 `attach` ⇒ 判定旧客户端，走环形缓冲回放（二进制帧按 64 KiB 原文切片），行为与历史一致。
- **迟到的 `attach` 补发快照**：超时之后才到的 `attach` 不丢弃——按该尺寸 resize → 等静默 → 取快照 → 同口径分片**补发**；**不新开输出流**（两条流会把同一块输出投递两遍），分片发送**持锁串行**。
- **开关**：`SANDBOX_TERMINAL_EMULATOR`（`ENV_EMULATOR`；`0` / `off` / `false`）关停后整条快照能力关闭、走回退路径。

### 二、前端（`src/lib/terminal.ts`、`src/components/TerminalView.tsx`、`src/lib/terminal-snapshot.ts`）

- 连上后**不发任何帧**，等 `hello` 拿到会话尺寸，再发 `attach`。
- 收到 `snapshot` 分片后按固定顺序恢复：**先 `term.resize(快照 geometry)` → 再 `term.reset()` → 再 `term.write(恢复流)`**。
- **分片拼不拢就丢弃**（缺片 / 序号重复 / 非法 base64 一律不写）；解码收敛在纯函数 `terminal-snapshot.ts`。
- **pwd 随快照恢复**：帧里的 `pwd`（最近一条 OSC 1337 载荷）按既有校验口径落前端内存缓存；后端会话记录仍**不加字段**。
- **旧后端兼容**：旧后端不认 `attach`（回「无法识别的终端指令」错误帧）时**静默豁免**（不弹提示、不改状态），并**补发一帧 `resize`** 让旧后端照常同步尺寸。
- **降级兜底**：attach 后窗口内一个快照分片都没收到（旧后端 / 模拟器关停）⇒ 补一次「尺寸真变化」的两步 resize 逼 readline 重画提示符，重新拿到 OSC 1337 pwd；正常路径不做。

## 完成标准

- [x] 后端 `attach` / `snapshot` 握手与静默窗口落地；几何对齐先模拟器后 PTY、失败回滚。
- [x] 迟到 `attach` 补发快照（不新开流、分片持锁串行）；旧客户端 1 秒超时回退环形缓冲。
- [x] 前端快照恢复三连（resize → reset → write）、分片一致性校验、旧后端静默豁免 + 补发 `resize`、降级两步 resize 兜底。
- [x] 后端 `sessions` 测试改写 + 新增：迟到 attach、**切点不重不漏**（快照与实时流的边界既不重复也不丢字节）、并发附着不重复。
- [x] 前端单测：快照分片一致性、`reset` 后 OSC handler 仍存活（承重：pwd 通道不能因 reset 断掉）。

## 依赖

- 依赖 [[tasks/console-terminal-emulator/01-server-emulator.md|01 服务端常驻终端模拟器]]（模拟器不在则只剩回退路径）。
- 前端的槽位常驻改造见 [[tasks/console-terminal-emulator/03-terminal-residency.md|03 前端实例常驻]]（本页只负责恢复流，不负责槽位）。

## 进展（2026-11-19 交付）

- **后端交付**：`routes/terminal.py` 的 `attach` 握手、静默窗口、快照分片、迟到补发、旧客户端回退；`terminal.py` 的快照导出与几何联动。
- **前端交付**：`lib/terminal.ts` 帧解析（`attach` / `snapshot` / 旧后端错误识别）、`lib/terminal-snapshot.ts` 分片解码、`TerminalView.tsx` 恢复顺序与降级定时器。
- **门禁**：后端 **461 passed**（含 sessions 改写与新增用例）；前端 vitest **1041 passed**（含快照分片一致性与 OSC handler 承重用例）。
- **口径要点**：`hello` 先到、`attach` 后发；`snapshot` 的 `cols`/`rows` 是**这份快照的几何**，重放端必须先按它 resize；`pwd` 可空，空即不覆盖既有缓存。
