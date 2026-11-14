---
prd: prds/file-pane-obsidian.md
status: done
---
# 任务：文件窗格分屏骨架

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **依赖 03**（窗格定位要用会话 pwd）。

## 目标

把控制台终端区从「一块终端面板 + 一个全局文件抽屉」改成「**终端面板 + 分隔条 + 文件窗格**」的三段式，并把抽屉形态退役。

本任务只做**骨架与定位 / 导航骨架**，**不含文件预览**（预览在 05 轮）、**不含 Obsidian tab**（在 06 轮）。

### 要落地的口径

- **分屏**：左终端面板 + 中间**可拖拽分隔条**（终端面板有**最小宽度钳位**）+ 右文件窗格（默认宽约 **340px**）。
- **抽屉退役**：全局 `DrawerShell` 文件抽屉形态整体退役，工作区头部的「**文件**」按钮移除——抽屉入口不复存在。
- **折叠**：窗格折叠为右缘 **36px** 纯图标竖条，**不显示任何文字**，「展开」按钮在竖条**底部**（竖条上**只有**这一个按钮）；折叠态**前端本地记忆**，跨会话关闭 / 重开保持。
- **入口随会话**：窗格只在「**存在终端会话且激活的是终端 tab**」时存在；关闭全部会话 ⇒ 窗格整体消失、内容区显示空态（「**没有终端会话**」+ 新建会话入口）；重开会话后窗格恢复且**折叠态保持**。
- **定位 fallback 链**：会话 pwd → 沙箱工作目录（metadata `workdir`）→ 容器根目录 `/`。
- **无自动跟随**：shell 内 `cd` 时窗格**绝不联动**。
- **回跳按钮**：工具条上的准星按钮，tooltip「**跳转到终端当前目录：<路径>**」随 pwd 更新；已在目标目录时**禁用**；点击导航到目标。pwd 不可得时**禁用** + tooltip「**当前会话未上报工作目录**」。
- **导航**：列表点击目录行进目录；顶部**面包屑**逐级可点、**当前层纯文本**；**同路径导航强制重读**的既有约定继续适用。
- **全屏范围改造**：全屏按钮的全屏对象从「仅终端面板」改为「**tabs 条下方的整个内容区**」；全屏层内 **tabs 条保持可见**、可切 tab、可退出；仍为**纯 CSS fixed 覆盖**（**不得** `requestFullscreen` / `navigator.keyboard.lock`）；全屏状态**不入路由不入存储**，**换沙箱自动退出**。

## 涉及文件

- `apps/web/frontend/src/components/TerminalPanel.tsx`（及终端区相关组件）— 三段式布局 + 分隔条 + 折叠态
- `apps/web/frontend/src/components/workbench/FileBrowserPanel.tsx` — 由抽屉面板**改造**为窗格形态（面包屑 / 列表 / 回跳 / 折叠）
- `apps/web/frontend/src/components/workbench/` — 移除工作区头部的「文件」按钮与抽屉挂载点
- `apps/web/frontend/src/lib/`（新增或复用）— 折叠态存取、窗格定位 fallback 链、分隔条宽度钳位等纯函数 + 单测
- `apps/web/frontend/README.md` — 标识表登记新标识 / 退役旧标识

## 完成标准

- [x] 终端区呈**三段式**：左终端面板 + 中间可拖拽分隔条 + 右文件窗格；文件窗格默认宽约 **340px**，终端面板有**最小宽度钳位**（对应 PRD 验收项 **FP-01**）。
- [x] 全局文件抽屉**退役**：工作区头部**不再有「文件」按钮**，抽屉入口在全应用范围内**不复存在**（对应 PRD 验收项 **FP-02**）。
- [x] 窗格可折叠为右缘 **36px** 纯图标竖条，**无任何文字**、**只有底部的展开按钮**；折叠态**前端本地记忆**且**跨会话关闭 / 重开保持**（对应 PRD 验收项 **FP-03**）。
- [x] 窗格**只在「存在终端会话且激活的是终端 tab」时存在**；激活 Obsidian tab 或无会话时**不出现**；关闭全部会话 ⇒ 窗格**整体消失** + 内容区显示空态（「**没有终端会话**」+ 新建会话入口），点该入口新建会话后窗格恢复且**折叠态与关闭前一致**（对应 PRD 验收项 **FP-04**；Obsidian tab 本体在 06 轮）。
- [x] 窗格定位按 **会话 pwd → metadata `workdir` → `/`** 的 fallback 链取第一个可得的起点（对应 PRD 验收项 **FP-05**）。
- [x] **无自动跟随**：会话里 `cd` 后窗格目录**不发生任何变化**（对应 PRD 验收项 **FP-06**）。
- [x] 回跳按钮的 tooltip 为「**跳转到终端当前目录：<路径>**」且随 pwd 更新；已在目标目录时**禁用**；可点击时点击即导航（对应 PRD 验收项 **FP-07**）。
- [x] 会话**不上报工作目录**时回跳按钮**禁用**、tooltip 为「**当前会话未上报工作目录**」，窗格**维持 fallback 起点**（对应 PRD 验收项 **FP-07**）。
- [x] 列表点击目录行切换目录；**面包屑逐级可点、当前层纯文本**；**同路径导航强制重读**的既有约定继续生效（对应 PRD 验收项 **FP-08**）。
- [x] 全屏对象是 **tabs 条下方的整个内容区**（终端 tab 激活时含文件窗格）；全屏层内 tabs 条可见、可切 tab、可退出；**未使用** `requestFullscreen` / `navigator.keyboard.lock`；全屏**不入路由不入存储**、**换沙箱自动退出**（对应 PRD 验收项 **FS-01** / **FS-02**）。

