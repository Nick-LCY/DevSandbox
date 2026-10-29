# 全栈示例项目 · 实测记录

> **闭环验收演练已完成（2026-10-29）。**
> agent 只拿 `BRIEF-NEXT.md`（R1 列表过滤 / R2 提交加载态），在全新沙箱 `acceptance-lab` 里
> 独立跑完「读需求 → 读现有代码 → 改码 → 起依赖与应用 → 跑端到端 → 看截图 → 修复 → 全绿」，
> **2 轮**改码→跑测循环内从红到绿（基线 2 failed / 4 passed → 最终 6 passed，退出码 0）。
> 全过程命令与决策见 [LOOP-LOG.md](./LOOP-LOG.md)；平台侧的一期总验收结论见仓库根目录 `RESULTS.md`。
>
> 本文件第一~七节记录一期任务 06 第一步（平台搭起来 + 端到端跑得通）的实测数据，
> 第八节记录第二步（闭环验收演练）的实测数据。

- 执行日期：2026-10-29
- 宿主：Ubuntu 26.04 LTS / Docker 29.6.2（宿主 root 守护进程）
- 沙箱镜像：`sandbox-platform/sandbox-default:0.1.0`（node 22.23.1 / pnpm 10.32.1 / uv 0.11.29 / playwright 1.64.1 / chromium 156.0.8078.4 构建号 1248）
- 沙箱名：`sample-lab`；网桥网络 `sample-lab-net`；系统用户 `sandbox-sample-lab`（uid 1001）
- 挂载：`platform/examples/fullstack-sample → /workspace/fullstack-sample`；`platform/e2e → /workspace/e2e`

---

## 一、沙箱创建耗时

```
$ time uv run python cli/sandboxctl.py create sample-lab \
    --image sandbox-platform/sandbox-default:0.1.0 \
    --mount .../examples/fullstack-sample:/workspace/fullstack-sample \
    --mount .../e2e:/workspace/e2e
```

| 口径 | 数值 |
|---|---|
| **沙箱创建总耗时** | **25.7 秒** |

固定 7 步（建用户 → 登记子 ID 段 → 写并起用户级守护进程 → 解析用户声明挂载 → 起沙箱容器 → 写元数据 → 输出连接方式），
每步都有回滚；用户声明的两个挂载目录原样存在。

---

## 二、各依赖容器就绪耗时

`scripts/up.sh` 实测（12 步，每步带健康门禁）：

| 步骤 | 冷启动（首次，无缓存） | 热启动（缓存命中） |
|---|---|---|
| 基础环境检查 | < 1 秒 | < 1 秒 |
| 网络与 `app` 别名注册 | < 1 秒 | < 1 秒 |
| 复制源码到容器内 `/opt/sample` | < 1 秒 | < 1 秒 |
| **后端 `uv sync` + 前端 `pnpm install` + `vite build`** | **9 秒** | **4 秒** |
| 生成自签证书 | < 1 秒 | < 1 秒 |
| **postgres 容器就绪**（`pg_isready` 通过 + 建业务库 + 执行迁移） | **2 秒** | **2 秒** |
| **minio 容器就绪**（`/minio/health/live` 返回 200） | **1 秒** | **1 秒** |
| **logto 容器就绪**（建库 + `logto db seed` + `db alteration deploy` + 容器起 + OIDC 发现文档 200） | **7 秒** | **6 秒** |
| **Logto 供应**（预置授权码应用 + 测试用户） | **1 秒** | **1 秒** |
| 创建 MinIO 桶 | < 1 秒 | < 1 秒 |
| **应用进程就绪**（uvicorn + 双协议前置代理起来） | **3 秒** | **3 秒** |
| 应用健康门禁（明文 + TLS 两条路都通、首页含 `data-testid="page-home-title"`） | < 1 秒 | < 1 秒 |
| **`up.sh` 总耗时** | **23 秒** | **18 秒** |

三个依赖容器都跑在沙箱网内（同一网桥，按容器名互访）：

