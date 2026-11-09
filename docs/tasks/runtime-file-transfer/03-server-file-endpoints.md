---
prd: prds/runtime-file-transfer.md
status: done
---
# 任务：服务端文件传输接口（三端点）

> 需求见 [[prds/runtime-file-transfer.md|运行期文件传输 PRD]]。**依赖 02 的核心包能力**。
>
> **本轮含三条实测得来的硬要求**（2026-11-09）：① **请求体必须 raw 流式**（禁 JSON body）；② **Traefik 读超时落地**（本机部署链是本平台自管的基础设施，属本轮落地范围；**落地方式经实测勘误为入口点级**，见下「部署链落地」）；③ **上传字节数核对**（客户端中断的上传不得把半截文件落在目标路径上——**核心包回修 + 服务端消费侧计数兜底**两道保险）。依据见 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]]。

## 目标

把核心包的传输能力包成服务端接口：**三个 REST 端点**，全部挂在 `/api/sandboxes/{name}/files/` 下。服务端只做编排与转译，能力本体在核心包。

## 涉及文件

- 新增 `apps/web/backend/src/sandbox_console/routes/files.py` — 三个端点
- 新增或改 `apps/web/backend/src/sandbox_console/transfers.py` — **流式装配**（`TRANSFER_IO_EXECUTOR` 专用线程池、断开清理）
- 改 `apps/web/backend/src/sandbox_console/routes/__init__.py` — 注册路由
- 改 `apps/web/backend/src/sandbox_console/app.py` — lifespan 装配传输管理器（如需）
- 改 `apps/web/backend/src/sandbox_console/errors.py` — **错误文案表**（固定中文）
- 改 `apps/web/backend/src/sandbox_console/schemas.py` — 请求 / 响应模型
- 改 `apps/core/src/sandbox_platform/transfer.py` — **本轮回修**：上传脚本的**期望字节数核对**（`mv` 之前）+ 新分类码 `size_mismatch` / `invalid_size`
- 改 `apps/core/src/sandbox_platform/__init__.py` — 四个新分类码 + `MSG_SIZE_MISMATCH` **进包导出**
- 改 `apps/core/tests/test_transfer.py` — 回修的用例（**93 → 101 项**）
- 新增 `apps/web/backend/tests/test_server_files.py` — 用例（**38 个测试函数 / 42 项**，其中 1 个 5 路参数化）
- 改 `apps/web/backend/API.md` — **新章节**（路由表 / 字段 / 错误码映射 / 认证口径；**章节号按 API.md 实际结构定**）
- 改 **Traefik 配置**（**不在本仓库内**，在 `sankabox-infrastructure` 仓库）— 调高读超时（本平台自管的基础设施，属本轮落地范围）。**实际落点与任务书原写法不同**：Traefik v3 无 service 级 `serversTransport.respondingTimeouts` ⇒ 改为**入口点级** `entryPoints.websecure.transport.respondingTimeouts.readTimeout=0`（**`7640HS/traefik/docker-compose.yaml` 的命令行**；见下「部署链落地」与 ADR 0018 §6）

## 接口契约

| 方法与路径 | 入参 | 出参 | 要点 |
|---|---|---|---|
| `POST /api/sandboxes/{name}/files/upload?path=<容器内绝对路径>` | **raw body**（`application/octet-stream`，**无 multipart**、**流式读**） | `{path, bytes}` | 覆盖语义；父目录缺失报错；**目标是已存在目录 → 前置拒绝** |
| `GET /api/sandboxes/{name}/files/download?path=<...>` | 查询参数 `path` | `StreamingResponse` | `Content-Length`（探到时）+ `Content-Disposition: attachment`（`filename*` UTF-8 + ASCII 回退）；**前置分层探测**，只放行普通文件 |
| `GET /api/sandboxes/{name}/files/list?path=<目录>` | 查询参数 `path` | 条目列表 | 名称 / 类型 / 大小 / 修改时间；**隐藏文件包含** |

## 服务端口径

