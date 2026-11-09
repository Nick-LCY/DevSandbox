---
prd: prds/runtime-file-transfer.md
status: done
---
# 任务：前端文件浏览面板

> 需求见 [[prds/runtime-file-transfer.md|运行期文件传输 PRD]]。**依赖 03 的接口契约**；与 05 可并行。
>
> **与实测口径的同步（2026-11-09）**：XHR 上传与图标 vendor **均不变**；唯一涉及文案的调整是「**上传目标若是已存在目录**」——服务端会前置拒绝（400），前端按固定中文文案提示，**不弹覆盖确认框**。**03 轮服务端另新增一条上传口径**：服务端按请求头 `Content-Length` 定期望字节数，**有长度头时**会在容器内 `mv` 之前核对实际字节数（不符 ⇒ **400**「上传中断，目标文件未完整写入」，**目标保持原样**）——**无长度头（chunked）时不核对**，此时客户端中断仍可能在目标路径留下半截文件。接口口径依据 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]]。

## 目标

在控制台工作台里给运行中的沙箱加一个**迷你文件管理器**：入口按钮 → 独立文件浏览抽屉 → 面包屑 + 列表 → 上传 / 下载 / 进度 / 覆盖确认。

## 涉及文件

- 改 `apps/web/frontend/src/api/client.ts` — 加 **raw 上传 / blob 下载 / list** 三种请求能力（**注意既有 `request()` 固定 json 的坑**：上传显式 `application/octet-stream`）
- 新增 `apps/web/frontend/src/lib/file-transfer.ts` — 纯逻辑（路径校验、文件名解析、大小格式化、列表排序）
- 新增 `apps/web/frontend/src/components/workbench/FileBrowserPanel.tsx`（或等价位置）— 面板组件
- 改 `apps/web/frontend/src/components/workbench/` 的沙箱操作区 — 加「**文件**」按钮
- 改 `apps/web/frontend/src/components/ui/drawer.tsx` 既有外壳的调用处 — **复用 `DrawerShell`**，不新造抽屉
- 新增前端资产目录 — 图标 **SVG 子集**（vendor 进仓库，**不用运行时 CDN**）+ 兜底 `folder.svg` / `file.svg`
- 新增测试 — 纯逻辑单测 + 组件测试
- 改 `apps/web/frontend/README.md` — 标识表登记新标识

## 交互口径（逐条对齐用户拍板 + demo 验证结论）

- **入口**：工作台沙箱操作区的「**文件**」按钮，与「详情」「停止」**同级** → 打开**独立文件浏览抽屉**（不塞进沙箱详情抽屉）。
- **列表三列**：**图标 + 名称** / **大小** / **修改时间**——**无类型列**；**文件夹在前**按名称排序；**隐藏文件（`.` 开头）显示**。
- **点击文件行本身即下载**：无下载按钮。
- **界面一律不加副标题 / 解释说明性文字**（见 [[conventions/console-frontend.md|前端约定]] 新增的两条）。
- **面包屑**各级可点击，**不重复展示纯文本形式的当前目录**。
- **上传**：只能传进**当前浏览目录**（**无手动路径输入框**）；行内**进度条** + **可取消**；目标同名时弹**覆盖确认框**（走既有 `ModalShell`）。
- **同名目标的两种情形要分开**：同名**普通文件** → 弹**覆盖确认框**；同名**目录** → 服务端**前置拒绝**（400），前端直接展示服务端的固定中文文案，**不弹覆盖确认框**（实测：`mv` 对目录目标会 rc=0 假成功、文件被搬进目录里，服务端必须先拦）。
- **上传被中断 / 字节数不符**：服务端回 **400**「上传中断，目标文件未完整写入」（**目标文件保持原样**，不会留半截文件）——前端按**上传失败**处理（展示服务端的中文 detail、结束进度条、**不弹覆盖确认框**）。**前提**：浏览器发请求时带了 `Content-Length`（XHR 用 `File` / `Blob` 作 body 时会带）⇒ 服务端才有期望值可核对；**无长度头时不核对**（残余风险，见顶部口径）。
- **进度条必须有**：上传用 **XHR**（fetch 拿不到上传进度事件）；下载按 `Content-Length` + 流式读取计算。
- **下载分形态**：
  - **web 形态** = `fetch` → blob → `a[download]`；**不得导航 blob: URL**（桌面 CSP 只在 `img-src` 放行 blob）；
  - **桌面形态** = 走 05 轮的桌面 IPC（本轮先留接口位，形态分支在 05 收口）。
