# 平台基础镜像 · 实测记录

## 0.3.1（当前版本）—— OSC 1337 pwd 上报注入 + UTF-8 locale

- 执行日期：2026-11-13
- 宿主：Ubuntu 26.04 LTS / 内核 7.0.0-38-generic / cgroup v2
- Docker：客户端 + 服务端 **29.6.2**（宿主 root 守护进程），存储驱动 `overlayfs`（containerd 快照器）
- 镜像：`sandbox-platform/base:0.3.1`，image id `sha256:51c34d2c512cb0ce7dcd0e23bf8cceaf12888ae5723a26fc7972b08eb66aba53`
- 上游依赖：[[tasks/file-pane-obsidian/01-prototype-osc-loop.md|任务 01 打样轮]]（注入写法的真沙箱实测定稿，本轮逐字照抄）

> **0.3.1 的变更原因**：两件事一起 bump——
> ① `/etc/bash.bashrc` **末尾追加** OSC 1337 pwd 上报注入段（交互式非登录 shell 生效）；
> ② Dockerfile 新增两条 `ENV`：`LANG=C.UTF-8` 与 `LC_ALL=C.UTF-8`（容器内 locale 原本处于未定义态）。

### 一、构建

| 项 | 实测 |
|----|------|
| 构建命令 | `docker build --build-arg DOCKER_CLI_VERSION=29.6.2 -t sandbox-platform/base:0.3.1 base-image` |
| 构建耗时（墙钟） | **1.7 秒**（增量：底座层与 docker 客户端层与 0.3.0 共用缓存，只有新增的注入层与 ENV/LABEL 重新落层） |
| 其中注入层 | 0.2 秒（`RUN printf … >> /etc/bash.bashrc`） |
| 构建结果 | 成功（BuildKit，联网构建） |

### 二、体积

| 口径 | 0.3.0 | 0.3.1（当前） | 变化 |
|------|------|------|------|
| `docker image inspect .Size`（验收口径） | 98,494,563 B = 98.5 MB | **98,496,943 B = 98.5 MB** | **+2,380 B** |
| `docker history` 分层（自顶向下） | — | 见下表 | 新增 1 个 12.3 kB 层（注入段） |

`docker history`（0.3.1，自顶向下）：

| 层 | 0.3.1 |
|----|-------|
| `ENTRYPOINT ["/entrypoint.sh"]` | 0 B |
| `WORKDIR /workspace` | 4.1 kB |
| **`RUN` bashrc 注入段（OSC 1337）** | **12.3 kB** |
| `RUN` 入口脚本可执行位 + `/workspace` 目录权限 | 12.3 kB |
| `COPY entrypoint.sh` | 8.19 kB |
| `COPY` docker 客户端二进制 | 42.5 MB |
| `ENV LC_ALL=C.UTF-8` / `ENV LANG=C.UTF-8` | 0 B / 0 B（ENV 不占层体积） |
| `LABEL` / `ARG` | 0 B |
| `RUN` apt 通用工具层（9 包） | 157 MB |
| debian:bookworm-slim 底座 | 85.3 MB |

### 三、注入段的最终形态

`/etc/bash.bashrc` **末尾追加**（原 58 行一字不改，追加后 62 行）：

```bash
# ---- 平台注入：OSC 1337 pwd 上报（交互式非登录 shell 生效）----
# 单引号是关键：$(pwd) 留到画提示符时才求值；写成双引号会把路径冻死。
export PS1="$PS1"'\[\e]1337;CurrentDir=$(pwd)\a\]'
```

**Dockerfile 层面的转义处理**（关键点：容器内落盘的就是上面那行**原文**）：

- 用 `printf '%s\n' <参数…> >> /etc/bash.bashrc` 逐行追加，**不用 `echo`**（dash 的 `echo` 会解释 `\e` 等反斜杠转义，会把行内容改坏）；`printf` 的 `%s` **不解释参数里的反斜杠序列** ⇒ `\e` / `\a` / `\[` / `\]` 原样落盘；
- 行内需要出现**单引号**（`$(pwd)` 必须留在单引号里才能延迟求值），Dockerfile 的 `RUN` 又必须经 `/bin/sh -c` ⇒ 用 shell 的 **`'\''` 拼接技巧**写出：`'export PS1="$PS1"'\''\[\e]1337;CurrentDir=$(pwd)\a\]'\'''`；
- 整行在 `RUN` 里**全程处于单引号内** ⇒ `$(pwd)` 与 `"$PS1"` 在构建期**不被求值**，落盘的就是定稿原文；
- **追加在末尾**是必须的：Debian 的 `/etc/bash.bashrc` 顶部有非交互守卫（`[ -z "$PS1" ] && return`），非交互 shell 读到那里就返回 ⇒ 注入**只对会画提示符的交互式非登录 shell 生效**（这正是想要的效果）。

