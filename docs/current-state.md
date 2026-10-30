# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 活跃需求
- Agent 开发沙箱平台 — 给 pi agent 提供隔离、可复用的全栈开发沙箱，核心价值是 agent 自主完成端到端测试。需求文档：[[prds/sandbox-platform.md|Agent 开发沙箱平台]]。
- 二期 控制面服务化与网页控制台 — 把一期控制面模块常驻为 FastAPI 服务并提供网页控制台（沙箱管理 / 网页终端 / 代理设置），不做认证，命令行不改。需求文档：[[prds/phase2-console.md|二期 控制面服务化与网页控制台]]。

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
| 二期任务集 | doing | 5 个任务，依赖顺序 01 → 02/03（可并行）→ 04 → 05；需求见 [[prds/phase2-console.md\|二期 PRD]] |
| [[tasks/phase2-console/01-service-core-api.md\|01 控制面服务骨架与沙箱管理接口]] | done | 服务层子包 sandbox_platform.server 落地（应用工厂 / 依赖注入 / 请求与响应模型 / 沙箱管理路由 / 错误映射 / 启动入口），核心包加 image_source 开关（命令行零变化）；审查修复轮完成（同名并发互斥 / 500 脱敏 / 接口文档默认关闭），209 项 pytest 全通过 |
| [[tasks/phase2-console/02-image-proxy-api.md\|02 宿主镜像枚举与代理状态管理接口]] | done | list_host_images + 代理状态/重启/CA 指纹比对落地；审查修复轮完成（状态与重启接口不再 500、CA 指纹口径收敛并新增 `ca_reinstalled`）；272 项 pytest 全通过 |
| [[tasks/phase2-console/03-web-terminal.md\|03 网页终端]] | todo | 伪终端会话 + WebSocket 桥接 + 会话表持久化；依赖 01 |
| [[tasks/phase2-console/04-console-frontend.md\|04 网页控制台前端]] | todo | React+Vite 四页面（列表/新建/详情+终端/设置）；依赖 01/02/03 |
| [[tasks/phase2-console/05-acceptance-regression.md\|05 二期端到端验收与一期回归复验]] | todo | 网页全流程演练 + 命令行等价性 + 一期无回归；依赖 01~04 |

## TODO / 阻塞
- [ ] 默认全栈沙箱镜像待基于 base 0.2.0 重建（当前 0.1.0 仍含离线包层）。
- [ ] 统一镜像代理缓存 GC 命令待做。
- 阻塞项：无。

