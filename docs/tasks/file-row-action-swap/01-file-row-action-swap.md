---
prd: prds/file-row-action-swap.md
status: doing
---
# 任务：文件行交互语义反转与验收留档

> 用户拍板日期：2026-11-28。旧语义「单击下载、hover 眼睛预览」由本轮反转，历史 PRD 与历史任务正文保留不改写。
> 需求来源：文件行交互反转精简 PRD；历史背景见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **状态：doing（2026-11-28 用户验收通过）。** 自动化验收已通过，用户真机验收已于 2026-11-28 通过；当前代码待提交，随 `v0.3.0` 发布（进行中），尚未发布或部署。

## 目标

完成并归档文件窗格文件行交互反转：

- 文件行单击 = 预览，沿用原 hover 眼睛按钮路径；大于 2 MB 仍二次确认后读取。
- 文件行 hover 浮现下载按钮：lucide `Download` 图标、`aria-label="下载"`、约 150ms 淡入、可聚焦、阻止冒泡。
- 目录行行为不变；网页与桌面共用组件两端一致。

## 改动文件

- `apps/web/frontend/src/components/workbench/FileBrowserPanel.tsx` — 共享文件行交互与网页 / 桌面下载分支。
- `apps/web/frontend/src/components/workbench/FileBrowserPanel.test.tsx` — 单击预览、hover 下载、键盘与冒泡隔离相关组件测试。
- `apps/web/frontend/tests/specs/12-file-transfer.spec.ts` — 文件传输验收入口与下载路径按新语义调整。
- `apps/web/frontend/tests/specs/14-file-pane.spec.ts` — 文件窗格预览路径按新语义验收。

## 完成标准

- [x] 文件行单击进入预览，复用原预览路径及大文件二次确认。
- [x] hover 文件行浮现下载按钮，使用 `Download` 图标、`aria-label="下载"`、150ms 淡入，可聚焦并阻止冒泡。
- [x] 目录行不变；网页与桌面两端共用组件生效。
- [x] typecheck / `typecheck:tests` 通过。
- [x] 单测 **64 个测试文件，1142 / 1142 通过**。
- [x] build 通过。
- [x] 定向 e2e：`12` / `14`，**13 / 13 通过**。
- [x] 全量真沙箱 e2e **90 / 90 通过**；本轮未复现 12 轮登记的脆化断言。
- [x] 审查无 Critical。
- [x] 代码完成。
- [x] 用户于 **2026-11-28** 真机验收通过。
- [ ] 代码提交并随 `v0.3.0` 发布（进行中；当前待提交、待发布）。

## 审查与遗留

- **已完成（test-only）**：审查 Warning 中键盘路径与冒泡隔离测试已由执行者补充完成；最终门禁：`typecheck:tests` 通过，单测 **64 个测试文件，1142 / 1142 通过**，e2e 维持 **90 / 90**。
- **TODO，不阻断本轮**：文件行当前仍存在嵌套交互控件模式（`div role="button"` 内嵌原生 `button`），这是旧眼睛按钮路径已有的 ARIA 结构风险，本轮不重构。
- **TODO，视需要**：补文件行键盘路径 e2e 最小用例；单测已覆盖，未作为本轮自动化收口阻断项。

## 依赖

- 历史实现基础：[[tasks/file-pane-obsidian/05-file-preview.md|文件窗格文本预览]]。
- 稳定交互口径：[[conventions/console-frontend.md|网页控制台前端约定]]。