### 四、判定结果

#### `verify.sh`（镜像级，宿主 root 守护进程）：**48 项全通过**（42 项原有 + 6 项新增）

| 判定组 | 项数 | 结果 |
|--------|------|------|
| 0～9. 原有判定组（镜像存在 / 基础命令 / 业务运行时缺席 / 无 volume 挂载点 / `/workspace` 语义 / 入口脚本静态检查 / 无离线包痕迹 / 入口行为 / 通用工具层） | **42** | 通过（逐项与 0.3.0 一致） |
| 10.1 `OSC 1337 注入段在 /etc/bash.bashrc 末尾`（末行逐字节比对定稿原文） | 1 | 通过 |
| 10.2 `OSC 1337 注入为追加（原有 PS1 保留）` | 1 | 通过 |
| 10.3 `bash -i 实测上报 OSC 1337 CurrentDir`（功能判定） | 1 | 通过（载荷 `CurrentDir=/workspace`） |
| 10.4 `sh -i 自然降级：不产生 OSC 序列` | 1 | 通过（0 条 OSC，输出无污染） |
| 10.5 `ENV LANG=C.UTF-8` | 1 | 通过 |
| 10.6 `ENV LC_ALL=C.UTF-8` | 1 | 通过 |
| **合计** | **48** | **不通过 0 项** |

> 判定总数口径：0.3.0 的 **42 项** + 本轮新增 **6 项** = **48 项**（与 0.3.0 当年「35 项 − 2 条被删的否定断言 + 9 条新增 = 42 项」同一套路：镜像内容变了，判定脚本跟着长）。

#### 镜像内实测证据

`bash -i` 的 OSC 序列（`xxd` 实测，`BEL` 终止）：

```
00000080: 3a2f 776f 726b 7370 6163 6523 201b 5d31  :/workspace# .]1
00000090: 3333 373b 4375 7272 656e 7444 6972 3d2f  337;CurrentDir=/
000000a0: 776f 726b 7370 6163 6507 6578 6974 0a65  workspace.exit.e
```

即 `ESC ] 1337 ; CurrentDir = /workspace BEL`（`1b 5d 31 33 33 37 3b … 07`）——与 01 轮真沙箱捕获的字节**完全同形**。

`bash -i` 内 `cd /tmp` 后，下一条 OSC 即变为 `CurrentDir=/tmp`（路径随 `cd` 实时更新 ⇒ `$(pwd)` 确实延迟求值）。

`sh -i`（`/bin/sh` → dash）：**0 条 OSC**，输出干净（`sh: 0: can't access tty; job control turned off` 是无 tty 的正常噪声，不是 bashrc 污染）。

locale：`bash -c 'echo "$LANG|$LC_ALL"'` ⇒ `C.UTF-8|C.UTF-8`。

### 五、踩坑清单

1. **镜像里的 `echo` 不能用来写带反斜杠的行**：dash 的 `echo` 会解释 `\e` / `\a` 等转义序列 ⇒ 写 OSC 注入行会把内容改坏。必须用 `printf '%s\n'`（`%s` 不解释参数里的反斜杠）。
2. **行内单引号在 Dockerfile 的 `RUN` 里要转**：`RUN` 经 `/bin/sh -c`，行内既要保留单引号又要不被展开，用 `'\''` 拼接技巧最省事；**不要**为了省事改成双引号（`$(pwd)` 会被冻死，与 01 轮证伪的写法同型）。
3. **注入必须追加在 `/etc/bash.bashrc` 末尾**：文件顶部的非交互守卫决定了「追加在中间」也会被后面的内容影响、「追加在末尾」才是确定生效的位置。
4. **`verify.sh` 里断言注入行时不能直接用 `grep "^PS1="`**：Debian 的 `PS1` 定义是**缩进两格**的（`  PS1='${debian_chroot:+($debian_chroot)}\u@\h:\w\$ '`），要用 `grep -cE` 匹配「行首可选空白 + `PS1=`」。
5. **镜像内跑 `bash -i` 会带两条噪声**：`bash: cannot set terminal process group` 与 `bash: no job control in this shell`（无 tty 时的正常提示，**不是** bashrc 污染）；判定里按 `1337;CurrentDir=` 子串匹配，不受噪声影响。

