---
prd: prds/file-pane-obsidian.md
status: done
---
# 任务：Obsidian tab 骨架（固定 tab、双栏、vault 树）

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **依赖 04**（本任务要动同一片终端标签区与内容区布局）。
> **不含 markdown 渲染与 wikilink**——那部分在 07 轮；本轮先把骨架与 vault 树立起来。
> **2026-11-13 口径修订**：tab 图标由 lucide `gem` 改用 **Obsidian 官方 logo SVG**（本地资产、运行时零 CDN）。

## 目标

在 tabs 条**最左**加一个**固定的 Obsidian tab**，激活时展示**全宽双栏**的 vault 阅读器骨架（左树右预览），并能**设 vault 根**、**浏览 vault 树**。

### 要落地的口径

- **固定 tab**：tabs 条**最左**，**Obsidian 官方 logo SVG**（**本地资产**）+「**Obsidian**」文字；**不可关闭、无关闭按钮**；**独立于终端会话**存在——**没有任何终端会话时仍然可用**。
  - **来源**：`https://upload.wikimedia.org/wikipedia/commons/1/10/2023_Obsidian_logo.svg`（**已实测可达**：HTTP 200、`image/svg+xml`、4820 字节、合法 **512×512** 宝石 logo）；
  - **必须下载进仓库作为本地资产**——仓库既有「**运行时零 CDN**」口径，**禁止运行时外链**（落地路径由本轮定，如 `src/assets/brand/`）；
  - **实现注意点**：该 SVG 内含 `logo-*` **渐变 id**，**内联多副本会 ID 冲突**——加前缀或改用 `img` 方式引入；
  - 其余图标**仍统一 lucide-react**，「**不引第二套图标库**」口径不变——**本地品牌 SVG 资产不算第二套图标库**。
- **与文件窗格联动**：激活 Obsidian tab 时**文件窗格隐藏**；切回终端 tab 时窗格**按原折叠态恢复**。
- **布局**：**全宽双栏**——左 **vault 树** + 右预览区，中间一条细**分隔线**（**无拖拽**）。
- **vault 根未设**：右侧显示**引导态**（居中）——书本线框图标 +「**选择一个目录作为 vault 根**」+「**使用沙箱工作目录**」描边按钮 + **路径输入框** +「**打开**」按钮——**两条入口都可用**。
- **vault 根已设**：左栏顶部显示「**vault 根：<路径>**」+「**更改**」小按钮（点击**回引导态并预填原根**）；vault 根**按沙箱记在前端本地**（换沙箱各自记忆，**不入后端**）。
- **vault 树**：**树形展开风格**（三角箭头旋转、缩进层级线）；**只列目录与 `.md` 文件**；目录可展开 / 收起，**展开态按路径在前端本地记忆**。

## 涉及文件

- `apps/web/frontend/src/components/TerminalPanel.tsx` 及其标签条相关组件 — 固定 Obsidian tab（最左）、激活态切换
- `apps/web/frontend/src/assets/`（新增品牌资产）— **Obsidian 官方 logo SVG**（**本地化入库、运行时零 CDN**）
- `apps/web/frontend/src/components/workbench/`（新增）— Obsidian 双栏视图组件（vault 树 / 引导态 / 预览占位区）
- `apps/web/frontend/src/lib/`（新增）— vault 根存取（按沙箱）、树展开态存取、目录列举等纯函数 + 单测
- `apps/web/frontend/src/api/client.ts` — 复用既有目录列举能力（`list`）
- `apps/web/frontend/README.md` — 标识表登记

## 完成标准

