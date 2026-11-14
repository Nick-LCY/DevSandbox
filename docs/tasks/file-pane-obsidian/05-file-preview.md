---
prd: prds/file-pane-obsidian.md
status: done
---
# 任务：文件窗格文本预览

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **依赖 04**（预览是窗格内的第二视图，窗格骨架先落地）。
> **2026-11-13 口径修订**：大文件预览由「2 MB 截断 + 提示条」改为「**二次确认 + 进度条加载 + 全文渲染**」。

## 目标

给文件窗格加**文本预览**能力：一条**只读**后端端点 + 窗格内的第二视图。

### 后端（只读端点）

- 新增 **`GET /api/sandboxes/{name}/files/read`**，查询参数 **`path`** 与 **`max_bytes`**；
- **正文按流式字节返回**（复用下载通道的流式形态）；**二进制标记 / 截断声明 / 总字节数等元信息走响应头**——前端拿到响应头即可**先判二进制早退**，再按「**已接收字节 / 响应头中的总大小**」驱动**进度条**（既有下载通道已有同款「fetch 流式读 + 按 `Content-Length` 算进度」的实现先例）；
- **复用核心包既有分层探测**（普通文件放行、FIFO / 设备 / 套接字一律拒——防挂起）与 **exec 字节泵能力**；
- 读**首块**做 **NUL 嗅探**，命中则在响应头给出**二进制标记**；
- **`max_bytes` 语义保留为防护性上限**：超限仍截断并在响应头**声明截断**；但**正常流程前端按文件列表条目的 `size` 字段请求全量**——截断提示条 UI 删除后，**前端正常路径永远不应看到截断声明**；
- **路径校验沿用既有口径**：绝对路径 + 拒 NUL + 词法校验，**不拦 `..`**（容器内权限由容器自身决定，[[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]] 既定）；
- **错误固定中文文案沿用传输轮文案体系**（`{"detail": "<中文>"}`，stderr 原文只进日志）。

### 前端（预览视图）

- **预览 = 窗格内的第二视图**（不是弹层、不是抽屉）；
- 文件行**单击仍即下载**（既有口径不变）；**hover 文件行**时行尾浮现「**预览**」眼睛图标按钮（约 **150ms** 淡入、带 `aria-label`、**不带文字**）；
- 预览工具条 = **返回** + 文件名 / 大小 + **复制**；**返回栈为空时隐藏返回钮**；`Esc` 与返回按钮等价；
- 正文**等宽字体 + 行号槽**；
- **`.md` 一律按纯文本预览**，**文件窗格内无 markdown 渲染**；
- **复制**：图标变**对勾**约 **1 秒**后复原，**成功零 toast**、**失败才 toast**；
- **大文件（>2 MB）= 二次确认 + 进度条 + 全文渲染**：
  - 判断依据 = **文件列表条目的 `size` 字段**（int 字节数）；
  - 点击预览时若**超过 2 MB**，先弹**二次确认对话框**（提醒内容超过 2 MB、是否要预览；**确认才发起读取**，**取消不发起请求**）；
  - 确认后以**进度条**加载（进度 = **已接收字节 / `size`**），加载完成渲染**全文**；
  - **不再有任何「文件过大，仅展示前 N KB」提示条**；
  - **小文件直接加载、不出现进度条**；
- **二进制 / 非 UTF-8**：渲染**空态构图**（居中线框图标 +「**二进制文件无法预览**」+ 描边「**下载文件**」按钮）。

## 涉及文件

- 核心包（路径校验 / 分层探测 / 字节泵复用）— 新增只读读取能力（**流式正文 + 响应头元信息**）
- 后端 `apps/web/backend/` — 新增只读端点 + 固定中文文案
- 后端 `apps/web/backend/API.md` — 新端点章节
- `apps/web/frontend/src/api/client.ts` — 新增只读请求能力（**流式读取 + 响应头元信息**）
- `apps/web/frontend/src/components/workbench/FileBrowserPanel.tsx` — 预览视图 / 返回栈 / 复制 / **大文件二次确认对话框 + 进度条** / 二进制空态
- `apps/web/frontend/src/lib/` — **大文件判定、进度换算**、复制等纯函数 + 单测
- `apps/web/frontend/README.md` — 标识表登记

## 完成标准

