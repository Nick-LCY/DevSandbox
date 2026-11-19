---
prd: prds/console-terminal-emulator.md
status: done
---
# 任务：验收与文档收口

> 需求见 [[prds/console-terminal-emulator.md|控制台终端全步方案 + 前端实例常驻]]；决策见 [[architecture/decisions/0020-控制台终端采用后端模拟器与快照接入.md|ADR 0020]]。
> 收口日期 2026-11-19；全轮数字与遗留见 [[tasks/console-terminal-emulator/RESULTS.md|全轮留档]]。

## 目标

- **e2e 取证**：新增 `17-terminal-snapshot.spec.ts`，用 **`page.reload()` 强制重挂载**取证——常驻之后「切标签」不再销毁实例，快照路径只有强制重建才走得到。
- **门禁全量**：后端 pytest、核心包 pytest、前端 vitest / typecheck ×2 / build、ruff。
- **文档收口**：ADR + 任务集 + 前端约定 + 看板 + 索引同步；代码区文档（`API.md` 12.3 / 12.3bis / 12.6、`apps/web/frontend/README.md`）随代码提交，不在本页重复。

## 完成标准

- [x] `17-terminal-snapshot.spec.ts` **四条**，全部 reload 取证：① 重新附着后**括号粘贴**仍在（`^[[200~…^[[201~` 包裹）；② 重新附着后**鼠标上报**仍在（1000/1006）；③ 重新附着**不再触发探测再应答**（DA1 应答次数不变）；④ 重新附着后**画面恢复**（屏幕内容仍在）。
- [x] e2e 全量 **75 条**（基线 71 + 新增 4），**每条至少通过一次、无稳定失败**；未取得单次 75/75 的原因归档为宿主内存 OOM（见下）。
- [x] 门禁：后端 **461 passed**、核心包 **511 / 514**（3 例既有镜像代理 502 环境问题，本轮 `apps/core` 零改动）、前端 vitest **1041 passed**、typecheck ×2 零错、build 成功、ruff 0。
- [x] 文档：ADR 0020 落档、任务集四页 + 本页 + RESULTS、`conventions/console-frontend.md` 三处口径改写、`current-state.md` 看板与 TODO 更新、`tasks/README.md` 与 `prds/README.md` 索引同步、ADR 清单与架构目录索引补行。

## 依赖

- 依赖 [[tasks/console-terminal-emulator/01-server-emulator.md|01]]、[[tasks/console-terminal-emulator/02-attach-snapshot-protocol.md|02]]、[[tasks/console-terminal-emulator/03-terminal-residency.md|03]] 全部落地。

## 进展（2026-11-19 收尾回归）

- **e2e**：`17-terminal-snapshot.spec.ts` 四条全过。**取证方式刻意用 reload**——常驻之后切标签只是 `display:none`，不销毁实例，快照路径一次都执行不到；`page.reload()` 把旧 xterm 连同 DOM 一起销毁、页面按路由重新附着，是最强的重挂载。
- **全量 e2e**：75 条逐条至少通过一次、无稳定失败；**单次 75/75 未取得**——宿主内存 11 GiB 用满 + swap 满，headless Chrome 被 OOM 杀掉（dmesg 实证），**归因宿主资源，不是代码问题**。
- **门禁**：后端 461 / 核心包 511·514（3 例为镜像代理上游 502 的既有环境故障）/ 前端 vitest 1041 / typecheck ×2 + build + ruff 全绿。
- **收口口径**：本轮代码 17 个提交（`8954025..da45bda`）**全部未 push**，工作区干净；生产部署与前端发布不在本轮动作内。
