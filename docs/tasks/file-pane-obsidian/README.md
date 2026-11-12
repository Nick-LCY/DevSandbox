# 文件窗格与 Obsidian 阅读器任务集

本目录是**文件窗格与 Obsidian 阅读器**轮的任务集，共 **8 个任务**，需求来源见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。

这一轮改造控制台的**终端区**：① 把文件浏览从「全局抽屉」改成**终端的伴生分屏**（可折叠、锚定当前会话的 shell 当前目录、以浏览下载为主、文本预览为辅）；② 新增一个**固定的 Obsidian tab**，全宽双栏 vault 阅读器（左树右预览，markdown 渲染 + wikilink 正向跳转）。支撑链路是 **pwd 通道**——用 shell integration（OSC 1337）把 shell 当前目录报上来。

**状态：01~08 全部 todo（2026-11-12 立项）**——立项口径来自**两轮低保真 HTML 原型的逐项拍板**；**无重大架构分歧，不写 ADR**，机制说明写在 PRD「方案」节。看板见 [[current-state.md|当前状态]]。

**关键口径（贯穿全轮）**：

| 口径 | 内容 |
|---|---|
| 文件窗格形态 | **终端区分屏**（左终端面板 + 可拖拽分隔条 + 右文件窗格），**默认约 340px**；全局 `DrawerShell` 文件抽屉**退役**、工作区头部「文件」按钮移除 |
| 折叠 | 右缘 **36px** 纯图标竖条，**不显示任何文字**，「展开」按钮在竖条**底部**（竖条上**只有**这一个按钮）；折叠态**前端本地记忆**，跨会话关闭 / 重开保持 |
| 入口随会话 | 窗格只在「**存在终端会话且激活的是终端 tab**」时存在；关闭全部会话 ⇒ 窗格消失 + 空态（「**没有终端会话**」+ 新建会话入口）；重开会话恢复且折叠态保持 |
| 定位 fallback 链 | **会话 pwd → 沙箱工作目录（metadata `workdir`）→ 容器根目录 `/`** |
| 跟随策略 | **无自动跟随**（用户彻底放弃：shell 内 `cd` 窗格绝不联动）；唯一联动入口 = 工具条「**回跳**」准星按钮 |
| 回跳 tooltip | 「**跳转到终端当前目录：<路径>**」；pwd 不可得时「**当前会话未上报工作目录**」且按钮禁用 |
| 文件行语义 | **单击 = 下载**（既有口径不变）；hover 行尾浮现「预览」眼睛按钮（约 **150ms** 淡入、带 `aria-label`、不带文字） |
| 预览 | **窗格内的第二视图**（非弹层非抽屉）；**`.md` 一律纯文本**（文件窗格内**无 markdown 渲染**）；**2 MB** 上限截断 + 底部就地提示条「文件过大，仅展示前 N KB」；二进制 = 首块 **NUL** 嗅探 → 空态构图 |
| pwd 通道 | 镜像侧 `/etc/bash.bashrc` 注入 **OSC 1337 CurrentDir**（tabby 方案）；前端 `term.parser.registerOscHandler(1337, cb)`（**禁手写扫描器、禁逐帧 `TextDecoder`**）；pwd 是**纯前端产物**，后端会话记录**不加字段** |
| 全屏 | 全屏对象从「仅终端面板」改为「**tabs 条下方的整个内容区**」；仍为**纯 CSS fixed 覆盖**（**禁** `requestFullscreen` / `keyboard.lock`）；不入路由不入存储，换沙箱自动退出 |
| Obsidian tab | tabs 条**最左**的**固定** tab（**gem 图标** +「Obsidian」，不可关闭、无关闭按钮），**独立于终端会话**；激活时**文件窗格隐藏**，切回终端 tab 窗格按原折叠态恢复 |
| Obsidian 布局 | **全宽双栏**（左 vault 树 + 右预览区），中间细分隔线（**无拖拽**）；vault 根**按沙箱记在前端本地**（不入后端） |
| 渲染 | 内容列 **max-width 约 620px** 居中；**frontmatter 渲染态隐藏、源码态可见**；渲染器**不放行原始 HTML** |
| wikilink | `\[\[目标\]\]` / `\[\[目标|别名\]\]` / `\[\[#标题\]\]`；兜底 **同目录 → vault 根相对 → 全库递归同名**（带 exec 看门狗超时）；目标不存在 ⇒ 正文顶部就地浅红错误条 |
| 后端 | 新增 **`GET /api/sandboxes/{name}/files/read`**（`path` + `max_bytes`）——复用既有**分层探测**与 **exec 字节泵**，首块 **NUL** 嗅探报二进制，超限截断并声明；**不拦 `..`**（ADR 0018 既定） |

