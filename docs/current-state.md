# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 活跃需求
- **文件窗格与 Obsidian 阅读器** — **已立项（2026-11-12），01~04 已收口（2026-11-13：01 打样、02 镜像 `base:0.3.1` 注入 + `SANDBOX_NETWORK`、03 前端 pwd 通道、04 文件窗格分屏骨架 + 抽屉退役 + 全屏范围改造），05~08 未开工**。控制台终端区改造：① **文件窗格**——终端右侧伴生**分屏**（可折叠），**锚定当前终端会话的 shell 当前目录**（pwd 走 **OSC 1337 shell integration**），以快速浏览 / 下载为主、纯文本预览为辅；② **固定 Obsidian tab**——全宽双栏 vault 阅读器（左树右预览），**markdown 渲染 + wikilink 正向跳转**。需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]，任务集见 [[tasks/file-pane-obsidian/README.md|文件窗格与 Obsidian 阅读器任务集]]；**关键口径**：**彻底放弃自动跟随 pwd**（唯一联动入口是工具条「回跳」按钮）、文件窗格内**不做 markdown 渲染**（渲染专属 Obsidian tab）、**pwd / vault 根 / 折叠态全部前端本地记忆**（不入后端）、全局文件抽屉退役、**无 ADR**（机制写进 PRD「方案」节）。**2026-11-13 口径修订（用户拍板）**：大文件预览改「**二次确认 + 进度条加载**」（**废除 2 MB 强制截断**与「文件过大」提示条）、镜像补 **UTF-8 locale ENV** 且创建沙箱容器时注入 **`SANDBOX_NETWORK`**（值 = 实际生效网络名，**并入任务 02**）、Obsidian tab 改用 **官方 logo SVG**（本地资产、零 CDN）；**验收标准由 35 条增至 38 条**（新增 OBS-11 / ENV-01 / ENV-02）。

