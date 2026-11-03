---
prd: prds/phase3-desktop.md
status: todo
---
# 任务：连接层后端改造（token 认证 / CORS / WebSocket 鉴权）

## 目标

把后端从「同源无认证」改造成「独立 API + token 认证」：所有 `/api`（含终端 WebSocket）受令牌保护；跨源有明确放行清单；浏览器侧 WebSocket 有可用的鉴权通道。核心包与命令行零改动。

## 涉及文件

- 新增 `apps/web/backend/src/sandbox_console/auth.py` — 令牌加载 / 生成 / 比对 / 票据存储
- 新增 `apps/web/backend/src/sandbox_console/routes/auth.py` — `POST /api/auth/ticket`
- 改 `apps/web/backend/src/sandbox_console/app.py` — 挂认证中间件、CORS 中间件、WS Origin 校验钩子、令牌初始化
- 改 `apps/web/backend/src/sandbox_console/routes/terminal.py` — WS 握手票据校验
- 改 `apps/web/backend/src/sandbox_console/routes/__init__.py` — 注册票据路由
- 改 `apps/web/backend/src/sandbox_console/__main__.py` — 非回环监听告警改写
- 改 `apps/web/backend/src/sandbox_console/config.py`（或等价位置）— `SANDBOX_CONSOLE_TOKEN` 环境变量口径
- 改 `apps/web/backend/API.md` — 新增「认证」章节
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

- [ ] 未带令牌访问任何 `/api` 返回 `401`，响应体为 `{"detail": "访问令牌无效或缺失"}`；带正确令牌返回 `200`。
- [ ] 令牌比较使用 `hmac.compare_digest`；代码里不出现对令牌的普通 `==` / `in` 比较。
- [ ] `SANDBOX_CONSOLE_TOKEN` 注入时用注入值；未注入时自动生成并落 `<数据根>/console-token.json`（`0600`），服务正常启动，启动日志只出现路径不出现令牌。
- [ ] `POST /api/auth/ticket` 必须带有效令牌；票据一次性、30 秒过期；用过即废。
- [ ] 终端 WebSocket 无票据 / 错票据时握手被拒；带有效票据时行为与二期一致（先回放缓冲再接实时流）。
- [ ] WebSocket 握手的 `Origin` 不在白名单时被拒。
- [ ] CORS 只放行三个白名单来源；预检与实际请求都不放行其它来源；响应里没有 `Access-Control-Allow-Origin: *`。
- [ ] 绑非回环地址时的启动日志按新口径改写。
- [ ] 服务端 pytest 全绿且新增认证相关用例；ruff（`E4/E7/E9/F`）退出码 0。
- [ ] 核心包（`apps/core/`）与命令行（`apps/cli/`）零改动。
- [ ] `apps/web/backend/API.md` 新增「认证」章节，写清令牌来源、请求头、票据流程、CORS 与 Origin 白名单、`/api/health` 不豁免的口径。

## 依赖

- 无前置任务依赖，可与 [[tasks/phase3-desktop/01-prototype-and-spike.md|01 打样轮]] 并行。
- 契约依据：[[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 第 3、4 节。
- 后续任务：[[tasks/phase3-desktop/03-frontend-connection-layer.md|03 连接层前端改造]]、[[tasks/phase3-desktop/07-acceptance-tokenization.md|07 验收套件 token 化]] 都依赖本任务定的契约。
