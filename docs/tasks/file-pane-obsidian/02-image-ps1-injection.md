---
prd: prds/file-pane-obsidian.md
status: done
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

- [x] base-image 的 `/etc/bash.bashrc` **追加**了 OSC 1337 CurrentDir 注入段，**原 PS1 保留不变**（注入前后对比原提示符不变）；最终写法与 01 轮实测结论一致（对应 PRD 验收项 **PWD-01**）。
- [x] 基础镜像**版本 bump** 完成，**构建并推送成功**；镜像代理里能拉到新版本。
      —— **口径校正**：平台自建镜像（`sandbox-platform/` 前缀）**不经统一镜像代理分发**，而是**由宿主导出注入沙箱守护进程**（既有口径，见 [[architecture/decisions/0008-统一镜像代理与离线包废弃.md|ADR 0008]] 与 `base-image/RESULTS.md` 0.2.0 节）。本轮的口径因此是：**宿主构建出 `sandbox-platform/base:0.3.1` ⇒ 核心包 `images.ensure_image_from_source` 能把它注入沙箱守护进程 ⇒ 新沙箱直接用上**（已用真沙箱实测，见进展第三节）。代理侧**无发布配置需改**。
- [x] 用新镜像起的沙箱里，`bash -i` 会话**实测能收到 pwd 上报**（对应 PRD 验收项 **PWD-02**）。
- [x] `dash` / `sh` 会话**自然降级**：不产生 OSC 序列、终端输出不被污染（对应 PRD 验收项 **PWD-02**）。
- [x] PRD「方案」节关于 **交互式非登录 shell 读 `~/.bashrc` 与 `/etc/bash.bashrc`** 的机制说明与实测一致（措辞如需调整，**只改本轮新增段落**，不改既有轮次的历史表述）。
      —— **结论：措辞与实测一致，本轮未改 PRD**。两条依据：① **机制段**（方案二「非登录 shell 的读取机制」）写的是「交互式非登录 shell 读 `~/.bashrc` 与 `/etc/bash.bashrc`，不读 `/etc/profile` 与 `~/.bash_profile`/`~/.profile`」——与 01 轮实测（`bash -i` 读序 = `/etc/bash.bashrc` → `~/.bashrc`；`/bin/bash` 二进制里确实编译进了 `/etc/bash.bashrc`）**逐条吻合**；② **注入片段**（方案二给的 tabby 写法）PRD 自己就标了「**bash 转义与引号按实现校准**——最终写法由 01 打样轮实测定稿，02 轮按其落地」，而 01 轮已证伪该写法并给出定稿、本轮已按定稿落地 ⇒ PRD 的「待校准」表述**恰好被本轮闭环**，无需改写。
- [x] base-image 的 Dockerfile 含 **`ENV LANG=C.UTF-8`** 与 **`ENV LC_ALL=C.UTF-8`** 两条；**版本 bump** 且**构建通过**、`verify.sh` **判定通过**；用新镜像起的沙箱里，**交互 shell 内实测** `LANG` / `LC_ALL` 均为 `C.UTF-8`（对应 PRD 验收项 **ENV-01**）。
- [x] 平台创建的沙箱容器 env 含 **`SANDBOX_NETWORK=<实际生效网络名>`**：默认 `<沙箱名>-net`；**用户指定自定义网络时取自定义值**（**不得**字符串拼 `<沙箱名>-net`）；该值**不写入 metadata、不经 API 响应掩码**（对应 PRD 验收项 **ENV-02**）。
- [x] **创建与重启两条路径**的 env 注入均有**核心包单测**覆盖（对应 PRD 验收项 **ENV-02**）。
- [x] **外部依赖登记**：现有沙箱需要**重建**才能用上新镜像——**重建由用户执行**（本任务不代劳），此事实作为**验收前置**登记进任务文件与收口留档（**镜像只存宿主 root 守护进程、沙箱守护进程经核心包注入，存量沙箱不会自动拿到新镜像**；该前置口径不变）。
      —— **已登记事实：本轮不代劳重建，待用户重建后复验**（打样沙箱 `image-verify` / `image-verify-2` 已在用新镜像实测通过；存量沙箱 `qilu` / `qqbot` **未动**）。
- [x] **ADR 0004 修订范围已扩大**的提示已登记：[[architecture/decisions/0004-镜像契约与默认沙箱镜像.md|ADR 0004]] §3「运行时极简」的修订行要同时覆盖 **PS1 注入**与 **Dockerfile 新增 ENV** 两条——**修订行由任务 08 统一落**，本任务只实现、不改 ADR。
      —— **已登记**（本节「进展」第六节转录给 08 轮；本轮**未改 ADR**）。

