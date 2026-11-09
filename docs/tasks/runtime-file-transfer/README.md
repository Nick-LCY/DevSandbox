# 运行期文件传输任务集（上传 / 下载）

本目录是沙箱平台**运行期文件传输**轮的任务集，共 6 个任务，需求来源见 [[prds/runtime-file-transfer.md|运行期文件传输 PRD]]。

这一轮给**运行中的沙箱**补一条类 `docker cp` 的**单文件**双向通路（上传 + 下载），覆盖 web 与桌面两形态。机制走三期端口转发已生产验证的 `docker exec -i` 字节泵资产（核心包 `forwarding.py` 的 `spawn_stream` + `BytePump`），核心包新增**平级**的 `transfer.py`，**零新增第三方依赖**。

**与既有通道的分工**：本轮与「**创建时注入**」（[[architecture/decisions/0012-文件注入采用复制加改属主而非改造挂载预检.md|0012]]）是**两条独立通道**——注入在创建时、单向、只读副本；本轮在运行期、双向、覆盖语义。本轮对**注入通道零改动**、对**命令行零改动**（「sandboxctl 增加 `--file`」是创建时注入的**另一条独立待办**，见 [[current-state.md|当前状态]] 的 TODO 段）。

**状态：01~06 全部收口（均于 2026-11-09 收口；05 的 Windows 真机清单待用户执行）**。**唯一开口 = 05 轮的 Windows 真机验证清单 15 条待用户执行**（本机 Linux 无法验证，**未验不宣称完成**）。全轮留档见 [[tasks/runtime-file-transfer/RESULTS.md|运行期文件传输全轮留档]]，看板见 [[current-state.md|当前状态]]。

**01 轮关键结论（一句话）**：主通道成立且**零新增依赖**（`docker exec -i` + `BytePump` 原样复用）——上传「同目录临时名 → `mv` 原子替换」实测字节精确、覆盖成立、rename 不跟随末端符号链接；下载的**前置分层探测是硬要求**（FIFO 会挂死 `cat`）；列表用 `find` 单次 exec 产出 **NUL 分隔**记录；**大小不限**（200 MiB 与 1 GiB 宿主峰值 RSS 相同 ≈ 23 MiB、曲线平坦）但**受反代读超时约束**（本机 Traefik 默认 `readTimeout=60s`，同一 200 MiB 慢上传直连 201.23 s 成功、经反代 61.13 s 被掐断）；**ADR 0018 已随本轮落档为已接受**。

**02 轮关键结论（一句话）**：核心包 `transfer.py`（路径校验 / upload / probe / 下载泵 / list）+ `TransferError` 与固定中文文案常量落地，**93 项单测**全绿，**审查修复一轮**（结论「需修复后合入」的 **7 项必修全部完成**，含 `set -C` + 16 位十六进制临时名**防写穿**的真机实测验证）；门禁：核心包非 root **362 passed**（基线 292 → 本轮 +70）、root **23 passed**（11m38s）、**ruff rc=0**，服务端基线 **287 passed** 未动；**`forwarding.py` 零改动**、CLI 与创建时注入通道零改动。

**03 轮关键结论（一句话）**：服务端三端点（上传 raw 流式 body / 下载 `StreamingResponse` / 目录列表）落地，并**回修核心包的 `mv` 竞态**（上传脚本在 `mv` 前核对期望字节数，不符即删临时名并报 `size_mismatch`）＋**服务端消费侧字节计数兜底**（两道保险，**chunked 无长度头时不核对**）；门禁：服务端 **329 passed**（基线 287 → +42，`test_server_files.py` **42 项**）、核心包非 root **370 passed**（+8，`test_transfer.py` **93 → 101 项**）/ root **23 passed**（11m20s）、**ruff rc=0**；**部署链读超时以「入口点级」落地**（Traefik v3 无 service 级 `respondingTimeouts` ⇒ 只动 `websecure` 入口点 `readTimeout=0`，infra 提交 `529ac29`），真机 A/B：改前 **60.53 s 被 502 掐断** → 改后 **83.13 s 200 成功**、sha256 一致。

