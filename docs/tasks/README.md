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

## 看板
任务状态汇总见 [[current-state.md]]，由人维护。