## 依赖

- 依赖 [[tasks/file-pane-obsidian/03-frontend-pwd-channel.md|03 前端 pwd 通道]]（窗格定位与回跳都要用会话 pwd）。
- 与 [[tasks/file-pane-obsidian/02-image-ps1-injection.md|02 镜像注入]] **无强依赖**（02 只影响真沙箱能不能收到上报）。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。

## 进展（2026-11-13 收口）

> **轮次说明**：本任务**前一半由上一个 agent 完成**（三段式分屏 / 窗格改造 / 折叠 / fallback / 回跳 / 全屏 / 单测，工作树里是未提交改动），该 agent 中途中断；**本次续作先盘点现状、再补缺口收尾**，未推倒重来。
> **范围**：只动 `apps/web/frontend/`（源码 + 测试 + README 标识表）与本任务文件；`base-image/` / `apps/core/` / `apps/web/backend/` **零改动**；**不引入新依赖**；**未 `git commit`**。

### 一、接手盘点（哪些已就绪 / 哪些缺口）

**已就绪（上一个 agent 的成果，本次复核后保留）**

| 面 | 现状 |
|---|---|
| 三段式分屏 | `TerminalPanel.tsx` 已是「左终端 + 中分隔条 + 右窗格」，窗格默认 340px、可拖拽（指针 + ←/→ 方向键）、终端最小宽度 320px 钳位；钳位纯逻辑在 `src/lib/file-pane.ts` |
| 抽屉退役 | `WorkspaceHeader.tsx` 的「文件」按钮已删；`Workbench.tsx` 不再挂 `FileBrowserPanel` 抽屉，`filesOpen` 状态与 `onOpenFiles` 一并移除；`DrawerShell.tsx` **保留**，仍被新建沙箱 / 沙箱详情 / 设置三个抽屉使用 |
| 折叠 | 右缘 36px 纯图标竖条（竖条上只有底部一个展开按钮、无文字）；折叠态存取在 `src/lib/file-pane-collapsed.ts`（localStorage） |
| 入口随会话 + 空态 | `shouldShowFilePane`（存在会话 **且** 激活终端 tab）；无会话时窗格整体消失，内容区给「没有终端会话」空态 + 新建会话入口 |
| 定位 / 无跟随 / 回跳 | fallback 链（会话 pwd → 沙箱 workdir → `/`）在 `resolveFilePaneStartPath`；`FileBrowserPanel.tsx` 只在用户未导航过时定位一次；回跳准星按钮与两套禁用 tooltip 齐备 |
| 面包屑 | 逐级可点、当前层纯文本；`applyPath` 同路径强制重读 |
| 全屏 | 面板 `fixed inset-0 z-40`（tabs 条在全屏层内），无 `requestFullscreen` / `navigator.keyboard.lock`，状态只在本地、换沙箱退出 |
| 测试 | 交接时 46 个测试文件 / 754 条用例全绿；`tsc` 双零；`vite build` 通过 |

**缺口（本次补完）**