**04 轮关键结论（一句话）**：「文件」入口（与详情 / 停止同级）→ 独立文件抽屉——面包屑（纯交互）+ 三列列表（文件夹在前、隐藏文件显示）+ 上传（XHR 进度 / 多文件队列 / 120 s 无进度看门狗 / 行内取消 / 同名覆盖确认）+ 下载（点行即下载、`Content-Length` 流式进度、多文件并行）+ 关闭与切沙箱全量收口；图标 **113 个 SVG** 本地 vendor（material-icon-theme v5.40.0 的 111 个 + 兜底 `folder.svg` / `file.svg`，**运行时零 CDN**）；用户八条硬约束逐条核验成立；审查一轮「需修复后合入」的 **2 Critical**（`initialPath` 错拿宿主家目录、覆盖确认快照绕过）与 **12 项清单**全部修完；门禁：前端 **vitest 633 passed**（基线 584 → **+49**）、typecheck 双零错、build 成功，后端 **330 passed**（+1，CORS `expose_headers`）/ **ruff rc=0**；桌面下载留桩（`TODO(05)`）。

**05 轮关键结论（一句话）**：桌面形态点文件行 → **原生「保存为」框**（默认名 = 条目名，取消静默）→ Rust 带令牌流式下载（`reqwest` **0.12** + `rustls-tls`，**不引 OpenSSL / aws-lc-rs**）→ 同目录临时名 + `rename` **原子写**；进度经 `download://<作用域>/<downloadId>` 事件回传（100 ms 节流）；`cancel_download` 幂等取消 + 删临时文件；令牌走 invoke 参数**不落盘 / 不进日志 / 不进 URL**；前端抽 `desktop-ipc.ts` 公共层（`desktop-forward` **行为零变化**）；**代码侧收口、Windows 真机待验**（15 条清单已产出，本机 Linux 无法验证）；审查一轮 **1 Critical + 5 Warning + 2 测试缺口**，修复 **9 项全部落地**；门禁：`cargo test` **47 passed**（基线 25 → +22，0 警告）、前端 **651 passed**（基线 633 → +18）、typecheck 双零错、build 成功，**后端 / 核心包零改动**。

**06 轮关键结论（一句话）**：e2e 真机验收通过（**50 passed / 0 failed / 0 flaky / 0 skipped**，9.9 分钟，基线 48+2，**e2e gate 通过**）——新 spec `12-file-transfer.spec.ts`（903 行 / 2 用例）证据链 = **宿主侧 `docker exec` 容器内取证**（sha256 / 字节数 / 属主，**不经过被测接口**）+ **下载回环** + **list 元数据三方对账**，负例钉死 400 / 409 / 401 **固定中文文案原文**，进度断言用 `MutationObserver` **与速度解耦**、负向断言**必配正向对照**；审查一轮（**1 Critical**：残留沙箱复用冲突；**3 Warning**：进度观测竞态 / 负向缺正向对照 / 取消覆盖证据链弱 + 低成本项）→ **修复一轮 10 项**落地、修后复跑全绿（`expect` **102** 处、**用例数不变**）；**ADR 0018 复核通过、无口径变更**（状态维持已接受）；全轮留档见 [[tasks/runtime-file-transfer/RESULTS.md|运行期文件传输全轮收口留档]]。

## 任务清单