## 依赖

- 依赖 [[tasks/file-pane-obsidian/01-prototype-osc-loop.md|01 打样轮]]（注入写法的实测结论——**硬前置**）。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。

## 进展（2026-11-13 收口）

> **本轮全部完成标准通过。** 交付三块：**① 镜像**（`/etc/bash.bashrc` 追加 OSC 1337 注入段 + 两条 UTF-8 locale `ENV`，版本 `0.3.0` → `0.3.1`，构建成功、`verify.sh` **48 项全通过**）；**② 核心包**（创建/重启沙箱容器时注入 `SANDBOX_NETWORK` = **实际生效网络名**，新增单测 **10 项**，全量 pytest **403 passed**、ruff rc=0）；**③ 真沙箱复验**（用 `0.3.1` 建打样沙箱实测 OSC / locale / `SANDBOX_NETWORK` / `sh` 降级四项全通过，打样沙箱已删）。
> **注入写法逐字照抄 01 轮定稿**，未自行发挥；PRD「方案」节措辞与实测一致，**未改 PRD**；**ADR 0004 未改**（修订行仍由 08 轮落）。

### 一、镜像侧：Dockerfile 注入段的最终形态（含 Dockerfile 层面的转义处理）

**镜像内 `/etc/bash.bashrc` 的实际末尾**（原 58 行**一字不改**，追加后 62 行）：

```bash
# ---- 平台注入：OSC 1337 pwd 上报（交互式非登录 shell 生效）----
# 单引号是关键：$(pwd) 留到画提示符时才求值；写成双引号会把路径冻死。
export PS1="$PS1"'\[\e]1337;CurrentDir=$(pwd)\a\]'
```

**注入行逐字等于 01 轮定稿**（`export PS1="$PS1"'\[\e]1337;CurrentDir=$(pwd)\a\]'`）——已在镜像内用 `tail -n 1` 逐字节比对过。

**Dockerfile 层面的转义处理**（本轮最需要当心的一处）：

```dockerfile
RUN set -eux; \
    printf '%s\n' \
      '' \
      '# ---- 平台注入：OSC 1337 pwd 上报（交互式非登录 shell 生效）----' \
      '# 单引号是关键：$(pwd) 留到画提示符时才求值；写成双引号会把路径冻死。' \
      'export PS1="$PS1"'\''\[\e]1337;CurrentDir=$(pwd)\a\]'\''' \
      >> /etc/bash.bashrc
```

- **用 `printf '%s\n'` 而不是 `echo`**：dash 的 `echo` 会解释 `\e` / `\a` 等反斜杠转义 ⇒ 落盘内容会被改坏；`printf` 的 `%s` **不解释参数里的反斜杠序列**，`\e` / `\a` / `\[` / `\]` 原样落盘。
- **行内单引号用 shell 的 `'\''` 拼接技巧写出**：注入行里 `$(pwd)` **必须**留在单引号里（否则 `export` 那一刻就被求值、路径冻死），而 Dockerfile 的 `RUN` 又必须经 `/bin/sh -c` ⇒ 单引号自身要先「退出单引号区」再以 `\'` 落回。
- **整行在 `RUN` 里全程处于单引号内** ⇒ `$(pwd)` 与 `"$PS1"` 在**构建期不被求值**，落盘的就是定稿原文。
- **追加在文件末尾**（不是中间）：Debian 的 `/etc/bash.bashrc` 顶部有非交互守卫（`[ -z "$PS1" ] && return`），非交互 shell 读到那里就返回 ⇒ 注入**只对会画提示符的交互式非登录 shell 生效**（正是想要的效果）。

**另外两条 ENV**（纯新增，插在 `LABEL` 之后）：

```dockerfile
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
```

**版本 bump**：`ARG BASE_VERSION=0.3.0` → `0.3.1`；Dockerfile 头注释的构建示例同步改 `-t sandbox-platform/base:0.3.1`。

### 二、镜像侧：构建与判定输出摘要

| 项 | 实测 |
|----|------|
| 构建命令 | `docker build --build-arg DOCKER_CLI_VERSION=29.6.2 -t sandbox-platform/base:0.3.1 base-image`（仓库根执行） |
| 构建耗时（墙钟） | **1.7 秒**（增量：底座层与 docker 客户端层与 0.3.0 共用缓存，新增注入层 0.2 秒） |
| 构建结果 | 成功（BuildKit，联网构建） |
| 镜像 | `sandbox-platform/base:0.3.1`，image id `sha256:51c34d2c512cb0ce7dcd0e23bf8cceaf12888ae5723a26fc7972b08eb66aba53` |
| 体积 | `docker image inspect .Size` = **98,496,943 B = 98.5 MB**（0.3.0 为 98,494,563 B，**+2,380 B**；新增 1 个 12.3 kB 注入层） |
| `inspect .Config.Env` | `["PATH=…","LANG=C.UTF-8","LC_ALL=C.UTF-8"]` |
| `verify.sh` 判定 | **共 48 项，不通过 0 项**（**42 项原有全通过 + 6 项新增全通过**） |

