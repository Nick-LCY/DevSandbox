---
prd: prds/phase3-desktop.md
status: doing
---
# 任务：连接层前端改造（请求基址抽象 / 连接配置 / WebSocket 地址推导 / 未配置态）

## 目标

让同一份前端源码能分别连「同源后端」与「远端后端」：请求基址可配置、凭据统一携带、WebSocket 地址从连接配置推导、未配置时给出引导。所有改造必须逐条遵守 [[conventions/console-frontend.md|网页控制台前端约定]]。

## 涉及文件

- 新增 `apps/web/frontend/src/lib/connection.ts` — 连接配置模型、存取、`useConnection()` Hook、基址推导、Tauri 形态探测
- 新增 `apps/web/frontend/src/lib/connection.test.ts` — 单元测试
- 改 `apps/web/frontend/src/api/client.ts` — 基址拼接、`Authorization` 头、票据获取
- 改 `apps/web/frontend/src/lib/terminal.ts` — `terminalSocketUrl()` 改为从连接配置推导；票据参数
- 改 `apps/web/frontend/src/lib/terminal.test.ts` — 对应用例
- 新增 `apps/web/frontend/src/components/workbench/ConnectionSetup.tsx` — 未配置态引导面板
- 改 `apps/web/frontend/src/components/workbench/Workbench.tsx` — 未配置态分流
- 改 `apps/web/frontend/src/components/workbench/SettingsDialog.tsx` — 新增「连接配置」区
- 改 `apps/web/frontend/src/components/workbench/SettingsDialog.test.tsx` — 对应用例
- 改 `apps/web/frontend/vite.config.ts` — `base: './'`
- 改 `apps/web/frontend/README.md` — 标识表、接口一览、连接配置章节
- 改 `apps/web/frontend/src/styles/globals.css` — 若引导面板需要新令牌则按令牌纪律新增（`:root` 与 `.dark` 两处 + `@theme` 映射）

## 实施步骤

1. **`src/lib/connection.ts`**：
   - `ConnectionConfig = { backendBaseUrl: string; token: string }`；
   - 存储键 `sandbox-console-connection`，读写包 try/catch，非法值回落默认（**令牌为空 = 未配置**；基址为空 = 同源，2026-11-03 修订：未配置不再按形态区分）；
   - `resolveApiBaseUrl(config)`：空基址 → `''`（同源）；否则去掉尾部 `/`；
   - `isDesktopRuntime()`：特性探测 `window.__TAURI_INTERNALS__`；
   - `useConnection()` Hook：口径与 `theme.ts` / `sidebar-collapsed.ts` 同款（挂载时不写存储、只认用户明确写过的值）。
2. **请求基址**：`src/api/client.ts` 的 `request()` 拼基址、附 `Authorization: Bearer <token>`；令牌为空时不发请求（抛一个可识别的「未配置」错误，由上层引导）。
3. **票据获取**：新增 `fetchAuthTicket()`（`POST /api/auth/ticket`），票据在每次 WS 连接 / 重连前获取，不缓存。
4. **WebSocket 地址**：`terminalSocketUrl(sessionId, { baseUrl, origin })` — 基址非空时按 `http→ws` / `https→wss` 推导；基址为空时仍按 `location` 推导（web 形态行为不变）。
5. **未配置态**：`Workbench.tsx` 在未配置时渲染 `ConnectionSetup`（后端地址输入框 + 令牌输入框 + 「保存并连接」按钮 + 来源说明）；~~web 形态下后端地址固定同源且只读。~~ **（2026-11-03 决策 A 推翻：网页端同样可配置后端地址，默认空即同源；唯一保留的形态差异是桌面运行时的机制层（CSP 同步 + 保存后按需重载），桌面形态的空基址在表单层本地校验拦截——以 [[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]] 第二次修订为准。）** 引导态不入路由。
6. **设置抽屉**：新增「连接配置」区（地址、令牌、「测试连接」按钮）；测试连接打一次 `/api/health`，成功弹成功 toast、失败弹失败 toast（`data-toast-source="connection"`）。
7. **`vite.config.ts`**：`base: './'`。
8. **字体**：新增中文文案后**必须重跑** `bash apps/web/frontend/scripts/build-fonts.sh`（否则新字缺字形显示为方框）。
9. **测试**：`connection.test.ts` 覆盖正常往返 / 非法值回落 / 读取失败回落 / 存储不可用不抛异常 / 基址推导 / 形态探测；`terminal.test.ts` 覆盖基址推导与票据拼接。

## 完成标准