1. **前端 `README.md` 标识表没有登记 / 退役**（04「涉及文件」明确要求）：新标识未入表、`page-sandbox-detail-files-button` / `page-file-browser-dialog` 仍挂在表上（且 `page-file-browser-dialog` 已无实现）；
2. **会话切换的 pwd 状态未按会话键控**：`sessionPwd` 是单一字符串 state，换会话那一提交里 state 里仍是上一个会话的 pwd（现有 effect 依赖恰好掩盖了它，但这是脆的），本次加固为「pwd 状态连会话标识一起存」；
3. **缺三条回归用例**：折叠态跨「关掉全部会话 → 新建」、换会话重新定位、换沙箱自动退出全屏；
4. **本任务文件没有进展节**，完成标准未勾、`status` 仍是 `todo`；
5. **e2e 用例未跟上**（合理留给 08，见第六节）：`tests/specs/12-file-transfer.spec.ts` 仍按抽屉形态定位已退役标识。

### 二、布局结构

```
<section page-sandbox-detail-terminal-panel>          ← 全屏时整块 fixed inset-0 z-40
  <TerminalTabs/>                                      ← tabs 条（全屏层内保持可见、可切、可退）
  <div 内容区 (p-4, flex-col)>                          ← 全屏对象 = 这一整块
    [重试连接按钮（仅连接失败时）]
    <div page-terminal-split>                          ← 三段式：flex 行
      <div page-terminal-split-terminal>               ← 左：flex-1，minWidth = 320px
         <TerminalView/> | 空态（没有终端会话 + 新建会话）
      <div page-terminal-split-handle/>                ← 中：w-1.5，role=separator（折叠态不渲染）
      <div page-file-pane style={{width}}>             ← 右：340px（折叠态 36px）
         <FileBrowserPanel/>
      </div>
    </div>
  </div>
</section>
```

- 窗格宽度是**本次挂载内的本地 state**（不入存储）；**只有折叠态**持久化（PRD 只要求折叠态跨会话保持）。
- 折叠态下不渲染分隔条（竖条上只有展开按钮，没有可拖的东西）。

### 三、实现要点（文件:行）

| 口径 | 位置 | 要点 |
|---|---|---|
| 窗格默认宽 / 折叠宽 / 钳位常量 | `src/lib/file-pane.ts:24-37` | 340 / 36 / 最小 240 / 最大 720 / 终端最小 320（px） |
| 宽度钳位 | `src/lib/file-pane.ts:64`（`clampFilePaneWidth`）、`:102`（`filePaneWidthFromDrag`） | 上限 = `min(720, 容器宽 − 终端最小宽)`；容器窄到装不下「最小窗格 + 最小终端」时终端保底；拿不到容器宽时只用窗格自身的上下限；结果取整像素 |
| 定位 fallback 链 | `src/lib/file-pane.ts:139`（`resolveFilePaneStartPath`） | 候选依次为 pwd / workdir，须过 `normalizeContainerPath`（绝对路径、拒 NUL、拒 `.`/`..`），都不行兜底 `/` |
| 入口条件 | `src/lib/file-pane.ts:187`（`shouldShowFilePane`） | 仅 `tabKind === 'terminal' && hasActiveSession`；`WorkspaceTabKind` 已预留 `'obsidian'` 供 06 轮 |
| 窗格宽 / 折叠接线 | `TerminalPanel.tsx:158-160` | `paneWidth` 本地 state；`useFilePaneCollapsed()` 供折叠态 |
| 分隔条拖拽 | `TerminalPanel.tsx:549-607` | 按下记起点 + `setPointerCapture`；移动用起点算（不累加漂移）；松手 / `pointercancel` 收口；键盘 ←/→ 每次 16px |
| 三段式渲染 | `TerminalPanel.tsx:641`（内容区）、`:655-658`（分屏容器）、`:665`（左终端）、`:719-733`（分隔条）、`:740-757`（右窗格） | 终端面板 `minWidth: 320`；窗格 `flex-none` + 内联 width |
| 空态 | `TerminalPanel.tsx:679-707` | 「没有终端会话」+「新建会话」入口（`sandboxRunning=false` 时禁用并给 title） |
| 全屏 | `TerminalPanel.tsx:131`（state）、`:267-269`（换沙箱退出）、`:613-622`（fixed 类）、`:624-635`（tabs 条在层内） | 纯 CSS `fixed inset-0 z-40`；不使用 `requestFullscreen` / `navigator.keyboard.lock`（全仓命中 0）；不入路由 / 存储 |
| 折叠竖条 | `FileBrowserPanel.tsx:1151-1170` | 36px、`border-l`、`justify-end`（按钮贴底）、**只有一个按钮、零文字**；展开 = `onToggleCollapsed` |
| 折叠态存取 | `src/lib/file-pane-collapsed.ts:17`（键）、`:38` / `:58`（读 / 写）、`:90`（Hook） | 键 `sandbox-console-file-pane-collapsed`，存 `'1'` / `'0'`；非法值与读取失败回落**展开**；挂载不写存储；`toggle` 用 ref 对齐（同帧连点不重复算同值） |
| 定位 / 无自动跟随 | `FileBrowserPanel.tsx:246-250`（pwd 状态按会话键控）、`:331-343`（订阅）、`:390-399`（首次定位）、`:409-418`（pwd 迟到补定位一次） | 定位只在「用户未导航过」且「尚未被 pwd 定位过」时发生；之后 pwd 再变不联动（`userNavigatedRef` / `pwdPositionedRef`） |
| 回跳按钮 | `FileBrowserPanel.tsx:1126-1142`（口径）、`:1346-1356`（渲染） | tooltip「跳转到终端当前目录：<路径>」随 pwd 订阅更新；`isSameContainerPath` 为真时禁用；pwd `null` 时禁用 + tooltip「当前会话未上报工作目录」；禁用按钮外包一层带 `title` 的 span（Firefox 对 disabled 控件不弹 title）；点击走 `applyPath(..., { userInitiated: true })`（同路径也强制重读） |
| 导航 / 面包屑 | `FileBrowserPanel.tsx:361-375`（`applyPath`）、`:1178-1330`（面包屑与列表） | 同路径**直接调 `loadDirectory`**，不依赖同值 state 触发 effect；父级是链接样式按钮、当前层是 `span`（`aria-current="page"`） |