- **流式**：上传是 raw body 流、下载是 `StreamingResponse`；**全程不整文件进内存**。
- **上传端点必须 raw 流式读 body**（`request.stream()` 逐块消费），**不得用 JSON 模型 / pydantic 接 body**——实测 FastAPI 的 JSON body 会被**整体缓冲进内存**（200 MiB body ⇒ 控制台进程 RSS **44.5 → 433.9 MiB**），「内存有界」将只在字节泵层成立、端到端不成立。
- **专用线程池**：字节搬运走 `TRANSFER_IO_EXECUTOR`（对齐转发轮的 `PUMP_IO_EXECUTOR` 惯例），**不进事件循环**。
- **客户端断开** → 关泵 + 清容器内临时文件。
- **期望字节数（`Content-Length`）接线**：请求头 `Content-Length` ⇒ **期望字节数**（传给核心包 `upload(..., expected_bytes=...)`，容器内 `mv` **之前**核对实际字节数）；**头缺失**（chunked）⇒ `None`（**跳过核对**，残余风险见「两条发现」第 1 条）；**头非法**（非数字 / 负数 / 空串 / 超 20 位十进制）⇒ **400**、**不静默降级**成「没有期望值」。
- **错误文案**：固定中文，形状 `{"detail": "<中文>"}`；**容器内 stderr 原文只进日志**；**错误分类只按 stderr 关键词子串**（不按整句、不按退出码）。
- **错误分类码的取用路径（03 轮已落地）**：四个新分类码——`REASON_DAEMON_UNREACHABLE`（**宿主侧**失败：守护进程不可达）、`REASON_TEMP_NAME_EXISTS`（上传**临时名撞名**）、`REASON_SIZE_MISMATCH`（**字节数不符**）、`REASON_INVALID_SIZE`（**期望值非法**）——**已全部进包导出**（`sandbox_platform/__init__.py`），服务端**从包根 `sandbox_platform` import**；「模块内直引」这一**例外已不存在**。状态码映射见 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]] 第 8 节（守护进程不可达 → **502**；撞名 → **409**；字节数不符 / 期望值非法 → **400**），**关键词匹配顺序即优先级**（宿主侧关键词必须排在 `permission denied` 之前；平台自打标记 `size mismatch` 排在容器内关键词**最前**）。
- **鉴权**：端点挂在 `/api` 下即被**令牌中间件自动保护**，不另写鉴权分支。
- **不新增 WebSocket**；只用 GET / POST → **CORS 白名单零改动**。

## 部署链落地：Traefik 读超时覆盖（本轮范围）

- **背景（01 轮实测）**：本机 Traefik **v3.7.13** 反代 `sandbox-api.sankabox.com` → `http://192.168.2.135:28642`，该 service **无 `transport` 块** ⇒ **全部走默认值**（`respondingTimeouts.readTimeout = 1m0s`）。实测同一 200 MiB 慢上传：**直连控制台 201.23 s 成功**，**经反代 61.13 s 被掐断**（`ConnectionResetError`）——掐断的是反代读超时，不是后端，也不是大小上限（反代与后端都**无 body 上限**、不会 413）。
- **本轮动作（任务书原写法）**：为 `sandbox-api-service` 加 `transport.respondingTimeouts.readTimeout`（**`0` 或显式大值**，如 `10m`），必要时同步调 `idleTimeout`；`writeTimeout` 无需动。**只改这一个 service 的转发超时，不动后端、不动其他路由。**
- **落地结果（03 轮实测勘误 ⇒ 入口点级覆盖）**：**Traefik v3 没有 service 级 `serversTransport.respondingTimeouts`**（按 service 级写法落配置会被反代**直接拒收**）⇒ 实际落地改为 **`entryPoints.websecure.transport.respondingTimeouts.readTimeout=0`**（**静态**配置项），**`:80` / `:8080` 两个入口点与其它 service / router 一概不动**；`idleTimeout`（180s）与 `writeTimeout` 不动。**A/B 实测**：改前同一请求 **60.53 s 被 502 掐断**（只传上去 190,316,544 / 262,144,000 字节），改后 **83.13 s 200 成功**且 sha256 一致。infra 仓库提交 **`529ac29`**。**勘误见 ADR 0018 §6**。
- **验证**：**经域名**（过 Traefik）做一次**慢速大上传**（限速使单次请求超过 60 s），确认不再被掐断。
- **归属**：本机部署链是**本平台自管的基础设施**（不在本仓库内，在 `sankabox-infrastructure` 仓库的 Traefik 动态配置目录），**属本轮落地范围**。
- **外推口径**：本机结论**不外推**——**远程部署必须自查反代**；这条口径写进 `API.md` 与部署说明。