- [x] tabs 条**最左**有**固定**的 Obsidian tab：**Obsidian 官方 logo SVG**（**本地资产、运行时零 CDN**、源码取自 Wikimedia 的 `2023_Obsidian_logo.svg`）+「**Obsidian**」文字，**不可关闭、无关闭按钮**；**没有任何终端会话时该 tab 仍可用**；内联多副本时 `logo-*` 渐变 id **不冲突**（对应 PRD 验收项 **OBS-01**）。
- [x] 激活 Obsidian tab 时**文件窗格隐藏**、切回终端 tab 时窗格**按原折叠态恢复**；Obsidian 视图为**全宽双栏**（左 vault 树 + 右预览区），中间一条细分隔线、**不可拖拽**（对应 PRD 验收项 **OBS-02**）。
- [x] **未设 vault 根**时右侧显示**引导态**：居中书本线框图标 +「**选择一个目录作为 vault 根**」+「**使用沙箱工作目录**」描边按钮 + **路径输入框** +「**打开**」按钮；**两条入口都可用**（按钮与输入框两条路径均能成功设根）（对应 PRD 验收项 **OBS-03**）。
- [x] **已设 vault 根**时左栏顶部显示「**vault 根：<路径>**」+「**更改**」小按钮，点击**回引导态并预填原根**；vault 根**按沙箱记在前端本地**、**不入后端**（对应 PRD 验收项 **OBS-04**）。
- [x] vault 树为**树形展开风格**（三角箭头旋转 + 缩进层级线），**只列目录与 `.md` 文件**；目录可展开 / 收起，**展开态按路径在前端本地记忆**（刷新后仍在）（对应 PRD 验收项 **OBS-05**）。
- [ ] 前端**标识表**登记新增标识；门禁（vitest / typecheck / build）全绿。
  - 门禁已全绿（数字见进展节第六小节）；**`apps/web/frontend/README.md` 本轮归并行 agent 独占、本次未改**——新标识清单已逐条登记在进展节第五小节，**待后续轮统一并入标识表**。

## 依赖

- 依赖 [[tasks/file-pane-obsidian/04-file-pane-split.md|04 文件窗格分屏骨架]]（同一片标签区与内容区布局）。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。

## 进展（2026-11-14 收口）

> **范围**：只动 `apps/web/frontend/`（`TerminalPanel.tsx` / `TerminalTabs.tsx` / 新增 `ObsidianWorkspace.tsx` / 新增 `lib/obsidian-vault.ts` / 新增 `src/assets/brand/`）与本任务文件。
> **禁改清单遵守**：`FileBrowserPanel.tsx` / `api/client.ts` / `api/types.ts` / `apps/core/` / `apps/web/backend/` / `apps/web/frontend/README.md` **零改动**（并行 agent 在改那些地方）；`src/lib/terminal-pwd.ts`、`src/lib/file-pane-collapsed.ts` **未动**；**未引入新依赖**；**未 `git commit`**。
> **字体**：新增中文文案的字符**全部已在** `scripts/fonts/charset.txt` 里（含 `common-hanzi.txt` 的 3500 字），无需重跑 `build-fonts.sh`（已逐字核对：0 个缺失字符）。

### 一、tab 结构与状态流

```
<section page-sandbox-detail-terminal-panel>            ← 全屏时整块 fixed inset-0 z-40
  <TerminalTabs/>                                        ← tabs 条（全屏层内保持可见 / 可切）
    tablist page-sandbox-detail-terminal-tabs
      [page-sandbox-detail-obsidian-tab]                 ← 固定 Obsidian tab（**最左**、无关闭按钮）
      [暂无终端会话（仅终端 tab 激活时）]
      [page-sandbox-detail-terminal-tab ...]             ← 终端会话 tab（从 sessions 派生）
      [page-sandbox-detail-terminal-new-button]
  <div 内容区 (p-4, flex-col)>
    activeTabKind === 'obsidian'
      ? <ObsidianWorkspace key={sandboxName}/>           ← 全宽双栏（左树 + 细分隔线 + 右预览区）
      : <> 重试连接按钮? + <div page-terminal-split> 三段式 </>   ← 终端 + 可拖拽分隔条 + 文件窗格
```

