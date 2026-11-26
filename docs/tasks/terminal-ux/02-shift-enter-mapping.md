---
prd: prds/terminal-ux.md
status: done
---
# 任务：终端 Shift+Enter 映射开关接线

## 目标

- 将任务 01 的 `Shift+Enter` 偏好接入当前 xterm 终端键盘处理路径。
- 开启时让终端对 `Shift+Enter` 严格发送 kitty CSI-u 序列 `ESC[13;2u`（7 字节：`0x1b 0x5b 0x31 0x33 0x3b 0x32 0x75`）；关闭时保持现有 `0x0d` 行为。
- 只改变这一组按键映射，不改变既有 Ctrl / Meta / Alt 组合分类、浏览器保留键、Ctrl+C、Ctrl+V 与剪贴板快捷键语义。
- 把映射判断收敛到既有终端纯逻辑 / 测试边界，确保终端实例常驻与重连路径读取到当前偏好。

## 完成标准

- [x] 开关关闭时 `Shift+Enter` 发送单个 `0x0d`，与现状一致。
- [x] 开关开启时 `Shift+Enter` 发送且仅发送 kitty CSI-u 序列 `ESC[13;2u`（7 字节）。
- [x] 偏好在终端已连接、切换会话、终端重挂载和重连后均使用当前值，不产生重复字节。
- [x] Ctrl+C 仍发送既有 SIGINT 语义，Ctrl+V 仍发送字面量 `0x16`，浏览器保留键仍交回浏览器。
- [x] Ctrl+Shift+C / Ctrl+Shift+V 仍走既有剪贴板路径，未被新的映射规则吞掉。
- [x] 新增与既有键盘分类单测覆盖开关两态和回归组合；不改后端与核心包。

## 进展

- 已交付：`terminal-shortcuts.ts` 新增 `shiftEnter` 分类，优先级位于 forward 之后、plain 之前；`TerminalView` 统一经 `sendInput()` 发字节，开关关闭时为 `0x0d`。原实现曾在开启时发 `ESC+CR`，但收口后经 pi 1.6.1 源码确认：启动查询 `ESC[>7u ESC[?u` 只有收到非零 flags 的 `CSI ? <flags> u` 才激活 kitty 协议；本链路前端 xterm.js 5.5 不支持该协议、服务端模拟器不应答，故始终未激活，`ESC+CR` 会被解析成 `alt+enter`（`app.message.followUp`，直接发送消息）。已修正为 pi 自身的 `NATIVE_SHIFT_ENTER_SEQUENCE`：kitty CSI-u `ESC[13;2u`，该分支不依赖协议激活；用户已在 pi 内实测换行通过。修正提交：`f3d7f14 fix(web): Shift+Enter 改发 kitty CSI-u 序列 ESC[13;2u`，已推送 `origin/main`。偏好经 ref 读取，切换不重建终端或 WebSocket，既有快捷键分类语义不变。
- 门禁：定向 vitest **107 passed**（TerminalView 35 / SettingsDialog 44 / terminal-shortcuts 28）；`pnpm run typecheck` 与 `typecheck:tests` **双零错**；build 成功；定向真沙箱 e2e `19-terminal-interaction` **11 / 11**（48.9 s）。

## 收口后修正

原实现发 `ESC+CR`。用户在 pi 内实测发现开启开关后 `Shift+Enter` 不换行而是直接发送消息；根因是本链路不应答 pi 1.6.1 的 kitty keyboard protocol 查询，未激活态下 pi 将 `ESC+CR` 解析为 `alt+enter`。已改发 kitty CSI-u `ESC[13;2u`（7 字节），其解析分支不依赖协议激活；用户复测通过。提交 `f3d7f14` 已推送 `origin/main`。

## 依赖

- 依赖 [[tasks/terminal-ux/01-preferences-and-general-settings.md|01 偏好存储与通用设置]]：使用其偏好存储与「通用设置」开关。
- 后续：[[tasks/terminal-ux/03-terminal-context-menu-clipboard.md|03 终端右键接管]]、[[tasks/terminal-ux/04-osc52-clipboard-interop.md|04 OSC 52 互通]] 在本任务的终端事件接线稳定后继续。