---

## 0.3.0 —— 通用工具层

- 执行日期：2026-10-31
- 宿主：Ubuntu 26.04 LTS / 内核 7.0.0-38-generic / cgroup v2
- Docker：客户端 + 服务端 **29.6.2**（宿主 root 守护进程），存储驱动 `overlayfs`（containerd 快照器）
- 免 root 守护进程：复用 `platform/probe/rootless/` 的 00/01/04 脚本（2026-11-01 随探针目录退役迁至 platform/base-image/rootless/，脚本内容零改动）
- 镜像：`sandbox-platform/base:0.3.0`，image id `sha256:d8167c121c69d85a525ce7b66a1665554c9a6c7385967efa1d7a9e6d6ba87102`
- 统一镜像代理：`rpardini/docker-registry-proxy:0.8.0`（沿用现有实例，本轮未改动代理）

> **0.3.0 的变更原因**：新增通用工具层——9 个通用工具包（git / openssh-client / vim / curl / ca-certificates / unzip / xz-utils / procps / less）随镜像预装。
> 代价是构建口径从「所有 RUN 不触网 + 构建显式带 `--network=none`」改为「构建期联网 apt 拉包」，镜像体积相应增长。

### 一、构建

| 项 | 实测 |
|----|------|
| 构建命令 | `docker build --build-arg DOCKER_CLI_VERSION=29.6.2 -t sandbox-platform/base:0.3.0 platform/base-image` |
| 构建耗时（墙钟） | **18 秒** |
| 其中 apt 拉包层 | 12.6 秒（`apt-get update` + `apt-get install --no-install-recommends` + 清索引，同一 `RUN` 层） |
| 其中导出镜像层 | 4.8 秒 |
| 构建结果 | 成功（BuildKit，联网构建） |

### 二、体积

| 口径 | 0.2.0 | 0.3.0（当前） | 变化 |
|------|------|------|------|
| `docker image inspect .Size`（验收口径） | 47,693,426 B = 47.7 MB | **98,494,563 B = 98.5 MB** | **+50,801,137 B（+106.5%）** |
| `docker history` 分层合计（未压缩口径） | 134,033,191 B = 134.0 MB | 298,659,623 B = 298.7 MB | +164,626,432 B（+122.9%） |

体积增长全部来自新增的 apt 通用工具层（未压缩 164.6 MB，压缩后净增 50.8 MB）；底座层与 docker 客户端层与 0.2.0 **共用同一层**（层摘要 `sha256:44a87794…` 与 `sha256:8e446bd1…`），未重复占用。

### 三、分层（`docker history`，自顶向下）

| 层 | 0.3.0 | 0.2.0 |
|----|-------|-------|
| `ENTRYPOINT ["/entrypoint.sh"]` | 0 B | 0 B |
| `WORKDIR /workspace` | 4,198 B（4.1 kB） | 4,198 B |
| `RUN` 入口脚本可执行位 + `/workspace` 目录权限 | 12,595 B（12.3 kB） | 12,595 B |
| `COPY entrypoint.sh` | 8,386 B（8.19 kB） | 8,386 B |
| `COPY` docker 客户端二进制（静态 Go） | 44,564,480 B（42.5 MB） | 44,564,480 B |
| `LABEL` / `ARG` | 0 B | 0 B |
| **`RUN` apt 通用工具层（9 包）** | **164,626,432 B（157 MB）** | 无此层 |
| debian:bookworm-slim 底座 | 89,443,532 B（85.3 MB） | 89,443,532 B |
| 分层合计（未压缩） | 298,659,623 B（298.7 MB） | 134,033,191 B（134.0 MB） |

> `docker history` 报的是各层**未压缩**大小，`docker image inspect .Size` 报的是**压缩后**总量，两者口径不同，不可直接相加对比。

