---
prd: prds/file-pane-obsidian.md
status: done
---
# 任务：验收与文档收口

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **依赖 01~07 全部完成**（本任务是收口轮）。

## 目标

把全轮做**验收与文档收口**：e2e 用例、门禁全量、**PRD 验收标准逐条核销**、文档同步、**全轮留档**。

### 要落地的口径

- **e2e**：新增用例覆盖**文件窗格分屏 / 折叠 / 空态**与 **Obsidian 双栏 / wikilink 跳转 / 目标不存在错误条**主链路（对应 PRD 验收项 **QA-01**）。
- **门禁全量**：核心包 pytest + ruff、服务端 pytest + ruff、前端 vitest + typecheck（双零错）+ build、桌面 `cargo test`、e2e 全量套件。
- **PRD 逐条核销**：把 [[prds/file-pane-obsidian.md|PRD]]「验收标准」的 **38 条**逐条勾选并**挂证据**（门禁数字 / 真机实证 / 用户验收 / 留档指针四类）；**未核销的条目要写明原因**，不许留空勾。
- **文档同步**：
  - 后端 `apps/web/backend/API.md` — 补 `files/read` 端点章节；
  - 前端 `apps/web/frontend/README.md` — **标识表**登记新增 `data-testid`、登记**退役**的旧标识；
  - [[glossary.md|词汇表]] — 按需补词条（如「文件窗格」「vault 根」「OSC 1337」）；
  - [[current-state.md|看板]] — 活跃需求 / 任务看板 / TODO；
  - [[prds/README.md|PRD 清单]] 与 [[tasks/README.md|任务清单]] — 同步本轮条目与状态；
  - [[conventions/console-frontend.md|前端约定]] — 若本轮产生新的稳定约定（如「纯 CSS 全屏范围」「剪贴板成功零反馈」扩展口径），**在此落一条**。
  - [[architecture/decisions/0004-镜像契约与默认沙箱镜像.md|ADR 0004 镜像契约与默认沙箱镜像]] — 按 01 轮实测结论**追加一条修订行**（**历史表述不改写**），对齐口径：「**镜像自带的默认 shell 配置（`/etc/bash.bashrc` 的 OSC 注入）属镜像内容、不属平台运行时机制；平台运行时机制仍不依赖 shell 初始化脚本**」——**2026-11-13 修订范围扩大**：该修订行**同时覆盖两条**：① **PS1 注入**；② **base image Dockerfile 新增 locale ENV**（`LANG` / `LC_ALL` = `C.UTF-8`）。两条均由任务 02 实现、由本轮统一落修订行。
- **全轮留档**：新建 `docs/tasks/file-pane-obsidian/RESULTS.md`——轮次总表、门禁数字、真机验收记录、**已知边界与留白**、提交链。

## 涉及文件

- `apps/web/frontend/tests/` — 新增 e2e spec
- `apps/web/backend/API.md` — 新端点章节
- `apps/web/frontend/README.md` — 标识表
- `docs/glossary.md`、`docs/current-state.md`、`docs/prds/README.md`、`docs/tasks/README.md`、`docs/conventions/console-frontend.md`
- `docs/prds/file-pane-obsidian.md` — **验收标准逐条核销**
- `docs/tasks/file-pane-obsidian/RESULTS.md`（新建）— 全轮留档

## 完成标准