## 完成标准

- [x] 三个端点行为符合契约；上传走 **raw body**（`application/octet-stream`，**无 multipart**），返回 `{path, bytes}` 且字节数与实际写入一致。
- [x] **上传端点 body 是 raw 流式读取**（`request.stream()` 逐块消费），**未使用 JSON 模型 / pydantic 接 body**；**有断言或测试证明进程内存不随 body 大小增长**（实测依据：JSON body 200 MiB ⇒ RSS 44.5 → 433.9 MiB）。
- [x] **目标已存在 = 覆盖**；上传是**原子替换**；失败时**临时文件被清理**（平台侧显式清，`cat` 不会自清）。
- [x] **目标是已存在目录 → 前置拒绝**（400 + 明确文案）；**目标文件自身只读（`0444`）不报错**（被覆盖）。
- [x] **父目录不自动创建**：缺失时报错并给出可行动的引导文案。
- [x] 下载**只允许普通文件**：**分层探测**可区分目录 / 普通文件 / FIFO·设备·套接字·其他特殊文件；目标是**目录 → 400** + 明确中文文案；**特殊文件 → 拒**（不挂起）。
- [x] **错误分类只按 stderr 关键词子串**（不按整句、不按退出码）；三类失败（父目录缺失 / 父目录不可写 / 只读挂载）各有固定中文文案；**临时名已换成用户目标路径**。
- [x] 下载响应带 `Content-Length`（探到时）与 `Content-Disposition: attachment`；**中文文件名正确**（`filename*` UTF-8 + ASCII 回退）。
- [x] 目录列表返回名称 / 类型 / 大小 / 修改时间；**隐藏文件包含**；**`find` 单次 exec 产出 NUL 分隔记录**；busybox 与 GNU 两种镜像下都正确；**含空格 / 中文 / 换行的名字**不乱。
- [x] **无 413**：大小不限；后端**全程流式、内存有界**。
- [x] **Traefik 读超时已落地（入口点级覆盖，只动 `websecure`）**：Traefik v3 **没有 service 级 `serversTransport.respondingTimeouts`**（按 service 级写会被反代**直接拒收**）⇒ 落地改为 `entryPoints.websecure.transport.respondingTimeouts.readTimeout=0`（**静态**配置项），**`:80` / `:8080` 与其它 service / router 一概不动**；**经域名**（过 Traefik）的一次**慢速大上传**（单次请求超 60 s）**不再被掐断**（**A/B 实测**：改前 60.53 s 被 502 掐断 → 改后 83.13 s 200 成功、sha256 一致）；**远程部署自查反代**的口径写进 `API.md` / 部署说明。**勘误见 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]] §6**。
- [x] 错误响应固定 `{"detail": "<中文>"}`；**容器内 stderr 原文只进日志**。
- [x] **客户端断开 → 关泵 + 清临时文件**；不留挂死进程与容器内残骸。
- [x] 字节搬运走 `TRANSFER_IO_EXECUTOR` **专用线程池**，**不进事件循环**。
- [x] **鉴权自动生效**：无令牌 / 错令牌 → 401（不另写鉴权分支）；**CORS 白名单零改动**。
- [x] `apps/web/backend/API.md` **新章节**：路由表、字段表、**错误码映射表**、**认证口径**、流式与大小不限的口径、**「大小不限但受反代读超时约束」的口径与远程部署自查反代的提示**（章节号按 API.md 实际结构定）。
- [x] 单测覆盖：401 / 404（沙箱不存在）/ **409（沙箱已停止）** / 400（目录下载、**目标为目录的上传**、非法路径、**父目录不可写**、**字节数不符**、**非法 `Content-Length`**）/ 下载响应头 / 字节一致 / 列表含隐藏文件 —— `apps/web/backend/tests/test_server_files.py` **42 项**（38 个测试函数，其中 1 个 5 路参数化）。
- [x] 门禁：服务端 **pytest 全绿**（**329 passed**）、**ruff 退出码 0**；**核心包本轮一并回修**（非 root **370 passed** / root **23 passed**）；分层契约测试红线不触发（能力本体在核心包）。
- [x] **命令行零改动**；**创建时注入通道零改动**；**CORS 配置零改动**。