## 任务清单

| 编号 | 任务 | 状态 | 交付内容 |
|---|---|---|---|
| [[tasks/file-pane-obsidian/01-prototype-osc-loop.md\|01]] | 打样轮——OSC 1337 pwd 链路端到端打通 | **todo** | 真沙箱打通「镜像 PS1 注入 → xterm 注册 OSC 处理器 → 解析 pwd → 窗格定位 / 回跳」；产出三条**实测口径结论**（bash 转义、sh 降级、断线重连 pwd 恢复方案） |
| [[tasks/file-pane-obsidian/02-image-ps1-injection.md\|02]] | 镜像 PS1 注入（OSC 1337 CurrentDir） | **todo** | base-image `/etc/bash.bashrc` 追加注入（保留原 PS1 + tabby 方案序列）+ **版本 bump** + 构建推送；**现有沙箱重建由用户完成**（外部依赖，登记为验收前置） |
| [[tasks/file-pane-obsidian/03-frontend-pwd-channel.md\|03]] | 前端 pwd 通道 | **todo** | `src/lib` 纯函数模块 + 单测；`registerOscHandler(1337, cb)` 接线；**按会话前端内存缓存**；断线重连提示符刷新恢复 pwd |
| [[tasks/file-pane-obsidian/04-file-pane-split.md\|04]] | 文件窗格分屏骨架 | **todo** | 抽屉退役、三段式分屏 / 拖拽 / 折叠、入口随会话与空态、fallback 链、回跳按钮、**全屏范围改造** |
| [[tasks/file-pane-obsidian/05-file-preview.md\|05]] | 文件窗格文本预览 | **todo** | 后端只读端点（服务端 + 核心包 + 单测）+ 前端预览视图（行号 / 复制 / 截断 / 二进制空态 / 返回栈 / hover 眼睛） |
| [[tasks/file-pane-obsidian/06-obsidian-tab.md\|06]] | Obsidian tab 骨架 | **todo** | 固定 tab（最左、gem 图标、不可关闭）、全宽双栏、引导态设 vault 根、vault 树、与文件窗格的隐藏 / 恢复联动 |
| [[tasks/file-pane-obsidian/07-markdown-wikilink.md\|07]] | markdown 渲染与 wikilink | **todo** | 渲染库引入（react-markdown，不放行原始 HTML）、渲染 / 源码切换、frontmatter 处理、wikilink 解析纯函数 + 单测 + 三级兜底、tooltip、错误条、历史栈 |
| [[tasks/file-pane-obsidian/08-acceptance-and-docs.md\|08]] | 验收与文档收口 | **todo** | e2e 用例、门禁全量、**PRD 验收 35 条逐条核销**、文档同步（`API.md` / 标识表 / 词汇表 / 看板 / 两份清单）、全轮留档 `RESULTS.md` |

## 依赖顺序

```
01 ──┬──▶ 02（镜像）
     │
     └──▶ 03（前端）──▶ 04 ──┬──▶ 05 ──┐
                         └──▶ 06 ──┴──▶ 07 ──▶ 08
```