**`verify.sh` 的 6 项新增判定**（沿用 0.3.0 当年「镜像内容变了、判定脚本跟着长」的同一套路；总数 42 → 48）：

| # | 判定 | 结果 |
|---|------|------|
| 10.1 | `OSC 1337 注入段在 /etc/bash.bashrc 末尾`（末行与定稿原文**逐字节**比对） | 通过 |
| 10.2 | `OSC 1337 注入为追加（原有 PS1 保留）`（用 `grep -cE` 匹配行首可选空白后的 `PS1=`，命中 ≥1） | 通过 |
| 10.3 | `bash -i 实测上报 OSC 1337 CurrentDir`（功能判定，载荷 `CurrentDir=/workspace`） | 通过 |
| 10.4 | `sh -i 自然降级：不产生 OSC 序列`（0 条 OSC、输出无污染） | 通过 |
| 10.5 | `ENV LANG=C.UTF-8` | 通过 |
| 10.6 | `ENV LC_ALL=C.UTF-8` | 通过 |

> **默认镜像变量按仓库惯例改了默认值**（`BASE_IMAGE="${BASE_IMAGE:-sandbox-platform/base:0.3.1}"`，`verify-rootless.sh` 同步）：仓库既有惯例见 [[tasks/console-templates/01-base-image-0.3.0.md|任务 01-base-image-0.3.0]] 的完成标准「`verify.sh` 默认校验镜像改为 …」。两种跑法都实测过：直接 `./verify.sh` 与 `BASE_IMAGE=sandbox-platform/base:0.3.1 ./verify.sh`，**均为 48 项全通过**。

**镜像内实测证据**（`bash -i` 的 OSC 字节，`xxd`）：

```
00000080: 343a 2f77 6f72 6b73 7061 6365 2320 1b5d  4:/workspace# .]
00000090: 3133 3337 3b43 7572 7265 6e74 4469 723d  1337;CurrentDir=
000000a0: 2f77 6f72 6b73 7061 6365 0765 7869 740a  /workspace.exit.
```

即 `ESC ] 1337 ; CurrentDir = /workspace BEL`（`1b 5d 31 33 33 37 3b … 07`，**BEL 终止**）——与 01 轮真沙箱捕获的字节**完全同形**。

### 三、核心包侧：注入实现要点

**注入点**：`apps/core/src/sandbox_platform/lifecycle.py` 的 `SandboxService._run_sandbox_container()`——**一处覆盖创建与重启两条路径**（`_create_locked()` 与 `_start_locked()` 都调它）。

```python
        container_env = dict(env)
        if network:
            container_env[SANDBOX_NETWORK_ENV] = network
```

- **值 = 实际生效网络名**：`network` 实参就是传给 `daemon.run_container(network=...)` 的那个值——默认 `<沙箱名>-net`（`request.network_name or self._network_name(name)`），用户指定自定义网络时**取那个自定义值**，**绝不字符串拼 `<沙箱名>-net`**；
- **平台注入值优先**：用户声明了同名 `SANDBOX_NETWORK` 时被平台值覆盖（平台说的网络才是真在用的那个）；
- **不写入 metadata**：`metadata.env` 只装用户声明值（`env=dict(request.env)` 未动）⇒ **不进 API 响应的环境变量清单**（后端详情接口只回 `metadata.env` 的键名与 `***`，平台注入值根本不在其中）；
- **命名**：`SANDBOX_NETWORK` 是**容器内变量**，与终端会话注入的 `SANDBOX_TERMINAL_SESSION` 风格一致；**不是**宿主平台参数（平台参数前缀是 `SANDBOX_PLATFORM_*`）。常量 `SANDBOX_NETWORK_ENV` 定义在 `lifecycle.py`，并从 `sandbox_platform` 包导出；
- **不受 `ENV_KEY_PATTERN` 白名单约束**：那条白名单校验的是**用户声明的 env**（`validate_env_pairs`，`_precheck` 里跑），平台注入是平台自己写的，**不经过它**（`SANDBOX_NETWORK` 本身也完全符合该字符集，两个口径不冲突）。

**新增单测**：`apps/core/tests/test_network_env.py`（**10 项**，跟 `test_lifecycle.py` / `test_hardening.py` 的假实现风格：假守护进程 + 假用户空间，**不碰宿主**）：

