---
prd: prds/file-injection-refresh.md
status: done
---
# 任务：详情抽屉「注入文件」清单

> 需求见 [[prds/file-injection-refresh.md|文件注入副本手动刷新 PRD]]；界面口径见 [[conventions/console-frontend.md|控制台前端约定]]。
> 前置：[[tasks/file-injection-refresh/03-admin-api.md|03 管理 API]]（界面接详情新字段与刷新端点）。

## 目标

- 在**现有沙箱详情抽屉**里、与既有「**挂载**」区**同级**加一个「**注入文件**」清单区；**不新增抽屉**。
- **每条一行**：宿主源 → 容器目标（只读）+ 一个「**刷新副本**」按钮；**不展开目录树**、不逐级列成员。
- **不读正文**：界面只显示元数据。
- 既有「刷新详情」是**读操作**，**不得**触发刷新副本；写动作只由「刷新副本」按钮发起。
- 遵循 [[conventions/console-frontend.md|控制台前端约定]]：主题令牌（不写裸色值）、操作结果走右上角 toast、按钮加载态用旋转图标（lucide `Loader2`、`size-3.5` + `animate-spin`、`aria-hidden`）、**新增中文文案后重跑字体子集脚本**。
- 新标识登记进前端 README 标识表（`page-sandbox-detail-injection-*`），符合 `page-<页面>-<元素>` 规范。

## 完成标准

- [x] 抽屉内「注入文件」区与「挂载」区**同级**；旧实例无条目时**不出现**刷新入口（旧实例仍可正常查看 / 管理 / 删除）。——**证据**：提交 `c25026b`；spec18 断言旧实例无条目 ⇒ **整区不渲染**（前端 README 标识表同口径）。
- [x] 每条一行：宿主源 → 容器目标（只读）+「刷新副本」按钮；不展开目录树；**不展示正文**。——**证据**：spec18 断言 `page-sandbox-detail-injection-item` 恰 **2** 条、每条含容器目标与「只读」字样，且**不含**注入内容标记。
- [x] 按钮**加载态禁重复触发**；操作结果走 toast（成功 / 失败），失败直出后端 `detail` 原文（含「可能部分更新」语义）。——**证据**：前端 vitest **1058 / 1058**（`c25026b`）；spec18 断言成功 toast「副本已刷新」、失败 toast 含后端原文。
- [x] 既有「刷新详情」**不触发**刷新副本（读 / 写分离）。——**证据**：spec18 负例监听刷新端点 POST —— 点「刷新详情」并观察 2 s 窗口，**一个 POST 都没发出**。
- [x] **网页与桌面两端行为一致**（同一份前端产物）。——**证据**：本轮未引入形态差异（桌面端零改动），同一份前端产物供两端使用。
- [x] 新增中文文案已重跑 `bash apps/web/frontend/scripts/build-fonts.sh`（否则界面出现缺字形方框）。——**证据**：`c25026b` 已重跑字体子集并随提交入库。
- [x] 新标识登记进前端 README 标识表。——**证据**：`apps/web/frontend/README.md` 标识表已含 `page-sandbox-detail-injection-*` 系列与刷新按钮标识。
- [x] 门禁：前端 vitest 定向用例全绿 + typecheck / typecheck:tests 零错 + build 成功。——**证据**：vitest **1058 / 1058**、typecheck **双零错**、build **成功**（`c25026b` 时点）。

## 进展

**2026-11-23 收口（done）**：详情抽屉「注入文件」清单落地（`c25026b`）。读 / 写分离的取证与界面口径见 [[tasks/file-injection-refresh/RESULTS.md|全轮留档]]；相关稳定约定见 [[conventions/console-frontend.md|控制台前端约定]]。

## 依赖

- [[tasks/file-injection-refresh/03-admin-api.md|03 管理 API]]。

## 优先风险

| 风险 | 影响 | 处置口径 |
|---|---|---|
| **新增中文文案没重跑字体子集** | 界面出现方框 | 收口前必跑字体脚本；中文文案清单与脚本产物一并核对 |
| **「刷新详情」与「刷新副本」混淆** | 点读操作触发写动作 | 两个按钮文案 / 位置分离；单元用例钉住读操作不发起写请求 |
| **按钮重复触发** | 并发刷新撞互斥 | 加载态禁重复（旋转图标 + 禁用） |
| **旧实例显示空入口** | 用户点到无源条目 | 无条目即不渲染按钮；空态按既有口径 |

## 定向验证（**不跑全量**）

- 前端 vitest 定向用例（清单渲染、按钮加载态、toast 分支、旧实例无入口、读操作不触发写）。
- typecheck / typecheck:tests / build（定向跑）。
- **不得**在本任务跑全量 E2E（全量只在 [[tasks/file-injection-refresh/05-acceptance-and-delivery.md|05 定向验收与交付]] 单独跑一次）。
