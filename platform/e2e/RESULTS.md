# 端到端测试基建 · 实测记录

- 执行日期：2026-10-29
- 宿主：Ubuntu 26.04 LTS / 内核 7.0.0-38-generic / cgroup v2
- Docker：客户端 + 服务端 **29.6.2**（宿主 root 守护进程）；沙箱侧免 root 守护进程同版本
- 沙箱镜像：`sandbox-platform/sandbox-default:0.1.0`（node v22.23.1 / pnpm 10.32.1 / playwright 1.64.1 / chromium 156.0.8078.4，构建号 1248）
- 沙箱名：`e2e-lab`；网桥网络 `e2e-lab-net`；代码目录挂载 `platform/e2e → /workspace`
- 依赖容器：`postgres`（postgres:16.15-alpine3.24）、`app`（沙箱镜像 + 静态页服务，端口 8000）

---

## 一、依赖安装

| 项 | 实测 |
|---|---|
| `bash tools/install-deps.sh`（含 `pnpm install`） | **2.7 秒**（21 个包，pnpm 10.32.1） |
| `pnpm exec playwright --version` | `Version 1.64.1` |
| 浏览器 | 复用沙箱镜像预装的 chromium 1248，**未**额外下载浏览器 |
| 包缓存位置 | `~/.local/share/pnpm/store`（工作目录保持干净，无 `.pnpm-store/`） |

---

## 二、脚本模式（判定依据）

命令：`pnpm run test:scripted` → `playwright test --project=scripted`

```
[门禁] 运行编号 run_mvtakudt；模板库 e2e_template；依赖 postgres、app
[门禁] 第 ① 步：等待依赖健康
[门禁] 等待依赖「postgres」就绪；判据：SELECT 1 返回且仅返回一行 1（node pg 连容器名 postgres:5432）；上限 120 秒
[门禁] 依赖「postgres」已就绪（第 1 次探测通过）
[门禁] 等待依赖「app」就绪；判据：HTTP 状态码 200 且响应体包含 data-testid="page-home-title"；上限 120 秒
[门禁] 依赖「app」已就绪（第 1 次探测通过）
[门禁] 第 ② 步：执行数据库迁移
[门禁] 迁移已执行：001_init.sql
[门禁] 迁移已执行：002_indexes.sql
[门禁] 第 ③ 步：载入种子数据
[门禁] 种子已载入：v1.sql
[门禁] 模板库 e2e_template 的种子版本：v1
[门禁] 门禁通过（postgres 连接串 postgres://postgres:postgres@postgres:5432/postgres），开始执行用例

Running 2 tests using 2 workers

[用例数据库] worker=0 pid=25520 库名=e2e_test_w0_mvtakudt
[用例数据库] worker=1 pid=25521 库名=e2e_test_w1_mvtakudt
[用例] 用例库=e2e_test_w0_mvtakudt worker=0
[用例] 用例库=e2e_test_w1_mvtakudt worker=1
[用例] 截图已保存：/workspace/artifacts/screenshots/sample-page-scripted-w1-7b000c0e.png
[用例] 隔离校验通过：本用例库=e2e_test_w0_mvtakudt，对照库=e2e_test_peer_0_mvtakuu1
  ✓  1 [scripted] › tests/e2e/sample-page.spec.ts:7:7 › 最小端到端样例 › 打开示例页 → 断言 data-testid 元素存在 → 截图 (182ms)
[用例数据库] worker=1 已销毁 e2e_test_w1_mvtakudt
  ✓  2 [scripted] › tests/e2e/db-isolation.spec.ts:10:7 › 用例隔离与种子一致性 › 两个用例库库名不同、互不影响；同一版本种子在任何用例库结果一致 (372ms)
[用例数据库] worker=0 已销毁 e2e_test_w0_mvtakudt

  2 passed (1.1s)
```

**退出码 0**（脚本模式的退出码即判定结果）。

---

## 三、探索模式（不参与判定）

命令：`pnpm run test:explore`

```
[探索] 截图：/workspace/artifacts/explore/01-home.png
[探索] 截图：/workspace/artifacts/explore/02-details-opened.png
[探索] 本次会话产出截图 2 张；trace 见 artifacts/test-results
  ✓  1 [explore] › explore/explore.spec.ts:18:5 › 探索会话：走查样例页并留存截图与 trace (241ms)
[explore] playwright 原始退出码 0；探索模式不参与判定，统一返回 0
```