## 依赖

- 依赖 [[tasks/runtime-file-transfer/02-core-transfer.md|02 核心包传输能力]]（**已于 2026-11-09 收口（done）**——落地结论、分类码清单与两处偏离见该文件文末「进展（2026-11-09）」）。
- 鉴权与 CORS 口径沿用 [[tasks/phase3-desktop/02-backend-token-and-cors.md|三期任务 02]]；流式装配可参考 [[tasks/phase3-desktop/05-port-forward-server-api.md|三期任务 05]]。
- 机制与口径依据：[[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018 运行期文件传输机制选型]]（第 5 节 raw 流式 body 的前提、第 6 节部署链约束）。

---

## 进展（2026-11-09）

> **本轮状态：done（实现 + 审查修复 + 真机验证完成）。** 三个端点、错误映射、schemas、
> 单测、`API.md` 新章节（第 16 章）、**核心包回修**（上传字节数核对）与**部署链
> Traefik 读超时落地（入口点级）**全部完成；审查一轮「需修复后合入」的 **7 项必修
> 全部完成**。
> **本仓库未 commit**（按本轮约定：等审查后统一提交）。

### 交付物

| 文件 | 改动 |
|---|---|
| `apps/web/backend/src/sandbox_console/routes/files.py` | **新建**：三个端点（上传 raw 流式 / 下载 `StreamingResponse` / 目录列表）+ `Content-Disposition` 构造（ASCII 回退 + `filename*=UTF-8''` 百分号编码） |
| `apps/web/backend/src/sandbox_console/transfers.py` | **新建**：传输 I/O **专用线程池**（`TRANSFER_IO_EXECUTOR`，32 线程）、**请求体桥接**（异步 body 流 ⇄ 同步字节块迭代器，**有界缓冲** ⇒ 端到端内存有界）、上传并发装配、**期望字节数取用**（`Content-Length` ⇒ 期望字节数；缺失 ⇒ `None`；非法 ⇒ 400）、**字节计数兜底改判**、下载流逐块读取与**按声明长度裁剪**、关泵丢进线程池 |
| `apps/web/backend/src/sandbox_console/errors.py` | 改：传输链路的**失败分类码 → 状态码**映射表（`TRANSFER_STATUS_BY_REASON`，含 `size_mismatch` / `invalid_size` ⇒ 400）+ `classify_transfer_error` + `TransferError` 异常处理器（**stderr 原文只进日志**）+ `single_line`（**日志单行化**） |
| `apps/web/backend/src/sandbox_console/schemas.py` | 改：`FileUploadResponse` / `FileListEntry`（`extra="forbid"`） |
| `apps/web/backend/src/sandbox_console/deps.py` | 改：`get_transfer_manager`（取生命周期服务持有的那一个，不另建实例） |
| `apps/web/backend/src/sandbox_console/app.py` | 改：lifespan 装配传输管理器 |
| `apps/web/backend/src/sandbox_console/routes/__init__.py` | 改：注册文件传输路由 |
| `apps/web/backend/tests/test_server_files.py` | **新建**：**42 项用例**（38 个测试函数，其中 1 个 5 路参数化；假 manager / 假下载流） |
| `apps/web/backend/API.md` | 改：**第 16 章**（路由表 / 字段 / 错误码映射 / 认证口径 / 流式与大小上限口径）+ 11.1 路由表补三行 |
| `apps/core/src/sandbox_platform/transfer.py` | **改（本轮回修）**：上传脚本加**期望字节数核对**（argv 直传 `"$3"`；`mv` **之前** `wc -c < 临时名` 比对，**不符即删临时名 + 打 `size mismatch` 标记 + 非零退出、不执行 `mv`**）；签名 `upload(..., expected_bytes: int \| None = None)`（`None` = 跳过核对）；新增分类码 `size_mismatch` / `invalid_size` 与固定中文文案 |
| `apps/core/src/sandbox_platform/__init__.py` | **改**：四个新分类码 + `MSG_SIZE_MISMATCH` **进包导出**（服务端从**包根**导入） |
| `apps/core/tests/test_transfer.py` | **改**：期望字节数透传 / 字节数不符归类与清临时名 / 非法期望值拒绝等用例（**93 → 101 项**） |
| `docs/architecture/decisions/0018-运行期文件传输机制选型.md` | 改：**第 6 节的 Traefik 配置项勘误** + **第 8 节分类表补两类** + **上传语义节补双保险口径**（见下「偏离」） |