| # | 用例 | 覆盖点 |
|---|------|--------|
| 1 | `test_run_sandbox_container_injects_default_network` | 注入点本体：默认网络；且与 `run_container(network=…)` 同源 |
| 2 | `test_run_sandbox_container_injects_custom_network` | 自定义网络：取自定义值，**不等于** `demo-net` |
| 3 | `test_platform_network_env_overrides_user_env` | 平台注入值**优先**于用户同名变量 |
| 4 | `test_user_env_is_kept_alongside_platform_env` | 注入是追加，用户其它 env 原样保留 |
| 5 | `test_create_path_injects_default_network` | **创建路径** + 默认网络 |
| 6 | `test_create_path_injects_custom_network` | **创建路径** + 自定义网络（并断言 `network_owned is False`） |
| 7 | `test_create_path_network_env_not_stored_in_metadata` | **创建路径**：不落 metadata（内存里的 + 落盘后的都断言） |
| 8 | `test_start_path_injects_network_env` | **重启路径** + 默认网络 |
| 9 | `test_start_path_injects_custom_network` | **重启路径** + 自定义网络 |
| 10 | `test_start_path_network_env_not_stored_in_metadata` | **重启路径**：不落 metadata |

> **反向验证**（确保用例不是「空跑」）：把注入那段临时改成 `if False:` 后，**8 项失败**（只有两条「不落 metadata」的用例仍然通过——它们本就该在无注入时也成立）；改回后 **10 项全通过**。

**门禁**：

| 项 | 结果 |
|----|------|
| 核心包 `uv run pytest`（全量） | **403 passed**（基线 393 → **+10**），耗时 9 分 02 秒，**0 failed / 0 skipped** |
| 核心包 `ruff check .` | **All checks passed!**（rc=0） |
| 服务端 `uv run pytest`（本轮**未改服务端**，跑一遍确认没被核心包改动带崩） | **332 passed**（0 failed） |
| 服务端 `ruff check .` | **All checks passed!**（rc=0） |
| 前端 | **未动**（`apps/web/**` 属并行 agent 的工作区，本轮零改动、零触碰） |

### 四、真沙箱复验证据（用 `0.3.1` 新镜像建打样沙箱）

**打样沙箱**：`image-verify`（默认网络，uid 1007，套接字 `/run/user/1007/docker.sock`）与 `image-verify-2`（**用户自定义网络**，uid 1008）。exec 模板（01 轮同款，坑照样适用）：

```bash
sudo -u sandbox-image-verify env XDG_RUNTIME_DIR=/run/user/1007 \
  DOCKER_HOST=unix:///run/user/1007/docker.sock \
  docker exec -i sandbox-image-verify bash -i 2>&1      # 无 tty ⇒ 提示符与 OSC 走 stderr，必须 2>&1
```

| 复验项 | 命令 | 实测输出 | 结论 |
|--------|------|----------|------|
| **OSC 1337 上报** | `printf 'pwd\ncd /tmp\npwd\nexit\n' \| … bash -i 2>&1` | `root@f0c2528268e4:/workspace# ^[]1337;CurrentDir=/workspace^Gpwd` → `/workspace`；`cd /tmp` 后下一条 ⇒ `CurrentDir=/tmp`，`pwd` 输出 `/tmp` | ✅ **路径与容器内 `pwd` 逐字一致**，且随 `cd` 实时更新 |
| **OSC 精确字节** | 同上管道接 `xxd` | `1b 5d 31 33 33 37 3b 43 75 72 72 65 6e 74 44 69 72 3d 2f 77 6f 72 6b 73 70 61 63 65 07` | ✅ 与 01 轮捕获**逐字节同形**（BEL 终止） |
| **locale** | `printf 'echo "$LANG\|$LC_ALL"\nexit\n' \| … bash -i 2>&1` | `C.UTF-8\|C.UTF-8` | ✅ **交互 shell 内**实测（非 `docker exec env` 的旁证） |
| **`SANDBOX_NETWORK`（默认网络）** | `… docker exec sandbox-image-verify env \| grep SANDBOX_NETWORK` | `SANDBOX_NETWORK=image-verify-net` | ✅ = `<沙箱名>-net` |
| **`SANDBOX_NETWORK`（自定义网络）** | 同上（`image-verify-2`） | `SANDBOX_NETWORK=custom-verify-net`（**不是** `image-verify-2-net`） | ✅ **取实际生效网络名**；`docker inspect` 复核容器确实接在 `custom-verify-net` 上 ⇒ 注入值 = 实际生效网络 |
| **`sh` 降级** | `printf 'pwd\nexit\n' \| … sh -i 2>&1` | `# /workspace`，**`1337` 命中数 = 0** | ✅ **无 OSC、输出无污染**（`sh: 0: can't access tty` 是无 tty 噪声，不是 bashrc 污染） |
| **重启路径** | `sandboxctl stop image-verify` → `sandboxctl start image-verify` → 复测 | 容器 env 仍为 `SANDBOX_NETWORK=image-verify-net`；`bash -i` 仍有 OSC；locale 仍 `C.UTF-8\|C.UTF-8` | ✅ **重启路径同样注入**（真机，非仅单测） |
| **不落 metadata** | `sandboxctl list --json` | `image-verify env= {}`、`image-verify-2 env= {}` | ✅ `metadata.env` 里**没有**平台注入值 ⇒ 详情接口的环境变量清单**不会**出现它（不经 API 响应掩码） |

