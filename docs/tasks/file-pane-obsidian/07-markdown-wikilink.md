---
prd: prds/file-pane-obsidian.md
status: done
---
# 任务：markdown 渲染与 wikilink 跳转

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **依赖 06**（Obsidian 骨架与 vault 树先落地）。

## 目标

把 Obsidian tab 的右栏从「占位区」做成**真正的阅读器**：**markdown 渲染**为主视图 + **wikilink 正向跳转**。

### 要落地的口径

- **渲染库**：以 **react-markdown** 为基座（其默认**不放行原始 HTML**）；任务列表等 GFM 语法按需引入配套插件。
- **工具条**：**返回**（历史栈）+ 文件名 / 大小 + 「**渲染 / 源码**」**分段切换** + **复制**。
- **渲染态**：内容列 **max-width 约 620px** 居中；标题层级、**深底代码块**、列表、**任务列表（静态不可勾）**、引用块、行内码、粗体。
- **frontmatter**（`---` 包裹的 YAML）**渲染态隐藏、源码态可见**。
- **wikilink**：支持 `\[\[目标\]\]` / `\[\[目标|别名\]\]` / `\[\[#标题\]\]`；样式 **强调色 + 虚线下划线**；hover 显示**黑色小 tooltip**（内容是**解析后的目标路径**，须**防视口裁切**）。
- **解析兜底顺序**：① 同目录 → ② vault 根相对路径 → ③ **全库递归同名匹配**（递归列举**带 exec 看门狗超时**）；解析结果**过 `normalizeContainerPath`**。
- **点击**：存在 ⇒ **沿预览历史栈推入**目标渲染视图；不存在 ⇒ 正文**顶部就地**浅红错误条「**链接目标不存在：<名>**」，**可手动关闭**、**不跳转、不弹 toast**。
- **复制**：**渲染态复制 markdown 源文**、**源码态复制原文**；对勾动画与成功零反馈口径同文件窗格预览。
- **大文件（>2 MB）**：与**文件窗格预览同口径**——**复用 05 轮的二次确认对话框与进度条组件**，行为一致：**确认才发起读取**、**取消不发起请求**、确认后**进度条加载并渲染全文**（**不截断**、**无「文件过大」提示条**）；两处预览**共用同一条只读端点**。

### 解析逻辑必须纯函数化

wikilink 解析（语法切分 + 三级兜底 + 归一）是**纯逻辑**，收敛在 `src/lib/` 下并配**单元测试**：语法变体逐条钉死、兜底顺序逐条钉死、**全库递归同名匹配带 exec 看门狗超时**（超时按「未找到」处理，不挂死）。

## 涉及文件

- 前端依赖 — 引入 markdown 渲染库（**react-markdown 及其 GFM 插件**）
- `apps/web/frontend/src/components/workbench/`（Obsidian 视图组件）— 渲染 / 源码双态、frontmatter 处理、wikilink 渲染与点击、tooltip、错误条、复制
- `apps/web/frontend/src/lib/`（新增）— wikilink 解析纯函数 + 单元测试
- `apps/web/frontend/src/api/client.ts` — 复用 05 轮落地的只读端点与目录列举能力
- `apps/web/frontend/README.md` — 标识表登记

## 完成标准

