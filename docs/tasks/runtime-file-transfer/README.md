# 运行期文件传输任务集（上传 / 下载）

本目录是沙箱平台**运行期文件传输**轮的任务集，共 6 个任务，需求来源见 [[prds/runtime-file-transfer.md|运行期文件传输 PRD]]。

这一轮给**运行中的沙箱**补一条类 `docker cp` 的**单文件**双向通路（上传 + 下载），覆盖 web 与桌面两形态。机制走三期端口转发已生产验证的 `docker exec -i` 字节泵资产（核心包 `forwarding.py` 的 `spawn_stream` + `BytePump`），核心包新增**平级**的 `transfer.py`，**零新增第三方依赖**。

**与既有通道的分工**：本轮与「**创建时注入**」（[[architecture/decisions/0012-文件注入采用复制加改属主而非改造挂载预检.md|0012]]）是**两条独立通道**——注入在创建时、单向、只读副本；本轮在运行期、双向、覆盖语义。本轮对**注入通道零改动**、对**命令行零改动**（「sandboxctl 增加 `--file`」是创建时注入的**另一条独立待办**，见 [[current-state.md|当前状态]] 的 TODO 段）。

**状态：01 done（2026-11-09 收口），02~06 todo**。看板见 [[current-state.md|当前状态]]。

**01 轮关键结论（一句话）**：主通道成立且**零新增依赖**（`docker exec -i` + `BytePump` 原样复用）——上传「同目录临时名 → `mv` 原子替换」实测字节精确、覆盖成立、rename 不跟随末端符号链接；下载的**前置分层探测是硬要求**（FIFO 会挂死 `cat`）；列表用 `find` 单次 exec 产出 **NUL 分隔**记录；**大小不限**（200 MiB 与 1 GiB 宿主峰值 RSS 相同 ≈ 23 MiB、曲线平坦）但**受反代读超时约束**（本机 Traefik 默认 `readTimeout=60s`，同一 200 MiB 慢上传直连 201.23 s 成功、经反代 61.13 s 被掐断）；**ADR 0018 已随本轮落档为已接受**。

## 任务清单

| 编号 | 任务 | 状态 | 交付内容 |
|---|---|---|---|
| [[tasks/runtime-file-transfer/01-prototype-and-mechanism.md\|01]] | 打样与机制验证 | **done（2026-11-09）** | 真沙箱实测 exec 命令（上传临时名 + `mv` / `cat` 流出 / **分层探测** / 只读目标报错归类）、反代缓冲与超时核对、200MB 级内存曲线与耗时、容器内 `sh` / `cat` / `wc` / `stat` / `find` 存在性核对、**ADR 0018 已落档为已接受** |
| [[tasks/runtime-file-transfer/02-core-transfer.md\|02]] | 核心包传输能力 | todo | `transfer.py`：路径校验 / upload（临时名 + `mv` 覆盖）/ probe / 下载泵 / list + `TransferError` 与固定中文文案常量 + `__init__.py` 导出 + 单测 |
| [[tasks/runtime-file-transfer/03-server-file-endpoints.md\|03]] | 服务端文件传输接口 | todo | `routes/files.py` 三端点 + 流式装配（`TRANSFER_IO_EXECUTOR` 专用线程池）+ 错误文案表 + schemas + `API.md` 新章节 + 单测 |
| [[tasks/runtime-file-transfer/04-frontend-file-panel.md\|04]] | 前端文件浏览面板 | todo | `client.ts` raw / blob / list 请求能力 + `lib/file-transfer.ts` 纯逻辑 + 入口按钮 + 抽屉 + 面包屑 + 列表 + 上传 / 下载 / 进度 / 覆盖确认框 + 图标资产 vendor（含根目录 `folder.svg` / `file.svg` 移入） |
| [[tasks/runtime-file-transfer/05-desktop-download.md\|05]] | 桌面端下载落盘 | todo | `Cargo.toml` 加 `reqwest`（rustls-tls + stream）+ `tauri-plugin-dialog` + Rust 下载落盘命令 + 命令注册 + 前端桌面 IPC 封装与形态分支 + **Windows 真机验证清单** |
| [[tasks/runtime-file-transfer/06-acceptance-and-docs.md\|06]] | 验收与文档收口 | todo | Playwright 真机 spec（主链路 + 负例）+ 文档同步（`API.md` / 约定 / 看板 / 词汇表）+ **ADR 0018 复核**（状态已是已接受，只复核不改状态） + 任务集收口留档 |