- [x] 新增 e2e 用例覆盖**文件窗格分屏 / 折叠 / 空态**与 **Obsidian 双栏 / wikilink 跳转 / 目标不存在错误条**主链路，**e2e 全量套件通过**（对应 PRD 验收项 **QA-01**）。（e2e 全量 **63 / 63**，见上文「一」）
- [x] 质量门禁**全绿**：核心包 pytest + ruff、服务端 pytest + ruff、前端 vitest + typecheck（双零错）+ build、桌面 `cargo test`、e2e 全量；**数字写进留档**。（数字已写入 [[tasks/file-pane-obsidian/RESULTS.md|RESULTS]] 第三节）
- [x] **PRD 验收标准 38 条逐条核销**并**挂证据**；未核销条目写明原因（对应 PRD 验收项 **QA-02**）。（2026-11-14：[[prds/file-pane-obsidian.md|PRD]] **38 / 38** 核销，证据分真机 e2e / 单测 / 既有落档三档，未真机覆盖项如实标注）
- [x] 后端 `API.md` 补 `files/read` 端点章节；前端**标识表**登记新标识与退役标识。（经核实：`API.md` 16.7「只读读取（预览）端点」已于 05 轮落库；标识表由 04~07 轮登记，本轮 e2e 按表编写并断言退役标识 0 命中）
- [x] [[glossary.md|词汇表]] 按需补词条；[[conventions/console-frontend.md|前端约定]] 按需补稳定约定。（2026-11-14 收口：词汇表补 5 词条；约定补 4 条——剪贴板零反馈扩展 / 全屏对象口径 / 窗格伴生形态 / 大文件预览统一口径）
- [x] [[current-state.md|看板]]（活跃需求 / 任务看板 / TODO）、[[prds/README.md|PRD 清单]]、[[tasks/README.md|任务清单]] 三处**同步**。（2026-11-14 收口完成；规划区「本需求线收口后再启动」前置同步解除）
- [x] 全轮留档 `RESULTS.md` 落库（轮次总表 / 门禁数字 / 真机验收记录 / **已知边界与留白** / 提交链）。（[[tasks/file-pane-obsidian/RESULTS.md|RESULTS]]，2026-11-14）

## 进展（2026-11-14 执行部分收口）

> **范围（本文件只记执行部分：代码与取证）**：新增 `apps/web/frontend/tests/helpers/file-pane.ts`、`apps/web/frontend/tests/specs/14-file-pane.spec.ts`、`apps/web/frontend/tests/specs/15-obsidian-reader.spec.ts`；改写 `apps/web/frontend/tests/specs/12-file-transfer.spec.ts`；`tests/helpers/api.ts` 补终端会话清场三函数（`listTerminalSessions` / `deleteTerminalSession` / `clearTerminalSessions`）；本任务文件。
> **零改动**：`apps/core/`、`apps/web/backend/`、`apps/desktop/`、`base-image/`、`apps/web/frontend/src/` **一行未动**；`docs/` 下**只动本文件**；**未 `git commit`**（提交链留给 archivist 统一收口）。
> **口径**：e2e 真机在本宿主跑（docker / 免密 sudo / 镜像 `sandbox-platform/base:0.3.1` 就绪），沙箱走既有接口直建通道，**未引入任何 mock**。

### 一、e2e 交付清单

| 文件 | 动作 | 用例数 | 覆盖 |
|---|---|---|---|
| `tests/specs/14-file-pane.spec.ts` | **新增** | **6** | 分屏三段式（左终端 + 分隔条 + 右窗格，默认 **340px**，指针拖拽 / 方向键调宽，窗格最窄 **240px** 且**终端面板 ≥ 320px**）；折叠成 **36px** 纯图标竖条（**无文字、只有底部一个展开按钮**）**刷新后保持**、展开复原；**关闭全部会话** ⇒ 窗格与分隔条整体消失 + 空态「**没有终端会话**」+ 新建入口恢复且**折叠态保持**；回跳准星（tooltip「跳转到终端当前目录：/workspace」/ 已在目标目录禁用 / 点击回到 pwd）；**无自动跟随**（终端里 `cd /tmp` 后 tooltip 变、窗格纹丝不动）；会话切换时窗格按折叠态重建；**退役标识不复存在**（`page-sandbox-detail-files-button` / `page-file-browser-dialog` 均为 0 个） |
| `tests/specs/15-obsidian-reader.spec.ts` | **新增** | **4** | 固定 tab（**tabs 条最左**、本地打包 SVG 资产、**只有一个按钮 / 无关闭钮**、**零会话可用**）；引导态（标题 / 使用沙箱工作目录 / 路径输入框 / 打开钮禁用）→ 设根后**双栏**（树 264px + **1px 不可拖拽分隔线** + 右预览）；vault 树（**只列目录与 `.md`**，`.txt` 不在、目录展开箭头 `rotate-90`、子层出现、收起消失）；点 `.md` **markdown 渲染**（内容列 ≤620px 且居中、**frontmatter 渲染态隐藏**）+ **渲染/源码切换**（源码态 frontmatter 可见）；**wikilink 命中**（虚线强调色、hover tooltip = 解析路径、`data-status=found` / `data-resolved-path`、点击**压栈**推入目标、返回钮退回、**互链回跳**）；**目标不存在**（正文顶部红色错误条「链接目标不存在：acc-vault-missing」`role=alert`、**不跳转 / 不弹 toast**、可关闭、**正向对照**：命中链接确实跳转）；激活 Obsidian tab 时**文件窗格与分屏整体不出现**、切回终端 tab **按原折叠态恢复** |
| `tests/specs/12-file-transfer.spec.ts` | **改写（入口换形态）** | **3**（原 3 条） | 上传 / 下载 / 列表**语义与断言强度不变**：入口从退役抽屉改成**终端 tab 右侧的文件窗格**（标识全用 `page-file-pane-*` / `page-file-browser-*`，**零退役标识**）；上传 → 容器内 `stat` + `sha256sum` 取证 → raw 上传 → 下载回环（字节 / 中文名 / `Content-Length`）→ 同名覆盖（取消 / 确认，容器内双重对账）→ 隐藏文件 → 排序 → 面包屑导航；负例 400/409/401 全部保留（**沙箱停止后的就地错误态改用「导航强制度」**，窗格没有「关掉再打开」这条路径） |
| `tests/helpers/file-pane.ts` | **新增** | — | 窗格定位与断言（`openFilePane` / `filePane` / `paneContent` / `paneCollapsed` / `paneHandle` / `splitTerminal` / `fileRow` / `uploadRow` / `crumbs` / `uploadFromPane` / `paneToast` / `expectPaneAt`），标识一律照前端 README 标识表 |
| `tests/helpers/api.ts` | 小幅补充 | — | 终端会话清场：`listTerminalSessions` / `deleteTerminalSession` / `clearTerminalSessions`（见「四、遇到的问题」第 1 条） |

