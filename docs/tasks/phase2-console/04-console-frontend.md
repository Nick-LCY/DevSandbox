---
prd: prds/phase2-console.md
status: todo
---
# 任务：网页控制台前端

## 目标
实现网页控制台前端（React + Vite + TypeScript，pnpm 管理）：沙箱列表、新建沙箱、沙箱详情与网页终端、代理设置四个页面。构建产物由后端服务在 `/` 路径托管，单端口对外；前端不含任何认证相关代码。

## 完成标准
- [ ] 新增前端工程 `platform/console/`：`package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`vite.config.ts`、`index.html`、`src/`。技术栈与仓库既有前端一致（React + Vite + TypeScript），Node ≥ 22，`packageManager` 字段与 `platform/e2e` 一致。
- [ ] 四个页面齐备：沙箱列表页（名字 / 状态 / 镜像 / 创建时间 + 行内操作）、新建沙箱页、沙箱详情页（含网页终端面板）、设置页（代理状态 + 重启）。
- [ ] 新建沙箱页：镜像下拉实时拉取 `GET /api/images`（宿主本地镜像，含任何本地构建镜像），可声明挂载（沿用 `宿主路径:容器路径[:ro]` 语法，可多条），提交时带 `image_source=host`。
- [ ] 删除操作：先调 `GET /api/sandboxes/{name}/reclaim` 展示平台回收清单与「用户挂载的宿主机目录不受影响」字样，用户确认后再发 `DELETE`；取消则不发删除请求。
- [ ] 终端面板：xterm.js + fit 适配插件，支持同一沙箱开多个终端标签、随窗口自适应、输入输出双向；断线后自动重连并携带原 `session_id` 重新附着；服务重启导致会话失效时给出明确提示（需新开终端）。
- [ ] 设置页展示：代理容器运行状态、健康状态、缓存目录占用大小、证书就绪状态；提供「重启代理」按钮，重启期间提示「依赖镜像拉取会失败，属预期行为」，重启后刷新状态。
- [ ] 前端不做登录、不做任何认证相关逻辑；所有接口走同源相对路径。
- [ ] `pnpm run typecheck`（tsc --noEmit）零错误；`pnpm run build` 产出 `platform/console/dist`；关键数据转换逻辑有单元测试。
- [ ] 开发联调：`pnpm dev` 走 Vite 代理把 `/api`（含 WebSocket）转发到后端服务，无需额外配置跨域。
- [ ] 页面元素统一带 `data-testid`（沿用一期规范，命名 `page-<页面>-<元素>`），供 05 的端到端脚本定位。
- [ ] `platform/console/README.md` 写明安装、启动、构建、接口地址与后端联调方式；`platform/.gitignore` 补上 `console/node_modules` 与 `console/dist`。

## 依赖
- 依赖 [[tasks/phase2-console/01-service-core-api.md|01 控制面服务骨架与沙箱管理接口]]（沙箱管理接口与错误消息格式）。
- 依赖 [[tasks/phase2-console/02-image-proxy-api.md|02 宿主镜像枚举与代理状态管理接口]]（镜像下拉与代理设置页的数据来源）。
- 依赖 [[tasks/phase2-console/03-web-terminal.md|03 网页终端]]（WebSocket 协议与终端协议帧定义）。
