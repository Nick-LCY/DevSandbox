---
prd: prds/runtime-file-transfer.md
status: todo
---
# 任务：服务端文件传输接口（三端点）

> 需求见 [[prds/runtime-file-transfer.md|运行期文件传输 PRD]]。**依赖 02 的核心包能力**。
>
> **本轮含两条实测得来的硬要求**（2026-11-09）：① **请求体必须 raw 流式**（禁 JSON body）；② **Traefik transport 覆盖落地**（本机部署链是本平台自管的基础设施，属本轮落地范围）。依据见 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]]。

## 目标

把核心包的传输能力包成服务端接口：**三个 REST 端点**，全部挂在 `/api/sandboxes/{name}/files/` 下。服务端只做编排与转译，能力本体在核心包。

## 涉及文件

- 新增 `apps/web/backend/src/sandbox_console/routes/files.py` — 三个端点
- 新增或改 `apps/web/backend/src/sandbox_console/transfers.py` — **流式装配**（`TRANSFER_IO_EXECUTOR` 专用线程池、断开清理）
- 改 `apps/web/backend/src/sandbox_console/routes/__init__.py` — 注册路由
- 改 `apps/web/backend/src/sandbox_console/app.py` — lifespan 装配传输管理器（如需）
- 改 `apps/web/backend/src/sandbox_console/errors.py` — **错误文案表**（固定中文）
- 改 `apps/web/backend/src/sandbox_console/schemas.py` — 请求 / 响应模型
- 新增 `apps/web/backend/tests/test_files.py` — 用例
- 改 `apps/web/backend/API.md` — **新章节**（路由表 / 字段 / 错误码映射 / 认证口径；**章节号按 API.md 实际结构定**）
- 改 **Traefik 动态配置** `sandbox-api.yaml`（**不在本仓库内**，在 `sankabox-infrastructure` 仓库的 Traefik 动态配置目录）— 为 `sandbox-api-service` 加 `transport.respondingTimeouts.readTimeout`（本平台自管的基础设施，属本轮落地范围）

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
- **错误文案**：固定中文，形状 `{"detail": "<中文>"}`；**容器内 stderr 原文只进日志**；**错误分类只按 stderr 关键词子串**（不按整句、不按退出码）。
- **鉴权**：端点挂在 `/api` 下即被**令牌中间件自动保护**，不另写鉴权分支。
- **不新增 WebSocket**；只用 GET / POST → **CORS 白名单零改动**。

## 部署链落地：Traefik transport 覆盖（本轮范围）

- **背景（01 轮实测）**：本机 Traefik **v3.7.13** 反代 `sandbox-api.sankabox.com` → `http://192.168.2.135:28642`，该 service **无 `transport` 块** ⇒ **全部走默认值**（`respondingTimeouts.readTimeout = 1m0s`）。实测同一 200 MiB 慢上传：**直连控制台 201.23 s 成功**，**经反代 61.13 s 被掐断**（`ConnectionResetError`）——掐断的是反代读超时，不是后端，也不是大小上限（反代与后端都**无 body 上限**、不会 413）。
- **本轮动作**：为 `sandbox-api-service` 加 `transport.respondingTimeouts.readTimeout`（**`0` 或显式大值**，如 `10m`），必要时同步调 `idleTimeout`；`writeTimeout` 无需动。**只改这一个 service 的转发超时，不动后端、不动其他路由。**
- **验证**：**经域名**（过 Traefik）做一次**慢速大上传**（限速使单次请求超过 60 s），确认不再被掐断。
- **归属**：本机部署链是**本平台自管的基础设施**（不在本仓库内，在 `sankabox-infrastructure` 仓库的 Traefik 动态配置目录），**属本轮落地范围**。
- **外推口径**：本机结论**不外推**——**远程部署必须自查反代**；这条口径写进 `API.md` 与部署说明。

## 完成标准