- [x] 端点 **`GET /api/sandboxes/{name}/files/read`** 存在，**复用核心包既有分层探测**（普通文件放行、FIFO / 设备 / 套接字拒）与 **exec 字节泵**；端点挂在 `/api` 下即**被令牌中间件自动保护**（无令牌 / 错令牌 401）；**服务端与核心包单测齐备**（对应 PRD 验收项 **API-01**）。
- [x] 响应**正文为流式字节**、**元信息走响应头**：响应头给出**二进制标记**（首块 NUL 嗅探）、**总字节数**与（超限时）**截断声明**；`max_bytes` **仅为防护性上限**，**正常流程按列表 `size` 请求全量**、**前端不应看到截断声明**（对应 PRD 验收项 **API-02**）。
- [x] 路径校验沿用既有口径（**绝对路径 + 拒 NUL + 词法校验，不拦 `..`**）；错误形状 `{"detail": "<中文>"}`、文案沿用传输轮文案体系，**stderr 原文只进日志不回显**（对应 PRD 验收项 **API-03**）。
- [x] 文件行**单击即下载**（既有下载通道与进度 UI **零改动**）；hover 文件行时行尾浮现「预览」眼睛按钮（约 **150ms** 淡入、带 `aria-label`、**不带文字**）（对应 PRD 验收项 **PV-01**）。
- [x] 预览是**窗格内的第二视图**（非弹层、非抽屉）；工具条 = 返回 + 文件名 / 大小 + 复制；正文**等宽字体 + 行号槽**；**返回栈为空时隐藏返回钮**；`Esc` 与返回按钮等价（对应 PRD 验收项 **PV-02**）。
- [x] 窗格内 **`.md` 按纯文本预览**，**无任何 markdown 渲染**（对应 PRD 验收项 **PV-03**）。
- [x] **复制**点击后图标变**对勾**约 **1 秒**后复原，**成功零 toast**、**失败才 toast**（对应 PRD 验收项 **PV-02**）。
- [x] **大文件（>2 MB）不截断**：先弹**二次确认对话框**（提醒超过 2 MB、是否预览；**确认才发起读取**、**取消不发起请求**）；确认后以**进度条**加载（进度按**已接收字节 / 列表条目 `size`**），加载完成渲染**全文**；**界面上不存在任何「文件过大，仅展示前 N KB」提示条**；**小文件直接加载、不出现进度条**（对应 PRD 验收项 **PV-04**）。
- [x] **二进制文件**渲染**空态构图**（居中线框图标 +「**二进制文件无法预览**」+ 描边「**下载文件**」按钮）；**非 UTF-8 解码失败**同样按「无法展示」处理（对应 PRD 验收项 **PV-05**）。
- [x] `API.md` 补新端点章节；前端**标识表**登记新标识。

## 进展（2026-11-14 实现轮）

> **范围**：核心包（`transfer.py` + 单测）、后端（路由 / 编排 / 单测 / `API.md` / CORS 暴露头）、前端（接口层 + 窗格预览视图 + 纯逻辑 + 单测 + `README.md` 标识表）与本任务文件。
> **未碰**并行 agent 的领地（`TerminalPanel.tsx` / `TerminalTabs.tsx` / `terminal-pwd.ts` / base-image）；**`docs/` 下只动本文件**；**未 `git commit`**。
> **`apps/web/frontend/README.md` 本轮由本 agent 独占编辑**（已登记全部新标识，见第四节）。

### 一、响应头头名定稿

| 响应头 | 取值 | 语义 |
|---|---|---|
| `X-File-Binary` | `true` / `false` | **二进制标记**（**首块** NUL 嗅探；默认嗅探窗口 64 KiB，且不超过 `max_bytes`）。**总是出现**（前端按布尔判定，不用「有无头」当语义） |
| `X-File-Size` | 非负整数 | **总字节数**（核心包 `stat -L -c %s` 探测值，跟随符号链接）。探测不到时**不出现** |
| `X-File-Truncated` | `true` | **截断声明**：**只在真的截断时出现**（缺省即不截断；不出现 ≠ 没有截断语义的歧义由文档钉死） |
| `Content-Length` | 非负整数 | 响应体字节数 = `min(总字节数, max_bytes)`；声明值与服务端裁剪上限取**同一个值**（沿用下载通道那套「响应体永不超过声明长度」的口径） |
| `Content-Type` | `application/octet-stream` | 固定原始字节（不做内容嗅探；UTF-8 解码在前端） |

跨源要能读这三个自定义头 ⇒ `CORS_EXPOSED_HEADERS` 由 `("Content-Disposition",)` 扩为四元组（`auth.py`），服务端测试同步钉住（`test_server_auth.py::test_cors_exposes_content_disposition_for_downloads`）。

