# 网页控制台 · 二期端到端验收实测记录

> - 验收日期：2026-10-30
> - 验收对象：沙箱平台二期「控制面服务化与网页控制台」，判据来自 `docs/prds/phase2-console.md` 的「验收标准」8 条
> - 验收方式：Playwright 驱动**真实浏览器**，打**真实控制台服务**与**真实沙箱**；一条命令跑完，退出码即判定
> - **总结论：PRD 验收标准 8 条全部通过（8/8），无不通过项；一期回归全绿，未发现平台缺陷**
> - 验收脚本：`platform/console/tests/`（14 条用例）；留档：本文件；平台侧结论另见仓库根 `RESULTS.md`

---

## 一、PRD 验收标准逐条结论

| # | 验收标准 | 结论 | 实测数据 | 证据 |
|---|---|---|---|---|
| 1 | 网页独立完成「从宿主本地镜像选一个创建沙箱 → 开终端操作 → 停止 → 再启动 → 删除」全流程 | **通过** | 全流程一条用例跑完，**20.25 秒**（其中沙箱创建 **4359 毫秒**，镜像 `sandbox-platform/base:0.2.0` 176 MB 宿主导出注入）。终端执行 `echo ACC_LIFECYCLE_MARKER_42`，屏幕回显断言命中；停止后容器 `exited`、子 ID 段不变；再启动后容器 `running`；删除走回收清单弹窗（先点「取消」确认一个删除请求都没发出，再点「确认删除」），删完列表里该行消失 | `tests/specs/01-lifecycle.spec.ts`；截图与 trace 在 `tests/artifacts/test-results/` |
| 2 | 不存在于任何仓库的本地构建镜像，可经网页选用并成功创建沙箱（注入路径走通） | **通过** | 现场 `docker build` 造镜像 `sandbox-console-acceptance/local-only-cbd1dacd:0.1.0`，**26.9 MB**，构建 **375 毫秒**；名字带一次性随机后缀，任何仓库里都不可能存在。佐证：`docker manifest inspect` 退出码 1（`errors:`）；直连 `registry-1.docker.io` 探测该命名空间返回 **HTTP 401**。网页下拉里能选中它（`GET /api/images` 也列出了它），创建成功；沙箱守护进程里 `docker image inspect` 能拿到它（镜像 ID `99315eee72b7`）；服务日志里有「按强制从宿主注入模式准备镜像」。反向用例：宿主没有的镜像按契约报 400「宿主上没有镜像…」，不降级直连 | `tests/specs/02-local-image.spec.ts` |
| 3 | 同一沙箱多个终端并行可用；断线重连后终端现场不丢（服务重启例外） | **通过** | ① 并行：同沙箱开两个终端，宿主侧 exec 进程号 **159309 / 159371** 互不相同；终端 1 只见 `PARALLEL_ONE_9x7`、终端 2 只见 `PARALLEL_TWO_3k5`，双向断言「对方的内容不出现」。② 断线重连：关掉整个浏览器上下文等 4 秒后重开，附着同一会话，**已输出内容回放出来了**（`RECONNECT_MARKER_77`），且容器内后台写文件进程**没被杀**（写入计数继续增长）。③ 服务重启：重启控制台服务后页面明确提示「终端会话已失效（后端服务已重启），请新建终端」，状态标签变「会话失效」，服务端会话表已清空；沙箱容器不受影响（仍 `running`） | `tests/specs/03-terminal.spec.ts` |
| 4 | 网页触发的沙箱操作与一期命令行对同一沙箱产生等价状态 | **通过** | ① 同一沙箱：网页与命令行的列表字段（名字/状态/状态标签/镜像/创建时间）、挂载清单（宿主路径/容器路径/只读/角色）逐字段相等；网页停 → 命令行读到 `stopped` 且容器 `exited`；命令行启 → 网页读到「运行中」且容器 `running`。② 回收清单：网页接口与命令行打印的清单**一字不差**（`toEqual` 逐项相等）。③ 参数相同的两个沙箱（网页建 / 命令行建）：状态标签、镜像、挂载清单、容器名/网络名/子 ID 段长度全部一致，两边镜像 ID 相同（`c89ed16c11a7`） | `tests/specs/04-equivalence.spec.ts` |
| 5 | 删除沙箱的资源回收语义与一期一致，用户挂载目录不受影响 | **通过** | 网页列表页的回收清单弹窗列 **7 项**：沙箱容器 / 依赖容器 / 网桥网络 / systemd 用户单元 / 系统用户与家目录 / 子 UID/GID 段 / 平台元数据；弹窗写着「用户挂载的宿主机目录不受影响」。确认删除后：删除接口 `failed` 为空、`removed` 含沙箱容器与依赖容器；系统用户已回收、家目录已回收、`/etc/subuid` 与 `/etc/subgid` 条目已回收、平台元数据已回收、该 uid 名下无守护进程残留、宿主 root 守护进程里无同名容器。用户声明挂载的外部目录删除前后**内容指纹一致**（目录清单 + 每个文件 sha256）。重复删除幂等（`existed=false`，不报错） | `tests/specs/05-reclaim.spec.ts`；一期口径另见 `platform/scripts/smoke-lifecycle.sh` |
| 6 | 沙箱内依赖镜像拉取仍统一经镜像代理，一期行为无回归 | **通过** | 沙箱守护进程单元仍注入 `HTTPS_PROXY=http://127.0.0.1:3128`、`HTTP_PROXY=…`、`NO_PROXY=…`、`SSL_CERT_FILE=…`。沙箱容器内 `docker pull busybox:1.37` 成功；代理容器访问日志新增对应记录，样例：`{"uri":"/v2/library/busybox/blobs/sha256:68fe9b…","host":"registry-1.docker.io","upstream_cache_status":"HIT","status":"200","bytes_sent":"2211514"}`——主机是上游仓库、缓存命中，未走外网 | `tests/specs/06-boundary.spec.ts`；代理日志取自 `docker logs sandbox-platform-registry-proxy` |
| 7 | 服务只监听回环或内网地址，不做认证，不暴露公网 | **通过** | `ss -ltnp` 显示验收服务只监听 **127.0.0.1:8100**（无 0.0.0.0 绑定）；不带任何凭据直接 `GET /api/sandboxes` 返回 200（不做认证）；`/docs` 与 `/openapi.json` 均返回 **404**（默认不公开接口清单）；前端产物由同一进程托管在 `/`，单端口对外 | `tests/specs/06-boundary.spec.ts` |
| 8 | 一期命令行行为零变化（`sandboxctl` 源码未改，一期 pytest 与冒烟判定全通过） | **通过** | `platform/cli/sandboxctl.py` 最后一次改动是**一期**提交（`26d7307 fix(platform): 安全加固…`），本次二期验收**未改一行**；本次工作区改动只落在 `platform/console/`（前端验收脚本）与 `platform/.gitignore`。`uv run pytest`：**288 passed / 0 failed**（330.24 秒），与验收前基线 288 项一致（验收前基线：288 passed / 320.06 秒）。`platform/scripts/smoke-lifecycle.sh`：**共 30 项判定，不通过 0 项**，退出码 0 | `platform/tests/`（288 项）、`platform/scripts/smoke-lifecycle.sh` |