- **上传两形态完全共用** `<input type="file">`（WebView2 原生可用），**Rust 上传零改动**。

## 图标资产

- 风格：material-icon-theme（vscode-material-icon-theme）。
- **把所需 SVG 子集 vendor 进前端仓库构建资产**——**不用运行时 CDN**（桌面 CSP 与离线场景都不允许）。
- 素材来源与映射口径已在视觉 demo 中验证：CDN tag `v5.40.0`、108 个图标逐一验证可用；**该版本没有通用 `folder.svg` / `file.svg` 与 `*_open` 变体**。
- **通用兜底图标 = 用户提供并已验证的 `folder.svg` / `file.svg`**：现暂存**仓库根目录**，本任务负责**移入前端资产目录**并接入映射；「展开态」用样式表达（不找 `*_open` 变体）。
- 视觉底座沿用控制台既有 token（**组件里不写裸色值**）。

## 完成标准

- [x] 工作台沙箱操作区有「**文件**」按钮，与「详情」「停止」**同级**，打开**独立文件浏览抽屉**（复用 `DrawerShell`）——入口 `page-sandbox-detail-files-button`（`WorkspaceHeader`，与「详情」「停止」同一排按钮），抽屉 `page-file-browser-dialog`（标题「文件」，共用三抽屉的宽度存储）。
- [x] 列表**三列**：图标 + 名称 / 大小 / 修改时间——**无类型列**；文件夹在前按名称排序；**隐藏文件显示**——三列网格 `rowGrid`；`sortFileEntries` 文件夹在前（同类按 numeric + 忽略大小写）；`.` 开头照常列出；大小 / 修改时间走 `font-mono tabular-nums`。
- [x] **点击文件行本身即下载**，不另加下载按钮——行是 `role="button"`（Enter / Space 同效），目录行进目录、文件行直接下载；行内只有取消上传这一个图标按钮。
- [x] **界面无副标题、无解释说明性文字**——抽屉只有标题「文件」；无说明段、无「点击下载」类提示。
- [x] **面包屑**各级可点击，**不重复展示纯文本形式的当前目录**——根目录图标按钮 + 各级名称按钮（`data-depth`），当前级用 `aria-current="page"` + 高亮表达，**没有**纯文本当前路径。
- [x] 上传**只能传进当前浏览目录**（**无手动路径输入框**）；行内**进度条** + **可取消**；同名**普通文件**弹**覆盖确认框**，同名**目录**走服务端 400 的固定中文文案（**不弹确认框**）——目标目录取当前 `pathRef`；同名目录不弹框、直接把后端 `detail` 交 toast；列表快照不可信（读取中 / 刚失败）时**先重读目录再判定**，不拿空列表当「无同名」。
- [x] **进度条必有**：上传用 XHR；下载按 `Content-Length` + 流式读取计算——XHR `upload.progress` + **120 s 无进度看门狗**（`UPLOAD_STALL_TIMEOUT_MS`；不用 `xhr.timeout`，避免与「大小不限」冲突）；下载按 `Content-Length` + `getReader()` 逐块累计。
- [x] web 形态下载 = `fetch` → blob → `a[download]`，**不导航 blob: URL**；上传两形态**共用 `<input type="file">`**——`saveBlob`（`createObjectURL` → `a[download]` → 延迟 1 s revoke）；隐藏的 `<input type="file" multiple>` 两形态共用，Rust 侧零改动。
- [x] `client.ts` 的三种新请求能力落地（**上传显式 `application/octet-stream`，绕开既有「固定 json」的坑**）——`api.uploadFile` / `api.downloadFile` / `api.listFiles`；上传显式写 `Content-Type: application/octet-stream`。
- [x] 纯逻辑收敛在 `src/lib/file-transfer.ts`（路径校验、文件名解析、大小格式化、列表排序）并有单测——另含子路径 / 面包屑切分 / 百分比 / 图标映射；`file-icon-assets.ts` 只做资产表，单测 19 个用例。
- [x] 图标：material-icon-theme 风格；**SVG 子集已 vendor 进前端构建资产**（**无运行时 CDN**）；**根目录 `folder.svg` / `file.svg` 已移入前端资产目录**并接入兜底映射——共 **113 个 SVG**（v5.40.0 的 111 个 + 用户提供的两个），`import.meta.glob` 构建期收集，根目录两个已移入。
- [x] 新增标识按 `page-<页面>-<元素>` 规范登记进 `apps/web/frontend/README.md` 标识表——`page-file-browser-*` 全组 + 入口 `page-sandbox-detail-files-button`，并登记 toast 来源 `file-browser`。
- [x] 门禁：前端 **vitest 全绿**、**typecheck 零错**、**build 通过**——**633 passed**（基线 584 → **+49**）/ `typecheck` 与 `typecheck:tests` 零错 / build 成功；后端配套 **330 passed**（+1 CORS 断言）、**ruff rc=0**。
- [x] 遵守 [[conventions/console-frontend.md|前端约定]]全部既有条目（令牌色、toast、`data-testid`、抽屉外壳、纯逻辑收敛）——组件内无裸色值；操作结果走 toast（来源 `file-browser`）；目录读取失败按「就地环境状态」（`page-file-browser-error`，`role="alert"`）展示，已补进约定的豁免清单。