- [ ] 三个端点行为符合契约；上传走 **raw body**（`application/octet-stream`，**无 multipart**），返回 `{path, bytes}` 且字节数与实际写入一致。
- [ ] **上传端点 body 是 raw 流式读取**（`request.stream()` 逐块消费），**未使用 JSON 模型 / pydantic 接 body**；**有断言或测试证明进程内存不随 body 大小增长**（实测依据：JSON body 200 MiB ⇒ RSS 44.5 → 433.9 MiB）。
- [ ] **目标已存在 = 覆盖**；上传是**原子替换**；失败时**临时文件被清理**（平台侧显式清，`cat` 不会自清）。
- [ ] **目标是已存在目录 → 前置拒绝**（400 + 明确文案）；**目标文件自身只读（`0444`）不报错**（被覆盖）。
- [ ] **父目录不自动创建**：缺失时报错并给出可行动的引导文案。
- [ ] 下载**只允许普通文件**：**分层探测**可区分目录 / 普通文件 / FIFO·设备·套接字·其他特殊文件；目标是**目录 → 400** + 明确中文文案；**特殊文件 → 拒**（不挂起）。
- [ ] **错误分类只按 stderr 关键词子串**（不按整句、不按退出码）；三类失败（父目录缺失 / 父目录不可写 / 只读挂载）各有固定中文文案；**临时名已换成用户目标路径**。
- [ ] 下载响应带 `Content-Length`（探到时）与 `Content-Disposition: attachment`；**中文文件名正确**（`filename*` UTF-8 + ASCII 回退）。
- [ ] 目录列表返回名称 / 类型 / 大小 / 修改时间；**隐藏文件包含**；**`find` 单次 exec 产出 NUL 分隔记录**；busybox 与 GNU 两种镜像下都正确；**含空格 / 中文 / 换行的名字**不乱。
- [ ] **无 413**：大小不限；后端**全程流式、内存有界**。
- [ ] **Traefik transport 覆盖已落地**：`sandbox-api-service` 的 `transport.respondingTimeouts.readTimeout` 已调（`0` 或显式大值），**只改这一个 service**；**经域名**（过 Traefik）的一次**慢速大上传**（单次请求超 60 s）**不再被掐断**；**远程部署自查反代**的口径写进 `API.md` / 部署说明。
- [ ] 错误响应固定 `{"detail": "<中文>"}`；**容器内 stderr 原文只进日志**。
- [ ] **客户端断开 → 关泵 + 清临时文件**；不留挂死进程与容器内残骸。
- [ ] 字节搬运走 `TRANSFER_IO_EXECUTOR` **专用线程池**，**不进事件循环**。
- [ ] **鉴权自动生效**：无令牌 / 错令牌 → 401（不另写鉴权分支）；**CORS 白名单零改动**。
- [ ] `apps/web/backend/API.md` **新章节**：路由表、字段表、**错误码映射表**、**认证口径**、流式与大小不限的口径、**「大小不限但受反代读超时约束」的口径与远程部署自查反代的提示**（章节号按 API.md 实际结构定）。
- [ ] 单测覆盖：401 / 404（沙箱不存在）/ **409（沙箱已停止）** / 400（目录下载、**目标为目录的上传**、非法路径、**父目录不可写**）/ 下载响应头 / 字节一致 / 列表含隐藏文件。
- [ ] 门禁：服务端 **pytest 全绿**、**ruff 退出码 0**；分层契约测试红线不触发（能力本体在核心包）。
- [ ] **命令行零改动**；**创建时注入通道零改动**；**CORS 配置零改动**。

## 依赖

- 依赖 [[tasks/runtime-file-transfer/02-core-transfer.md|02 核心包传输能力]]。
- 鉴权与 CORS 口径沿用 [[tasks/phase3-desktop/02-backend-token-and-cors.md|三期任务 02]]；流式装配可参考 [[tasks/phase3-desktop/05-port-forward-server-api.md|三期任务 05]]。
- 机制与口径依据：[[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018 运行期文件传输机制选型]]（第 5 节 raw 流式 body 的前提、第 6 节部署链约束）。
