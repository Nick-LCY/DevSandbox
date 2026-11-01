# 沙箱平台 · 总验收结论留档（一期本地闭环 + 二期控制面）

> **留档说明**
> - 本文件是沙箱平台**平台侧验收结论**的留档：第一至第四节为一期（本地闭环）的总验收与分项结论，第五至第七节为二期（控制面服务化与网页控制台）的验收结论。2026-11-01 自仓库根 `RESULTS.md` 内化进文档库，仓库根同名文件同时删除。
> - 文中出现的路径与证据文件（`platform/probe/`、`platform/base-image/`、`platform/sandbox-image/`、`platform/e2e/`、`platform/examples/`、`platform/console/`、`platform/scripts/`）一律按**一、二期当时的目录结构**理解；此后多轮清理中，一次性探针目录、默认全栈镜像构建目录与其 RESULTS、冒烟脚本目录、`examples/` 示例目录等证据文件已被移除。
> - **证据链以 git 历史为准**（清理时点 104 个提交完整）。结论按验收当时口径原样保留，不因后续变更改写；后续口径变更见 [[current-state.md|当前状态]]。
> - 关联页面：[[tasks/sandbox-platform/README.md|一期任务集]]、[[prds/sandbox-platform.md|一期需求]]、[[tasks/phase2-console/README.md|二期任务集]]、[[prds/phase2-console.md|二期需求]]、[[glossary.md|词汇表]]。

---

> - 验收日期：2026-10-29
> - 验收对象：沙箱平台一期，判据来自 [[prds/sandbox-platform.md|一期需求]] 的「一期总验收」与「一期分项」
> - **总结论：一期总验收通过（1/1），一期分项 8 条全部通过，无不通过项，不存在阻塞后续任务的问题**
> - 证据索引：闭环全过程见 `platform/examples/fullstack-sample/LOOP-LOG.md`；
>   实测数据见 `platform/examples/fullstack-sample/RESULTS.md`（第八节为闭环验收演练）；
>   各组件实测见 `platform/probe/rootless/RESULTS.md`、`platform/base-image/RESULTS.md`、
>   `platform/sandbox-image/RESULTS.md`、`platform/e2e/RESULTS.md`

## 一、一期总验收（必须全绿）

| 判据 | 结论 | 依据 |
|---|---|---|
| 在真实全栈示例项目（React 前端 + FastAPI 后端 + Postgres + MinIO + Logto）上，agent 在**无任何人工介入**的情况下独立跑通「改码 → 起环境 → 端到端 → 看截图 → 修复 → 全绿」全程 | **通过** | 全栈示例项目在 `platform/examples/fullstack-sample/`；2026-10-29 的闭环验收演练：agent 只拿 `BRIEF-NEXT.md`（R1 列表过滤 / R2 提交加载态），在全新沙箱 `acceptance-lab` 里独立完成 **读需求 → 读现有代码 → 改码 → 起依赖与应用 → 跑端到端 → 看截图 → 修复 → 全绿**，**2 轮**改码→跑测循环内从红（2 failed / 4 passed，退出码 1）到绿（6 passed，退出码 0）；全过程命令与决策逐步记在 `platform/examples/fullstack-sample/LOOP-LOG.md`，截图与 trace 落在用户声明挂载的代码目录内 |

**关于「无人工介入」的口径说明**（不夸大）：本轮只有「注入需求（写判死用例）」、「建沙箱」、「写文档与提交」三件事在宿主侧由执行者完成；
从「读需求」到「看截图并修复」的全部动作（改码、起依赖与应用、跑端到端、读 PNG、修 bug、重跑）都在沙箱容器内以 `docker exec` 执行，
全程没有人工点击界面，也没有人工代敲测试命令。

## 二、一期分项