## 依赖

- 依赖 [[tasks/runtime-file-transfer/03-server-file-endpoints.md|03 服务端文件传输接口]]（接口契约）。
- 与 [[tasks/runtime-file-transfer/05-desktop-download.md|05 桌面端下载落盘]] **可并行**；桌面形态分支在 05 落地后接通。
- 视觉底座沿用 [[conventions/console-frontend.md|前端约定]]；图标风格与 demo 验证结论见 PRD「前端」节。
- 接口口径（错误文案 / 目录目标拒绝）依据 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018 运行期文件传输机制选型]]。

---

## 进展（2026-11-09）

> **本轮状态：done（实现 + 审查修复一轮 + 门禁全绿）。** 「文件」入口 → 独立文件抽屉
> （面包屑 + 三列列表 + 上传 / 下载 / 进度 / 覆盖确认）全部落地；图标资产本地化
> **113 个 SVG**（运行时零 CDN）；后端配套 CORS `expose_headers`。桌面下载**留桩**
> （`TODO(05)`，无行为），05 轮接线。

### 交付物

| 文件 | 改动 |
|---|---|
| `apps/web/frontend/src/components/workbench/FileBrowserPanel.tsx` | **新建**：独立文件抽屉（`DrawerShell`）——面包屑导航、三列列表、上传队列（进度 / 取消 / 覆盖确认）、并行下载（行内进度）、关闭与切沙箱的全量收口 |
| `apps/web/frontend/src/components/workbench/FileBrowserPanel.test.tsx` | **新建**：组件用例 **20 个**（三列 / 排序 / 隐藏文件、面包屑导航、点行下载、列表失败就地态、上传 / 排队 / 取消 / 覆盖确认 / 同名目录、关闭收口、并行下载、桌面桩） |
| `apps/web/frontend/src/components/workbench/WorkspaceHeader.tsx` | 改：「文件」按钮（`onOpenFiles`，`page-sandbox-detail-files-button`），与「详情」「停止」同级 |
| `apps/web/frontend/src/components/workbench/Workbench.tsx` | 改：`filesOpen` 状态 + 面板挂载；`initialPath` 取**沙箱详情里的容器内 `workdir`**（缺省 `/`）；切沙箱时先关抽屉 |
| `apps/web/frontend/src/api/client.ts` | 改：`api.uploadFile`（XHR raw body + 进度 + **120 s 无进度看门狗** + abort）、`api.downloadFile`（fetch 流式读取 + 进度 + 返回 `Content-Disposition` 原文）、`api.listFiles` |
| `apps/web/frontend/src/api/client.test.ts` | 改：**+9** 用例——列表参数编码、上传 octet-stream / Bearer / raw body / 进度、上传失败取 `detail`、**停滞看门狗**、慢速但持续有进度不被误杀、令牌缺失不发 XHR、下载流式与 `Content-Disposition`、进度回抛错先 `cancel`、下载失败取 `detail` |
| `apps/web/frontend/src/api/types.ts` | 改：`FileListEntry` / `FileUploadResponse` 类型 |
| `apps/web/frontend/src/lib/file-transfer.ts` | **新建**：纯逻辑（路径归一与子路径、面包屑切分、`Content-Disposition` 文件名解析、大小 / 时间格式化、排序、图标映射、百分比） |
| `apps/web/frontend/src/lib/file-transfer.test.ts` | **新建**：纯逻辑单测 **19 个**（含**图标映射与资产文件双向一致**） |
| `apps/web/frontend/src/lib/file-icon-assets.ts` | **新建**：图标资产表（`import.meta.glob` 构建期收集 → URL） |
| `apps/web/frontend/src/assets/file-icons/` | **新建**：**113 个 SVG** + `README.md`（来源、验证方式、兜底口径） |
| `apps/web/frontend/src/components/workbench/Workbench.test.tsx` | 改：入口按钮与抽屉联通用例 |
| `apps/web/frontend/README.md` | 改：标识表（`page-sandbox-detail-files-button` / `page-file-browser-*`）、toast 来源 `file-browser`、就地错误态豁免、目录树与测试说明 |
| `apps/web/backend/src/sandbox_console/auth.py` | 改：`CORS_EXPOSED_HEADERS = ("Content-Disposition",)`（见「偏离」） |
| `apps/web/backend/src/sandbox_console/app.py` | 改：`CORSMiddleware(..., expose_headers=list(CORS_EXPOSED_HEADERS))` |
| `apps/web/backend/tests/test_server_auth.py` | 改：**+1** 断言——CORS 预检 / 实际响应带 `access-control-expose-headers: Content-Disposition` |
| `docs/conventions/console-frontend.md` | 改：就地展示豁免补「文件面板目录读取失败」+ 文件面板反馈口径（操作结果 toast、来源 `file-browser`） |

