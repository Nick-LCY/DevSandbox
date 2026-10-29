# 平台基础镜像 · 实测记录

- 执行日期：2026-10-29
- 宿主：Ubuntu 26.04 LTS / 内核 7.0.0-38-generic / cgroup v2
- Docker：客户端 + 服务端 **29.6.2**（宿主 root 守护进程），存储驱动 `overlayfs`（containerd 快照器）
- 免 root 守护进程：复用 `platform/probe/rootless/` 的 00/01/04 脚本（用户 `sandboxprobe`，systemd 用户级单元 + RootlessKit）
- 镜像：`sandbox-platform/base:0.1.0`，image id `sha256:208cd220d0134cbc9c0ee2a9dd7cf67c930885eab54db82dbd5d93377fbea409`

## 一、体积

### 基础镜像

| 口径 | 数值 |
|------|------|
| `docker image inspect .Size`（验收口径） | **534,391,230 B = 534.4 MB = 509.6 MiB** |
| `docker save` 导出 tar | 534,409,216 B（与上一行同量级） |
| `docker images` 显示的虚拟大小 | 1.15 GB（展开后口径，含与其它镜像共享的层） |
| `docker system df -v` | 共享 113.6 MB / 独占 1.038 GB |

分层构成（`docker history`，未压缩）：

| 层 | 体积 |
|----|------|
| debian:bookworm-slim 底座 | 85.3 MB |
| docker 客户端二进制（静态 Go） | 42.5 MB |
| 依赖镜像离线包层 | 490 MB |
| 入口脚本 + 加载脚本 + 目录权限 | 33 kB |

> 离线包占了镜像体积的九成。基础镜像必须携带离线包是任务硬要求；若后续要瘦身，唯一有效的方向是拆成「基础镜像 + 离线包镜像」两层由平台组合。

### 依赖镜像离线包

| 包 | 字节 | MB | sha256 |
|----|------|-----|--------|
| `postgres-16.15-alpine3.24.tar` | 116,749,312 | 116.7 | `75be4e107226def02acd7351c23b567324b30ed3c2ed5bc0f769ebf68cf9aaa5` |
| `minio-minio-RELEASE.2025-04-22T22-12-26Z.tar` | 64,024,576 | 64.0 | `6ab00aa32cdac2220fc812118296e7144c5a44171586d4d4b155f02b28777716` |
| `logto-1.29.0.tar` | 308,753,408 | 308.8 | `f111a0c273ac924ad9b2792bc75c44abd7ba1951cdcd0ef656b74be53daff5f2` |
| **合计** | **489,527,296** | **489.5 MB（467 MiB）** | — |

### 依赖镜像版本（已钉死）

| 用途 | 镜像引用 | 来源 | digest |
|------|----------|------|--------|
| Postgres | `postgres:16.15-alpine3.24` | Docker Hub `library/postgres` | `sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab` |
| MinIO | `minio/minio:RELEASE.2025-04-22T22-12-26Z` | Docker Hub `minio/minio`（**官方仓库已从 Docker Hub 下架**，本包取自宿主 root 守护进程里已存在的同 digest 官方镜像） | `sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e` |
| Logto | `ghcr.io/logto-io/logto:1.29.0` | GHCR `logto-io/logto` | `sha256:5d2b916d2a3cd26517182b9061eb4b28a26ce317e0f6c43ee175b60b5f1d0a9f` |

## 二、加载耗时

| 场景 | 数值 |
|------|------|
| 首次加载（免 root 守护进程，3 个包 489.5 MB） | **23 秒** |
| 第二次执行 `load-deps.sh` | 3 个包全部 `skip`，耗时 < 1 秒 |

首次加载日志（容器内 `/tmp/load-deps.log`）：