**核心包本轮回修**（不是「未动」）：上传脚本在 `mv` **之前**核对**期望字节数**（argv 直传；不符即删临时名 + 打 `size mismatch` 标记 + 非零退出、**不执行 `mv`**），签名 `upload(..., expected_bytes: int | None = None)`（`None` = **跳过核对**）；新增分类码 `size_mismatch` / `invalid_size` 与固定中文文案。四个新分类码与 `MSG_SIZE_MISMATCH` **已进包导出**（`sandbox_platform/__init__.py`），服务端**从包根导入**——「模块内直引」这一**例外已不存在**。

### 失败分类码 → HTTP 状态码映射

| `TransferError.reason` | 状态码 | 响应 `detail` |
|---|---|---|
| `invalid_path` / `parent_missing` / `parent_not_directory` / `parent_not_writable` / `readonly` / `target_is_dir` / `not_regular` | **400** | 核心包固定中文文案（+ 用户自己给的容器内路径） |
| `size_mismatch` | **400** | 同上（固定文案「上传中断，目标文件未完整写入」）——**目标文件保持原样**（旧内容不被半截内容覆盖） |
| `invalid_size` | **400** | 同上（固定文案「期望字节数非法」）——服务端已在请求头处**前置拦截**（非数字 / 负数 / 空串 / 超 20 位十进制） |
| `not_found` | **404** | 同上 |
| `sandbox_stopped` | **409** | 同上 |
| `temp_name_exists` | **409** | 同上 |
| `daemon_unreachable` | **502** | 同上 |
| `exec_failed` / `write_failed` / `no_runtime` | **500** | **固定文案**「平台内部错误，请查看服务日志」（原文只进日志） |

补充：沙箱不存在 → **404**（平台 `NotFoundError`，走既有全局处理器）；缺 `path`
查询参数 → **400**（既有请求校验口径）。

### 门禁数字

| 门禁 | 结果 |
|---|---|
| `uv run pytest web/backend` | **329 passed**（基线 287 → **+42**；其中 `tests/test_server_files.py` **42 项**） |
| `uv run ruff check .` | **退出码 0** |
| `uv run pytest core -m "not root"`（核心包本轮**已回修**） | **370 passed**（02 轮 362 → 本轮 **+8**；其中 `test_transfer.py` **93 → 101 项**） |
| `uv run pytest core -m root` | **23 passed**（**11m20s**；含**上传脚本真机路径**已跑） |

### 真机验证（本机部署链，2026-11-09）

**部署**：把工作区的两个运行时包同步到快照 `/opt/sandbox-platform`（`rsync`，只动
`apps/core/src/sandbox_platform` 与 `apps/web/backend/src/sandbox_console`），
`systemctl restart sandbox-console.service`（改前 PID 1737301 / 01:41:59 起 → 改后
PID 2730482 / 08:56:01 起）。**核心包回修（字节数核对）后再次同步工作区产物并
重启服务**——**新端点已在线**。**测试沙箱 `rtf-probe`（`sandbox-platform/base:0.3.0`）**
完测后已由平台回收（容器 / 网络 / 系统用户 / 子 UID 段 / 元数据）；用户既有的
`qilu` 沙箱全程未被触碰。

