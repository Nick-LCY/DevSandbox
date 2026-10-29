# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 活跃需求
- Agent 开发沙箱平台 — 给 pi agent 提供隔离、可复用的全栈开发沙箱，核心价值是 agent 自主完成端到端测试。需求文档：[[prds/sandbox-platform.md|Agent 开发沙箱平台]]。

## 任务看板
| Task | 状态 | 备注 |
|------|------|------|
| 一期任务集 | todo | 已拆分至 `tasks/sandbox-platform/`，状态见各任务文件 |
| [[tasks/sandbox-platform/01-rootless-probe.md\|01 免root打样验证]] | done | 实测主链路成立，14 项判定全通过；记录见 `platform/probe/rootless/RESULTS.md` |
| [[tasks/sandbox-platform/02-base-image.md\|02 平台基础镜像]] | todo | 依赖 01 |
| [[tasks/sandbox-platform/03-sandbox-image.md\|03 默认全栈沙箱镜像]] | todo | 依赖 02 |
| [[tasks/sandbox-platform/04-lifecycle-core-cli.md\|04 生命周期核心模块与CLI]] | todo | 依赖 01 |
| [[tasks/sandbox-platform/05-e2e-harness.md\|05 端到端基建]] | todo | 依赖 03、04 |
| [[tasks/sandbox-platform/06-sample-app-acceptance.md\|06 示例项目与验收演练]] | done | 两步全完成：全栈示例项目落地（FastAPI + React + Postgres + MinIO + Logto）+ 闭环验收演练（agent 在全新沙箱内独立从红到绿，2 轮循环，6 条用例全绿）；证据见 `platform/examples/fullstack-sample/LOOP-LOG.md` 与仓库根目录 `RESULTS.md` |

## TODO / 阻塞
- [ ] 一期任务已拆分至 `tasks/sandbox-platform/`，状态见各任务文件。

## 最近变更
- 2026-10-29：一期总验收完成——闭环验收演练落地：agent 只拿 `BRIEF-NEXT.md`（R1 列表过滤 / R2 提交加载态），在全新沙箱 `acceptance-lab` 里独立完成「读需求 → 改码 → 起依赖 → 跑端到端 → 看截图 → 修复 → 全绿」，2 轮循环内从 2 failed 走到 6 passed（退出码 0）；沙箱创建 26.4 秒、`up.sh` 22.5 秒、端到端 5.4 秒；删除沙箱后逐项复验回收干净，用户挂载目录原样存在且含本轮实现。一期总验收与分项结论见仓库根目录 `RESULTS.md`。
- 2026-10-29：06 第一步完成——全栈示例项目落地 `platform/examples/fullstack-sample/`（后端 FastAPI+uv、前端 React+Vite），真实对接 Postgres / MinIO(S3) / Logto(OIDC 授权码)；依赖清单加 app/logto/minio 三条，迁移与种子进既有目录，沙箱内 `pnpm run test:scripted` 4 条用例全绿（退出码 0）。下一轮需求见 `BRIEF-NEXT.md`，闭环验收演练待做。
- 2026-10-29：01 免root打样验证完成——专属用户 + 子 ID 段 + 用户级免 root 守护进程 + 套接字挂载 + 同网桥按名互访全部跑通；02、04 可开工，注意基础镜像的 docker 客户端须与宿主守护进程同版本。
- 2026-10-29：挂载契约修订——套接字为唯一固定挂载，其余由用户声明。
- 2026-10-29：归档全部架构决策（7 篇 ADR）与一期任务拆分。