- [x] 预览以 **markdown 渲染**为主视图；工具条 = **返回**（历史栈）+ 文件名 / 大小 + 「**渲染 / 源码**」**分段切换** + **复制**（**渲染态复制 markdown 源文**、**源码态复制原文**；对勾动画与成功零反馈口径同文件窗格预览）（对应 PRD 验收项 **OBS-06**）。
- [x] 渲染态：内容列 **max-width 约 620px** 居中，标题层级、**深底代码块**、列表、**任务列表（静态不可勾）**、引用块、行内码、粗体均正确呈现；**frontmatter 渲染态隐藏、源码态可见**；渲染器**不放行原始 HTML**（`<script>` 一类不执行、不渲染为标签）（对应 PRD 验收项 **OBS-07**）。
- [x] wikilink 支持 `\[\[目标\]\]` / `\[\[目标|别名\]\]` / `\[\[#标题\]\]`；样式为**强调色 + 虚线下划线**；hover 显示**黑色小 tooltip**（内容为**解析后的目标路径**），且**靠近视口边缘不被裁切**（对应 PRD 验收项 **OBS-08**）。
- [x] 解析兜底顺序为 **同目录 → vault 根相对路径 → 全库递归同名匹配**（递归列举**带 exec 看门狗超时**）；解析结果**过 `normalizeContainerPath`**；**解析纯函数有单元测试**（对应 PRD 验收项 **OBS-09**）。
- [x] 点击**存在**的 wikilink 目标 ⇒ **沿预览历史栈推入**渲染视图（可沿返回键退回）；点击**不存在**的目标 ⇒ 正文**顶部就地**浅红错误条「**链接目标不存在：<名>**」，**可手动关闭**、**不跳转、不弹 toast**（对应 PRD 验收项 **OBS-10**）。
- [x] 复制：**渲染态复制 markdown 源文**、**源码态复制原文**；对勾动画与成功零反馈口径与文件窗格预览**一致**（对应 PRD 验收项 **OBS-06**）。
- [x] Obsidian 预览对 **>2 MB** 文件**复用 05 的二次确认 + 进度条组件**，与**文件窗格预览同口径**：**确认才发起读取**、取消不发起请求，确认后加载并渲染**全文**（**不截断**）（对应 PRD 验收项 **OBS-11**）。
- [x] 前端**标识表**登记新标识；门禁（vitest / typecheck / build）全绿。

## 依赖

- 依赖 [[tasks/file-pane-obsidian/06-obsidian-tab.md|06 Obsidian tab 骨架]]（双栏与 vault 树先落地）。
- 数据来源：[[tasks/file-pane-obsidian/05-file-preview.md|05 文件窗格文本预览]]的**只读端点**（markdown 正文读取与目录列举共用）。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。

## 进展（2026-11-14 收口）

> **范围**：`apps/web/frontend/`（新增 `ObsidianPreview.tsx` / `PreviewConfirmDialog.tsx` / `PreviewLoading.tsx` / `lib/wikilink.ts` / `lib/markdown.ts` / `lib/tooltip-position.ts`，改 `ObsidianWorkspace.tsx` / `lib/obsidian-vault.ts` / `FileBrowserPanel.tsx`（**只做抽取**）/ `README.md` / `package.json` / `pnpm-lock.yaml`）+ 本任务文件。
> **禁改清单遵守**：`TerminalPanel.tsx` / `TerminalTabs.tsx` / `api/client.ts` / `api/types.ts` / `lib/terminal-pwd.ts` / `lib/file-pane*.ts` / `apps/core/` / `apps/web/backend/` / `base-image/` **零改动**；`FileBrowserPanel` 的**行为与全部标识**一个没动（61 条既有测试原样通过）；**未 `git commit`**。
> **字体**：新增文案的汉字**全部已在** `scripts/fonts/charset.txt`（逐字核对 0 缺失），无需重跑 `build-fonts.sh`。
> **文档面**：只动本任务文件与 `apps/web/frontend/README.md`（标识表归本轮）；任务集 `README.md` / `current-state.md` 的 07 状态标记**留给 08 收口统一同步**（不改别人的领地）。

### 一、依赖（本轮唯一新增）

| 包 | 版本 | 用途 |
|---|---|---|
| `react-markdown` | **10.1.0**（`--save-exact`，与仓库既有「依赖全部钉死版本」一致） | markdown 渲染基座；**默认不放行原始 HTML**，**没有装 `rehype-raw`** |
| `remark-gfm` | **4.0.1**（`--save-exact`） | 表格 / 任务列表 / 删除线等 GFM 语法 |

- `pnpm-lock.yaml` +877 行（unified / mdast / hast 一整套传递依赖）。**没有再引其它包**；图标仍全是 lucide。
- 构建产物主 chunk 由 ~700 kB 涨到 **857.81 kB**（gzip 262.81 kB），>500 kB 提示是既有现象（react-markdown 链路带进来的），本轮**没做**代码分割（08 若在意可对 Obsidian 视图做 `React.lazy`）。
- **实测（jsdom）确认的原始 HTML 行为**：源码里的 `<script>…</script>` 被**转义成文本**（`&lt;script&gt;`），既不渲染成标签也不执行——测试断言 `querySelector('script') === null` 且 `window.__pwn` 未定义。

