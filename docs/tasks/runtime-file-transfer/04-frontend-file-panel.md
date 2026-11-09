---
prd: prds/runtime-file-transfer.md
status: todo
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

- [ ] 工作台沙箱操作区有「**文件**」按钮，与「详情」「停止」**同级**，打开**独立文件浏览抽屉**（复用 `DrawerShell`）。
- [ ] 列表**三列**：图标 + 名称 / 大小 / 修改时间——**无类型列**；文件夹在前按名称排序；**隐藏文件显示**。
- [ ] **点击文件行本身即下载**，不另加下载按钮。
- [ ] **界面无副标题、无解释说明性文字**。
- [ ] **面包屑**各级可点击，**不重复展示纯文本形式的当前目录**。
- [ ] 上传**只能传进当前浏览目录**（**无手动路径输入框**）；行内**进度条** + **可取消**；同名**普通文件**弹**覆盖确认框**，同名**目录**走服务端 400 的固定中文文案（**不弹确认框**）。
- [ ] **进度条必有**：上传用 XHR；下载按 `Content-Length` + 流式读取计算。
- [ ] web 形态下载 = `fetch` → blob → `a[download]`，**不导航 blob: URL**；上传两形态**共用 `<input type="file">`**。
- [ ] `client.ts` 的三种新请求能力落地（**上传显式 `application/octet-stream`，绕开既有「固定 json」的坑**）。
- [ ] 纯逻辑收敛在 `src/lib/file-transfer.ts`（路径校验、文件名解析、大小格式化、列表排序）并有单测。
- [ ] 图标：material-icon-theme 风格；**SVG 子集已 vendor 进前端构建资产**（**无运行时 CDN**）；**根目录 `folder.svg` / `file.svg` 已移入前端资产目录**并接入兜底映射。
- [ ] 新增标识按 `page-<页面>-<元素>` 规范登记进 `apps/web/frontend/README.md` 标识表。
- [ ] 门禁：前端 **vitest 全绿**、**typecheck 零错**、**build 通过**。
- [ ] 遵守 [[conventions/console-frontend.md|前端约定]]全部既有条目（令牌色、toast、`data-testid`、抽屉外壳、纯逻辑收敛）。

## 依赖

- 依赖 [[tasks/runtime-file-transfer/03-server-file-endpoints.md|03 服务端文件传输接口]]（接口契约）。
- 与 [[tasks/runtime-file-transfer/05-desktop-download.md|05 桌面端下载落盘]] **可并行**；桌面形态分支在 05 落地后接通。
- 视觉底座沿用 [[conventions/console-frontend.md|前端约定]]；图标风格与 demo 验证结论见 PRD「前端」节。
- 接口口径（错误文案 / 目录目标拒绝）依据 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018 运行期文件传输机制选型]]。