**状态流（唯一真源 = `TerminalPanel` 的本地 `activeTabKind`）**

| 入口 | 动作 | 位置 |
|---|---|---|
| 点固定 Obsidian tab | `setActiveTabKind('obsidian')`（`selectTabKind`） | `TerminalPanel.tsx:534` |
| 点终端会话 tab | `selectSession`：置焦点回填意图 + `setActiveTabKind('terminal')` + 选会话 | `TerminalPanel.tsx:523` |
| 新建会话（tabs 条 + 或空态入口） | `createTerminal`：`setActiveTabKind('terminal')` + 选中新会话 | `TerminalPanel.tsx:415-429` |
| tab 条渲染 | props `activeTabKind` / `onSelectTabKind` | `TerminalTabs.tsx:34,57,66,95` |

- **两种内容二选一渲染**（不是 `display:none` 盖住）：Obsidian tab 激活时**终端分屏整体不出现** ⇒ `page-file-pane` / `page-terminal-split-handle` / `page-sandbox-detail-terminal-surface` / 「没有终端会话」空态**全部不在 DOM 里**（`queryByTestId(...) === null`；Playwright 的 `toHaveCount(0)` 与 `toBeHidden()` 两种写法都成立）。
- **终端 WS 的副作用（已知、可接受）**：二选一渲染意味着切到 Obsidian tab 时 `TerminalView` 卸载 ⇒ 终端 WebSocket 断开；会话本身是**服务端 pty**（不随附着断开而结束），切回终端 tab 重新附着，服务端回放现场缓冲（口径同「点标签 = 重新连上该会话」）。**刻意不选「隐藏但保挂载」**：那会让 `page-file-pane` / 「没有终端会话」空态留在 DOM 里，与 PRD FP-04「窗格不出现」的验收口径（`toHaveCount(0)`）冲突。**pwd 恢复的真实机制见第八小节「机制修正」——不是 `attachedOnceRef` 的两步 resize。**
- **折叠态不重置**：`paneCollapsed` 仍由 `TerminalPanel` 的 `useFilePaneCollapsed()` 持有，切 tab 只改渲染分支、不碰它；切回终端 tab 时窗格按原折叠态（36px 竖条 / 原宽度）恢复。窗格宽度 `paneWidth` 也仍在本挂载内保持。
- **`shouldShowFilePane` 维度已接线**：`paneVisible = shouldShowFilePane({ tabKind: activeTabKind, hasActiveSession: activeId !== null })`（`TerminalPanel.tsx:556-559`），`file-pane.ts` 本轮**未改**。
- **换沙箱**：`activeTabKind` 保留（Obsidian tab 是固定 tab，读的是新沙箱自己的根 / 引导态）；全屏仍按 04 的口径自动退出；`ObsidianWorkspace` 用 `key={sandboxName}` 强制重挂载（树缓存 / 选中态 / 根 / 展开态都按沙箱分开）。

### 二、Obsidian logo SVG 的引入方式（定稿：`img` 外部引用，不内联）

- **资产**：`src/assets/brand/obsidian.svg`（**原件入库**，4820 字节、`viewBox="0 0 512 512"`、8 个 `logo-*` 渐变 id；下载自 Wikimedia Commons，HTTP 200 / `image/svg+xml`）。
- **引入**：`import obsidianLogoUrl from '../../assets/brand/obsidian.svg'`（Vite 资产 URL），渲染成 `<img src={obsidianLogoUrl} alt="" aria-hidden="true" className="size-[14px]">`（`TerminalTabs.tsx:114-120`）。
  - **为什么用 `img`**：SVG 的 `id` 是文档级的，内联多副本会让第二份的 `url(#logo-*)` 指到第一份的渐变节点上；`<img>` 是独立文档，天然无 ID 冲突（理由与来源写在 `src/assets/brand/README.md`）。
  - **运行时零 CDN**：构建产物里是 `dist/assets/obsidian-CRDpkhMp.svg`（**4.82 kB**，实测 `vite build` 输出行），页面无任何外链请求；单元测试里也断言 `src` 不含 `http://` / `https://` 前缀。
  - `vite.config.ts` 的 `assetsInlineLimit: 0` 保证它**不会被内联成 data URI**（与文件图标同一口径）。