### 八条硬约束核验

| # | 用户硬约束 | 落地 | 证据 |
|---|---|---|---|
| 1 | **界面无说明文字** | 抽屉只有标题「文件」；无副标题、无说明段、无「点击下载」提示 | 面板渲染结构；标识表里没有任何说明性文案位 |
| 2 | **点行即下载** | 文件行 `role="button"`，点击 / Enter / Space 直接下载；行内无下载按钮 | 用例「目录行点击进入；文件行点击下载（行本身就是操作）」 |
| 3 | **面包屑纯交互** | 根目录图标按钮 + 各级名称按钮（`data-depth`）+ `aria-current="page"` 高亮；**没有**纯文本当前路径 | 用例「面包屑各级可点击，点上级目录重新读取列表」 |
| 4 | **三列 + 隐藏文件** | 名称（图标 + 名称）/ 大小 / 修改时间，**无类型列**；文件夹在前按名称；`.` 开头照常显示；数字等宽 | 用例「三列：文件夹在前按名称排序、隐藏文件显示、大小与时间等宽」+ 纯逻辑排序用例 |
| 5 | **上传限当前目录 + 进度取消 + 覆盖确认** | 只有隐藏的 `<input type="file" multiple>`（无路径输入框）；行内进度条 + 取消；同名**普通文件**弹 `ModalShell` 确认；同名**目录**不弹框、吃服务端 400 文案 | 用例「选文件即上传到当前目录…」「同名普通文件：先弹覆盖确认…」「同名目录：不弹覆盖确认，服务端 400 的 detail 原样 toast」「取消上传…」「多文件逐个排队上传」 |
| 6 | **双向进度** | 上传 `XMLHttpRequest.upload.progress`（fetch 拿不到上传进度）+ 120 s 无进度看门狗；下载 `Content-Length` + `getReader()` 逐块累计 | `client.ts` 的 `UPLOAD_STALL_TIMEOUT_MS` / `downloadFileWithProgress`；`client.test.ts` 用例「上传停滞看门狗…」「慢速但持续有进度的上传：看门狗随 progress 重置」；组件用例「按 Content-Length 报进度…」 |
| 7 | **web 用 blob、不导航 blob:** | `saveBlob`：`createObjectURL` → `a[download]` → 延迟 1 s revoke；**不** `location.href = blob:` | 用例「完成后 blob → a[download]（不导航 blob: URL）」 |
| 8 | **后端 `detail` 原样 toast** | 上传失败 / 下载失败 / 同名目录 400 一律把后端中文 `detail` 原文交给 toast；本地只造「上传停滞」「文件名不合法」两条本地判定文案 | 用例「上传失败：错误 toast 用后端 detail 原文」「下载失败：…」「同名目录：…」 |

