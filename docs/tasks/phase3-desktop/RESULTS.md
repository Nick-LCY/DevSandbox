# 三期留档（打样与实测结论）

> **留档说明**
> - 本文件是三期（桌面端打包 + 端口转发）的**打样与实测结论**留档，由 [[tasks/phase3-desktop/01-prototype-and-spike.md|任务 01]] 打样轮与 [[tasks/phase3-desktop/09-acceptance-and-docs.md|任务 09]] 收口轮填写。
> - 当前为**空模板**：三期尚未开工，四项打样结论（P1~P4）与各套测试数字均待填。
> - 关联页面：[[tasks/phase3-desktop/README.md|三期任务集]]、[[prds/phase3-desktop.md|三期 PRD]]、[[architecture/decisions/0014-端口转发机制选型.md|0014 端口转发机制选型]]、[[current-state.md|当前状态]]。

## 一、打样结论（任务 01 填）

| 编号 | 前置项 | 结论 | 关键输出 / 裁决 |
|---|---|---|---|
| **P1** | 免 root 守护进程 `-p` 发布宿主回环 | 待测 | （主路径 / Fallback B） |
| **P2** | Tauri v2 + WebView2 三项冒烟（`oklch` / xterm.js / `navigator.clipboard`） | 待测 | — |
| **P3** | 转发镜像经统一镜像代理可拉 | 待测 | — |
| **P4** | Windows 出包路径 | 待测 | （GitHub Actions / 自有 Windows 机） |
| **P5** | Windows 目标机器的 WebView2 运行时策略 | 待测 | — |

## 二、验收数字（任务 09 填）

| 项目 | 结果 | 基线 |
|---|---|---|
| 核心包 pytest | 待填 | — |
| 核心包 root 级用例 | 待填 | — |
| 服务端 pytest | 待填 | — |
| ruff（E4/E7/E9/F） | 待填 | — |
| 前端 vitest | 待填 | — |
| 前端 typecheck / typecheck:tests / build | 待填 | — |
| Playwright 真机 | 待填 | 既有 9 条 + 认证用例 + 端口转发用例 |
| Windows 冒烟结论 | 待填 | — |

## 三、已知边界

待填（宿主回环这一跳不受令牌保护、多路复用推迟、令牌轮换无 UI 等口径见 [[prds/phase3-desktop.md|三期 PRD]] 风险清单）。
