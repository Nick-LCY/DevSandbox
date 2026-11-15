# 镜像缓存清单与缓存优先拉取引导：全轮收口留档（01~06）

> **2026-11-15 全轮收口**：6 个任务全部 done，PRD 验收 **32 / 32** 逐条核销（证据分真机 e2e / 单测 / 真机记录与实测三档，逐条注记见 [[prds/registry-cache-manifest.md|PRD]] 验收标准节），e2e 全量 **71 / 71**。本文是该轮的总留档：轮次总表、门禁数字、真缓存实测与真机记录汇总、已知边界与留白、硬约束复核。

## 一、轮次总表与提交链

| 任务 | 交付 | 提交链 | 收口日期 |
|---|---|---|---|
| 01 核心包缓存扫描器 | `cache_manifest.py`（纯解析与特权 IO 分离）+ 63 例单测 + 真缓存实测（抓出并修复 `0x7B` 撞「第一个 `{`」启发式的真实解析缺陷） | `82cf57d` 主实现 + `43fec65` 审查修复 | 2026-11-15 |
| 02 服务端端点与受限令牌 | `GET /api/proxy/cache/images`（json\|text、422、503、60s TTL）+ `cache-images-token.json` 凭据文件 + `BearerAuthMiddleware` 双凭据限界 + 33 例单测 | `ab95fa1` 主实现 + `dea6828` 审查收尾 | 2026-11-15 |
| 03 注入管线 | 服务端创建/启动递参 + 核心包 `_run_sandbox_container` 平台强制注入两 env（平台值优先、不进 metadata）+ 可达地址配置优先与探测兜底 + 真机六项 | `3197e1a` 主实现 + `5b337f1` 审查收尾 | 2026-11-15 |
| 04 基础镜像 `base:0.4.0` | `cached-images` 纯 bash 三态命令（`--noproxy`、5s/10s 封顶、双退出码）+ Dockerfile/README bump + verify.sh 61 项 + 真机三态实测 | `912989c` 主实现 + `7ec26ed` 审查收尾 | 2026-11-15 |
| 05 console 缓存镜像清单视图 | 设置抽屉视图（人读大小、空态/失败态、手动刷新零轮询双保险）+ 10 例单测（含「刷新失败保留旧清单」回归钉） | `4ad452b` 主实现 + `a33c33f` 审查收尾 | 2026-11-15 |
| 06 验收与文档收口 | e2e `16-cache-images.spec.ts` 4 条（真浏览器+真沙箱+真缓存）+ 门禁全量 + PRD 32 条逐条核销 + API.md 第 17 章 / README / base-image 口径 / 词汇表 / 看板两清单 + 本留档 | 三个提交（`9ec6fbc` / `f93310f` / `9572d5c`）：`test(registry-cache-manifest)` 验收 spec → `docs(registry-cache-manifest)` 文档落位 → `docs(registry-cache-manifest)` 全轮收口；收口后审查复核两提交：`e04391b` 审查收尾 + `65f8d72` 复核勘误（见下「审查复核收尾」） | 2026-11-15 |

依赖顺序 `01 → 02 → {03, 04, 05} → 06` 全部按计划走完；机制不设打样轮（前向 md5 验证与反向 `KEY:` 头枚举由立项前侦察双向实证），01 直接实装、真缓存实测即验收——该决策被 01 的实测结果（含抓出一个真实缺陷）证实是合理的。

**审查复核收尾（06 收口后两提交，2026-11-15）**：`e04391b` 审查收尾——跨 TTL 归一化回退死路径修复（前缀断言移入 else 分支）+ 转发器 error 监听与连接清理闭环（`forwarderSockets` 名册逐 socket 清理替代 `closeAllConnections`——该 API 是 `http.Server` 独有、`net.Server` 无）+ 清理失败经 `test.info().annotations` 留痕 + 三处计数补 `Number.isFinite` 判定；新 spec 两轮单跑 **4 / 4 全绿**，并意外获得一次全量 e2e 回归 **71 / 71**（12.5 分钟），收口数字不变。`65f8d72` 复核勘误——spec 头注释清理口径改回自动化兜底事实（`acc-` 前缀清扫由 `cleanupLeftoverSandboxes` 在 global-setup / global-teardown 自动执行）。复核结论：**通过**（Critical 已修复、Warning 2 替代实现经核实正确无泄漏、唯一注释勘误已修）。

## 二、门禁数字汇总（06 收口实测）