**e2e 全量结果（`cd apps/web/frontend && pnpm run test:acceptance`，2026-11-14 05:09 收尾）**：

| 项 | 数字 |
|---|---|
| 用例总数 | **63**（既有 01~13 共 **53** 条 + 本轮新增 **10** 条） |
| 通过 | **63** |
| 失败 / 跳过 | **0 / 0** |
| 总耗时 | **11.1m**（串行 1 worker；含 global setup 的 `uv sync` + 前端 build + 静态源 + 本地测试镜像 + 服务拉起） |
| 退出码 | **0** |

**teardown 清干净（逐项核验，验收跑完后立刻查）**：

| 核验项 | 结果 |
|---|---|
| 宿主 `docker ps -a` 里 `acc-*` 容器 | **0** |
| 宿主 `sandbox-acc*` 用户 | **0**（`getent passwd` 无命中） |
| `/home/acc-*` 家目录 | **0** |
| `/etc/subuid` 里 `acc` 段 | **0** 行 |
| 平台 `terminal-sessions/` 里 `acc-*` 记录 | **0**（残留两条属用户自己的 `qqbot` 沙箱，按设计不碰） |
| 本轮测试镜像（`sandbox-console-acceptance/local-only-<随机>`） | **已删**（宿主仍有一张 **2026-10-30** 的旧残留，早于本轮，不是本轮的产物） |
| `8100` / `8200` 监听 | **已释放** |
| `tests/.runtime/` | **已删** |

### 二、全量门禁数字（本轮实跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 核心包单测 | `cd apps/core && uv run pytest` | ✅ **429 passed**（`578.64s`，0 failed / 0 skipped） |
| 核心包 ruff | `cd apps/core && uv run ruff check .` | ✅ **All checks passed!**（0 error） |
| 服务端单测 | `cd apps/web/backend && uv run pytest` | ✅ **348 passed**（`22.06s`，0 failed） |
| 服务端 ruff | `cd apps/web/backend && uv run ruff check .` | ✅ **All checks passed!**（工作区根 `apps/ && uv run ruff check .` 同样通过） |
| 前端 vitest | `cd apps/web/frontend && pnpm run test` | ✅ **52 个测试文件 / 919 条用例全过**（`6.73s`） |
| 前端 typecheck（应用） | `npx tsc --noEmit` | ✅ **0 error** |
| 前端 typecheck（验收脚本） | `npx tsc --noEmit -p tests/tsconfig.json` | ✅ **0 error** |
| 前端 build | `npx vite build` | ✅ **built in 3.09s**；主 chunk `index-BLJ6AQA9.js` **857.91 kB**（gzip 262.84）——>500 kB 提示是 07 轮引入 react-markdown 后的既有现象，非本轮回归 |
| 桌面端 `cargo test` | `cd apps/desktop/src-tauri && cargo test` | ✅ **47 passed**（0 failed，`0.11s`） |
| e2e 全量 | `cd apps/web/frontend && pnpm run test:acceptance` | ✅ **63 passed**（0 failed，`11.1m`） |