## 依赖顺序

```
01 ──▶ 02 ──▶ 03 ──▶ 04 ──┐
          │                ├──▶ 06
          └──▶ 05 ─────────┘
```

- **01 是硬前置**：机制验证不通过（exec 命令不成立 / 容器内缺 `sh`、`cat`、`wc` / 反代把大文件传输打断），**不进 02**——先改机制与方案，再谈实现。**01 已于 2026-11-09 通过（主通道成立、零新增依赖），02 可开工。**
- **02 → 03 强顺序**：核心包能力先定（路径校验、覆盖语义、类型判定的口径），服务端再包 REST 与流式。
- **03 → 04 / 05 强顺序**：接口契约先定，前端与桌面端各自对接。
- **04 与 05 可并行**：两者互不依赖（上传走浏览器侧，桌面端只新增下载落盘），但都依赖 03 的接口契约。
- **06 收口**：等 03~05 全部就位。

## 关键前置与风险

| 项 | 性质 | 影响 | 01 轮结论（2026-11-09） |
|---|---|---|---|
| 容器内 `sh` / `cat` / `wc` 的存在性 | 01 轮实测 | 基础镜像与典型用户镜像缺 `wc` 时，探测口径要换 | **已闭合**：`sh` / `cat` / `wc` / `tar` / `find` / `stat` / `mv` 在平台基础镜像、debian-slim、alpine、alpine-socat **全部存在** ⇒ **无降级口径**；大小改用 **`stat -c %s`**（O(1)），`wc -c` 兜底 |
| 部署链反代的缓冲与超时 | 01 轮核对 | **大小不限**与反代默认缓冲 / 超时是一对潜在矛盾 | **已闭合**：本机 Traefik **无 body 大小上限**（不会 413）、响应不缓冲；硬约束是**读超时 60 s**（直连 201.23 s 成功、经反代 61.13 s 被掐断）⇒ **要调该 service 的 `transport.respondingTimeouts.readTimeout`**（0 或大值），**列入 03 落地、06 验证**；**远程部署必须自查反代** |
| 大文件内存曲线 | 01 轮与 06 轮各留一份证据 | 「不限大小」必须配「内存有界」的实测证据，否则只是口头承诺 | **已闭合（01 轮）**：宿主峰值 RSS 下载 200 MiB **23.2 MiB**、1 GiB **23.3 MiB**（上传 24.7 / 25.0 MiB），曲线平坦；**前提是端点用 raw 流式 body**（JSON body 实测 200 MiB ⇒ 进程涨约 390 MiB） |
| 容器内路径**无黑名单** | 用户拍板的口径 | 平台不设路径黑名单，**父目录不自动创建**——缺失即报错引导；权限由容器内用户与文件系统决定 |
| WebView2 真机行为 | 本机（Linux）无法验 | 05 轮必须产出 **Windows 真机验证清单**并逐条验过，**未验不宣称完成** |
| release `panic = "abort"` | 桌面端既有约束 | 05 轮新增 Rust 代码**禁 unwrap / 越界索引**，错误一律 `Result` 收口 |
| 与创建时注入的用词区分 | 文档与界面口径 | 界面与文档一律「**运行期传输**」vs「**创建时注入**」，不混用「文件传输」这种含混说法 |

## 任务文件

- [[tasks/runtime-file-transfer/01-prototype-and-mechanism.md]] — 打样与机制验证（**硬前置**）。
- [[tasks/runtime-file-transfer/02-core-transfer.md]] — 核心包传输能力（`transfer.py`）。
- [[tasks/runtime-file-transfer/03-server-file-endpoints.md]] — 服务端文件传输接口（三端点）。
- [[tasks/runtime-file-transfer/04-frontend-file-panel.md]] — 前端文件浏览面板。
- [[tasks/runtime-file-transfer/05-desktop-download.md]] — 桌面端下载落盘。
- [[tasks/runtime-file-transfer/06-acceptance-and-docs.md]] — 验收与文档收口。
- [[architecture/decisions/0018-运行期文件传输机制选型.md]] — **ADR 0018 运行期文件传输机制选型**（**已接受**，含 10 条被实测修正的设计口径与部署链反代约束）。
