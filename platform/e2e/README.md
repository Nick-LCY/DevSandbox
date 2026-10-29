# 端到端测试基建

以 Playwright 为核心的端到端测试基建：**脚本模式为主、探索模式为辅**；运行前有健康检查门禁
（等依赖就绪 → 迁移 → 种子）；每个用例独占一个数据库；元素定位只认 `data-testid`；
截图与 trace 留在用户声明挂载的代码目录里。

```
platform/e2e/
├── playwright.config.ts        # 两个 project：scripted（判定）/ explore（不判定）
├── global-setup.ts             # 健康检查门禁：依赖就绪 → 迁移 → 种子
├── global-teardown.ts          # 兜底清理残留用例库
├── config/dependencies.json    # 依赖清单（数据驱动）
├── fixtures/test-db.ts         # 每 worker 一个独立数据库的 fixture
├── helpers/                    # 配置、postgres、健康判据、产物路径、trace 归档 reporter
├── migrations/                 # 数据库迁移（进模板库）
├── seeds/                      # 种子数据（带版本号，进模板库）
├── tests/e2e/                  # 脚本化用例
├── explore/                    # 探索会话用例
├── fixtures/app/               # 最小静态页与它的双协议服务
├── tools/                      # 命令行工具（建库、起服务、契约断言、跑批）
├── TESTID.md                   # data-testid 命名规范
└── artifacts/                  # 运行产物：截图、trace、报告（不进版本库）
```

---

## 一、环境前提

| 前提 | 说明 |
|---|---|
| Node 22 + pnpm | 沙箱默认镜像自带（nvm 管理），宿主也可用 |
| 浏览器 | Playwright chromium 1.64.1（构建号 1248），沙箱默认镜像已预装，**不要**再跑 `playwright install` |
| 依赖容器 | postgres 与被测应用容器与沙箱容器**同一网桥网络**，按容器名互访 |
| 数据库客户端 | 沙箱镜像内**没有** psql，shell 里操作数据库一律 `docker exec <pg容器名> psql` |

---

## 二、安装

```bash
cd platform/e2e
pnpm install
pnpm exec playwright --version      # 期望：Version 1.64.1
```

网络慢时走国内镜像源：

```bash
E2E_NPM_REGISTRY=https://registry.npmmirror.com bash tools/install-deps.sh
# 等价写法：export npm_config_registry=https://registry.npmmirror.com
```

`tools/install-deps.sh` 还会把 pnpm 的包缓存放到容器家目录（默认 `~/.local/share/pnpm/store`），
避免缓存把代码目录弄脏；直连 `pnpm install` 时缓存会落在工作目录的 `.pnpm-store/`（已在 `.gitignore` 与契约断言的排除范围里）。

---

## 三、两种模式

| 模式 | 命令 | 跑什么 | 退出码 | 是否参与判定 |
|---|---|---|---|---|
| 脚本模式 | `pnpm run test:scripted` | `tests/e2e` 下的全部用例 | 0 = 通过，非 0 = 不通过 | **是** |
| 探索模式 | `pnpm run test:explore` | `explore` 下的探索会话 | **恒为 0** | 否 |
| 依次跑 | `pnpm run test:all` | 先脚本后探索 | 返回脚本模式的退出码 | 脚本模式为准 |

- 脚本模式是判定依据：失败即失败，退出码可直接进 CI。
- 探索模式给 agent 现场走查用：trace 全开、每步截图，走查中断只记录不报错，退出码恒 0。

---

## 四、健康检查门禁

门禁在 `global-setup.ts` 里，顺序固定、不可调换：

1. **等待依赖健康** —— 依赖清单数据驱动，每个依赖有明确判据，单依赖等待上限 **120 秒**；
2. **执行数据库迁移** —— 迁移进模板库；
3. **载入种子数据** —— 种子进模板库，带版本号。

三步全过才允许跑用例。任一步失败立即整体失败，退出码非 0，并打印**失败依赖名 + 判据 + 超时上限 + 最后原因**：

```
Error: 依赖「app」等待超时；判据：HTTP 状态码 200 且响应体包含 data-testid="page-home-title"；上限 120 秒；最后原因：fetch failed
```

### 依赖清单

`config/dependencies.json`：

```json
{
  "dependencies": [
    {
      "name": "postgres",
      "type": "postgres",
      "url": "postgres://postgres:postgres@postgres:5432/postgres",
      "urlEnv": "E2E_PG_URL",
      "criterion": "SELECT 1 返回且仅返回一行 1（node pg 连容器名 postgres:5432）",
      "timeoutSeconds": 120
    },
    {
      "name": "minio",
      "type": "http",
      "url": "http://minio:9000/minio/health/live",
      "urlEnv": "E2E_MINIO_URL",
      "criterion": "HTTP 状态码 200（MinIO 存活探针 /minio/health/live）",
      "timeoutSeconds": 120
    },
    {
      "name": "logto",
      "type": "http",
      "url": "http://logto:3001/oidc/.well-known/openid-configuration",
      "urlEnv": "E2E_LOGTO_URL",
      "criterion": "HTTP 状态码 200 且响应体包含 issuer（Logto 默认租户的 OIDC 发现文档）",
      "timeoutSeconds": 120,
      "bodyIncludes": "\"issuer\""
    },
    {
      "name": "app",
      "type": "http",
      "url": "http://app:8000/",
      "urlEnv": "E2E_APP_URL",
      "criterion": "HTTP 状态码 200 且响应体包含 data-testid=\"page-home-title\"",
      "timeoutSeconds": 120,
      "bodyIncludes": "data-testid=\"page-home-title\""
    }
  ]
}
```