### 四、新增 / 退役的 `data-testid`

**新增**（已登记进 `apps/web/frontend/README.md` 标识表）：

- 分屏：`page-terminal-split` / `page-terminal-split-terminal` / `page-terminal-split-handle`
- 窗格：`page-file-pane` / `page-file-pane-content` / `page-file-pane-collapsed` / `page-file-pane-expand-button` / `page-file-pane-collapse-button` / `page-file-pane-jump-button`
- 空态：`page-sandbox-detail-terminal-empty-title` / `page-sandbox-detail-terminal-empty-create-button`

**沿用**（面板自身从抽屉时期继承、语义不变）：`page-file-browser-crumbs` / `-crumb` / `-crumb-ellipsis` / `-upload-button` / `-file-input` / `-list` / `-row*` / `-upload-row` / `-upload-progress` / `-upload-cancel-button` / `-download-progress` / `-overwrite-*` / `-loading` / `-empty` / `-error`。

**退役**（已写进 README「已退役的标识」）：`page-sandbox-detail-files-button`（头部「文件」按钮）、`page-file-browser-dialog`（抽屉容器）。

### 五、测试与门禁（2026-11-13 收口实测）

- `npx vitest run`：**46 个测试文件 / 757 条用例全绿**（接手基线 754 → 757：新增「折叠态跨会话」「换会话重新定位」「换沙箱自动退出全屏」三条）；
- `npx tsc --noEmit`：**零错**；
- `npx tsc --noEmit -p tests/tsconfig.json`：**零错**；
- `npx vite build`：**通过**（`chunk > 500 kB` 是既有提示，非本轮引入）；
- **已知噪声**：jsdom 下 xterm 探测 canvas 会打一条 `HTMLCanvasElement.prototype.getContext not implemented` 的 stderr（03 轮起就有），不影响断言与退出码。

本轮补的用例（`TerminalPanel.test.tsx`）：

- **折叠态跨会话**：先「没有终端会话」⇒ 窗格整体消失；点空态入口新建会话 ⇒ 窗格恢复且**仍是 36px 折叠竖条**；
- **换会话重新定位**：会话 A 有 pwd ⇒ 从 pwd 起读；切到会话 B（无 pwd）⇒ 走 workdir，回跳 tooltip 回到「当前会话未上报工作目录」（不残留 A 的路径）；
- **换沙箱自动退出全屏**：全屏后换沙箱，面板不再带 `fixed`。

### 六、e2e 说明（留 08 轮）

