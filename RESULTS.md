# 沙箱平台 · 一期总验收结论

> - 验收日期：2026-10-29
> - 验收对象：沙箱平台一期，判据来自 `docs/prds/sandbox-platform.md` 的「一期总验收」与「一期分项」
> - **总结论：一期总验收通过（1/1），一期分项 8 条全部通过，无不通过项，不存在阻塞后续任务的问题**
> - 证据索引：闭环全过程见 `platform/examples/fullstack-sample/LOOP-LOG.md`；
>   实测数据见 `platform/examples/fullstack-sample/RESULTS.md`（第八节为闭环验收演练）；
>   各组件实测见 `platform/probe/rootless/RESULTS.md`、`platform/base-image/RESULTS.md`、
>   `platform/sandbox-image/RESULTS.md`、`platform/e2e/RESULTS.md`

---

## 一、一期总验收（必须全绿）

| 判据 | 结论 | 依据 |
|---|---|---|
| 在真实全栈示例项目（React 前端 + FastAPI 后端 + Postgres + MinIO + Logto）上，agent 在**无任何人工介入**的情况下独立跑通「改码 → 起环境 → 端到端 → 看截图 → 修复 → 全绿」全程 | **通过** | 全栈示例项目在 `platform/examples/fullstack-sample/`；2026-10-29 的闭环验收演练：agent 只拿 `BRIEF-NEXT.md`（R1 列表过滤 / R2 提交加载态），在全新沙箱 `acceptance-lab` 里独立完成 **读需求 → 读现有代码 → 改码 → 起依赖与应用 → 跑端到端 → 看截图 → 修复 → 全绿**，**2 轮**改码→跑测循环内从红（2 failed / 4 passed，退出码 1）到绿（6 passed，退出码 0）；全过程命令与决策逐步记在 `platform/examples/fullstack-sample/LOOP-LOG.md`，截图与 trace 落在用户声明挂载的代码目录内 |

**关于「无人工介入」的口径说明**（不夸大）：本轮只有「注入需求（写判死用例）」、「建沙箱」、「写文档与提交」三件事在宿主侧由执行者完成；
从「读需求」到「看截图并修复」的全部动作（改码、起依赖与应用、跑端到端、读 PNG、修 bug、重跑）都在沙箱容器内以 `docker exec` 执行，
全程没有人工点击界面，也没有人工代敲测试命令。

---

## 二、一期分项