| 包 | 门禁 | 数字 | 基线对照 |
|---|---|---|---|
| 服务端（apps/web/backend） | pytest | **398 passed / 0 failed**（22.84s） | 348（文件传输轮收口）→ 02 轮 381（+33）→ 03 轮 398（+17） |
| 服务端 | ruff | **rc=0** | — |
| 核心包（apps/core） | pytest | **500 passed / 3 failed**（8m58s；一套用例覆盖 root + 非 root 两档，root 档经免密 sudo 实跑） | 01 收口 489 passed / 3 failed → 03 轮起 500 passed / 3 failed |
| 核心包 | ruff | **rc=0** | — |
| 前端（apps/web/frontend） | vitest | **953 passed / 0 failed**（52 文件，6.81s） | 05 轮基线 943 → +10（05 的 CacheImagesSection 套件） |
| 前端 | typecheck | 主 tsconfig **0 错** + tests tsconfig **0 错**（双零错） | — |
| 前端 | build | **成功**（chunk 体积 warning 为既有） | — |
| e2e（Playwright，真浏览器+真沙箱） | 全量 | **71 passed / 0 failed**（12.6 分钟） | 67 既有（文件窗格轮收口口径）+ 4 新增（`16-cache-images`） |

**核心包 3 例失败的甄别结论**：全部落在 `test_root_lifecycle.py`（busybox 经代理拉取上游 502 的环境故障），与 01 / 03 收口时**同一既有故障**，01 收口时已用 `git stash` 干净基线复跑证实与本轮改动无关；06 实测数字与该基线完全一致（500 / 3），无新增失败。

**e2e 首轮 1 例既有用例瞬时失败的甄别记录**（任务纪律：只跑该用例复跑 + 相关性判断，归因不得含糊）：

- 首轮全量（12.7 分钟）：70 passed + **1 failed**——`12-file-transfer.spec.ts:776`（「面包屑回根后根 crumb 变静态」），断言列目录响应计数 expected 2 / received 3（网络响应计数型断言在长跑后段的竞态）。
- **甄别一（隔离复跑）**：`playwright test "tests/specs/12-file-transfer.spec.ts:776"` 单跑 → **passed**（920ms）。
- **甄别二（全量复跑）**：整轮重跑 → **71 / 71 全绿**（12.6 分钟），含该用例。
- **相关性判断**：本轮改动 = 新增 spec 文件（纯测试代码，不触前端产品源码）+ 文档；spec 16 不触碰面包屑 / 文件窗格代码路径；该用例属文件窗格轮既有用例、本轮零改动。结论：**环境性瞬时失败（响应计数竞态），与本轮改动无关**。

## 三、真缓存实测与真机记录汇总

### 3.1 真缓存实测（01 轮，`/var/lib/sandbox-platform/registry-proxy/cache`）

- **规模**：140 文件 / 91 blob / **29 条镜像**（10 仓库：postgres、python、nginx、alpine、busybox、hello-world、socat、uv、curl、seaweedfs），清单合计 **630,373,638 字节**；1 条脏条目跳过。
- **前向公式抽样**：postgres `aa6cb33…`（OCI index）→ amd64 child `ac838714…` → **12 个 blob（config + 11 layers）`sudo test -f` 全命中**，`cache/<md5末1位>/<md5倒数第3-2位>/<32位md5>` 三级路径逐条核对；布局公式真机锚点 `f/d6/da797b74…`（rclone blob）命中并固化为单测回归锚。
- **总大小一致性**：postgres 条目 `total_size_bytes=116,101,621` 与链内各文件实际字节之和逐字节一致。
- **过期落榜边界（PRD 7）**：1h 分层的 `latest` / `alpine` / `16-alpine` 全部落榜、60d 版本式标签（`3.11-slim` 等）存活上榜——「只少一次优先提示，不会误导」实测钉住；26 条 digest 直拉条目标签列表为空（PRD 6 真机佐证）。
- **实测缺陷（已修复）**：python `b701198…` 条目 nginx 二进制头含 `0x7B` 字节，撞「取第一个 `{` 当 JSON 起点」启发式被误判；修复为逐 `{` 尝试 `raw_decode` + sha256 自洽兜底，复扫 skipped 4→1、images 27→29，修复回灌夹具级回归。

### 3.2 真机六项（03 轮，源码起后端临时实例，生产零接触，验证后已清理）