### 三、完成标准逐条状态与证据指针

> 1 / 2 条是**本任务（执行部分）**的交付，已达成并附实测数字；3~7 条是**文档收口面**，由 archivist 随后统一做，这里只给**可核销的证据指针**（不代劳改动别人的文档领地）。

| # | 完成标准 | 状态 | 证据指针 |
|---|---|---|---|
| 1 | 新增 e2e 覆盖文件窗格分屏 / 折叠 / 空态 + Obsidian 双栏 / wikilink / 错误条，e2e 全量通过（**QA-01**） | ✅ **完成** | `tests/specs/14-file-pane.spec.ts`（6 条，含分屏几何 / 240px 钳位 / 36px 竖条 / 空态「没有终端会话」）；`tests/specs/15-obsidian-reader.spec.ts`（4 条，含双栏几何 / 1px 不可拖拽分隔线 / 成功跳转 / 错误条文案）；全量 **63 passed / 0 failed**（见「一」） |
| 2 | 门禁全绿（核心 pytest+ruff / 服务端 pytest+ruff / 前端 vitest+双 typecheck+build / 桌面 cargo / e2e），数字写进留档 | ✅ **完成** | 见「二」11 行数字；可直接搬进 `RESULTS.md` |
| 3 | PRD **38 条**逐条核销并挂证据，未核销写明原因（**QA-02**） | ⏳ 待 archivist | 见「三之二」38 条证据指针表（本轮实测过的都标了「真机 e2e」/「单测」，未在真机覆盖的明确标出原因） |
| 4 | 后端 `API.md` 补 `files/read` 章节；前端标识表登记新标识与退役标识 | ⏳ 待 archivist（**标识表其实已由 04~07 轮登记**：`page-file-pane-*` / `page-file-browser-*` / `page-terminal-split*` / `page-sandbox-detail-obsidian-*` / `page-file-preview-*` 全在，退役标识段在 `apps/web/frontend/README.md`「退役标识」块；本轮 e2e **就按这张表写的，并断言退役标识 0 命中**） | `apps/web/frontend/README.md` 标识表（306 / 632 / 633 / 634 行附近）+ 退役段（~690-700 行）；`apps/web/backend/API.md` 需 archivist 补 |
| 5 | 词汇表按需补词条；前端约定按需补稳定约定 | ⏳ 待 archivist | 本轮新产生的稳定事实：①**文件窗格是终端 tab 的伴生物**（无会话即整体不渲染，**没有关闭按钮**）；②**折叠态按应用记 localStorage**（键 `sandbox-console-file-pane-collapsed`），**跨会话 / 跨沙箱保持**；③**窗格无「关掉再打开」路径**，重读列表只能靠导航（同路径导航强制重读）；④**终端会话上限 5 个 / 沙箱**（e2e 需清场，见问题 1） |
| 6 | 看板 / PRD 清单 / 任务清单三处同步 | ⏳ 待 archivist | 本任务文件与 `RESULTS.md`（待建）是同步源 |
| 7 | 全轮留档 `RESULTS.md` 落库 | ⏳ 待 archivist | 本轮数字（一、二节）+ 已知边界（「三之二」的「未在真机覆盖」诸条）可直接搬 |

#### 三之二、PRD 38 条证据指针（供 archivist 核销）

> 证据类型三档：**真机 e2e**（本轮实跑，最硬）/ **单测**（本轮全量 vitest 919 或核心 429 / 服务端 348 跑通）/ **既有落档**（前序任务的真机记录，本轮不改写）。e2e 用例名按 `spec 文件 › 用例标题` 简写。