| 分项 | 结论 | 依据 | 是否阻塞后续 |
|---|---|---|---|
| **免 root**：沙箱以专属用户运行，全流程不需要宿主 root 凭据；该用户执行 `docker ps` 只显示本沙箱容器 | 通过 | 沙箱用户 `sandbox-acceptance-lab`（uid 1001）+ systemd 用户级 rootless dockerd；沙箱容器内 `docker ps` 只列出本沙箱的 4 个容器（沙箱容器 + postgres + minio + logto）；`platform/probe/rootless/RESULTS.md` 判定 1~3 通过 | 不阻塞 |
| **权限隔离**：容器内无法读写其他沙箱用户目录与宿主挂载目录；子 UID/GID 段生效（容器内 `id` 显示 UID 0、宿主侧显示映射后的高位 UID） | 通过 | 本轮实测：容器内 `id` → `uid=0(root)`，宿主侧文件属主为 `sandbox-acceptance-lab`(1001)，子 ID 段 `165536:65536` 登记在 `/etc/subuid`、`/etc/subgid`；`platform/probe/rootless/RESULTS.md` 判定 4~6 通过（`uid_map` 按区间映射的等价口径判定） | 不阻塞 |
| **挂载**：固定挂载的套接字可用且位于 `/var/run/docker.sock`；用户声明的挂载按声明的权限生效；未声明任何挂载的沙箱仅挂载套接字即可正常使用 | 通过 | 本轮沙箱套接字挂载点 `/var/run/docker.sock`，容器内 `docker ps` 可用；两个用户声明挂载（`/workspace/fullstack-sample`、`/workspace/e2e`）按声明生效且沙箱内可写（宿主侧靠 `chmod o+rwX` 放行，属主不变）；`platform/e2e` 产物目录等未声明挂载的沙箱行为见任务 04 的实测 | 不阻塞 |
| **镜像**：基础镜像可用；默认全栈镜像内 pi / git / uv / node / pnpm / Playwright 浏览器齐备；依赖离线包首次自动加载、第二次不重复加载 | 通过 | `sandbox-platform/base:0.1.0`（534.4 MB）与 `sandbox-platform/sandbox-default:0.1.0`（1212.9 MB）建成；容器内 node 22.23.1 / pnpm 10.32.1 / uv 0.11.29 / Playwright 1.64.1 / chromium 156 全部就绪；离线包首次加载 23 秒、二次 skip（`platform/base-image/RESULTS.md`、`platform/sandbox-image/RESULTS.md`）。**后续变更**：离线包机制已按 ADR 0008 废弃，基础镜像升到 0.2.0（47.7 MB），依赖镜像改经统一镜像代理缓存拉取 | 不阻塞 |
| **网络**：依赖容器按容器名互访；宿主无任何由沙箱发布的新增监听端口 | 通过 | 依赖容器与沙箱容器同网桥 `acceptance-lab-net`，按容器名互访（`postgres:5432`、`minio:9000`、`logto:3001/3002`，应用以别名 `app` 对外）；本轮宿主 `ss -ltn` 无新增监听端口，沙箱容器不发布任何端口到宿主 | 不阻塞 |
| **生命周期**：`create / stop / delete / list` 行为符合 PRD；`delete` 前提示含回收清单与「用户挂载的宿主机目录不受影响」字样；删除后平台资源全部回收，用户挂载的外部目录原样存在且内容未变 | 通过 | 本轮 `create` 走固定 7 步、耗时 26.4 秒；`delete acceptance-lab --yes` 打印完整回收清单并含该字样；删除后逐项复验：沙箱容器 + 3 个依赖容器、守护进程与用户级单元、系统用户与家目录、子 ID 段、平台元数据全部已回收；两个用户挂载目录删除前后 md5 指纹逐个一致，内容含本轮新增实现（详见 `platform/examples/fullstack-sample/RESULTS.md` 第 8.5 节） | 不阻塞 |
| **端到端**：脚本模式与探索模式均可执行；健康检查门禁生效；每用例独立数据库；截图与 trace 落在代码目录内 | 通过 | 本轮 `pnpm run test:scripted` 退出码 0（6 条用例，2 个 worker 并行）、`pnpm run test:explore` 退出码 0；门禁按「等依赖健康 → 迁移 → 种子」固定顺序执行并打印每个依赖的判据与 120 秒上限；每 worker 独占用例库（`e2e_test_w0_*` / `e2e_test_w1_*`，该口径已在安全加固轮改为每用例一库，见第四节第 2 条），克隆耗时 130~159 毫秒；截图与 trace 全部落在 `platform/e2e/artifacts/`（用户声明挂载的代码目录内） | 不阻塞 |
| **证据**：总验收全程留存截图与 trace，可回溯 | 通过 | 本轮截图 6 张（其中 3 张是本轮新增功能证据）、trace 7 份，全部在 `platform/e2e/artifacts/`；失败基线那一轮的失败截图与 trace 也保留在 `artifacts/test-results/`；逐步命令与决策在 `platform/examples/fullstack-sample/LOOP-LOG.md` | 不阻塞 |

---

## 三、一期任务逐条完成情况

| 任务 | 状态 | 关键证据 |
|---|---|---|
| 01 免 root 打样验证 | done | `platform/probe/rootless/RESULTS.md`：14 项技术判定全部通过 |
| 02 平台基础镜像 | done | `platform/base-image/RESULTS.md`：镜像 534.4 MB，离线包首次加载 23 秒；**0.2.0（ADR 0008）**：47.7 MB，无离线包，统一镜像代理拉取 15.25 秒 → 命中缓存 3.44 秒 |
| 03 默认全栈沙箱镜像 | done | `platform/sandbox-image/RESULTS.md`：镜像 1212.9 MB，工具链与浏览器齐备 |
| 04 生命周期核心模块与 CLI | done | `platform/src/sandbox_platform/` + `platform/cli/sandboxctl.py`；创建 7 步、删除固定回收清单 |
| 05 端到端测试基建 | done | `platform/e2e/RESULTS.md`：脚本/探索两模式、门禁、每用例独立库、契约断言命中数 0 |
| 06 示例项目与验收演练 | done | `platform/examples/fullstack-sample/`：全栈示例 + 本轮闭环验收演练（LOOP-LOG 与 RESULTS 第八节） |

---

## 四、已知边界与后续输入

1. ~~**删除前的回收清单没列依赖容器**~~：**已于安全加固轮修复**——`delete` 前实时扫描守护进程网络上的容器
   （剔除沙箱容器自身）与元数据旧列表取并集进提示清单，探测失败时在清单标注「可能不完整」。
2. ~~**用例库按 worker 分配而非按用例分配**~~：**已于安全加固轮修复**——端到端 fixture 作用域改为用例级，
   库名带用例标识（`e2e_test_t<用例ID>_<运行编号>`），沙箱内复验 6 条用例全绿、退出码 0
   （记录见 `platform/e2e/RESULTS.md` 第十二节）；PRD 措辞本就写的是每用例一库，无需改动。
3. **会话存在应用进程内存里**：应用重启即掉登录态；多副本部署需要共享存储。
4. **平台不做 git 操作**：代码目录由用户挂载并自行纳入 git 管理，平台只执行挂载声明。