### 五、外部依赖登记（**不代劳重建**）

- **事实**：基础镜像只存在**宿主 root 守护进程**里；沙箱守护进程经核心包 `images.ensure_image_from_source()` **注入**镜像（平台自建镜像不走代理下载）。⇒ **存量沙箱不会自动拿到新镜像**，要用上 `0.3.1`（含 bashrc 注入与 locale ENV）**必须重建**。
- **本轮不代劳**：宿主上现存的 `qilu` / `qqbot` 两个沙箱**一个都没动**（容器、镜像、元数据、守护进程全部原样）。
- **状态**：**待用户重建后复验**——重建后跑一次 `bash -i` 看 OSC、跑一次 `echo "$LANG|$LC_ALL"` 看 locale 即可。

### 六、ADR 0004 修订范围已扩大（**本轮只登记，不改 ADR**）

修订行由**任务 08** 统一落，修订行需**同时覆盖两条**（原文不改写，只追加）：

1. **PS1 注入**：交互式非登录 shell（`bash -i`）**会读** `/etc/bash.bashrc`（系统级、对所有用户生效）⇒ 允许在该文件里做**只读上报类**的 shell 集成注入（如 OSC 1337 pwd 上报）；**不得**借此注入环境变量与别名；
2. **Dockerfile 新增 ENV 指令**：镜像的 `ENV` 指令**不是**「shell 初始化脚本注入」，不落在 ADR 0004 §3 影响段那句「不能靠 shell 初始化脚本注入环境变量与别名」的射程内——但 ADR 0004「运行时极简」的口径**本身不变**（沙箱仍是「启动即一个 bash、依赖服务仍由 agent 自主决定」）。

### 七、落盘清单

| 文件 | 变更 |
|------|------|
| `base-image/Dockerfile` | `/etc/bash.bashrc` 注入段（`printf` 追加写法）；新增 `ENV LANG=C.UTF-8` / `ENV LC_ALL=C.UTF-8`；`ARG BASE_VERSION` → `0.3.1`；头注释构建示例 → `0.3.1` |
| `base-image/verify.sh` | 默认镜像 → `0.3.1`；新增第 10 组 6 条判定（总数 42 → **48**） |
| `base-image/verify-rootless.sh` | 默认镜像 → `0.3.1`（与 README 示例同步） |
| `base-image/README.md` | 新增「OSC 1337 pwd 上报注入」「UTF-8 locale」两节与镜像内容表条目；构建命令 / `BASE_VERSION` 默认 / 标签规则（0.3.1 修订原因）/ 叠加用户层示例 / 验证脚本条目（48 项）同步 |
| `base-image/RESULTS.md` | 新增「0.3.1（当前版本）」节：构建实测、体积与分层、注入段最终形态与 Dockerfile 转义处理、判定结果（48 项）、踩坑清单 |
| `apps/core/src/sandbox_platform/lifecycle.py` | 新增常量 `SANDBOX_NETWORK_ENV`；`_run_sandbox_container()` 里合并注入 `SANDBOX_NETWORK`（平台值优先、不落 metadata） |
| `apps/core/src/sandbox_platform/__init__.py` | 导出 `SANDBOX_NETWORK_ENV` |
| `apps/core/tests/test_network_env.py` | **新增**：10 项单测（假守护进程 + 假用户空间，不碰宿主） |
| `docs/tasks/file-pane-obsidian/02-image-ps1-injection.md` | 本文件：完成标准十项全部勾选 + 新增「进展（2026-11-13 收口）」节；frontmatter `status` → `done` |

**未动**：`apps/web/**`（并行前端 agent 的工作区）、`docs/` 下其它任何文件（含 PRD）、存量沙箱与宿主既有容器、ADR 0004。

### 八、清理清单

