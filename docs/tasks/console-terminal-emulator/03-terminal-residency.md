---
prd: prds/console-terminal-emulator.md
status: done
---
# 任务：前端实例常驻（施工单步骤 8）

> 需求见 [[prds/console-terminal-emulator.md|控制台终端全步方案 + 前端实例常驻]]；决策见 [[architecture/decisions/0020-控制台终端采用后端模拟器与快照接入.md|ADR 0020]]；快照恢复流见 [[tasks/console-terminal-emulator/02-attach-snapshot-protocol.md|02 接入协议换代]]。
> **这是施工单步骤 8 的增量任务页**：前七步按交付面归并为 [[tasks/console-terminal-emulator/01-server-emulator.md|01 服务端常驻终端模拟器]] 与 [[tasks/console-terminal-emulator/02-attach-snapshot-protocol.md|02 接入协议换代]] 两页（后端模拟器、接入协议与前端接线）。

## 目标

### 一、终端标签之间常驻

- 新增 `src/components/TerminalStack.tsx`：每个常驻会话一个槽位，**删掉 `TerminalPanel` 上的 `key={activeId}`**——切标签不再销毁重建 xterm 实例。
- **只有访问过的会话才挂载**：挂载集合 = 已访问 ∩ 仍在会话表 ∪ 当前激活（纯函数 `src/lib/terminal-residency.ts`）；没点过的会话不自动附着。
- 非激活槽位用 **`display:none`**（Tailwind `hidden`）隐藏：不用 `visibility` / `opacity` / `z-index` 叠加。
- **变可见补一次 fit**（隐藏态 xterm 量不到尺寸，fit 会算出 0 列）；**滚动位置按「距底部」还原**（隐藏时记 `viewportY`，可见时 `scrollLines` 还原）。
- **切 Obsidian tab 仍是分屏整体卸载**（既有约定与 e2e 的 count 0 断言不动）：切回来重新挂载，走 attach + 快照恢复。

### 二、焦点回填换代

- 回填从「挂载时布尔」改为**按会话的回填请求序号**（`focusRequestId`）：面板发请求、终端视图消费一次，序号不变不重复抢焦点；重试连接（重建 WebSocket）**不重放旧请求**。
- 回填时机不变：用户刚点标签 / 点终端表面 / 新建会话，或判定当下焦点就在终端表面内；**绝不抢别处的焦点**。

### 三、状态提示

- 隐藏会话的状态变化**也进会话状态表**并照既有去重规则弹提示（有意为之的行为变化：后台会话断线 / 退出不再因为「看不见」而静默）。

### 四、保留的降级

- 无快照路径（旧后端 / 模拟器关停）**保留两步 resize 逼 pwd 的兜底**——常驻只减少重建路径，不消灭它们。

## 完成标准

- [x] `TerminalStack.tsx` 落地 + `TerminalPanel` / `TerminalView` 改造；`key={activeId}` 删除。
- [x] 挂载集合口径收敛纯函数 `terminal-residency.ts` 并单测（只挂载已访问、关闭会话后槽位消失、顺序按会话表）。
- [x] 变可见 refit、滚动位置还原、焦点请求序号消费、隐藏会话状态提示、降级两步 resize 保留。
- [x] 前端单测：**15 条新用例**（含「来回切标签挂载次数恒为 1」、只挂载已访问会话、focusRequestId 不重复回填、降级路径不误触发）。
- [x] 门禁：前端 vitest **1041 passed**、typecheck 双零错、build 成功。

## 依赖

- 依赖 [[tasks/console-terminal-emulator/02-attach-snapshot-protocol.md|02 接入协议换代]]：常驻减少的是「切标签」这一条重建路径，其余路径（刷新 / Obsidian 往返 / 重连）仍要靠快照恢复，两者缺一不可。

## 进展（2026-11-19 交付）

- **交付**：`TerminalStack.tsx` 新文件；`TerminalPanel.tsx` 改为按会话发回填请求、维护已访问集合；`TerminalView.tsx` 增加 `active` / `focusRequestId` 入参与 `safeFit` / 滚动还原；新增 `src/lib/terminal-residency.ts`（纯函数）。
- **门禁**：前端 vitest **1041 passed / 0 failed**（常驻 15 条新用例）；typecheck 双零错；build 成功。
- **明确不做**：Obsidian tab 的卸载口径不改；已访问集合**不跨 Obsidian 往返保留**（组件重建即清零，各会话再点开时重走一次快照）。
- 约定口径已写进 [[conventions/console-frontend.md|控制台前端约定]]（「终端实例常驻」与「终端全屏与焦点回填」两节）。