| 编号 | 任务 | 状态 | 交付内容 |
|---|---|---|---|
| [[tasks/runtime-file-transfer/01-prototype-and-mechanism.md\|01]] | 打样与机制验证 | **done（2026-11-09）** | 真沙箱实测 exec 命令（上传临时名 + `mv` / `cat` 流出 / **分层探测** / 只读目标报错归类）、反代缓冲与超时核对、200MB 级内存曲线与耗时、容器内 `sh` / `cat` / `wc` / `stat` / `find` 存在性核对、**ADR 0018 已落档为已接受** |
| [[tasks/runtime-file-transfer/02-core-transfer.md\|02]] | 核心包传输能力 | **done（2026-11-09）** | `transfer.py`：路径校验 / upload（临时名 + `mv` 覆盖）/ probe / 下载泵 / list + `TransferError` 与固定中文文案常量 + `__init__.py` 导出 + 单测 —— **93 项测试**（61 个测试函数）全绿，**审查修复一轮**（7 项必修全部完成） |
| [[tasks/runtime-file-transfer/03-server-file-endpoints.md\|03]] | 服务端文件传输接口 | **done（2026-11-09）** | `routes/files.py` 三端点 + 流式装配（`TRANSFER_IO_EXECUTOR` 专用线程池）+ 错误文案表 + schemas + `API.md` 第 16 章 + 单测（**42 项**）+ **核心包回修**（`mv` 前核对期望字节数）+ **Traefik 入口点级读超时落地** —— 审查一轮「需修复后合入」的 **7 项必修全部完成**；门禁：服务端 **329 passed** / 核心包非 root **370 passed** + root **23 passed** / **ruff rc=0** |
| [[tasks/runtime-file-transfer/04-frontend-file-panel.md\|04]] | 前端文件浏览面板 | **done（2026-11-09）** | 工作台「文件」入口 + 独立文件抽屉（面包屑 / 三列列表 / 上传队列 + 进度 + 取消 + 覆盖确认 / 点行下载 + 并行进度 / 关闭收口）+ `client.ts` 三种请求能力 + `lib/file-transfer.ts` 纯逻辑 + **图标 113 个 SVG 本地 vendor**（运行时零 CDN）+ 后端 CORS `expose_headers`——用户八条硬约束逐条核验成立，审查修复一轮（2 Critical + 12 项清单）；门禁：前端 **633 passed**（+49）/ typecheck 双零错 / build 过，后端 **330 passed**（+1）/ **ruff rc=0** |
| [[tasks/runtime-file-transfer/05-desktop-download.md\|05]] | 桌面端下载落盘 | **doing（代码收口，2026-11-09；Windows 真机待验）** | `Cargo.toml` 加 `reqwest` 0.12（rustls-tls，**不引 OpenSSL / aws-lc-rs**）+ `tauri-plugin-dialog` + Rust 下载落盘命令（同目录临时名 + `rename` 原子写）+ 命令注册 + 前端 `desktop-ipc.ts` 公共层与形态分支 + **Windows 真机验证清单 15 条** —— 审查修复一轮（1 Critical + 5 Warning + 2 测试缺口 = **9 项全部落地**）；门禁：`cargo test` **47 passed**（基线 25 → +22）/ 前端 **651 passed**（基线 633 → +18）；**真机未验不宣称完成** |
| [[tasks/runtime-file-transfer/06-acceptance-and-docs.md\|06]] | 验收与文档收口 | **done（2026-11-09）** | Playwright 真机 spec `12-file-transfer.spec.ts`（903 行 / 2 用例：主链路 + 负例）+ 文档全库同步（`API.md` / 约定 / 看板 / 词汇表 / PRD 验收清单）+ **ADR 0018 复核**（状态已是已接受，只复核不改状态）+ **全轮留档** [[tasks/runtime-file-transfer/RESULTS.md\|RESULTS.md]] —— 审查一轮（1 Critical + 3 Warning + 低成本项）→ 修复一轮 **10 项**落地，修后复跑全绿（`expect` 102 处、用例数不变）；e2e 全量 **50 passed / 0 flaky**（9.9 分钟，基线 48+2）、**e2e gate 通过**；**唯一开口 = 05 的 Windows 真机清单待用户执行** |

## 依赖顺序

```
01 ──▶ 02 ──▶ 03 ──▶ 04 ──┐
          │                ├──▶ 06
          └──▶ 05 ─────────┘
```