## 历史交付
- **控制台前端托管到 Cloudflare（Workers + 静态资产）** — **已完成（2026-11-12 收口，01~05 全部 done）**。控制台前端从「后端托管」解耦并独立发版：载体是 **Cloudflare Workers + 静态资产**（**不是 Pages**），域名 **`dev.sankabox.com`**，项目标识定名 **`dev-sandbox`**（Worker 与 `.workers.dev` 地址同名）；后端同时纯 API 化（`console_mounted` 字段删除、`GET /` 与 `/assets/*` 一律 404）。**核心口径**：**单一所有者原则**——Terraform 只管域名层（zone data + `workers_custom_domain`），**脚本与静态资产归 `wrangler`**，部署顺序 `wrangler deploy` → `terraform apply`；远端状态存**真实 AWS S3**（region `ap-southeast-1`、**S3 原生锁 `use_lockfile = true` 已开启**）；**手动部署不做 CI**。需求见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，任务集见 [[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]，全轮留档见 [[tasks/console-cloudflare/RESULTS.md|控制台前端托管到 Cloudflare 全轮收口留档]]，决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]（**已接受**，单向取代 [[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 第 6 节「Cloudflare 静态托管的退役」，历史表述不改写）。
- **运行期文件传输（上传 / 下载）** — **已完成（2026-11-11 收口，01~06 全部 done）**。为**运行中**的沙箱补了一条类 `docker cp` 的**单文件双向通路**（上传 + 下载），覆盖 **web + 桌面**两形态；机制走三期端口转发已生产验证的 `docker exec -i` 字节泵（核心包新增 `transfer.py`，**零新增第三方依赖**），与「创建时文件注入」（[[architecture/decisions/0012-文件注入采用复制加改属主而非改造挂载预检.md|0012]]）是**两条独立通道**。**核心口径**：上传走「同目录临时名 → `mv` 原子替换」，下载走 `cat` 流出 + 前置分层探测；**大小不限但受反代读超时约束**（Traefik **入口点级** `websecure` `readTimeout=0` 已落地）。需求见 [[prds/runtime-file-transfer.md|运行期文件传输 PRD]]，任务集见 [[tasks/runtime-file-transfer/README.md|运行期文件传输任务集]]，全轮留档见 [[tasks/runtime-file-transfer/RESULTS.md|运行期文件传输全轮留档]]，机制决策见 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]]（**已接受**，06 轮复核无口径变更）。
- **三期：桌面端打包（Tauri）与端口转发** — **已完成（2026-11-04 收口，01~09 全部 done）**。三条交付线：① **桌面端**——Tauri v2 壳，定位**纯连接器**（不拉起、不托管、不探测后端），与 web 形态**共用同一份前端产物**；② **连接层认证**——后端全部 `/api` 受访问令牌保护、浏览器侧 WebSocket 走一次性票据，**准入边界 = 令牌 + 票据**；③ **端口转发**——链路只有「沙箱 ⇄ 用户机」两点（用户机监听 ⇄ 隧道 WS ⇄ `docker exec -i` 字节泵 ⇄ 沙箱容器端口），**后端宿主零端口**，端口选择权在用户机。需求见 [[prds/phase3-desktop.md|三期 PRD]]，任务集见 [[tasks/phase3-desktop/README.md|三期任务集]]，实测留档见 [[tasks/phase3-desktop/RESULTS.md|三期留档]]，决策依据见 [[architecture/decisions/0013-三期定位改定与认证重启.md|0013]]、[[architecture/decisions/0014-端口转发机制选型.md|0014]]、[[architecture/decisions/0015-桌面壳与连接配置抽象.md|0015]]。**收口后修复（2026-11-09）**：`https://` 后端下的 **wss 隧道建连即 panic**（`rustls` 缺进程级 crypto provider）已修复，Windows 真机复测通过。
- **控制台默认运行用户切换为非 root（sankabox）** — **已完成（2026-11-06）**。控制台服务不再默认以 root 运行：仓库 systemd 单元 `User=` 由 `root` 改为 `sankabox`，配套把平台数据根属主迁到该用户（`registry-proxy` 子树除外），本机已按「先迁属主 → 再改单元 → daemon-reload + restart」的顺序切完并验证通过（进程 `USER=sankabox`、`HOME=/home/sankabox`）。**收益**：内置 pi 模板 `tpl_pi_dev` 的五条凭证路径不再命中核心包宿主敏感目录拒绝清单（默认 root 下必然 400）。**前提**（单元头注释与仓库 README 已写全）：免密 sudo 覆盖两条通道、数据根已存在且属主为运行用户、监听端口 > 1024、部署产物可读可执行。**口径未变**：宿主特权操作仍经免密 sudo，实际权限 ≈ root——**非 root 默认不等于降权**，要真正收敛信任边界须收窄 sudoers 规则范围（遗留待办见下方 TODO「免密 sudo 规则收窄」）。决策依据见 [[architecture/decisions/0016-控制台默认运行用户改为非root.md|0016]]。
- **移除终端空闲回收** — **已完成（2026-11-09）**。终端会话的空闲回收机制整体下线：后台巡检线程、「距上次附着 ≥30 分钟即自动关闭」判据、`reclaimed` 退出原因与 `SANDBOX_TERMINAL_IDLE_TIMEOUT` 一并移除。会话**只有三种用户可感知的结束方式**——用户主动删除（`closed_by_user`）、容器内进程自己退出或崩溃（`exited`）、沙箱删除（容器销毁连带 exec 死亡，走 `exited`，前端提示异常结束属预期）；另有服务退出兜底（`shutdown`，非用户可感知）。**保留的口径**：服务重启仍作废全部会话并做启动清扫（跨实例保护不变）、名额语义不变（全局 20 / 单沙箱 5，已退出仍占、需手动移除，超限报错改为引导在终端标签条手动关闭）。**收益**：断开标签页后会话与进程在后台继续存活，重开能接回同一 shell 现场。**已知后果**：名额会持续积压，已登记待办（见下方 TODO「终端会话名额积压待观察」）。决策依据见 [[architecture/decisions/0017-移除终端空闲回收.md|0017]]。
- 历史交付的叙事与验收留档：git 历史 + [[tasks/README.md|docs/tasks/ 各留档页]]。

## 规划
> 以下为用户已拍板、尚未立项的方向；立项后再补 PRD 与任务集，并在下方任务看板挂行。

- **终端会话顺序与快捷键切换标签**：沙箱内多个终端会话按稳定顺序排列，支持键盘快捷键在标签之间切换；控制台小型体验轮。**与本需求线（[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器]]）任务 04 动同一片终端标签区，建议在本需求线收口后再启动。**
- **沙箱详情与转发记录接口合并**：控制台对「沙箱详情」与「转发记录列表」当前是两个接口、前端一个定时器一拍并行双刷；用户倾向后续把两份数据合并为一个接口读径（如详情响应嵌转发记录，或嵌套子资源）。未立项；立项时需处理已发布的三条转发管理 REST 契约的去留（保留则须钉死两条读径等价，废弃则破坏已发布 API 形状）与合并响应的部分失败语义（详情成功但转发读取失败时返回什么）。

## 任务看板
| 任务集 | 状态 | 入口 |
|---|---|---|
| 文件窗格与 Obsidian 阅读器 | 01~04 done（2026-11-13），05~08 todo | [[tasks/file-pane-obsidian/README.md\|文件窗格与 Obsidian 阅读器任务集]] |
| 控制台前端托管到 Cloudflare | done（2026-11-12 收口） | [[tasks/console-cloudflare/README.md\|控制台前端托管到 Cloudflare 任务集]] |
| 三期：桌面端打包 + 端口转发 | done（2026-11-04 收口） | [[tasks/phase3-desktop/README.md\|三期任务集]] |
| 运行期文件传输（上传 / 下载） | done（2026-11-11 收口） | [[tasks/runtime-file-transfer/README.md\|运行期文件传输任务集]] |

