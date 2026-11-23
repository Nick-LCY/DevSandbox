---
prd: prds/file-injection-refresh.md
status: todo
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

- [ ] 定向 Playwright **一份**全绿：运行中容器 / 终端**不重启**；刷新后单文件与目录**可见且只读**。
- [ ] 01~04 的**定向**测试逐层全绿。
- [ ] 满足「全部交付 + 定向全绿 + 无待修」三条前置后，**单独跑一次**全量 `pnpm run test:acceptance`，结果**如实留档**（**不自动二刷**）。
- [ ] 全轮留档 `RESULTS.md` 落库（提交链 / 门禁数字 / e2e 证据 / 已知边界与留白）。
- [ ] PRD 验收标准**逐条核销**并挂证据；看板 / 任务清单 / 任务集 README 同步。
- [ ] 全轮**零部署、零 push**（代码提交留在本地）。

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