- **01 是硬前置**：机制验证不通过（exec 命令不成立 / 容器内缺 `sh`、`cat`、`wc` / 反代把大文件传输打断），**不进 02**——先改机制与方案，再谈实现。**01 已于 2026-11-09 通过（主通道成立、零新增依赖），02 可开工**（**02 已于 2026-11-09 收口**）。
- **02 → 03 强顺序**：核心包能力先定（路径校验、覆盖语义、类型判定的口径），服务端再包 REST 与流式。（**03 已于 2026-11-09 收口**；本轮因“客户端中断上传”的半截文件缺陷**回头改了核心包**，已在 02 的能力上补了**期望字节数核对**。）
- **03 → 04 / 05 强顺序**：接口契约先定，前端与桌面端各自对接。（**04 已于 2026-11-09 收口**；**05 代码侧已于 2026-11-09 收口（doing），Windows 真机待验**。）
- **04 与 05 可并行**：两者互不依赖（上传走浏览器侧，桌面端只新增下载落盘），但都依赖 03 的接口契约。
- **06 收口**：等 03~05 全部就位。**（已于 2026-11-09 收口：e2e 真机验收通过、文档全库同步、全轮留档写完；**唯一开口 = 05 的 Windows 真机清单待用户执行**。）**

## 关键前置与风险

| 项 | 性质 | 影响 | 01 轮结论（2026-11-09） |
|---|---|---|---|
| 容器内 `sh` / `cat` / `wc` 的存在性 | 01 轮实测 | 基础镜像与典型用户镜像缺 `wc` 时，探测口径要换 | **已闭合**：`sh` / `cat` / `wc` / `tar` / `find` / `stat` / `mv` 在平台基础镜像、debian-slim、alpine、alpine-socat **全部存在** ⇒ **无降级口径**；大小改用 **`stat -c %s`**（O(1)），`wc -c` 兜底 |
| 部署链反代的缓冲与超时 | 01 轮核对 | **大小不限**与反代默认缓冲 / 超时是一对潜在矛盾 | **已闭合（03 轮落地）**：本机 Traefik **无 body 大小上限**（不会 413）、响应不缓冲；硬约束是**读超时 60 s**（直连 201.23 s 成功、经反代 61.13 s 被掐断）⇒ **Traefik v3 的读超时只在「入口点」上**（无 service 级 `serversTransport.respondingTimeouts`）⇒ 落地为 **入口点级覆盖**：`websecure` 入口点 `readTimeout=0`（**`:80` / `:8080` 与其它 service / router 不动**，infra 提交 `529ac29`）；**真机 A/B：改前 60.53 s 被 502 掐断 → 改后 83.13 s 200 成功**；**06 轮收口时落地状态未回退**（本轮未新增独立的经域名大文件复跑，证据统一引用 03 轮 A/B）；**远程部署必须自查反代** |
| 大文件内存曲线 | 01 轮（机制侧）与 03 轮（实现侧）各留一份证据 | 「不限大小」必须配「内存有界」的实测证据，否则只是口头承诺 | **已闭合（01 轮）**：宿主峰值 RSS 下载 200 MiB **23.2 MiB**、1 GiB **23.3 MiB**（上传 24.7 / 25.0 MiB），曲线平坦；**前提是端点用 raw 流式 body**（JSON body 实测 200 MiB ⇒ 进程涨约 390 MiB）。**实现侧证据在 03 轮**：250 MiB 经域名上传控制台 RSS **58.8 → 59.2 MiB** 平坦；**06 轮未新增独立的 e2e 级大文件证据，以 03 轮证据代之**（见 [[tasks/runtime-file-transfer/RESULTS.md\|全轮留档]] 第五节） |
| 容器内路径**无黑名单** | 用户拍板的口径 | 平台不设路径黑名单，**父目录不自动创建**——缺失即报错引导；权限由容器内用户与文件系统决定 |
| WebView2 真机行为 | 本机（Linux）无法验 | 05 轮必须产出 **Windows 真机验证清单**并逐条验过，**未验不宣称完成** | **清单已产出（15 条，全文见 [[tasks/runtime-file-transfer/05-desktop-download.md\|05 任务]]）**，**待用户 Windows 真机执行**——**全轮唯一开口**；在此之前 **05 任务维持 `doing`** |
| release `panic = "abort"` | 桌面端既有约束 | 05 轮新增 Rust 代码**禁 unwrap / 越界索引**，错误一律 `Result` 收口 |
| 与创建时注入的用词区分 | 文档与界面口径 | 界面与文档一律「**运行期传输**」vs「**创建时注入**」，不混用「文件传输」这种含混说法 |

