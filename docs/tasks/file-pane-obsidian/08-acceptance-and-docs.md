---
prd: prds/file-pane-obsidian.md
status: todo
---
# 任务：验收与文档收口

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **依赖 01~07 全部完成**（本任务是收口轮）。

## 目标

把全轮做**验收与文档收口**：e2e 用例、门禁全量、**PRD 验收标准逐条核销**、文档同步、**全轮留档**。

### 要落地的口径

- **e2e**：新增用例覆盖**文件窗格分屏 / 折叠 / 空态**与 **Obsidian 双栏 / wikilink 跳转 / 目标不存在错误条**主链路（对应 PRD 验收项 **QA-01**）。
- **门禁全量**：核心包 pytest + ruff、服务端 pytest + ruff、前端 vitest + typecheck（双零错）+ build、桌面 `cargo test`、e2e 全量套件。
- **PRD 逐条核销**：把 [[prds/file-pane-obsidian.md|PRD]]「验收标准」的 **35 条**逐条勾选并**挂证据**（门禁数字 / 真机实证 / 用户验收 / 留档指针四类）；**未核销的条目要写明原因**，不许留空勾。
- **文档同步**：
  - 后端 `apps/web/backend/API.md` — 补 `files/read` 端点章节；
  - 前端 `apps/web/frontend/README.md` — **标识表**登记新增 `data-testid`、登记**退役**的旧标识；
  - [[glossary.md|词汇表]] — 按需补词条（如「文件窗格」「vault 根」「OSC 1337」）；
  - [[current-state.md|看板]] — 活跃需求 / 任务看板 / TODO；
  - [[prds/README.md|PRD 清单]] 与 [[tasks/README.md|任务清单]] — 同步本轮条目与状态；
  - [[conventions/console-frontend.md|前端约定]] — 若本轮产生新的稳定约定（如「纯 CSS 全屏范围」「剪贴板成功零反馈」扩展口径），**在此落一条**。
  - [[architecture/decisions/0004-镜像契约与默认沙箱镜像.md|ADR 0004 镜像契约与默认沙箱镜像]] — 按 01 轮实测结论**追加一条修订行**（**历史表述不改写**），对齐口径：「**镜像自带的默认 shell 配置（`/etc/bash.bashrc` 的 OSC 注入）属镜像内容、不属平台运行时机制；平台运行时机制仍不依赖 shell 初始化脚本**」。
- **全轮留档**：新建 `docs/tasks/file-pane-obsidian/RESULTS.md`——轮次总表、门禁数字、真机验收记录、**已知边界与留白**、提交链。

## 涉及文件

- `apps/web/frontend/tests/` — 新增 e2e spec
- `apps/web/backend/API.md` — 新端点章节
- `apps/web/frontend/README.md` — 标识表
- `docs/glossary.md`、`docs/current-state.md`、`docs/prds/README.md`、`docs/tasks/README.md`、`docs/conventions/console-frontend.md`
- `docs/prds/file-pane-obsidian.md` — **验收标准逐条核销**
- `docs/tasks/file-pane-obsidian/RESULTS.md`（新建）— 全轮留档

## 完成标准

- [ ] 新增 e2e 用例覆盖**文件窗格分屏 / 折叠 / 空态**与 **Obsidian 双栏 / wikilink 跳转 / 目标不存在错误条**主链路，**e2e 全量套件通过**（对应 PRD 验收项 **QA-01**）。
- [ ] 质量门禁**全绿**：核心包 pytest + ruff、服务端 pytest + ruff、前端 vitest + typecheck（双零错）+ build、桌面 `cargo test`、e2e 全量；**数字写进留档**。
- [ ] **PRD 验收标准 35 条逐条核销**并**挂证据**；未核销条目写明原因（对应 PRD 验收项 **QA-02**）。
- [ ] 后端 `API.md` 补 `files/read` 端点章节；前端**标识表**登记新标识与退役标识。
- [ ] [[glossary.md|词汇表]] 按需补词条；[[conventions/console-frontend.md|前端约定]] 按需补稳定约定。
- [ ] [[current-state.md|看板]]（活跃需求 / 任务看板 / TODO）、[[prds/README.md|PRD 清单]]、[[tasks/README.md|任务清单]] 三处**同步**。
- [ ] 全轮留档 `RESULTS.md` 落库（轮次总表 / 门禁数字 / 真机验收记录 / **已知边界与留白** / 提交链）。

## 依赖

- 依赖 [[tasks/file-pane-obsidian/01-prototype-osc-loop.md|01]]、[[tasks/file-pane-obsidian/02-image-ps1-injection.md|02]]、[[tasks/file-pane-obsidian/03-frontend-pwd-channel.md|03]]、[[tasks/file-pane-obsidian/04-file-pane-split.md|04]]、[[tasks/file-pane-obsidian/05-file-preview.md|05]]、[[tasks/file-pane-obsidian/06-obsidian-tab.md|06]]、[[tasks/file-pane-obsidian/07-markdown-wikilink.md|07]] **全部完成**。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