```
[load-deps] 开始处理依赖镜像离线包（目录：/opt/deps/images）
[load-deps] 加载前镜像列表：
sandbox-platform/base:0.1.0 (1.15GB)
[load-deps] load  postgres:16.15-alpine3.24 <- postgres-16.15-alpine3.24.tar
[load-deps] loaded postgres:16.15-alpine3.24
[load-deps] load  minio/minio:RELEASE.2025-04-22T22-12-26Z <- minio-minio-RELEASE.2025-04-22T22-12-26Z.tar
[load-deps] loaded minio/minio:RELEASE.2025-04-22T22-12-26Z
[load-deps] load  ghcr.io/logto-io/logto:1.29.0 <- logto-1.29.0.tar
[load-deps] loaded ghcr.io/logto-io/logto:1.29.0
[load-deps] 加载后镜像列表：
sandbox-platform/base:0.1.0 (1.15GB)
postgres:16.15-alpine3.24 (420MB)
ghcr.io/logto-io/logto:1.29.0 (1.76GB)
minio/minio:RELEASE.2025-04-22T22-12-26Z (250MB)
[load-deps] 结束：全部离线包处理完毕
```

第二次执行（幂等）：

```
[load-deps] skip  postgres:16.15-alpine3.24（已存在，跳过加载）
[load-deps] skip  minio/minio:RELEASE.2025-04-22T22-12-26Z（已存在，跳过加载）
[load-deps] skip  ghcr.io/logto-io/logto:1.29.0（已存在，跳过加载）
```

## 三、判定结果

### `verify.sh`（镜像级，宿主 root 守护进程）：33 项全通过

| 判定组 | 结果 |
|--------|------|
| bash / docker 客户端存在、`docker --version` 有版本输出 | 通过 |
| 业务运行时缺席：node、npm、pnpm、python3、python、psql、pg_config、mc、minio、postgres、git、curl、jq | 通过（13 项均未安装） |
| 无 `VOLUME` 指令，`inspect .Config.Volumes` 为 `null`；容器内只有 `/proc` `/sys` `/dev` `/etc` 标准挂载 | 通过 |
| `/workspace` 是空目录、可写、非挂载点、权限 1777 | 通过 |
| `/entrypoint.sh` 与 `/opt/deps/load-deps.sh` 存在，静态检查无业务运行时调用 | 通过 |
| 三个离线包与 `images.list` 清单在镜像内 | 通过 |
| docker 缺失 → 输出含 `docker client missing` 且退出码 127 | 通过 |
| docker 存在 → 进入交互式 bash，退出码 0 | 通过 |

### `verify-rootless.sh`（真实免 root 守护进程）：7 项全通过

| 判定 | 结果 |
|------|------|
| 入口脚本在容器内后台自动完成离线包加载（耗时 23 秒） | 通过 |
| 免 root 守护进程已导入 postgres / minio / logto 三个镜像 | 通过 |
| `load-deps.sh` 幂等：3 个镜像全部 `skip`，`loaded` 计数为 0 | 通过 |
| 容器内 `docker version`：client 29.6.2 == server 29.6.2 | 通过 |
| 客户端版本 == 宿主 root 守护进程版本 29.6.2 | 通过 |
| 回收：容器删除、用户与子 ID 段清除、用户级单元删除、运行时目录回收（6 项校验全通过） | 通过 |

容器内版本一致性输出：

```
[base-image] 容器内 client=29.6.2 server=29.6.2
```

## 四、完成标准逐条核对

| 完成标准 | 结论 | 依据 |
|----------|------|------|
| Dockerfile 可构建出 `sandbox-platform/base:<tag>`，构建无外网 | 通过 | `docker build --network=none` 成功；RUN 步骤仅本地文件操作 |
| 镜像内含 docker 客户端，`docker --version` 有输出且能与外部守护进程通信 | 通过 | `Docker version 29.6.2, build dfc4efb`；免 root 守护进程下 `docker ps`/`docker load` 均正常 |
| 纯 bash 入口脚本，只依赖 bash 与 docker，静态检查通过 | 通过 | `verify.sh` 静态检查无命中 |
| 入口行为固定：docker 存在则 exec 交互式 bash，不存在则报错退出码 127 | 通过 | 两条判定均通过 |
| 镜像不内置任何 volume 挂载点 | 通过 | `inspect .Config.Volumes = null`；容器内只有标准挂载 |
| 存在便捷空目录 `/workspace` 且可写，容器层目录、随容器消失 | 通过 | 空目录、1777、可创建删除文件、`/proc/mounts` 无命中 |
| README 写明套接字默认路径 `/var/run/docker.sock` | 通过 | README「挂载点约定」 |
| 依赖镜像离线包随镜像分发，`docker load` 可离线导入成功 | 通过 | 三个包在 `/opt/deps/images/`，免 root 守护进程内导入成功 |
| `load-deps.sh` 首次自动加载、重复执行不重复加载、输出前后镜像列表 | 通过 | 日志含 `skip`/`loaded` 与前后镜像列表 |
| `verify.sh` 断言无业务运行时、有 docker 与 bash | 通过 | 33 项判定 |
| README 写明构建命令、标签规则、套接字路径、`/workspace` 含义、离线包来源与更新方式 | 通过 | README 全文 |
| RESULTS.md 记录镜像体积、离线包体积、首次加载耗时 | 通过 | 本文件第一、二节 |