**退出码 0**（探索模式恒为 0，不参与判定）。

---

## 四、每用例独立数据库

### 并行隔离佐证

`artifacts/db-usage.log`（脚本模式一次运行）：

```
{"worker":0,"pid":25520,"database":"e2e_test_w0_mvtakudt","event":"created","ts":"2026-10-29T08:39:10.845Z"}
{"worker":1,"pid":25521,"database":"e2e_test_w1_mvtakudt","event":"created","ts":"2026-10-29T08:39:10.908Z"}
{"worker":1,"pid":25521,"database":"e2e_test_w1_mvtakudt","event":"dropped","ts":"2026-10-29T08:39:11.222Z"}
{"worker":0,"pid":25520,"database":"e2e_test_w0_mvtakudt","event":"dropped","ts":"2026-10-29T08:39:11.301Z"}
```

两个 worker 并行，各自连各自的库（库名不同），用例结束即销毁。
用例 `db-isolation.spec.ts` 另外克隆一个对照库，比对两库的种子行数与内容指纹一致，
并验证在自有库写入的标记行在对照库里查不到。

### 连续克隆 10 个用例库的耗时

命令：`bash tools/new-test-db.sh bench 10`

```
[db] 第 1 次克隆 e2e_bench_1793263161_1 耗时 148 毫秒
[db] 第 2 次克隆 e2e_bench_1793263161_2 耗时 139 毫秒
[db] 第 3 次克隆 e2e_bench_1793263161_3 耗时 135 毫秒
[db] 第 4 次克隆 e2e_bench_1793263161_4 耗时 143 毫秒
[db] 第 5 次克隆 e2e_bench_1793263161_5 耗时 137 毫秒
[db] 第 6 次克隆 e2e_bench_1793263161_6 耗时 142 毫秒
[db] 第 7 次克隆 e2e_bench_1793263161_7 耗时 129 毫秒
[db] 第 8 次克隆 e2e_bench_1793263161_8 耗时 135 毫秒
[db] 第 9 次克隆 e2e_bench_1793263161_9 耗时 159 毫秒
[db] 第 10 次克隆 e2e_bench_1793263161_10 耗时 159 毫秒

克隆耗时汇总（连续 10 个用例库，模板库 e2e_template）
  单库最短 129 毫秒
  单库最长 159 毫秒
  单库平均 143 毫秒
  合计 1432 毫秒
判定：通过 —— 单库耗时均不超过 5000 毫秒
```

| 口径 | 数值 | 判据 | 结论 |
|---|---|---|---|
| 单库最长 | **159 毫秒** | ≤ 5000 毫秒 | 通过（余量 31 倍） |
| 单库平均 | 143 毫秒 | — | — |
| 连续 10 个合计 | 1432 毫秒 | — | — |

---

## 五、契约断言

命令：`bash tools/assert-contracts.sh`（宿主侧与沙箱内各跑一次，结果一致）

```
[契约] 回环地址连接串断言
  扫描目录：/workspace
  匹配模式：本机回环主机名、回环 IP
  匹配数：0
判定：通过 —— 匹配数为 0，全部连接串走容器名

[契约] data-testid 唯一定位断言
  扫描范围：tests/、explore/
  模式 xpath 命中 0 处
  模式 getBy(Text|Role|Label|Placeholder|Title|AltText) 命中 0 处
  模式 locator[[:space:]]*\( 命中 0 处
  模式 \$\$?[[:space:]]*\( 命中 0 处
  模式 querySelector 命中 0 处
  模式 getElementById 命中 0 处
  合计命中：0
判定：通过 —— 全部用例只用 data-testid 定位，匹配数为 0

[契约] 判定：通过
```

---

## 六、产物留存

运行后工作目录（`/workspace`，即宿主上的 `platform/e2e/`）内出现：

| 文件 | 说明 |
|---|---|
| `artifacts/screenshots/sample-page-scripted-w1-7b000c0e.png` | 样例用例显式截图（35 076 字节，PNG magic 校验通过） |
| `artifacts/explore/01-home.png`、`02-details-opened.png` | 探索会话分步截图 |
| `artifacts/test-results/.../trace.zip` | 本次运行的 trace（102 229 字节，ZIP magic 校验通过） |
| `artifacts/traces/scripted-*.zip`（2 个）、`explore-*.zip`（1 个） | 两种模式的 trace 归档副本 |
| `artifacts/html-report/index.html` | HTML 报告 |
| `artifacts/results.json`、`artifacts/db-usage.log` | 机器可读结果与用例库使用记录 |

