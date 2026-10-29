# 闭环验收演练 · Agent 循环日志（LOOP-LOG）

> 这是本轮「只拿需求简报、在全新沙箱里独立干活」的可回放证据。
> 每一步的命令、关键输出、决策与耗时按时间顺序记在这里，宿主侧步骤同样入账并标注执行位置。
>
> - 需求来源：`BRIEF-NEXT.md`（R1 记录列表按关键字过滤、R2 提交过程有加载态）
> - 沙箱：`acceptance-lab`（全新创建，2026-10-29）
> - 判据：`pnpm run test:scripted` 退出码 0，且不改动任何端到端判据
> - 硬约束：沙箱外的宿主机不直接改示例项目代码；一切改码都在沙箱容器内经挂载目录落回仓库

## 〇、基线（宿主侧执行，准备「从失败到全绿」的起点）

| 时间(UTC) | 位置 | 动作 | 结果 |
|---|---|---|---|
| 09:33 | 宿主 | 读 `docs/tasks/sandbox-platform/06-sample-app-acceptance.md`、`BRIEF-NEXT.md`、`RESULTS.md`、示例项目 `README.md` 第五节 | 确认 R1/R2 是本轮需求，环境事实以 README 第五节为准 |
| 09:35 | 宿主 | 核对应用侧实现：`grep -rn "filter\|upload-loading" frontend/src/` | 只有 `submitting` 置灰与「保存中…」文案，**没有任何过滤区，也没有任何可判定的加载元素** → R1/R2 基线即为未实现状态 |
| 09:38 | 宿主 | 往 `platform/e2e/tests/e2e/fullstack-sample.spec.ts` 追加两条判死用例（`列表页按关键字过滤`、`提交过程有加载态`） | 用例只按 `data-testid` 定位；条数一律相对断言；用例结束清理自己新建的记录 |
| 09:38 | 宿主 | `pnpm run typecheck` + `bash tools/assert-contracts.sh` | 类型检查通过；契约断言命中数 0（回环地址 0、非 testid 定位 0） |
| 09:38 | 宿主 | `git commit -m "chore(example): 注入下轮需求，回退对应实现"` | 提交 `e3b91dd`；这是唯一的「注需求」提交，既有 4 条用例与判据未被改动 |
| 09:39 | 宿主 | `uv run python cli/sandboxctl.py create acceptance-lab --image sandbox-platform/sandbox-default:0.1.0 --mount examples/fullstack-sample:/workspace/fullstack-sample --mount e2e:/workspace/e2e` | **创建耗时 26.4 秒**；系统用户 `sandbox-acceptance-lab`（uid 1001）、子 ID 段 `165536:65536`、容器 `6794c9592c9b`、套接字 `/run/user/1001/docker.sock` |
| 09:40 | 宿主 | `sudo -u sandbox-acceptance-lab env DOCKER_HOST=unix:///run/user/1001/docker.sock docker exec sandbox-acceptance-lab bash -lc 'id; ls /workspace'` | 沙箱内 root 映射到沙箱专属用户；两个挂载点就位：`/workspace/fullstack-sample`、`/workspace/e2e`；node 22.23.1 / pnpm 10.32.1 / uv 0.11.29 / docker 客户端可用 |

> 宿主侧准备工作到此为止。接下来所有改码、起环境、跑端到端、看截图的动作，
> 全部通过 `docker exec` 在沙箱容器内完成。

## 一、Round 1：基线红（注入需求后、实现之前，沙箱容器内执行）

| 时间(UTC) | 命令 | 结果 |
|---|---|---|
| 09:40 | `sed -n '1,40p' /workspace/fullstack-sample/BRIEF-NEXT.md` + `grep` 读 `frontend/src/App.tsx` | 读需求、读现有代码：前端只有 `submitting` 置灰与「保存中…」文案，没有过滤区，也没有任何可判定的加载元素 |
| 09:41 | `bash /workspace/fullstack-sample/scripts/up.sh` | 全环境就绪，12 步门禁全过，**22.5 秒** |
| 09:41 | `cd /workspace/e2e && bash tools/install-deps.sh` | 0.8 秒（挂载目录里依赖已在，pnpm 报 Already up to date） |
| 09:42 | `cd /workspace/e2e && pnpm run test:scripted` | **红：2 failed / 4 passed，退出码 1，墙钟 15.1 秒** |