### 二、05 / 07 共用的两个组件（抽取形态）

两个组件都放 `src/components/workbench/`，**props 带 `testId` 覆盖点，默认值就是 05 的那一套**——所以 `FileBrowserPanel` 换用之后**标识与行为一字未变**（61 条测试原样过）。

| 组件 | 职责 | 默认标识（05） | Obsidian 传入（07） |
|---|---|---|---|
| `PreviewConfirmDialog.tsx` | 大文件（>2 MB）二次确认（`ModalShell` + 固定文案「「<名>」超过 2 MB（<大小>），确认预览？」；**确认才读、取消不发请求**由调用方实现） | `page-file-preview-confirm-dialog` / `-confirm-button` / `-confirm-cancel-button` | `page-sandbox-detail-obsidian-preview-confirm-dialog` / `-confirm-button` / `-confirm-cancel-button` |
| `PreviewLoading.tsx` | 加载态：**小文件**一行「正在读取…」；**大文件**进度条（`transferPercent(loaded, total)`，`role="progressbar"` + `aria-label=读取 <名>`） | `page-file-preview-loading` / `page-file-preview-progress` | `page-sandbox-detail-obsidian-preview-loading` / `-preview-progress` |

- 抽取是**纯搬运**：`FileBrowserPanel.tsx` 的两段内联 JSX 换成组件调用（-79 / +22 行），`percent` 的计算挪进 `PreviewLoading`，其余（小文件无进度条、大文件 `flex-none` 等）逐字保留。
- 读取逻辑**没有**抽成 hook：两处的「读 → 二进制 / 非 UTF-8 / 中断」分派各自十来行，抽 hook 反而要把 05 的 `PreviewView` 形状也搬出来；口径靠「都走 `api.readFile` + 同一套错误类」保证一致。
- 大文件闸门统一在 `ObsidianWorkspace`：**树里点文件**与 **wikilink 命中**都先过 `openFile()`（`isLargePreviewFile(size)` ⇒ 弹确认），`ObsidianPreview` 拿到的 `target` 一定是「已确认」的，它只负责读与画。

### 三、wikilink 解析 API（`src/lib/wikilink.ts`）

```ts
// 语法层
parseWikilink(inner: string): WikilinkParts | null      // {raw, target, alias, heading, display}
splitWikilinkSegments(text: string): WikilinkSegment[]  // [{kind:'text',text} | {kind:'wikilink',link}]
collectWikilinks(text: string): WikilinkParts[]
wikilinkFileCandidates(target: string): string[]        // [目标, 目标.md]（去重保序）

// 解析层（纯函数 + 全注入）
createWikilinkResolver(deps: WikilinkResolverDeps): WikilinkResolver
type WikilinkResolverDeps = {
  list: (dir: string) => Promise<FileListEntry[]>;  // 组件层传 (dir) => api.listFiles(sandbox, dir)
  timeoutMs?: number;                               // 默认 WIKILINK_WATCHDOG_MS = 5000
  now?: () => number;                               // 默认 Date.now
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};
interface WikilinkResolver {
  resolve(link: WikilinkParts, ctx: {currentPath: string; root: string}): Promise<WikilinkResolution>;
  invalidate(): void;                               // 清跨次解析的目录缓存（换根 / 换沙箱）
}
type WikilinkResolution =
  | {status: 'found'; path: string; name: string; size: number}   // path 已过 normalizeContainerPath
  | {status: 'missing'; reason: 'not-found' | 'timeout'};         // 超时按「未找到」处理
```

**兜底顺序（PRD 明令，单测逐条钉死）**

1. **同目录**：`parent(currentPath)` 里按候选名找 `kind === 'file'`（**只认 `.md`**）；
2. **vault 根相对**：`root + 目标路径`（目标里可带子目录段 `a/b`），逐段过 `vaultChildPath` 后列父目录找同名文件；候选名先原样、再补 `.md`；
3. **全库递归同名匹配**：从 `root` **BFS**（层序，目录按名字自然序入队），按**文件名**（最后一段 + 候选名）匹配；每层先找文件、再排子目录。

**其它定死的口径**