**合计：8 条通过 / 0 条不通过。**

---

## 二、验收脚本与运行方式

```bash
cd platform/console
pnpm install                  # 首次：装 @playwright/test@1.64.1
pnpm run test:acceptance      # 一条命令跑完全部用例，退出码 0 = 通过
```

| 项 | 实测 |
|---|---|
| 命令 | `npx playwright test --config=tests/playwright.config.ts`（等价于 `pnpm run test:acceptance`） |
| 退出码 | **0** |
| 用例数 | 14 条（全部通过，0 跳过，0 失败，0 flaky） |
| 总耗时 | **246.03 秒**（4.1 分钟） |
| 并发 | 串行（`workers: 1`、`fullyParallel: false`）：用例之间共享服务进程与沙箱资源 |
| 监听端口 | `127.0.0.1:8100`（宿主 8000 端口被无关进程占用，用 `CONSOLE_TEST_PORT` 换端口） |
| 浏览器 | Playwright chromium 1.64.1（宿主 `~/.cache/ms-playwright/chromium-1248`） |
| 失败留存 | 每条用例都留 trace 与截图（`trace: 'on'`、`screenshot: 'on'`），产物在 `tests/artifacts/test-results/`；另有 `results.json` 与 HTML 报告 |

**用例清单与耗时**