## TODO / 阻塞
- [ ] 统一镜像代理缓存 GC 命令待做。
- [ ] sandboxctl 增加文件注入参数（如 `--file`）——文件注入轮核心能力已落地，待补命令行入口。
- [ ] 文件注入降级路径收口（终审遗留，不阻断使用）：预检阶段纳入本次目标沙箱的计划家目录（消除干跑/实跑对自家目录的口径差）；getent / test -d / readlink 失败时从静默放行改为可观测（error 日志 + API.md 写明降级行为）。
- [ ] 终端中文乱码排查与修复——现象：终端中中文**间歇性**乱码（用户实测观察，间歇出现、非必现）。排查方向候选（按嫌疑排序，逐项排查后删改本条）：① 终端帧协议的 UTF-8 解码边界——多字节中文字符被 WebSocket 分帧截断时，若按单条消息边界做非流式解码（`TextDecoder` 不带 `stream: true`）会解出半个字符的乱码，与「间歇性」现象最吻合（后端按读块 / 分片发二进制帧，帧边界与字符边界无关）；② 容器内 locale 非 UTF-8（shell 的 `LANG` / `LC_ALL`）——**2026-11-13**：随文件窗格轮**任务 02** 落地（镜像 `ENV` **基础层** + 平台起容器时**强制注入**，**平台值优先**于用户同名 env），**落地后以实测观察是否收敛**（该项**落地不等于本 TODO 自动关闭**）；③ 终端字体的 CJK 字形回退（Geist Mono 无中日韩字形）。修复落点大概率在前端 `src/lib/` 的终端帧解码纯函数（现状：二进制帧字节直接交给终端渲染，尚无平台侧独立解码函数；该处有单测，改解码口径必须同步改测试）。
- [ ] 免密 sudo 规则收窄（[[architecture/decisions/0016-控制台默认运行用户改为非root.md|0016]] 遗留，**不阻断使用**）：控制台默认非 root 运行后，宿主特权操作仍经一条宽口径免密 sudo（`sankabox ALL=(ALL) NOPASSWD: ALL`），实际权限 ≈ root。要真正收敛信任边界，须把 `NOPASSWD` 收窄到平台真正用到的那几类命令（docker、useradd/userdel/usermod/groupadd、install、chmod/chown、tee、loginctl、systemctl --user 等）——代价是以后新增宿主命令必须同步补规则，漏一条就报权限错。
- [ ] 终端会话名额积压待观察（[[architecture/decisions/0017-移除终端空闲回收.md|0017]] 遗留，**不阻断使用**）：空闲回收移除后，**无附着的运行中会话**与**已退出的会话**都会持续占用终端名额（全局 20 / 单沙箱 5，**已退出也占**）；名额占满后新建终端会报错，需在**终端标签条手动关闭**若干会话才能继续用。待观察真实使用是否需要调整名额语义（如已退出会话是否该让出名额）或引入更顺手的清理引导（如批量清理入口）；在拍板前维持现状。
- [ ] **release `panic = "abort"` 的处置（待拍板，不阻断使用）**：桌面端 release profile 配了 `panic = "abort"`，**桥接任务 panic 在发布版会让整个应用闪退**（2026-11-09 修掉的 wss provider panic 走的是 dev 构建，未在打包版触发；同类 panic 一旦命中打包版即整进程退出）。候选方案：**① 去掉 `abort`**（改回 unwind，panic 只挂当前任务）；**② 对桥接任务做 panic 兜底**（捕获后转失败上报，界面给红字 + toast，不带崩进程）。详见 [[tasks/phase3-desktop/RESULTS.md|三期留档]] 第十节。
- [ ] **监听开启后的自连探测（待拍板，不阻断使用）**：把「**绑定成功** / **本机端口被 IDE 等抢占** / **隧道不通**」三种状态在 UI 上区分开——当前**绿灯只表示本机监听已建立**，不表示隧道可用（VS Code 端口转发抢占 8000 是真实存在的一例：绑定不报错、连接被抢走、绿灯依旧）。详见 [[tasks/phase3-desktop/RESULTS.md|三期留档]] 第十节。
- **宿主部署可选小项（不阻断，2026-11-12 登记）**：① **单元注释文案与新模板对齐**——可选，需按「新模板 + 回填本机三行」的**合并方式**落地（不覆盖单元，避免丢本机定制）；② **注入令牌长度 14 < 建议 16**——轮换可消告警，需**同步改单元与前端配置**。
- 阻塞项：无。
