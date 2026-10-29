# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 活跃需求
- Agent 开发沙箱平台 — 给 pi agent 提供隔离、可复用的全栈开发沙箱，核心价值是 agent 自主完成端到端测试。需求文档：[[prds/sandbox-platform.md|Agent 开发沙箱平台]]。

## 任务看板
| Task | 状态 | 备注 |
|------|------|------|
| 一期任务集 | todo | 已拆分至 `tasks/sandbox-platform/`，状态见各任务文件 |
| [[tasks/sandbox-platform/01-rootless-probe.md\|01 免root打样验证]] | todo | 无依赖，最先完成 |
| [[tasks/sandbox-platform/02-base-image.md\|02 平台基础镜像]] | todo | 依赖 01 |
| [[tasks/sandbox-platform/03-sandbox-image.md\|03 默认全栈沙箱镜像]] | todo | 依赖 02 |
| [[tasks/sandbox-platform/04-lifecycle-core-cli.md\|04 生命周期核心模块与CLI]] | todo | 依赖 01 |
| [[tasks/sandbox-platform/05-e2e-harness.md\|05 端到端基建]] | todo | 依赖 03、04 |
| [[tasks/sandbox-platform/06-sample-app-acceptance.md\|06 示例项目与验收演练]] | todo | 依赖 03、04、05 |

## TODO / 阻塞
- [ ] 一期任务已拆分至 `tasks/sandbox-platform/`，状态见各任务文件。

## 最近变更
- 2026-10-29：挂载契约修订——套接字为唯一固定挂载，其余由用户声明。
- 2026-10-29：归档全部架构决策（7 篇 ADR）与一期任务拆分。