| 用例 | 耗时 | 覆盖 |
|---|---|---|
| 下拉选镜像 → 创建（带挂载）→ 终端执行命令 → 停止 → 再启动 → 删除 | 20.25s | PRD #1 |
| 新建页能刷新宿主本地镜像列表 | 1.08s | PRD #1 |
| 沙箱详情页刷新后字段保持一致 | 6.92s | PRD #1 |
| 镜像出现在下拉里，选中后创建成功，且沙箱守护进程里确实拿到了它 | 6.74s | PRD #2 |
| 宿主上没有的镜像不能被网页选用（报错说人话） | 3.99s | PRD #2 |
| 同一沙箱两个终端并行可用，两端互不串扰 | 0.94s | PRD #3 |
| 断开浏览器后重连，终端现场不丢（输出与仍在运行的进程都还在） | 5.37s | PRD #3 |
| 重启服务后旧会话失效，页面给出明确提示 | 1.07s | PRD #3 |
| 同一沙箱：网页与命令行看到的列表字段、挂载清单、容器状态、回收清单都一致 | 18.28s | PRD #4 |
| 参数相同的两个沙箱（网页建 / 命令行建）挂载与状态流转等价 | 23.18s | PRD #4 |
| 回收清单里的平台资源全部回收，用户挂载目录原样保留 | 10.32s | PRD #5 |
| 重复删除同一沙箱是幂等的（返回不存在，不报错） | 0.07s | PRD #5 |
| 沙箱内依赖镜像拉取统一经镜像代理 | 10.14s | PRD #6 |
| 服务只监听回环地址、不做认证、不暴露接口文档 | 0.43s | PRD #7 |

**验收脚本自己做的事**（`tests/global-setup.ts` / `tests/global-teardown.ts`）：构建前端产物 → 现场构建本地专属测试镜像 → 清掉上一轮残留的验收沙箱（名字前缀 `acc-`，不碰别人的沙箱）→ 用平台虚拟环境里的 Python 直接拉起控制台服务（进程号即服务本体，重启不留孤儿进程）→ 等 `/api/health` 通过；收尾时停服务、清残留沙箱、删测试镜像、清运行期目录。

**收尾清理实测**：验收跑完后 `sandboxctl list --json` 为 `[]`；测试镜像已删；`getent passwd` 里没有 `sandbox-` 开头的用户；终端会话表里没有归属验收沙箱的记录；`tests/.runtime/` 已清空；外部挂载用的临时目录已删。

**顺带做的环境卫生**：`/tmp/sandbox-platform-home-*` 积了 296 个 pytest 自己的临时平台目录（一期测试夹具每次建一个，`shutil.rmtree(ignore_errors=True)` 删不掉里面 root 属主的代理缓存目录，最老的来自 2026-10-29）。验收收尾时一并清掉（清前 296 → 清后 0）；这些目录只含测试代理的缓存与 CA，每次跑测试都会重建，不涉及任何在跑的服务。

---

## 三、一期回归复验

| 项 | 命令 | 结果 |
|---|---|---|
| 平台单元与接口测试 | `cd platform && uv run pytest` | **288 passed / 0 failed**，330.24 秒 |
| 验收前基线（对照） | 同上，验收开始前跑一次 | 288 passed / 0 failed，320.06 秒 |
| 生命周期冒烟 | `bash platform/scripts/smoke-lifecycle.sh` | **共 30 项判定，不通过 0 项**，退出码 0 |
| 前端类型检查 | `cd platform/console && pnpm run typecheck` | 0 错误 |
| 前端单元测试 | `cd platform/console && pnpm run test` | 7 个文件 / **58 passed** |
| 验收脚本类型检查 | `pnpm run typecheck:tests` | 0 错误 |

**冒烟判定明细（30 项全通过）**：系统用户已创建 / 子 UID 段已登记 / 子 GID 段已登记 / 用户级守护进程 active / 套接字就位 / 容器内 `docker ps` 只见本沙箱容器 / 守护进程单元注入 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`、`SSL_CERT_FILE` / 合并 CA 束可读且含多份证书 / 沙箱内 `docker pull busybox:1.37` 经镜像代理成功 / 容器挂载点为套接字 + 用户声明挂载 / 外部挂载目录内容未变 / 删除提示清单含依赖容器 / 沙箱容器已停止 / 关闭后用户保留 / 关闭后守护进程保留 / 关闭后子 ID 段保留 / 沙箱容器已恢复运行 / 重启后子 ID 段不变 / 重启后外部挂载目录内容未变 / 系统用户已回收 / 家目录已回收 / `/etc/subuid` 条目已回收 / `/etc/subgid` 条目已回收 / 守护进程已停止 / 平台元数据已回收 / 用户挂载的宿主机目录仍存在且内容未变 / 重复删除幂等。

**冒烟实测关键数据**：创建沙箱 `smoke-lifecycle`（系统用户 `sandbox-smoke-lifecycle`，uid 1002，子 UID/GID 段 `231072:65536`，挂载 `/tmp/sandbox-platform-smoke-XXXX → /data` 只读）；创建走固定 7 步；删除前清单 6 项含依赖容器 `smoke-lifecycle-dep`；删除后回收清单 6 项全中；重复删除返回「沙箱不存在，无需删除」。

**镜像代理取证方法（可复核）**：

```bash
# ① 沙箱守护进程单元里的代理环境变量
sudo -u <沙箱用户> env XDG_RUNTIME_DIR=/run/user/<uid> \
  DOCKER_HOST=unix:///run/user/<uid>/docker.sock \
  systemctl --user show docker.service --property=Environment --value