| 分项 | 结论 | 依据 | 是否阻塞后续 |
|---|---|---|---|
| **免 root**：沙箱以专属用户运行，全流程不需要宿主 root 凭据；该用户执行 `docker ps` 只显示本沙箱容器 | 通过 | 沙箱用户 `sandbox-acceptance-lab`（uid 1001）+ systemd 用户级 rootless dockerd；沙箱容器内 `docker ps` 只列出本沙箱的 4 个容器（沙箱容器 + postgres + minio + logto）；`platform/probe/rootless/RESULTS.md` 判定 1~3 通过 | 不阻塞 |
| **权限隔离**：容器内无法读写其他沙箱用户目录与宿主挂载目录；子 UID/GID 段生效（容器内 `id` 显示 UID 0、宿主侧显示映射后的高位 UID） | 通过 | 本轮实测：容器内 `id` → `uid=0(root)`，宿主侧文件属主为 `sandbox-acceptance-lab`(1001)，子 ID 段 `165536:65536` 登记在 `/etc/subuid`、`/etc/subgid`；`platform/probe/rootless/RESULTS.md` 判定 4~6 通过（`uid_map` 按区间映射的等价口径判定） | 不阻塞 |
| **挂载**：固定挂载的套接字可用且位于 `/var/run/docker.sock`；用户声明的挂载按声明的权限生效；未声明任何挂载的沙箱仅挂载套接字即可正常使用 | 通过 | 本轮沙箱套接字挂载点 `/var/run/docker.sock`，容器内 `docker ps` 可用；两个用户声明挂载（`/workspace/fullstack-sample`、`/workspace/e2e`）按声明生效且沙箱内可写（宿主侧靠 `chmod o+rwX` 放行，属主不变）；`platform/e2e` 产物目录等未声明挂载的沙箱行为见任务 04 的实测 | 不阻塞 |
| **镜像**：基础镜像可用；默认全栈镜像内 pi / git / uv / node / pnpm / Playwright 浏览器齐备；依赖离线包首次自动加载、第二次不重复加载 | 通过 | `sandbox-platform/base:0.1.0`（534.4 MB）与 `sandbox-platform/sandbox-default:0.1.0`（1212.9 MB）建成；容器内 node 22.23.1 / pnpm 10.32.1 / uv 0.11.29 / Playwright 1.64.1 / chromium 156 全部就绪；离线包首次加载 23 秒、二次 skip（`platform/base-image/RESULTS.md`、`platform/sandbox-image/RESULTS.md`）。**后续变更**：离线包机制已按 [[architecture/decisions/0008-统一镜像代理与离线包废弃.md|ADR 0008]] 废弃，基础镜像升到 0.2.0（47.7 MB），依赖镜像改经统一镜像代理缓存拉取 | 不阻塞 |
| **网络**：依赖容器按容器名互访；宿主无任何由沙箱发布的新增监听端口 | 通过 | 依赖容器与沙箱容器同网桥 `acceptance-lab-net`，按容器名互访（`postgres:5432`、`minio:9000`、`logto:3001/3002`，应用以别名 `app` 对外）；本轮宿主 `ss -ltn` 无新增监听端口，沙箱容器不发布任何端口到宿主 | 不阻塞 |
| **生命周期**：`create / stop / delete / list` 行为符合 PRD；`delete` 前提示含回收清单与「用户挂载的宿主机目录不受影响」字样；删除后平台资源全部回收，用户挂载的外部目录原样存在且内容未变 | 通过 | 本轮 `create` 走固定 7 步、耗时 26.4 秒；`delete acceptance-lab --yes` 打印完整回收清单并含该字样；删除后逐项复验：沙箱容器 + 3 个依赖容器、守护进程与用户级单元、系统用户与家目录、子 ID 段、平台元数据全部已回收；两个用户挂载目录删除前后 md5 指纹逐个一致，内容含本轮新增实现（详见 `platform/examples/fullstack-sample/RESULTS.md` 第 8.5 节） | 不阻塞 |
| **端到端**：脚本模式与探索模式均可执行；健康检查门禁生效；每用例独立数据库；截图与 trace 落在代码目录内 | 通过 | 本轮 `pnpm run test:scripted` 退出码 0（6 条用例，2 个 worker 并行）、`pnpm run test:explore` 退出码 0；门禁按「等依赖健康 → 迁移 → 种子」固定顺序执行并打印每个依赖的判据与 120 秒上限；每 worker 独占用例库（`e2e_test_w0_*` / `e2e_test_w1_*`，该口径已在安全加固轮改为每用例一库，见第四节第 2 条），克隆耗时 130~159 毫秒；截图与 trace 全部落在 `platform/e2e/artifacts/`（用户声明挂载的代码目录内） | 不阻塞 |
| **证据**：总验收全程留存截图与 trace，可回溯 | 通过 | 本轮截图 6 张（其中 3 张是本轮新增功能证据），trace 7 份，全部在 `platform/e2e/artifacts/`；失败基线那一轮的失败截图与 trace 也保留在 `artifacts/test-results/`；逐步命令与决策在 `platform/examples/fullstack-sample/LOOP-LOG.md` | 不阻塞 |

## 三、一期任务逐条完成情况

各任务的完整目标、完成标准与实测口径见对应留档页。