### 二、`max_bytes` 缺省行为（定稿）

- **不传 = 不截断**：按文件实际大小读到 EOF。理由写进了 `API.md` 16.7 与代码注释——正文本来就是**流式**（内存有界），而本端点服务的「大文件预览」语义是**不截断**（二次确认 + 进度条 + 全文渲染，PRD PV-04 / OBS-11）；给默认上限会把「全量预览」变成「悄悄只看一截」，而界面上**不允许**出现「文件过大，仅展示前 N KB」的提示条。
- **`max_bytes` 是正整数**：`0` / 负数 ⇒ **400 +「max_bytes 非法：必须是正整数」**（`transfers.parse_max_bytes`）；非数字由 FastAPI 参数校验拦成 400。**不静默降级成「不传」**（那会让调用方误以为自己是限量读取）。
- **截断时「超出部分不读」**：`ReadStream.read` 到限即**自己关泵**（按进程组回收，容器内 `cat` 不会被晾着），并让 `raise_for_status` **不给失败结论**（非零退出码是我们自己造成的，不是容器内失败）。
- **前端正常路径**：`api.readFile` 的 `maxBytes` 传**列表条目的 `size`** ⇒ 请求全量、`truncated` 恒为 `false`；前端只是**如实转发**服务端的截断声明，不据此画任何提示条。

### 三、核心包 API 形态（`apps/core/src/sandbox_platform/transfer.py`）

| 新增 | 说明 |
|---|---|
| `ReadStream(DownloadStream)`（数据类，`transfer.py:514-598`） | 复用下载流的 `read / close / raise_for_status / 上下文管理器`，新增字段 `is_binary` / `truncated` / `max_bytes` / `head` / `delivered` / `limit_closed`；重写 `read`（**先交首块**、按上限裁剪、到限即关泵）与 `raise_for_status`（`limit_closed` 时不给失败结论） |
| `FileTransferManager.read(sandbox, path, max_bytes=None) -> ReadStream`（`transfer.py:1021`） | **复用分层探测**（`_require_regular_file`：普通文件放行；目录 → `target_is_dir`；FIFO / 字符设备 / 块设备 / 套接字 / 悬空符号链接 / 其它特殊文件 → `not_regular`；不存在 → `not_found`）与 **exec 字节泵**（`docker exec -i <容器> cat -- <路径>`，与下载同一条 argv 形态）；**首块在返回前读掉做 NUL 嗅探**；声明式截断 = `size > max_bytes` |
| `_require_regular_file(...)`（私有，`transfer.py:1089`） | 下载与只读读取共用的「只放行普通文件」前置判定；`not_regular` 的文案按场景取（下载「不能下载」/ 预览「无法预览」，新常量 `MSG_NOT_PREVIEWABLE`） |
| `_normalize_max_bytes(...)`（`transfer.py:703`）+ `MSG_INVALID_MAX_BYTES` | 正整数校验（与上传的 `expected_bytes` 分开：那边 0 合法、文案也不同），失败分类码复用 `REASON_INVALID_SIZE` |
| `READ_SNIFF_BYTES = 65536`（`transfer.py:383`）| 首块嗅探窗口；`min(READ_SNIFF_BYTES, max_bytes)` |
| 包导出 | `ReadStream` / `MSG_NOT_PREVIEWABLE` / `MSG_INVALID_MAX_BYTES` 进 `sandbox_platform.__all__`（服务端统一从包根 import） |

### 四、服务端（`apps/web/backend/`）

- **路由**（`routes/files.py`）：`GET /api/sandboxes/{name}/files/read`，查询参数 `path` + 可选 `max_bytes`；先 `parse_max_bytes` 校验（400 固定文案），再 `open_read`（探测 + 首块嗅探），最后 `StreamingResponse(iter_read_chunks(...))` 带三件套响应头 + `Content-Length`。头名常量集中在路由模块：`READ_BINARY_HEADER` / `READ_SIZE_HEADER` / `READ_TRUNCATED_HEADER`。
- **编排**（`transfers.py`）：新增 `INVALID_MAX_BYTES_MESSAGE` / `parse_max_bytes` / `open_read` / `iter_read_chunks`；读流走**传输专用线程池**（`TRANSFER_IO_EXECUTOR`），复用 `iter_download_chunks` 的「逐块读 + 按声明长度裁剪 + 读完核对失败原因 + finally 关泵」口径（客户端二进制早退断开 ⇒ 照样关泵回收 exec）。
- **`API.md`**：11.1 路由表补一行、16 章标题与导语改「四个端点」、16.1 补一行、16.4 改「四条端点」、16.6 模块职责更新、**新增 16.7「只读读取（预览）端点」**（请求参数 / `max_bytes` 缺省口径 / 响应头表 / 两个示例（正常 + 截断）/ 二进制早退示例 / 错误表 / 与下载的差异对照）。
- **CORS**：`CORS_EXPOSED_HEADERS` 增加三个 `X-File-*`（不登记则跨源前端读不到，二进制早退与进度条都会变成死代码）。

