---
prd: prds/phase3-desktop.md
status: todo
---
# 任务：既有验收套件 token 化改造

## 目标

让既有 9 条控制台验收用例在 token 模式下继续跑通，并补认证的负向 / 正向用例。验收脚本与后端服务的启动方式都要带令牌。

## 涉及文件

- 改 `apps/web/frontend/tests/helpers/server.ts` — 启动后端时注入固定测试令牌；`healthOk()` 带认证头
- 改 `apps/web/frontend/tests/helpers/api.ts` — 所有 REST 直调带 `Authorization` 头
- 改 `apps/web/frontend/tests/playwright.config.ts` — `storageState` 预置连接配置
- 新增 `apps/web/frontend/tests/helpers/auth.ts` — 测试令牌常量与带认证的请求助手
- 新增 `apps/web/frontend/tests/specs/10-auth.spec.ts` — 认证正负向用例
- 改 `apps/web/frontend/tests/README.md` — 用例清单与令牌说明
- 改 `apps/web/frontend/src/api/client.ts` / `src/lib/connection.ts` — 若注入方式需要前端配合则同步

## 实施步骤

1. **固定测试令牌**：`helpers/auth.ts` 导出 `TEST_TOKEN`（常量字符串）与 `authHeaders()`。
2. **后端启动**：`helpers/server.ts` 的 `startConsoleServer()` 在子进程环境里加 `SANDBOX_CONSOLE_TOKEN=<TEST_TOKEN>`；`healthOk()` / `waitForHealth()` 的 `fetch` 带上 `Authorization` 头（否则服务会被 401 挡住，健康等待永远超时）。
3. **页面侧令牌**：Playwright 的 `use.storageState` 预置 `http://127.0.0.1:<port>` origin 下的 `localStorage['sandbox-console-connection'] = {backendBaseUrl: "", token: "<TEST_TOKEN>"}`；这样页面一打开就处于「已配置」态，直接进工作台。
4. **REST 直调**：`helpers/api.ts` 的 `request()` 统一带上认证头。
5. **终端 WS**：终端用例走页面内的 WebSocket，前端自动取票据，用例本身不改；只需确认断线重连路径也带票据。
6. **负向 / 正向用例**（新 `10-auth.spec.ts`）：
   - 无令牌访问 `/api/health` → 401；
   - 错误令牌 → 401；
   - 正确令牌 → 200；
   - 无票据的终端 WS 握手 → 被拒（可用 Playwright 的 `page.evaluate` 里手写 `new WebSocket(...)` 观察 `onerror` / `onclose`）；
   - 未配置态引导：无 localStorage 配置时页面渲染引导面板且不是路由。

## 完成标准

- [ ] 既有 9 条 spec 在 token 模式下全量回归通过（无一条因认证改造而失败）。
- [ ] `helpers/server.ts` 启动的后端带固定测试令牌；健康等待不会因 401 卡死。
- [ ] 页面侧通过 `storageState` 预置连接配置，既有用例直接进工作台（不新增「先配置再操作」的步骤）。
- [ ] `helpers/api.ts` 的所有直调都带认证头。
- [ ] 新增 `10-auth.spec.ts` 覆盖：无令牌 401 / 错令牌 401 / 正确令牌 200 / 无票据 WS 被拒 / 未配置态引导。
- [ ] 负向用例**保留**并常驻（不是临时验证脚本）。
- [ ] `apps/web/frontend/tests/README.md` 更新用例清单与令牌说明。

## 依赖

- 依赖 [[tasks/phase3-desktop/02-backend-token-and-cors.md|02 连接层后端改造]]（令牌与票据契约）。
- 依赖 [[tasks/phase3-desktop/03-frontend-connection-layer.md|03 连接层前端改造]]（连接配置的存储键与结构，用于 `storageState` 预置）。
- 可与 [[tasks/phase3-desktop/04-port-forward-core.md|04]]~[[tasks/phase3-desktop/06-port-forward-desktop.md|06]] 并行。
