# 任务

需求拆分出的开发任务。**按 PRD 分组**：`tasks/<feature>/<NN>-<短名>.md`。每个 task 是一个可独立领取、独立完成的单元。

## Task 文件格式

```
---
prd: prds/<feature>.md
status: todo        # todo | doing | done | blocked
---
# 任务：<标题>

## 目标
（来自 PRD 的拆分项）

## 完成标准
- [ ] ...

## 依赖
- 无 / 或依赖其他 task
```

## 状态约定
- `todo` — 待领取
- `doing` — 正在执行中
- `done` — 完成
- `blocked` — 阻塞

## 清单
- [[tasks/sandbox-platform/README.md]] — 沙箱平台一期（本地闭环）任务集索引，含依赖顺序
- [[tasks/sandbox-platform/01-rootless-probe.md]] — 免 root 沙箱模式打样验证（02、04 的前置）
- [[tasks/sandbox-platform/02-base-image.md]] — 平台基础镜像
- [[tasks/sandbox-platform/03-sandbox-image.md]] — 默认全栈沙箱镜像
- [[tasks/sandbox-platform/04-lifecycle-core-cli.md]] — 生命周期核心模块与 CLI
- [[tasks/sandbox-platform/05-e2e-harness.md]] — 端到端测试基建
- [[tasks/sandbox-platform/06-sample-app-acceptance.md]] — 示例全栈项目与一期验收演练
- [[tasks/sandbox-platform/RESULTS.md]] — 平台侧总验收结论留档（一期总验收与分项、二期分项与已知边界）
- [[tasks/phase2-console/README.md]] — 沙箱平台二期（控制面服务化与网页控制台）任务集索引，含依赖顺序
- [[tasks/phase2-console/01-service-core-api.md]] — 控制面服务骨架与沙箱管理 HTTP 接口
- [[tasks/phase2-console/02-image-proxy-api.md]] — 宿主镜像枚举与代理状态管理接口
- [[tasks/phase2-console/03-web-terminal.md]] — 网页终端：伪终端会话管理与 WebSocket 桥接
- [[tasks/phase2-console/04-console-frontend.md]] — 网页控制台前端（React + Vite）
- [[tasks/phase2-console/05-acceptance-regression.md]] — 二期端到端验收与一期回归复验
- [[tasks/phase2-console/07-console-ui-overhaul.md]] — 控制台 UI 全面改造（单页工作台 + 新视觉底座）
- [[tasks/phase2-console/08-console-drawer-migration.md]] — 控制台弹窗抽屉化（大面板改右侧抽屉 + 确认类弹窗精简）
- [[tasks/console-templates/README.md]] — 控制台模板轮（基础镜像 0.3.0 工具层 + 启动模板）任务集索引，含依赖顺序
- [[tasks/console-templates/01-base-image-0.3.0.md]] — 平台基础镜像 0.3.0：apt 装 9 个通用工具包、构建转联网、判定扩到 42 项
- [[tasks/console-templates/02-template-server.md]] — 启动模板服务端：模板库落盘、四条接口、`~` 展开、内置模板种子机制
- [[tasks/console-templates/03-template-console.md]] — 启动模板前端与字体：新建抽屉加载 / 保存、设置抽屉模板管理区、字体子集重生成
- [[tasks/console-templates/04-acceptance-and-docs.md]] — 控制台模板轮真机验收与文档收口：三套测试全绿、两篇架构决策记录、看板与约定同步
- [[tasks/file-injection/README.md]] — 文件注入轮（创建沙箱时把宿主文件复制进沙箱）任务集索引，含四个工作包完成状态、验收数字与提交链
- [[tasks/phase3-desktop/README.md]] — 三期（桌面端打包 + 端口转发）任务集索引，含 9 个任务、依赖顺序与关键前置风险
- [[tasks/phase3-desktop/01-prototype-and-spike.md]] — 打样轮：免 root 端口发布 / Tauri 壳 / WebView2 三项冒烟 / Windows 出包路径（doing：本机 P1 / P3 已实测通过；首轮 Windows 反馈——P4 路径②可行、P2 外观初测通过，控制台三项待调试构建复验）
- [[tasks/phase3-desktop/02-backend-token-and-cors.md]] — 连接层后端改造：token 认证 / CORS / WebSocket 鉴权（done：后端侧已落地，按部署口径须与 03 同批发布）
- [[tasks/phase3-desktop/03-frontend-connection-layer.md]] — 连接层前端改造：请求基址抽象 / 连接配置 / WebSocket 地址推导 / 未配置态（doing：前端侧已落地，CSP 闸门闭合；只差「同一份产物连同源 / 远端后端」待真机复验）
- [[tasks/phase3-desktop/04-port-forward-core.md]] — 端口转发核心包能力：转发容器编排 / 宿主端口分配 / 生命周期与清理
- [[tasks/phase3-desktop/05-port-forward-server-api.md]] — 端口转发服务端接口：转发管理 REST + 隧道 WebSocket
- [[tasks/phase3-desktop/06-port-forward-desktop.md]] — 端口转发桌面侧：Rust 本机 TCP 监听 + 隧道桥接 + 界面
- [[tasks/phase3-desktop/07-acceptance-tokenization.md]] — 既有验收套件 token 化改造
- [[tasks/phase3-desktop/08-windows-package.md]] — Windows 打包产物与冒烟
- [[tasks/phase3-desktop/09-acceptance-and-docs.md]] — 验收回归与文档收口
- [[tasks/phase3-desktop/RESULTS.md]] — 三期打样与实测结论留档（P1/P3 已填；首轮用户反馈已入档：P4 路径②部分闭合、P2 外观初测通过，P2 控制台三项与 P5 待验）

## 看板
任务状态汇总见 [[current-state.md]]，由人维护。