失败详情（两条都是新增的判死用例）：

- `列表页按关键字过滤`：卡在 `expect(baseCount).toBeGreaterThanOrEqual(2)`，实测 0。
  判读：**不是实现缺陷，是用例自己的竞态** —— 登录后列表是异步拉取的，用例用 `count()` 立刻取快照，
  等于在列表到位之前就断言。修法是让用例等列表加载出来，不是放松判据。
- `提交过程有加载态`：`expect(loading).toBeVisible()` → `element(s) not found`。
  判读：**这正是预期的红** —— 页面上根本没有加载元素，R2 要的就是它。

决策：

1. R2 的红是需求没实现，由 agent 在沙箱里改码解决。
2. R1 的红是注入用例的缺陷，修用例侧（不动判据）：
   - 登录后用 `expect.poll` 等列表条目数 ≥ 2 再取条数快照；
   - 每新建一条记录后，等这条记录出现在列表里再往下走（避免列表刷新与断言抢跑）；
   - 断言本身一条没放松：过滤后 == 1 条、清除后恢复全量、只看标题与内容、不区分大小写、
     关键字为空等于全量、接口仍返回全量、列表重新加载后关键字不清空。
3. 端到端判据与既有 4 条用例全程不动。

## 二、Round 2：改码 → 重跑 up.sh → 全绿

改码全部在沙箱容器内完成，经挂载目录落回宿主仓库（宿主没有直接改过示例项目代码）：

| 文件 | 改动 |
|---|---|
| `frontend/src/App.tsx` | **R1**：新增 `filterInput`（输入框原始值）与 `appliedFilter`（已应用的关键字）两个状态；列表上方加过滤区三个元素 `page-home-record-filter-input` / `page-home-record-filter-button` / `page-home-record-filter-clear-button`；`visibleRecords` 只看标题与内容、不区分大小写、关键字 trim 后为空即全量；过滤只作用于展示，后端接口不动；列表重新加载（新建记录后刷新）时 `appliedFilter` 保持不变 |
| | **R2**：提交期间渲染 `page-home-record-upload-loading`（可见的「上传中…」），提交按钮保持 `disabled`；用 effect 记录加载元素真正挂到页面上的时刻，`finally` 里补足到**最短 300 毫秒**才撤掉加载态 |
| `frontend/src/styles.css` | 追加 `.filter-bar`（过滤区横向排布）与 `.loading`（加载指示文字）两条样式 |

| 时间(UTC) | 命令 | 结果 |
|---|---|---|
| 09:43 | `cat > /workspace/fullstack-sample/frontend/src/App.tsx`（容器内写） | 改码落盘；宿主 `git status` 立刻看到这两个文件被改（经挂载目录） |
| 09:43 | `bash /workspace/fullstack-sample/scripts/up.sh` | **16.8 秒**；前端 `tsc --noEmit && vite build` 通过（类型错会在构建阶段就挂，不会拖到跑测才发现） |
| 09:43 | `cd /workspace/e2e && pnpm run test:scripted` | **绿：6 passed，退出码 0，墙钟 5.4 秒** |

### 看截图（把 PNG 读出来人眼复核）

