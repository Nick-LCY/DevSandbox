# 控制台终端全步方案 + 前端实例常驻任务集

本目录是**控制台终端全步方案 + 前端实例常驻**轮的任务集，共 4 个任务，需求见 [[prds/console-terminal-emulator.md|控制台终端全步方案 + 前端实例常驻（交付后补记）]]，决策依据见 [[architecture/decisions/0020-控制台终端采用后端模拟器与快照接入.md|ADR 0020 控制台终端采用后端模拟器与快照接入]]。

这一轮把 2026-11-17 登记的「pi × 控制台终端四项待办」里的 **①②** 从源头根治：控制台终端改为**服务端常驻终端模拟器 + 附着时下发快照恢复流**（恢复介质从「历史字节」换成「当前状态」），前端同轮落地**终端实例常驻**（标签之间不再销毁重建 xterm）。**③ 自定义按键映射、④ 系统剪贴板互通仍登记不做。**

**状态：01~04 全部 done（2026-11-19 收口）**——后端 **461 passed**、前端 vitest **1041 passed**、核心包 **511 / 514**（3 例既有镜像代理 502 环境故障，本轮 `apps/core` 零改动）、typecheck ×2 + build + ruff 全绿；e2e 全量 **75 条**（基线 71 + 新增 4）每条至少通过一次、无稳定失败（单次 75/75 受宿主内存 OOM 制约，dmesg 实证）。**全轮留档见 [[tasks/console-terminal-emulator/RESULTS.md|RESULTS.md]]**。看板见 [[current-state.md|当前状态]]。

**2026-11-26 更新：** 本轮代码 17 个提交已全部在 `origin/main`；前端已随 2026-11-25 的 `v0.1.0` 发布部署到 Cloudflare Worker；**宿主侧后端是否已重启更新未记录、待核实**。

## 关键口径（贯穿全轮）

| 口径 | 内容 |
|---|---|
| 权威 | 终端模式状态由**服务端模拟器**权威持有（pyghostty 0.1.4 / 进程内 libghostty-vt），前端 xterm 只是显示端 |
| 恢复介质 | **VT 恢复流（当前画面 + 光标 + 模式）**，不再是历史字节回放；历史里的终端探测不进任何回放 |
| 握手 | `attach`（报尺寸）→ 对齐会话（先模拟器后 PTY，失败回滚）→ 静默窗口（0.12 s / 上限 0.8 s）→ `snapshot` 分片 → 实时流 |
| 快照分片 | **48 KiB 原文**切片、base64 装文本帧（约 64 KiB，不越中间代理单帧上限）；带 `cols`/`rows`/`pwd` |
| 旧客户端 | 1 秒内无 `attach` ⇒ 回退环形缓冲回放（64 KiB 二进制帧），行为与历史一致 |
| 迟到 `attach` | **补发快照**：不新开输出流、分片持锁串行 |
| 两红线 | ① 结构体字段**逐字段显式 ctype**（默认类型会堆越界崩进程）；② **不注册应答回调**（探测应答静默丢弃） |
| 开关 | `SANDBOX_TERMINAL_EMULATOR`（`ENV_EMULATOR`）= `0` / `off` / `false` 关停，走回退路径 |
| 前端常驻 | 标签之间常驻（`display:none`）、只挂载**已访问过**的会话；**切 Obsidian tab 仍整体卸载** |
| 焦点回填 | 按会话的**请求序号**（`focusRequestId`）消费一次，重连不重放 |

## 任务清单

| 编号 | 任务 | 状态 | 交付内容 |
|---|---|---|---|
| [[tasks/console-terminal-emulator/01-server-emulator.md\|01]] | 服务端常驻终端模拟器 | **done** | `sandbox_console/emulator.py`（pyghostty 进程内实例）：输出**并行喂**（`_publish` 锁内）、几何与 PTY 恒一致（先模拟器后 PTY、失败回滚）、快照导出；两红线落地；单测 10 条（ctype 矩阵 / 快照往返幂等 / kitty 恢复序列）；后端 461 passed |
| [[tasks/console-terminal-emulator/02-attach-snapshot-protocol.md\|02]] | 接入协议换代（attach / snapshot） | **done** | `routes/terminal.py`：`attach` 握手、静默窗口、快照分片、迟到补发、旧客户端回退；前端 `lib/terminal.ts` + `lib/terminal-snapshot.ts` + `TerminalView.tsx`：恢复三连（resize → reset → write）、分片一致性丢弃、旧后端静默豁免 + 补发 `resize`、降级两步 resize 兜底；sessions 测试改写 + 新增（迟到 attach / 切点不重不漏 / 并发不重复） |
| [[tasks/console-terminal-emulator/03-terminal-residency.md\|03]] | 前端实例常驻（**施工单步骤 8**） | **done** | `TerminalStack.tsx` + `terminal-residency.ts`：标签间常驻、只挂载已访问会话、`display:none` 隐藏、变可见 refit、滚动位置按距底部还原、焦点请求序号、隐藏会话状态提示；前端 vitest 1041 passed（常驻 15 条新用例） |
| [[tasks/console-terminal-emulator/04-acceptance-and-docs.md\|04]] | 验收与文档收口 | **done** | e2e `17-terminal-snapshot.spec.ts` 四条（reload 强制重挂载取证：括号粘贴 / 鼠标上报 / 无再应答 / 画面恢复）+ 门禁全量 + ADR / 约定 / 看板 / 索引同步 |

