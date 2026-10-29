# 全栈示例项目（FastAPI + React + Postgres + MinIO + Logto）

沙箱平台的一期验收对象：一个**真实**的全栈应用，用来证明「agent 在沙箱里自己起环境、自己跑端到端、自己看截图」这条闭环成立。

- 后端：FastAPI + uv，真实读写 Postgres、真实走 S3 协议访问 MinIO、真实对接 Logto 完成 OIDC 授权码登录。
- 前端：React + Vite（TypeScript），构建产物由后端托管。
- 依赖：Postgres / MinIO / Logto 全部容器化，跑在沙箱网内，按容器名互访。

当前已实现的功能清单见 [REQUIREMENTS.md](./REQUIREMENTS.md)；实测数据见 [RESULTS.md](./RESULTS.md)；
下一轮要做的需求见 [BRIEF-NEXT.md](./BRIEF-NEXT.md)。

---

## 一、目录结构

```
platform/examples/fullstack-sample/
├── README.md                    # 本文件
├── REQUIREMENTS.md              # 当前已实现功能清单（下一轮需求的基线）
├── BRIEF-NEXT.md                # 下一轮需求（下一个执行者只拿这份）
├── RESULTS.md                   # 实测数据
├── backend/
│   ├── pyproject.toml           # uv 依赖声明
│   ├── migrations/
│   │   └── 001_sample_records.sql   # 业务表结构
│   └── app/
│       ├── main.py              # 路由：静态前端 + 登录 + 记录读写 + 附件上下传
│       ├── config.py            # 环境变量配置
│       ├── db.py                # Postgres 连接池（按数据库名惰性建池）
│       ├── storage.py           # MinIO（S3 协议）访问
│       └── auth.py              # Logto OIDC 授权码 + id_token 校验
├── frontend/
│   ├── package.json             # pnpm 依赖声明
│   ├── vite.config.ts
│   ├── index.html               # 静态外壳（带 data-testid，供健康门禁读原始 HTML）
│   └── src/
│       ├── main.tsx
│       ├── App.tsx              # 首页 + 回调页
│       ├── api.ts               # 后端接口封装
│       └── types.ts
└── scripts/
    ├── up.sh                    # 按序拉起依赖 + 健康门禁（一条命令起全环境）
    ├── down.sh                  # 停掉应用进程与依赖容器
    ├── dual-protocol-proxy.mjs  # 同端口明文 + TLS 双协议前置代理
    └── provision-logto.mjs      # 预置 Logto 应用与测试用户
```

---

## 二、一条命令起全环境

在**沙箱容器内**执行：

```bash
bash /workspace/fullstack-sample/scripts/up.sh
```

`up.sh` 固定 12 步，每步都有健康门禁，任何一步不通过立即退出：

| 步 | 动作 | 门禁判据 |
|---|---|---|
| 1 | 基础环境检查 | docker / uv / node / pnpm / openssl / curl 齐备 |
| 2 | 确定沙箱网络、注册 `app` 别名 | 沙箱容器在网桥上以 `app` 为别名 |
| 3 | 复制源码到容器内 `/opt/sample` | **不写用户的代码目录** |
| 4 | `uv sync` + `pnpm install` + `pnpm run build` | 前端产物 `dist/index.html` 存在 |
| 5 | 生成自签证书 | 证书与私钥就位 |
| 6 | 拉起 postgres、建业务库、执行迁移 | `pg_isready` 通过 |
| 7 | 拉起 minio | `/minio/health/live` 返回 200 |
| 8 | 初始化 Logto 数据库并拉起 Logto | OIDC 发现文档返回 200 |
| 9 | 供应 Logto（应用 + 测试用户） | 管理 API 返回应用与用户 |
| 10 | 创建 MinIO 桶 | `head_bucket` 通过 |
| 11 | 启动应用（uvicorn + 双协议代理） | 进程起来 |
| 12 | 应用健康门禁 | 明文与 TLS 两条路都返回 200，首页含 `data-testid="page-home-title"` |

停掉：

```bash
bash /workspace/fullstack-sample/scripts/down.sh
```

---

## 三、端口与地址约定

| 对象 | 容器名 | 地址 | 说明 |
|---|---|---|---|
| 应用 | 沙箱容器（别名 `app`） | `http://app:8000` | 同端口同时接受明文与 TLS |
| Postgres | `postgres` | `postgres://postgres:postgres@postgres:5432/postgres` | 业务库 `sample_app`，端到端用例库按 worker 克隆 |
| MinIO | `minio` | `http://minio:9000` | S3 协议；桶 `sample-records` |
| Logto（默认租户） | `logto` | `http://logto:3001` | OIDC issuer `http://logto:3001/oidc` |
| Logto（管理租户） | `logto` | `http://logto:3002` | 管理 API 与 client_credentials 走这里 |

**所有连接串一律走容器名**，不使用本机回环地址（端到端基建有契约断言守着这条）。
本项目里出现的回环地址只有一类：双协议前置代理到**同一容器内**的后端进程（如 `127.0.0.1:8001`），
那是容器内的进程间跳转，不是依赖寻址。

