---
prd: prds/sandbox-platform.md
status: done
---
# 任务：示例全栈项目与一期验收演练

> **进度：两步都已完成。**
> - 第一步（平台搭好 + 端到端全绿）：示例项目落在 `platform/examples/fullstack-sample/`（FastAPI + React + Postgres + MinIO + Logto），实测数据见该目录的 `RESULTS.md`；
> - 第二步（闭环验收演练，2026-10-29）：agent 只拿 `BRIEF-NEXT.md`（R1 列表过滤 / R2 提交加载态），
>   在全新沙箱 `acceptance-lab` 里独立完成「读需求 → 改码 → 起依赖 → 跑端到端 → 看截图 → 修复 → 全绿」，
>   **2 轮**循环内从红（2 failed / 4 passed）到绿（6 passed，退出码 0）；
>   全过程命令与决策见 `platform/examples/fullstack-sample/LOOP-LOG.md`，
>   实测数据见 `platform/examples/fullstack-sample/RESULTS.md` 第八节，
>   平台侧的一期总验收结论见 [[tasks/sandbox-platform/RESULTS.md|平台侧总验收结论留档]]。

## 目标
搭建一个真实全栈示例项目（前端 + FastAPI + Postgres + MinIO + Logto），并让 agent 在一个干净沙箱中无人工介入地跑通「改码 → 起环境 → 端到端 → 看截图 → 修复 → 全绿」闭环，同时记录实测数据用于校准后续性能估算。

## 完成标准
- [x] 示例项目落在 `platform/examples/fullstack-sample/`：前端 React / Vue / Astro 任一 + 后端 FastAPI + Postgres + MinIO + Logto；附 README 说明本地启动步骤、依赖版本、端口约定。
- [x] 后端真实对接三类外部依赖：Postgres 读写真实表；MinIO 通过 S3 协议上传并下载对象（不得用本地目录替代）；Logto 完成一次 OIDC 授权码登录并校验用户信息。
- [x] 前端能走通一次完整业务流程：登录 → 向 Postgres 写数据 → 向 MinIO 上传文件 → 列表页展示，页面元素带 data-testid。
- [x] 端到端用例覆盖上述流程，全部用例通过（退出码 0）；失败时留存截图与 trace。
- [x] 闭环验收：由 agent 在全新创建的沙箱中独立完成「读需求 → 改码 → 起依赖 → 跑端到端 → 看截图 → 修复 → 全绿」全过程，全程无人工点击、无人工代敲命令；全过程日志与脚本保存在用户声明挂载的代码目录内可回放。
- [x] 实测数据记录到 `platform/examples/fullstack-sample/RESULTS.md`：沙箱创建耗时（秒）、各依赖容器就绪耗时（秒）、端到端整套运行耗时（秒）、模板库克隆耗时（秒）、Logto 自建容器实例的启动与初始化耗时（秒）、截图张数与尺寸。
- [x] 一期总验收结论写入 `RESULTS.md`：逐条对应 PRD 的「一期总验收」与「一期分项」，标注通过 / 不通过；每条不通过项标注是否阻塞后续任务。
- [x] 删除沙箱复验：按 PRD 回收清单逐项核对（容器、守护进程、用户与家目录、子 ID 段、平台元数据已全部回收），并确认用户声明挂载的外部目录原样存在、内容未变。

## 依赖
- 依赖 [[tasks/sandbox-platform/03-sandbox-image.md|03 默认全栈沙箱镜像]]、[[tasks/sandbox-platform/04-lifecycle-core-cli.md|04 生命周期核心模块与 CLI]]、[[tasks/sandbox-platform/05-e2e-harness.md|05 端到端测试基建]]（共同支撑本任务的一期总验收）。