- 其余图标仍是 lucide（`BookOpen` / `ChevronRight` / `Folder` / `FileText` / `Loader2`），**未引入第二套图标库**。

### 三、存储 key 定稿（按沙箱，参考 `file-pane-collapsed.ts` 惯例）

| 用途 | key | 值 | 回落 |
|---|---|---|---|
| vault 根 | `sandbox-console-obsidian-vault-root:<沙箱名>` | 归一后的绝对路径字符串 | 没存过 / 值非法 / 读失败 ⇒ **没有根**（引导态） |
| 树展开态 | `sandbox-console-obsidian-expanded:<沙箱名>` | 绝对路径的 **JSON 数组**（写时去重 + 字典序） | 没存过 / JSON 坏掉 / 不是数组 / 项非法 ⇒ **空数组** |

- 键前缀常量 `OBSIDIAN_VAULT_ROOT_STORAGE_PREFIX` / `OBSIDIAN_VAULT_EXPANDED_STORAGE_PREFIX`，拼键函数 `vaultRootStorageKey(sandbox)` / `vaultExpandedStorageKey(sandbox)`（`lib/obsidian-vault.ts:26-39`）。
- **挂载时不写存储**：只有用户设根 / 点「更改」后打开 / 点目录展开才落盘；读不到、写不进（隐私模式）都静默回落，不打断交互。
- **不设会话级、不入后端**：根与展开态都只认沙箱维度（换沙箱各自记忆）；没有任何接口调用用于存取它们。
- 设根写值先过 `normalizeVaultRoot`（trim + 绝对路径 + 拒 NUL + 拒 `.` / `..`），**写非法值等于清键**；写 `null` 显式 `removeItem`。

### 四、实现要点（文件:行）

