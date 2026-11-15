# 平台基础镜像 `sandbox-platform/base`

所有沙箱镜像的唯一底座。只含五样东西：**bash、docker 客户端、通用工具层（9 个包）、纯 bash 入口脚本、`cached-images` 缓存清单命令**，外加一个容器层临时目录 `/workspace`。

不含任何业务运行时（无 node / pnpm / python3 / psql / mc），也不内置任何 volume 挂载点。

> **目录位置**：本目录 2026-11-01 由 `platform/base-image/` 上移到仓库根 `base-image/`；镜像名 `sandbox-platform/base:<版本>` 与构建口径均未变。

> **0.4.0 起新增 `cached-images` 命令**：查询统一镜像代理「已完整缓存」清单的纯 bash 命令（`/usr/local/bin/cached-images`），见[下文专章](#cached-images-缓存清单命令040-新增)。
> **0.3.1 起新增两样东西。** ① `/etc/bash.bashrc` **末尾追加** OSC 1337 pwd 上报注入段（交互式非登录 shell `bash -i` 生效，`sh` / `dash` 自然降级）；② Dockerfile 新增两条 `ENV`：`LANG=C.UTF-8` 与 `LC_ALL=C.UTF-8`（容器内 locale 原本处于未定义态）。
> **0.3.0 起新增通用工具层。** 9 个通用工具包（git / openssh-client / vim / curl / ca-certificates / unzip / xz-utils / procps / less）随镜像预装，构建期联网 apt 拉取。
> **0.2.0 起不再内置依赖镜像离线包。** 依赖镜像（Postgres / MinIO / Logto 等）与一切外部镜像
> 统一经宿主的统一镜像代理（`rpardini/docker-registry-proxy`）缓存拉取，见 ADR 0008。
> 旧的 `sandbox-platform/base:0.2.0` 与 `sandbox-platform/base:0.1.0`（含离线包层）仍保留在宿主上，供存量镜像引用。

## 镜像内容

| 路径 | 内容 | 说明 |
|------|------|------|
| `/usr/local/bin/docker` | docker 客户端 | 静态编译的 Go 二进制，版本必须与宿主守护进程一致 |
| `/usr/bin/git`、`/usr/bin/ssh`、`/usr/bin/vim`、`/usr/bin/curl`、`/usr/bin/unzip`、`/usr/bin/xz`、`/usr/bin/ps`、`/usr/bin/less` | 通用工具层 | apt 装的 9 个通用工具包；`ca-certificates` 不提供命令，只提供 `/etc/ssl/certs/ca-certificates.crt` |
| `/entrypoint.sh` | 入口脚本 | 纯 bash，只依赖 bash 与 docker |
| `/usr/local/bin/cached-images` | 缓存清单命令（0.4.0 新增） | 纯 bash + curl，零 jq、零 JSON 解析；三态退出码 0 / 2 / 3 |
| `/etc/bash.bashrc` | 平台注入的 OSC 1337 pwd 上报段 | **追加**在文件末尾（原内容保留）；`bash -i` 起会话时把当前目录以 `ESC ] 1337 ; CurrentDir=<path> BEL` 上报 |
| `/workspace` | 便捷空目录 | 容器层目录（非 volume），随容器删除而消失 |

镜像内**没有** `/opt/deps/` 目录、**没有** `load-deps.sh` / `fetch-deps.sh`、**没有任何 `.tar` 归档**。

## cached-images 缓存清单命令（0.4.0 新增）

`/usr/local/bin/cached-images`（在 PATH 内）：查询统一镜像代理「已完整缓存」的镜像清单，让 agent 在拉依赖镜像前先查清单、**可接受的版本集合中优先选已缓存版本**（未命中再回退正常拉取），提高缓存命中率。

### 用法

```bash
cached-images          # 查询清单（无参数即查询）
cached-images --help   # 帮助（含三态退出码表）
```

命令把服务端预渲染文本（`?format=text`）**原样输出**：零解析、**不依赖 jq、不碰 JSON**（基础镜像只有 curl）。正常态输出 = 清单正文（仓库 / 标签 / 摘要 / 链大小 / 缓存时间；缓存为空时是空态文案，不是错误）+ 尾部一行引导语。

### 三态与退出码

| 态 | 触发条件 | 行为 | 退出码 |
|----|----------|------|--------|
| ① 正常 | 两个 env 在场且端点可达 | 清单文本原样输出 + 尾部引导语 | `0` |
| ② 缺凭据 / 缺 URL | `SANDBOX_IMAGE_CACHE_URL` / `SANDBOX_IMAGE_CACHE_TOKEN` 任一未设置**或为空串** | 一行中文提示（stderr），引导回退正常拉取 | `2` |
| ③ 不可达 / 超时 / HTTP 错误 | 端点连不上、超时或拒绝请求（含令牌失效 401 的降级态） | 一行中文提示（stderr），引导回退正常拉取 | `3` |

两个失败态退出码**不同**且写进 `--help`。**任何失败态都不阻塞**：提示语引导 agent 回退正常拉取，后续 `docker pull` 照常进行。

### 实现口径（硬约束）

- **纯 bash + coreutils + curl**：脚本零 jq、零脚本解释器调用、零 JSON 解析构造（`verify.sh` 有静态判定）；
- **显式 `--noproxy '*'`**：沙箱 env 里有 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（统一镜像代理的拉取变量），**平台后端调用不走镜像代理**，必须显式绕开——不写这个参数，命令在沙箱内会撞死代理上超时；
- **超时封顶**：`--connect-timeout 5 --max-time 10`，任何网络形态下不挂 shell（实测：拒连即刻返回、监听不回包 10 秒封顶）；
- **凭据形态**：`Authorization: Bearer <受限令牌>`——受限令牌（`sbxr_` 前缀）仅对这一条只读读径有效，由服务端生成与轮换、平台全权管理。

### env 注入与已知边角

两个 env（`SANDBOX_IMAGE_CACHE_URL` = 后端可达地址、`SANDBOX_IMAGE_CACHE_TOKEN` = 受限令牌）由服务端在**创建 / 启动沙箱**时平台强制注入（CLI 创建路径不传参 → 沙箱缺这对 env，属已知边角：console 里对该沙箱执行一次「停止 → 启动」即自愈）。**令牌轮换**（服务端重写凭据文件）后，已注入沙箱内的旧令牌立即 401 → 命令走 ③ 降级态；console 对沙箱重启一次即重新注入新值。

### 存量沙箱口径（PRD 26）

**升级前创建的沙箱不带本命令**（基础镜像随沙箱创建时固化），**重建至 `base:0.4.0` 后在场**。现有沙箱的重建**由用户执行**（平台不代劳），已登记为镜像缓存清单轮的验收前置（06 轮端到端 PRD 21 / 26 / 30 硬前置）：存量沙箱内执行 `cached-images` 得到「命令不存在」，属预期行为，不是缺陷。

## OSC 1337 pwd 上报注入（0.3.1 新增）

`/etc/bash.bashrc` **末尾追加**一段（**追加**，原内容一字不改）：

```bash
export PS1="$PS1"'\[\e]1337;CurrentDir=$(pwd)\a\]'
```

- **单引号是关键**：`$(pwd)` 留在提示符里，bash **每次画提示符时**才求值 ⇒ 路径随 `cd` 实时更新（写成双引号会在 `export` 那一刻被冻死）；
- `\[` … `\]` 是 bash 的「不可见区」标记，整段 OSC 不占位、不影响光标定位；
- **追加在末尾是必须的**：Debian 的 `/etc/bash.bashrc` 顶部有非交互守卫（`[ -z "$PS1" ] && return`），非交互 shell 读到那里就返回 ⇒ 注入**只对会画提示符的交互式非登录 shell 生效**；
- **生效范围**：交互式非登录 shell（`bash -i`）与登录式交互 shell（`bash -l -i`）；`bash`（非交互）、`bash -c` 不读任何 rc 文件 ⇒ 无 OSC；
- **自然降级**：`/bin/sh` 是 `dash`，只读 `$ENV`（平台未设置），**不读** `/etc/bash.bashrc` ⇒ `sh -i` / `dash -i` 不产生任何 OSC，终端输出不被污染；
- 写法由 01 轮真沙箱实测定稿（实测记录见 [[tasks/file-pane-obsidian/01-prototype-osc-loop.md|任务 01 打样轮]]），**逐字照抄，未自行发挥**。

## UTF-8 locale（0.3.1 新增）

Dockerfile 新增两条 `ENV`：

```dockerfile
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
```

容器内 locale 原本**处于未定义态**（0.3.1 之前一条 `ENV` 都没有）。这是纯新增，不改变镜像内任何业务运行时（镜像里本来就没有业务运行时）。

## 通用工具层

9 个通用工具包在同一个 `RUN` 层里装完并清掉 apt 索引（`--no-install-recommends`，不留包索引）。包名与命令名不是一一对应：

| 包 | 命令 | 用途 |
|----|------|------|
| `ca-certificates` | 无命令（提供 `/etc/ssl/certs/ca-certificates.crt`） | HTTPS 根证书束，供 curl / git / ssh 校验服务端证书 |
| `curl` | `curl` | 命令行 HTTP(S) 客户端 |
| `git` | `git` | 版本控制 |
| `less` | `less` | 分页查看长文本 |
| `openssh-client` | `ssh` | SSH 客户端 |
| `procps` | `ps` | 进程查看 |
| `unzip` | `unzip` | 解压 zip 包 |
| `vim` | `vim` | 终端编辑器 |
| `xz-utils` | `xz` | xz 压缩 / 解压 |

业务运行时（node / pnpm / python3 / psql / mc 等）仍然**不在**镜像里——工具层只装通用命令行工具。

## 构建

```bash
# 在仓库根目录执行；构建期需要外网（apt 拉取通用工具包）
docker build \
  --build-arg DOCKER_CLI_VERSION=29.6.2 \
  -t sandbox-platform/base:0.4.0 \
  base-image
```

构建分两个阶段：

1. `FROM docker:29.6.2-cli` —— 抠出 `/usr/local/bin/docker`（静态二进制，可直接放进任意发行版底座）；
2. `FROM debian:bookworm-slim` —— 最终底座（体积优先；bookworm-slim 自带 bash，无需额外安装）。

**构建期需要外网**：apt 要拉 9 个通用工具包，构建命令不再带 `--network=none`（该参数是 0.2.0 时代的口径，已作废）。
离线环境请继续使用 `sandbox-platform/base:0.2.0`（它是最后一个零网络构建的版本）。

### 构建参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `DOCKER_CLI_VERSION` | `29.6.2` | docker 客户端版本，**必须与宿主守护进程版本一致**（client/server 版本一致性是验收判据） |
| `BASE_IMAGE` | `debian:bookworm-slim` | 底座发行版 |
| `BASE_VERSION` | `0.4.0` | 只写入 OCI label |

宿主守护进程升级后，必须用新版本号重建基础镜像，否则容器内 `docker version` 的客户端与服务端版本会不一致。

## 镜像标签规则

- 命名：`sandbox-platform/base:<平台语义化版本>`，例如 `sandbox-platform/base:0.4.0`。
- 版本号语义：`<主>.<次>.<修订>`，主次跟随平台自身版本，修订号在**依赖离线包更新**或**入口脚本行为变更**时递增。
- 0.2.0 的修订原因：废弃离线包机制（ADR 0008），镜像内不再携带依赖镜像 tar。
- 0.3.0 的修订原因：新增通用工具层（9 个包），构建口径从零网络改为联网 apt 拉包。
- 0.3.1 的修订原因：新增 OSC 1337 pwd 上报注入段（`/etc/bash.bashrc`）与两条 UTF-8 locale `ENV`。
- 0.4.0 的修订原因（minor bump）：新增 `cached-images` 缓存清单命令（`/usr/local/bin/cached-images`，镜像缓存清单轮任务 04）。
- docker 客户端版本**不写进 tag**，它是构建参数；版本不匹配时重建同名 tag 即可。

## 挂载点约定

| 路径 | 约定 | 说明 |
|------|------|------|
| `/var/run/docker.sock` | **固定挂载点** | 宿主守护进程套接字挂到这里；docker 客户端默认就找这个路径，用户无需设置 `DOCKER_HOST` |
| `/workspace` | 容器层临时目录 | **不是** volume，不落宿主机；容器删除即消失。需要持久化就自己把宿主目录挂进来 |

镜像里除 `/var/run/docker.sock` 外**不预置任何宿主机挂载目标**：没有会话目录、没有代码目录。Dockerfile 无 `VOLUME` 指令，`docker image inspect` 的 `Volumes` 字段为空。其它挂载全部由用户在启动沙箱时显式声明。

运行示例（免 root 守护进程）：

```bash
# 套接字属主是守护进程用户、权限 0660，容器内需以 root 运行才能访问
docker run -it --rm \
  -v /run/user/<uid>/docker.sock:/var/run/docker.sock \
  sandbox-platform/base:0.4.0
```

## 入口行为

`/entrypoint.sh` 的行为是固定的：

1. `docker` 命令不存在 → 打印一行含 `docker client missing` 的错误，**退出码 127**；
2. `docker` 命令存在 → `exec bash -i` 进入交互式 shell。

入口里**没有任何镜像加载逻辑**：依赖镜像由沙箱守护进程自己经统一镜像代理拉取
（代理环境变量由平台在守护进程单元里注入），沙箱内 `docker pull` 无需额外操作。

## 依赖镜像怎么来

不再随镜像分发，统一走代理：

- 平台在创建沙箱时确保统一镜像代理容器在跑并健康检查通过；
- 沙箱守护进程的 systemd 单元注入 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` / `SSL_CERT_FILE`；
- 沙箱内 `docker pull <镜像>` 自动经代理，命中代理缓存，不再反复从公网拉。

代理不可达时拉取直接失败（不降级直连），错误信息里会明确指出代理地址。

## 在默认镜像上叠加用户层

基础镜像就是普通底座，用户镜像直接 `FROM` 它：

```dockerfile
FROM sandbox-platform/base:0.4.0

# 用户自己的层：代码、配置、其它工具
COPY ./app /opt/app
WORKDIR /opt/app
```

构建用户镜像时**不需要**重新拉取基础镜像（它已经在本地），但用户层自己的 `RUN` 若要下载内容，需要放开网络：

```bash
docker build -t my-sandbox:0.1.0 -f ./Dockerfile .
```

注意：

- 用户镜像里不要再写 `VOLUME` 或预置挂载目标，保持「挂载由启动时声明」的统一约定；
- 若用户镜像里装了业务运行时（node / python / psql 等），那是用户层的责任，基础镜像本身不含这些；
- 基础镜像的入口脚本会被继承。若用户镜像要换入口，直接覆盖 `ENTRYPOINT`，但要保留「docker 客户端缺失时以 127 退出」的约定。

## 验证脚本

| 脚本 | 作用 | 依赖 |
|------|------|------|
| `verify.sh` | 镜像级判定：业务运行时缺席、**通用工具层在场**、无 volume 挂载点、`/workspace` 语义、入口脚本静态检查与入口行为、镜像内无离线包痕迹、**OSC 1337 注入段逐字节比对 + `bash -i` 功能判定 + `sh -i` 降级判定**、两条 locale ENV、**`cached-images` 命令硬约束（PATH / 纯 bash 零 jq / `--noproxy` / 5s+10s 封顶 / 缺凭据态退出码 / 帮助文本退出码表 / 拒连态，共 13 项）**（共 61 项） | 宿主 docker 守护进程 |
| `verify-rootless.sh` | 免 root 守护进程联调：入口脚本行为、客户端与服务端版本一致性、镜像内无离线包目录 | 复用同目录 `rootless/` 的 00/01/04 脚本 |

```bash
cd base-image
./verify.sh                                   # 镜像级判定（默认 sandbox-platform/base:0.4.0）
BASE_IMAGE=sandbox-platform/base:0.4.0 ./verify-rootless.sh   # 免 root 联调（测完自动回收）
```

正常态 / 不可达态的「活后端」形态属真机验证（需服务端端点与受限令牌在场），不塞 `verify.sh`；`verify.sh` 里的不可达判定用零依赖的「拒连」形态（URL 指向本机必死端口）。实测数据见 [RESULTS.md](RESULTS.md)。

## 目录内容

| 文件 | 作用 |
|------|------|
| `Dockerfile` | 多阶段构建定义 |
| `entrypoint.sh` | 容器入口（纯 bash） |
| `cached-images` | 缓存清单命令源文件（0.4.0 新增，COPY 进镜像 `/usr/local/bin/`） |
| `verify.sh` | 镜像级判定脚本 |
| `verify-rootless.sh` | 免 root 守护进程联调脚本 |
| `rootless/` | 免 root 守护进程引导脚本（`common.sh` / `00-create-user.sh` / `01-start-dockerd.sh` / `04-cleanup.sh`）；原在重组前的 `platform/probe/rootless/`（该路径已随目录重组消失），2026-11-01 随探针目录退役一并迁入本目录 |
| `RESULTS.md` | 实测记录（体积、耗时、代理拉取对比、踩坑） |
