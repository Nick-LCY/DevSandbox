# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 活跃需求
- Agent 开发沙箱平台 — 给 pi agent 提供隔离、可复用的全栈开发沙箱，核心价值是 agent 自主完成端到端测试。需求文档：[[prds/sandbox-platform.md|Agent 开发沙箱平台]]。

## 任务看板
| Task | 状态 | 备注 |
|------|------|------|
| 一期任务集 | done | 6 个任务全部完成，闭环验收通过；分项状态见各任务文件 |
| [[tasks/sandbox-platform/01-rootless-probe.md\|01 免root打样验证]] | done | 实测主链路成立，14 项判定全通过；记录见 `platform/probe/rootless/RESULTS.md` |
| [[tasks/sandbox-platform/02-base-image.md\|02 平台基础镜像]] | done | 基础镜像 `sandbox-platform/base:0.1.0` 建成，534.4 MB（含离线包 489.5 MB），离线包首次加载 23 秒、第二次跳过；离线包机制已废弃（ADR 0008），重建后的基础镜像不再含离线包层；记录见 `platform/base-image/RESULTS.md` |
| [[tasks/sandbox-platform/03-sandbox-image.md\|03 默认全栈沙箱镜像]] | done | 默认沙箱镜像 `sandbox-platform/sandbox-default:0.1.0` 建成，1212.9 MB，pi / git / uv / nvm+node / pnpm / Playwright 浏览器齐备；仍含已废弃的离线包层，待重建（见下方 TODO）；记录见 `platform/sandbox-image/RESULTS.md` |
| [[tasks/sandbox-platform/04-lifecycle-core-cli.md\|04 生命周期核心模块与CLI]] | done | 生命周期核心包与薄壳 CLI 落地（创建 7 步、删除固定回收清单），80 项 pytest 与 23 项冒烟判定全通过；接口文档见 `platform/src/sandbox_platform/API.md` |
| [[tasks/sandbox-platform/05-e2e-harness.md\|05 端到端基建]] | done | Playwright 脚本与探索双模式、健康检查门禁、用例库克隆、data-testid 规范落地，脚本模式用例全绿；记录见 `platform/e2e/RESULTS.md` |
| [[tasks/sandbox-platform/06-sample-app-acceptance.md\|06 示例项目与验收演练]] | done | 两步全完成：全栈示例项目落地（FastAPI + React + Postgres + MinIO + Logto）+ 闭环验收演练（agent 在全新沙箱内独立从红到绿，2 轮循环，6 条用例全绿）；证据见 `platform/examples/fullstack-sample/LOOP-LOG.md` 与仓库根目录 `RESULTS.md` |

## TODO / 阻塞
- [ ] 默认全栈沙箱镜像待基于 base 0.2.0 重建（当前 0.1.0 仍含离线包层）。
- [ ] 统一镜像代理缓存 GC 命令待做。
- 阻塞项：无。

## 最近变更
- 2026-10-29：镜像供给改为统一镜像代理（ADR 0008），废弃离线包——基础镜像不再内置 postgres / minio / logto 离线 tar，三件套及一切外部镜像统一经镜像代理拉取（缓存命中走本地，未命中由代理拉一次外网）；宿主导出注入收窄为本地构建镜像专用；代理不可达即拉取失败、不降级直连。详见 [[architecture/decisions/0008-统一镜像代理与离线包废弃.md|ADR 0008 统一镜像代理与离线包废弃]]。
- 2026-10-29：安全加固轮完成——一期平台按审查结论修复 7 条严重问题与 12 条中等问题：沙箱名穿越（七个入口统一校验 + 元数据目录兜底断言）、删除路径不再信任元数据（用户信息现查 `getent passwd`、单元路径重算、只回收平台自建网络）、守护进程启动改 `--no-block` 且就绪统一交给套接字等待、子 ID 段回收加锁、用户指定网络不回收、回滚不删既有用户、终止用户返回真实结果；回收清单并入实时扫描（探测失败标注不完整）、宿主敏感路径与含逗号挂载拒绝、元数据权限改 0600、命名白名单、命令返回码如实上报。新增 59 项回归测试，141 项 pytest（含 7 项 root 标记测试）与 24 项冒烟判定全通过；端到端用例库改回「每用例一库」，沙箱内复验 6 条用例全绿（退出码 0）。记录见 `platform/e2e/RESULTS.md` 第十二节。
- 2026-10-29：一期（本地闭环）六个任务全部完成，闭环验收通过——总验收 1/1 通过、分项 8 条全通过；验收暴露的两处平台缺口已登记到上方 TODO。
- 2026-10-29：一期总验收完成——闭环验收演练落地：agent 只拿 `BRIEF-NEXT.md`（R1 列表过滤 / R2 提交加载态），在全新沙箱 `acceptance-lab` 里独立完成「读需求 → 改码 → 起依赖 → 跑端到端 → 看截图 → 修复 → 全绿」，2 轮循环内从 2 failed 走到 6 passed（退出码 0）；沙箱创建 26.4 秒、`up.sh` 22.5 秒、端到端 5.4 秒；删除沙箱后逐项复验回收干净，用户挂载目录原样存在且含本轮实现。一期总验收与分项结论见仓库根目录 `RESULTS.md`。
- 2026-10-29：06 第一步完成——全栈示例项目落地 `platform/examples/fullstack-sample/`（后端 FastAPI+uv、前端 React+Vite），真实对接 Postgres / MinIO(S3) / Logto(OIDC 授权码)；依赖清单加 app/logto/minio 三条，迁移与种子进既有目录，沙箱内 `pnpm run test:scripted` 4 条用例全绿（退出码 0）。下一轮需求见 `BRIEF-NEXT.md`，闭环验收演练待做。
- 2026-10-29：01 免root打样验证完成——专属用户 + 子 ID 段 + 用户级免 root 守护进程 + 套接字挂载 + 同网桥按名互访全部跑通；02、04 可开工，注意基础镜像的 docker 客户端须与宿主守护进程同版本。
- 2026-10-29：挂载契约修订——套接字为唯一固定挂载，其余由用户声明。
- 2026-10-29：归档全部架构决策（7 篇 ADR）与一期任务拆分。
