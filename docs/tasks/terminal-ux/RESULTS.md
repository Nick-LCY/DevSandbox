# 终端交互增强：全轮收口留档（2026-11-26）

> 本轮范围全部在前端 `apps/web/frontend`：设置抽屉「通用设置」、两个终端交互偏好、`Shift+Enter` 映射、终端内右键复制 / 粘贴接管和常开 OSC 52 剪贴板互通。`apps/web/backend` 与 `apps/core` 零改动，零新增依赖；收口修正提交 `f3d7f14` 已推送 `origin/main`；发布提交 `409d2ac chore(release): 版本号 0.2.0`、`5f3a09e docs(terminal-ux): 收口验收、Shift+Enter CSI-u 修正与 v0.2.0 发布留档` 已推送，annotated tag `v0.2.0` 已推送。
> 需求见 [[prds/terminal-ux.md|终端交互增强 PRD]]，任务集见 [[tasks/terminal-ux/README.md|终端交互增强任务集]]，约定见 [[conventions/console-frontend.md|控制台前端约定]]。

**状态：01~05 全部 done。** 自动化验收已完成；用户已完成网页与桌面形态手工验收，桌面右键菜单抑制与剪贴板读写确认无问题。Shift+Enter 收口后修正为 kitty CSI-u，用户在 pi 内实测换行通过；已随 `v0.2.0` 发布：Actions run `45832306595` 已 completed / `success`，`build-windows`、`deploy-worker`、`create-release` 三个 job 全部 `success`；GitHub 正式 Release 已创建，资产 `DevSandbox-0.2.0-windows-x64-setup.exe` 为 4,457,358 字节（约 4.25 MB）；Cloudflare 前端 `https://dev.sankabox.com` 返回 200。

## 一、轮次总表

| 任务 | 交付 | 状态 | 收口日期 |
|---|---|---|---|
| [[tasks/terminal-ux/01-preferences-and-general-settings.md\|01 偏好存储与通用设置]] | 两个独立 localStorage 偏好、默认关闭、非法值回落关闭；设置抽屉 tab 改为「通用设置 → 代理 → 模板」，通用设置默认激活并承载终端交互区与原连接配置表单 | done | 2026-11-26 |
| [[tasks/terminal-ux/02-shift-enter-mapping.md\|02 Shift+Enter 映射]] | `shiftEnter` 分类与统一 `sendInput()`；开关开时发送 kitty CSI-u `ESC[13;2u`（7 字节，`f3d7f14` 修正），关时 `0x0d`；切换不重建终端 / WebSocket | done | 2026-11-26 |
| [[tasks/terminal-ux/03-terminal-context-menu-clipboard.md\|03 终端右键接管]] | capture 阶段仅接管 xterm 内右键；有选区复制，无选区 `readText()` + `term.paste()`；关闭或终端外不接管 | done | 2026-11-26 |
| [[tasks/terminal-ux/04-osc52-clipboard-interop.md\|04 OSC 52 互通]] | 常开、只处理 `c` 选择区；set / query 双向桥接，query 经 `sendInput()` 回写 PTY；base64 64 KiB 预检与解码后二次校验 | done | 2026-11-26 |
| [[tasks/terminal-ux/05-acceptance-and-docs.md\|05 验收与文档收口]] | 定向 e2e、前端全量门禁、字体重建、PRD 逐条证据、约定 / 看板 / 清单 / 留档同步 | done | 2026-11-26 |

## 二、门禁数字汇总

各数字对应其提交时点；提交链单列于第八节，不把门禁数字误写成部署或用户验收。