- `[[#标题]]` ⇒ **当前文件自身**（`found` + 当前路径，`size` 记 0）；`[[目标#标题]]` 标题段只保留、不参与匹配（本轮不做滚动定位）。
- **别名只作显示**（`display = alias ?? target ?? #heading`）。
- `..` / `.` 段、相对根、NUL **一律直接 missing**（不发起列举）；候选与结果都过 `normalizeContainerPath`，命中后还要 `isPathWithinVaultRoot` 复检，**逃不出 vault**。
- **看门狗**：每次 `resolve` 有自己的预算；每步列举前查一次剩余时间，并把列举 `Promise.race` 进剩余预算（`setTimer` 注入），**预算耗尽 / 列举不返回 ⇒ `{missing, reason:'timeout'}`**，绝不挂死。
- **目录读失败当空目录**（不打断兜底链）；**目录列举按路径在 resolver 内缓存**（多条链接共用，`invalidate()` 清）。
- 已知取舍：resolver 的缓存与 vault 树的 `dirs` 缓存**各自独立**（同一目录最多各列一次）；全库 BFS 在前几层就命中时只发 1~3 个请求，真·缺失才会扫全库（受 5 秒预算约束）。

### 四、frontmatter（`src/lib/markdown.ts`）

- `splitFrontmatter(text) → {frontmatter: string | null, body: string}`：**必须文件第一个字符就是 `---`**、首行**整行**是 `---`（`----` / `--- title` 都不算）、**必须找到闭合围栏**（否则按「没有 frontmatter」处理，正文原样返回）；允许 CRLF 与行尾空白，BOM 先剥掉；`frontmatter` 含两条围栏、不含尾部换行与 CR。
- `markdownBodyForRender(text)`：剥 frontmatter + 去掉正文开头空行（渲染态用）。源码态直接显示 `view.text`（原文，frontmatter 可见）。

### 五、tooltip 定位（`src/lib/tooltip-position.ts`）

```ts
computeTooltipPosition(anchor: TooltipRect, tooltip: TooltipViewport, viewport: TooltipViewport,
                       opts?: {gap?: number /*6*/; margin?: number /*8*/})
  → {left: number; top: number; placement: 'top' | 'bottom'}
```

- **上方优先**（`anchor.top - gap - height`）；上方越过上留白 ⇒ **翻转到下方**；上下都放不下（视口太矮 / 浮层太高）⇒ **竖向钳进视口**（宁可压住锚点也不出视口）。
- **水平居中于锚点**后钳进 `[margin, viewport.width - margin - width]`（贴左 / 贴右都不裁切）；浮层比视口还宽时贴左留白，**不出现负坐标**；尺寸未知（0）或 NaN 也不抛错。
- 组件侧：tooltip `position: fixed` + **portal 到 `document.body`**（避开 `overflow-hidden` 祖先的裁切），首帧按 0 尺寸算、`useLayoutEffect` 量到真实宽高后重算一次；黑底用终端恒定深色令牌（`bg-terminal-bg` / `text-terminal-fg`），`pointer-events-none`。

### 六、组件与状态流

```
ObsidianWorkspace（06 的双栏骨架）
  ├─ 左栏 vault 树（不变）
  └─ 右栏 page-sandbox-detail-obsidian-preview（data-selected-path = 栈顶路径）
       ├─ 未选中 → page-sandbox-detail-obsidian-preview-empty（「从左侧选择文件」）
       ├─ 「更改」→ 引导态
       └─ 选中 → <ObsidianPreview sandbox root target canGoBack onBack onOpenTarget>
                  工具条：返回? · 文件名 · 大小 · [渲染 | 源码] · 复制
                  错误条：链接目标不存在：<名> ×（浅红，就地）
                  正文：620px 居中（渲染 markdown | 源码原文）
                  tooltip（portal 到 body）
       └─ PreviewConfirmDialog（大文件二次确认；与 05 共用组件）
```

- **历史栈**：`ObsidianWorkspace` 持有 `stack: VaultSelectedFile[]`，栈顶 = 右栏在读的文件 = 树里高亮的那一行（`data-active`）。
  - **树里点文件** ⇒ 重置栈（新的一次阅读）；**wikilink 命中** ⇒ **压栈**；**返回钮** ⇒ 弹一层；**栈只有一层时不渲染返回钮**。
  - `[[#标题]]` / 解析回当前路径 ⇒ **不压栈**（否则返回键原地踏步）。
