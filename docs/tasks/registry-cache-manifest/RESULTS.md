# 镜像缓存清单与缓存优先拉取引导：全轮收口留档（01~06）

> **2026-11-15 全轮收口**：6 个任务全部 done，PRD 验收 **32 / 32** 逐条核销（证据分真机 e2e / 单测 / 真机记录与实测三档，逐条注记见 [[prds/registry-cache-manifest.md|PRD]] 验收标准节），e2e 全量 **71 / 71**。本文是该轮的总留档：轮次总表、门禁数字、真缓存实测与真机记录汇总、已知边界与留白、硬约束复核，以及**收口后小增强（tags=only 与表格化输出，见第七节）与收口后输出清理小轮（cached-images 输出清理，`base:0.4.2`，见第八节）**、**方案 C 与 180d 轮（清单口径「拉过即上榜」+ 有效期统一 180 天，见第九节）**、**收口后 console 视图改版小轮（设置抽屉三 tabs + 清单表格化 + 本地搜索，见第十节）**。

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

### 4.1 运维留白与部署后状态（**非 PRD 验收项，必须留档**）

1. **生产服务仍跑旧代码**：生产控制台服务（systemd 单元，监听 `0.0.0.0:28642`）仍运行本轮之前的代码——新端点 `GET /api/proxy/cache/images`、受限令牌凭据文件与双凭据鉴权、env 注入管线（`SANDBOX_IMAGE_CACHE_URL` / `SANDBOX_IMAGE_CACHE_TOKEN`）都要**按既有部署流程更新代码并重启服务后**才在生产生效。本轮全程零接触生产服务（06 收口复核：28642 监听进程 PID 未变），**更新与重启由用户执行**，本轮不代劳。——**已消除（2026-11-15 10:59 UTC 生产部署完成）**：22 提交已 push `origin/main`（`b229669..ce95adf`），快照 `/opt/sandbox-platform` 已 rsync 两个运行时包（core/sandbox_platform + backend/sandbox_console）并重启服务（旧 PID 3511625 → 新 PID 2808367；启动清扫：遗留终端会话 3 条清理、遗留转发 0 条）；生产验证矩阵 **10 / 10** 全过——新端点无凭据 401、完整令牌 json 200（真缓存 29 条 / total 140 / blob 91 / skipped 1）、text 200、受限令牌该读径 200 而其余路径与非 GET 401、health 200、回归 `/api/sandboxes` 与 `/api/proxy/status` 200。**收口后小增强二次部署（2026-11-15 14:34:38 UTC）**：tags=only 与表格化输出 5 提交已 push（`a913177..cafa694`）→ 快照 rsync → 服务再次重启（现运行 PID **3231614**；10:59 与 14:34 两次重启均在档）→ 生产验证 **8 / 8** 全过（无凭据 401、json 缺省 29 条、json tags=only 3 条、text 表格 6 行、缺省 text 零改动、tags=abc 422、受限令牌 tags=only 200、回归 200）——生产现运行版本**含 tags=only 与表格化输出**（详见第七节）。**前端 Cloudflare（`dev.sankabox.com`）暂不发布——用户决策**：生产控制台暂看不到新「缓存镜像清单」视图，待用户择机 `wrangler deploy`（本轮未碰 wrangler / terraform）。
2. **存量沙箱需重建**：`base:0.4.0` 之前创建的存量沙箱不带 `cached-images` 命令、也没有新的注入 env（基础镜像随沙箱创建时固化，平台不自动迁移）——**需将存量沙箱重建至 `base:0.4.0` 后**才有完整能力（重建操作见 `base-image/README.md` 存量沙箱口径）。**重建由用户执行**，本轮不代劳；未重建的存量沙箱内执行 `cached-images` 得到「命令不存在」，属预期行为，不是缺陷。另：**新建沙箱需显式指定 `base:0.4.0`**，缺省镜像仍落旧版、同样无该能力。（镜像其后随收口后两小轮 bump：`0.4.1` 增强、**`0.4.2`** 输出清理——新建 / 重建要拿最新能力与输出应显式指定 **`base:0.4.2`**，见第七、八节。）

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
- 门禁数字见第二节；真机证据见第三节；4.1 现状：生产部署已落地（2026-11-15，push `b229669..ce95adf`、服务更新重启、验证矩阵 10 / 10），前端暂不发布为用户决策，仅剩存量沙箱重建 qilu 待用户执行；
- 文档落位：`API.md` 第 17 章、根 `README.md` 设置接口段、`base-image/README.md`、`docs/glossary.md`（「受限令牌」「缓存镜像清单」词条）、`docs/current-state.md`、两份清单（`docs/prds/README.md` / `docs/tasks/README.md`）。

