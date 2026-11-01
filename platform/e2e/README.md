# 端到端测试基建

以 Playwright 为核心的端到端测试基建：**单 project 脚本模式**；运行前有健康检查门禁
（等静态页就绪）；元素定位只认 `data-testid`；截图与 trace 留在用户声明挂载的代码目录里。

**零外部服务依赖**：不需要 Postgres / MinIO / Logto，也不需要数据库迁移与种子；
验收口径就是「静态页可达冒烟 + 平台契约断言」。

```
platform/e2e/
├── playwright.config.ts        # 单 project：scripted（退出码即判定）
├── global-setup.ts             # 健康检查门禁：静态页就绪
├── config/dependencies.json    # 依赖清单（数据驱动）
├── helpers/                    # 配置、健康判据、产物路径、trace 归档 reporter
├── tests/e2e/                  # 脚本化用例
├── fixtures/app/               # 最小静态页与它的双协议服务
├── tools/                      # 命令行工具（起静态页容器、契约断言、装依赖）
├── TESTID.md                   # data-testid 命名规范
└── artifacts/                  # 运行产物：截图、trace、报告（不进版本库）
```

---

## 一、环境前提

| 前提 | 说明 |
|---|---|
| Node 22 + pnpm | 沙箱镜像自带（nvm 管理），宿主也可用 |
| 浏览器 | Playwright chromium 1.64.1（构建号 1248），沙箱镜像需已预装，**不要**再跑 `playwright install` |
| 静态页容器 | 一个 `python:3.12-alpine` 容器：容器名 `app`、端口 8000，与沙箱容器在**同一网桥网络**上 |

除静态页容器外不再需要任何外部服务。

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

## 三、运行模式

只有一种模式：

| 模式 | 命令 | 跑什么 | 退出码 | 是否参与判定 |
|---|---|---|---|---|
| 脚本模式 | `pnpm run test:scripted` | `tests/e2e` 下的全部用例 | 0 = 通过，非 0 = 不通过 | **是** |

- 脚本模式是判定依据：失败即失败，退出码可直接进 CI。
- 退出码由 playwright 自身给出，基建不再有压退出码的包装脚本。

---

## 四、健康检查门禁

门禁在 `global-setup.ts` 里，只有一步：**等待静态页健康**。

- 依赖清单数据驱动，每个依赖一条明确判据，单依赖等待上限 **120 秒**；
- 判据通过才允许跑用例；失败立即整体失败，退出码非 0，并打印**失败依赖名 + 判据 + 超时上限 + 最后原因**：

```
Error: 依赖「app」等待超时；判据：HTTP 状态码 200 且响应体包含 data-testid="page-home-title"；上限 120 秒；最后原因：fetch failed
```

### 依赖清单

`config/dependencies.json`：

```json
{
  "dependencies": [
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
- 换依赖的指向：`E2E_APP_URL=...`；
- 清单里写的超时上限超过 120 秒会直接报错，防止有人把等待上限放大。

**所有连接串一律走容器名**（沙箱内部网络中由 docker 内置 DNS 解析），不使用本机回环地址。

---

## 五、静态页底座

| 项 | 说明 |
|---|---|
| `fixtures/app/index.html` | 最小静态页：首页标题带 `data-testid="page-home-title"` |
| `fixtures/app/serve.py` | 静态页服务：同一端口同时接受明文与 TLS（按连接首字节分流） |
| 容器镜像 | `python:3.12-alpine`（自带 python 解释器，容器命令直接跑服务，不做包装） |
| 容器名 / 端口 | `app` / 8000（`E2E_APP_CONTAINER`、`E2E_APP_IMAGE`、`E2E_APP_PORT` 可改） |

静态页底座兼两职：既是冒烟用例的被测对象，也是门禁的健康判据对象。

---

## 六、产物

| 路径 | 内容 |
|---|---|
| `artifacts/screenshots/` | 用例显式截图 |
| `artifacts/test-results/` | Playwright 每条用例的输出目录：`trace.zip`、失败截图 `test-failed-1.png` |
| `artifacts/traces/` | 按「project + 用例」归档的 trace 副本 |
| `artifacts/html-report/` | HTML 报告 |
| `artifacts/results.json` | 机器可读结果 |

产物全部落在**用户声明挂载的代码目录**内（不写容器临时层、不上传外部服务）。
`artifacts/` 与 `node_modules/` 不进版本库。

---

## 七、标准流程

被测对象只有静态页底座，一套流程走到底：

```bash
# 1. 宿主：创建沙箱，把端到端基建目录挂进去
cd platform
uv run python cli/sandboxctl.py create e2e-lab \
  --image node:22-bookworm \
  --mount "$PWD/e2e:/workspace/e2e"

