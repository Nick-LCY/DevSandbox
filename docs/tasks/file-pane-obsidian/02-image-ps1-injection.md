---
prd: prds/file-pane-obsidian.md
status: todo
---
# 任务：镜像与环境变量注入（OSC 1337 / locale / SANDBOX_NETWORK）

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **依赖 01 的实测结论**——注入写法（bash 转义与引号）按 01 轮实测校准后的版本落地，不自行发挥。
> **2026-11-13 扩 scope**：因本任务本来就要动镜像、bump 版本，用户要求**顺带**做两件事——① base image 补 **UTF-8 locale ENV**；② 创建沙箱容器时注入 **`SANDBOX_NETWORK`**。镜像部分口径**不变**。

## 目标

### 一、镜像：OSC 1337 的 PS1 注入（原有部分）

把 01 轮实测确定的 OSC 1337 上报片段**正式注入基础镜像**，让平台起的 `bash` 会话默认上报工作目录。

- 注入点：**base-image 的 `/etc/bash.bashrc`**（追加，不覆盖原有内容）；
- 注入内容：**保留原 PS1 + 追加 OSC 1337 CurrentDir 序列**（tabby 方案写法，最终形态按 01 轮实测校准）；
- **镜像版本 bump 并构建推送**；
- 「**交互式**非登录 shell 会读 `~/.bashrc` 与 `/etc/bash.bashrc`（系统级生效、不依赖容器内用户家目录）」这一机制（控制台的终端会话以 `bash -i` 起）写进 PRD 的「方案」节（**已写**，本轮复核措辞与实测一致即可）。

### 二、镜像：补 UTF-8 locale ENV（2026-11-13 新增）

- base image 的 Dockerfile **新增两条 ENV**：`ENV LANG=C.UTF-8` 与 `ENV LC_ALL=C.UTF-8`；
- **纯新增**——现状 Dockerfile **一条 ENV 都没有**，容器内 locale 处于**未定义态**；
- 与看板 TODO「**终端中文间歇乱码**」的排查方向②「**容器内 locale 非 UTF-8**」直接相关——该项**落地后该 TODO 不自动关闭**，**以实测观察是否收敛为准**。

### 三、核心包：创建沙箱容器时注入 `SANDBOX_NETWORK`（2026-11-13 新增）

- **值 = 实际生效的 docker 网络名**：默认 `<沙箱名>-net`；**用户创建时指定了自定义网络则取用户指定值**——**绝不能字符串拼 `<沙箱名>-net`**；
- **用途**：沙箱内挂载了**自己用户的 rootless docker 套接字**、镜像里有 **docker CLI**，内部 `docker run --network "$SANDBOX_NETWORK"` 即可与**沙箱容器、转发容器同网按名互访**；
- **注入机制**：`SANDBOX_NETWORK` 是**容器内变量**（与既有终端会话 exec 注入的 `SANDBOX_TERMINAL_SESSION` **命名风格一致**），**不是宿主平台参数**（平台参数前缀是 `SANDBOX_PLATFORM_*`）；建议注入在**容器运行的 env 合并处**、**不写入 metadata、不经 API 响应掩码**；
- **创建与重启两条路径都要覆盖**，**核心包单测齐备**。

## 涉及文件

- 基础镜像的 Dockerfile / 构建脚本 — 追加 `/etc/bash.bashrc` 注入段 + **新增两条 locale ENV**
- 基础镜像版本号（**bump**）与镜像代理内的发布配置
- 核心包（`lifecycle.py` 等容器创建 / 重启路径）— **注入 `SANDBOX_NETWORK`**（取实际生效网络名）
- 核心包单测 — 覆盖**创建与重启两条路径**的 env 注入
- `docs/prds/file-pane-obsidian.md` — 复核「方案」节的 PS1 片段与 bash 读取机制表述；**新增方案七**（镜像与环境变量补齐）已写
- 镜像构建产物（构建与推送）

## 完成标准

- [ ] base-image 的 `/etc/bash.bashrc` **追加**了 OSC 1337 CurrentDir 注入段，**原 PS1 保留不变**（注入前后对比原提示符不变）；最终写法与 01 轮实测结论一致（对应 PRD 验收项 **PWD-01**）。
- [ ] 基础镜像**版本 bump** 完成，**构建并推送成功**；镜像代理里能拉到新版本。
- [ ] 用新镜像起的沙箱里，`bash -i` 会话**实测能收到 pwd 上报**（对应 PRD 验收项 **PWD-02**）。
- [ ] `dash` / `sh` 会话**自然降级**：不产生 OSC 序列、终端输出不被污染（对应 PRD 验收项 **PWD-02**）。
- [ ] PRD「方案」节关于 **交互式非登录 shell 读 `~/.bashrc` 与 `/etc/bash.bashrc`** 的机制说明与实测一致（措辞如需调整，**只改本轮新增段落**，不改既有轮次的历史表述）。
- [ ] base-image 的 Dockerfile 含 **`ENV LANG=C.UTF-8`** 与 **`ENV LC_ALL=C.UTF-8`** 两条；**版本 bump** 且**构建通过**、`verify.sh` **判定通过**；用新镜像起的沙箱里，**交互 shell 内实测** `LANG` / `LC_ALL` 均为 `C.UTF-8`（对应 PRD 验收项 **ENV-01**）。
- [ ] 平台创建的沙箱容器 env 含 **`SANDBOX_NETWORK=<实际生效网络名>`**：默认 `<沙箱名>-net`；**用户指定自定义网络时取自定义值**（**不得**字符串拼 `<沙箱名>-net`）；该值**不写入 metadata、不经 API 响应掩码**（对应 PRD 验收项 **ENV-02**）。
- [ ] **创建与重启两条路径**的 env 注入均有**核心包单测**覆盖（对应 PRD 验收项 **ENV-02**）。
- [ ] **外部依赖登记**：现有沙箱需要**重建**才能用上新镜像——**重建由用户执行**（本任务不代劳），此事实作为**验收前置**登记进任务文件与收口留档（**镜像只存宿主 root 守护进程、沙箱守护进程经核心包注入，存量沙箱不会自动拿到新镜像**；该前置口径不变）。
- [ ] **ADR 0004 修订范围已扩大**的提示已登记：[[architecture/decisions/0004-镜像契约与默认沙箱镜像.md|ADR 0004]] §3「运行时极简」的修订行要同时覆盖 **PS1 注入**与 **Dockerfile 新增 ENV** 两条——**修订行由任务 08 统一落**，本任务只实现、不改 ADR。

## 依赖

- 依赖 [[tasks/file-pane-obsidian/01-prototype-osc-loop.md|01 打样轮]]（注入写法的实测结论——**硬前置**）。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