| 范围 | 门禁 | 结果 |
|---|---|---|
| 前端 | 全量 vitest | **1093 passed / 59 files**（前一基线 1058，增加 35） |
| 前端 | `pnpm run typecheck` | **零错** |
| 前端 | `pnpm run typecheck:tests` | **零错** |
| 前端 | `bash scripts/build-fonts.sh` | **成功**；字符集 3648 字符，其中非 ASCII 3553；产出 6 个 woff2 |
| 前端 | `pnpm run build` | **成功**；转换 2924 个模块；既有 chunk >500KB warning 仍在，非本轮引入 |
| 真沙箱 e2e | 首轮 4 个定向 spec | **28 / 28**；0 失败 / 0 跳过 / 0 flaky |
| 真沙箱 e2e | 修复轮复跑 `19` + `16` | **15 / 15**；0 失败 / 0 跳过 / 0 flaky |
| 真沙箱 e2e | 全量 `pnpm exec playwright test --config=tests/playwright.config.ts` | **88 通过 / 0 失败 / 0 跳过 / 0 flaky**；14.4 分钟；退出码 0（基线 77 + `19-terminal-interaction` 新增 11） |
| 范围核对 | 后端 / 核心包 / 依赖 / 发布 | `apps/web/backend` 与 `apps/core` 零改动；零新增依赖；Shift+Enter 修正提交 `f3d7f14` 已推送 `origin/main`；annotated tag `v0.2.0` 已推送，Actions run `45832306595` 已 completed / `success`，`build-windows`、`deploy-worker`、`create-release` 三个 job 全部 `success`；GitHub Release 与 Cloudflare Worker 前端部署成功 |

## 三、机制与关键口径

### 设置与偏好

- 设置抽屉 tab 顺序固定为 **通用设置（默认激活）→ 代理 → 模板**；旧 testid `page-settings-tab-backend` 退役。
- 「通用设置」内是 `page-settings-terminal-interaction` 区，包含 `page-settings-terminal-shift-enter-switch` 与 `page-settings-terminal-right-click-switch` 两个开关；连接配置表单字段与行为不变。
- 两个 localStorage 键相互独立：`sandbox-console-terminal-shift-enter-escape` 与 `sandbox-console-terminal-right-click-clipboard`。值只认 `'1'` / `'0'`；缺失、非法值、读写异常均回落关闭；挂载不写存储；两个开关默认关闭。
- Switch 使用 Base UI 封装 `src/components/ui/switch.tsx`，无 Radix、无新增依赖。

### Shift+Enter

- `terminal-shortcuts.ts` 新增 `shiftEnter` 分类，优先级在 forward 之后、plain 之前，不污染既有分类语义。
- 原实现曾在偏好开启时发送 `ESC+CR` 两字节。收口后用户在 pi 内实测发现它不换行而是直接发送消息；pi 1.6.1 源码证实，pi 启动时发送 kitty 查询 `ESC[>7u ESC[?u`，只有终端回 `CSI ? <flags> u` 且 flags 非零才置 `_kittyProtocolActive`。本链路前端 xterm.js 5.5 不支持该协议，服务端模拟器不注册应答回调，因此永不应答、始终未激活；未激活时 pi 将 `ESC+CR` 解析成 `alt+enter`，绑定 `app.message.followUp` 直接发送消息。VS Code 新版集成终端会应答该查询，所以同一串字节在那里有效。
- 已改为 pi 自身的 `NATIVE_SHIFT_ENTER_SEQUENCE`：kitty CSI-u `ESC[13;2u`，字节为 `0x1b 0x5b 0x31 0x33 0x3b 0x32 0x75`，共 7 字节；该解析分支不依赖协议是否激活。**稳定约定：不得改回 `ESC+CR`。**用户已在 pi 内实测换行通过。修正提交：`f3d7f14 fix(web): Shift+Enter 改发 kitty CSI-u 序列 ESC[13;2u`，已推送 `origin/main`。
- 偏好由 ref 读取，开关切换不重建终端实例或 WebSocket；Ctrl / Meta / Alt、浏览器保留键、Ctrl+Shift+C / Ctrl+Shift+V 语义保持不变。

### 右键 capture