### 四、判定结果

#### `verify.sh`（镜像级，宿主 root 守护进程）：42 项全通过

| 判定组 | 项数 | 结果 |
|--------|------|------|
| 0. 镜像存在 | 1 | 通过 |
| 1. 基础命令存在：bash、docker 客户端、`docker --version` 有版本输出 | 3 | 通过 |
| 2. 业务运行时缺席：node、npm、pnpm、python3、python、psql、pg_config、mc、minio、postgres、jq | 11 | 通过（11 项均未安装；git 与 curl 的否定断言已删除，改由第 9 段正向断言） |
| 3. 不内置 volume 挂载点：`inspect .Config.Volumes` 为 `null`、容器内只有 `/proc` `/sys` `/dev` `/etc` 标准挂载 | 2 | 通过 |
| 4. `/workspace` 便捷空目录：是目录、是空目录、可写、不是挂载点、权限位 1777 | 5 | 通过 |
| 5. 入口脚本静态检查：`/entrypoint.sh` 存在、只依赖 bash 与 docker | 2 | 通过 |
| 6. 镜像内无离线包痕迹：无 `/opt/deps`、无 `load-deps.sh` / `fetch-deps.sh` / `images.list`、全盘无 `.tar` 类文件、入口脚本无加载逻辑、镜像根目录清单 | 7 | 通过 |
| 7. 入口行为：docker 缺失 → 输出含 `docker client missing` 且退出码 127 | 1 | 通过 |
| 8. 入口行为：docker 存在 → 进入交互式 bash，退出码 0 | 1 | 通过 |
| 9. **通用工具层在场**：git / openssh-client / vim / curl / unzip / xz-utils / procps / less / ca-certificates | 9 | 通过（逐包断言 `dpkg-query` 查得到版本 + 命令在 PATH；ca-certificates 断言证书文件存在） |
| **合计** | **42** | **不通过 0 项** |

判定总数口径：35 项原有判定 − 2 条被删的否定断言（git / curl） + 9 条新增判定 = **42 项**，与上表逐段相加一致，实测 **不通过 0 项**。

#### `verify-rootless.sh`（真实免 root 守护进程）：5 项全通过（+ 6 项回收校验）

| 判定 | 结果 |
|------|------|
| 入口脚本进入交互式 bash（容器保持运行） | 通过 |
| 容器内 docker 客户端可访问守护进程 | 通过 |
| 镜像内无 `/opt/deps` 离线包目录 | 通过 |
| 容器内 client=29.6.2 == server=29.6.2 | 通过 |
| 客户端版本 == 宿主 root 守护进程版本 29.6.2 | 通过 |
| 回收：容器删除、用户与子 ID 段清除、用户级单元删除、运行时目录回收 | 通过（6 项） |

测完确认脚本自建资源已全部回收：探针用户 `sandboxprobe` 已删除、`/tmp/rootless-probe` 已清理、`/run/user/<uid>` 已回收、测试容器已删除。

### 五、踩坑清单

1. **免 root 探针的用户总线存在竞态**：`01-start-dockerd.sh` 开启 linger 后只等 `/run/user/<uid>` 目录出现，
   不等用户总线套接字就绪，紧接着的 `systemctl --user daemon-reload` 会报
   `Failed to connect to user scope bus via local transport: Connection refused`。
   首次跑失败后重跑即通过（此时 `user@<uid>.service` 与 `/run/user/<uid>/bus` 已就绪）。
   这是探针脚本的时序问题，与基础镜像内容无关。
2. **`--network=none` 口径作废**：apt 必须联网，构建命令不能带 `--network=none`。
   离线环境只能继续用 `sandbox-platform/base:0.2.0`。
3. **包名与命令名不是一一对应**：`openssh-client` 提供 `ssh`、`xz-utils` 提供 `xz`、`procps` 提供 `ps`，
   `ca-certificates` 不提供命令而提供 `/etc/ssl/certs/ca-certificates.crt`——判定脚本按「包→命令」映射表逐条断言。
4. **apt 层的位置有讲究**：通用工具层放在 `FROM ${BASE_IMAGE} AS base` 之后、`ARG DOCKER_CLI_VERSION` 重新声明之前，
   这样客户端版本变化只会让其后的层失效，升级 docker 客户端不必重跑 apt。

