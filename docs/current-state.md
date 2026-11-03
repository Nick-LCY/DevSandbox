# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 活跃需求
- **三期：桌面端打包（Tauri）与端口转发** — 现有前端产物装进 Tauri 桌面壳（纯连接器：只装前端 + 后端地址 + token，不拉起后端）+ 后端改造成 token 认证的独立 API（浏览器侧 WS 走一次性票据）+ 用户显式指定的沙箱端口经后端隧道转发到桌面本机 `127.0.0.1`。**现状（2026-11-03）：01 doing**——P4 自有 Windows 机器本地构建路径已验证（环境 / 耗时 / 产物形态待正式记录）、P2 控制台三项待调试构建（`pnpm tauri dev`）复验、xterm 真渲染待 03 后端连通后验；**02 done**——后端全部 `/api` 受令牌保护、票据、CORS 白名单、WS Origin 校验，但未改造的网页前端在 03 落地前拿不到数据（前端不带 `Authorization` 头），**按部署口径 02 须与 03 同批发布**；03~09 todo。需求见 [[prds/phase3-desktop.md|三期 PRD]]，任务集见 [[tasks/phase3-desktop/README.md|三期任务集]]，决策依据见 [[architecture/decisions/0013-三期定位改定与认证重启.md|0013]]、[[architecture/decisions/0014-端口转发机制选型.md|0014]]、[[architecture/decisions/0015-桌面壳与连接配置抽象.md|0015]]。
- 历史交付的叙事与验收留档：git 历史 + [[tasks/README.md|docs/tasks/ 各留档页]]。

## 规划
> 以下为用户已拍板、尚未立项的方向；立项后再补 PRD 与任务集，并在下方任务看板挂行。

- **终端会话顺序与快捷键切换标签**：沙箱内多个终端会话按稳定顺序排列，支持键盘快捷键在标签之间切换；控制台小型体验轮。

## 任务看板
| 任务集 | 状态 | 入口 |
|---|---|---|
| 三期：桌面端打包 + 端口转发 | doing（01 doing、02 done 待与 03 同批发布、03~09 todo） | [[tasks/phase3-desktop/README.md\|三期任务集]]（9 个任务；打样轮 01 是全期前置硬门槛） |

## TODO / 阻塞
- [ ] 统一镜像代理缓存 GC 命令待做。
- [ ] sandboxctl 增加文件注入参数（如 `--file`）——文件注入轮核心能力已落地，待补命令行入口。
- [ ] 文件注入降级路径收口（终审遗留，不阻断使用）：预检阶段纳入本次目标沙箱的计划家目录（消除干跑/实跑对自家目录的口径差）；getent / test -d / readlink 失败时从静默放行改为可观测（error 日志 + API.md 写明降级行为）。
- [ ] 三期 01 收口：P4 已部分闭合（自有 Windows 机器本地构建路径可行；环境 / 耗时 / 产物形态待正式记录），P2 控制台三项（`CSS.supports('color', 'oklch(...)')`、`window.isSecureContext`、剪贴板读写）待用户以调试构建（`pnpm tauri dev`）复验后判定，xterm 真渲染待 03 后端连通后验，P5（WebView2 运行时策略）无新信息；实测回填 [[tasks/phase3-desktop/RESULTS.md|RESULTS.md]] 后闭合 [[tasks/phase3-desktop/01-prototype-and-spike.md|任务 01]]。
- 阻塞项：无。