- 终端容器在 capture 阶段监听 `contextmenu`；只有事件目标在当前 `term.element` 内才接管，并执行 `preventDefault()` + `stopPropagation()`。
- 有选区复用既有 Ctrl+Shift+C 复制路径；无选区读取 `navigator.clipboard.readText()` 后调用 `term.paste()`，不直接写 socket。
- 右键偏好关闭、点击终端外、组件卸载后均不接管；卸载会移除监听。复制成功零反馈，失败沿用 `terminal-clipboard` toast。

### 收口后微调（2026-11-26）

用户在前端与桌面端验收后提出的唯一交互微调为：终端右键复制分支仅在复制成功后调用 `term.clearSelection()` 清除选区；复制失败保留选区以便重试，并继续弹既有 `terminal-clipboard` 失败 toast。无选区的右键粘贴分支不清除选区；`Ctrl/Cmd+Shift+C` 既有快捷键路径行为不变，也不清除选区。两条复制路径的选区差异是刻意口径，复制成功仍零 toast。

本轮定向回归：组件单测 **35 / 35** 通过，`typecheck` 与 `typecheck:tests` 双零错，定向 e2e `19-terminal-interaction` **11 / 11** 通过（48.6 s）。本轮未新增中文文案，未重跑字体脚本，未跑全量 e2e。

### OSC 52 双向与 64 KiB 预检

- OSC 52 **常开、无开关**，只处理选择区 `c`；忽略 `p`、`s` 和 cut buffer。
- set：容器内程序提供内容，前端写系统剪贴板，成功零反馈。
- query：前端读系统剪贴板，base64 编码后经同一 `sendInput()` 回写 PTY，**不走 `term.paste`**，不把响应文本插入终端画面。
- 上限检查分两步：先按 base64 字符串长度预检 64 KiB，再解码并校验字节数；非法 base64、超限和非 `c` 均静默丢弃，不产生部分写入或部分响应。
- 异步处理落地前检查组件仍挂载且 socket 为 OPEN。系统剪贴板读取失败与 Ctrl+Shift+C 一致：toast 来源为 `terminal-clipboard`、沿用既有文案、不发响应、不降级。

## 四、e2e 结果与用例清单

### 首轮

在真沙箱、临时后端 8100 与 preview 8200 环境中执行 4 个定向 spec，共 **28 / 28** 通过：

- `19-terminal-interaction`：**11** 条，设置 tab 顺序 / 默认激活、两个开关默认关闭与持久化、Shift+Enter 两态、终端内外右键边界与交互路径。
- `09-terminal-clipboard`：**5** 条，终端剪贴板与 OSC 52 双向 / 过滤相关路径。
- `16-cache-images`：**4** 条，既有缓存镜像清单回归。
- `03-terminal`：**8** 条，既有终端主链路回归。

### 修复轮

首轮审查后的修复轮复跑 `19-terminal-interaction` 与 `16-cache-images`，共 **15 / 15** 通过；全程 0 失败、0 跳过、0 flaky。随后执行第二次全量口径，故本轮最终全量数字不止代表上述定向 spec。

### 全量口径（本轮第二次全量）

在真沙箱、临时后端 8100 与构建后 preview 8200 环境中执行：

```bash
pnpm exec playwright test --config=tests/playwright.config.ts
```

结果为 **88 通过 / 0 失败 / 0 跳过 / 0 flaky**，耗时 **14.4 分钟**，退出码 **0**。基线为上一轮「文件注入副本刷新」的 **77** 条，本轮新增 `19-terminal-interaction` **11** 条；此前首次仅为定向验证，不计入本次全量口径。

## 五、回归影响与修复

设置抽屉默认 tab 改为「通用设置」后，`01-lifecycle.spec.ts` 的「设置抽屉：刷新状态与重启代理两个按钮在代理设置区里」用例因代理面板 `keepMounted` 但不可见而失败。已补 `switchSettingsTab(page, 'proxy')`，断言强度不变。排查确认 `07-templates`、`16-cache-images`、`19-terminal-interaction` 以及抽屉宽度用例均不受影响。

## 六、审查与修复轮