- **渲染 / 源码**：每个文件打开时回到**渲染态**（渲染是主视图）。
- **复制**：两态复制的都是 `view.text`——即**这个文件的 markdown 源文**（不是渲染后的纯文本）；渲染态只是**不显示** frontmatter，不改变复制内容。成功零 toast（对勾 1 秒）、失败才 toast（来源 `obsidian`）。
- **错误条**：只有「点击 wikilink 未命中」才出现；**不跳转、不弹 toast**、点 × 关闭；换文件自动清。
- **读取**：`api.readFile(sandbox, target.path, {maxBytes: target.size > 0 ? target.size : null, onProgress, signal})`；`binary` ⇒「二进制文件无法预览」空态；`TextNotPreviewableError` ⇒ 同款「无法展示」空态；其它（含 `IncompleteReadError`）⇒ 就地 `role="alert"` 错误态；换文件 / 卸载 `abort`。
- **阅读位持久化（任务第 7 条「可选评估项」结论：做了「选中态」，没做「dirs 缓存」）**：
  - 存储键 `sandbox-console-obsidian-selected:<沙箱>`（JSON `{path,name,size}`，`readStoredSelection` / `writeStoredSelection`，脏值一律回落「没记过」）；挂载时若根已设、路径在根内且**不是大文件**就恢复到栈上——**大文件不自动恢复**，避免绕过「> 2 MB 先二次确认」。
  - **不做**「把选中态 / dirs 提升到 `TerminalPanel`」：那要改 `TerminalPanel.tsx` 的二选一渲染分支与它 06 的测试（`queryByTestId('page-sandbox-detail-obsidian') === null` 钉着），超出本轮改动面；**dirs 缓存仍不持久化**（回到 tab 后按需重新懒展开）。**已知取舍，记在此处**。
- **退役标识**：`page-sandbox-detail-obsidian-preview-placeholder`（06 的「显示路径」占位）由阅读器取代，已登记进 `README.md` 的退役清单（**名字不得复用**）。

### 七、测试清单（本轮新增 **71 条**）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `src/lib/wikilink.test.ts` | **27** | 三条语法 + 空白 / 空别名 / 空内文 / 未闭合 / 嵌套括号 / 跨行；切分与 `collectWikilinks`；**兜底顺序逐条**（①命中就不再列根、②含子目录、③BFS 层序取先遇到的那份、同名多处）、`[[#标题]]` 自身、别名不影响解析、带 / 不带 `.md`、多斜杠归一、`..` 与相对根不解析、只解析 `.md`、目录缓存与 `invalidate`、**读失败当空目录**、**两条超时用例**（列举不返回 ⇒ 注入计时器立刻到点；预算在递归途中耗尽） |
| `src/lib/markdown.test.ts` | **11** | 标准 / 空 / 无 frontmatter / 不在开头 / 首行不是整行 / 未闭合 / CRLF + 行尾空白 / BOM / 正文里再出现 `---`；`markdownBodyForRender` 去开头空行 |
| `src/lib/tooltip-position.test.ts` | **9** | 上方居中、**越界翻转**、上下都放不下时的竖向钳位、左右边缘钳位、浮层比视口宽、尺寸为 0、自定义 gap/margin、NaN 不出 NaN 坐标 |
| `src/lib/obsidian-vault.test.ts` | **+4** | 阅读位：键按沙箱拼 / 路径归一后落盘 / 写 `null` 清键 / 脏值回落 / 存储不可用静默 |
| `src/components/workbench/ObsidianWorkspace.test.tsx` | **+20** | 工具条（返回钮栈底不渲染）、620px 居中列 + 标题层级 / 深底代码块 / 列表 / **静态不可勾任务列表** / 引用块 / 行内码 / 粗体、frontmatter 渲染态隐藏、**`<script>` 不渲染不执行**、源码态可见 frontmatter 且无渲染产物、复制（两态都复制源文 / 对勾 1 秒 / 成功零 toast / 失败 toast 带 `obsidian` 来源）、wikilink 样式与别名显示、**hover tooltip 内容 = 解析后路径 + `position: fixed`**、点击命中压栈 + 返回键退回、树上另点文件重置栈、未命中错误条（文案 / `role=alert` / 浅红 / 可关 / 不跳转 / 不弹 toast）、`[[#标题]]` 自指不压栈、**大文件四步**（弹框不发请求 → 取消不发 → 确认才读 + `maxBytes=size` → 进度 50% → 全文渲染且无「文件过大」）、**wikilink 命中大文件同样先确认再压栈**、小文件不弹框无进度条、非 UTF-8 空态、读取失败就地错误、**阅读位恢复 / 大文件不恢复 / 根外不恢复** |
| `src/components/workbench/FileBrowserPanel.test.tsx` | 0（61 条原样过） | 抽取后行为与标识零变化 |