### 五、前端组件结构

**接口层（`src/api/client.ts`）**

- `api.readFile(sandbox, path, options)` → `readFileWithProgress`：fetch 流式读；`ReadFileOptions = {maxBytes?, onProgress?(loaded), signal?}`，`ReadFileResult = {text, binary, size, bytes, truncated}`；
- **早退**：`X-File-Binary: true` ⇒ `response.body.cancel()` 后立即返回（**一个字节都不读**）；
- **进度**：`onProgress(已接收字节)`；
- **UTF-8 严格解码**（`TextDecoder('utf-8', {fatal: true})`）：非法序列抛 **`TextNotPreviewableError`**（新导出类；不是 `ApiError`——HTTP 是 200，失败在本地解码）；
- 鉴权 / 错误与 `downloadFileWithProgress` 同款（令牌缺失 `ConnectionNotConfiguredError`；非 2xx 用后端 `detail`）。

**纯逻辑（`src/lib/file-preview.ts`，新文件）**：`PREVIEW_LARGE_FILE_BYTES`（2 MiB）/ `isLargePreviewFile`（**严格大于**；`null` / `NaN` / 负数按小文件）/ `previewStackReducer`（push / pop / clear，**栈空 pop 保持空**、空栈 clear 复用引用）/ `currentPreview` / `splitPreviewLines`（按换行切行、CRLF 去行尾回车、末尾换行不多算一行、空行保留、空文本 `[]`）。

**窗格（`src/components/workbench/FileBrowserPanel.tsx`）**

```
FileBrowserPanel
├─ 顶行：面包屑（预览态下**全部层级可点**，含当前级 → 清预览栈 + 导航/强制重读）
│        + 回跳 / 上传（**仅列表态**）+ 折叠（两态都在）
├─ 列表态：page-file-browser-list（原结构，行单击即下载——**零改动**）
│         └─ 行尾「预览」眼睛钮（仅文件行；opacity-0 → group-hover:opacity-100，duration-150；
│            click / Enter 都 stopPropagation）
└─ 预览态：<FilePreviewView/>（**窗格内第二视图**，同文件内的私有子组件）
          ├─ 工具条：返回（栈空不渲染）/ 文件名 / 大小 / 复制（对勾 1s 复原）
          ├─ loading：大文件 = 进度条（transferPercent），小文件 = 一行「正在读取…」
          ├─ ready：等宽 + 行号槽 + 全文（splitPreviewLines 逐行渲染）
          ├─ unsupported：二进制 / 非 UTF-8 的空态（图标 + 文案 + 描边「下载文件」）
          └─ error：就地 role="alert"（不弹 toast）
+ 大文件二次确认 ModalShell（page-file-preview-confirm-dialog；确认才 startPreview）
```

口径落点：**`Esc` 只在预览态监听**（二次确认弹窗开着时让给弹窗）；**换目录 / 退出预览 / 换沙箱 / 卸载**都 `abort` 在途读取（`previewControllerRef` 进 `abortTransfers`，换沙箱 effect 另外把栈与载荷清零；04 轮按 `sandbox:session` 重挂载是天然兜底）；空态的「下载文件」走**既有** `startDownload`（只多了一个可选的目标路径入参，列表行的路径计算**没动**）。

### 六、测试清单

**核心包**（`apps/core/tests/test_transfer.py`，新增 20 条 → 该文件 121 条）：首块嗅探交一次 / NUL 命中 / NUL 未命中 / 空文件 / `max_bytes` 截断（含「到限即关泵 + 不给失败结论」）/ 恰好等于上限不算截断 / 上限大于文件 / 非法 `max_bytes`（0、负数、小数、字符串、列表）/ 非普通文件六种 + 悬空链接 + 不存在（并断言**没起 cat**）/ 分类码 `not_regular` 与 `not_found` / 非法路径无副作用 / `cat` 失败按 stderr 分类 / 未装配运行时 / 嗅探窗口上限 / 包导出一致。