- **本轮不跑 e2e**：`tests/` 的 Playwright 套件需要**真实沙箱 + 宿主 Docker + 免密 sudo + 镜像代理 + 起后端与独立静态源**（`tests/README.md` 的「环境前提」），不是无外部依赖可直接运行的用例；本轮**不新跑**、也**不静默跳过**。
- **存量用例与退役形态冲突**：`tests/specs/12-file-transfer.spec.ts` 仍按**抽屉形态**编写——`page-sandbox-detail-files-button`（第 359、475、484 行）与 `page-file-browser-dialog`（第 360、771、933 行）已退役，该 spec 需在 **08 轮**随「文件窗格分屏 / 折叠 / 空态」新用例一起改写；本轮**不改 e2e**（04 的涉及文件不含 `tests/`，e2e 归 08 的验收口径）。
- **pwd 真机链路**：03 轮遗留的「浏览器端端到端复验」要等**存量沙箱重建到 `base:0.3.1`**（02 轮登记的外部前置）+ 本轮的窗格落地，才有可点的界面；真机复验同样归 08 / 用户验收。

### 七、落盘清单

| 文件 | 变更 |
|---|---|
| `apps/web/frontend/src/components/TerminalPanel.tsx` | 三段式分屏（分隔条拖拽 / 键盘调宽 / 窗口宽度钳位）、折叠态接线、入口条件与空态、全屏对象改为 tabs 条下方整块内容区 |
| `apps/web/frontend/src/components/workbench/FileBrowserPanel.tsx` | 抽屉 → 窗格：折叠竖条、回跳准星、pwd 状态按会话键控、定位只在用户未导航过时做一次 |
| `apps/web/frontend/src/lib/file-pane.ts`（新增） | 宽度钳位 / 拖拽换算 / 定位 fallback 链 / 同路径判定 / 入口条件 |
| `apps/web/frontend/src/lib/file-pane-collapsed.ts`（新增） | 折叠态 localStorage 存取 + Hook |
| `apps/web/frontend/src/components/workbench/Workbench.tsx` | 移除文件抽屉挂载与 `filesOpen`；把 `sandboxWorkdir` / `desktop` 交给 `TerminalPanel` |
| `apps/web/frontend/src/components/workbench/WorkspaceHeader.tsx` | 移除「文件」按钮与 `onOpenFiles` |
| `apps/web/frontend/src/components/TerminalPanel.test.tsx` | 三段式 / 折叠 / 空态 / 拖拽 / 键盘 / 全屏 + 本轮三条回归 |
| `apps/web/frontend/src/components/workbench/FileBrowserPanel.test.tsx` | 窗格形态重写（折叠 / 回跳 / fallback / 无自动跟随 / 卸载收口） |
| `apps/web/frontend/src/lib/file-pane.test.ts` / `file-pane-collapsed.test.ts`（新增） | 纯逻辑单测（25 + 8 条） |
| `apps/web/frontend/src/components/workbench/Workbench.test.tsx` | 抽屉退役断言 + 窗格出现 / 空态 |
| `apps/web/frontend/README.md` | 标识表登记新标识、退役 `page-sandbox-detail-files-button` / `page-file-browser-dialog`；目录结构与全屏口径同步 |
| `docs/tasks/file-pane-obsidian/04-file-pane-split.md` | 本进展节；完成标准 10 条勾选；`status: done` |

**docs 只动了本文件**（其余 docs 的未提交改动是 02 / 03 轮的收口内容，本轮不碰）；**未 `git commit`**。

## 进展（审查修复，2026-11-13）

> **前情**：本任务已按「2026-11-13 收口」交付；审查又确认了 4 个遗留问题。本次在**现有未提交改动基础上继续修**，不回退、不 `git commit`。
> **范围**：只动 `TerminalPanel.tsx`（+测试）、`FileBrowserPanel.tsx`（+测试）与本任务文件；`base-image/` / `apps/core/` / `apps/web/backend/` / 其它 docs **零改动**。

### 一、换会话 / 换沙箱瞬间的陈旧列表（真回归）

- **主修**：`TerminalPanel` 渲染 `<FileBrowserPanel key={`${sandboxName}:${activeId ?? 'none'}`}>`，按「沙箱:会话」**强制重挂载**。`path` / `entries` / `userNavigatedRef` / `pwdPositionedRef` 等内部状态随之归零；折叠态与窗格宽度在父组件持有，**不受重挂载影响**。
- **兜底**：`FileBrowserPanel` 的换沙箱复位 effect 从「只清传输」补回 `setEntries([])`，并同步清 `listTrustedRef` / `listPathRef`——即使有人直接改 `sandbox` prop（不经 key），旧沙箱的行也不会挂到新沙箱的慢查询返回为止。传输收口（上传 / 下载 / 队列 / 确认框）保持不变。
- **回归用例**：`FileBrowserPanel.test.tsx` 新增「换沙箱（同起点 `/`）：旧沙箱的行立即清空，新沙箱慢查询返回前绝不残留」——用挂住的新列表请求钉住「立即为空」，再放行并确认只出现新沙箱条目。