## 七、收口后小增强（2026-11-15）：tags=only 与表格化输出

> 全轮收口后用户拍板的增强：端点新增 `?tags=only` 过滤（json / text 双格式、非法值 422、缺省零改动）+ tags=only 时 text 渲染 **docker images 风格表格**（IMAGE repo:tag 多标签展开行 / ID digest 前 12 位 / SIZE 十进制 B/kB/MB/GB / CACHED TIME `YYYY-MM-DD HH:mm:ss UTC`，轻表头含清单生成时间，表尾 SIZE 防误读尾注）+ `cached-images` 消费 tags=only、`--help` 定稿文本替换、退出码 0 / 2 / 3 不变 + 基础镜像 bump **`base:0.4.0 → 0.4.1`**（宿主已重建）。PRD 头部修订行与「验收标准」D 组注记见 [[prds/registry-cache-manifest.md|PRD]]。

- **提交链（4 个）**：`5bcada8`（服务端 tags=only + 表格渲染 + 36 用例）→ `d6af3c3`（cached-images 表格化 / 新帮助 + `0.4.1` bump + verify 更新 + 真机三态）→ `23c87a0`（e2e 同步 + `API.md` / `README` 同步）→ `aa29b23`（审查收尾：SIZE 满千升单元 + 测试名实相符 + spec 注释勘误）。**以上提交已随生产部署 push（`a913177..cafa694`，区间 5 提交，2026-11-15 14:34:38 UTC 落生产，见下「部署状态」）。**
- **reviewer 结论**：通过（无 Critical / Warning；三条 Suggestion 已随 `aa29b23` 收拾）。
- **门禁数字**：后端 pytest **436 passed / 0 failed**（基线 398 → 436）+ ruff rc=0；`verify.sh` **64 项全过**（61 → 64）；e2e 全量 **71 / 71**（真沙箱，12.4 分钟）；前端 vitest **953 passed / 0 failed**、typecheck:tests **0 错**。
- **真机三态**：随 `d6af3c3` 实测全过（正常 / 缺凭据 / 不可达），退出码 0 / 2 / 3 语义不变。
- **部署状态**：**已部署生产（2026-11-15 14:34:38 UTC）**——push（`a913177..cafa694`）→ 快照 rsync → 服务重启（PID → **3231614**）→ 生产验证 **8 / 8** 全过（无凭据 401、json 缺省 29 条、json tags=only 3 条、text 表格 6 行、缺省 text 零改动、tags=abc 422、受限令牌 tags=only 200、回归 200）；存量沙箱重建口径随增强从 `base:0.4.0` 改 `base:0.4.1`（其后输出清理小轮再 bump **`base:0.4.2`**，见第八节）。
- **运维事故（如实留档）**：真机验证清理时 worker 误用宽匹配 `pkill -f` 误杀生产服务（2026-11-15 13:31:35–13:49:39 中断约 18 分钟），已用原部署版本恢复并复核（服务 active、端点行为正常）。**教训登记：清理进程禁用宽匹配 `pkill -f`**。

## 八、收口后小轮（2026-11-15）：cached-images 输出清理（base:0.4.2）

> tags=only 增强落生产后（见第七节），用户拍板「**只保留表格本体**」的输出清理小轮：**服务端**——tags=only 表格去掉轻表头与表尾 SIZE 防误读尾注（仅保留表格本体）、空清单仅列头行；**脚本**——`cached-images` 正常态去掉尾部「提示：…」追加（**引导约定仅 `--help` 承载**）；**缺省 text 零改动**（无 tags=only 的输出形态不变）。基础镜像 bump **`base:0.4.1 → 0.4.2`**（宿主已重建，`verify.sh` 65 项全过）。PRD 头部修订行与「验收标准」D 组注记已同步（见 [[prds/registry-cache-manifest.md|PRD]]）。