### 八、门禁（实测）

| 门禁 | 结果 |
|---|---|
| `npx vitest run`（全量） | **52 个测试文件 / 917 条用例全绿**（接手基线 846，**本轮 +71**） |
| `npx tsc --noEmit` | **0 错误** |
| `npx tsc --noEmit -p tests/tsconfig.json` | **0 错误**（双零） |
| `npx vite build` | **通过**（主 chunk 857.81 kB / gzip 262.81 kB；仅既有 >500 kB 提示） |
| 字体字符集 | 新增文案汉字 **0 个缺失**（无需重跑 `build-fonts.sh`） |

### 九、给 08 轮（QA / e2e / 文档同步）的留档要点

1. **可用的 e2e 定位**：`README.md` 标识表新增的「Obsidian 阅读器」一行（06 的 26 个 + 07 的 21 个，其中 `-preview-placeholder` 已退役）。关键几个：
   - 打开阅读器：点 `page-sandbox-detail-obsidian-tree-file[data-path="…"]` → 等 `page-sandbox-detail-obsidian-preview-title`；
   - 双态切换：`-preview-mode-render` / `-preview-mode-source`（带 `aria-pressed`、`data-active`）；
   - wikilink：`-preview-wikilink[data-target="…"]`，命中后带 `data-status="found"` 与 `data-resolved-path`；tooltip 是 `-preview-wikilink-tooltip`（**portal 在 `document.body`**，`position: fixed`）；
   - 未命中错误条：`-preview-wikilink-error`（文案固定「链接目标不存在：<名>」）+ `-preview-wikilink-error-close-button`；
   - 大文件：`-preview-confirm-dialog` / `-preview-confirm-button` / `-preview-confirm-cancel-button` + `-preview-progress`（`role="progressbar"`，`aria-valuenow`）。
2. **e2e 要留意**：`api.readFile` 的 `max_bytes` 必须是列表条目的 `size`；大文件用例要**先断言未发请求**（取消路径）再断言进度与全文；`-preview-content` 的 620px 是类名（`max-w-[620px]` + `mx-auto`），e2e 里可断言 `boundingBox().width <= 620`（真实浏览器才有布局，jsdom 量不到）。
3. **本轮明确没做**（别按「已支持」写文档 / 写用例）：wikilink 的**标题滚动定位**（`#标题` 只解析文件，不滚到锚点）、**反向链接 / 图谱 / 标签 / 搜索**、`![[嵌入]]`、**树自动展开并滚到 wikilink 目标**、渲染态**代码高亮**（深底纯文本）、markdown 内相对链接 / 图片的解析（`<img>` 直接按原始 `src` 渲染，沙箱内路径浏览器取不到）。
4. **交互取舍**：hover tooltip 是**异步解析**出来的（同目录 / 根相对通常 1 个请求，真缺失会走全库 BFS，最多 5 秒后按「未找到」出 tooltip）；点击 wikilink 也会等这次解析。e2e 里对 tooltip 用「可见即断言」，不要写「hover 后立刻可见」。
5. **QA-01 的 e2e 主链路**建议按 PRD 原话组织：设根 → 展开树 → 点开一篇 → 渲染态断言标题 / 代码块 / 任务列表 → 点 wikilink 命中 → 返回键退回 → 点未命中链接 → 错误条可关且 URL / 选中路径未变。
6. **05 的回归**：`PreviewConfirmDialog` / `PreviewLoading` 已抽成共用组件（默认标识仍归 05），e2e 里文件窗格的大文件用例**不需要改**。