### 二、回跳按钮首帧闪烁

- `pwdState` 初值改为 **`useState` 惰性初始化时同步读缓存**（`getSessionPwd(sessionId)`）；换会话的 pwd 同步改到 **`useLayoutEffect`**（值没变就返回原 state，不额外渲染），pwd 订阅仍留在 `useEffect`。
- 效果：pwd 已缓存时，挂载 / 换会话**首帧**就是正确 tooltip，不再先闪一帧「当前会话未上报工作目录」。
- 用例：`FileBrowserPanel.test.tsx` 新增「pwd 已缓存：挂载首帧就显示回跳目标（不先闪「未上报」）」。

### 三、分隔条 a11y

- 可聚焦分隔条补 `aria-valuemin={FILE_PANE_MIN_WIDTH_PX}`（240px，窗格最小宽）与 `aria-valuemax={paneMaxWidth}`。
- `paneMaxWidth` **直接问钳位函数要实际上限**：`clampFilePaneWidth(Number.MAX_SAFE_INTEGER, { containerWidth, minTerminalWidth: 320 })` ⇒ `min(720, 容器宽 − 320)`；容器宽拿不到时为 720。容器宽在渲染期活读，拖动 / 键盘调宽后的重渲染会更新上限。
- 用例：既有三分屏用例补 `aria-valuemin=240` / `aria-valuemax=720` / `aria-valuenow=340`；新增「容器宽 900 ⇒ `aria-valuemax=580`」验证上限跟钳位函数走。

### 四、换会话语义（用户导航状态复位）

- 新增用例（`FileBrowserPanel.test.tsx` + `TerminalPanel.test.tsx` 各一条）：**会话 A 里导航到子目录后切到会话 B**，窗格必须落 **B 的 fallback 起点（workdir）**，绝不留在 A 里用户去的目录；切换后的请求里也不出现 A 的子目录路径。
- 锁住 `userNavigatedRef` / `pwdPositionedRef` 随会话复位的语义；终端面板侧同时验证 key 重挂载后的真实集成路径。

### 五、明确不做（本轮依据）

- **窄窗口 ResizeObserver 钳位**：不做。依据是 PRD 的非目标「窄窗口适配不做」；本次只为 `aria-valuemax` 在渲染期读取容器宽，**没有新增 ResizeObserver / resize 监听 / 自动钳位**。
- **复位 effect 依赖顺序重构**：不做。现有 effect 的声明顺序已有注释锚定（pwd 同步 → 会话复位 → 定位），本次只补状态清理，不动依赖顺序。

### 六、最终门禁（本次修复后实测）

- `npx vitest run`：**46 个测试文件 / 762 条用例全绿**（修复前基线 757；本轮新增 5 条：换沙箱陈旧列表、换会话导航复位（面板）、换会话导航复位（终端面板）、回跳首帧、`aria-valuemax` 动态上限；另在既有三分屏用例补了 `aria-valuemin` / `aria-valuemax` / `aria-valuenow` 断言）。
- `npx tsc --noEmit`：**零错**。
- `npx tsc --noEmit -p tests/tsconfig.json`：**零错**。
- jsdom 下 xterm 的 `HTMLCanvasElement.prototype.getContext not implemented` 仍是既有噪声，不影响断言与退出码。
- **未 `git commit`**。

### 七、本次落盘清单

| 文件 | 变更 |
|---|---|
| `apps/web/frontend/src/components/TerminalPanel.tsx` | 窗格按 `sandbox:session` key 强制重挂载；分隔条补 `aria-valuemin` / 动态 `aria-valuemax` |
| `apps/web/frontend/src/components/TerminalPanel.test.tsx` | 三分屏 a11y 断言；`aria-valuemax` 动态上限；换会话导航复位集成用例 |
| `apps/web/frontend/src/components/workbench/FileBrowserPanel.tsx` | pwd 初值同步读缓存 + `useLayoutEffect` 换会话同步；换沙箱复位补 `entries` / 列表可信标记清理 |
| `apps/web/frontend/src/components/workbench/FileBrowserPanel.test.tsx` | 换沙箱同起点陈旧列表回归；换会话导航复位；回跳首帧；清理 `sess-2` pwd 缓存 |
| `docs/tasks/file-pane-obsidian/04-file-pane-split.md` | 本「审查修复」小节 |
