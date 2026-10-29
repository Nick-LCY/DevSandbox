# 全栈示例项目 · 实测记录

> **闭环验收演练由后续执行。**
> 本文件只记录一期任务 06 第一步的实测数据：平台搭起来了、端到端自己跑得通。
> 「agent 在全新沙箱里独立完成读需求 → 改码 → 起依赖 → 跑端到端 → 看截图 → 修复 → 全绿」
> 这一段闭环由下一个执行者按 `BRIEF-NEXT.md` 完成，届时本文件补记闭环数据。

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