| 临时物 | 处置 |
|--------|------|
| 打样沙箱 `image-verify`（容器 `sandbox-image-verify`、网络 `image-verify-net`、系统用户 `sandbox-image-verify` 及家目录、子 UID-GID 段 `165536:65536`、用户级 systemd 单元、`/run/user/1007`、平台元数据） | **已删除并回收**（`sandboxctl delete image-verify --yes`，回收清单 6 项全绿） |
| 打样沙箱 `image-verify-2`（容器 `sandbox-image-verify-2`、网络 `custom-verify-net`、系统用户 `sandbox-image-verify-2` 及家目录、子 UID-GID 段 `296608:65536`、用户级 systemd 单元、`/run/user/1008`、平台元数据） | **已删除并回收**（自定义网络按既有口径平台不回收，但守护进程随之删除，网络随之消失） |
| 宿主残留复查 | `id sandbox-image-verify` → 无此用户；`/home/sandbox-image-verify*` → 不存在；`/etc/subuid`、`/etc/subgid` → 无相关条目；`/run/user/1007`、`/run/user/1008` → 不存在；`/var/lib/sandbox-platform/sandboxes/` → 只剩 `qilu`、`qqbot`；`docker ps` → 宿主既有容器一个没动 |
| 存量沙箱 `qilu` / `qqbot` | **全程未碰**（仍「运行中」，容器 ID `c9452f09150d` / `dee74b39bdfc` 与开工前一致） |
| 临时镜像 / tag | **未创建**（只多出 `sandbox-platform/base:0.3.1` 这一个正式产物） |
| 临时脚本与捕获产物 | 全在 `/tmp`（`/tmp/t.bashrc`、`/tmp/bashrc_030.txt`、`/tmp/bashrc_031.txt`、`/tmp/quote_test.sh`、`/tmp/lifecycle.py.bak`、`/tmp/core_pytest_full.log`），**不在仓库内**，收尾时**已全部删除** |

### 九、审查修复（2026-11-13）

> **审查结论落地**：修掉四类遗留问题——① **locale 平台强制**（审查确认的**真实缺陷**）；② Dockerfile **构建期自检**；③ `verify.sh` **判定加固**；④ 测试**假实现补强 + 断言补强**。
> **改动范围**：`base-image/Dockerfile`、`base-image/verify.sh`、`apps/core/src/sandbox_platform/lifecycle.py`、`apps/core/tests/test_network_env.py`、本文件（**未碰 `apps/web/**`**——并行 agent 的工作区；**未碰 `docs/` 下其它任何文件**；**未 git commit**）。
> **本轮明确跳过**（审查 Suggestion 级）：metadata 增 `platform_env` 留痕字段、`${PWD}` 换 `$(pwd)`、`LANG`/`LC_ALL` 去冗余、RUN 层合并、常量归位 `env_contract`、`if network:` 死分支清理——**保留现状**。

#### 9.1 locale 平台强制（真实缺陷修复）：镜像层 + 平台强制层双层口径

**缺陷**：上一轮只把 `ENV LANG=C.UTF-8` / `ENV LC_ALL=C.UTF-8` 放进镜像（**基础层**），但**用户经创建参数声明 `LANG` / `LC_ALL` 时会静默废掉这层修复**——docker 的 `-e` **覆盖镜像 ENV**，且 `LC_ALL` 的优先级**高于** `LANG`（只堵住一条也堵不住）。结果：容器内 locale 退回用户声明的值 ⇒ 中文输出可能间歇乱码（看板 TODO「终端中文乱码」排查方向②）。

**修法**：平台在 `lifecycle.py` 的 `_run_sandbox_container()` **env 合并处**（与 `SANDBOX_NETWORK` **同口径**）强制注入 `LANG=C.UTF-8` 与 `LC_ALL=C.UTF-8`，且**平台值优先**：

```python
        container_env = dict(env)
        if network:
            container_env[SANDBOX_NETWORK_ENV] = network
        # locale 强制层：平台值覆盖用户声明的同名变量（镜像 ENV 只是基础层）
        container_env[SANDBOX_LANG_ENV] = SANDBOX_LOCALE_VALUE
        container_env[SANDBOX_LC_ALL_ENV] = SANDBOX_LOCALE_VALUE
```

**双层口径**（本轮定稿）：

| 层 | 载体 | 覆盖面 |
|----|------|--------|
| **基础层** | 镜像 `ENV LANG=C.UTF-8` / `ENV LC_ALL=C.UTF-8` | 用户**不声明**任何 env 的常规情形 |
| **强制层** | 平台起容器时注入 `LANG` / `LC_ALL`（平台值优先） | 用户**声明了同名变量**的情形（声明被平台值覆盖） |