## 依赖顺序

```
01 ──▶ 02 ──▶ 04
        │      ▲
03 ─────┴──────┘
```

- **01 → 02 强顺序**：协议下发的快照来自模拟器；模拟器不在时只剩回退路径。
- **03 与 02 是同一方案的两半**：常驻只消灭「切标签」这一条重建路径，刷新 / Obsidian 往返 / 重连仍要靠快照恢复；**两者缺一不可**（03 落地不依赖 02 的代码，但验收口径互相咬合）。
- **04 依赖 01 / 02 / 03 全部落地**（e2e 取证与门禁都要在最终态上跑）。

## 关键前置与风险

| 项 | 性质 | 影响 | 现状 |
|---|---|---|---|
| **pyghostty 只有 wheel**（glibc Linux x86_64/aarch64 + macOS、无 sdist） | 硬前提 | 平台或 Python 版本一变可能装不上 | 已留降级路径：装不上 ⇒ 能力缺失、服务照常启动、前端走回退（环形缓冲回放 + 两步 resize 逼 pwd）；另有开关 `SANDBOX_TERMINAL_EMULATOR` |
| **两条红线都关乎进程存活 / 症状复发** | 实现层硬约束 | 显式 ctype 漏一个 ⇒ 堆越界崩整个服务进程；注册应答回调 ⇒ 症状② 从源头复发 | 单测以 ctype 矩阵与「无应答回调」钉住；e2e 以 DA1 应答计数不变钉住 |
| **快照只恢复活动屏** | 已接受代价 | pi 全屏期间主屏早期输出不回放 | 写进 ADR 影响节与 RESULTS 第五节；不当作缺陷修 |
| **回滚深度两侧不同**（服务端 1000 / 前端 5000 行） | 已接受代价 | 长会话重挂载后可回滚历史降到 ≤1000 行 | 同上 |
| **宿主内存不足以单次跑满 e2e** | 环境约束 | 无法取得单次 75/75 的漂亮数字 | 75 条逐条至少通过一次、无稳定失败；OOM 有 dmesg 实证，归因宿主资源 |

## 任务文件

- [[tasks/console-terminal-emulator/01-server-emulator.md]] — 服务端常驻终端模拟器（**done**：`emulator.py` + 两红线 + 单测 10 条；后端 461 passed）。
- [[tasks/console-terminal-emulator/02-attach-snapshot-protocol.md]] — 接入协议换代（**done**：attach → 对齐 → 静默 → snapshot → 实时流；迟到补发 / 旧客户端回退 / 前端恢复三连与降级兜底）。
- [[tasks/console-terminal-emulator/03-terminal-residency.md]] — 前端实例常驻（**done**：施工单步骤 8 的增量；标签间常驻 + 只挂载已访问 + 焦点请求序号；常驻 15 条新用例）。
- [[tasks/console-terminal-emulator/04-acceptance-and-docs.md]] — 验收与文档收口（**done**：e2e 17 四条 reload 取证 + 门禁全量 + 文档同步）。
- [[tasks/console-terminal-emulator/RESULTS.md]] — **全轮收口留档**：轮次总表与提交链、门禁数字表、根因→根治对照、测试与取证要点、已知限制 6 条、偏离登记 5 条、评审遗留 4 条。
- [[prds/console-terminal-emulator.md]] — 需求（**交付后补记**：本轮以施工单推进，未先立 PRD）。
- [[architecture/decisions/0020-控制台终端采用后端模拟器与快照接入.md]] — **ADR 0020**（已接受）：模拟器选型三档对比、接入协议换代、两条红线、已知限制。

## 后续更新（2026-11-26）

17 个提交 `82b70bf..da45bda` 已在 `origin/main`。前端已随 2026-11-25 的 `v0.1.0` 发布部署到 Cloudflare Worker。宿主侧后端服务在 2026-11-25 之后是否已重启 / 更新：未记录，待核实。