1. console 创建沙箱：`docker inspect` 两 env 在场且值正确（PRD 16 前半）；
2. 详情接口 env 只回用户声明键——两值不进 metadata（PRD 16 后半）；
3. 平台值优先：创建参数声明同名键取平台值、用户其他 env 原样保留（PRD 17）；
4. **探测兜底真实可达**：沙箱内 curl 后端 200、text 格式正常（PRD 18 兜底档，兼作 PRD 30 当前部署形态的实测依据）；
5. 自愈口径全链：CLI 创建缺 env ⇒ console「停止 → 启动」自愈 ⇒ CLI 直接 start 仍缺（PRD 19 两半都钉住）；
6. 令牌轮换：重写凭据文件旧令牌 401 / 新令牌 200（服务零重启）；沙箱重启后 `docker inspect` 两 env 为新值（PRD 20）。

### 3.3 真机三态（04 轮，临时后端绑 docker0 网桥地址 + 测试凭据文件，生产零接触，验证后已全清）

1. **① 正常**：清单原文 + 尾部引导语 + 退出 0（480ms）；注入死代理变量实证 `--noproxy` 生效（PRD 23）；
2. **② 缺凭据**：全缺 / 仅缺 token / 空串三变体 ⇒ 中文提示（stderr）+ 退出 2（PRD 24）；
3. **③ 不可达 / 超时 / HTTP 错误**：拒连退出 3（842ms）、假端点超时封顶退出 3（10470ms ≈ max-time 10s）、401 降级退出 3（406ms）（PRD 25）。

### 3.4 端到端（06 轮 e2e，真浏览器 + 真沙箱 + 真缓存）

- **端到端（PRD 21）**：console 抽屉创建**新建** `base:0.4.0` 沙箱 → 网页终端读出注入 env（URL 为宿主 LAN IP + 实际端口探测兜底形态、令牌 `sbxr_` 前缀）→ 容器内 `cached-images` stdout/stderr 落文件、经文件通道取回全量字节 → 与端点 `?format=text` **逐字一致**（同数据源；跨 60 秒 TTL 时归一化「生成时间」行后比对条目区）、退出码 0、stderr 空、屏幕表头可见旁证；
- **端点两格式（PRD 9/10）**：json 字段齐全 + 缺省同格式 + text 表头/尾注两则 + json/text 同一 `generated_at`；
- **端点负例（PRD 8/11）**：无凭据 401（`WWW-Authenticate: Bearer`）、错误令牌 401（与无凭据逐字节同一响应）、非法 format 422（固定文案原文）；
- **console 视图冒烟（PRD 27/28）**：真实端点数据态字段渲染 + 手动刷新数据仍在。
- **部署形态说明**：验收后端按既有 setup 绑 `127.0.0.1`，spec 内起一条 TCP 转发器（绑注入地址、逐字节透传回环真后端）补网络可达性——不改被测服务的绑定与代码，端点数据仍出自同一服务进程（同一份 TTL 缓存）；转发器带**回环自保护断言**（注入地址为回环时直接抛错），正是 PRD 30「绑回环时沙箱侧失效」的 e2e 推演依据（生产绑 `0.0.0.0` 形态不需要它）。

## 四、已知边界与留白

### 4.1 两条运维留白（**非 PRD 验收项，必须留档，由用户执行**）

1. **生产服务仍跑旧代码**：生产控制台服务（systemd 单元，监听 `0.0.0.0:28642`）仍运行本轮之前的代码——新端点 `GET /api/proxy/cache/images`、受限令牌凭据文件与双凭据鉴权、env 注入管线（`SANDBOX_IMAGE_CACHE_URL` / `SANDBOX_IMAGE_CACHE_TOKEN`）都要**按既有部署流程更新代码并重启服务后**才在生产生效。本轮全程零接触生产服务（06 收口复核：28642 监听进程 PID 未变），**更新与重启由用户执行**，本轮不代劳。
2. **存量沙箱需重建**：`base:0.4.0` 之前创建的存量沙箱不带 `cached-images` 命令、也没有新的注入 env（基础镜像随沙箱创建时固化，平台不自动迁移）——**需将存量沙箱重建至 `base:0.4.0` 后**才有完整能力（重建操作见 `base-image/README.md` 存量沙箱口径）。**重建由用户执行**，本轮不代劳；未重建的存量沙箱内执行 `cached-images` 得到「命令不存在」，属预期行为，不是缺陷。

### 4.2 已接受边界（PRD 内已拍板，此处汇总指针）