| 条目 | 证据类型 | 证据指针 |
|---|---|---|
| **FP-01** 三段式 + 340px + 终端最小宽钳位 | 真机 e2e + 单测 | `14-file-pane › 分屏三段式…`（三块左中右几何、默认 340、拖到 240 时终端 ≥320、`aria-valuenow`）；`src/lib/file-pane.test.ts`（25 条：`clampFilePaneWidth` / `filePaneWidthFromDrag`） |
| **FP-02** 抽屉退役（头部无「文件」按钮、全局不复存在） | 真机 e2e | `14-file-pane › 分屏三段式…` ⑥（两个退役标识 count 0）+ `12-file-transfer › 上传…` ①（头部「文件」按钮 count 0）；`src/components/TerminalPanel.test.tsx` |
| **FP-03** 折叠 36px 无文字 + 只有展开钮 + 本地记忆 | 真机 e2e + 单测 | `14-file-pane › 折叠…`（36px、`textContent` 为空、竖条内 button 恰 1 个、刷新后仍折叠、展开复原）+ `› 会话切换…`（跨会话保持）；`src/lib/file-pane-collapsed.test.ts`（8 条） |
| **FP-04** 入口随会话 + 空态 + 新建恢复 + Obsidian 时无窗格 | 真机 e2e | `14-file-pane › 关闭全部会话…`（窗格/分隔条 count 0、空态标题「没有终端会话」、新建后折叠态保持）；`15-obsidian-reader › 激活 Obsidian tab 时文件窗格隐藏…`（分屏整体 count 0、切回按原折叠态恢复） |
| **FP-05** fallback 链 pwd → workdir → `/` | 真机 e2e + 单测 | `14-file-pane › 回跳准星…`（真沙箱 bash 上报 pwd = `/workspace`，窗格起手即它）；`src/lib/file-pane.test.ts` 的 `resolveFilePaneStartPath`（三级 + 兜底 `/`） |
| **FP-06** 无自动跟随 | 真机 e2e | `14-file-pane › 无自动跟随：终端里 cd 到别处…`（`cd /tmp` 后 tooltip 变 `/tmp`、窗格仍在根） |
| **FP-07** 回跳准星（tooltip / 已在目标禁用 / 点击 / pwd 不可得降级） | 真机 e2e + 单测 | `14-file-pane › 回跳准星…`（tooltip 全文、禁用、点击导航后再次禁用）；「未上报 pwd ⇒ 禁用 + tooltip 改文案」由 `FileBrowserPanel.test.tsx`（61 条）覆盖，**真机 sh 会话降级本轮未在 e2e 覆**（前序 01 打样已实测 `dash`/`sh` 自然降级） |
| **FP-08** 目录行进目录 + 面包屑（当前层纯文本 / 预览时恢复可点）+ 同路径强制度 | 真机 e2e + 单测 | `12-file-transfer › 面包屑回根后根 crumb 变静态…`（`SPAN` 不可点、零新增 list 请求）+ `› 上传…` ⑨（根 crumb → 点 `workspace` 目录行、`data-kind=dir`、目录行不触发下载）；`src/lib/file-transfer.test.ts` / `file-pane.test.ts` |
| **PV-01** 行单击即下载 + hover 行尾「预览」钮 | 真机 e2e + 单测 | 单击下载：`12-file-transfer › 上传…` ⑤（含 `Content-Length`、中文名、进度条观测）；hover 150ms 淡入 + `aria-label`：`FileBrowserPanel.test.tsx`（真机不做 hover 时序断言） |
| **PV-02** 第二视图 + 工具条 + 返回/Esc + 复制（成功零反馈） | 单测 | `FileBrowserPanel.test.tsx`（61 条：返回栈空不渲染、Esc、复制对勾 1s 复原与零 toast）——**本轮 e2e 未覆盖预览视图**（不在 08 要求的 QA-01 主链路里） |
| **PV-03** 窗格内 `.md` 纯文本 | 单测 | `FileBrowserPanel.test.tsx` + `src/lib/file-preview.test.ts` |
| **PV-04** >2MB 二次确认 + 进度条 + 不截断 + 小文件无进度条 | 单测 | `FileBrowserPanel.test.tsx` + `file-preview.test.ts`（大文件判定 `isLargePreviewFile` 用列表 `size`） |
| **PV-05** 二进制 / 非 UTF-8 空态 | 单测 | `FileBrowserPanel.test.tsx` |
| **PWD-01** 镜像 bashrc OSC 注入 + bump / 推送 | 既有落档 + 真机旁证 | `base-image/Dockerfile`（`ENV LANG/LC_ALL` L50-51；OSC 注入 L65-86）+ 任务 02 落档（commit `3708d26`）；本轮 e2e 全程用 **0.3.1** 镜像，`14-file-pane › 回跳准星…` 证明注入在真沙箱里生效 |
| **PWD-02** `bash -i` 实测上报；`dash`/`sh` 自然降级 | 既有落档 + 真机旁证 | bash 侧：`14-file-pane › 回跳准星…`（真沙箱上报 `/workspace`）；`dash`/`sh` 降级：任务 01 打样结论（`01-prototype-osc-loop.md`）与任务 02 实测，**本轮未重跑** |
| **PWD-03** xterm `registerOscHandler(1337)`、无逐帧 TextDecoder | 单测 + 源码指针 | `src/lib/terminal-pwd-xterm.test.ts`（5 条）+ `src/lib/terminal-pwd.ts` |
| **PWD-04** 独立纯函数模块 + 单测（绝对路径校验 + `normalizeContainerPath`） | 单测 | `src/lib/terminal-pwd.test.ts`（23 条） |
| **PWD-05** 纯前端按会话缓存、后端不加字段、重连刷新提示符 | 单测 + 后端契约 | `terminal-pwd.test.ts`；后端会话模型（`schemas.py` 的 `TerminalSessionModel`）**无 pwd 字段**；断线重连刷提示符由 `terminal-pwd` 与 03 轮既有用例覆盖 |
| **FS-01** 全屏对象 = tabs 下方整个内容区 | 单测 + 既有 e2e | `TerminalPanel.test.tsx`（全屏覆盖分屏整体）；终端侧真机：`03-terminal › 终端全屏…`（63 条全绿里）；**Obsidian 全屏无真机用例** |
| **FS-02** 全屏内 tabs 可见可切可退出 + 纯 CSS + 不落路由/存储 + 换沙箱退出 | 单测 + 既有 e2e | `TerminalPanel.test.tsx` + `Workbench.test.tsx`；`03-terminal › 终端全屏…`（真机退出复原） |
| **OBS-01** 最左固定 tab + 官方 logo 本地资产 + 不可关 + 零会话可用 | 真机 e2e | `15-obsidian-reader › 固定 tab…` ①~③（零会话 tab 仍在、`role=tab` 第一个就是它、同源 `/assets/*.svg`、tab 内 button 恰 1 个、无 close） |
| **OBS-02** 激活 Obsidian 时窗格隐藏 / 切回恢复 + 全宽双栏 + 细分隔线不可拖 | 真机 e2e | `15-obsidian-reader › 固定 tab…` ⑤（树/线/预览 x 序、线宽 ≤2px、无 `role=separator`）+ `› 激活 Obsidian tab 时…`（窗格与分屏 count 0、切回折叠态恢复） |
| **OBS-03** 引导态两入口（按钮 + 输入框） | 真机 e2e + 单测 | `15-obsidian-reader › 固定 tab…` ④（标题 / 按钮启用 / 输入框 / 空值「打开」禁用）+ ⑤（按钮路径设根成功）；输入框路径：`ObsidianWorkspace.test.tsx`（38 条），**真机只走按钮路径** |
| **OBS-04** 「vault 根：<路径>」+「更改」回引导预填 + 按沙箱本地记忆 | 真机 e2e + 单测 | `15-obsidian-reader › 固定 tab…` ⑤（`vault 根：/workspace` + 更改按钮可见）；预填与按沙箱记忆：`src/lib/obsidian-vault.test.ts`（26 条）+ `ObsidianWorkspace.test.tsx` |
| **OBS-05** 树形展开（箭头旋转 + 层级线）+ 只列目录与 `.md` + 展开态记忆 | 真机 e2e + 单测 | `15-obsidian-reader › 固定 tab…` ⑥（`.txt` 节点 0、目录展开 `rotate-90`、子层出现、收起消失）；展开态 localStorage：`obsidian-vault.test.ts` |
| **OBS-06** 渲染主视图 + 工具条（返回 / 名 / 大小 / 渲染源码 / 复制） | 真机 e2e + 单测 | `15-obsidian-reader › 点击 .md 渲染…` ②（`aria-pressed` 分段切换、源码态原文）+ ④⑤（返回钮随栈出现/消失）；复制对勾与零 toast：`ObsidianWorkspace.test.tsx` |
| **OBS-07** 620px 居中 + 排版 + frontmatter 渲染态隐藏 + 不放行原始 HTML | 真机 e2e + 单测 | `15-obsidian-reader › 点击 .md 渲染…` ①（内容列 ≤620 且左右留白差 ≤24px、渲染态无 `tags:`）+ ②（源码态可见 frontmatter）；HTML 不放行与排版：`src/lib/markdown.test.ts`（11 条） |
| **OBS-08** wikilink 三语法 + 强调色虚线下划线 + hover 黑底 tooltip 防裁切 | 真机 e2e + 单测 | `15-obsidian-reader › 点击 .md 渲染…` ③（`text-decoration` 含 underline 且 `dashed`、tooltip 文本 = `/workspace/acc-vault-note-b.md`）；三语法与防裁切：`wikilink.test.ts`（27 条）+ `tooltip-position.test.ts` |
| **OBS-09** 三级兜底 + 看门狗 + `normalizeContainerPath` | 单测 | `src/lib/wikilink.test.ts`（27 条：同目录 / 根相对 / BFS 同名 / 超时按未找到 / 归一） |
| **OBS-10** 命中压栈（可返回）/ 未命中就地错误条（可关、不跳转、不弹 toast） | 真机 e2e | `15-obsidian-reader › 点击 .md 渲染…` ④⑤⑥（压栈、返回钮、互链回跳）+ `› wikilink 目标不存在…`（文案、`role=alert`、在正文顶部、不跳转、无 toast、可关、正向对照） |
| **OBS-11** >2MB 与文件窗格同口径（同确认框 / 同进度条 / 全文不截断） | 单测 | 共用组件 `PreviewConfirmDialog` / `PreviewLoading` + `ObsidianWorkspace.test.tsx`；**真机未造 >2MB 夹具**（边界与 PV-04 共用一套逻辑，已在单测钉住） |
| **API-01** `GET …/files/read` + 复用分层探测 / exec 字节泵 + 令牌保护 + 单测齐备 | 单测 + 真机旁证 | `apps/web/backend/tests/test_server_files.py`（348 全绿里）+ `apps/core/tests/test_files.py`；真机读取走 UI：`15-obsidian-reader`（读 .md 成功）、令牌 401 由 `12-file-transfer › 负例…` 抽样 |
| **API-02** 流式正文 + 响应头元信息（二进制标记 / 总字节 / 截断声明）+ `max_bytes` 仅防护 | 单测 | `apps/web/backend/tests/test_server_files.py`（响应头断言）；前端按列表 `size` 请求全量：`src/api/client.ts` + `FileBrowserPanel.test.tsx` |
| **API-03** 路径校验（绝对 / 拒 NUL / 词法，不拦 `..`）+ `{"detail": "中文"}` + 文案体系 | 真机 e2e + 单测 | `12-file-transfer › 负例…`（相对路径 400 文案、下载目录 400、上传到目录 400、停止 409、无令牌 401）；核心 `test_files.py` / `test_transfer.py` |
| **ENV-01** Dockerfile `LANG` / `LC_ALL` = `C.UTF-8` + bump + verify + 交互 shell 实测 | 既有落档 + 真机旁证 | `base-image/Dockerfile` L50-51 + 任务 02 落档（commit `3708d26`）；本轮 e2e 全部跑在 **0.3.1** 上（locale 生效是沙箱可用性的前提，任务 02 已实测 `LANG`/`LC_ALL`） |
| **ENV-02** 容器 env `SANDBOX_NETWORK`（创建 + 重启两条路径）+ 不入 metadata / 不掩码 | 单测 | `apps/core/tests/test_network_env.py`（429 全绿里） |
| **QA-01** 门禁全绿 + e2e 主链路 | ✅ 本轮实测 | 见「一」「二」：e2e **63/63**、核心 **429**、服务端 **348**、vitest **919**、双 typecheck **0 错**、build ✅、cargo **47** |
| **QA-02** 文档同步 + 38 条核销 + RESULTS.md | ⏳ archivist | 本表 + 「三」的完成标准表；文档面待 archivist 落笔 |