- **常量**（定义在 `apps/core/src/sandbox_platform/lifecycle.py`，与 `SANDBOX_NETWORK_ENV` **同风格**、同模块）：`SANDBOX_LANG_ENV = "LANG"`、`SANDBOX_LC_ALL_ENV = "LC_ALL"`、`SANDBOX_LOCALE_VALUE = "C.UTF-8"`；
- **一处覆盖两条路径**：`_create_locked()` 与 `_start_locked()` 都走 `_run_sandbox_container()` ⇒ **创建与重启都强制**；
- **与 `SANDBOX_NETWORK` 同口径的四条**：**平台值优先** / **不写入 metadata**（`metadata.env` 只装用户声明值） / **不经 API 响应掩码**（不进详情接口的环境变量清单） / **不就地改写调用方传入的 env dict**（合并在副本上做）。

#### 9.2 Dockerfile 构建期自检（坏镜像构建期即失败）

注入段的 `RUN` **末尾追加 `grep -Fx` 自检**：落盘的那一行必须**逐字节等于定稿原文**，不等则本次构建**直接失败**（`set -e`）——坏镜像出不了厂，不再靠事后 `verify.sh` 才发现。

```dockerfile
    grep -Fxq 'export PS1="$PS1"'\''\[\e]1337;CurrentDir=$(pwd)\a\]'\''' /etc/bash.bashrc
```

- **「该行是不是最后一个非空行」不在构建期判**（那会把镜像结构钉死在构建脚本里），由 `verify.sh` 判；
- **反向实测**：把自检模式串故意改坏（`1337` → `1338`）后构建 ⇒ **构建失败**（`exit code: 1`，镜像未产出），确认自检不是「空跑」。

#### 9.3 `verify.sh` 判定加固（三处）

| # | 原判据 | 现判据 | 加固点 |
|---|--------|--------|--------|
| **10.1** | `tail -n 1` 取末行与定稿原文比 | **两个各自独立的判定**：① `grep -Fxq` 判「**存在该行**」（定长串 + 整行匹配）；② `awk 'NF{last=$0} END{print last}'` 取**最后一个非空行**再逐字节比对 | 原判据把「存在」与「在末尾」**混成一条**（末行不是定稿行就整条红）；现判据分别判，且**不再依赖 tail 猜末行** |
| **10.2** | 用 `grep -cE` **数**「行首（允许空白）以 `PS1=` 开头」的行数，≥1 即通过 | 对 **Debian 原生 PS1 定义行**（`  PS1='${debian_chroot:+($debian_chroot)}\u@\h:\w\$ '`）做 `grep -Fx` | 原判据**证明不了「原 PS1 保留」**——注入行自身也是 `PS1=` 开头 ⇒ 计数法恒真；现判据证「**原 PS1 那行逐字节还在**」 |
| **10.4** | `grep -q '1337'`（**裸串**） | 匹配 **OSC 起始形态** `$'\033]1337;'`（`ESC ] 1337;`） | 裸串会**误判**：将来 `WORKDIR` 之类的路径含 `1337` 就会报红；现判据只认真正的 OSC 起始序列 |

- **模式串走容器内环境变量传递**（新增 `in_image_with_env` 辅助函数）：`$PS1` / `$(pwd)` / `${debian_chroot:…}` 之类内容**不被外层 shell 或容器内 shell 求值**（求值了就不是「逐字节等于原文」了）；
- **反向实测**（三个负例，全部判红/判绿符合预期，临时镜像已清理）：
  - **负例 A**（注入行后面追加一行）⇒ 10.1 **不通过**（定稿行存在=是；最后非空行=`# trailing line`）；
  - **负例 B**（删掉 Debian 原生 PS1 那一行）⇒ 10.2 **不通过**（10.1 仍通过——注入行确实还在末尾，两个判定各管各的）；
  - **负例 C**（`WORKDIR /work1337`）⇒ 10.4 **通过**（不误判）。

#### 9.4 测试补强（`apps/core/tests/test_network_env.py`）

- **假实现补齐**：`FakeDaemon` 补上缺失的三个方法（签名对齐真守护进程 `daemon.py`，参考 `test_hardening.py` 同名假实现）：`can_access_path(path) -> bool`、`containers_on_network(network) -> list[str] | None`、`container_running(name) -> bool`；
- **新增 5 条用例**（10 → **15**）：