- **01 是硬前置，不通过不进后续**：镜像注入写法（bash 转义与引号）、sh 降级表现、断线重连 pwd 恢复方案**都在 01 轮实测定**——02 与 03 都按 01 的结论施工，不自行发挥。
- **02 与 03 可并行**：02 动**镜像**（base-image + 版本 bump + 构建推送），03 动**前端**（解析纯函数 + OSC 接线 + 会话缓存），**零文件重叠**；03 的**实现**只等 01 的结论，真沙箱**端到端复验**要等 02 的镜像就绪。
- **04 依赖 03**：窗格定位与回跳都要用会话 pwd。
- **05 依赖 04**：预览是窗格内的第二视图。
- **06 依赖 04**：Obsidian tab 与文件窗格动同一片标签区与内容区布局（04 的折叠 / 隐藏语义是 06 的前提）。
- **07 依赖 06**（渲染与 wikilink 建在 Obsidian 双栏骨架之上），**数据来源**是 05 落地的**只读端点**。
- **08 收口依赖全部**（01~07）。

## 关键前置与风险

| 项 | 性质 | 影响 | 现状 |
|---|---|---|---|
| **现有沙箱需重建才能用上新镜像** | **外部依赖** | 02 轮推送新镜像后，**存量沙箱仍是旧镜像**、收不到 pwd 上报 | **登记为验收前置**：重建**由用户执行**，本轮不代劳；收口留档里写明「用户重建后复验」的前置关系 |
| **01 轮打样结论是全链路的口径源头** | **硬前置** | 02 / 03 的实现细节全部依赖它（bash 转义、引号、sh 降级、重连恢复方案） | **未开轮**；01 不通过不进 02 / 03 |
| **`dash` / `sh` 会话无 pwd 上报** | 已知边界（非缺陷） | 回跳按钮禁用 + tooltip「当前会话未上报工作目录」；窗格维持 fallback 起点 | **设计内**（PRD 验收项 **FP-07** 已钉死该降级口径） |
| **既有 TODO「终端中文间歇乱码」点名终端帧解码区** | 约束 | 本轮**禁**引入逐帧 `TextDecoder`、**禁**手写字节流扫描器 | **PRD 方案节已写死禁令**（验收项 **PWD-03**） |
| **全屏范围变更影响既有终端全屏口径** | 口径变更 | 全屏对象从「终端面板」变成「整个内容区」；**仍是纯 CSS 覆盖**，不碰 `requestFullscreen` / `keyboard.lock` | **PRD 方案节写明**（验收项 **FS-01** / **FS-02**） |
| **「终端会话顺序与快捷键切换标签」规划项动同一片标签区** | 排期冲突 | 两条需求线都改终端标签区 | **建议本需求线收口后再启动**（见 [[current-state.md|看板]] 的「规划」区） |

## 任务文件

- [[tasks/file-pane-obsidian/01-prototype-osc-loop.md]] — 打样轮：OSC 1337 pwd 链路端到端打通（**硬前置**）。
- [[tasks/file-pane-obsidian/02-image-ps1-injection.md]] — 镜像 PS1 注入 + 版本 bump + 构建推送。
- [[tasks/file-pane-obsidian/03-frontend-pwd-channel.md]] — 前端 pwd 通道：纯函数 + 单测 + OSC 接线 + 按会话缓存 + 重连恢复。
- [[tasks/file-pane-obsidian/04-file-pane-split.md]] — 文件窗格分屏骨架：抽屉退役 / 分屏 / 折叠 / 空态 / fallback / 回跳 / 全屏范围。
- [[tasks/file-pane-obsidian/05-file-preview.md]] — 文本预览：后端只读端点 + 前端预览视图。
- [[tasks/file-pane-obsidian/06-obsidian-tab.md]] — Obsidian tab 骨架：固定 tab / 双栏 / 引导态设根 / vault 树。
- [[tasks/file-pane-obsidian/07-markdown-wikilink.md]] — markdown 渲染与 wikilink：渲染库 / 双态切换 / 三级兜底 / tooltip / 错误条。
- [[tasks/file-pane-obsidian/08-acceptance-and-docs.md]] — 验收与文档收口：e2e / 门禁 / PRD 核销 / 文档同步 / 留档。
- [[prds/file-pane-obsidian.md]] — **文件窗格与 Obsidian 阅读器 PRD**（本轮需求与验收标准 35 条）。