- 换清单：`E2E_DEPENDENCIES_FILE=/path/to/dependencies.json`；
- 换单个依赖的指向：`E2E_PG_URL=...`、`E2E_MINIO_URL=...`、`E2E_LOGTO_URL=...`、`E2E_APP_URL=...`；
- 清单里写的超时上限超过 120 秒会直接报错，防止有人把等待上限放大。

**所有连接串一律走容器名**（沙箱内部网络中由 docker 内置 DNS 解析），不使用本机回环地址。

---

## 五、每用例独立数据库

| 动作 | 命令 |
|---|---|
| 克隆一个用例库 | `bash tools/new-test-db.sh create <库名>` |
| 销毁一个用例库 | `bash tools/new-test-db.sh drop <库名>` |
| 连续克隆计时 | `bash tools/new-test-db.sh bench 10` |
| 列出用例库 | `bash tools/new-test-db.sh list` |

- 机制：`CREATE DATABASE <库名> TEMPLATE e2e_template`（模板库由门禁的迁移与种子装好）；
- 容器名可配：`E2E_PG_CONTAINER`（默认 `postgres`）、`E2E_TEMPLATE_DB`（默认 `e2e_template`）；
- psql 一律经 `docker exec` 到 postgres 容器内执行；
- 并行隔离：`fixtures/test-db.ts` 给每个 worker 分配一个库（库名带 worker 序号），
  用例结束即销毁，库名与创建/销毁事件都记在 `artifacts/db-usage.log`。

---

## 六、产物

| 路径 | 内容 |
|---|---|
| `artifacts/screenshots/` | 用例显式截图 |
| `artifacts/test-results/` | Playwright 每条用例的输出目录：`trace.zip`、失败截图 `test-failed-1.png` |
| `artifacts/traces/` | 按「模式 + 用例」归档的 trace 副本（两种模式的 trace 可同时保留） |
| `artifacts/explore/` | 探索会话的分步截图 |
| `artifacts/html-report/` | HTML 报告 |
| `artifacts/results.json` | 机器可读结果 |
| `artifacts/db-usage.log` | 用例库使用记录（并行隔离佐证） |

产物全部落在**用户声明挂载的代码目录**内（不写容器临时层、不上传外部服务）。
`artifacts/` 与 `node_modules/` 不进版本库。

---

## 七、在沙箱里跑通（完整步骤）

**标准流程（任务 06 之后）**：被测应用是真实全栈应用，环境由示例项目一把起：

```bash
# 1. 宿主：创建沙箱，把代码目录挂进去
cd platform
uv run python cli/sandboxctl.py create sample-lab \
  --image sandbox-platform/sandbox-default:0.1.0 \
  --mount "$PWD/examples/fullstack-sample:/workspace/fullstack-sample" \
  --mount "$PWD/e2e:/workspace/e2e"

# 2. 沙箱容器内：装端到端基建自己的依赖
cd /workspace/e2e
bash tools/install-deps.sh

# 3. 沙箱容器内：起全环境（postgres + minio + logto + 被测应用，每步带健康门禁）
bash /workspace/fullstack-sample/scripts/up.sh

# 4. 沙箱容器内：跑脚本模式（判定）与探索模式
pnpm run test:scripted
pnpm run test:explore

# 5. 沙箱容器内：克隆耗时基准
bash tools/new-test-db.sh bench 10

# 6. 宿主：回收沙箱
cd ..
uv run python cli/sandboxctl.py delete sample-lab --yes
```

**仅基建自检的轻量流程**（只有 postgres 与一个最小静态页，不含真实依赖）：

```bash
# 沙箱容器内
cd /workspace/e2e
bash tools/start-services.sh        # postgres + 静态页容器 app
pnpm run test:scripted
```

> 两种流程不要同时跑：`tools/start-services.sh` 里的静态页容器也叫 `app`，
> 与示例项目注册在沙箱容器上的 `app` 别名会在 DNS 上撞名。

宿主目录要让沙箱用户可写（沙箱容器里的 root 映射到沙箱专属用户，不是宿主用户）：

```bash
chmod -R o+rwX platform/e2e      # 让「他人」可读写；不动属主执行位，不影响 git
```

---

## 八、契约断言

```bash
bash tools/assert-contracts.sh
```