### 审查一轮 + 修复一轮（2026-11-09）

审查结论「**需修复后合入**」：**2 Critical + 若干 Warning**。

| 级别 | 问题 | 处置 |
|---|---|---|
| **Critical ①** | **`initialPath` 错拿宿主家目录**——入口把宿主侧目录填给了「容器内路径」，抽屉一打开就读错目录 | 改为取**沙箱详情里的容器内 `workdir`**（`detail?.workdir?.trim() || '/'`），缺省根目录 |
| **Critical ②** | **覆盖确认快照绕过**——同名判定用的是抽屉里的列表快照；列表正在读 / 刚读失败时快照为空，会**静默覆盖**而不弹确认框 | 快照不可信（读取中 / 刚失败 / 路径对不上）时**先重读当前目录**，拿到可信列表再判定；读不出来就取消本次上传并提示（不拿空列表当「无同名」）。入队时为每个文件定格目标目录与同名条目 |
| Warning / 配套 | 跨源读不到 `Content-Disposition`（浏览器只把安全列表头交给 JS） | 后端补 CORS `expose_headers`（只增一个响应头，见「偏离」） |
| Warning / 配套 | 其余 Warning 与配套项 | 合计 **12 项清单全部落地**（含上传队列与覆盖确认框的收口、关闭时的在途 abort、图标兜底样式等） |

**修复后新增的钉子用例**：「列表还在加载时入队：先重新加载该目录，同名仍弹覆盖确认（不静默覆盖）」「覆盖确认框等待时取消上传：关框、只弹取消提示，不多发『已跳过』」「关闭抽屉：abort 在途上传、清空队列；重开不显示上一个沙箱的行」「关闭抽屉：在途下载的 AbortController 也被取消，行内进度清掉」。

### 最终门禁

| 门禁 | 结果 |
|---|---|
| 前端 `pnpm test`（vitest） | **633 passed**（基线 **584** → **+49**） |
| 前端 `pnpm typecheck` / `typecheck:tests` | **零错** |
| 前端 `pnpm build` | **通过** |
| 后端 `pytest`（CORS 配套） | **330 passed**（基线 329 → **+1**：`test_server_auth.py` 断言 `expose_headers` 带 `Content-Disposition`） |
| 后端 `ruff` | **rc=0** |