---

## 四、依赖版本

| 依赖 | 版本 | 来源 |
|---|---|---|
| Python | 3.11（沙箱镜像自带） | `uv` 管理虚拟环境 |
| Node / pnpm | 22.23.1 / 10.32.1 | 沙箱镜像自带（nvm 管理） |
| FastAPI | ≥ 0.115 | `backend/pyproject.toml` |
| React / Vite | 19.2.0 / 7.1.9 | `frontend/package.json` |
| postgres | 16.15-alpine3.24 | 离线包 |
| MinIO | RELEASE.2025-04-22T22-12-26Z | 离线包 |
| Logto | 1.29.0 | 离线包 |

---

## 五、四个绕不开的设计决定

### 1. 双协议前置代理（为什么不能只用明文 HTTP）

Chromium 会对 `http://` 导航额外发一次 `https://` 请求（企业数据保护 URL 扫描），
只讲明文的服务会让浏览器停在 `net::ERR_SSL_PROTOCOL_ERROR`。
实测：容器名 `app` 会被升级，IP 字面量与 `localhost` 不会。

因此应用与 Logto 前面都挂一个**按连接首字节分流**的前置代理（`scripts/dual-protocol-proxy.mjs`）：
首字节是 `0x16`（TLS 握手）就走 TLS，其余按明文 TCP 转发。同一端口两条路都通：

- 机器客户端（健康门禁、后端调 Logto）用明文，不需要配置任何证书信任；
- 浏览器（Playwright，`ignoreHTTPSErrors: true`）走 TLS 自签证书。

### 2. 应用跑在沙箱容器里，不单独起容器

沙箱本来就是 agent 的开发环境。应用进程跑在沙箱容器内，
源码先复制到容器内的 `/opt/sample` 再 `uv sync` / `pnpm install`，
**用户的代码目录保持原样**（不落 `.venv`、`node_modules`、`dist`）。

为了让别的容器按名字访问它，沙箱容器在网桥上注册了 `app` 别名
（`up.sh` 第 2 步：断开后带别名重连同一个网桥网络）。

### 3. Logto 的供应方式：管理 API + 种子自带的机器对机器应用

Logto 没有「开箱即用的管理员口令」，首次初始化还要在管理后台网页里注册管理员。
所以走这条无人值守的路径：

1. `logto db seed` 建表并写入种子数据，种子会为「默认租户的管理接口」预置一个机器对机器应用 `m-default`；
2. 从数据库读出 `m-default` 的客户端密钥，到**管理租户**（3002）的 token 端点做 `client_credentials`，
   换到真正的「管理接口访问令牌」；
3. 拿令牌调管理 API（3001 的默认租户）：`POST /api/applications` 建授权码应用，`POST /api/users` 建测试用户。

全程是真实的 OAuth2 客户端凭证流程 + 真实管理 API，没有人工点击。
细节见 `scripts/provision-logto.mjs` 的文件头注释。

### 4. 每个用例独占一个数据库：会话记住「本次用哪个库」

端到端基建给每个 worker 克隆一个独立数据库（`e2e_test_w0_<run>` 这样）。
应用侧的做法：

- 登录换 token 时，用 `x-sample-database` 请求头告知本次用哪个库，**记进会话**；
- 之后所有请求（含浏览器的文件下载导航）都按会话走同一个库。

这样「写进 Postgres」这一步真的落在本用例自己的库里，
两个 worker 并行互不干扰，`db-isolation.spec.ts` 的对照库也看不到对方的行。

---

## 六、在端到端基建里怎么跑

```bash
# 宿主：创建沙箱，把示例项目与端到端基建一起挂进去
cd platform
uv run python cli/sandboxctl.py create sample-lab \
  --image sandbox-platform/sandbox-default:0.1.0 \
  --mount "$PWD/examples/fullstack-sample:/workspace/fullstack-sample" \
  --mount "$PWD/e2e:/workspace/e2e"

# 沙箱容器内：起全环境
bash /workspace/fullstack-sample/scripts/up.sh

# 沙箱容器内：跑端到端（退出码即判定）
cd /workspace/e2e && bash tools/install-deps.sh && pnpm run test:scripted
```

用例在 `platform/e2e/tests/e2e/fullstack-sample.spec.ts`，覆盖：
Logto 登录页真实输入 → 授权码回调 → 后端校验 id_token → 写 Postgres → 传 MinIO → 列表展示 → 下载比对字节。

---

## 七、单独跑这个示例（不接端到端基建）

1. 起依赖：`bash scripts/up.sh`（它会把业务库 `sample_app` 建好并执行 `backend/migrations/`）。
2. 打开 `http://app:8000`，点「用 Logto 登录」，用 `sampleuser / SamplePass123!` 登录。
3. 业务表结构在 `backend/migrations/001_sample_records.sql`；
   端到端基建里另有一份同样的内容（`platform/e2e/migrations/003_sample_records.sql`），
   因为端到端门禁要在模板库里建出同样的表，两处保持一致。