| 断言 | 判据 |
|---|---|
| 回环地址连接串 | `platform/e2e/` 全目录（排除 `node_modules/`、`artifacts/`、`.pnpm-store/`、`.git/` 与断言脚本自身）匹配数为 **0** |
| data-testid 唯一定位 | `tests/`、`explore/`、`helpers/` 里 XPath、语义定位器、CSS 选择器、DOM 原生选择器的命中数合计为 **0**；第三方页面豁免名单在脚本输出里公示 |

> 第三方页面豁免：Logto 登录页不是我们自己的页面，控制不了它的 DOM，没法加 data-testid。
> 它的定位集中在 `helpers/logto-signin.ts` 一个文件里，断言脚本每次运行都会公示这份豁免名单。

---

## 九、已知坑

1. **浏览器会把 `http://` 导航自动改成 `https://`**。Chromium 的「企业数据保护」URL 扫描会额外发一次
   `https://` 请求；只讲明文的静态页容器会让导航报 `net::ERR_SSL_PROTOCOL_ERROR`。
   本基建的做法：静态页服务（`fixtures/app/serve.py`）**同一端口同时接受明文与 TLS**（按连接首字节分流），
   并在配置里开 `ignoreHTTPSErrors` 放行自签证书。这样明文与 TLS 两条路都通，浏览器怎么升级都不影响。
2. **容器名要能解析**。依赖容器必须与沙箱容器在**同一网桥网络**上，且用容器名互访；
   用 IP 段地址虽然也能通，但换台机器就失效。
3. **`docker cp` 不会创建缺失的父目录**。先把目录建出来（或让容器启动时建），再拷文件。
4. **Playwright 每次运行会清空 `outputDir`**。两种模式的 trace 用 `helpers/trace-archive-reporter.ts` 额外归档一份。
5. **pnpm 的包缓存默认落在工作目录**（`.pnpm-store/`），会让代码目录变脏；用 `tools/install-deps.sh` 可改到容器家目录。
6. **宿主目录权限**。沙箱容器里的 root 映射的是沙箱专属用户，写不进宿主上属主是普通用户的目录；
   挂载前要 `chmod -R o+rwX`。
7. **容器名会被 Chromium 升级成 HTTPS**。IP 字面量与本机名不会升级，但容器名会；
   被测应用与 Logto 前面都要有双协议前置（同一端口明文 + TLS），
   否则浏览器停在 `net::ERR_SSL_PROTOCOL_ERROR`。
8. **应用不能在模板库被克隆时连着模板库**。`CREATE DATABASE ... TEMPLATE e2e_template`
   要求模板库没有其它连接；被测应用要连自己的库，用例库由应用在登录时选定。
9. **浏览器的文件下载导航不携带 `page.setExtraHTTPHeaders` 设的头**。
   要按用例库路由，就得让应用在登录时把「本次用哪个库」记进会话，后续请求（包括下载导航）都按会话走。
10. **宿主装过的 `node_modules` 沙箱内改不动**（属主不同，`pnpm install` 报 `EPERM ... chmod`）。
    `node_modules/` 在 `.gitignore` 里，沙箱内先删再装即可。

---

## 十、06（示例项目与验收演练）的接入结果

06 的示例项目直接复用这套基建，没有另起炉灶。实际落地情况：

| 06 要做的事 | 实际怎么做的 |
|---|---|
| 起被测应用 | 应用进程跑在**沙箱容器内**（沙箱就是开发环境），沙箱容器在网桥上注册 `app` 别名；依赖容器（`postgres`、`minio`、`logto`）由示例项目的 `scripts/up.sh` 拉起 |
| 应用自己的页面 | 按 `TESTID.md` 给元素加 `data-testid`，用例只写 `getByTestId()`；静态外壳 `index.html` 里也放了 `page-home-title`，健康门禁读原始 HTML 就能判就绪 |
| 应用自己的数据库 | 往 `migrations/` 加 `003_sample_records.sql`、往 `seeds/` 加 `v2.sql`；门禁自动把模板库装好，用例库自动克隆；应用在登录换 token 时选定本次用哪个库并记进会话 |
| 跑验收 | `pnpm run test:scripted` 的退出码就是验收结论；截图与 trace 就在 `artifacts/` 里 |
| agent 现场看效果 | `pnpm run test:explore` 出截图与 trace（会走到 Logto 真实登录页），退出码恒 0 |
| 依赖没起来时的排查 | 门禁失败信息里直接写明是哪个依赖、判据是什么、上限多久、最后一次探测的原因 |
| 闭环验收演练 | 2026-10-29 在全新沙箱里把下一轮需求（R1 列表过滤 / R2 提交加载态）实现到全绿：2 轮「改码→跑测」循环，从 2 failed 走到 6 passed（退出码 0）；逐步命令与决策见 `platform/examples/fullstack-sample/LOOP-LOG.md`，实测数据见 `platform/examples/fullstack-sample/RESULTS.md` 第八节 |

新增依赖服务时，只要做两件事：容器名进清单、判据写成一条可自动验证的句子。