| 容器名 | 镜像 | 寻址 |
|---|---|---|
| `postgres` | `postgres:16.15-alpine3.24`（平台离线包） | `postgres:5432` |
| `minio` | `minio/minio:RELEASE.2025-04-22T22-12-26Z`（平台离线包） | `minio:9000` |
| `logto` | `ghcr.io/logto-io/logto:1.29.0`（平台离线包） | `logto:3001`（默认租户）、`logto:3002`（管理租户） |

宿主没有新增任何监听端口。

---

## 三、Logto 供应方式与耗时

### 实际采用的方式

**管理 API + 种子自带的机器对机器应用**（`scripts/provision-logto.mjs`）：

| 步 | 动作 | 说明 |
|---|---|---|
| 1 | `logto db seed` + `logto db alteration deploy` | 建表并写入种子数据。种子会为「默认租户的管理接口」预置一个机器对机器应用 `m-default`，它的客户端密钥写在数据库 `applications` 表里 |
| 2 | 从数据库读出 `m-default` 的客户端密钥 | 一条 `psql` 查询 |
| 3 | `client_credentials` 换管理令牌 | 到**管理租户**（`logto:3002`）的 `/oidc/token`，`resource=https://default.logto.app/api`、`scope=all`。这是真实的 OAuth2 客户端凭证流程 |
| 4 | `POST /api/applications` | 建授权码应用（Traditional 类型，登记 `https://app:8000/auth/callback`，客户端密钥 `client_secret_basic`） |
| 5 | `POST /api/users` | 建测试用户 `sampleuser` / `SamplePass123!`（邮箱 `sample@example.com`，昵称「示例用户」） |

### 为什么不用其它方式

- **管理后台网页手工点**：Logto 首次初始化没有预置管理员账号，必须先在管理后台网页里注册管理员，
  再手工建应用与用户 —— 无人值守做不到。
- **Logto CLI（`@logto/cli`）**：镜像里自带 CLI，但它只能做数据库层面的 `db seed` / `db alteration`，
  建应用与建用户仍要走管理 API；而且走 npm 还要额外联网装包。
- **直接写数据库种子**：应用与用户的表结构（`applications.oidc_client_metadata`、`users.password_encrypted` 等）
  由 Logto 自己定义并带校验约束，绕开管理 API 直写数据库容易与版本脱节。
- **开发态免校验后门**（`DEVELOPMENT_USER_ID` 之类的开关）：能跳过认证，但那是调试开关不是真实路径，不作为验收依据。

### 耗时

| 口径 | 数值 |
|---|---|
| **供应（建应用 + 建用户 + 落配置）** | **1 秒** |
| 其中：从数据库读种子密钥 → client_credentials 换管理令牌 | < 1 秒 |

---

## 四、端到端整套耗时

命令：`pnpm run test:scripted`（`playwright test --project=scripted`）

| 口径 | 数值 |
|---|---|
| **整套耗时（连续 3 次）** | **3073 / 2958 / 3003 毫秒** |
| 用例数 | 4 条（2 个 worker 并行） |
| **退出码** | **0** |

门禁日志（一次完整运行）：

```
[门禁] 第 ① 步：等待依赖健康
[门禁] 依赖「postgres」已就绪（第 1 次探测通过）
[门禁] 依赖「minio」已就绪（第 1 次探测通过）
[门禁] 依赖「logto」已就绪（第 1 次探测通过）
[门禁] 依赖「app」已就绪（第 1 次探测通过）
[门禁] 第 ② 步：执行数据库迁移 → 001_init.sql、002_indexes.sql、003_sample_records.sql
[门禁] 第 ③ 步：载入种子数据 → v1.sql、v2.sql（模板库种子版本：v1, v2）
[门禁] 门禁通过，开始执行用例

  4 passed (2.6s)
```

### 每用例独立数据库（模板库克隆耗时）

```
$ bash tools/new-test-db.sh bench 10
  单库最短 130 毫秒 / 单库最长 147 毫秒 / 单库平均 140 毫秒 / 合计 1407 毫秒
判定：通过 —— 单库耗时均不超过 5000 毫秒
```

---

## 五、产物（截图与 trace）

全部落在用户声明挂载的代码目录 `platform/e2e/artifacts/` 内（不进版本库）。