---

## 0.2.0 实测记录（历史留档）

- 执行日期：2026-10-29
- 宿主：Ubuntu 26.04 LTS / 内核 7.0.0-38-generic / cgroup v2
- Docker：客户端 + 服务端 **29.6.2**（宿主 root 守护进程），存储驱动 `overlayfs`（containerd 快照器）
- 免 root 守护进程：复用 `platform/probe/rootless/` 的 00/01/04 脚本（2026-11-01 随探针目录退役迁至 platform/base-image/rootless/，脚本内容零改动）
- 镜像：`sandbox-platform/base:0.2.0`，image id `sha256:c89ed16c11a7f8aef0514b900b1febaaeb8ce9825b3b2bb51d0ab1dfd9a50611`
- 统一镜像代理：`rpardini/docker-registry-proxy:0.8.0`
  （digest `sha256:fe958e7a4b7ef01a646d903347a0522b6a9065b44b451c5ef87eb4b6b0f3d770`）

> **0.2.0 的变更原因**：废弃离线包机制（ADR 0008）——依赖镜像与一切外部镜像统一经宿主统一镜像代理缓存拉取，
> 基础镜像不再随依赖镜像膨胀，也不再被依赖版本绑死发布节奏。

---

## 一、体积

### 基础镜像

| 口径 | 0.1.0（已废弃离线包） | 0.2.0（当前） | 变化 |
|------|------|------|------|
| `docker image inspect .Size`（验收口径） | 534,391,230 B = 534.4 MB | **47,693,426 B = 47.7 MB** | **−91.1%** |
| 其中依赖镜像离线包层 | 490 MB | 0 | 全部移除 |

0.2.0 分层构成（`docker history`，未压缩）：

| 层 | 体积 |
|----|------|
| debian:bookworm-slim 底座 | 4.6 MB（与 0.1.0 同底座，共用层） |
| docker 客户端二进制（静态 Go） | 42.5 MB |
| 入口脚本 + 目录权限 | 12.5 kB |

> 旧镜像 `sandbox-platform/base:0.1.0`（534.4 MB）仍保留在宿主上，存量沙箱镜像仍引用它；本轮不重建。

### 依赖镜像离线包

已全部移除：不再有 `deps/images/*.tar`（原 489.5 MB）、不再有 `load-deps.sh` / `fetch-deps.sh`、
镜像内不再有 `/opt/deps` 目录。

---

## 二、判定结果

### `verify.sh`（镜像级，宿主 root 守护进程）：35 项全通过

| 判定组 | 结果 |
|--------|------|
| 镜像存在；bash / docker 客户端存在；`docker --version` 有版本输出 | 通过 |
| 业务运行时缺席：node、npm、pnpm、python3、python、psql、pg_config、mc、minio、postgres、git、curl、jq | 通过（13 项均未安装） |
| 无 `VOLUME` 指令，`inspect .Config.Volumes` 为 `null`；容器内只有 `/proc` `/sys` `/dev` `/etc` 标准挂载 | 通过 |
| `/workspace` 是空目录、可写、非挂载点、权限 1777 | 通过 |
| `/entrypoint.sh` 存在，静态检查无业务运行时调用 | 通过 |
| **镜像内无离线包痕迹**：无 `/opt/deps`、无 `load-deps.sh` / `fetch-deps.sh` / `images.list`、全盘无 `.tar` 类文件、入口脚本无加载逻辑 | 通过（5 项） |
| docker 缺失 → 输出含 `docker client missing` 且退出码 127 | 通过 |
| docker 存在 → 进入交互式 bash，退出码 0 | 通过 |

### `verify-rootless.sh`（真实免 root 守护进程）：5 项全通过（+ 6 项回收校验）

| 判定 | 结果 |
|------|------|
| 入口脚本进入交互式 bash（容器保持运行） | 通过 |
| 容器内 docker 客户端可访问守护进程 | 通过 |
| 镜像内无 `/opt/deps` 离线包目录 | 通过 |
| 容器内 client=29.6.2 == server=29.6.2 | 通过 |
| 客户端版本 == 宿主 root 守护进程版本 29.6.2 | 通过 |
| 回收：容器删除、用户与子 ID 段清除、用户级单元删除、运行时目录回收 | 通过（6 项） |

