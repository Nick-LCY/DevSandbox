# 终端交互增强任务集

本目录是**终端交互增强**任务集，需求见 [[prds/terminal-ux.md|终端交互增强 PRD]]。本轮只涉及前端体验：设置抽屉「通用设置」tab、`Shift+Enter` 映射、终端内右键复制 / 粘贴和常开的 OSC 52 剪贴板互通；后端与核心包不改。

**状态：01~05 全部 done，2026-11-26 收口。** 自动化验收完成：前端 vitest **1093 passed / 59 files**，typecheck 双零错，字体构建与 build 成功；定向真沙箱 e2e 首轮 **28 / 28**，修复轮 **15 / 15**，全程 0 失败 / 0 跳过 / 0 flaky。桌面 Windows WebView2 真机、全量 e2e 与用户手工验收仍是留白，详见 [[tasks/terminal-ux/RESULTS.md|全轮留档]]。

## 任务清单

| 编号 | 任务 | 状态 | 交付内容 |
|---|---|---|---|
| [[tasks/terminal-ux/01-preferences-and-general-settings.md\|01]] | 偏好存储层与设置抽屉「通用设置」tab 改造 | done | 两个布尔偏好与默认关闭、tab 重排 / 改名 / 默认激活、终端交互区、既有连接配置表单保留 |
| [[tasks/terminal-ux/02-shift-enter-mapping.md\|02]] | 终端 Shift+Enter 映射开关接线 | done | 开启发送 `0x1b 0x0d`、关闭保持 `0x0d`、既有终端快捷键语义回归覆盖 |
| [[tasks/terminal-ux/03-terminal-context-menu-clipboard.md\|03]] | 终端右键复制 / 粘贴接管 | done | 仅 xterm 区域 capture 接管、有选区复制、无选区 `term.paste`、阻止原生菜单与 xterm 右键行为 |
| [[tasks/terminal-ux/04-osc52-clipboard-interop.md\|04]] | OSC 52 剪贴板双向互通 | done | 选择区 `c` 双向桥接、忽略 `p` / `s` / cut buffer、64 KiB base64 预检与字节二次校验、读取失败不响应 |
| [[tasks/terminal-ux/05-acceptance-and-docs.md\|05]] | 验收与文档收口 | done | 定向 e2e、门禁全量、字体子集重跑、前端 README 标识表同步、PRD 核销与留档；全量 e2e 未跑、桌面真机待验收 |

## 依赖顺序

```text
01 ──▶ 02 ──▶ 03 ──▶ 04 ──▶ 05
```

- **01 → 02**：键盘映射需要先有稳定的偏好读取与「通用设置」开关。
- **02 → 03**：右键接管与键盘 / 剪贴板事件共用终端接线，先固定 `Shift+Enter` 不影响既有快捷键的边界。
- **03 → 04**：OSC 52 复用系统剪贴板失败 toast、`terminal-clipboard` 来源和终端实例接线，先确认右键路径不绕过 `term.paste`。
- **04 → 05**：收口任务必须在 OSC 52 双向、过滤、上限与失败语义已有定向证据后执行。
- **全量门禁只在 05**：01~04 只做各自定向验证；05 在前置任务全部完成且无待修项后执行项目门禁全量，并如实留档。

## 关键前置风险

| 风险 | 影响 | 处置口径 |
|---|---|---|
| 设置 tab 重排与既有 keepMounted 口径冲突 | 切 tab 可能丢状态或重复请求 | 沿用既有 Base UI Tabs 封装；验收断言顺序、默认激活与既有 tab 行为 |
| `Shift+Enter` 误伤既有快捷键分类 | Ctrl+C / Ctrl+V、保留键或剪贴板快捷键回归 | 仅在明确组合命中时映射，纯逻辑单测逐项覆盖既有语义 |
| 右键事件范围过宽 | 终端外页面被接管，或 xterm 原生选区 / 菜单残留 | 先判定当前 xterm 区域，再阻止默认行为；终端外不处理 |
| 粘贴绕过 xterm | 括号粘贴与换行归一失效 | 无选区右键粘贴必须调用 `term.paste`，不直接写 socket |
| OSC 52 方向或选择区处理错误 | 容器程序拿不到剪贴板，或误处理 `p` / `s` / cut buffer | 只处理 `c`，分别取证设置与查询响应，过滤项必须有负向断言 |
| payload 上限与部分处理 | 超限时出现截断写入或半截 PTY 响应 | 在 64 KiB 边界实施完整拒绝，超限不产生部分副作用 |
| 系统剪贴板权限 / 安全上下文失败 | 右键粘贴或 OSC 52 查询无声失败，或错误降级 | 失败 toast 来源固定 `terminal-clipboard`；读取失败不发送响应、不加桌面插件，除非真机实测读取被拒 |
| 容器内程序信任边界 | OSC 52 可读写用户系统剪贴板 | 沿既有「容器内程序视为受信」口径登记为已知边界，不新增权限模型 |
| 新增中文文案导致字体缺字 | 真机出现方框 | 05 重跑 `build-fonts.sh` 并核对产物，再更新前端 README 标识表与留档 |

## 任务文件

- [[tasks/terminal-ux/01-preferences-and-general-settings.md]] — 偏好存储层与「通用设置」tab 改造。
- [[tasks/terminal-ux/02-shift-enter-mapping.md]] — `Shift+Enter` 映射接线。
- [[tasks/terminal-ux/03-terminal-context-menu-clipboard.md]] — 终端右键复制 / 粘贴接管。
- [[tasks/terminal-ux/04-osc52-clipboard-interop.md]] — OSC 52 双向剪贴板互通。
- [[tasks/terminal-ux/05-acceptance-and-docs.md]] — 验收与文档收口（**done：2026-11-26**；定向 e2e 首轮 28 / 28、修复轮 15 / 15；全量 e2e 未跑，桌面真机与用户手工验收待执行）。
- [[tasks/terminal-ux/RESULTS.md]] — 终端交互增强全轮收口留档（01~05；前端 vitest 1093 / 59 files、typecheck 双零、build 成功；定向真沙箱 e2e 28 / 28 + 修复轮 15 / 15）。
