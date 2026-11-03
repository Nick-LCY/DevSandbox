# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 活跃需求
- **三期：桌面端打包（Tauri）与端口转发** — 现有前端产物装进 Tauri 桌面壳（纯连接器：只装前端 + 后端地址 + token，不拉起后端）+ 后端改造成 token 认证的独立 API（浏览器侧 WS 走一次性票据）+ 用户显式指定的沙箱端口经后端隧道转发到桌面本机 `127.0.0.1`。**现状（2026-11-03）：01 doing**——P4 自有 Windows 机器本地构建路径已验证（环境 / 耗时 / 产物形态待正式记录）、P2 控制台三项待调试构建（`pnpm tauri dev`）复验；**02 done + 03 doing**——02 后端侧（令牌 / 票据 / CORS 白名单 / WS Origin 校验）与 03 前端侧（连接配置抽象、未配置态引导面板、WS 票据对接、设置抽屉连接配置区、`base: './'`）**均已落地**，**按部署口径同批发布**后网页控制台恢复；03 只差第 2 条完成标准（同一份产物连同源 / 远端后端全链路可用）**待用户 Windows 真机 + 真后端复验**，**04 起可开工**。桌面侧 CSP 已按 [[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]] 收敛为「配置基线 + Rust 运行期 host 级动态生成」，打样轮的 `csp: null` 临时偏离闭合。**已知过渡态**：既有 Playwright 验收套件（9 条 spec）自 03 落地起为红（引导面板替换工作台 + 后端要求令牌），07 token 化后恢复——**勿当回归**。需求见 [[prds/phase3-desktop.md|三期 PRD]]，任务集见 [[tasks/phase3-desktop/README.md|三期任务集]]，决策依据见 [[architecture/decisions/0013-三期定位改定与认证重启.md|0013]]、[[architecture/decisions/0014-端口转发机制选型.md|0014]]、[[architecture/decisions/0015-桌面壳与连接配置抽象.md|0015]]。
- 历史交付的叙事与验收留档：git 历史 + [[tasks/README.md|docs/tasks/ 各留档页]]。

## 规划
> 以下为用户已拍板、尚未立项的方向；立项后再补 PRD 与任务集，并在下方任务看板挂行。

- **终端会话顺序与快捷键切换标签**：沙箱内多个终端会话按稳定顺序排列，支持键盘快捷键在标签之间切换；控制台小型体验轮。

## 任务看板
| 任务集 | 状态 | 入口 |
|---|---|---|
| 三期：桌面端打包 + 端口转发 | doing（01 doing、02 done、03 doing 待真机复验；02 与 03 同批发布；04~09 todo） | [[tasks/phase3-desktop/README.md\|三期任务集]]（9 个任务；打样轮 01 是全期前置硬门槛） |

## TODO / 阻塞
- [ ] 统一镜像代理缓存 GC 命令待做。
- [ ] sandboxctl 增加文件注入参数（如 `--file`）——文件注入轮核心能力已落地，待补命令行入口。
- [ ] 文件注入降级路径收口（终审遗留，不阻断使用）：预检阶段纳入本次目标沙箱的计划家目录（消除干跑/实跑对自家目录的口径差）；getent / test -d / readlink 失败时从静默放行改为可观测（error 日志 + API.md 写明降级行为）。
- [ ] **三期 Windows 真机复验（一次窗口合并四项）**：P2 控制台三项（`CSS.supports('color', 'oklch(...)')`、`window.isSecureContext`、剪贴板读写——须用调试构建 `pnpm tauri dev`，正式版构建没有 DevTools）+ 03 全链路（桌面壳按连接配置连真后端，同源 / 远端两形态，含 xterm 真渲染与剪贴板端到端验证）+ P4 正式记录（环境 / 耗时 / 产物形态）+ P5（WebView2 运行时策略），均待用户 Windows 真机；实测回填 [[tasks/phase3-desktop/RESULTS.md|RESULTS.md]] 后闭合 [[tasks/phase3-desktop/01-prototype-and-spike.md|任务 01]] 与 [[tasks/phase3-desktop/03-frontend-connection-layer.md|任务 03]] 的待复验项。
- 阻塞项：无。