统计：**PNG 5 个、trace 4 份**，全部在用户声明挂载的代码目录内，未写容器临时层、未上传外部服务。

失败用例自动留截图（临时加一条必然失败的用例实测）：

```
attachment #1: screenshot (image/png) ──
artifacts/test-results/tests-e2e-tmp-fail-临时失败用例（验证失败自动留截图）-scripted/test-failed-1.png
attachment #3: trace (application/zip) ──
  1 failed
  2 passed (11.1s)
退出码=1
```

---

## 七、门禁失败的表现

把应用依赖指向错误端口（`E2E_APP_URL=http://app:9999`）：

```
[门禁] 等待依赖「app」就绪；判据：HTTP 状态码 200 且响应体包含 data-testid="page-home-title"；上限 120 秒
Error: 依赖「app」等待超时；判据：HTTP 状态码 200 且响应体包含 data-testid="page-home-title"；上限 120 秒；最后原因：依赖「app」未就绪；判据：HTTP 状态码 200 且响应体包含 data-testid="page-home-title"；原因：fetch failed
门禁失败退出码=1
```

失败信息里带齐了：依赖名、判据、超时上限、最后一次探测的原因；用例一条都没跑，退出码 1。

---

## 八、目录结构

```
platform/e2e/
├── README.md                       # 用法、门禁、产物、已知坑、给 06 的复用说明
├── RESULTS.md                      # 本文件
├── TESTID.md                       # data-testid 命名规范（12 个示例 + 13 个反例）
├── package.json                    # @playwright/test 1.64.1 + pg 8.23.1
├── pnpm-lock.yaml
├── tsconfig.json
├── playwright.config.ts            # scripted / explore 两个 project
├── global-setup.ts                 # 健康检查门禁
├── global-teardown.ts
├── config/dependencies.json        # 依赖清单（数据驱动）
├── fixtures/
│   ├── app/index.html              # 最小静态页（带 data-testid）
│   ├── app/serve.py                # 同端口同时讲明文与 TLS 的静态页服务
│   └── test-db.ts                  # 每 worker 一个独立数据库的 fixture
├── helpers/
│   ├── config.ts                   # 清单装载、连接串拼装、产物目录
│   ├── postgres.ts                 # pg 封装、种子指纹
│   ├── health.ts                   # 判据实现（SELECT 1 / HTTP 200）
│   ├── artifacts.ts                # 截图落盘路径
│   └── trace-archive-reporter.ts   # trace 归档 reporter
├── migrations/001_init.sql、002_indexes.sql
├── seeds/v1.sql                    # 种子（版本 v1）
├── tests/e2e/sample-page.spec.ts、db-isolation.spec.ts
├── explore/explore.spec.ts
├── tools/
│   ├── new-test-db.sh              # 建库 / 删库 / 十连克隆计时
│   ├── start-services.sh           # 起 postgres 与 app 容器
│   ├── run-explore.sh              # 探索模式入口（退出码恒 0）
│   ├── run-all.sh                  # 两模式依次跑
│   ├── install-deps.sh             # 装依赖（支持镜像源与缓存目录）
│   ├── assert-contracts.sh         # 契约断言总入口
│   ├── assert-no-loopback.sh       # 回环地址连接串断言
│   └── assert-testid-only.sh       # data-testid 唯一定位断言
└── artifacts/                      # 运行产物（不进版本库）
```

---

## 九、踩坑清单