## 五、踩坑清单

1. **`minio/minio` 已从 Docker Hub 下架**：`docker pull minio/minio:RELEASE.2025-04-22T22-12-26Z` 直接 `403 Forbidden / denied`，Docker Hub 的仓库 API 返回 `object not found`，`quay.io/minio/minio` 也改成需要认证且标签列表为空。处理方式：用宿主 root 守护进程里已存在的同 digest 官方镜像导出离线包（`sha256:a1ea29fa…`），并在 README / 本文件记录来源。**后续更新 MinIO 版本时需要另找可拉取的镜像源，不能假设 Docker Hub 还能拉。**
2. **`docker:cli` 标签是 latest**（当时指向 29.9.2），client 与宿主 server 版本对不上。基础镜像的客户端版本由构建参数 `DOCKER_CLI_VERSION=29.6.2` 锁定，取值必须与宿主守护进程一致。
3. **docker 客户端二进制是静态 Go 程序**（`not a dynamic executable`），可以跨发行版直接复制；但 `docker:29.6.2-cli` 镜像本身是 Alpine（musl），只搬二进制、不搬它的 libc。
4. **`debian:bookworm-slim` 自带 bash**（`/usr/bin/bash`）与 `libtinfo.so.6`，不需要在无网阶段离线安装 bash，选它比 ubuntu:24.04 更省事也更小。
5. **Dockerfile 里 `FROM` 之后的阶段看不到全局 ARG**：LABEL 里引用 `${BASE_VERSION}` / `${DOCKER_CLI_VERSION}` 会触发 `UndefinedVar` 警告且渲染为空，必须在构建阶段内重新 `ARG` 一次。
6. **`/proc/mounts` 的字段顺序与 `/etc/fstab` 不同**：挂载点在第 2 列（`source target fstype options 0 0 extra`），第 5 列是 `0`。判定「无预置挂载点」时按 fstab 口径写会全量误报。
7. **静态检查会把注释里的词也算命中**：入口脚本注释里原本写了被禁命令名，导致「只依赖 bash 与 docker」判定失败。已把注释改成不含这些词的表述；脚本正文本身从未调用过它们。
8. **免 root 守护进程里 `docker images` 的 SIZE 是展开后的虚拟大小**（基础镜像显示 1.15 GB），与 `docker image inspect .Size`（534.4 MB）不是同一口径；测体积一律以 inspect 为准。
9. **`exec bash -i` 在非 TTY 下会打印 `cannot set terminal process group` 告警**（退出码仍为 0），这是交互式 shell 的正常行为，判定脚本按退出码判定即可。
10. **离线包 tar 共 489 MB，未进 git**：克隆仓库后必须先跑 `fetch-deps.sh` 再构建；`Dockerfile` 的 `RUN` 步骤会检查 `deps/images/*.tar` 是否存在，缺失时构建直接失败并提示，避免产出无法加载依赖的空壳镜像。
11. **Dockerfile 首行不要写 `# syntax=docker/dockerfile:1`**：它会让 BuildKit 去仓库拉取前端镜像，无外网构建时直接失败；去掉后用内置前端即可，本构建全程只解析两个基础镜像的 manifest（已在本机缓存）。
12. **内置前端产出的镜像配置里没有 `Volumes` 这个 key**（不是 `null`，而是字段不存在）；`docker image inspect --format '{{json .Config.Volumes}}'` 会报 `map has no entry for key "Volumes"`。判定脚本要把「字段不存在」与「值为 null」都当作“无挂载点”。