| 场景 | 结果 |
|---|---|
| 直连控制台：上传 / 列表 / 下载 | 全部 200；上传 28 字节回 `{"path":"/workspace/small.txt","bytes":28}`；容器内内容一致；下载响应头齐（`Content-Type` / `Content-Length` / `Content-Disposition`） |
| 直连负例 | 下载目录 400、**上传目标是目录 400**、非法路径 400、沙箱不存在 404、无令牌 401 |
| **经 Traefik（改前）** | 限速 3 MiB/s 上传 250 MiB ⇒ **60.53 s 被掐断，HTTP 502**，只传上去 190,316,544 字节 |
| **经 Traefik（改后）** | 同一上传 ⇒ **83.13 s 成功，HTTP 200**（修完「上传前置失败挂死」缺陷后复验 **83.08 s / HTTP 200**），`{"path":"/workspace/big.bin","bytes":262144000}`（**>60 s 且成功**）；容器内 sha256 与宿主源文件**一致**（`e9474e4c…a65df`） |
| 经 Traefik 下载（对照） | 250 MiB **0.62 s** 完整送达，字节**逐字节一致**；响应头 `content-length: 262144000` |
| 内存曲线 | 上传全程控制台进程 RSS **58.8 → 59.2 MiB**（平坦，**不随文件大小增长**） |
| 上传**前置就失败**（目标是目录）时的大 body | **0.52 s 即回 400**（只传了 1.5 MB 就被拒，客户端拿到完整中文 detail，**不挂死**） |
| 殃及检查 | `traefik.sankabox.com` 302、`clash.sankabox.com` 200、`minio-console` 200、`minio` 403、`prometheus` 302、`sandbox-api` `/api/health` **200**；`filebrowser` 与 `clash-api` 的失败是**既有**问题（前者 DNS 指向 `192.168.2.134`（本机是 `.135`，**请求没到 Traefik**），后者动态配置的后端 IP `192.168.2.2` 已失效），与本次改动无关 |

### 部署链落地（Traefik）：偏离与理由

**偏离**：任务书与 ADR 0018 第 6 节要求「为 `sandbox-api-service` 加
`transport.respondingTimeouts.readTimeout`」，**在 Traefik v3.7 上不成立**：

- v3 的 **service 级 `serversTransport` 没有 `respondingTimeouts` 字段**
  （动态配置 schema：`pkg/config/dynamic/http_config.go` 的 `ServersTransport` 只有
  `forwardingTimeouts` 与 TLS 相关项）——按 service 级写法落配置，反代**直接拒收**：
  ``collecting file configs: /dynamic/sandbox-api.yaml: field not found, node: respondingTimeouts``；
- **v3 的读超时只在「入口点」的 transport 上**
  （`entryPoints.<name>.transport.respondingTimeouts.readTimeout`，**静态**配置项，
  默认 60s，语义是「读整个请求，含 body」——正是掐断慢速上传的那一个）。

**因此落地改为入口点级覆盖**（最小增量）：`7640HS/traefik/docker-compose.yaml` 的
命令行**新增一条** `--entrypoints.websecure.transport.respondingTimeouts.readtimeout=0`。
**`:80` / `:8080` 两个入口点与其它 service / router 一概不动**；`idleTimeout`（180s）
与 `writeTimeout`（默认不限时）不动。生效证据：Traefik API `/api/entrypoints` 显示
`:443` 的 `respondingTimeouts` 由 `{"readTimeout":"1m0s","idleTimeout":"3m0s"}` 变为
**`{"idleTimeout":"3m0s"}`**（读超时不限时），`:80` / `:8080` 保持 `1m0s`。
静态配置**不能热加载** ⇒ 按约定**只重启 traefik 本体**（改前容器 id `df3ecfe7…`、
`started=2026-10-26T09:40:29Z` → 改后 id `08d97d34…`、`started=2026-11-09T09:05:06Z`）。