### 截图：4 张

| 文件 | 尺寸 | 字节 | 内容 |
|---|---|---|---|
| `screenshots/fullstack-record-created-scripted-w1-79ced442.png` | 1280 × 986 | 74 265 | 登录后的看板：新建记录表单 + 三条记录（含种子 2 条）+ 附件下载链接 |
| `screenshots/sample-page-scripted-w1-7b000c0e.png` | 1280 × 720 | 22 542 | 应用首页（最小样例用例） |
| `explore/01-home.png` | 1280 × 720 | 22 542 | 探索会话：应用首页 |
| `explore/02-logto-sign-in.png` | 1280 × 720 | 19 996 | 探索会话：浏览器停在 **Logto 真实登录页** |

### trace：5 份

| 文件 | 字节 |
|---|---|
| `traces/scripted-Logto_-79ced442e91c67729a81-6a27ad5c83467ec4f33a.zip` | 491 943 |
| `traces/scripted-_-79ced442e91c67729a81-591dfdbe16a8d501eefa.zip` | 330 914 |
| `traces/scripted-_data-testid_-7b000c0ed96bf09c43fc-614ea8fdeaa1f828e90a.zip` | 59 455 |
| `traces/scripted-_-d6341a7d16365ba6a6f7-76d33d11080e1e8b1aff.zip` | 4 490 |
| `traces/explore-_Logto_trace-f4485a405684a49dfd9e-29bdb5aa7515517b2a7e.zip` | 126 662 |

另有 `artifacts/results.json`、`artifacts/html-report/`、`artifacts/db-usage.log`。

---

## 六、端到端覆盖到哪一步

| 能力 | 覆盖方式 | 判据 |
|---|---|---|
| Logto 授权码登录 | Playwright 驱动真实浏览器，在 Logto 登录页真实输入用户名口令 | 回调带回 code 与 state，后端换 token 并校验 id_token，页面出现用户名 |
| 写 Postgres | `POST /api/records` | 用例直接查自己的用例库，确认那一行在（隔离佐证） |
| 传 MinIO | 附件随表单提交，走 S3 `PutObject` | 下载回来的字节与上传的逐字节一致 |
| 列表展示 | `GET /api/records` | 列表条目数与标题断言 + 截图 |
| 未登录保护 | 不带会话直接调接口 | 期望 401 |

---

## 七、踩坑清单

1. **Chromium 会把容器名上的 `http://` 导航升级成 `https://`**：
   实测 `http://app:9000` 被升级后报 `net::ERR_SSL_PROTOCOL_ERROR`；
   而 IP 字面量与 `localhost` 不会升级。
   `--disable-features=HttpsUpgrades`、`EnterpriseDataProtection`、`AlwaysUseHttps` 全部无效。
   解法：应用与 Logto 前置**按首字节分流的双协议代理**（`scripts/dual-protocol-proxy.mjs`），同一端口明文与 TLS 都通。
2. **`docker cp` 不会创建缺失的父目录**：往 `/opt/proxy/` 拷文件报
   `Could not find the file /opt/proxy in container logto`。解法：落到镜像里一定存在的 `/tmp` 下。
3. **Logto 的管理应用在管理租户（3002），不在默认租户（3001）**：
   用 `m-default` 的密钥去 `3001` 换令牌会报 `invalid_client`。
4. **`logto db seed` 必须先跑**：Logto 容器直接启动会报
   `Found undeployed database alterations, you must deploy them first`，容器随即退出。
5. **应用不能在端到端门禁克隆模板库期间连着模板库**：
   应用一旦持有 `e2e_template` 的连接，`CREATE DATABASE ... TEMPLATE e2e_template` 会报
   `source database "e2e_template" is being accessed by other users`。
   解法：应用默认连自己的 `sample_app` 库；端到端用例按 worker 独占的库由**会话**选定。
6. **浏览器的文件下载导航不携带 `page.setExtraHTTPHeaders` 设的头**：
   早期版本按请求头选库，下载请求因此查不到记录（404，下载被取消）。
   解法：登录换 token 时把「本次用哪个库」记进会话，之后所有请求（含下载导航）都按会话走。