### 十、审查修复（2026-11-13）

> **落地日 2026-11-14**（`date` 核对；本节按审查批次日期命名）。改动面：`ObsidianPreview.tsx` + `ObsidianWorkspace.test.tsx` + 本节，**其它文件零改动**、**未 `git commit`**；在上一条未提交现状上继续改。

#### 逐条结论

| # | 审查结论 | 处置 | 落点 |
|---|---|---|---|
| 1 | **wikilink 点击代次守卫（真竞态，Warning）**：`activateLink` 里 `await ensureResolved(link)`（最长 5 秒）之后只查 `aliveRef`；用户点链接后、解析返回前在树上点了别的文件，旧点击的续体会把**旧目标压到新栈顶**，劫持导航 | **已修**：点击时快照 `linkGenerationRef.current`，`await` 后 `!aliveRef.current \|\| generation !== linkGenerationRef.current` 就整段作废（与 `ensureResolved` 内部 `.then` 的守卫同款） | `ObsidianPreview.tsx` → `activateLink` |
| 2 | **`em` 不过 wikilink 渲染**：`*[[目标]]*` 渲染成死文本（`**[[目标]]**` 可点） | **现状代码里 `em` 已经过 `withWikilinks`**（与 `a` / `strong` / `del` 对齐，未提交工作区即如此）；本轮**补用例把行为锁死**，并用「临时去掉 `withWikilinks`」的变异验证该用例确实会红（防将来回退） | `ObsidianPreview.tsx` → `markdownComponents.em` + 新用例 |
| 3 | **归一口径两份**：`isSameWikilinkTarget` 只有单测在用，组件里用裸 `===` 比路径 | **已修**：组件改调 `isSameWikilinkTarget(resolution.path, target.path)`，归一 / 比较口径只留 `src/lib/wikilink.ts` 一份 | `ObsidianPreview.tsx`（新增 import） |

#### 新增用例（+2 条：`ObsidianWorkspace.test.tsx` 20 → 22）

1. **「解析还没回来时在树上另点了文件：旧点击作废，不把旧目标压到新栈顶」** —— 让 wikilink 的 ① 同目录列举**挂住**（手动 deferred）→ 点 `[[target]]` → 解析返回前点树上 `notes/deep.md`（重置栈）→ 再释放解析：断言 `data-selected-path` 仍是 `/vault/notes/deep.md`、标题仍是 `deep.md`、**没有返回钮**（没多压一层）、无错误条。**变异验证**：把代次守卫去掉后该用例变红（实测被压成 `/vault/target.md`），确认它抓的就是这个竞态。
2. **「斜体（em）里的 wikilink 同样可点，点击照常压栈」** —— `*[[target]]*` 与 `**[[target]]**` 同时出现：两条都渲染成 wikilink 元素（`data-target=target`）、分别位于 `<em>` / `<strong>` 内；点斜体那条照常压栈到 `/vault/target.md`。**变异验证**：临时把 `em` 的 `withWikilinks` 去掉即变红。

#### 本轮明确不做（已知项）

- **img 白名单**（markdown 图片的路径 / 域名 / `data:` 限制）：留 **08 之后 / 后续轮**，任务文档已把它记为**非目标**（本轮 `<img>` 仍按原始 `src` 渲染）。
- **tooltip 滚动漂移**：tooltip 位置在 hover 时按锚点 rect 算一次，容器滚动时不跟随重算（`position: fixed` + portal，不裁切，但滚动中可能偏）。
- **`listFiles` 的 AbortSignal**：目录列举没有取消通道（切根 / 换沙箱只是 `invalidate()` 缓存）。
- **`truncated` 标志统一处理**：与 05 同口径（`maxBytes = size` 时正常流程看不到截断），留后续轮统一收口。

以上四项**别按「已支持」写 e2e / 文档**。

#### 门禁（实测）

| 门禁 | 结果 |
|---|---|
| `npx vitest run`（全量） | **52 个测试文件 / 919 条用例全绿**（接手基线 917，**本轮 +2**） |
| `npx tsc --noEmit` | **0 错误** |
| `npx tsc --noEmit -p tests/tsconfig.json` | **0 错误**（双零） |

（本轮无依赖变化、无渲染产物形状变化，未重跑 `vite build`。）
