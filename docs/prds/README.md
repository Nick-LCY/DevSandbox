# 需求设计（PRD）

每个需求一个文件，放在本目录下，命名 `<feature>.md`。PRD 是任务拆分的输入。

## PRD 格式

```
# <需求名>

## 背景
为什么做这个。

## 目标
- 要达成什么

## 非目标
- 明确不做什么

## 方案
设计思路、关键决策。

## 验收标准
- [ ] ...
```

## 清单
- [[prds/sandbox-platform.md]] — Agent 开发沙箱平台：一期本地闭环 / 二期控制面服务化 / 三期代理与多沙箱运营（原三期已完整退役，三期现指桌面端打包轮，见 [[architecture/decisions/0001-项目定位与三期路线.md|ADR 0001 修订行]]）
- [[prds/phase2-console.md]] — 二期：控制面服务化与网页控制台（FastAPI 服务 + 网页控制台 + 网页终端）
- [[prds/console-templates.md]] — 控制台模板轮：基础镜像 0.3.0 通用工具层 + 网页控制台启动模板（存一套沙箱启动配置，下次一键回填）
- [[prds/file-injection.md]] — 文件注入轮：创建沙箱时把宿主文件复制进沙箱（复制 + chown，敏感凭证不经权限放开即可进容器）
- [[prds/phase3-desktop.md]] — 三期：桌面端打包（Tauri）与端口转发（桌面壳 + token 认证连接层 + 沙箱端口转发，决策依据见 ADR 0013 / 0014 / 0015）
- [[prds/runtime-file-transfer.md]] — 运行期文件传输轮：为**运行中的沙箱**提供类 `docker cp` 的**单文件**上传 / 下载双向通路（web + 桌面两形态，CLI 零改动；与「创建时文件注入」是两条独立通道）
- [[prds/console-cloudflare.md]] — 控制台前端托管到 Cloudflare 轮：前端搬上 **Cloudflare Workers + 静态资产**（域名 `dev.sankabox.com`），后端**纯 API 化**（删 `console_mounted`，**破坏性变更、无兼容层**），验收套件迁**独立本地静态源**（与生产跨源同构），**Terraform** 管域名层（**单一所有者原则**：脚本与资产归 `wrangler`）——决策依据见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]（**单向取代 0013 第 6 节**，历史表述不改写）——**2026-11-12 全轮收口**：01~05 全部 done，**验收标准 27 条逐条核销（27 / 27）**、用户真实浏览器八步全过，全轮留档见 [[tasks/console-cloudflare/RESULTS.md|全轮收口留档]]
- [[prds/file-pane-obsidian.md]] — 文件窗格与 Obsidian 阅读器轮：控制台终端区改造——① **文件窗格**（终端右侧伴生**分屏**、可折叠，锚定当前终端会话的 **shell 当前目录**，pwd 走 **OSC 1337 shell integration**；以浏览 / 下载为主、纯文本预览为辅）＋ ② **固定 Obsidian tab**（全宽双栏 vault 阅读器，左树右预览，**markdown 渲染 + wikilink 正向跳转**）——**两轮低保真 HTML 原型逐项拍板**（原型只作交互参考，口径以 PRD 为准）——**2026-11-12 立项**，**2026-11-13 口径修订**（大文件预览二次确认 + 进度条；镜像 locale ENV + SANDBOX_NETWORK 注入；官方 logo SVG）——**2026-11-14 全轮收口**：01~08 全部 done，**验收标准 38 条逐条核销（38 / 38，证据分真机 e2e / 单测 / 既有落档三档）**，e2e 全量 **63 / 63**（11.1 分钟，真沙箱），全轮留档见 [[tasks/file-pane-obsidian/RESULTS.md|全轮收口留档]]
- [[prds/registry-cache-manifest.md]] — 镜像缓存清单与缓存优先拉取引导轮：把统一镜像代理的平台级缓存清单变为可查询事实（核心包扫描器 + 服务端 `GET /api/proxy/cache/images` json|text + 60s TTL + 受限令牌双凭据限界 + 平台强制 env 注入 + 基础镜像 `base:0.4.0` 新增 `cached-images` 命令 + console 视图），引导 agent 拉依赖镜像前优先选已缓存版本——**2026-11-14 立项**，任务集见 [[tasks/registry-cache-manifest/README.md|任务集]]（验收标准 32 条）——**2026-11-15 全轮收口**：01~06 全部 done，**验收标准 32 条逐条核销（32 / 32，证据分真机 e2e / 单测 / 真机记录与实测三档）**，e2e 全量 **71 / 71**（12.6 分钟，真沙箱；含新 spec `16-cache-images` 4 条——真沙箱 `0.4.0` 新建端到端不依赖存量重建），全轮留档见 [[tasks/registry-cache-manifest/RESULTS.md|全轮收口留档]]（生产部署已落地（2026-11-15），前端已发布（2026-11-16，含 console 视图改版），存量沙箱重建条目已撤销（沙箱保持现状））
- [[prds/console-terminal-emulator.md]] — 控制台终端全步方案 + 前端实例常驻轮：**服务端常驻终端模拟器 + 附着下发快照恢复流**（恢复介质从「历史字节」换成「当前状态」）+ **终端标签间实例常驻**，根治 pi × 控制台终端四项待办里的 ①②（③ 自定义按键映射 / ④ 系统剪贴板互通仍待立项）——**交付后补记的需求档**（本轮以施工单推进、未先立 PRD），决策依据见 [[architecture/decisions/0020-控制台终端采用后端模拟器与快照接入.md|ADR 0020]]——**2026-11-19 收口**：任务集 01~04 全部 done、验收标准 6 条逐条挂证据，全轮留档见 [[tasks/console-terminal-emulator/RESULTS.md|全轮留档]]；17 个提交 `82b70bf..da45bda` 已在 `origin/main`；前端已随 2026-11-25 `v0.1.0` 发布部署到 Cloudflare Worker，宿主后端更新状态待核实
- [[prds/file-injection-refresh.md]] — 文件注入副本手动刷新轮：运行中的沙箱可对**单文件**或**整目录**已保存注入手动刷新托管副本（**不停机**，不中断容器 / 终端 / agent）；目录按镜像同步，宿主源里**已不存在的成员一并删除**——**2026-11-23 立项、同日收口**：任务集见 [[tasks/file-injection-refresh/README.md|任务集]]（01~05 **全部 done**），**验收标准 23 条逐条挂证据核销（23 / 23）**，e2e 定向 **2 / 2**、**单次**全量 **77 = 76 通过 / 1 失败**（唯一失败为 spec16 首行写死的脆化断言，与本轮代码无关；已由独立 test-only 提交定向修复，**未跑第二次全量**），**用户手工验收已于 2026-11-26 通过**；10 个提交 `6b694d4..ffcbdf9` 已在 `origin/main`；决策见 [[architecture/decisions/0021-文件注入副本刷新采用显式触发与原位写.md|ADR 0021]]；全轮留档见 [[tasks/file-injection-refresh/RESULTS.md|全轮收口留档]]
- [[prds/terminal-ux.md]] — 终端交互增强轮：设置抽屉「通用设置」tab、`Shift+Enter` 映射、终端右键复制 / 粘贴接管与常开 OSC 52 剪贴板互通；**2026-11-26 已收口**：任务 01~05 全部 done，前端 vitest **1093 passed / 59 files**，`typecheck` / `typecheck:tests` 双零错，字体构建成功（3648 字符、6 个 woff2），build 成功（2924 个模块）；定向真沙箱 e2e 首轮 **28 / 28**、修复轮 **15 / 15**，第二次全量 **88 / 88（14.4 分钟，基线 77 + `19-terminal-interaction` 11）**；回归代理区用例已补 `switchSettingsTab(page, 'proxy')`；提交链 5 个提交 `cdd2c3f` / `5f362aa` / `02a3a15` / `60c4669` / `984c657` 全部本地未 push；后端与核心包零改动，零新增依赖，未部署；桌面真机、64 KiB 真机覆盖与用户手工验收待执行。全轮留档见 [[tasks/terminal-ux/RESULTS.md|RESULTS]]，任务集见 [[tasks/terminal-ux/README.md|任务集]]。