### 图标资产口径

- **113 个 SVG = 111 + 2**：`material-icon-theme` **v5.40.0**（jsdelivr tag）的 **111** 个——按 `src/lib/file-transfer.ts` 的映射表去重后逐个下载，**逐个校验 HTTP 200 且响应以 `<svg` 开头**；该版本**没有**通用 `folder.svg` / `file.svg`，也没有 `*_open` 变体（展开态用样式表达）。
- **通用兜底**：`folder.svg` / `file.svg` 由**用户提供并验收**（原先暂存仓库根目录），本轮**移入** `apps/web/frontend/src/assets/file-icons/`，映射表里未知扩展名 → `file`、未知目录名 → `folder`。
- **运行时零 CDN**：资产表 `src/lib/file-icon-assets.ts` 用 `import.meta.glob(..., { eager: true, query: '?url' })` 在**构建期**收集成 URL；桌面 CSP 与离线场景都成立。
- **双向一致性用例**：`FILE_ICON_URLS` 的键集合与映射表（`EXT_ICON` / `NAME_ICON` / `FOLDER_ICON` + 兜底 `file` / `folder`）的值集合**逐名相等**——新增映射漏放 SVG、或目录里多了孤儿资产，都会红。
- 目录内 `README.md` 记录来源、验证方式与兜底口径。

### 桌面下载桩

- `desktop` 为真时 `startDownload` **直接 return**（注释 `TODO(05)`：原生「保存为」→ Rust 带令牌落盘）；不发请求、不画进度、不弹提示，**无行为**。
- 用例「桌面分支留桩：本轮不调下载接口（05 轮接原生保存框 + Rust 落盘）」钉死现状；[[tasks/runtime-file-transfer/05-desktop-download.md|05 轮]]接线时替换该分支。

### 偏离与其它口径

- **`expose_headers` 落点在 `app.py`（+ `auth.py` 常量）**：任务书写「CORS 白名单零改动」——**白名单**（来源 / 方法 / 请求头）确实零改动，但**跨源读 `Content-Disposition` 必须登记 `expose_headers`**：不登记的话浏览器不会把这个头交给前端 JS，文件名解析永远是死代码（跨源部署下中文文件名回退成条目名）。改动为**只增一个响应头**：`CORS_EXPOSED_HEADERS = ("Content-Disposition",)` ⇒ `app.py` 的 `CORSMiddleware(..., expose_headers=list(CORS_EXPOSED_HEADERS))`；后端补 **+1** 断言。
- **列表读取失败是面板状态，不是 toast**：`page-file-browser-error`（`role="alert"`）就地展示后端 `detail`——toast 5 秒即逝，空列表面板会失去解释。已补进 [[conventions/console-frontend.md|前端约定]]的「六处豁免」清单（改为七处）与文件面板反馈口径；**操作结果**仍一律 toast，来源标识固定 `file-browser`。
- **上传看的是「进度停顿」不是总时长**：不用 `xhr.timeout`（那会与「大小不限」冲突）；连续 **120 s 无 progress 事件**才取消，慢而持续有进度的上传不会被误杀。
- **按声明长度裁剪在服务端**：前端按读到的字节累计进度，不重复裁剪；响应体与 `Content-Length` 的一致性由 03 轮的下载流裁剪保证（`iter_download_chunks`）。
- **关闭抽屉 / 切沙箱全量收口**：`abortTransfers()` 递增**会话代次** → abort 全部在途上传 / 下载 → 清队列、覆盖确认框与进度行；旧代次的异步收尾（成功提示 / 列表刷新 / 进度清理）据此静默退出，不会串到重开后的抽屉。切沙箱时工作台先 `setFilesOpen(false)`，走同一条收口路径。
