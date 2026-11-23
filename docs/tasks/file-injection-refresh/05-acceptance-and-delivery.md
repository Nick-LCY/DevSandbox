---
prd: prds/file-injection-refresh.md
status: done
---
# 任务：定向验收与交付

> 需求见 [[prds/file-injection-refresh.md|文件注入副本手动刷新 PRD]]。
> 前置：[[tasks/file-injection-refresh/01-refresh-mechanism-and-probe.md|01]] / [[tasks/file-injection-refresh/02-core-persistence-and-mutex.md|02]] / [[tasks/file-injection-refresh/03-admin-api.md|03]] / [[tasks/file-injection-refresh/04-detail-drawer.md|04]] **全部完成**。

## 目标

### 一、一份定向 Playwright

- 在 `apps/web/frontend/tests/specs/` 新增**一份**定向用例（编号接 17 之后，建议 `18-file-injection-refresh.spec.ts`）：证明**真实运行容器 / 终端不重启**（容器 id / 启动时间不变、终端会话保持连接）；页面刷新后**单文件 / 目录**可见且**只读**。
- 取证沿用既有口径：宿主侧 `docker exec` 容器内取证（**不经过被测接口读正文**），负例配正向对照。

### 二、逐层定向测试

- 逐任务跑**定向**测试：01 / 02 core 包 pytest 定向 → 03 服务端 pytest 定向 → 04 前端 vitest 定向 → 本任务的定向 e2e。
- 每层只跑本任务相关用例，**不做全量回归**。

### 三、单次全量 E2E（全轮唯一一次）

- **三条硬前置**（缺一不可）：① 01~04 **全部交付完成**；② **所有定向测试通过**；③ **无待修项**。
- 满足前置后**单独跑一次**全量：`pnpm run test:acceptance`（`apps/web/frontend`，nvm + pnpm；使用**本地后端 / 独立静态源**）。
- 运行前确认：端口占用、宿主内存（**历史 OOM** 实证：单次全量曾受宿主内存制约）、测试数据**独立**、**不得打 Cloudflare**；如需腾资源，**只停本机明确归属的资源**。
- **不自动二刷**：跑一次即记录结果；失败就如实留档，不靠重跑掩盖。

### 四、归档

- 全轮留档写 `RESULTS.md`（提交链、门禁数字、e2e 证据、已知边界与留白）。
- 文档同步：[[current-state.md|看板]]、[[tasks/README.md|任务清单]]、本任务集 README；PRD 验收标准**逐条挂证据**核销。
- **不部署**（**绝不 Cloudflare 部署**）、**不 push**。

## 完成标准

- [x] 定向 Playwright **一份**全绿：运行中容器 / 终端**不重启**；刷新后单文件与目录**可见且只读**。——**证据**：新增 `18-file-injection-refresh.spec.ts`（真沙箱 **2 / 2**，**30.1 s**，提交 `f28775e`）：容器 Id / StartedAt 前后一致、同一会话 PID / 哨兵存活、单文件与目录刷新后可见且写入仍撞 EROFS。
- [x] 01~04 的**定向**测试逐层全绿。——**证据**：core helper **44** + 接线 **34**、服务端 **21**、前端 vitest **1058 / 1058**（typecheck 双零错、build 过）、**ruff 全绿**；**01~04 未提前跑全量**。
- [x] 满足「全部交付 + 定向全绿 + 无待修」三条前置后，**单独跑一次**全量 `pnpm run test:acceptance`，结果**如实留档**（**不自动二刷**）。——**证据**：**只跑了那一次**（2026-11-23 12:02–12:15 UTC，**815.5 s / 13.6 min**，退出码 1；**77 = 76 通过 / 1 失败 / 0 跳过 / 0 flaky**，无 OOM）；唯一失败为 spec16「PRD 21」把共享缓存首行**写死**的脆化断言（与本轮代码无关），已由**独立 test-only 提交** `ee7d970` 改为动态推导并**定向 1 / 1（35.4 s）**通过，**未跑第二次全量**；原始产物留档在本机 `apps/web/frontend/tests/artifacts/preserved-full-20261123-120208/`（gitignore）。
- [x] 全轮留档 `RESULTS.md` 落库（提交链 / 门禁数字 / e2e 证据 / 已知边界与留白）。——**证据**：[[tasks/file-injection-refresh/RESULTS.md|全轮收口留档]]。
- [x] PRD 验收标准**逐条核销**并挂证据；看板 / 任务清单 / 任务集 README 同步。——**证据**：PRD **23 / 23** 逐条挂证据；[[current-state.md|看板]]、[[tasks/README.md|任务清单]]、[[prds/README.md|需求清单]]、任务集 README 与 ADR 索引已同步。
- [x] 全轮**零部署、零 push**（提交留在本地）。——**证据**：未碰 Cloudflare Workers、未发布前端；**归档前 10 个提交全部未 push**（本归档另起提交）。

## 进展

**2026-11-23 收口（done）**：全量 E2E **只跑过一次**（不自动二刷），结果与那一条失败已如实留档；归档前 10 个提交均留本地（本归档另起提交），**零部署、零 push**。
**遗留（非本任务阻塞）**：**用户手工验收尚未执行**——本机走查方式见 [[tasks/file-injection-refresh/RESULTS.md|全轮留档]]第六节（文档步骤**未启动任何进程**）。

## 依赖

- [[tasks/file-injection-refresh/01-refresh-mechanism-and-probe.md|01 安全刷新机制与真机探针]]
- [[tasks/file-injection-refresh/02-core-persistence-and-mutex.md|02 核心实例持久化与互斥 / 真沙箱]]
- [[tasks/file-injection-refresh/03-admin-api.md|03 管理 API]]
- [[tasks/file-injection-refresh/04-detail-drawer.md|04 详情抽屉「注入文件」清单]]

## 优先风险

| 风险 | 影响 | 处置口径 |
|---|---|---|
| **宿主内存不足**（历史实证：单次全量曾 OOM） | 全量跑到一半被宿主杀掉 | 跑前确认内存；必要时**只停本机明确归属**的资源；**不自动二刷**，如实留档 |
| **端口 / 测试数据互相干扰** | 假失败或污染存量沙箱 | 用独立测试数据与独立静态源；跑前核对端口占用 |
| **误打 Cloudflare** | 触碰生产 | 全程本地后端 / 独立静态源；**绝不**部署、**绝不** push |
| **把「刷新详情」误当「刷新副本」** | 验收口径漂移 | 定向 e2e 断言写请求**只由**「刷新副本」按钮发起 |
| **全量提前** | 01~04 未收口就烧全量，数字不可信 | 全量只在 05 跑，且必须先满足三条硬前置 |

## 定向验证

- 本任务本身就是定向 + 单次全量的收口轮；**01~04 不得提前跑全量**。
