---
prd: prds/phase3-desktop.md
status: todo
---
# 任务：验收回归与文档收口

## 目标

把三期整体收口：跑齐全部质量基线确认无回归，补齐转发与认证的真机验收用例，把三篇决策记录归档，并同步看板、词汇表、架构总览、前端约定、接口文档与工程说明。

## 涉及文件

- 新增 / 改 `apps/web/frontend/tests/specs/` — 端口转发与连接配置的验收用例
- 改 `docs/architecture/decisions/README.md` — 0013 / 0014 / 0015 入清单表
- 改 `docs/architecture/README.md` — 0013 / 0014 / 0015 入清单表
- 改 `docs/architecture/overview.md` — 关键决策表 + 核心模块（「连接层与认证」「端口转发」「桌面端」三条）
- 改 `docs/glossary.md` — 新增术语（端口转发、访问令牌、连接配置、转发容器、桌面端）
- 改 `docs/conventions/console-frontend.md` — 「连接配置与请求基址」「端口转发」两节
- 改 `docs/current-state.md` — 规划段（「前后端分离部署」标注被吸收 / Cloudflare 退役）、任务看板、TODO
- 改 `docs/prds/README.md` — 三期 PRD 入清单
- 改 `docs/tasks/README.md` — 三期任务集入清单
- 改 `apps/web/backend/API.md` — 认证章节 + 端口转发接口章节（若 02 / 05 未写完则在此补齐）
- 改 `apps/web/frontend/README.md` — 连接配置、转发界面、标识表、接口一览
- 改 `README.md`（仓库根）— 目录结构加 `apps/desktop/`、认证与令牌说明、非回环监听口径改写
- 改 `apps/web/backend/sandbox-console.service` — 令牌相关注释

## 实施步骤

1. **质量基线**：核心包 pytest（含 `-m root`）、服务端 pytest、ruff（`E4/E7/E9/F`）、前端 vitest / typecheck / typecheck:tests / build 全绿。
2. **真机回归**：既有 9 条 spec + 新增的认证用例（`10-auth-connection.spec.ts`）+ 端口转发用例（转发建立 → 桌面端开启 → 本机访问 → 停止 → 沙箱删除后回收）全绿。
3. **三篇 ADR**：按仓库模板写全六段（日期、状态、背景、决策、影响、相关决策），文件名 `0013-三期定位改定与认证重启.md`、`0014-端口转发机制选型.md`、`0015-桌面壳与连接配置抽象.md`。
4. **清单同步**：三篇 ADR 登记进 `docs/architecture/decisions/README.md` 与 `docs/architecture/README.md` 两张表；PRD 与任务集登记进对应清单；看板、词汇表、总览、约定、API.md、两个 README 同步到位。
5. **留档**：`docs/tasks/phase3-desktop/RESULTS.md` 记实测数字（各套测试条数、真机用例数、Windows 冒烟结论）。
6. **仓库卫生自查**：本轮新增文件里 grep 不到个人家目录路径与个人专属内容。

## 完成标准

- [ ] 核心包 pytest（含 root 级用例）、服务端 pytest、ruff 全绿。
- [ ] 前端 vitest、typecheck、typecheck:tests、build 全绿。
- [ ] Playwright 真机用例全绿（既有 9 条 + 认证用例 + 端口转发用例）。
- [ ] 三篇决策记录按仓库模板写全并登记进两张清单表。
- [ ] `docs/current-state.md` 更新：规划段三条方向全部收敛（「前后端分离部署」标注被三期吸收、Cloudflare 静态托管退役、三期任务集挂行）、TODO 段落登记本期明确不做的非目标。
- [ ] `docs/glossary.md` 补齐新术语，并保持「端口转发 ≠ URL 代理」的区分。
- [ ] `docs/architecture/overview.md` 的核心模块与关键决策表补齐；ADR 0009 的认证裁剪在总览里标注为已被 0013 推翻。
- [ ] `docs/conventions/console-frontend.md` 补「连接配置与请求基址」「端口转发」两节。
- [ ] `apps/web/backend/API.md` 与两个 README 同步本轮改动。
- [ ] `docs/tasks/phase3-desktop/RESULTS.md` 留档实测数字与已知边界。
- [ ] 仓库卫生自查通过。

## 依赖

- 依赖 [[tasks/phase3-desktop/01-prototype-and-spike.md|01]] ~ [[tasks/phase3-desktop/08-windows-package.md|08]] 全部就位。
- 决策记录模板与清单体例见 [[architecture/decisions/README.md|架构决策记录索引]]；看板体例见 [[current-state.md|当前状态]]。