| 口径 | 位置 | 要点 |
|---|---|---|
| 固定 Obsidian tab（最左、无关闭按钮、图标 + 文字） | `TerminalTabs.tsx:92-121` | 在 tablist 的**第一个子节点**；`role="tab"` + `aria-selected` + `data-active`；**只有一个按钮**（无 × 关闭键）；零会话时照样渲染 |
| 「暂无终端会话」标签只在终端 tab 激活时出现 | `TerminalTabs.tsx:122` | 条件 `tabs.length === 0 && terminalActive` |
| 终端 tab 的激活态不串到 Obsidian tab | `TerminalTabs.tsx:135` | `active = terminalActive && tab.id === activeId` |
| tab 状态真源 | `TerminalPanel.tsx:156` | `useState<WorkspaceTabKind>('terminal')`（不再是写死的只读 state） |
| 内容区二选一渲染 | `TerminalPanel.tsx:675-690` | `activeTabKind === 'obsidian' ? <ObsidianWorkspace/> : <>…三段式…</>` |
| 全屏承接 Obsidian | `TerminalPanel.tsx:614-624` | 仍是整块 `fixed inset-0 z-40`；Obsidian 双栏在内容区里 `flex-1`（单测断言全屏层内 `page-sandbox-detail-obsidian` 存在） |
| vault 根归一 | `lib/obsidian-vault.ts:50` | trim ⇒ `normalizeContainerPath`（复用文件窗格同一套路径校验） |
| 根存取 | `lib/obsidian-vault.ts:77` / `:93` | 读回落 `null`、写先归一（非法 = 清键）、写 `null` 删键 |
| 展开态存取 | `lib/obsidian-vault.ts:127` / `:163` | 读：只认绝对路径字符串、去重；写：去重 + 排序后 `JSON.stringify` |
| 树过滤 / 定序 | `lib/obsidian-vault.ts:187-230` | `isVaultEntry`：dir 全留、file 只看 `.md`（大小写不敏感）、special 全丢；目录在前 + 名称自然序；**不改原数组** |
| 子路径 / 根内判定 | `lib/obsidian-vault.ts:238` / `:248` | 复用 `childContainerPath`；`/vault` 与 `/vault2` 不误判 |
| 引导态（两条入口） | `ObsidianWorkspace.tsx:381-450` | 居中 `BookOpen`（`strokeWidth 1.25`）+「选择一个目录作为 vault 根」+描边「使用沙箱工作目录」（`workdir` 不可得时禁用 + title）+ 路径输入框 + 主按钮「打开」（非法路径禁用）+ 就地红字 `role="alert"`；输入框回车同样提交 |
| 已设根的左栏头 | `ObsidianWorkspace.tsx:470-495` | 「vault 根：<路径>」（`truncate` + `title` 全文）+「更改」小按钮 |
| 「更改」回引导态并预填 | `ObsidianWorkspace.tsx:354-357` | `setDraftPath(root)` + `changingRoot=true`；此时左栏树干保留，右栏显示引导态 |
| 懒展开 + 三角箭头旋转 | `ObsidianWorkspace.tsx:126-183` | 展开才渲染子层并 `api.listFiles(sandbox, path)`；`ChevronRight` 展开时 `rotate-90`；子层 `border-l` + `ml-[13px] pl-2` 画**层级线** |
| 展开态持久 | `ObsidianWorkspace.tsx:319-336`（写）/ `:304-317`（刷新后补列举） | 点目录即落盘；刷新后已记的展开目录（且在根之内）自动补列举一次 |
| 过期响应丢弃 | `ObsidianWorkspace.tsx:289-301` | 换根 `generationRef` 自增，旧根的列举结果一律丢弃 |
| 目录读取失败 | `ObsidianWorkspace.tsx:86-104` | 就地 `role="alert"`（`page-sandbox-detail-obsidian-tree-error`），**不弹 toast** |
| 选中态（07 轮的输入） | `ObsidianWorkspace.tsx:46-54` / `:185-215` / `:505-525` | `selected: {path,name,size}`；右侧 `data-selected-path` 带出选中路径；点中行 `data-active="true"` |

### 五、新增 data-testid 清单（**待并入标识表**；`apps/web/frontend/README.md` 本轮禁改）