**infra 仓库提交**：`sankabox-infrastructure`（`/home/sankabox/sankabox-infrastructure`）
→ **`529ac29`**「traefik: websecure read timeout unlimited for runtime file transfer」
（只含 `7640HS/traefik/docker-compose.yaml` 一个文件、+8 行；仓库里**他人未提交的**
`NanoPiR2S/dnsmasq/dnsmasq.conf` 改动与**未纳管**的
`7640HS/traefik/dynamic/sandbox-api.yaml` **一概未碰**）。

**ADR 勘误**：0018 第 6 节的「落地要求」已随本轮更正（并加勘误条）——**远程部署必须
自查反代读超时**这条口径不变；另补两处本轮勘误：**第 8 节**错误分类表**再补两类**
（`size_mismatch` / `invalid_size`，「两个新分类码」改为**四个**且**均已进包导出**）、
**第 2 节上传语义**补「`mv` 前期望字节数核对 + 服务端计数兜底」的**双保险**口径与
**chunked 残余风险**。

### 两条发现

1. **核心包层：客户端中断的上传会把「半截文件」落在目标路径上**（`mv` 竞态）——
   **本轮已修**（核心包回修 + 服务端字节计数兜底，**双保险**）。
   修复前的实测：经反代 60 s 掐断后，容器内 `/workspace/big.bin` = **189,726,720 字节**
   （客户端只传上去 190,316,544 字节），**临时名已按预期清理**（无 `.rtf-tmp-*`
   残留）、**exec 进程也已回收**（宿主与容器内均无残留进程）——但目标路径上留下的是
   **半截内容**。根因：宿主侧关 stdin ⇒ 容器内 `cat > 临时名` **干净 EOF、rc=0** ⇒
   `&& mv 临时名 目标` **照常执行**（核心包失败路径里的 `rm -f 临时名` 随后扑空）。
   **服务端层无法规避**（宿主侧关 stdin 必然让容器内 `cat` 收到干净 EOF）。
   - **第一道保险（核心包回修）**：上传脚本把**期望字节数**经 argv 直传进去（`"$3"`），
     `mv` **之前**用 `wc -c < 临时名` 核对实际字节数——**不符即删临时名 + 打
     `size mismatch` 标记 + 非零退出**，**不执行 `mv`** ⇒ **目标路径保持原样**（旧内容
     不被半截内容覆盖）；签名 `upload(..., expected_bytes: int | None = None)`，
     `None` = **跳过核对**；新增分类码 `size_mismatch` / `invalid_size` 与固定中文文案。
   - **第二道保险（服务端消费侧计数兜底）**：真机中断场景下**第一道的信号会丢**
     （核心包失败路径**先**关泵（按进程组回收）**再**读 stderr 尾部，容器客户端被杀时
     `size mismatch` 标记**一并丢了** ⇒ 核心包只能归 `write_failed` / `exec_failed`
     ⇒ 500）。服务端因此自己数「核心包**实际取走**的字节数」：**取走字节数 ≠ 期望**
     且核心包只给出**笼统分类** ⇒ **改判 `size_mismatch`（400）**；**取走 0 字节**
     （失败发生在写入之前）或核心包给出**更精确分类码**（如「目录不可写」）⇒
     **不改判**。
   - **残余风险（已写明）**：**无 `Content-Length`（chunked 传输）时不核对**——没有契约值
     可比，此时客户端中断**仍可能在目标路径留下半截文件**；**调用方拿得到总长度时
     应当带上 `Content-Length`**（服务端已在请求头处接线：**缺失 ⇒ `None`（跳过核对）**、
     **非法 ⇒ 400，不静默降级**）。
2. **Traefik 配置模型**：见上「偏离」——0018 第 6 节与本任务书的「service 级
   transport 覆盖」写法在 v3 不成立，已勘误入档（ADR 0018 §6 + 文首修订条）。

### 其它口径

- **上传端点确为 raw 流式**：`request.stream()` 逐块消费，**未使用** `request.body()`
  / JSON 模型（单测里把 `Request.body` 换成会抛异常的桩来证明这一点）。
- **字节搬运走专用线程池**：`TRANSFER_IO_EXECUTOR`（`sandbox-transfer-io-*` 线程名，
  单测断言）。
