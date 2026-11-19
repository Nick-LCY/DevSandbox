---
prd: prds/console-terminal-emulator.md
status: done
---
# 任务：服务端常驻终端模拟器

> 需求见 [[prds/console-terminal-emulator.md|控制台终端全步方案 + 前端实例常驻]]；决策见 [[architecture/decisions/0020-控制台终端采用后端模拟器与快照接入.md|ADR 0020]]。
> 本页是**施工单前段**的交付留档（后端侧的能力落点）。协议与前端接线见 [[tasks/console-terminal-emulator/02-attach-snapshot-protocol.md|02 接入协议换代]]；全轮数字与遗留见 [[tasks/console-terminal-emulator/RESULTS.md|全轮留档]]。

## 目标

### 一、每会话一份进程内 VT 模拟器

- 新增 `apps/web/backend/src/sandbox_console/emulator.py`：封装 **pyghostty 0.1.4**（Python 绑定，进程内跑 libghostty-vt）的一个会话级实例。
- 在 `terminal.py` 的输出路径上**并行喂**：容器输出照旧转发前端，并在 `_publish` 锁内同步喂给模拟器（唯一权威仍是 PTY 字节流，模拟器只是影子状态）。
- **几何三者恒一致**（模拟器 / 宿主伪终端 / 会话记录）：resize 先改模拟器再改 PTY，PTY 失败回滚模拟器，模拟器失败则两边都不改。
- 导出「当前画面 + 光标 + 终端模式」的 **VT 恢复流**供附着时下发。

### 二、两条红线

1. **逐字段显式 ctype**：状态 / 恢复流的结构体字段一律显式声明 ctype。默认类型推断会让字段宽度与实际布局不符，堆越界**崩整个服务进程**（不是单会话失败）。
2. **不注册应答回调**：模拟器自己产生的探测应答**静默丢弃**。转发出去就等于历史探测被再应答（症状②的根因）。

### 三、降级

- pyghostty 装不上（只有 wheel：glibc Linux x86_64/aarch64 + macOS、无 sdist）或 `SANDBOX_TERMINAL_EMULATOR` 关停时，**整条能力缺失但不影响服务启动**：服务端退回环形缓冲回放，前端走降级兜底。

## 完成标准

- [x] `emulator.py` 落地：创建 / 喂字节 / resize / 导出快照 / 释放；显式 ctype 全覆盖；不注册应答回调。
- [x] 与 `terminal.py` 接通：输出并行喂、会话生命周期内释放、几何与 PTY 联动（先模拟器后 PTY、失败回滚）。
- [x] 单测 10 条：**ctype 矩阵**（逐字段宽度与取值）、**快照往返幂等**（导出 → 重放 → 再导出一致）、**kitty 恢复序列**（键盘协议相关序列的恢复口径）。
- [x] 门禁：后端 `pytest` 全绿（**461 passed**）。

## 依赖

- 无（本轮后端侧的地基；协议对接见 [[tasks/console-terminal-emulator/02-attach-snapshot-protocol.md|02 接入协议换代]]）。
- 新增第三方依赖：`pyghostty==0.1.4`（wheel-only）。

## 进展（2026-11-19 交付）

- **交付**：`sandbox_console/emulator.py` 新文件；`sandbox_console/terminal.py` 接入（并行喂、几何联动、开关 `ENV_EMULATOR = "SANDBOX_TERMINAL_EMULATOR"`）。
- **两条红线均按实现层约束落地**：ctype 逐字段显式（单测里用 ctype 矩阵钉住）；应答**不注册回调**（模拟器解析到探测时产生的应答不外出）。
- **门禁**：后端 pytest **461 passed / 0 failed**（含 `emulator` 单测 10 条）。
- **降级口径**：`SANDBOX_TERMINAL_EMULATOR=0` / `off` / `false` 三种写法等价关停，与「装不上」走同一条回退路径。
- 代价与已知限制（快照只恢复活动屏、回滚深度 1000 vs 5000 等）见 [[architecture/decisions/0020-控制台终端采用后端模拟器与快照接入.md|ADR 0020]] 的影响节；全轮门禁与遗留见 [[tasks/console-terminal-emulator/RESULTS.md|全轮留档]]。
