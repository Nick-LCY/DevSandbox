# 终端交互增强：全轮收口留档（2026-11-26）

> 本轮范围全部在前端 `apps/web/frontend`：设置抽屉「通用设置」、两个终端交互偏好、`Shift+Enter` 映射、终端内右键复制 / 粘贴接管和常开 OSC 52 剪贴板互通。`apps/web/backend` 与 `apps/core` 零改动，零新增依赖；未部署、未 push。
> 需求见 [[prds/terminal-ux.md|终端交互增强 PRD]]，任务集见 [[tasks/terminal-ux/README.md|终端交互增强任务集]]，约定见 [[conventions/console-frontend.md|控制台前端约定]]。

**状态：01~05 全部 done。** 自动化验收已完成：定向真沙箱 e2e 首轮 28 / 28、修复轮 15 / 15，第二次全量真沙箱 e2e 88 / 88（14.4 分钟，0 失败 / 0 跳过 / 0 flaky，退出码 0）；桌面 Windows WebView2 真机验证与用户手工验收仍是留白，不能据此写成用户已验收、已部署或已 push。

## 一、轮次总表

| 任务 | 交付 | 状态 | 收口日期 |
|---|---|---|---|
| [[tasks/terminal-ux/01-preferences-and-general-settings.md\|01 偏好存储与通用设置]] | 两个独立 localStorage 偏好、默认关闭、非法值回落关闭；设置抽屉 tab 改为「通用设置 → 代理 → 模板」，通用设置默认激活并承载终端交互区与原连接配置表单 | done | 2026-11-26 |
| [[tasks/terminal-ux/02-shift-enter-mapping.md\|02 Shift+Enter 映射]] | `shiftEnter` 分类与统一 `sendInput()`；开关开时 `0x1b 0x0d`，关时 `0x0d`；切换不重建终端 / WebSocket | done | 2026-11-26 |
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
| 范围核对 | 后端 / 核心包 / 依赖 / 发布 | `apps/web/backend` 与 `apps/core` 零改动；零新增依赖；未部署、未 push |

## 三、机制与关键口径

### 设置与偏好

- 设置抽屉 tab 顺序固定为 **通用设置（默认激活）→ 代理 → 模板**；旧 testid `page-settings-tab-backend` 退役。
- 「通用设置」内是 `page-settings-terminal-interaction` 区，包含 `page-settings-terminal-shift-enter-switch` 与 `page-settings-terminal-right-click-switch` 两个开关；连接配置表单字段与行为不变。
- 两个 localStorage 键相互独立：`sandbox-console-terminal-shift-enter-escape` 与 `sandbox-console-terminal-right-click-clipboard`。值只认 `'1'` / `'0'`；缺失、非法值、读写异常均回落关闭；挂载不写存储；两个开关默认关闭。
- Switch 使用 Base UI 封装 `src/components/ui/switch.tsx`，无 Radix、无新增依赖。

### Shift+Enter

- `terminal-shortcuts.ts` 新增 `shiftEnter` 分类，优先级在 forward 之后、plain 之前，不污染既有分类语义。
- `TerminalView` 抽出统一 `sendInput()`：偏好开启发送严格的 `0x1b 0x0d`，关闭保持 `0x0d`。
- 偏好由 ref 读取，开关切换不重建终端实例或 WebSocket；Ctrl / Meta / Alt、浏览器保留键、Ctrl+Shift+C / Ctrl+Shift+V 语义保持不变。

### 右键 capture

- 终端容器在 capture 阶段监听 `contextmenu`；只有事件目标在当前 `term.element` 内才接管，并执行 `preventDefault()` + `stopPropagation()`。
- 有选区复用既有 Ctrl+Shift+C 复制路径；无选区读取 `navigator.clipboard.readText()` 后调用 `term.paste()`，不直接写 socket。
- 右键偏好关闭、点击终端外、组件卸载后均不接管；卸载会移除监听。复制成功零反馈，失败沿用 `terminal-clipboard` toast。

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

1. **桌面形态右键菜单抑制未做真机验证**：网页形态已自动验收通过；Windows WebView2 上 `preventDefault(contextmenu)` 能否抑制原生菜单、剪贴板读写是否正常，均待用户在真机确认。
2. **64 KiB 超限只有纯函数与组件单测覆盖**，无真机 e2e 覆盖；该缺口已在 `apps/web/frontend/tests/README.md` 登记。
3. **容器内程序可任意写宿主剪贴板**：沿既有「容器内程序视为受信」口径，用户已明确接受，登记为信任边界；本轮不做白名单或确认弹窗。
4. **OSC 52 内容不随快照恢复**：快照只恢复屏幕状态，不重放控制序列；重连后不补发，属预期行为。
5. **剪贴板读写仍依赖安全上下文与浏览器 / WebView2 权限**：非安全上下文走失败 toast，不做降级，沿既有口径。
6. **用户手工验收尚未执行**：自动化验收已完成，但真实用户尚未按下一节方式走查网页与桌面形态。