- **提交链（4 个，未 push）**：`c49fcae` / `bcc2b9f` / `f9b526f` / `86efc1a`；base-image/RESULTS 已单独补节（镜像与命令侧明细）。
- **门禁**：后端 pytest **436 passed / 0 failed**（与第七节持平）+ ruff rc=0；`verify.sh` **65 项全过**（64 → 65）；e2e 全量 **71 / 71**；前端 vitest **953 passed / 0 failed**。
- **真机三态与跨 TTL 实测**：随本轮全过——正常态输出即「仅表格本体」新形态、缺凭据 / 不可达退出码 0 / 2 / 3 语义不变；端到端跨 60 秒 TTL 比对按新输出形态归一（明细见 base-image/RESULTS 补节）。
- **部署状态**：**未部署生产、未 push（本地领先 4 提交）**——生产现仍跑第七节版本（tags=only 含轻表头与 SIZE 尾注形态）；**沙箱侧要用上新输出需重建至 `base:0.4.2`**（新建沙箱同样需显式指定 `base:0.4.2`；存量重建 qilu 维持暂停、待用户拍板）。——**push 状态其后更新（2026-11-16）：该 4 提交已随方案 C 轮的 push 上 origin（见第九节），生产仍未部署本小轮输出**。
- **运维备注（如实留档）**：本轮真机验证时曾在生产缓存挂载路径误加一层 bind mount，当场已按原样复原，并经三视角复核（`findmnt` / `mount` / `mountinfo` 单条自 bind、140 文件对账）；另有上轮登记的 pkill 教训（见第七节运维事故）。

## 九、方案 C 与 180d 轮（2026-11-15）：拉过即上榜

> 用户拍板的口径修订轮：**清单口径改为「拉过就算」**（manifest 在缓存即上榜，废除 blob 完整性拦截）+ **有效期统一 180 天**（manifest 三层 + 代理回收约束）。本节是这一轮的留档：口径、提交链、门禁、生产部署验证、待拍板项与登记待办。PRD 侧的修订行与 A 组逐条注记见 [[prds/registry-cache-manifest.md|PRD]] 文首与「验收标准」A 组。

### 9.1 口径（方案 C，用户拍板 2026-11-15）

| # | 口径 | 落地形态 |
|---|---|---|
| 1 | **清单口径 = 拉过就算** | **manifest 条目在缓存即上榜**（tag 键与 digest 键同权重）；**废除「全部声明 blob 都在缓存」的完整性拦截**——**取代 PRD 原「已完整缓存」保守口径**（原验收 A 组 1 / 2 / 3 / 7 的落榜类判据由本轮取代，5 的总大小语义变更） |
| 2 | **SIZE = 声明链字节** | manifest 文档声明的 config + layers 字节和（多架构 index 另加 index 声明的 amd64 子 manifest 文档字节；子文档在缓存时再合并它声明的 config + layers），**不依赖 blob 在场**；text 尾注补第二句「SIZE 可能是部分值——子 manifest 不在缓存或不可信时仅含已可计算部分，可能偏小」 |
| 3 | **有效期统一 180 天** | manifest 三层 PRIMARY / SECONDARY / DEFAULT 全 **180d**（代理启动 env 显式钉，此前 10m / 60d / 1h）；代理回收约束 `CACHE_INACTIVE` 同步 **180d**（旋钮在代理 `entrypoint.sh:106`，此前平台未传、走默认 60d）；**blob 层 60d 写死在代理镜像 `nginx.conf`、无 env 旋钮——登记遗留**（方案 C 起 blob 不再参与落榜判定） |
| 4 | **保留的纪律** | 不可解析文件跳过；digest 键体哈希与键不符跳过——**自洽校验放宽为双口径**：接受 `sha256(纯 JSON)` 或 `sha256(JSON + 仅空白尾随)`（修复 busybox amd64 子文档尾随换行误判：SIZE 610 → 2,212,583）；tag 键过期**只丢标签绑定、条目仍落榜**（同 digest 的其余记录存活时），整组过期才落榜 |
| 5 | **代理容器 env 漂移即重建** | 核心包新增 env 对账：**探测失败视为一致但打 warning**；`REGISTRIES` 按**集合**比较（书写顺序不同不算漂移）；**删除失败上抛不静默**（否则「看起来一致」会把 env 漂移静默吞掉） |