审查结论为 **零 Critical**。8 条 Warning 全部处理：

- OSC 52 增加 base64 长度预检，并保留解码后字节数二次校验；
- 补齐 7 条组件级负向测试；
- 增强 e2e 清场健壮性；
- 去掉固定 `waitForTimeout`；
- 在 `apps/web/frontend/tests/README.md` 登记 64 KiB 超限仍无真机 e2e 覆盖；
- 在前端 README 登记新标识与语义；
- 文档类 warning 由本次收口处理，包含 PRD 证据、任务状态、约定、看板与清单同步。

## 七、已知边界与留白

1. **桌面形态右键菜单与剪贴板已由用户真机验收通过**：用户确认网页与桌面形态均通过，桌面右键菜单抑制与剪贴板读写无问题；右键复制成功清除选区、失败保留选区的语义也由组件单测与定向 e2e 覆盖。
2. **64 KiB 超限只有纯函数与组件单测覆盖**，无真机 e2e 覆盖；该缺口已在 `apps/web/frontend/tests/README.md` 登记。
3. **本平台终端不应答 kitty 键盘协议协商**：pi 的 kitty 查询不会收到 `CSI ? <flags> u` 应答；原因是前端 xterm.js 5.5 不支持该协议，服务端模拟器不注册应答回调。因此依赖扩展协议的其他按键（例如 Ctrl+Enter 之类）仍需前端逐个合成。Shift+Enter 已通过前端直接发送 `ESC[13;2u` 规避该限制。
4. **容器内程序可任意写宿主剪贴板**：沿既有「容器内程序视为受信」口径，用户已明确接受，登记为信任边界；本轮不做白名单或确认弹窗。
5. **OSC 52 内容不随快照恢复**：快照只恢复屏幕状态，不重放控制序列；重连后不补发，属预期行为。
6. **剪贴板读写仍依赖安全上下文与浏览器 / WebView2 权限**：非安全上下文走失败 toast，不做降级，沿既有口径。

## 八、提交链

前置收口代码提交链仍按原记录保留：

1. `cdd2c3f` `feat(web): 通用设置 tab 与终端交互偏好层`
2. `5f362aa` `feat(web): 终端 Shift+Enter 映射、右键与 OSC 52 剪贴板`
3. `02a3a15` `test(web): 终端交互定向 e2e 与标识文档同步`
4. `60c4669` `docs(terminal-ux): 立项、验收留档与前端约定同步`
5. `984c657` `test(web): 设置抽屉默认 tab 变更后代理区用例补切 tab`

收口后修正：`f3d7f14 fix(web): Shift+Enter 改发 kitty CSI-u 序列 ESC[13;2u`，已推送 `origin/main`。本次文档变更不纳入上述代码提交链。

## 九、用户真机验收与发布

2026-11-26，用户已完成网页形态与桌面形态手工验收，均通过；桌面右键菜单抑制与剪贴板读写确认无问题。用户同时在 pi 内实测 `Shift+Enter` 换行通过，确认收口修正有效。

代码修正提交 `f3d7f14 fix(web): Shift+Enter 改发 kitty CSI-u 序列 ESC[13;2u` 已推送 `origin/main`。发布提交 `409d2ac chore(release): 版本号 0.2.0`、`5f3a09e docs(terminal-ux): 收口验收、Shift+Enter CSI-u 修正与 v0.2.0 发布留档` 已推送；annotated tag `v0.2.0` 已推送，推送前 `scripts/verify-release-version.mjs v0.2.0` 校验通过（matches 5 version files）。

Actions run `45832306595` 已 completed，结论为 `success`：<https://github.com/Nick-LCY/DevSandbox/actions/runs/45832306595>；`build-windows`、`deploy-worker`、`create-release` 三个 job 全部 `success`。GitHub 正式 Release `v0.2.0` 已创建（<https://github.com/Nick-LCY/DevSandbox/releases/tag/v0.2.0>），资产 `DevSandbox-0.2.0-windows-x64-setup.exe`，大小 4,457,358 字节（约 4.25 MB）。Cloudflare 前端 `https://dev.sankabox.com` 返回 200，确认部署后的新产物线上可达。

