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
- [[prds/file-pane-obsidian.md]] — 文件窗格与 Obsidian 阅读器轮：控制台终端区改造——① **文件窗格**（终端右侧伴生**分屏**、可折叠，锚定当前终端会话的 **shell 当前目录**，pwd 走 **OSC 1337 shell integration**；以浏览 / 下载为主、纯文本预览为辅）＋ ② **固定 Obsidian tab**（全宽双栏 vault 阅读器，左树右预览，**markdown 渲染 + wikilink 正向跳转**）——**两轮低保真 HTML 原型逐项拍板**（原型只作交互参考，口径以 PRD 为准）——**2026-11-12 立项**：01~08 未开工，验收标准 **35 条**待核销