### 9.2 提交链（4 个，均已 push）

1. `e91c69d` —— 方案 C + 180d 主实现；
2. `fea0694` —— `API.md` + `README` 同步；
3. `b84fb46` —— 审查修复（C1 / W1 / W2 / W3 / W5 / W6 / W7 / `CACHE_INACTIVE` / S1）；
4. `c84d163` —— 措辞收口。

### 9.3 门禁数字

| 包 | 门禁 | 数字 |
|---|---|---|
| 核心包（apps/core） | pytest | **505 passed / 3 failed**（3 例为既有 `test_root_lifecycle` 环境故障）+ root 档单跑 **20 / 3** |
| 核心包 | ruff | **rc=0** |
| 服务端（apps/web/backend） | pytest | **438 passed / 0 failed** |
| 前端（apps/web/frontend） | vitest | **953 passed / 0 failed** |
| e2e（Playwright，真浏览器 + 真沙箱） | 全量 | **71 / 71 passed** |

### 9.4 生产部署与验证（**已部署生产**）

- **清单条数**：**29 → 36 → 37 条**（口径放宽 + busybox 修复两段增量）。
- **tags=only 12 行**：含此前缺失的 `alpine:latest`、`seaweedfs:3.80`、`busybox:1.37`、`curl:latest`、`postgres:16-alpine`、`rclone` 等。
- **busybox 修复前后对比**：amd64 子 manifest 缓存体 = JSON 609 字节 + 尾随 `\n` = 610 字节，上游摘要覆盖**整段 610 字节**；旧口径只哈希 JSON 段（609B）→ 自洽失败 → 子文档被判脏 → `busybox:1.37` 的 SIZE 只剩 index 声明的 **610 字节**；**双口径自洽校验**（`sha256(纯 JSON)` 或 `sha256(JSON + 仅空白尾随)`）生效后 SIZE = **2,212,583 字节**（真值）。
- **skipped**：**1 → 0**（脏条目全部消除）。

### 9.5 待拍板项（已拍板，2026-11-16）

- **e2e 验收后端与生产共用同一代理容器**：env 漂移时 e2e 可触发**生产代理容器删除重建**（本轮**已实证发生**一次；CA 因绑定挂载持久化未变）。候选护栏：**e2e 只读观察模式 / e2e 独立代理实例**。——**已拍板（2026-11-16，用户）：维持现状、不设护栏**，共用形态可接受，候选项不再推进。

### 9.6 登记待办（不阻断）

| 项 | 内容 |
|---|---|
| **blob 60d 写死镜像模板** | blob 层有效期 60d 写死在代理镜像 `nginx.conf`（`proxy_cache_valid 200 206 60d`，**无 env 旋钮**），平台管不到；要真正统一 180d 须改镜像模板 |
| W8 | lint 词级禁令收窄 |
| W9 | e2e 首行钉脆化 |
| S2 | 死常量注记 |
| S3 | 锁内多次 inspect 合并 |
| S5 | inactive 生效说明 |

## 十、收口后小轮（2026-11-16）：console 视图改版——设置抽屉三 tabs + 清单表格化 + 本地搜索