未带令牌访问 `https://sandbox-api.sankabox.com/api/health` 返回 401，属于预期的鉴权行为，不是故障。宿主侧后端服务未随本次发布重启或更新；本轮为前端改动，后端零改动。

## 十、本机人工验收方式（已执行，保留为历史记录）

**以下为收口时的验收步骤，用户已于 2026-11-26 执行并通过，本节保留作为复验指引。**

1. **起新版后端**（8000 已被现有服务占用，另起 8100）——**在仓库根目录执行**（`--project apps/web/backend` 是相对仓库根的路径）：

   ```bash
   SANDBOX_CONSOLE_HOST=127.0.0.1 SANDBOX_CONSOLE_PORT=8100 \
     uv run --project apps/web/backend python -m sandbox_console
   ```

   令牌用**本人现有配置**或本机令牌，**不要把 secret 抄进文档或截图**。
2. **另开一个终端起前端**（nvm 22 + pnpm）——**先切到前端目录、切到 Node 22**，再**先 build、后 preview**：

   ```bash
   cd apps/web/frontend
   source "$HOME/.nvm/nvm.sh"
   nvm use 22
   pnpm run build
   pnpm run preview --host 127.0.0.1 --port 8200 --strictPort
   ```

   **`pnpm run build` 不能省**：preview 伺服的是 `dist` 静态产物，不先 build 就会伺服旧产物，看不到本轮界面改动。
3. **设置里填**后端地址 `http://127.0.0.1:8100` 与管理令牌，连接后打开「通用设置」，确认终端交互区的两个开关默认关闭；新建一个临时沙箱。
4. **Shift+Enter 点验**：关闭「Shift+Enter 映射」时确认终端仍发送回车 `0x0d`；开启后，终端发送 kitty CSI-u `ESC[13;2u`，取证建议执行 `stty -icanon -icrnl -echo; cat -v`，观察 `^[[13;2u`。**不要用 `ESC+CR`，kitty 未激活时会被 pi 解释为 `alt+enter` 而直接发送消息。**在 pi 内按 `Shift+Enter` 确认换行，不直接发送消息。
5. **右键与剪贴板点验**：开启终端右键开关，在终端内有选区时右键复制、无选区时右键粘贴；确认终端外右键不被接管、终端内不弹原生菜单，网页与桌面形态均可用。Windows WebView2 原生菜单抑制与剪贴板权限**已由用户于 2026-11-26 在桌面形态确认**。
6. **OSC 52 点验**：确认容器内程序通过 OSC 52 设置选择区 `c` 能写入系统剪贴板、查询选择区 `c` 能读回并收到响应；确认 `p`、`s` 与 cut buffer 被忽略，超限或读取失败不产生部分写入或响应。

## 十一、核销结论

- PRD 验收标准已逐条挂证据；证据分为真沙箱 e2e、单测、设计口径三档。64 KiB 超限明确只有单测证据；用户网页与桌面形态手工验收已通过，桌面右键菜单抑制与剪贴板读写确认无问题。
- 任务 01~05 全部 `done`；定向 e2e 首轮 28 / 28，修复轮 15 / 15；第二次全量 e2e **88 / 88**，14.4 分钟，退出码 0。
- 本轮后端 / 核心包零改动，零新增依赖；Shift+Enter 修正提交 `f3d7f14` 已推送 `origin/main`。annotated tag `v0.2.0` 已推送，Actions run `45832306595` 成功，GitHub Release 与 Cloudflare 前端线上产物已更新；宿主侧后端服务未重启或更新。
- 看板与索引收口见 [[current-state.md|当前状态]]、[[prds/README.md|需求清单]]、[[tasks/README.md|任务清单]]；后续保留 64 KiB 真机覆盖与 kitty 协商应答能力边界两项非阻断留白。
