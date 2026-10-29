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
- [[tasks/sandbox-platform/01-rootless-probe.md]] — 免 root 沙箱模式打样验证（阻塞 02、04）
- [[tasks/sandbox-platform/02-base-image.md]] — 平台基础镜像
- [[tasks/sandbox-platform/03-sandbox-image.md]] — 默认全栈沙箱镜像
- [[tasks/sandbox-platform/04-lifecycle-core-cli.md]] — 生命周期核心模块与 CLI
- [[tasks/sandbox-platform/05-e2e-harness.md]] — 端到端测试基建
- [[tasks/sandbox-platform/06-sample-app-acceptance.md]] — 示例全栈项目与一期验收演练

## 看板
任务状态汇总见 [[current-state.md]]，由人维护。