| 截图 | 看到什么 | 结论 |
|---|---|---|
| `artifacts/screenshots/record-filtered-scripted-w1-*.png`（1280×831） | 列表上方的过滤区里输入框是「过滤靶标」，右边是「过滤」「清除」两个按钮；下方列表只剩 **1 条**「R1 过滤靶标-…」，标题、内容「R1 命中标题关键字」、属主「示例用户」都在；顶部状态行显示上一条保存成功；提交按钮已恢复成可点的「保存」 | R1 生效：按标题关键字过滤到 1 条，清除后能恢复全量 |
| `artifacts/screenshots/record-upload-loading-scripted-w0-*.png`（1280×720） | 表单已填好标题与内容、附件已选 `loading-evidence.txt`；附件下方是**蓝色「上传中…」**（可见），提交按钮是**置灰的「保存中…」** | R2 生效：提交过程中有可判定的加载元素，提交按钮同步置灰 |
| `artifacts/screenshots/fullstack-record-created-scripted-w1-*.png`（1280×1064） | 既有主链路截图仍正常：新建记录 + 2 条种子记录都在，附件「下载 evidence.txt（33 字节）」链接在，新的过滤区在列表上方 | 没有把既有功能改坏 |

### 稳定性

- 连续 3 次 `pnpm run test:scripted`：**6 passed / 6 passed / 6 passed**，墙钟 **5.2 / 5.3 / 5.4 秒**（用例 4.6~4.9 秒）。
- `pnpm run test:explore`：退出码 0，产出 2 张走查截图（应用首页 + Logto 真实登录页）。

## 三、循环汇总

| 轮次 | 动作 | 端到端结果 | 退出码 | 墙钟 |
|---|---|---|---|---|
| Round 1 | 注入需求后原样跑（基线） | 2 failed / 4 passed | 1 | 15.1 秒 |
| Round 2 | 改码（沙箱内）+ 重跑 up.sh + 跑测 | **6 passed** | **0** | 5.4 秒 |
| 复跑 ×3 | 只跑测，验证不是偶然绿 | 6 passed ×3 | 0 | 5.2 / 5.3 / 5.4 秒 |

改动到全绿共 **2 轮**（改码→跑测循环 1 次），远低于 4 轮上限。

## 四、收尾（宿主侧执行）

| 时间(UTC) | 动作 | 结果 |
|---|---|---|
| 09:46 | `uv run python cli/sandboxctl.py delete acceptance-lab --yes` | 删除前打印平台回收清单并含「用户挂载的宿主机目录不受影响」字样；实际回收：容器 logto / minio / postgres / sandbox-acceptance-lab、网络 acceptance-lab-net、systemd 用户单元、系统用户与家目录、子 UID/GID 段、平台元数据 |
| 09:47 | 逐项复验 | 沙箱容器与 3 个依赖容器已删（宿主 `docker ps -a` 里的同名容器是 2026-09 就存在的宿主机自有容器，与本轮无关）；`getent passwd sandbox-acceptance-lab` 无输出、家目录不存在、`/run/user/1001` 已消失、进程表无该用户的 rootless dockerd；`/etc/subuid`、`/etc/subgid` 无该用户条目；`/var/lib/sandbox-platform/sandboxes/` 下无 `acceptance-lab`；两个用户挂载目录删除前后 md5 指纹逐个一致，且 `frontend/src/App.tsx` 里 `page-home-record-filter-input`、`page-home-record-upload-loading` 两处标识都在 → **挂载目录原样存在、内容未变、含本轮新增实现** |
| 09:48 | 回填实测数据 | `platform/examples/fullstack-sample/RESULTS.md` 第八节；平台侧一期总验收结论写进仓库根目录 `RESULTS.md`；任务 06 的 frontmatter 置 done、完成标准逐条勾选 |

## 五、这一轮暴露的两件事（留给后续）

1. **删除前的回收清单没列依赖容器**：依赖容器是沙箱内 `up.sh` 事后起的，创建沙箱时元数据里还没有它们，
   所以 `delete` 的提示清单与实际回收项对不上（实际都删了）。建议把依赖容器扫描结果并入提示清单。
2. **用例库是按 worker 分配的，不是按用例分配的**：同一 worker 上的用例共用一个库，
   于是用例必须用相对条数断言、并清理自己写的行。本轮注入的 R1 用例第一版就踩了这个坑
   （登录后列表异步加载，用 `count()` 立刻取快照 → 读到 0）。PRD 写的是「每个用例一个独立数据库」，
   与实现有偏差，建议后续把 fixture 改成用例级。
