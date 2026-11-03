---
prd: prds/phase3-desktop.md
status: done
---
# 任务：连接层后端改造（token 认证 / CORS / WebSocket 鉴权）

> 落地结论：全部完成标准通过。新增 `sandbox_console/auth.py`（令牌来源解析与落盘、常量时间比对、票据存储、跨源放行清单与 Origin 判定、Bearer 认证中间件）与 `sandbox_console/routes/auth.py`（`POST /api/auth/ticket`）；改 `app.py`（挂中间件、启动解析令牌）、`routes/terminal.py`（WS 握手校验票据与 Origin）、`routes/__init__.py`、`deps.py`、`schemas.py`、`__main__.py`（非回环告警改「已启用令牌认证」口径）；`API.md` 增第 14 章「认证」；`sandbox-console.service` 与根 `README.md` 同步令牌口径。核心包 `apps/core/` 与命令行 `apps/cli/` **零改动**。
>
> **用例与门禁（修复轮收口）**：新增 **61 条**用例（初轮 34 条 + 修复轮 27 条）；服务端 pytest **全量 249 passed**；ruff（`E4/E7/E9/F`）**退出码 0**；核心包回归 **245 passed** 且零改动。
>
> 三条关键设计落点：**中间件挂哪** —— 外层跨源放行（CORS）、内层令牌认证（`/api` 前缀才拦，静态资源与 `/docs` 不拦，预检由外层直接应答、不带 `Authorization` 头也不被拦）；**票据存哪** —— 进程内存态（`app.state.ticket_store`），30 秒有效、用过即废、过期判定走单调时钟；**Origin 校验在哪个钩子** —— 终端 WS 路由的握手处（`routes/terminal.py`，先判 Origin 再消费票据，不过就 `close(1008)` 且不 `accept`）。
>
> **修复轮落实的五条**（初轮实现经审查后收紧，均有用例覆盖）：
> - **同源判定的 scheme 与默认端口**：同源判定不只比主机，还要比 scheme（`http` 的 Origin 与 `https` 的连接不算同源），默认端口按 **Origin 的 scheme** 取（`https` → 443、`http` → 80）。
> - **WS scope 默认拒绝（fail-closed）**：中间件对 WebSocket scope 一律拒握手；只有豁免清单里显式登记的路径（当前仅终端 WS `/api/terminal/sessions`）才放行到路由层，由路由自己再做票据与 Origin 校验——漏登记的后果是「默认被拒」而不是「裸奔」。
> - **令牌文件加固**：令牌文件权限位不是 `0600` 时读前收紧并打 WARNING；文件存在但内容损坏时**重新生成并告警**（只说路径、不说内容）；**请求期回退路径只读化**（不生成、不落盘，取不到就按认证失败处理）。
> - **AST 白名单契约测试**：令牌比较的「不使用 `==` / `in`」不再靠搜字符串，而是解析 AST 断言令牌取值只出现在 `token_matches` 内、且该函数确实调用 `hmac.compare_digest`。
> - **`root_path` 剥离**：ASGI `root_path` 前缀（挂载前缀）不参与准入判定——服务挂在子路径下时 `/api` 前缀仍被拦，不漏鉴权。
>
> 一条口径要说明：**WS 的 Origin 放行清单含「同源」**（浏览器 Origin 与本次请求同源即放行，判定含 scheme 与按 Origin scheme 取默认端口）——后端托管网页的形态下浏览器发起 WS 带的正是自身 Origin（如 `http://127.0.0.1:8000`），不放行同源等于把网页终端全断。**但 Origin 校验不是安全边界**（同源判定基于 `Host` 头，Host 头可被伪造），真正的准入边界是**令牌与票据**；口径见 [[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 第 4 节的修订说明（2026-11-03）。
>
> 一条**过渡期事实**：令牌闸对全部 `/api` 生效（`/api/health` 不豁免），因此**未改造的网页前端在 03 落地前拿不到数据**（前端不带 `Authorization` 头）。这是 ADR 0013 第 3 节的硬要求（令牌是硬需求），不是缺陷；03 的连接层改造（基址抽象 + 统一带令牌 + 票据）落地后即恢复。**部署口径：02 不得单独部署，必须与 03 同批发布**（见 [[tasks/phase3-desktop/README.md|三期任务集]]「部署顺序硬约束」）。

## 目标

把后端从「同源无认证」改造成「独立 API + token 认证」：所有 `/api`（含终端 WebSocket）受令牌保护；跨源有明确放行清单；浏览器侧 WebSocket 有可用的鉴权通道。核心包与命令行零改动。

## 涉及文件

- 新增 `apps/web/backend/src/sandbox_console/auth.py` — 令牌加载 / 生成 / 比对 / 票据存储 / 跨源放行清单与 Origin 判定 / Bearer 认证中间件（服务端包没有 `config.py`，`SANDBOX_CONSOLE_TOKEN` 的环境变量口径同落此处）
- 新增 `apps/web/backend/src/sandbox_console/routes/auth.py` — `POST /api/auth/ticket`
- 改 `apps/web/backend/src/sandbox_console/app.py` — 挂认证中间件、CORS 中间件、令牌初始化（WS 的 Origin 校验落在终端 WS 路由的握手处，判定函数在 `auth.py`）
- 改 `apps/web/backend/src/sandbox_console/routes/terminal.py` — WS 握手票据校验与 Origin 校验
- 改 `apps/web/backend/src/sandbox_console/routes/__init__.py` — 注册票据路由
- 改 `apps/web/backend/src/sandbox_console/deps.py` / `schemas.py` — 票据存储的依赖注入与响应模型
- 改 `apps/web/backend/src/sandbox_console/__main__.py` — 非回环监听告警改写
- 改 `apps/web/backend/API.md` — 新增「认证」章节（第 14 章）
- 改 `README.md`（仓库根）— 控制台服务的令牌口径与调用示例
- 改 `apps/web/backend/sandbox-console.service` — 令牌相关注释
- 新增 / 改 `apps/web/backend/tests/` — 认证、票据、CORS、WS 鉴权用例

## 实施步骤

1. **令牌来源**：`SANDBOX_CONSOLE_TOKEN` 优先；否则在 `<平台数据根>/console-token.json` 生成（`secrets.token_urlsafe(32)`，前缀 `sbx_`，文件 `0600`，原子写入）。启动日志只打路径。
2. **HTTP 鉴权中间件**：拦 `/api` 前缀（静态资源与 `/docs` 不拦）；取 `Authorization: Bearer`，用 `hmac.compare_digest` 比对；失败 → `401` + `{"detail": "访问令牌无效或缺失"}`；不区分「缺失」与「错误」，不回显令牌，不在日志里写令牌。
3. **票据**：`POST /api/auth/ticket`（受 Bearer 保护）→ `{"ticket": "...", "expires_in": 30}`；票据一次性、30 秒过期、进程内存态；提供 `consume(ticket)` 供 WS 握手校验。
4. **WS 鉴权**：终端 WS 握手读 `?ticket=`，校验并立即作废；非法 / 过期 → 拒握手（`websocket.close(code=1008)`，握手不 `accept`）。同时校验 `Origin` 头在放行清单内。
5. **CORS**：白名单 `http://tauri.localhost`、`http://localhost:5173`、`http://127.0.0.1:5173`；不放通配符；`allow_credentials=False`；`allow_methods=["GET","POST","DELETE","OPTIONS"]`；`allow_headers=["Authorization","Content-Type"]`。
6. **非回环告警改写**：`__main__.py` 的 `warn_if_not_loopback()` 改成「已启用令牌认证」口径，不再宣称「完全信任」；README / API.md 的相关说明同步。
7. **测试**：令牌缺失 / 错误 / 正确三态；票据一次性与过期；CORS 允许与拒绝；WS 无票据 / 错票据 / 有票据；Origin 不在白名单被拒。

## 完成标准

- [x] 未带令牌访问任何 `/api` 返回 `401`，响应体为 `{"detail": "访问令牌无效或缺失"}`；带正确令牌返回 `200`。
- [x] 令牌比较使用 `hmac.compare_digest`；代码里不出现对令牌的普通 `==` / `in` 比较。
- [x] `SANDBOX_CONSOLE_TOKEN` 注入时用注入值；未注入时自动生成并落 `<数据根>/console-token.json`（`0600`），服务正常启动，启动日志只出现路径不出现令牌。
- [x] `POST /api/auth/ticket` 必须带有效令牌；票据一次性、30 秒过期；用过即废。
- [x] 终端 WebSocket 无票据 / 错票据时握手被拒；带有效票据时行为与二期一致（先回放缓冲再接实时流）。
- [x] WebSocket 握手的 `Origin` 不在白名单时被拒。
- [x] CORS 只放行三个白名单来源；预检与实际请求都不放行其它来源；响应里没有 `Access-Control-Allow-Origin: *`。
- [x] 绑非回环地址时的启动日志按新口径改写。
- [x] 服务端 pytest 全绿且新增认证相关用例；ruff（`E4/E7/E9/F`）退出码 0。（实测：新增 61 条用例——初轮 34 条 + 修复轮 27 条；服务端全量 **249 passed**；ruff 退出码 **0**。）
- [x] 核心包（`apps/core/`）与命令行（`apps/cli/`）零改动。（实测：核心包回归 **245 passed**。）
- [x] `apps/web/backend/API.md` 新增「认证」章节，写清令牌来源、请求头、票据流程、CORS 与 Origin 白名单、`/api/health` 不豁免的口径。

## 依赖

- 无前置任务依赖，可与 [[tasks/phase3-desktop/01-prototype-and-spike.md|01 打样轮]] 并行。
- 契约依据：[[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 第 3、4 节。
- 后续任务：[[tasks/phase3-desktop/03-frontend-connection-layer.md|03 连接层前端改造]]、[[tasks/phase3-desktop/07-acceptance-tokenization.md|07 验收套件 token 化]] 都依赖本任务定的契约。