**未在真机 e2e 覆盖的条目（核销时按「单测 / 既有落档」定性，不按「真机实证」）**：PV-02 ~ PV-05（预览第二视图整块）、OBS-03 的输入框路径、OBS-11 的 >2MB 真机流程、PWD-02 的 `dash`/`sh` 降级、FS-01 的 Obsidian 全屏。理由：08 的 e2e 范围锁定 PRD **QA-01** 主链路（窗格三分屏 / 折叠 / 空态 / Obsidian 双栏 / wikilink / 错误条），上述条目由单测与 01/05/06/07 轮的既有真机记录兜住。

> **落档补记（2026-11-14，archivist 文档收口）**：上表 3~7 条已随文档收口全部完成——PRD **38 / 38** 核销（[[prds/file-pane-obsidian.md|PRD]] 验收标准节，证据三档标注）；`API.md` 16.7 经核实**已于 05 轮落库**（无需补）；词汇表补 5 词条、[[conventions/console-frontend.md|前端约定]] 补 4 条、[[architecture/decisions/0004-镜像契约与默认沙箱镜像.md|ADR 0004]] 追加修订行（2026-11-14，历史表述不改写）、看板与两份清单同步、[[tasks/file-pane-obsidian/RESULTS.md|RESULTS]] 落库。本任务 status → done，全轮 01~08 done。**开口仅剩：存量沙箱重建 `base:0.3.1` 与用户浏览器端复验，待用户执行。**