| 任务 | 状态 | 关键证据 |
|---|---|---|
| [[tasks/sandbox-platform/01-rootless-probe.md\|01 免 root 打样验证]] | done | `platform/probe/rootless/RESULTS.md`：14 项技术判定全部通过 |
| [[tasks/sandbox-platform/02-base-image.md\|02 平台基础镜像]] | done | `platform/base-image/RESULTS.md`：镜像 534.4 MB，离线包首次加载 23 秒；**0.2.0（ADR 0008）**：47.7 MB，无离线包，统一镜像代理拉取 15.25 秒 → 命中缓存 3.44 秒 |
| [[tasks/sandbox-platform/03-sandbox-image.md\|03 默认全栈沙箱镜像]] | done | `platform/sandbox-image/RESULTS.md`：镜像 1212.9 MB，工具链与浏览器齐备 |
| [[tasks/sandbox-platform/04-lifecycle-core-cli.md\|04 生命周期核心模块与 CLI]] | done | `platform/src/sandbox_platform/` + `platform/cli/sandboxctl.py`；创建 7 步、删除固定回收清单 |
| [[tasks/sandbox-platform/05-e2e-harness.md\|05 端到端测试基建]] | done | `platform/e2e/RESULTS.md`：脚本/探索两模式、门禁、每用例独立库、契约断言命中数 0 |
| [[tasks/sandbox-platform/06-sample-app-acceptance.md\|06 示例项目与验收演练]] | done | `platform/examples/fullstack-sample/`：全栈示例 + 本轮闭环验收演练（LOOP-LOG 与 RESULTS 第八节） |

## 四、一期已知边界与后续输入

1. ~~**删除前的回收清单没列依赖容器**~~：**已于安全加固轮修复**——`delete` 前实时扫描守护进程网络上的容器
   （剔除沙箱容器自身）与元数据旧列表取并集进提示清单，探测失败时在清单标注「可能不完整」。
2. ~~**用例库按 worker 分配而非按用例分配**~~：**已于安全加固轮修复**——端到端 fixture 作用域改为用例级，
   库名带用例标识（`e2e_test_t<用例ID>_<运行编号>`），沙箱内复验 6 条用例全绿、退出码 0
   （记录见 `platform/e2e/RESULTS.md` 第十二节）；PRD 措辞本就写的是每用例一库，无需改动。
3. **会话存在应用进程内存里**：应用重启即掉登录态；多副本部署需要共享存储。
4. **平台不做 git 操作**：代码目录由用户挂载并自行纳入 git 管理，平台只执行挂载声明。

---

> - 验收日期：2026-10-30
> - 验收对象：沙箱平台二期，判据来自 [[prds/phase2-console.md|二期需求]] 的「验收标准」8 条
> - 验收方式：Playwright 驱动真实浏览器，打真实控制台服务与真实沙箱；一条命令跑完，退出码即判定
> - **总结论：二期验收标准 8 条全部通过（8/8），无不通过项；一期回归全绿，未发现平台缺陷**
> - 逐条实测数据见 `platform/console/RESULTS.md`（该文件现已随目录重组迁至 `apps/web/frontend/RESULTS.md`）；验收脚本见 `platform/console/tests/`

## 五、二期分项

