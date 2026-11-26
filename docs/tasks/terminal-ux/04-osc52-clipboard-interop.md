---
prd: prds/terminal-ux.md
status: done
---
# 任务：OSC 52 剪贴板双向互通

## 目标

- 在前端终端 xterm 实例注册 OSC 52 处理路径，提供无开关、常开的系统剪贴板互通。
- 只处理选择区 `c`：容器内程序设置剪贴板时写系统剪贴板；查询剪贴板时读取系统剪贴板、base64 编码并回写给 PTY。
- 忽略选择区 `p`、`s` 与 cut buffer，不产生系统剪贴板读写或查询响应。
- 对 OSC 52 payload 执行 64 KiB 上限，超限不产生部分写入或部分查询响应。
- 读取系统剪贴板失败时沿 Ctrl+Shift+C 的失败口径处理：弹失败 toast、来源 `terminal-clipboard`、不发送响应、不做降级。
- 登记「容器内程序视为受信」这一既有信任边界；不改后端、核心包、PTY 协议或权限模型。

## 完成标准

- [x] OSC 52 设置选择区 `c` 能将合法内容写入系统剪贴板，成功路径零反馈。
- [x] OSC 52 查询选择区 `c` 能读取系统剪贴板、按约定 base64 编码并回写给 PTY。
- [x] `p`、`s` 与 cut buffer 被忽略，且不会误触发系统剪贴板读写。
- [x] payload 在 64 KiB 边界内正常处理，超限被拒绝且不产生部分写入或部分响应。
- [x] 系统剪贴板读取失败弹失败 toast，来源为 `terminal-clipboard`，不发送响应、不做桌面插件或其他降级。
- [x] OSC 52 处理器在终端 reset、快照恢复、标签切换与重连路径中保持正确注册，不改变现有终端画面恢复语义。
- [x] 定向单测覆盖双向、选择区过滤、base64、边界、失败和信任边界登记；不改后端与核心包。

## 进展

- 已交付：OSC 52 常开且只处理选择区 `c`；set 写系统剪贴板，query 读系统剪贴板并经统一 `sendInput()` 回写 PTY，不走 `term.paste`；忽略 `p` / `s` / cut buffer。payload 先按 base64 长度预检 64 KiB，再按解码字节数二次校验；非法 base64、超限和非 `c` 静默丢弃，读取失败沿 `Ctrl+Shift+C` 口径 toast / 不响应 / 不降级。
- 门禁：定向真沙箱 e2e `09-terminal-clipboard` **5 / 5**，并纳入首轮 **28 / 28**；OSC 52 纯函数与组件单测覆盖双向、过滤、base64、边界和失败；前端全量 vitest **1093 passed / 59 files**，typecheck 双零错。

## 依赖

- 依赖 [[tasks/terminal-ux/01-preferences-and-general-settings.md|01 偏好存储与通用设置]]：前端设置抽屉与偏好存储层完成，确认 OSC 52 不受开关控制。
- 依赖 [[tasks/terminal-ux/02-shift-enter-mapping.md|02 Shift+Enter 映射]]、[[tasks/terminal-ux/03-terminal-context-menu-clipboard.md|03 终端右键接管]]：终端键盘与系统剪贴板既有接线口径稳定后进行互通验证。
- 后续：[[tasks/terminal-ux/05-acceptance-and-docs.md|05 验收与文档收口]] 负责真机 / e2e、全量门禁与文档收口。