1. **浏览器会把 `http://` 导航自动改成 `https://`**（本次最大的坑）。
   Chromium 156 的「企业数据保护」URL 扫描会额外发一次 `https://` 请求；
   只讲明文的静态页容器会让导航报 `net::ERR_SSL_PROTOCOL_ERROR`。
   排查路径：开 `--enable-logging=stderr --v=1`，日志里会同时出现
   `NotifyBeforeURLRequest: http://app:8000/` 与 `NotifyBeforeURLRequest: https://app:8000/`，
   前一行还有 `enterprise.data_protection: URL to scan: http://app:8000/`。
   逐项排除过的无效假设：`--disable-features=HttpsUpgrades`（Playwright 默认已带）、
   `--disable-features=UseDnsHttpsSvcb`、`--host-resolver-rules`、`--dns-over-https-mode=off`、
   各种按主机名/IP 地址的对比 —— 都不是它。
   **最终解法**：静态页服务按连接首字节分流，同一端口同时接受明文与 TLS（自签证书），
   配置里开 `ignoreHTTPSErrors`。两条路都通，浏览器怎么升级都不影响。
   附带现象：同一台宿主上 DNS 走 fake-IP 网段（`198.18.x.x`）时，
   浏览器对主机名的解析路径与 IP 字面量不同，会让这个问题看起来「时好时坏」；
   用 IP 字面量访问时永远正常，所以排查时容易被误导。
2. **`docker cp` 不会创建缺失的父目录**：`Could not find the file /srv/www in container app`。
   解法：容器先用 `mkdir -p` 建目录并等 `serve.py` 到位再启动服务，文件逐个拷进去。
3. **`docker create` + `docker cp` + `docker start` 的顺序**：`docker cp` 只能对已存在的容器执行，
   所以必须先 `create`（不启动）再拷文件，最后 `start`。
4. **沙箱容器里的 root 写不进宿主目录**：容器里的 root 映射的是沙箱专属用户（不是宿主用户），
   挂载前必须 `chmod -R o+rwX` 宿主目录。`o+rwX` 不改属主执行位，git 不会记录模式变更。
5. **pnpm 的包缓存默认落在工作目录**（`.pnpm-store/`，本次 47 MB），会把代码目录弄脏，
   还会把第三方包里的回环地址字符串带进契约断言的扫描范围。
   解法：`tools/install-deps.sh` 传 `--store-dir` 指到容器家目录；断言脚本排除 `.pnpm-store/`。
6. **Playwright 每次运行清空 `outputDir`**：后一次运行会覆盖前一次的 trace。
   解法：额外写一个 reporter 把 trace 复制到 `artifacts/traces/`，两种模式的 trace 可同时保留。
7. **Playwright 的 worker 级 fixture 签名**：1.64 里 worker 作用域的 fixture 第三个参数才是 `workerInfo`
   （`async ({}, use, workerInfo) => {}`），从参数里取 `workerInfo` 类型不通过。
8. **worker 级 fixture 要写进 `extend` 的第二个类型参数**：`base.extend<{}, { testDb: TestDatabase }>({...})`，
   写在第一个类型参数里会被当成 test 作用域，类型直接报错。
9. **`pnpm-lock.yaml` 里没有回环地址字符串**：断言脚本不需要为它开例外。
10. **沙箱镜像里没有 psql 客户端**：所有 shell 侧数据库操作都必须 `docker exec <pg容器名> psql`；
    Node 侧（健康判据、迁移、种子）用 `pg` 走容器名连接。

---

## 十、完成标准逐条核对