- [x] `src/lib/connection.ts` 有单元测试：正常值往返、非法值回落默认、读取失败回落、存储不可用不抛异常、基址推导（空基址 = 同源、尾部斜杠归一）、Tauri 形态探测。
- [ ] 请求基址可配置：同一份前端产物能分别连同源后端与远端后端，两种形态下沙箱列表 / 详情 / 创建 / 终端全部可用。**（唯一未闭合项：代码侧已落地，待用户在 Windows 真机上用同一份产物分别连同源后端与远端后端实跑复验。）**
- [x] 每个 API 请求都带 `Authorization: Bearer`；令牌缺失时不发请求并进入引导态。
- [x] 终端 WebSocket 地址从连接配置推导（`http→ws` / `https→wss`），票据由前端自动获取、每次重连重新获取。
- [x] 未配置态有引导 UI，且**不是路由**（地址栏仍是 `#/`）；~~web 形态下后端地址只读。~~ **（2026-11-03 决策 A 推翻：两种形态下地址都可编辑，判定只看令牌。）**
- [x] 设置抽屉有「连接配置」区，可改配置并「测试连接」，结果按 toast 规范反馈。
- [x] `base: './'` 生效：产物资源引用为相对路径；web 形态（后端 `StaticFiles` 托管）下页面与静态资源加载正常。
- [x] 不违反 [[conventions/console-frontend.md|网页控制台前端约定]] 的任何一条：只用 Base UI、颜色只走令牌、结果反馈只走 toast、标识符合 `page-<页面>-<元素>` 规范、新增标识登记进 `apps/web/frontend/README.md` 标识表。
- [x] 新增中文文案后字体子集已重新生成（`build-fonts.sh` 已跑，产物入库）。**（本轮按「核对」路径闭合：字符集核对为 3636 字、与库内子集一致，新增用字全在子集内，故未重跑 `build-fonts.sh`，产物无需变更。）**
- [x] 前端 `vitest` / `typecheck` / `typecheck:tests` / `build` 全绿。（实测：vitest **490 全绿**；`typecheck` 与 `typecheck:tests` **双零错**；`build` 成功；服务端 pytest **245 passed（CORS/Origin 口径调整后）**。）
- [x] `apps/desktop/src-tauri/tauri.conf.json` 的 `app.security.csp` 已收敛为动态生成值，不得为 `null`（[[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]] 打样轮临时偏离的闭合闸门）。（实测：收敛为「配置基线 + Rust 运行期 host 级动态生成」——基线 `connect-src` 只留 `'self'`，Rust 侧按当前后端主机补 `http(s)://<host>:*` 与 `ws(s)://<host>:*`；`cargo check` 过 + **11 条 Rust 单测**全过。）

## 依赖

- 依赖 [[tasks/phase3-desktop/02-backend-token-and-cors.md|02 连接层后端改造]] 定下的令牌与票据契约。
- 依赖 [[tasks/phase3-desktop/01-prototype-and-spike.md|01 打样轮]] 的 P2 结论（WebView2 三项冒烟）——若 `oklch` 或剪贴板在真机不成立，本任务要在同轮内调整样式 / 剪贴板口径。
- 决策依据：[[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]]；约定依据：[[conventions/console-frontend.md|网页控制台前端约定]]。

## 进展（2026-11-03）

- **实现与修复轮完成**：连接配置抽象（`{ backendBaseUrl, token }`，存储键 `sandbox-console-connection`，存取收敛在 `src/lib/connection.ts`）、未配置态引导面板（`src/components/workbench/ConnectionSetup.tsx`，**页面状态、不是路由**）、WS 一次性票据对接（每次连接 / 重连前取票）、设置抽屉「连接配置」区（地址 + 令牌 + 测试连接 + 保存配置）、`base: './'` 均已落地；审查提出的问题经一轮修复后收口。
- **CSP 闸门闭合**（详见 [[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]] 第 6、7 节）：桌面侧 CSP 已从审查判定的「scheme 通配（Critical）」收敛为**「配置基线 + Rust 运行期 host 级动态生成」**——`tauri.conf.json` 的 `app.security.csp` 是基线策略（`connect-src` 只留 `'self'`，**不为 `null`**），Rust 侧（`apps/desktop/src-tauri/src/csp.rs`）在主文档被请求时按当前后端主机补 `http(s)://<后端host>:*` 与 `ws(s)://<后端host>:*`（**host 级，不放行 `http:` / `https:` / `ws:` / `wss:` 这类 scheme 通配**）。时序契约 = **保存连接配置 → 同步 Rust 状态 → 按需重载主文档**（主文档的 CSP 只在被请求时生成，故状态更新必须先于重载）。ADR 0015 第 7 节的「打样轮临时偏离」就此闭合（**06 完成标准中的同款闸门保留**）。
- **2026-11-03 用户决策已同步口径**：决策 A（取消形态间的**配置**差异——网页端同样可配置后端地址，默认空即同源；未配置判定 = 令牌为空；唯一保留的形态差异是桌面运行时的机制层：桌面空基址改为表单层本地校验拦截）与决策 B（后端 CORS 任意来源、WS 握手 Origin 门禁取消，准入边界 = 令牌 + 票据）已落进本任务条目；口径依据见 [[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]] 第二次修订与 [[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 第二次修订。
- **门禁**：vitest **490 全绿**；`typecheck` 与 `typecheck:tests` **双零错**；`build` 成功；服务端 pytest **245 passed（CORS/Origin 口径调整后）**；`cargo check` 通过 + **11 条 Rust 单测**全过（基线策略不含 `script-src 'unsafe-inline'`、基线与改写后均无 scheme 通配、host 换算、IPv6 方括号只带一层、幂等改写、重载判定等）。
- **字体**：新增中文文案后核对字符集为 **3636 字、与库内子集一致**（新增用字全在子集内），**未重跑** `build-fonts.sh`，产物无需变更。
- **待复验**：完成标准 11 条中 **10 条已闭合**，唯第 2 条（同一份产物连同源 / 远端后端全链路可用）**待用户在 Windows 真机 + 真后端复验**。
- **已知过渡态（非回归）**：既有 Playwright 验收套件（`apps/web/frontend/tests`，9 条 spec）**自 03 落地起为红**——未配置态引导面板替换了工作台，后端又要求令牌，脚本没预置令牌就进不了工作台；**07（[[tasks/phase3-desktop/07-acceptance-tokenization.md|验收套件 token 化]]）落地后恢复**。看到这 9 条红不要当回归。