### 四、遇到的问题

1. **终端会话是宿主侧持久资源，同一沙箱上限 5 个**（`DEFAULT_MAX_SESSIONS_PER_SANDBOX = 5`，`terminal.py`）。同一 spec 文件里多条用例共用一个沙箱时会看到彼此留下的会话：`关闭全部会话` 用例先失败在「关掉一条还有别的」，`会话切换` 用例失败在「新建第 6 个会话被上限拒」。**处置（测试侧，不改产品）**：`tests/helpers/api.ts` 新增 `clearTerminalSessions(sandbox)`，spec 14 / 15 加 `beforeEach` 清场；`12-file-transfer` 不受影响（每条用例最多 2 个会话）。**这不是产品缺陷**，是 e2e 的共享资源纪律，已写进 helper 注释。
2. **窗格没有「关掉再打开」**：12 的负例原本靠 `Escape` 关抽屉再重开触发重读；窗格形态下只能靠**导航**（点根面包屑）强制重读。已改写，断言强度不变（就地错误态仍展示后端 detail 原文）。
3. **Obsidian tab 图标的「本地资产」断言不能判 `src` 前缀**：页面 origin 是静态源（`http://127.0.0.1:8200`），打包后的资产 src 自然是**绝对 URL**。改为「与页面同源 + 落在 `/assets/*.svg`」，这样「运行时零 CDN」的口径才判得准（远端 CDN 会因 origin 不同而红）。
4. **一次性发现**：宿主还留着一张 **2026-10-30** 的 `sandbox-console-acceptance/local-only-a4b2e8cb:0.1.0` 旧镜像（早于本轮任何一次运行）。本轮 teardown 确实删掉了**本轮**构建的镜像；旧残留属历史，未清理（不在本任务范围，留给需要的人判断）。
5. **产品 bug：0 条**。e2e 全程没有暴露需要回头修的业务缺陷；`docs/` 下除本文件外未动，`git` 未提交。

## 依赖

- 依赖 [[tasks/file-pane-obsidian/01-prototype-osc-loop.md|01]]、[[tasks/file-pane-obsidian/02-image-ps1-injection.md|02]]、[[tasks/file-pane-obsidian/03-frontend-pwd-channel.md|03]]、[[tasks/file-pane-obsidian/04-file-pane-split.md|04]]、[[tasks/file-pane-obsidian/05-file-preview.md|05]]、[[tasks/file-pane-obsidian/06-obsidian-tab.md|06]]、[[tasks/file-pane-obsidian/07-markdown-wikilink.md|07]] **全部完成**。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