## 任务文件

- [[tasks/runtime-file-transfer/01-prototype-and-mechanism.md]] — 打样与机制验证（**硬前置**）。
- [[tasks/runtime-file-transfer/02-core-transfer.md]] — 核心包传输能力（`transfer.py`）——**done（2026-11-09）**：93 项单测全绿、审查修复一轮（7 项必修全部完成）。
- [[tasks/runtime-file-transfer/03-server-file-endpoints.md]] — 服务端文件传输接口（三端点）——**done（2026-11-09）**：服务端 **329 passed** / 核心包非 root **370 passed** + root **23 passed** / **ruff rc=0**；**核心包回修**（`mv` 前核对期望字节数 + 服务端计数兜底）；**Traefik 入口点级**读超时落地（真机 A/B：60.53 s 掐断 → 83.13 s 成功）。
- [[tasks/runtime-file-transfer/04-frontend-file-panel.md]] — 前端文件浏览面板——**done（2026-11-09）**：入口 / 抽屉 / 面包屑 / 三列列表 / 上传下载进度与覆盖确认 / 图标 **113 个 SVG** 本地化；八条硬约束核验成立，审查修复一轮（2 Critical + 12 项清单）；门禁前端 **633 passed**（+49）/ 后端 **330 passed**（+1）。
- [[tasks/runtime-file-transfer/05-desktop-download.md]] — 桌面端下载落盘——**doing（代码收口，2026-11-09；Windows 真机待验）**：原生「保存为」+ Rust 带令牌流式下载 + 同目录临时名 `rename` 原子写 + 进度事件（100 ms 节流）+ `cancel_download` 幂等取消；令牌走 invoke 参数不落盘；审查修复一轮 **9 项**；门禁 `cargo test` **47 passed**（+22）/ 前端 **651 passed**（+18）；**15 条 Windows 真机清单已产出，本机 Linux 无法验证**。
- [[tasks/runtime-file-transfer/06-acceptance-and-docs.md]] — 验收与文档收口——**done（2026-11-09）**：e2e 真机 spec `12-file-transfer.spec.ts`（903 行 / 2 用例：主链路 + 负例），证据链 = **宿主侧 `docker exec` 容器内取证（不经过被测接口）+ 下载回环 + list 元数据三方对账**，负例钉死 400/409/401 固定中文文案原文，进度断言用 `MutationObserver` 与速度解耦，负向断言必配正向对照；审查一轮（1 Critical + 3 Warning + 低成本项）→ **修复一轮 10 项**落地、复跑全绿（`expect` 102 处）；e2e 全量 **50 passed / 0 flaky**（9.9 分钟）；**ADR 0018 复核通过（状态不变）**。
- [[tasks/runtime-file-transfer/RESULTS.md]] — **运行期文件传输全轮收口留档**：各轮交付与门禁数字、e2e 证据链、**大文件真机证据**、部署动作（Traefik 入口点级 `readTimeout=0`）、环境事件、已知边界与留白、Windows 清单指针、提交链。
- [[architecture/decisions/0018-运行期文件传输机制选型.md]] — **ADR 0018 运行期文件传输机制选型**（**已接受**，含 10 条被实测修正的设计口径与部署链反代约束；**06 轮复核通过，无口径变更**）。
