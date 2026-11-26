---
prd: prds/terminal-ux.md
status: done
---
# 任务：验收与文档收口

## 目标

- 在任务 01~04 的实现与定向测试完成后，执行终端交互增强的定向 e2e，覆盖设置抽屉、两个开关、右键复制 / 粘贴、OSC 52 双向和既有语义回归。
- 按项目门禁执行前端单测、类型检查、构建及约定的全量验证；如有环境限制或失败，按真实结果留档，不把未完成项写成通过。
- 按既有前端约定重跑中文字体子集，核对新增设置与 toast 文案在产物中可显示。
- 同步前端 README 标识表、PRD 验收清单、任务集状态和 current-state；登记 OSC 52 的已知信任边界。
- 形成本轮验收证据与留档，确认后端与核心包没有被修改。

## 完成标准

- [x] 定向 e2e 覆盖通用设置 tab 顺序 / 默认激活、两个开关默认关闭与持久化。——**证据**：真沙箱 `19-terminal-interaction` **11 / 11**，本轮首轮 4 个 spec 合计 **28 / 28**。
- [x] 定向 e2e 覆盖 `Shift+Enter` 开关两态、终端右键终端内外边界、有选区复制和无选区粘贴。——**证据**：真沙箱 `19-terminal-interaction` **11 / 11** 与 `09-terminal-clipboard` **5 / 5**。
- [x] 定向 e2e 或等价可挂证据覆盖原生菜单 / xterm 右键行为被阻止，以及 `terminal-clipboard` 失败 toast。——**证据**：组件级负向单测 + 真沙箱定向 e2e；桌面 WebView2 原生菜单仍未做真机验证。
- [x] 定向 e2e 或协议级测试覆盖 OSC 52 设置与查询双向、`c` 过滤、`p` / `s` / cut buffer 忽略、64 KiB 上限和读取失败不响应。——**证据**：`09-terminal-clipboard` **5 / 5** + OSC 52 纯函数 / 组件单测；64 KiB 超限无真机 e2e。
- [x] 前端单测、类型检查、构建与本轮约定的前端门禁全量验证按实际结果留档；失败项有明确归因，不虚报通过。——**证据**：vitest **1093 / 59 files**、typecheck 双零、build 成功；全量 e2e 未跑。
- [x] `build-fonts.sh` 已按新增中文文案重跑并核对字体产物，前端 README 标识表已同步。——**证据**：字符集 3648（非 ASCII 3553），6 个 woff2；标识已登记。
- [x] PRD 验收标准逐条挂证据；任务 01~04 在证据充分后更新为 `done`，本任务完成后更新为 `done`。——**证据**：PRD 20 条逐条挂真沙箱 e2e / 单测 / 设计口径；01~05 全部 `done`。
- [x] current-state 看板、PRD 清单、任务清单与本任务集索引均与最终状态一致；OSC 52 受信边界与未做桌面剪贴板插件的条件已留档。——**证据**：相关文档已同步；桌面 WebView2、全量 e2e 与用户手工验收作为未含项留档。

## 进展

- 已交付：本轮自动化验收覆盖设置抽屉、偏好默认值 / 持久化、`Shift+Enter` 两态、终端右键边界与剪贴板路径、OSC 52 双向与过滤；完成前端全量 vitest、双 typecheck、字体构建和 production build，PRD 验收标准逐条挂证据，任务 01~05 全部收口。
- 门禁：首轮定向 e2e 4 个 spec **28 / 28**（`19-terminal-interaction` 11、`09-terminal-clipboard` 5、`16-cache-images` 4、`03-terminal` 8）；修复轮复跑 `19` + `16` **15 / 15**；全程 **0 失败 / 0 跳过 / 0 flaky**。前端 vitest **1093 passed / 59 files**，typecheck 双零错，字体脚本成功（3648 字符、6 个 woff2），build 成功（2924 个模块）。

### 本轮验收范围与未含项

- 范围：网页形态真沙箱定向 e2e、前端单测 / 类型检查 / 构建 / 字体门禁，以及前端 README 标识、PRD、任务集、RESULTS、约定和看板收口；后端与核心包零改动，零新增依赖，未部署、未 push。
- 未含项：桌面形态 Windows WebView2 真机验证未做；全量 e2e 未跑（本轮仅跑定向 spec）；64 KiB 超限无真机 e2e，只有纯函数与组件单测；用户手工验收尚未执行。

## 依赖

- 依赖 [[tasks/terminal-ux/01-preferences-and-general-settings.md|01 偏好存储与通用设置]]、[[tasks/terminal-ux/02-shift-enter-mapping.md|02 Shift+Enter 映射]]、[[tasks/terminal-ux/03-terminal-context-menu-clipboard.md|03 终端右键接管]]、[[tasks/terminal-ux/04-osc52-clipboard-interop.md|04 OSC 52 互通]] 全部完成，且各自定向验证无待修项。
- 本任务完成后本轮任务集与 PRD 已收口；桌面真机、全量 e2e 和用户手工验收仍按留白登记。