**服务端**（`apps/web/backend/tests/test_server_files.py`，新增 16 条；`test_server_auth.py` 1 条改期望）：无令牌 / 错令牌 401（且**没走到编排层**）/ 三件套响应头（正常不出现截断头）/ 二进制标记 / `max_bytes` 截断（`Content-Length` 同步）/ 不传上限传 `None` / `max_bytes` 非法（0、负数）400 固定文案 / 非数字 400 / 读完关泵（关泵在传输线程池里 + 核对失败原因）/ 404 / 特殊文件 400 / 沙箱已停止 409 / 相对路径 400 / 生成器提前关闭仍关泵（二进制早退）/ 逐块流式（2×64KiB+1）/ CORS 暴露三个新头。

**前端**（新增 36 条）：`src/lib/file-preview.test.ts`（16 条，新文件）、`FileBrowserPanel.test.tsx` +13 条（现 58 条）、`api/client.test.ts` +7 条（现 26 条）——覆盖眼睛钮浮现类名 / 无文字 / aria-label / 目录行无钮、行单击仍下载且不触发读取、开预览（请求参数含 `maxBytes=size`、工具条、行号、`.md` 无 heading/strong/code）、`Esc` 与返回钮、列表态无返回钮、复制对勾 1s 复原 + **成功零 toast** + 失败 toast（来源 `file-browser`）、大文件确认流（取消不发请求 / 确认才发 / 进度 `aria-valuenow=50` / 全文渲染 / **无「文件过大」「仅展示前」文案**）、小文件无进度条且无确认框、二进制空态 + 下载钮走既有通道、非 UTF-8 空态、读取失败就地 alert 不弹 toast、预览态面包屑当前级变按钮 + 点击回列表并**同路径强制重读**、卸载时 abort 在途读取。

### 七、门禁数字（2026-11-14 实测）

| 门禁 | 结果 |
|---|---|
| 核心包 `uv run pytest` | **428 passed**（基线 408，+20；耗时 9m49s）；`uv run ruff check .` **rc=0** |
| 服务端 `uv run pytest` | **348 passed**（基线 332，+16）；`uv run ruff check .` **rc=0** |
| 前端 `npx vitest run` | **49 个测试文件 / 841 条用例全绿**（其中本轮自身新增 36 条：file-preview 16 / FileBrowserPanel 13 / client 7；总数含并行 Obsidian 轮在同一工作树新增的用例） |
| 前端 `npx tsc --noEmit` / `-p tests/tsconfig.json` | **双零错** |
| 前端 `npx vite build` | **通过**（`✓ built in 2.69s`；既有 chunk 体积告警与本轮无关） |
| 字体 | 新增中文文案后已重跑 `bash apps/web/frontend/scripts/build-fonts.sh`（6 个 woff2 与 `scripts/fonts/charset.txt` 更新） |

### 八、落盘清单

| 文件 | 改动 |
|---|---|
| `apps/core/src/sandbox_platform/transfer.py` | `ReadStream` / `manager.read` / `_require_regular_file` / `_normalize_max_bytes` / 两条新文案 / `READ_SNIFF_BYTES` |
| `apps/core/src/sandbox_platform/__init__.py` | 导出 `ReadStream` / `MSG_NOT_PREVIEWABLE` / `MSG_INVALID_MAX_BYTES` |
| `apps/core/tests/test_transfer.py` | 只读读取 20 条用例 |
| `apps/web/backend/src/sandbox_console/routes/files.py` | 只读读取端点 + 三个头常量 + `READ_CONTENT_TYPE` |
| `apps/web/backend/src/sandbox_console/transfers.py` | `parse_max_bytes` / `open_read` / `iter_read_chunks` / `INVALID_MAX_BYTES_MESSAGE` |
| `apps/web/backend/src/sandbox_console/auth.py` | `CORS_EXPOSED_HEADERS` 扩到四个头 |
| `apps/web/backend/tests/test_server_files.py` / `test_server_auth.py` | 16 条新用例 / CORS 期望更新 |
| `apps/web/backend/API.md` | 11.1 路由表、16 章导语与各节、**新增 16.7** |
| `apps/web/frontend/src/api/client.ts` / `client.test.ts` | `readFile` + `ReadFileOptions` / `ReadFileResult` / `TextNotPreviewableError` / 头名常量；7 条单测 |
| `apps/web/frontend/src/lib/file-preview.ts` / `file-preview.test.ts` | 大文件判定 / 预览栈 / 行号切分 + 16 条单测（新文件） |
| `apps/web/frontend/src/components/workbench/FileBrowserPanel.tsx` / `.test.tsx` | 预览第二视图 / 眼睛钮 / 二次确认 / 进度条 / 二进制空态 / 复制 / 面包屑联动 / 收口；13 条组件测试 |
| `apps/web/frontend/README.md` | 行为节「文件窗格预览」、标识表登记、测试清单、toast 来源、目录结构 |
| `apps/web/frontend/public/fonts/*`、`scripts/fonts/charset.txt` | 字体子集重生成（约定要求） |
| `docs/tasks/file-pane-obsidian/05-file-preview.md` | 本进展节；完成标准 10 条勾选；`status: done` |