- **鉴权自动生效**：三个端点挂在 `/api` 下 ⇒ 无令牌 401；**CORS 白名单零改动**
  （只用 GET / POST）；**不新增 WebSocket**。
- **命令行零改动**；**创建时注入通道零改动**。
- **实现期发现并修掉的一个服务端缺陷**：「上传前置就失败」（目标是已存在目录 /
  父目录缺失 / 沙箱已停）时，消费侧已经退出，而请求体仍在被读进**有界**桥接
  队列 ⇒ 队列塞满 ⇒ 喂 body 的一侧永远等不到空位 ⇒ **请求挂死**。修法：喂 body
  与上传编排**并行**，**上传一结束就终止读 body**（并给桥接记失败，让还在等下一块
  的消费侧立刻收工）。单测 `test_upload_that_fails_early_does_not_hang_on_a_large_body`
  覆盖（分块大 body）；真机复验：大 body 打到「目标是目录」**0.52 s 即回 400**。

### 审查一轮 + 修复一轮（2026-11-09）

审查结论「**需修复后合入**」，**7 项必修全部完成**（另做**测试补强**）：

| # | 必修项 | 落点 | 要点 |
|---|---|---|---|
| 1 | **核心包回修：上传字节数核对** | `apps/core/src/sandbox_platform/transfer.py`（`UPLOAD_SCRIPT` / `upload` / `_ERROR_KEYWORDS`） | 期望字节数 argv 直传；`mv` 前核对实际字节数，不符即删临时名 + 打 `size mismatch` 标记 + 非零退出、**不 `mv`**；新增 `size_mismatch` / `invalid_size` 分类码与固定文案 |
| 2 | **服务端字节计数兜底** | `apps/web/backend/src/sandbox_console/transfers.py::_translate_upload_failure` | 「取走字节数 ≠ 期望」且核心包分类笼统 ⇒ 改判 `size_mismatch`（400）；取走 0 字节 / 分类更精确 ⇒ **不改判** |
| 3 | **期望字节数接线（`Content-Length`）** | `transfers.py::parse_expected_bytes` + `routes/files.py` | 头 ⇒ 期望字节数；**缺失 ⇒ `None`**（跳过核对）；**非法 ⇒ 400**，不静默降级 |
| 4 | **下载流按声明长度裁剪** | `transfers.py::iter_download_chunks` | 实际流超出探测值即截断（否则响应体与 `Content-Length` 冲突 ⇒ uvicorn / h11 `LocalProtocolError`） |
| 5 | **超长 `Content-Length` ⇒ 400** | `transfers.py::parse_expected_bytes` + `errors.py` | 超过 **20 位十进制**直接 400（`int()` 对超长数字串抛 `ValueError` ⇒ 否则是 500）；不落 500 |
| 6 | **日志单行化** | `apps/web/backend/src/sandbox_console/errors.py::single_line` | 传输链路的路径 / stderr 片段压成单行，不让换行污染日志 |
| 7 | **下载关泵丢进线程池** | `transfers.py::_close_download_stream` | `stream.close()` 最坏阻塞约 **6 s**（SIGTERM → `wait(3)` → SIGKILL → `wait(3)` + stderr 排空 `join(2)`），同步关会**堵住事件循环** ⇒ 丢进 `TRANSFER_IO_EXECUTOR` |

**分类码导出（第 1 项的配套）**：四个新分类码（守护进程不可达 / 临时名已存在 /
字节不符 / 期望值非法）+ `MSG_SIZE_MISMATCH` **已进 `__init__.py` 包导出**，服务端
**从包根导入**——02 轮记的「模块内直引」例外**已消解**。

**测试补强**：服务端 `apps/web/backend/tests/test_server_files.py` **42 项**（38 个测试
函数，其中 1 个 5 路参数化；新增字节数核对、非法 / 超长 `Content-Length`、计数兜底
改判、下载裁剪、关泵入池、日志单行等）；核心包 `apps/core/tests/test_transfer.py`
**93 → 101 项**（新增期望字节数透传、字节数不符归类与清临时名、非法期望值拒绝）。