| 标识 | 元素 | 备注 |
|---|---|---|
| `page-sandbox-detail-obsidian-tab` | 固定 Obsidian tab 容器 | `role="tab"`、`aria-selected`、`data-active`；**tabs 条最左** |
| `page-sandbox-detail-obsidian-tab-select` | 该 tab 的选中按钮 | tab 上**唯一**的按钮（**没有关闭按钮**） |
| `page-sandbox-detail-obsidian-tab-icon` | tab 图标 `<img>` | 本地资产 URL（无 `http(s)` 外链） |
| `page-sandbox-detail-obsidian` | Obsidian 视图根 | 引导态与双栏共用（两种分支各一份） |
| `page-sandbox-detail-obsidian-onboarding` | 引导态容器 | 未设根时占满视图；「更改」时出现在右栏 |
| `page-sandbox-detail-obsidian-onboarding-icon` | 书本线框图标 | lucide `BookOpen` |
| `page-sandbox-detail-obsidian-onboarding-title` | 「选择一个目录作为 vault 根」 | |
| `page-sandbox-detail-obsidian-use-workdir-button` | 「使用沙箱工作目录」描边按钮 | `workdir` 不可得时禁用 |
| `page-sandbox-detail-obsidian-root-input` | vault 根路径输入框 | 回车同样提交 |
| `page-sandbox-detail-obsidian-root-open-button` | 「打开」按钮 | 非法路径 / 空值禁用 |
| `page-sandbox-detail-obsidian-root-error` | 路径非法就地红字 | `role="alert"` |
| `page-sandbox-detail-obsidian-vault-tree` | 左栏树容器 | |
| `page-sandbox-detail-obsidian-vault-header` | 左栏顶部头 | |
| `page-sandbox-detail-obsidian-vault-root` | 「vault 根：<路径>」 | 纯文本，`title` 带全文 |
| `page-sandbox-detail-obsidian-change-root-button` | 「更改」小按钮 | 回引导态 + 预填原根 |
| `page-sandbox-detail-obsidian-tree-node` | 目录节点外层 | 带 `data-path` |
| `page-sandbox-detail-obsidian-tree-dir` | 目录行按钮 | `data-path`、`data-expanded`、`aria-expanded` |
| `page-sandbox-detail-obsidian-tree-chevron` | 三角箭头 | 展开时带 `rotate-90` |
| `page-sandbox-detail-obsidian-tree-children` | 子层容器（含层级线） | 每层一个 |
| `page-sandbox-detail-obsidian-tree-file` | `.md` 文件行 | `data-path`、`data-active`、`aria-current` |
| `page-sandbox-detail-obsidian-tree-loading` | 目录列举中的旋转图标 | |
| `page-sandbox-detail-obsidian-tree-error` | 目录读取失败就地错误 | `role="alert"` |
| `page-sandbox-detail-obsidian-divider` | 两栏之间的细分隔线 | `aria-hidden`、**不可拖拽**（无 role=separator、无事件） |
| `page-sandbox-detail-obsidian-preview` | 右栏预览区 | `data-selected-path` = 当前选中文件路径（未选中为空串） |
| `page-sandbox-detail-obsidian-preview-empty` | 「从左侧选择文件」空态 | |
| `page-sandbox-detail-obsidian-preview-placeholder` | 选中文件后的占位（显示路径） | 07 轮由渲染视图取代 |

> 复用未改动的既有标识：`page-sandbox-detail-terminal-tabs` / `-terminal-tab` / `-terminal-tab-select` / `-terminal-tab-close` / `-terminal-new-button` / `-terminal-status` / `-terminal-fullscreen-button` / `page-terminal-split` / `page-terminal-split-handle` / `page-file-pane` / `page-sandbox-detail-terminal-placeholder` / `-terminal-empty-title` / `-terminal-empty-create-button`。

### 六、测试与门禁

**新增单测**：`src/lib/obsidian-vault.test.ts`（22 条）——根归一（相对路径 / NUL / `.` / `..` / 空白）、键按沙箱拼、根读写（归一落盘、非法值清键、写 `null` 删键、脏值回落、隐私模式不抛）、展开态（去重 + 排序、非法项丢弃、坏 JSON 回落、按沙箱隔离）、树过滤（只目录 + `.md`、大小写、目录在前自然序、不改原数组）、子路径与根内判定（`/vault` vs `/vault2`）、文件名。

**新增组件测试**：`src/components/workbench/ObsidianWorkspace.test.tsx`（15 条）——引导态构图与两条入口（按钮 / 输入框 + 回车）、workdir 不可得禁用、按沙箱隔离、已存根直进树、只列目录 + md、懒展开（点才列举 + 箭头 `rotate-90`）、展开态落盘 / 收起移除 / 刷新后仍在（补列举）、目录失败就地错误、多层展开层级线、更改根预填 + 换根、选中态（`data-selected-path`）。

**新增交互测试**（`src/components/TerminalPanel.test.tsx` 的「Obsidian tab」describe，6 条）——最左固定 tab（icon 本地资产 + 单按钮无关闭键）、零会话可用 + 不改选中会话 + 「没有终端会话」空态不出现、激活 Obsidian ⇒ 窗格 / 分隔条 / 终端表面消失、切回 ⇒ **折叠态按原样恢复（36px）**、展开态切回宽度不变（340px + 分隔条回来）、Obsidian 上新建会话回终端 tab、全屏层内双栏可见。