### 九、审查修复（2026-11-13）

#### 逐条修了什么

1. **截断标志早退盲区**（`transfer.py` 的 `ReadStream.read`）：`remaining <= 0` 的早退分支原先只 `_close_at_limit()`、**不评估截断**，而姊妹分支会评估。现抽出 `_mark_truncated_at_limit()`，两个到限分支共用同一条判定：探测值**大于**上限 ⇒ 真截断；探测值**小于**上限、却已经交付了上限那么多字节 ⇒ 探测后文件又长胖（增长竞态）⇒ 真截断；只有「探测值恰好等于上限」才按「文件恰好等于上限」处理、不算截断。新增用例 `test_read_marks_truncation_when_head_fills_the_limit_after_probe_growth`：`max_bytes=4`、文件实际 10 字节、`probe.size` 报告 2（模拟探测后增长），首块（`0123`）恰好喂满上限，下一次读走早退分支，断言 `truncated` 为真。
2. **流中失败静默成空文件**：`api.readFile` 在 `!truncated && !binary && size !== null && 实际收到字节数 < size` 时抛新增的 `IncompleteReadError`（文案「读取中断，文件不完整」）——HTTP 200 + `Content-Length` 已发出时服务端只能给干净 EOF，客户端必须把「没读满」识别成失败。面板沿用既有 error 态就地 `role="alert"` 展示（不弹 toast），不再把失败的读取当合法空文件渲染。补 client 用例（提前 EOF ⇒ `IncompleteReadError`）与面板用例（⇒ error 态、不渲染正文 / 行号、不弹 toast）。
3. **非 ready 态复制空串**：复制钮加 `disabled={view.status !== 'ready'}`（loading / error / unsupported 不可点，补 `disabled:pointer-events-none disabled:opacity-50`），并在 `copyPreviewText` 加同条件早退做第二道防线。补断言覆盖 loading / error / unsupported / ready 四态。
4. **Esc 让位**：补用例——大文件二次确认框开着按 Esc，**只关框**，留在列表态、预览栈不动、一个请求都不发（行为已实现，本轮补测试）。

#### 明确不做（含理由）

- **退栈重取内容**：预览栈深 ≤ 1（窗格内只 push 当前目标，退栈即回列表），不存在「上一层文件」可重取，不可达；这是当前预览栈的不变量。
- **大文件确认框加上限**：用户已拍板服务端 / 产品均无硬上限，确认框只做「超过 2 MB」的风险提示，不引入假上限。
- **截断多字节字符的 fatal 误报**：`max_bytes` 恰好切在多字节 UTF-8 字符中间时，`TextDecoder(fatal)` 会判成「非 UTF-8」；正常路径按列表 `size` 请求全量、不截断，概率极低，记作已知边界，不为此放宽解码。
- **字体子集回退**：本轮无新增界面文案字符，字体文件无害，不动。
- **类型 `Any` 标注、缩进格式**：不属行为问题，保持现状。

#### 最终门禁（2026-11-14 实测）

| 门禁 | 结果 |
|---|---|
| 核心包 `uv run pytest` | **429 passed**（基线 428，+1；耗时 9m28s）；`uv run ruff check .` **rc=0** |
| 前端 `npx vitest run` | **49 个测试文件 / 846 条用例全绿**（本轮自身 +4：`client.test.ts` 1 条、`FileBrowserPanel.test.tsx` 3 条） |
| 前端 `npx tsc --noEmit` | **零错** |

## 依赖

- 依赖 [[tasks/file-pane-obsidian/04-file-pane-split.md|04 文件窗格分屏骨架]]（预览挂在窗格上）。
- 口径依据：[[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018 运行期文件传输机制选型]]（分层探测 / 字节泵 / 路径校验）。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