## 最近变更
- 2026-10-30：二期任务 02 审查修复轮 + UserDaemon root 分支修复（同一提交）——任务 02 侧修掉**状态 / 重启接口的 500 漏口**：宿主命令缺失或超时、代理 CA 证书不是 UTF-8、代理返回截断响应都会顶成 500；现在状态查询外层兜住异常并降级为「不健康 + 明细」（明细区分「容器不存在」「容器未运行」「端口不通」），重启流程兜住命令异常并写 `last_error`，重启接口稳定返回 200 + `restarted=false`。**CA 指纹口径收敛**：改为「变更前后都读得到证书才算变了」（原先 CA 首次生成会被误报成「CA 已变更」），指纹先做空白归一化再哈希（换行差异不算变更）；新增 `ca_reinstalled` 字段——CA 变了但新 CA 读不到时如实说「未能重装合并证书链」，**不把未修复报成已修复**；新增 `failed_users` 回传单个用户重装失败（失败只记日志，不阻断其余用户）。其余修复：重启成功路径补挂载一致性校验（不一致则删除后按首次启动路径重建）、锁语义文档与实现对齐（创建流程实为阻塞等待代理锁，重启结束后再判定可达性）、`docker restart` 超时跟 `restart(timeout)` 挂钩（不再写死 120 秒）、重启失败分支消息追加 CA 状态、接口文档标注重启端点是**未认证特权端点**（本机任意进程可调用，可反复重启打断沙箱拉镜像）、测试不再污染全局 `time.sleep`。UserDaemon 侧修复**进程本身是 root 时 `user_argv` 产出非法命令行**（`-u <用户>` 少了提权前缀，而 root 环境下 `sudo` 未必存在，服务化后该分支是主路径）——root 分支改用 `setpriv --reuid <uid> --regid <gid> --clear-groups env -i …`，非 root 分支逐字不变，连接提示同步按运行身份给对应前缀。命令行 `platform/cli/sandboxctl.py` 源码仍一行未改，一期行为零变化。测试 272 项 pytest 全通过。
- 2026-10-30：二期任务 01 审查修复轮——修复 1 项严重问题与 8 项中等问题，另落地 12 项采纳的建议。严重问题：**同名沙箱并发创建互相拆台**（`store.exists` 非原子「查-用」），核心包 `SandboxService` 加按名互斥（进程内锁字典）+ 原子占用名字（`<平台数据根>/locks/<名>.lock` 用 `O_EXCL` 落占位文件，创建失败回收、删除时释放），命令行与服务端同受益。中等问题：命令引号不配对改 400（原落 500）、回收清单对不存在沙箱改 404、500 分支改固定文案「平台内部错误，请查看服务日志」（原文只进日志，不回显宿主路径与特权命令行）、宿主无此镜像改 400、新增的两处测试用例挂临时目录夹具（原先直接操作真实 `/var/lib/sandbox-platform`）、分层契约检测补 `subprocess` / `os.system` / `os.popen` / `docker` / `sudo` 禁令并合并重复用例、镜像注入中转文件改用镜像引用摘要命名（原先 `a/b:1` 与 `a_b:1` 同名）。采纳建议：删无信息量包装层、镜像来源显式三分支、host 模式判定按创建/启动两条路径分开、请求模型 `extra="forbid"`、创建返回 201、前端未挂载时告警且健康接口暴露 `console_mounted`、健康接口不再回显平台数据根路径（只给 `data_root_configured`）、详情接口环境变量值脱敏、端口非法退出码 2、非回环监听打醒目告警、接口文档默认关闭（`SANDBOX_CONSOLE_DOCS` 显式开启）。命令行 `platform/cli/sandboxctl.py` 源码仍一行未改，一期行为零变化。测试 209 项 pytest 全通过（一期既有 158 项无回归）。
- 2026-10-29：二期任务 01 完成——控制面服务骨架与沙箱管理接口。服务层子包 `platform/src/sandbox_platform/server/` 落地：`create_app()` 应用工厂（`/api` 前缀、`console/dist` 静态托管、lifespan 准备数据目录并清理遗留终端会话记录）、`deps.py` 依赖注入、`schemas.py` 请求与响应模型、`routes/sandboxes.py` 七条沙箱路由（创建 / 列表 / 详情 / 启动 / 停止 / 回收清单 / 删除）、固定错误映射（入参非法 400 / 不存在 404 / 已存在 409 / 其余平台异常 500，响应体统一 `{"detail": "中文消息"}`）。核心包新增可选字段 `CreateRequest.image_source`（`auto` 默认保持一期行为，`host` 强制从宿主导出注入、不经镜像代理），命令行 `sandboxctl.py` 源码一行未改。启动入口 `uv run python -m sandbox_platform.server`（默认 `127.0.0.1:8000`，可用 `SANDBOX_CONSOLE_HOST` / `SANDBOX_CONSOLE_PORT` 覆盖），随附 systemd 单元模板 `platform/server/sandbox-console.service`（不自动安装）。测试 188 项 pytest 全通过（一期既有 158 项无回归）。
- 2026-10-29：二期 PRD 定稿并完成任务拆分——控制面服务化与网页控制台（FastAPI 服务 + 网页控制台 + 网页终端 + 代理设置页），范围相对原二期概要做了两处裁剪：不做认证（内部部署、个人使用）、命令行不改造成服务客户端；拆分 5 个任务，依赖顺序 01 → 02/03 → 04 → 05。见 [[prds/phase2-console.md|二期 PRD]] 与 [[tasks/phase2-console/README.md|二期任务集]]。
- 2026-10-29：镜像供给改为统一镜像代理（ADR 0008），废弃离线包——基础镜像不再内置 postgres / minio / logto 离线 tar，三件套及一切外部镜像统一经镜像代理拉取（缓存命中走本地，未命中由代理拉一次外网）；宿主导出注入收窄为本地构建镜像专用；代理不可达即拉取失败、不降级直连。详见 [[architecture/decisions/0008-统一镜像代理与离线包废弃.md|ADR 0008 统一镜像代理与离线包废弃]]。
- 2026-10-29：安全加固轮完成——一期平台按审查结论修复 7 条严重问题与 12 条中等问题：沙箱名穿越（七个入口统一校验 + 元数据目录兜底断言）、删除路径不再信任元数据（用户信息现查 `getent passwd`、单元路径重算、只回收平台自建网络）、守护进程启动改 `--no-block` 且就绪统一交给套接字等待、子 ID 段回收加锁、用户指定网络不回收、回滚不删既有用户、终止用户返回真实结果；回收清单并入实时扫描（探测失败标注不完整）、宿主敏感路径与含逗号挂载拒绝、元数据权限改 0600、命名白名单、命令返回码如实上报。新增 59 项回归测试，141 项 pytest（含 7 项 root 标记测试）与 24 项冒烟判定全通过；端到端用例库改回「每用例一库」，沙箱内复验 6 条用例全绿（退出码 0）。记录见 `platform/e2e/RESULTS.md` 第十二节。
- 2026-10-29：一期（本地闭环）六个任务全部完成，闭环验收通过——总验收 1/1 通过、分项 8 条全通过；验收暴露的两处平台缺口已登记到上方 TODO。
- 2026-10-29：一期总验收完成——闭环验收演练落地：agent 只拿 `BRIEF-NEXT.md`（R1 列表过滤 / R2 提交加载态），在全新沙箱 `acceptance-lab` 里独立完成「读需求 → 改码 → 起依赖 → 跑端到端 → 看截图 → 修复 → 全绿」，2 轮循环内从 2 failed 走到 6 passed（退出码 0）；沙箱创建 26.4 秒、`up.sh` 22.5 秒、端到端 5.4 秒；删除沙箱后逐项复验回收干净，用户挂载目录原样存在且含本轮实现。一期总验收与分项结论见仓库根目录 `RESULTS.md`。
- 2026-10-29：06 第一步完成——全栈示例项目落地 `platform/examples/fullstack-sample/`（后端 FastAPI+uv、前端 React+Vite），真实对接 Postgres / MinIO(S3) / Logto(OIDC 授权码)；依赖清单加 app/logto/minio 三条，迁移与种子进既有目录，沙箱内 `pnpm run test:scripted` 4 条用例全绿（退出码 0）。下一轮需求见 `BRIEF-NEXT.md`，闭环验收演练待做。
- 2026-10-29：01 免root打样验证完成——专属用户 + 子 ID 段 + 用户级免 root 守护进程 + 套接字挂载 + 同网桥按名互访全部跑通；02、04 可开工，注意基础镜像的 docker 客户端须与宿主守护进程同版本。
- 2026-10-29：挂载契约修订——套接字为唯一固定挂载，其余由用户声明。
- 2026-10-29：归档全部架构决策（7 篇 ADR）与一期任务拆分。