# 2. 沙箱容器内：装端到端基建自己的依赖
cd /workspace/e2e
bash tools/install-deps.sh

# 3. 沙箱容器内：起静态页容器（容器名 app，端口 8000）
bash tools/start-services.sh

# 4. 沙箱容器内：跑契约断言与脚本模式
bash tools/assert-contracts.sh
pnpm run test:scripted

# 5. 宿主：回收沙箱
cd ..
uv run python cli/sandboxctl.py delete e2e-lab --yes
```

宿主目录要让沙箱用户可写（沙箱容器里的 root 映射到沙箱专属用户，不是宿主用户）：

```bash
chmod -R o+rwX platform/e2e      # 让「他人」可读写；不动属主执行位，不影响 git
```

> 跑在沙箱容器之外（宿主直跑）时，容器名 `app` 在宿主侧解析不到，
> 把 `E2E_APP_URL` 指向静态页容器的地址即可（例如 `E2E_APP_URL=http://<容器IP>:8000/`）。

---

## 八、契约断言

```bash
bash tools/assert-contracts.sh
```

| 断言 | 判据 |
|---|---|
| 回环地址连接串 | `platform/e2e/` 全目录（排除 `node_modules/`、`artifacts/`、`.pnpm-store/`、`.git/` 与断言脚本自身）匹配数为 **0** |
| data-testid 唯一定位 | `tests/`、`helpers/` 里 XPath、语义定位器、CSS 选择器、DOM 原生选择器的命中数合计为 **0** |

> 第三方页面豁免名单当前为空：基建只测自己的静态页。将来接入第三方页面（控制不了它的 DOM）时，
> 把它的定位集中到一个文件并登记进 `tools/assert-testid-only.sh` 的豁免名单，断言脚本每次运行都会公示这份名单。

---

## 九、已知坑

1. **浏览器会把 `http://` 导航自动改成 `https://`**。Chromium 的「企业数据保护」URL 扫描会额外发一次
   `https://` 请求；只讲明文的静态页容器会让导航报 `net::ERR_SSL_PROTOCOL_ERROR`。
   本基建的做法：静态页服务（`fixtures/app/serve.py`）**同一端口同时接受明文与 TLS**（按连接首字节分流），
   并在配置里开 `ignoreHTTPSErrors` 放行自签证书。这样明文与 TLS 两条路都通，浏览器怎么升级都不影响。
2. **容器名要能解析**。静态页容器必须与沙箱容器在**同一网桥网络**上，且用容器名互访；
   用 IP 段地址虽然也能通，但换台机器就失效。
3. **`docker cp` 不会创建缺失的父目录**。先把目录建出来（或让容器启动时建），再拷文件。
4. **Playwright 每次运行会清空 `outputDir`**。trace 用 `helpers/trace-archive-reporter.ts` 额外归档一份。
5. **pnpm 的包缓存默认落在工作目录**（`.pnpm-store/`），会让代码目录变脏；用 `tools/install-deps.sh` 可改到容器家目录。
6. **宿主目录权限**。沙箱容器里的 root 映射的是沙箱专属用户，写不进宿主上属主是普通用户的目录；
   挂载前要 `chmod -R o+rwX`。
7. **宿主装过的 `node_modules` 沙箱内改不动**（属主不同，`pnpm install` 报 `EPERM ... chmod`）。
   `node_modules/` 在 `.gitignore` 里，沙箱内先删再装即可。

---

## 十、退役说明

2026-11-01「目录重组轮」第一步给本基建做了一次瘦身，下列能力已整体退役（代码与脚本一并删除）：

| 退役项 | 原作用 | 现状 |
|---|---|---|
| 全栈示例项目（仓库内 `platform/examples/` 目录） | 示例应用 + 示例迁移 + 示例种子 | 目录已删除；全栈链路的实测记录留档在仓库根 `RESULTS.md` 与本目录 `RESULTS.md`（历史留档，内容一字未改） |
| 每用例独立数据库（每用例克隆一个库、迁移与种子、建库工具） | 用例间数据隔离 | 已删除；门禁只判静态页一条 |
| 依赖三件套（Postgres / MinIO / Logto） | 全栈依赖容器 | 已删除；`config/dependencies.json` 只留静态页判据 |
| 探索模式（探索会话目录与它的入口脚本） | 现场走查会话（退出码恒 0） | 已删除；只剩单 project 脚本模式 |
| 第三方登录页定位辅助 | 第三方页面的元素定位 | 已删除；第三方页面豁免名单随之清空 |

验收口径随之收敛为：**静态页可达冒烟 + 平台契约断言**。
