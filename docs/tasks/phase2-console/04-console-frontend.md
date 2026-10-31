---
prd: prds/phase2-console.md
status: done
---
# 任务：网页控制台前端

> 实测结论：全部完成标准通过。新增前端工程 `platform/console/`（React 19 + Vite 7 + TypeScript 5.9，pnpm 管理）：沙箱列表、新建沙箱、沙箱详情（含网页终端）、代理设置四个页面，哈希路由 + xterm.js 网页终端，产物由后端在 `/` 路径托管，单端口对外。接口全部走同源相对路径，前端不含任何认证逻辑。命令行 `platform/cli/sandboxctl.py` 源码一行未改。
>
> 审查修复轮（2026-10-30）：reviewer 结论「无严重问题，4 项中等 + 11 项建议」，已逐条修完。**路由容错**：沙箱名里的畸形百分号编码（如 `#/sandboxes/%`）会让 `decodeURIComponent` 抛 URIError，异常经路由快照冒泡到渲染，整站白屏；现在解码失败一律退回沙箱列表页，并补了一条畸形编码的路由单测。**终端重连风暴**：退避计数原先在 WebSocket 握手成功（`onopen`）时就清零，服务端握手后立刻关闭会退化成每 500ms 一次的无限连接风暴；现在计数只在收到服务端 `hello` 帧或连接稳定存活超 5 秒后才清零，连续失败 10 次即停掉自动重连，改由用户点「重试连接」手动触发。**定位符缺失**：`index.html` 里的静态占位带 `page-layout-title`，React 挂载后占位被清空，README 承诺的定位符实际不存在；现在品牌名元素自带 `data-testid="page-layout-title"`。**文档收口**：本文件状态改 done 并补实现摘要，看板同步。
>
> 采纳建议（11 项）：终端卸载时补 `fitAddon.dispose()`、`new WebSocket(...)` 包 try/catch（地址非法走失效状态而不是抛异常打断 effect）、操作提示条拆成功 / 失败两种样式、容器路径重复在前端先拦（少一次往返）、代理状态摘要与后端健康自检两处死代码接到页面上（摘要接设置页顶部，健康自检接外壳顶部）、镜像下拉在页面重新可见时补拉一次、服务端 error 帧给独立的告警样式、终端标签标题改单调递增计数器（关掉中间标签后不再重名）、删除确认弹窗支持 `Esc` 关闭、`docker exec` 命令行回归断言升级为尾部整体断言并补 sudo 分支用例、`websockets` 依赖下界补注释说明。
>
> 关键实现约定：前端只做编排与展示，错误消息一律直接展示后端 `{"detail": "中文消息"}` 里的 `detail`，不另造说法；页面元素统一带 `data-testid`（命名 `page-<页面>-<元素>`）供 05 的端到端脚本定位；纯数据转换逻辑（路由解析、挂载声明、环境变量、字节与时间格式化、终端帧协议、代理文案）收敛在 `src/lib/` 并有单元测试。
>
> 后续变更：本任务的四页面形态被 [[tasks/phase2-console/07-console-ui-overhaul.md|07 控制台 UI 全面改造]] 取代（改为单页工作台），「删除前先展示回收清单」的口径又被 [[tasks/phase2-console/08-console-drawer-migration.md|08 控制台弹窗抽屉化]] 取代（删除改一步确认，页面不再预取回收清单）。下文保留本任务当时的交付记录，不做追改。

## 目标
实现网页控制台前端（React + Vite + TypeScript，pnpm 管理）：沙箱列表、新建沙箱、沙箱详情与网页终端、代理设置四个页面。构建产物由后端服务在 `/` 路径托管，单端口对外；前端不含任何认证相关代码。

## 完成标准
- [x] 新增前端工程 `platform/console/`：`package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`vite.config.ts`、`index.html`、`src/`。技术栈与仓库既有前端一致（React + Vite + TypeScript），Node ≥ 22，`packageManager` 字段与 `platform/e2e` 一致。
- [x] 四个页面齐备：沙箱列表页（名字 / 状态 / 镜像 / 创建时间 + 行内操作）、新建沙箱页、沙箱详情页（含网页终端面板）、设置页（代理状态 + 重启）。
- [x] 新建沙箱页：镜像下拉实时拉取 `GET /api/images`（宿主本地镜像，含任何本地构建镜像），可声明挂载（沿用 `宿主路径:容器路径[:ro]` 语法，可多条），提交时带 `image_source=host`。
- [x] 删除操作：先调 `GET /api/sandboxes/{name}/reclaim` 展示平台回收清单与「用户挂载的宿主机目录不受影响」字样，用户确认后再发 `DELETE`；取消则不发删除请求。
- [x] 终端面板：xterm.js + fit 适配插件，支持同一沙箱开多个终端标签、随窗口自适应、输入输出双向；断线后自动重连并携带原 `session_id` 重新附着；服务重启导致会话失效时给出明确提示（需新开终端）。
- [x] 设置页展示：代理容器运行状态、健康状态、缓存目录占用大小、证书就绪状态；提供「重启代理」按钮，重启期间提示「依赖镜像拉取会失败，属预期行为」，重启后刷新状态。
- [x] 前端不做登录、不做任何认证相关逻辑；所有接口走同源相对路径。
- [x] `pnpm run typecheck`（tsc --noEmit）零错误；`pnpm run build` 产出 `platform/console/dist`；关键数据转换逻辑有单元测试。
- [x] 开发联调：`pnpm dev` 走 Vite 代理把 `/api`（含 WebSocket）转发到后端服务，无需额外配置跨域。
- [x] 页面元素统一带 `data-testid`（沿用一期规范，命名 `page-<页面>-<元素>`），供 05 的端到端脚本定位。
- [x] `platform/console/README.md` 写明安装、启动、构建、接口地址与后端联调方式；`platform/.gitignore` 补上 `console/node_modules` 与 `console/dist`。

## 依赖
- 依赖 [[tasks/phase2-console/01-service-core-api.md|01 控制面服务骨架与沙箱管理接口]]（沙箱管理接口与错误消息格式）。
- 依赖 [[tasks/phase2-console/02-image-proxy-api.md|02 宿主镜像枚举与代理状态管理接口]]（镜像下拉与代理设置页的数据来源）。
- 依赖 [[tasks/phase2-console/03-web-terminal.md|03 网页终端]]（WebSocket 协议与终端协议帧定义）。