| # | 用例 | 覆盖点 |
|---|------|--------|
| 11 | `test_platform_locale_env_overrides_user_declared_locale` | 用户声明的 `LANG`/`LC_ALL` **被平台值覆盖**；其它用户 env 保留 |
| 12 | `test_platform_locale_env_injected_without_user_env` | 用户没声明 locale 时平台照样注入两条 |
| 13 | `test_platform_env_does_not_mutate_caller_env` | **实现不得就地改写调用方传入的 env dict**（合并在副本上做） |
| 14 | `test_create_path_locale_env_not_stored_in_metadata` | 创建路径：locale 强制值**不落 metadata**（用户声明值原样落盘） |
| 15 | `test_start_path_forces_locale_env` | **重启路径**：locale 强制层照样生效 |

- **顺手加的两条低成本断言**：① 自定义网络用例（`test_create_path_injects_custom_network`）追加断言 `metadata.env` **同样不含平台值**（`SANDBOX_NETWORK` / `LANG` / `LC_ALL`）；② 上面第 13 条（调用方 env dict 不被就地改写）；
- **未搬 conftest**（改动面控制）：`test_network_env.py` 自带 `FakeDaemon` + `FakeUserSpace`，不依赖别的文件的夹具。

#### 9.5 门禁数字（本轮）

| 项 | 结果 |
|----|------|
| 核心包 `uv run pytest`（全量） | **408 passed**（上一轮 403 → **+5**），耗时 9 分 28 秒，**0 failed / 0 skipped** |
| 核心包 `ruff check .` | **All checks passed!**（rc=0） |
| 镜像构建 `docker build --build-arg DOCKER_CLI_VERSION=29.6.2 -t sandbox-platform/base:0.3.1 base-image` | **成功**（tag 不变、覆盖；注入层重跑 0.2 秒，其余层命中缓存）；镜像 id `sha256:ad3c58476c1820654512a8fcf52daeda24fdabb51b8943673d0e28971d41aac5`，体积 `98,497,042 B`（较上轮 **+99 B**——落盘内容未变，增量来自构建历史里多出的那条自检命令） |
| 镜像构建（坏镜像负例） | **构建失败**（rc=1，镜像未产出）——自检确实拦得住 |
| `base-image/verify.sh` | **共 48 项，不通过 0 项**（10.1 / 10.2 / 10.4 三条判定加固后**项数不变**） |
| 前端 / 服务端 | **未动**（`apps/web/**` 属并行 agent 的工作区，本轮零改动、零触碰；服务端本轮未改，亦未跑） |

> **项数说明**：10.1 由「一条判定」改为「**两个各自独立的判定**」，但仍**计作一项**（10.1 本身）⇒ `verify.sh` 总项数**保持 48**，与上一轮口径一致。

#### 9.6 本轮落盘清单

| 文件 | 变更 |
|------|------|
| `base-image/Dockerfile` | 注入段 `RUN` 末尾追加 **构建期自检** `grep -Fxq <定稿原文> /etc/bash.bashrc`（坏镜像构建期即失败）；补注释说明「最后非空行由 verify.sh 判」 |
| `base-image/verify.sh` | 新增 `in_image_with_env` 辅助函数（模式串经容器内 env 传递，不被任一层 shell 求值）；**10.1** 改为「`grep -Fxq` 判存在」+「awk 取最后一个非空行」两个独立判定；**10.2** 改为对 Debian 原生 PS1 定义行做 `grep -Fx`；**10.4** 改为匹配 OSC 起始形态 `$'\033]1337;'`；**项数保持 48** |
| `apps/core/src/sandbox_platform/lifecycle.py` | 新增常量 `SANDBOX_LANG_ENV` / `SANDBOX_LC_ALL_ENV` / `SANDBOX_LOCALE_VALUE`；`_run_sandbox_container()` env 合并处**强制注入 locale 且平台值优先**；方法 docstring 补「locale 强制层 + 四条口径（含不就地改写调用方 env）」 |
| `apps/core/tests/test_network_env.py` | `FakeDaemon` 补 `can_access_path` / `containers_on_network` / `container_running`；新增 5 条用例（10 → 15）；自定义网络用例补「metadata.env 不含平台值」断言；新增「不就地改写调用方 env dict」断言 |
| `docs/tasks/file-pane-obsidian/02-image-ps1-injection.md` | 本文件：进展节新增「九、审查修复（2026-11-13）」小节（9.1 locale 双层强制口径 / 9.2 构建期自检 / 9.3 判定加固 / 9.4 测试补强 / 9.5 门禁数字 / 9.6 落盘清单） |

**未动**：`apps/web/**`（并行 agent 的工作区）、`docs/` 下其它任何文件（含 PRD）、`base-image/README.md` / `RESULTS.md` / `verify-rootless.sh`（本轮口径未变，无需同步）、存量沙箱与宿主既有容器、ADR 0004。**未 git commit**（工作区留待主 agent 统一处置）。