# → HTTPS_PROXY=http://127.0.0.1:3128  HTTP_PROXY=...  NO_PROXY=...  SSL_CERT_FILE=...

# ② 代理容器的访问日志（结构化 JSON 行）
docker logs sandbox-platform-registry-proxy 2>&1 | grep '"uri":"/v2/library/busybox/'
# → {"upstream_cache_status":"HIT","uri":"/v2/library/busybox/blobs/sha256:...","status":"200",
#    "host":"registry-1.docker.io","proxy_host":"registry-1.docker.io","bytes_sent":"2211514"}
```

---

## 四、验收中发现的问题

**本轮验收未发现平台缺陷**，8 条验收标准首次运行即全部通过，无「先红后绿」的修复过程。过程中出现并已定位的 3 处问题全部在**验收脚本自身**（测试代码），不涉及平台行为：

| # | 现象 | 定位 | 处理 |
|---|---|---|---|
| 1 | 终端断言一直等不到回显 | 断言目标选错：「已连接」是面板**状态标签**上的文案，不在终端屏幕里；xterm 的屏幕文本要用 `textContent()` 读（`innerText()` 对隐藏标签返回空串） | 断言拆开：连接状态看 `page-sandbox-detail-terminal-status`，回显看 `.xterm-rows` 的 `textContent()` |
| 2 | 开第二个终端时拿不到新会话标识 | 轮询条件写成了「数组里含某个匹配正则的元素」，已存在的会话本身就匹配，条件提前满足 | 改为轮询「标签数量 +1」，再按差集取新会话标识 |
| 3 | 命令行启动沙箱后网页仍显示「已停止」 | 页面 URL 未变，`page.goto` 到同一个哈希地址只做同文档导航，React 组件没重挂载，状态是旧的 | 改为「先回列表页再进详情页」，强制重新拉取详情 |

另有一处**发现后按现状判定为通过**、未做改动的事项，见下一节「遗留边界」第 1 条。

---

## 五、遗留边界（不影响本轮结论）

1. **沙箱容器 / 网桥网络的回收证据依赖平台自身的删除结果**。沙箱容器活在免 root 守护进程的私有命名空间里（宿主 root 守护进程里查不到、也不该有），用户家目录被回收后该命名空间整体消失，无法在删除后从宿主侧再查一次容器清单。因此本轮对容器与网络的直接证据是：删除接口返回的 `removed` 明确列出「容器 <沙箱容器>」「容器 <依赖容器>」「网络 <网桥>」，且 `failed` 为空；宿主侧另可独立确认「该 uid 名下无守护进程残留」「宿主 root 守护进程里无同名容器」「家目录与子 ID 段已回收」「平台元数据已回收」。一期冒烟脚本用的是同一套判据，口径一致。
2. **命令行与网页的镜像来源字段按设计不同**：网页新建固定带 `image_source=host`，命令行不传该字段、保持一期默认 `auto`。两者在本轮用的都是平台自建镜像（`sandbox-platform/` 前缀），最终都落到「宿主导出注入」，两个沙箱里的镜像 ID 相同（`c89ed16c11a7`）。这是 PRD「一期命令行保持原样」与二期「网页固定宿主注入」两条要求并存的结果，不是行为分叉。
3. **「同沙箱避免网页与命令行同时操作」的使用纪律未做技术强制**：PRD 已明确本期不改造命令行。本轮等价性复验按「网页操作 → 命令行观察 → 命令行操作 → 网页观察」的顺序串行执行，未做并发写同一沙箱的压测。
4. **服务重启会杀掉沙箱容器内残留的会话进程**：这是 PRD 已确认可接受的口径（服务重启则会话全丢）。实测重启后旧会话立即失效、页面提示明确，且沙箱容器本身不受影响。
5. **验收环境复用了宿主的生产镜像代理**（`sandbox-platform-registry-proxy`，端口 3128）与平台数据根（`/var/lib/sandbox-platform`）。验收用的沙箱名统一带 `acc-` 前缀，收尾按前缀清理；未触碰宿主上的其它容器与其它沙箱数据。

---

## 六、复现方式

```bash
# ① 二期端到端验收（真实浏览器 + 真实沙箱）
cd platform/console && pnpm install && pnpm run test:acceptance

# ② 一期回归
cd platform && uv run pytest
bash platform/scripts/smoke-lifecycle.sh

# ③ 前端自身检查
cd platform/console && pnpm run typecheck && pnpm run test && pnpm run typecheck:tests
```

环境前提：Node ≥ 22 + pnpm、Playwright chromium 1.64.1、免密 sudo、宿主 Docker、镜像代理在跑。