## 八、提交链（本地，未 push）

代码收口核对时工作树干净；以下 **5 个提交全部留在本地、未 push**。本次文档补记属于后续 docs 变更，不纳入以下提交链：

1. `cdd2c3f` `feat(web): 通用设置 tab 与终端交互偏好层`
2. `5f362aa` `feat(web): 终端 Shift+Enter 映射、右键与 OSC 52 剪贴板`
3. `02a3a15` `test(web): 终端交互定向 e2e 与标识文档同步`
4. `60c4669` `docs(terminal-ux): 立项、验收留档与前端约定同步`
5. `984c657` `test(web): 设置抽屉默认 tab 变更后代理区用例补切 tab`

## 九、本机人工验收方式（尚未执行）

以下步骤由用户在本机执行；本次文档收口没有拉起或停止任何进程。使用临时测试沙箱和测试固定令牌，不要把真实令牌写入文档或截图。

1. 在仓库根目录启动临时后端 8100：

   ```bash
   SANDBOX_CONSOLE_HOST=127.0.0.1 SANDBOX_CONSOLE_PORT=8100 \\
     uv run --project apps/web/backend python -m sandbox_console
   ```

2. 另开终端启动前端 preview 8200。先切 Node 22，先 build 再 preview：

   ```bash
   cd apps/web/frontend
   source /home/sankabox/.nvm/nvm.sh
   nvm use 22
   pnpm run build
   pnpm run preview --host 127.0.0.1 --port 8200 --strictPort
   ```

3. 浏览器打开 preview，设置后端地址为 `http://127.0.0.1:8100`，填入测试固定令牌，连接后新建一个临时真沙箱。

4. 点验设置与 Shift+Enter：
   - 打开设置抽屉，确认 tab 顺序为「通用设置 → 代理 → 模板」，默认落在「通用设置」，两个开关均为关闭；分别打开后刷新页面，确认选择保留。
   - 开关关闭时，在终端执行 `stty -icrnl; cat -v`，按 Shift+Enter，观察为回车字节；打开开关后重复，观察为 `^[` 后跟回车（即 `0x1b 0x0d`）。结束 `cat` 后恢复 shell。

5. 点验右键：
   - 打开「右键复制 / 粘贴」开关，在终端产生可选文本并框选，终端内右键后检查系统剪贴板；清除选区，将系统剪贴板换成一段测试文本，终端内无选区右键，确认文本经终端粘贴进入。
   - 右键点终端外，确认网页原有行为未被接管；关闭开关后重复终端内右键，确认本轮逻辑不接管。Windows WebView2 原生菜单抑制与剪贴板权限仍需真机确认。

6. 点验 OSC 52（真沙箱内执行，先执行 set，再执行 query）：

   ```bash
   printf '\033]52;c;%s\a' "$(printf '%s' 'terminal-ux-osc52-check' | base64 -w0)"
   ```

   执行后在宿主系统剪贴板粘贴，预期得到 `terminal-ux-osc52-check`。再在真沙箱中运行下面命令，让程序发出 OSC 52 query 并读取前端回写的响应：

   ```bash
   python3 -c 'import os,termios,tty; old=termios.tcgetattr(0); tty.setraw(0); os.write(1,b"\033]52;c;?\a"); data=os.read(0,4096); termios.tcsetattr(0,termios.TCSANOW,old); print(repr(data))'
   ```

   预期 `repr` 中出现 `\\x1b]52;c;` 及系统剪贴板内容的 base64。若浏览器处于非安全上下文或权限被拒，预期是 `terminal-clipboard` 失败 toast，且不收到 query 响应；不做降级。

## 十、核销结论

- PRD 验收标准已逐条挂证据；证据分为真沙箱 e2e、单测、设计口径三档。64 KiB 超限明确只有单测证据，桌面真机与用户手工验收未被写成通过。
- 任务 01~05 全部 `done`；定向 e2e 首轮 28 / 28，修复轮 15 / 15；第二次全量 e2e **88 / 88**，14.4 分钟，退出码 0。
- 本轮只改前端范围内文档与已交付前端结果的留档信息；后端 / 核心包零改动，零新增依赖，未部署、未 push。
- 看板与索引收口见 [[current-state.md|当前状态]]、[[prds/README.md|需求清单]]、[[tasks/README.md|任务清单]]；后续保留桌面真机确认、视需要补 64 KiB 真机覆盖与用户手工验收三项本轮遗留待办。