7. **`node_modules` 的属主**：宿主用户装过的 `node_modules`，沙箱容器（root 映射到沙箱专属用户）改不动它的权限，
   `pnpm install` 报 `EPERM ... chmod`。解法：沙箱内先删掉再装（`node_modules` 在 `.gitignore` 里）。

---

## 八、闭环验收演练（任务 06 第二步，2026-10-29）

> 角色：执行者只拿 `BRIEF-NEXT.md`，在**全新沙箱**里独立干活，全程无人工点击、无人工代敲命令。
> 完整时间线见 [LOOP-LOG.md](./LOOP-LOG.md)。

### 8.1 本轮需求与判据

| 需求 | 内容 | 判死用例（`platform/e2e/tests/e2e/fullstack-sample.spec.ts`） |
|---|---|---|
| R1 | 记录列表按关键字过滤（只看标题与内容、不区分大小写、只影响展示、刷新后保持、清除即恢复全量） | `列表页按关键字过滤` |
| R2 | 提交过程有可见加载态（`page-home-record-upload-loading`），提交期间按钮置灰，加载态最短 300 毫秒 | `提交过程有加载态` |

### 8.2 沙箱与耗时

| 口径 | 数值 | 说明 |
|---|---|---|
| **沙箱创建总耗时** | **26.4 秒** | `sandboxctl create acceptance-lab --image sandbox-platform/sandbox-default:0.1.0 --mount examples/fullstack-sample:/workspace/fullstack-sample --mount e2e:/workspace/e2e`；固定 7 步全部成功 |
| 沙箱容器 | `sandbox-acceptance-lab`（`6794c9592c9b`） | 镜像 `sandbox-platform/sandbox-default:0.1.0`（与 `:latest` 同一镜像 ID `cc053354831d`） |
| 系统用户 / 子 ID 段 | `sandbox-acceptance-lab`（uid 1001）/ `165536:65536` | 宿主 `getent passwd` 可见，容器内 `id` 为 root（映射到该用户） |
| **`up.sh` 全环境就绪（首次，冷）** | **22.5 秒** | 12 步门禁全过：postgres 2 秒 / minio 1 秒 / logto 7 秒 / 应用进程 3 秒 / 构建 9 秒 |
| **`up.sh` 全环境就绪（改码后重跑）** | **16.8 秒** | 前端 `tsc --noEmit && vite build` 通过，类型错会在构建阶段就暴露 |
| 端到端基建依赖安装 | 0.8 秒 | 挂载目录里依赖已在，`pnpm install` 报 Already up to date（Playwright 1.64.1） |
| **基线红（实现前）** | **15.1 秒，退出码 1** | 2 failed / 4 passed |
| **最终绿（实现后）** | **5.4 秒，退出码 0** | 6 passed |
| 稳定性复跑 ×3 | 5.2 / 5.3 / 5.4 秒，退出码均为 0 | 每次 6 passed |
| 探索模式 | 1.9 秒，退出码 0 | 产出 2 张走查截图 |

### 8.3 改码 → 跑测的循环

| 轮次 | 动作 | 端到端结果 | 退出码 |
|---|---|---|---|
| Round 1 | 注入需求后原样跑（基线） | 2 failed / 4 passed | 1 |
| Round 2 | 沙箱内改码（`frontend/src/App.tsx`、`frontend/src/styles.css`）+ 重跑 `up.sh` + 跑测 | **6 passed** | **0** |
| 复跑 ×3 | 只跑测 | 6 passed ×3 | 0 |

**2 轮**改码→跑测循环内从红到绿，远低于 4 轮上限。中途发现并修掉一处**注入用例自身的竞态**
（登录后列表异步加载，用例用 `count()` 立刻取快照 → 改为 `expect.poll` 等列表到位；
每新建一条记录后等它出现在列表里再往下走）。**判据本身没有放松**：
过滤后条数、清除后恢复全量、只看标题与内容、不区分大小写、关键字为空等于全量、
接口仍返回全量、刷新后关键字不清空，全部逐条断言。

### 8.4 截图与 trace（全部落在用户声明挂载的代码目录内）