| 分项 | 结论 | 依据 | 是否阻塞后续 |
|---|---|---|---|
| **全流程**：网页独立完成「从宿主本地镜像选一个创建沙箱 → 开终端操作 → 停止 → 再启动 → 删除」 | 通过 | 一条验收用例跑完全流程，20.25 秒（沙箱创建 4359 毫秒）；终端回显断言命中；停止/再启动后容器状态与子 ID 段符合一期语义；删除走回收清单弹窗（先取消、再确认） | 不阻塞 |
| **本地构建镜像**：不存在于任何仓库的镜像可经网页选用并创建成功（注入路径走通） | 通过 | 现场构建 `sandbox-console-acceptance/local-only-cbd1dacd:0.1.0`（26.9 MB，名字带一次性随机后缀）；`docker manifest inspect` 失败、直连仓库返回 HTTP 401；网页下拉可选、创建成功、沙箱守护进程里确实拿到了它；宿主没有的镜像按契约报 400 不降级直连 | 不阻塞 |
| **网页终端**：多终端并行、断线重连不丢现场、服务重启后失效并明确提示 | 通过 | 两个终端的宿主侧 exec 进程号互不相同且内容互不串扰；断开浏览器上下文后重开，输出回放、后台进程未被杀（写入计数继续涨）；重启服务后页面提示「终端会话已失效（后端服务已重启），请新建终端」，会话表已清空，沙箱容器不受影响 | 不阻塞 |
| **等价性**：网页触发的沙箱操作与一期命令行对同一沙箱产生等价状态 | 通过 | 同一沙箱的列表字段、挂载清单逐字段相等；网页停 → 命令行读到 `stopped`、容器 `exited`；命令行启 → 网页读到「运行中」、容器 `running`；回收清单网页接口与命令行打印一字不差；参数相同的两个沙箱（网页建/命令行建）状态与挂载等价，两边镜像 ID 相同 | 不阻塞 |
| **删除回收**：回收语义与一期一致，用户挂载目录不受影响 | 通过 | 网页弹窗列出 7 项回收清单并写明「用户挂载的宿主机目录不受影响」；删除后沙箱容器/依赖容器/网桥网络/systemd 单元/用户与家目录/子 UID-GID 段/平台元数据全部回收，删除接口 `failed` 为空；用户声明挂载的外部目录删除前后内容指纹一致；重复删除幂等 | 不阻塞 |
| **镜像代理**：沙箱内依赖镜像拉取仍统一经镜像代理，一期行为无回归 | 通过 | 守护进程单元仍注入 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`/`SSL_CERT_FILE`；沙箱内 `docker pull busybox:1.37` 成功，代理访问日志留有 `host=registry-1.docker.io`、`upstream_cache_status=HIT` 的记录 | 不阻塞 |
| **安全边界**：服务只监听回环或内网地址，不做认证，不暴露公网 | 通过 | `ss -ltnp` 显示只监听 `127.0.0.1:8100`；不带凭据直接调接口返回 200；`/docs` 与 `/openapi.json` 默认 404；前端产物同端口托管 | 不阻塞 |
| **一期零变化**：`sandboxctl` 源码未改，一期 pytest 与冒烟判定全通过 | 通过 | `platform/cli/sandboxctl.py` 最后一次改动仍是**一期**提交，本次验收未改一行；`uv run pytest` 288 passed / 0 failed（基线同为 288 项）；`platform/scripts/smoke-lifecycle.sh` 共 30 项判定、不通过 0 项、退出码 0 | 不阻塞 |

## 六、二期任务逐条完成情况

各任务的完整目标、完成标准与实测口径见对应留档页。

| 任务 | 状态 | 关键证据 |
|---|---|---|
| [[tasks/phase2-console/01-service-core-api.md\|01 控制面服务骨架与沙箱管理接口]] | done | `platform/src/sandbox_platform/server/`：FastAPI 服务 + 一期命令行共用同一批核心函数；错误映射 400/404/409/500 |
| [[tasks/phase2-console/02-image-proxy-api.md\|02 宿主镜像枚举与代理状态管理接口]] | done | `GET /api/images` 实时枚举宿主本地镜像（含任何仓库都没有的本地构建镜像）；`GET/POST /api/proxy/status` 与 `/api/proxy/restart` |
| [[tasks/phase2-console/03-web-terminal.md\|03 网页终端]] | done | `platform/src/sandbox_platform/server/terminal.py`：伪终端 + WebSocket 桥接，真实 TTY、多终端并行、断线回放、服务重启即失效 |
| [[tasks/phase2-console/04-console-frontend.md\|04 网页控制台前端]] | done | `platform/console/`：React + Vite + TypeScript；列表/新建/详情（含终端）/代理设置四页；119 个静态定位符 + 10 个模板定位符（源码实测），清单见 `platform/console/README.md` |
| [[tasks/phase2-console/05-acceptance-regression.md\|05 端到端验收与一期回归复验]] | done | `platform/console/tests/`：14 条 Playwright 用例，一条命令跑完，退出码即判定，失败留截图与 trace；`platform/console/RESULTS.md` 逐条对应 PRD 8 条验收标准 |

## 七、二期已知边界与后续输入

1. **沙箱容器与网桥网络的回收证据依赖平台自身的删除结果**：两者活在免 root 守护进程的私有命名空间里，
   用户家目录被回收后该命名空间整体消失，删除后无法在宿主侧再查一次容器清单。宿主侧可独立确认的是
   「该 uid 名下无守护进程残留」「宿主 root 守护进程里无同名容器」「家目录与子 ID 段已回收」
   「平台元数据已回收」。一期冒烟脚本用的是同一套判据，口径一致。
2. **命令行与网页的镜像来源字段按设计不同**：网页新建固定 `image_source=host`，命令行不传该字段、保持一期默认 `auto`；
   两者用平台自建镜像时最终都落到宿主导出注入，两个沙箱里的镜像 ID 相同，不是行为分叉。
3. **同一沙箱避免网页与命令行同时操作**仍是使用纪律，本期未做技术强制（PRD 已明确本期不改造命令行）。
4. **服务重启会连带杀掉沙箱容器内的残留会话进程**：PRD 已确认可接受的口径；实测重启后旧会话立即失效、页面提示明确，
   沙箱容器本身不受影响。
