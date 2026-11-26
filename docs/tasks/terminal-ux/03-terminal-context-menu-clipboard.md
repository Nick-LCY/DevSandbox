---
prd: prds/terminal-ux.md
status: done
---
# 任务：终端右键复制 / 粘贴接管

## 目标

- 将任务 01 的终端右键偏好接入 xterm 终端区域的右键事件。
- 开启时仅在右键点位位于当前 xterm 终端区域内时接管；终端外点击保持原有行为。
- 终端内有选区时复用既有 Ctrl+Shift+C 复制路径；无选区时读取系统剪贴板并通过 `term.paste` 粘贴。
- 接管时阻止原生右键菜单与 xterm 自带右键选区行为；关闭时不改变 xterm / 浏览器现有右键行为。
- 复用既有终端剪贴板成功零反馈、失败 toast 和 `terminal-clipboard` 来源标识，不新增反馈口径或后端能力。

## 完成标准

- [x] 右键开关关闭时，终端内外均不走本轮接管逻辑。
- [x] 右键开关开启时，终端外右键不被阻止、不触发复制或粘贴。
- [x] 终端内右键有选区时，复制结果、成功零反馈、失败 toast 文案与来源标识均与 Ctrl+Shift+C 一致。
- [x] 终端内右键无选区时，系统剪贴板文本通过 `term.paste` 注入，未直接写 socket。
- [x] 终端内被接管的右键不会打开原生菜单，也不会触发 xterm 自带右键选区行为。
- [x] 系统剪贴板读取失败时弹失败 toast，来源为 `terminal-clipboard`，不静默降级。
- [x] 定向单测 / 组件测试覆盖开关两态、终端内外边界、有选区 / 无选区和失败反馈；不改后端与核心包。

## 进展

- 已交付：终端容器在 capture 阶段监听 `contextmenu`，仅当事件目标位于 `term.element` 内才接管并阻止默认与冒泡；有选区复用既有复制路径，无选区执行 `navigator.clipboard.readText()` 后调用 `term.paste()`，终端外或关闭时不接管，卸载移除监听。
- 门禁：定向真沙箱 e2e 首轮 4 个 spec **28 / 28** 通过（其中 `19-terminal-interaction` **11**、`09-terminal-clipboard` **5**）；修复轮复跑 `19` 与 `16` 共 **15 / 15**；前端全量 vitest **1093 passed / 59 files**，typecheck 双零错。

## 依赖

- 依赖 [[tasks/terminal-ux/01-preferences-and-general-settings.md|01 偏好存储与通用设置]]：使用其终端右键偏好与设置入口。
- 与 [[tasks/terminal-ux/02-shift-enter-mapping.md|02 Shift+Enter 映射]] 顺序衔接：共享终端键盘 / 剪贴板接线后再进入定向验证。
- 后续：[[tasks/terminal-ux/04-osc52-clipboard-interop.md|04 OSC 52 互通]] 复用本任务确认过的系统剪贴板失败口径。