> 输出清理与方案 C 两轮之后用户拍板的第三轮小改（**纯前端，后端与 API 契约零改动**）：① 设置抽屉由四个纵向 section 拆成**三个 tabs**——**代理**（含缓存镜像清单，**默认激活**）/ **模板** / **后端配置**（连接配置）；② 缓存镜像清单**对齐沙箱内 `cached-images` 命令口径**——数据改拉 `GET /api/proxy/cache/images?format=json&tags=only`（只展示有 tag 的镜像），**表格化**：IMAGE（repo:tag，多标签展开行，按 (repo, tag) 排序）/ ID（digest 去 `sha256:` 前缀取前 12 位，`title` 保留完整 digest）/ SIZE（十进制 1000 进制）/ CACHED TIME（UTC `YYYY-MM-DD HH:mm:ss`），「清单生成时间」脚注保留（改 UTC 口径）；③ **本地搜索过滤**——大小写不敏感子串匹配 repo:tag，命中 digest 整组显示，「清单为空」与「搜索无命中」两种空态；④ **代理 tab 布局**——顶部状态区有界自滚（`max-h-[70vh] overflow-y-auto`，矮视口下重启结果可达）、下方清单撑满剩余空间、表格内部滚动 + 表头吸顶（`border-separate`）。稳定口径已沉淀 [[conventions/console-frontend.md|控制台前端约定]]。

- **提交链（3 个 + 用户样式微调 `91d878c`，均已 push）**：`cadac74`（feat 主实现）→ `2216de6`（e2e helper/spec 同步三个 tab 与清单表格 + 前端 README 标识表）→ `7d6be6b`（审查修复：代理区矮视口自滚 + 抽屉滚动显式开关 + 表头吸顶与短摘要口径）。
- **关键实现决策**：
  - **tabs 封装**：新增 `src/components/ui/tabs.tsx`（Base UI Tabs 原语封装），**Panel keepMounted**——打开抽屉即全量加载、切 tab 不发请求；
  - **滚动责任显式开关**：`DrawerShell` 新增 `scrollable` prop（缺省 `true`，既有三个抽屉零行为变化）与 `contentClassName`（只追加不替换）；设置抽屉显式 `scrollable={false}`，滚动责任交给 tab 面板；
  - **纯函数对齐口径**：新增 `src/lib/cache-images.ts`——`formatSizeDecimal` 与服务端 Python 实现逐值对拍 **4025 个值 0 分歧**（BigInt 中点取偶）、`formatCachedTimeUtc`（UTC）、`shortImageId` 与服务端逐字同语义、`expandImageRows`（多标签展开行）、`filterImageRows`（本地过滤）；api 客户端新增 `cacheImages(options?: { tagsOnly?: boolean })`；
  - **标识换代**：新增 `page-settings-tabs` / `page-settings-tab-proxy|templates|backend` / `page-settings-cache-images-search-input|table|scroll|row|image|id|size|time|head|search-empty` / `page-settings-proxy-section`；旧单数 `page-settings-cache-image-*` 系列退役（登记与退役清单见前端 `apps/web/frontend/README.md` 标识表）。
- **审查两轮**：首轮审出 **1 Critical**（矮视口下重启结果被裁不可达——顶部区改有界自滚修复）+ **4 Warning** + 5 建议 → 随 `7d6be6b` 修复；复审**七个修复项全过**、结论「可合并」——两条非阻塞观察：e2e digest 正则隐含小写可加注释、`toContain('max-h-')` 弱断言。
- **门禁数字**：前端 vitest **53 文件 / 992 用例全绿**（基线 953）+ typecheck 双零错 + build 成功；字体子集重跑（charset 补进 `≡ 铌 锢` 三字符）；e2e 全量 **71 / 71**（真沙箱，12.6 分钟）；后端 / 核心包零改动。
- **已知差异（登记不修）**：`cached_at` 不可解析时前端「—」占位、服务端回原文——前端口径优先。
- **部署状态**：**已 push（3 提交 + 用户样式微调 `91d878c`）**，纯前端改动不涉生产服务；**前端已发布 Cloudflare（2026-11-16，用户在他机执行并实测通过——本机出口网络当时无法连 CF）**，生产控制台（`dev.sankabox.com`）现为三 tabs 新形态，桌面（Tauri）形态用户已实测。
- **拍板记录（2026-11-16）**：① **「存量沙箱重建 qilu」条目撤销**——不再重建、沙箱保持现状（第八节括注的该待办就此关闭）；② **e2e 与生产共用同一代理容器维持现状、不设护栏**（见 9.5）。