---

## 三、统一镜像代理实测（核心验收）

### 代理版本与配置

| 项 | 取值 | 依据 |
|----|------|------|
| 代理镜像 | `rpardini/docker-registry-proxy:0.8.0` | 上游稳定版（多架构）；`:latest` 是 master 构建，不用于生产 |
| 镜像 digest | `sha256:fe958e7a4b7ef01a646d903347a0522b6a9065b44b451c5ef87eb4b6b0f3d770` | Docker Hub registry API 返回的 `docker-content-digest` |
| 监听 | 宿主 `127.0.0.1:3128` → 容器 3128 | 上游只暴露 3128；绑回环不对外 |
| 必填环境变量 | `REGISTRIES="docker.io ghcr.io quay.io gcr.io registry.k8s.io"` | 上游拦截清单；docker.io 由上游内置（`registry-1.docker.io` / `auth.docker.io`） |
| 其它环境变量 | `ENABLE_MANIFEST_CACHE=true` | 上游默认 false；开启后 manifest 也缓存，Docker Hub 限流友好 |
| 卷 | `/var/lib/sandbox-platform/registry-proxy/cache` → `/docker_mirror_cache`；`/var/lib/sandbox-platform/registry-proxy/ca` → `/ca` | 上游约定；两个卷都必须持久化 |
| CA 证书 | `/ca/ca.crt`（同时经 `http://127.0.0.1:3128/ca.crt` 提供） | 上游 entrypoint 生成 |
| CA 私钥 | `/ca/ca.key`，权限 **0600** | 平台在代理就绪后显式收紧 |
| 健康检查 | TCP 连 `127.0.0.1:3128` + HTTP 取 `/ca.crt` 拿到证书 | 两项都通过才算健康 |

沙箱侧注入（`systemd` 用户单元）：

```
Environment=HTTPS_PROXY=http://127.0.0.1:3128
Environment=HTTP_PROXY=http://127.0.0.1:3128
Environment=NO_PROXY=localhost,127.0.0.1,::1
Environment=SSL_CERT_FILE=/home/sandbox-<name>/.config/sandbox-platform/registry-proxy-ca-bundle.crt
```

`SSL_CERT_FILE` 指向**合并 CA 束**：宿主系统 CA 束（120 份根证书）+ 代理 CA（1 份），共 121 份，
属主沙箱用户、权限 0644。只放代理 CA 会让沙箱内非代理目标的 TLS 全部失败，故必须合并。

### a) 用 base:0.2.0 创建沙箱

```
$ sandboxctl create proxy-lab --image sandbox-platform/base:0.2.0 --command "sleep infinity"
INFO sandbox_platform.proxy：镜像代理已就绪：http://127.0.0.1:3128
INFO sandbox_platform.userspace：创建系统用户：sandbox-proxy-lab
INFO sandbox_platform.proxy：已安装合并 CA 束：/home/sandbox-proxy-lab/.config/sandbox-platform/registry-proxy-ca-bundle.crt（属主 sandbox-proxy-lab）
沙箱 proxy-lab 创建完成
```

平台自建镜像（`sandbox-platform/` 前缀）由宿主导出注入沙箱守护进程，不走代理下载。

### b) 沙箱内首次拉取（缓存未命中）

```
$ docker exec sandbox-proxy-lab docker pull busybox:1.37
Digest: sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
Status: Downloaded newer image for busybox:1.37
首次拉取耗时：15.25 秒
```

代理缓存目录随即出现该镜像的 blob（8 个文件，共 2.3 MB）：

```
2212597  /var/lib/sandbox-platform/registry-proxy/cache/f/2c/f680048c00822b67682fe0c4b94a22cf   ← busybox 根层
10573    .../3/ba/52e0d56d97fb8bf512c634641e08cba3
10506    .../2/4a/7059f52a8c5d2ee53bb6bd0d116ae4a2
3064     .../8/12/790da5fa08ef1780d822fa3d70a1c128
1650     .../c/5c/40f919db829f46b7107b667d7c9c65cc
```

代理访问日志里对应记录为 `MISS`。

### c) 删除沙箱 → 重建 → 再拉同一镜像（命中缓存）

