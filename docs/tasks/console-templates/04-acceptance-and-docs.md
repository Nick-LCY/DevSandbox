---
prd: prds/console-templates.md
status: todo
---
# 任务：真机验收与文档收口

## 目标
把控制台模板轮收口：跑齐三套测试确认无回归，把本轮的两个架构决策归档成决策记录，同步看板、词汇表、前端约定与工程说明，并做一遍仓库卫生自查。

## 完成标准
- [ ] 后端 pytest 与 ruff 全绿。
- [ ] 前端 vitest、typecheck、typecheck:tests、build 全绿。
- [ ] Playwright 真机验收用例全绿（含二期既有用例，无回归）。
- [ ] 新增两篇架构决策记录，按仓库模板写（日期、状态、背景、决策、影响、相关决策），文件名为 `0010-启动模板收敛为控制台私有功能.md` 与 `0011-基础镜像增加通用工具层并转联网构建.md`，落在 `docs/architecture/decisions/`。
- [ ] 两篇决策记录登记进 `docs/architecture/decisions/README.md` 的清单表格。
- [ ] `docs/current-state.md` 更新：任务看板新增控制台模板轮任务集一行、最近变更追加本轮条目、TODO 段落登记本轮明确不做的六项非目标。
- [ ] `docs/glossary.md` 补两条术语：启动模板、模板墓碑。
- [ ] `docs/conventions/console-frontend.md` 补三处约定：模板相关约定、字体回退边界、设置抽屉更名。
- [ ] `platform/console/README.md` 与 `platform/console/tests/README.md` 同步本轮前端改动（标识表与已退役标识、helper 对照表）。
- [ ] `platform/console/RESULTS.md` 补本轮真机实测留档。
- [ ] 仓库卫生自查：本轮新增文件里 grep 不到个人家目录路径，也 grep 不到个人专属内容。

## 依赖
- 依赖 [[tasks/console-templates/01-base-image-0.3.0.md|01 基础镜像 0.3.0]]、[[tasks/console-templates/02-template-server.md|02 模板服务端]]、[[tasks/console-templates/03-template-console.md|03 模板前端与字体]]：三套测试与文档收口都要等这三项就位。
- 决策记录模板与清单体例见 [[architecture/decisions/README.md|架构决策记录索引]]；看板体例见 [[current-state.md|当前状态]]。

## 实施要点

### 三套测试
- 后端：`pytest` 与 `ruff` 分别跑，二者都要退出码 0。
- 前端：`vitest`、`typecheck`、`typecheck:tests`、`build` 四项分别跑全绿。
- 真机：Playwright 用例全跑，二期既有用例与本轮新增用例一起跑，任何一条回归都要在本任务里修掉而不是记 TODO。

### 两篇决策记录
- 0010 记录「启动模板收敛为控制台私有功能」这一决策：为什么模板能力只落在服务层与网页控制台、核心包与命令行为什么不承接、代价是什么（命令行用不上模板）。
- 0011 记录「基础镜像增加通用工具层并转联网构建」这一决策：为什么放弃零网络构建、工具包清单的取舍、构建可复现性的代价。
- 两篇都要按仓库模板写全六段，「影响」段必须诚实写出代价，不写空话。

### 文档收口
- 看板的 TODO 段落把本轮明确不做的六项登记进去（默认全栈镜像退役与 git 历史抹除、命令行零参数创建的硬拦截、镜像前缀限制下线、个人镜像入仓、内置模板真实内容、会话目录按挂载声明归类），每条写清推迟原因。
- 词汇表补的两条：启动模板（保存下来的一套沙箱启动配置，含镜像、挂载、命令、工作目录、环境变量）、模板墓碑（内置模板被删除后留下的删除记录，保证删除后不复活）。
- 前端约定补三处：模板的合并语义与占位符口径、字体回退边界（字体文件缺失时回退系统字体栈，新字缺字形表现为方框，要重跑脚本）、设置抽屉更名后的标识口径。

### 仓库卫生自查
- 用 grep 在本轮新增与改动的文件里查个人家目录路径与个人专属内容，命中即清理；文档里描述该类内容时只写「个人家目录路径」这类泛称，不写真实路径。

## 留档指引
- 决策记录：`docs/architecture/decisions/` 下新增的两篇文件与该目录索引表。
- 看板与待办：`docs/current-state.md`。
- 术语：`docs/glossary.md`。
- 前端约定：`docs/conventions/console-frontend.md`。
- 工程与用例说明：`platform/console/README.md`、`platform/console/tests/README.md`。
- 实测数据：`platform/console/RESULTS.md`。