| 完成标准 | 结论 | 依据 |
|---|---|---|
| `platform/e2e/` 用 nvm + pnpm 管理依赖，`package.json` 声明 `@playwright/test`，`pnpm install` 与 `pnpm exec playwright --version` 均成功 | 通过 | 第一节：2.7 秒装完 21 个包，版本 1.64.1 |
| `playwright.config.ts` 定义两个 project：`scripted`（跑 `tests/e2e` 下用例，作判定，有明确退出码）与 `explore`（探索会话，出截图与 trace，不参与判定） | 通过 | 第二节、三节：脚本模式退出码 0、探索模式退出码恒 0 |
| 两模式都能单条命令执行并产出可复现退出码 | 通过 | `pnpm run test:scripted` / `pnpm run test:explore`；`pnpm run test:all` 依次跑 |
| 健康门禁在全局 setup，顺序固定：等依赖健康（明确判据 + 120 秒上限）→ 迁移 → 种子；任一步失败打印依赖名与判据 | 通过 | 第二、七节：门禁日志顺序正确；失败时打印依赖名、判据、上限、最后原因，退出码 1 |
| 依赖清单数据驱动 | 通过 | `config/dependencies.json`；`E2E_DEPENDENCIES_FILE` 换清单、`E2E_PG_URL`/`E2E_APP_URL` 换指向 |
| 每用例独立数据库工具 `tools/new-test-db.sh`：模板库克隆、用例后销毁、psql 经 docker exec、容器名可配 | 通过 | 第四节：十连克隆实测；`E2E_PG_CONTAINER` 可配 |
| 实测连续创建 10 个用例库耗时，单库 ≤ 5 秒 | 通过 | 单库最长 159 毫秒，平均 143 毫秒 |
| 种子带版本号，同一版本在任意用例库载入结果一致（行数校验佐证） | 通过 | `seeds/v1.sql` 记版本 v1；`db-isolation.spec.ts` 比对两库行数（5 条）与内容指纹 |
| `TESTID.md` 写明命名规则、≥10 个示例、反例 | 通过 | 12 个示例 + 13 个反例 |
| 用例只按 `data-testid` 定位，检索断言匹配数为 0 | 通过 | 第五节：6 类禁用写法命中数合计 0 |
| 产物落在用户声明挂载的代码目录；失败用例自动留截图；运行后目录内出现 `*.png` 与 `trace.zip` | 通过 | 第六节：PNG 5 个、trace 4 份，magic 校验通过；失败用例产出 `test-failed-1.png` |
| 两个用例并行时数据库名不同且互不影响（打印各自库名佐证） | 通过 | 第四节：`artifacts/db-usage.log` 记录两个 worker 的库名；用例断言对照库看不到标记行 |
| 全部连接串走容器名，不存在本机回环地址连接串（匹配数 0） | 通过 | 第五节：匹配数 0 |
| 提供最小端到端样例，一条命令跑通并产出 PNG | 通过 | `pnpm run test:scripted` 一条命令产出 `artifacts/screenshots/*.png` |

---

## 十一、任务 06 增量（接入真实全栈示例应用）

- 执行日期：2026-10-29
- 沙箱名：`sample-lab`；网桥 `sample-lab-net`；挂载 `platform/examples/fullstack-sample → /workspace/fullstack-sample`、`platform/e2e → /workspace/e2e`
- 依赖容器：`postgres`、`minio`、`logto`（均由示例项目的 `scripts/up.sh` 拉起）

### 增量内容

| 项 | 增量 |
|---|---|
| 依赖清单 | 新增 `minio`（`/minio/health/live` 返回 200）与 `logto`（OIDC 发现文档返回 200 且含 issuer）；`app` 的地址改为 `http://app:8000/` |
| 迁移 | 新增 `migrations/003_sample_records.sql`（示例应用的业务表 `sample_records`） |
| 种子 | 新增 `seeds/v2.sql`（版本 v2：两条初始记录）；种子版本现为 `v1,v2` |
| 用例 | 新增 `tests/e2e/fullstack-sample.spec.ts`（Logto 登录 → 写库 → 传 MinIO → 列表 → 下载比对）；`sample-page.spec.ts` 改为只断言两套流程都成立的 `page-home-title`；`explore/explore.spec.ts` 改为走查应用首页与 Logto 登录页 |
| 辅助 | 新增 `helpers/logto-signin.ts`（第三方页面定位集中一处，契约断言显式豁免并公示）；`helpers/postgres.ts` 的种子指纹加入 `sample_records` 行数与哈希 |
| 断言 | `tools/assert-testid-only.sh` 的扫描范围扩到 `helpers/`，并公示第三方页面豁免名单 |

### 实测

```
[门禁] 依赖 postgres、minio、logto、app 全部第 1 次探测通过
[门禁] 迁移已执行：001_init.sql、002_indexes.sql、003_sample_records.sql
[门禁] 种子已载入：v1.sql、v2.sql（模板库种子版本：v1, v2）
  4 passed (2.6s)
退出码 = 0
```

| 口径 | 数值 |
|---|---|
| 脚本模式整套耗时（连续 3 次） | 3073 / 2958 / 3003 毫秒 |
| 用例数 | 4 条（2 个 worker 并行） |
| 模板库十连克隆 | 单库最短 130 / 最长 147 / 平均 140 毫秒 |
| 截图 | 4 张（脚本 2 张 + 探索 2 张），1280×986 与 1280×720 |
| trace | 5 份 |

> 完整实测记录见 `platform/examples/fullstack-sample/RESULTS.md`。