```
$ sandboxctl delete proxy-lab --yes && sandboxctl create proxy-lab --image sandbox-platform/base:0.2.0 …
$ docker exec sandbox-proxy-lab docker pull busybox:1.37
Status: Downloaded newer image for busybox:1.37
第二次拉取耗时：3.44 秒
```

代理访问日志（manifest 与全部 blob 均为 `HIT`）：

```
"upstream_cache_status":"HIT","method":"HEAD","uri":"/v2/library/busybox/manifests/1.37"
"upstream_cache_status":"HIT","method":"GET","uri":"/v2/library/busybox/manifests/sha256:a7dbc319…"
"upstream_cache_status":"HIT","method":"GET","uri":"/v2/library/busybox/blobs/sha256:30ecbe15…"
"upstream_cache_status":"HIT","method":"GET","uri":"/v2/library/busybox/blobs/sha256:9177639f…"
"upstream_cache_status":"HIT","method":"GET","uri":"/v2/library/busybox/blobs/sha256:68fe9bff…"
```

**两次拉取耗时对比：15.25 秒（MISS，走外网） → 3.44 秒（HIT，走本地缓存），约 4.4 倍提速。**
第二次仍非零耗时，因为 Docker Hub 的 token 协商与 manifest 拉取要走一遍代理转发。

### d) 停掉代理后再拉（验证无降级语义）

```
$ docker stop sandbox-platform-registry-proxy
$ docker exec sandbox-proxy-lab docker pull busybox:1.36
Error response from daemon: failed to resolve reference "docker.io/library/busybox:1.36":
  failed to do request: Head "https://registry-1.docker.io/v2/library/busybox/manifests/1.36":
  proxyconnect tcp: dial tcp 127.0.0.1:3128: connect: connection refused
失败耗时：0.09 秒
```

错误信息直接点名代理地址与拒绝原因，**没有任何直连公网的降级行为**（守护进程虽然有宿主网络，
但 `HTTPS_PROXY` 强制它走代理）。测完代理已恢复。

### e) 代理不可达时创建沙箱（控制面侧）

让 3128 端口被占位使代理容器起不来时，创建直接失败并回滚：

```
$ sandboxctl create proxy-fail --image sandbox-platform/base:0.2.0 --command "sleep infinity"
ERROR sandbox_platform.proxy：启动代理容器失败：docker: Error response from daemon: failed to set up
  container networking: … failed to bind host port 127.0.0.1:3128/tcp: address already in use
错误：步骤「准备镜像代理」失败：镜像代理未就绪（http://127.0.0.1:3128）：…；平台不做降级直连，请先修复代理后重试
```

失败发生在任何宿主改动之前（沙箱用户尚未创建），无需回滚。

---

## 四、测试与冒烟

| 项 | 结果 |
|----|------|
| `pytest`（全量，含 root 标记测试） | **158 项全通过**（其中新增代理回归 14 项：单元模板四环境变量、代理不可达→创建失败且报错明确、`ensure_running` 幂等、CA 束生成与权限、合并 CA 束同时含系统与代理两份） |
| `ruff check src/ tests/ cli/` | 零告警 |
| `scripts/smoke-lifecycle.sh` | 两遍全绿，各 30 项判定（新增：单元注入四环境变量、合并 CA 束可读且含多份证书、沙箱内经代理拉取小镜像成功） |

---

## 五、完成标准逐条核对