| 文件 | 尺寸 | 字节 | 看到什么 |
|---|---|---|---|
| `screenshots/record-filtered-scripted-w1-79ced442.png` | 1280 × 831 | 52 987 | R1：过滤框里是「过滤靶标」，列表只剩 1 条「R1 过滤靶标-…」，标题/内容/属主齐全；提交按钮已恢复可点 |
| `screenshots/record-upload-loading-scripted-w0-79ced442.png` | 1280 × 720 | 约 26 000 | R2：附件已选 `loading-evidence.txt`，附件下方蓝色「上传中…」可见，提交按钮是置灰的「保存中…」 |
| `screenshots/fullstack-record-created-scripted-w1-79ced442.png` | 1280 × 1064 | 80 393 | 既有主链路：新建记录 + 2 条种子记录 + 附件下载链接，新的过滤区在列表上方 |
| `screenshots/sample-page-scripted-w0-7b000c0e.png` | 1280 × 720 | 26 239 | 应用首页（最小样例用例） |
| `explore/01-home.png` | 1280 × 720 | 26 239 | 探索会话：应用首页 |
| `explore/02-logto-sign-in.png` | 1280 × 720 | 19 852 | 探索会话：Logto 真实登录页 |

trace：脚本模式 6 份 + 探索模式 1 份，落在 `artifacts/traces/`（按「模式 + 用例」归档）；
失败用例的截图与 trace 落在 `artifacts/test-results/`。

### 8.5 删除沙箱复验（逐条核对 PRD 回收清单）

`uv run python cli/sandboxctl.py delete acceptance-lab --yes` 的输出：

```
即将删除沙箱 acceptance-lab
平台将回收以下资源：
  - 沙箱容器 sandbox-acceptance-lab
  - 网桥网络 acceptance-lab-net
  - systemd 用户单元 /home/sandbox-acceptance-lab/.config/systemd/user/docker.service
  - 系统用户 sandbox-acceptance-lab 与家目录 /home/sandbox-acceptance-lab
  - 子 UID/GID 段 165536:65536（/etc/subuid、/etc/subgid）
  - 平台元数据 /var/lib/sandbox-platform/sandboxes/acceptance-lab/metadata.json
注意：用户挂载的宿主机目录不受影响
```

| 回收项 | 复验方式 | 结果 |
|---|---|---|
| 沙箱容器 + 依赖容器 | 回收清单列出「容器 logto / minio / postgres / sandbox-acceptance-lab」；宿主 `docker ps -a` 里同名容器是 2026-09 就存在的宿主机自有容器，与本轮无关 | **已回收** |
| 守护进程 | 用户级 systemd 单元文件随家目录删除；`/var/lib/systemd/users/` 无 uid 1001 残留；`/run/user/1001` 已消失；进程表里无该用户的 rootless dockerd | **已回收** |
| 用户与家目录 | `getent passwd sandbox-acceptance-lab` 无输出；`/home/sandbox-acceptance-lab` 不存在 | **已回收** |
| 子 UID/GID 段 | `/etc/subuid`、`/etc/subgid` 中无该用户条目 | **已回收** |
| 平台元数据 | `/var/lib/sandbox-platform/sandboxes/` 下只剩目录、无 `acceptance-lab/metadata.json` | **已回收** |
| 用户声明挂载的宿主机目录 | 两个挂载目录原样存在，删除前后 md5 指纹逐个一致 | **原样存在、内容未变** |
| 本轮实现是否还在挂载目录里 | `frontend/src/App.tsx` 里 `page-home-record-filter-input`、`page-home-record-upload-loading` 两处标识都在 | **含本轮新增实现** |

**平台侧暴露的一个小缺口**（不影响验收）：删除前的「平台将回收以下资源」清单里没有列出
**依赖容器**（postgres / minio / logto）—— 因为删除时元数据里的 `dependency_containers` 是空的
（依赖容器是沙箱内 `up.sh` 事后起的，创建沙箱时还不存在）。
实际执行确实把这三个容器删掉了，但**提示清单与实际回收项不一致**。
建议后续把依赖容器扫描结果也并入删除前的提示清单。