**门禁（实测）**

| 门禁 | 结果 |
|---|---|
| `npx vitest run`（全量） | **49 个测试文件 / 821 条用例全绿**（接手基线 762；**本轮新增 43 条**：22 纯函数 + 15 组件 + 6 交互。其余增量来自并行 agent 的 05 轮文件预览，非同轮产物） |
| `npx tsc --noEmit` | **0 错误**（双零：`tests/tsconfig.json` 项目同样 0 错误） |
| `npx vite build` | **通过**（`dist/assets/obsidian-CRDpkhMp.svg` 4.82 kB 独立产出，仅既有 >500kB 提示） |
| 字体字符集 | 新文案字符 **0 个缺失**（无需重跑 `build-fonts.sh`） |

### 七、给 07 轮的接口（渲染 / wikilink 落点）

1. **视图组件**：`src/components/workbench/ObsidianWorkspace.tsx` 的 `ObsidianWorkspace({ sandbox, workdir })` —— 07 轮在右栏 `page-sandbox-detail-obsidian-preview` 内替换占位。
2. **选中状态（已搭好结构）**：
   - 组件内 state `selected: VaultSelectedFile | null`，类型 `{ path: string; name: string; size: number }`（**已导出** `VaultSelectedFile`）；
   - 点树上的 `.md` ⇒ `selectFile(file)`（`ObsidianWorkspace.tsx:333-336`），行上 `data-active="true"`；
   - 右栏容器带 `data-selected-path`（未选中为空串），挂载点 `page-sandbox-detail-obsidian-preview` 目前渲染 `page-sandbox-detail-obsidian-preview-empty`（「从左侧选择文件」）或 `page-sandbox-detail-obsidian-preview-placeholder`（显示路径）。
3. **树缓存（可直接复用做 wikilink 同名匹配的第一/二级）**：组件内 `dirs: Record<string, {status, entries, error}>`（**按绝对路径缓存的原生 `FileListEntry[]`，未过滤**，07 想拿全量条目做匹配可直接读），再加 `loadDir(path)`；`expanded` 是 `Set<string>`，`toggleDir(path)` 已落盘。**注意**：这些都是组件内部状态，07 若要做递归列举，建议把「列举 + 缓存」抽成 hook 或在 lib 里加纯函数（带 exec 看门狗超时的那层）。
4. **纯函数可复用**：`lib/obsidian-vault.ts` 的 `normalizeVaultRoot` / `vaultChildPath` / `isPathWithinVaultRoot` / `vaultFileName` / `filterVaultEntries`；路径归一统一走既有 `normalizeContainerPath`（wiki 解析结果也要求过它）。
5. **右栏宽度**：当前是 `flex-1 min-w-0`（08 说的 620px 内容列居中由 07 自己加，别在双栏层加）。
6. **不要动的地方**：tabs 条上 Obsidian tab 的位置 / 测试标识、`activeTabKind` 状态流、`TerminalPanel` 的二选一渲染分支；07 只在 `ObsidianWorkspace` 内部扩右栏与树（树若加「展开到目标文件」能力，沿用 `toggleDir` + `expanded` 落盘口径）。

### 八、审查修复（2026-11-13）

> 范围仍是 `ObsidianWorkspace.tsx` / `ObsidianWorkspace.test.tsx` / `lib/obsidian-vault.ts`（删冗余 `.slice()`）与本任务文件；**未碰** 05 轮修复领地（`transfer.py` / `api/client.ts` / `FileBrowserPanel` 等）、终端组件、`base-image`、`apps/core`、`apps/web/backend`；**未 `git commit`**。

**1. 恢复列举 effect 稳定化**