- **部署绑回环时沙箱侧失效**：cached-images 走降级提示（退出码 3）、console 视图不受影响——`API.md` 第 17.4 节写明，PRD 30 按三档证据核销；
- **manifest 有效期短**（10m / 1h / 60d 分层）：过期条目落榜——只少一次优先提示、不会误导（01 轮实测钉住，PRD 7）；
- **CLI 边角**：CLI 创建 / CLI 直接 start 不传注入参数 ⇒ 沙箱缺这对 env（行为与现状一致，非缺陷）；console「停止 → 启动」一次自愈（03 真机全链钉住，`API.md` 17.4 写明）；
- **同镜像两行**：index 条目 + 平台 manifest 条目并存（digest 不同、blob 共享）——text 尾注写明不可把链大小求和当缓存占用（01 审查裁决，02 落进渲染尾注，`API.md` 17.1 同步）；
- **受限令牌凭据文件每请求重读的 stat + chmod 副作用**：权限可能漂移、chmod 持续失败时未认证探测流量可放大 WARNING 日志——02 审查判非阻断，登记备查（沿 02 / 03 遗留登记，收敛应统一在 `read_token_file`）。

### 4.3 单测定性档说明（未在真机 e2e 覆盖、已如实注记的条目）

- PRD 12 的受限令牌越界半边（其余路径 / 非 GET / 换票据 401）——单测（e2e 只钉完整令牌 / 无凭据 / 错令牌三形态）；
- PRD 15 的 503 失败语义（故障注入形态）——单测；
- PRD 28 的空态（本机真缓存非空，空态无法真机呈现）——单测；
- PRD 18 的配置优先档与皆不可得跳过档——单测（真机只验探测兜底档，03 完成标准已如实注记）。

## 五、硬约束六条复核（全轮，06 收口复核）

| # | 禁令 | 结论 | 证据指针 |
|---|---|---|---|
| 1 | **禁 bash 解析 JSON** | ✅ 成立 | 02 提供 text 预渲染格式（`routes/proxy.py` + `cache_images.py` 的 text 渲染器）；04 的 `cached-images` 只拉 `?format=text` 原样输出、一个字节都不解析（`base-image/cached-images` 头注释与实现，零 json 处理代码）；e2e 端到端验的正是 text 直出链路 |
| 2 | **禁 jq 依赖** | ✅ 成立 | `base-image/Dockerfile` 不装 jq；`verify.sh` 第 2 节「镜像内无 jq」负向判定 + 第 11.3 节 `grep -cE '(^|[|;&]) *(jq|python3?|node|perl|ruby)( |$)' /usr/local/bin/cached-images` 静态断言 0 命中（verify.sh 61 项全过内）；`cached-images` 全文无 jq 调用 |
| 3 | **禁 `docker images` 劫持** | ✅ 成立 | 本轮全部新代码文件（`cache_manifest.py` / `cache_images.py` / `routes/proxy.py` / `injection.py` / `cached-images`）grep `docker images` 零命中；核心包镜像枚举能力未做任何封装或改写 |
| 4 | **禁代理层透明改写** | ✅ 成立 | 本轮零改动代理层（`proxy.py` 与 infra 代理配置在本轮提交链零 diff）；grep `rewrite|transparent` 在缓存清单相关模块零命中；拉取语义保持「拉什么得什么」 |
| 5 | **无 GC 入口** | ✅ 成立 | 缓存三模块（`cache_manifest.py` / `cache_images.py` / `routes/proxy.py`）grep `def .*(gc|prune|garbage|clean_?up|delete)` 零命中；端点只读；`README.md`「缓存只增不减、不提供清理代理缓存的接口」口径未动；GC 仅在 PRD / 任务集 / TODO 关联提及（共享 01 扫描底座，将来复用） |
| 6 | **CLI 零改动** | ✅ 成立 | `git diff 5e9f9bc~1..HEAD -- apps/cli` 为空（01~06 全部提交对 `apps/cli` 零改动）；CLI 创建缺 env 属已知边角（行为与现状一致，非缺陷，见 4.2） |

## 六、全轮核销结论

- PRD 验收 **32 / 32** 逐条核销挂证据（验收标准节 checkbox 全勾，每条标注证据档位）；
- 任务集 01~06 全部 done（各任务文件 frontmatter + 进展节 + 看板同步）；
- 门禁数字见第二节；真机证据见第三节；两条运维留白见 4.1（用户执行）；
- 文档落位：`API.md` 第 17 章、根 `README.md` 设置接口段、`base-image/README.md`、`docs/glossary.md`（「受限令牌」「缓存镜像清单」词条）、`docs/current-state.md`、两份清单（`docs/prds/README.md` / `docs/tasks/README.md`）。