| 完成标准 | 结论 | 依据 |
|----------|------|------|
| 基础镜像 0.2.0 可构建，无外网构建 | 通过 | `docker build --network=none` 成功；RUN 步骤仅本地文件操作 |
| 镜像内含 docker 客户端，版本与宿主一致 | 通过 | `Docker version 29.6.2`；容器内 client == server == 宿主 |
| 纯 bash 入口脚本，只依赖 bash 与 docker | 通过 | `verify.sh` 静态检查无命中 |
| 入口行为固定：docker 存在则 exec 交互式 bash，不存在则报错退出码 127 | 通过 | 两条判定均通过 |
| 镜像不内置任何 volume 挂载点 | 通过 | `inspect .Config.Volumes = null`；容器内只有标准挂载 |
| 便捷空目录 `/workspace` 可写、容器层目录 | 通过 | 空目录、1777、可创建删除文件、`/proc/mounts` 无命中 |
| **镜像内无离线包痕迹（deps 目录、加载脚本、tar 包）** | 通过 | `verify.sh` 5 项断言 + 全盘 `find` 无 `.tar` 类文件 |
| 入口脚本无离线包加载逻辑 | 通过 | 静态检查 `load-deps` / `docker load` / `/opt/deps` / `images.list` 均无命中 |
| 沙箱内 `docker pull` 经统一代理成功，代理缓存出现该镜像 blob | 通过 | 第三节 b 项：8 个缓存文件 / 2.3 MB |
| 删沙箱重建后再拉命中缓存并记录耗时 | 通过 | 15.25 秒 → 3.44 秒，日志 `HIT` |
| 代理不可达时拉取明确失败、无降级直连 | 通过 | 第三节 d 项：`proxyconnect tcp: … connection refused`，0.09 秒失败 |
| 代理不可达时创建沙箱明确失败 | 通过 | 第三节 e 项：步骤「准备镜像代理」失败并回滚 |
| CA 私钥权限 0600；合并 CA 束含系统与代理两份 | 通过 | `/ca/ca.key` 0600；合并束 121 份证书 |

---

## 六、踩坑清单

1. **免 root 守护进程不在 slirp 网络命名空间里**（本轮最关键的坑）：`dockerd-rootless.sh` 默认启用
   `--detach-netns`，守护进程进程本身留在**宿主网络命名空间**（只有容器在 slirp4netns 命名空间里）。
   因此守护进程访问代理要用宿主回环地址 `127.0.0.1:3128`；slirp 网关 `10.0.2.2` 只在**沙箱容器内**可达，
   给守护进程写 `10.0.2.2` 会把请求发到宿主局域网网关，表现为拉取报 `unexpected EOF`（连接被对端静默关闭），
   代理日志里看不到任何请求。平台因此把代理地址做成配置项（`SANDBOX_PLATFORM_PROXY_ADDRESS`），
   默认 `127.0.0.1`，并在单元里显式固定 `DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=true`。
2. **`unexpected EOF` 不等于「网络不通」**：dockerd 拉取失败报这个错时，先确认守护进程在哪个网络命名空间
   （`readlink /proc/<dockerd pid>/ns/net`），再确认代理地址是否可达；本例中代理日志完全无记录，
   才定位到地址用错了命名空间。
3. **代理的 CA 必须与系统 CA 合并**：只把代理 CA 放进 `SSL_CERT_FILE` 会让沙箱内所有非代理目标的
   TLS 握手失败（业务 API、数据库连接等）。平台把系统 CA 束（`/etc/ssl/certs/ca-certificates.crt`）
   与代理 CA 合并成一个文件装到沙箱用户家目录。
4. **代理容器里的 nginx 会 chown 缓存目录**：nginx 的 cache manager 会把缓存目录改成 worker 用户
   （容器内 uid 100），宿主上表现为目录属主变成 `usbmux`（uid 100）。不影响代理写入，
   但读取缓存内容需要 root；CA 目录不受影响，私钥仍是 0600 root。
5. **代理不可达时的错误信息要指名道姓**：守护进程报的是 `proxyconnect tcp: dial tcp 127.0.0.1:3128:
   connect: connection refused`，用户一眼能看出是代理问题；平台侧在创建流程里再补一条
   「镜像代理未就绪（地址）：…；平台不做降级直连」，两层信息都不遮蔽。
6. **代理容器名要带端口后缀**：测试用临时数据根 + 独立端口时，代理容器名若固定会与生产实例抢名字与端口。
   平台按端口派生容器名（默认 3128 用固定名，其它端口加后缀）。
7. **并发创建要加锁**：两个沙箱同时创建会同时去建代理容器，后一个撞名失败。代理拉起用文件锁串行化。
8. **宿主 DNS 只在宿主网络命名空间可用**：slirp 命名空间里 `/etc/resolv.conf` 指向 systemd-resolved 的
   `127.0.0.53`，在命名空间内不可达，沙箱容器内的 DNS 解析会失败。这正好说明代理是必需的：
   代理在宿主侧解析仓库域名，守护进程只需把域名交给代理。
9. **旧镜像保留**：0.1.0 基础镜像与 `sandbox-platform/sandbox-default:0.1.0` 均未重建、未删除，
   存量引用不受影响；默认沙箱镜像的重建是后续任务。