- 原写法把 `dirs` 放进依赖数组（`[root, expandedPaths, dirs, loadDir]`）：每列完一个目录都整轮重跑一遍循环，`!dirs[path]` 只是免掉重复请求，effect 本身仍在反复执行。
- 改为 `requestedPathsRef: Set<string>` 持守卫：**只在真正发起列举时记一笔**，effect 依赖收敛为 `[root, expandedPaths, loadDir]`；同一路径不会再被恢复逻辑重复列举。
- **并发恢复请求保留（设计如此）**：一轮循环里多个已记展开目录仍会并发 `void loadDir(path)`，不串行、不合并。
- **换根时 `requestedPathsRef.current.clear()`**：新根要重新列举，旧 guard 不能挡住。懒展开仍由同一 effect 驱动（`toggleDir` 改 `expandedPaths` ⇒ 新路径不在 guard 里 ⇒ 发一次列举）。

**2. 换根裁剪展开态**

- `applyRoot` 在写根之前，用既有 `isPathWithinVaultRoot(normalized, path)` 过滤 `expandedRef.current`（同时排除新根自身——根层本就隐式展开，不必进存储），并把结果**同时写回 state 与 localStorage**。
- 旧根下、新根之外的展开路径不再永久滞留：换到更小的根后它们从 `expandedPaths` / 存储里消失，也不会再被恢复 effect 拿来列举。
- 新增用例：根 `/vault`（已展开 `/vault/notes`、`/vault/media`）换到 `/vault/notes/deep` ⇒ 存储裁空、`/vault/media` 不再新增列举、新根正常列出 `idea.md`。

**3. 冗余 `.slice()` 清理**

- `filterVaultEntries` 里 `.filter(isVaultEntry).slice().sort(...)` 的 `.slice()` 删除：`filter` 已返回新数组，`sort` 不会碰入参；纯函数单测「不改原数组」继续护着。

**4. 测试清理**

- 目录失败用例删掉首渲死代码：改为先 `writeStoredVaultRoot('demo', ROOT)` 再单次 `renderWorkspace()`，不再 `cleanup()` + 二次挂载。

**机制修正（pwd 恢复，重要）**

- **不成立的表述**：「切 tab 卸载 ⇒ 重连时 `attachedOnceRef` 判定为重新附着，两步 resize 刷 pwd」。`TerminalView` 随 Obsidian tab 的二选一渲染**整块卸载**；切回终端 tab 是**新实例挂载**，`attachedOnceRef` 从 `false` 起步，首次 `hello` 被判定为**新起 shell**，`refreshPwdByResize` 的「cols+1 → 还原」**不会执行**。
- **实际机制**：切回后的 pwd 由两处叠加恢复——① 服务端在该会话缓冲里回放的字节**包含脱离前最后一条 OSC 1337**，xterm 重新解析回放流时触发已注册的 OSC handler，`setSessionPwd` 用回放里的值刷新缓存；② 首次握手后的 `safeFit` / 首帧 resize 在**前端视宽 ≠ pty 真实尺寸**时触发 shell 重绘，顺带再报一条 OSC 1337。
- **结果为什么正确**：脱离期间 shell 没有输入 ⇒ pwd 不会漂移，所以①回放里的旧值就是当前值，②再兜一次即可收敛。
- **语义**：与既有「点终端标签切换」（`key={activeId}` 重挂载）**完全一致**，**不是本轮引入的回归**。07+ 轮不要把「两步 resize」当成切 tab 后 pwd 恢复的依赖；两步 resize 只服务于**同一 `TerminalView` 实例内的自动重连 / 手动重试**。

**门禁（实测）**

| 门禁 | 结果 |
|---|---|
| `npx vitest run`（全量） | **49 个测试文件 / 842 条用例全绿**（基线 841，本轮净增 1：ObsidianWorkspace 组件用例 15 → 16） |
| `npx tsc --noEmit` | **0 错误** |
| `npx tsc --noEmit -p tests/tsconfig.json` | **0 错误** |
