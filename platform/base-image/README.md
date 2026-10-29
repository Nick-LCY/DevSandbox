# 平台基础镜像 `sandbox-platform/base`

所有沙箱镜像的唯一底座。只含四样东西：**bash、docker 客户端、纯 bash 入口脚本、依赖镜像离线包**，外加一个容器层临时目录 `/workspace`。

不含任何业务运行时（无 node / pnpm / python3 / psql / mc / git），也不内置任何 volume 挂载点。

## 镜像内容

| 路径 | 内容 | 说明 |
|------|------|------|
| `/usr/local/bin/docker` | docker 客户端 | 静态编译的 Go 二进制，版本必须与宿主守护进程一致 |
| `/entrypoint.sh` | 入口脚本 | 纯 bash，只依赖 bash 与 docker |
| `/opt/deps/load-deps.sh` | 离线包加载脚本 | 幂等，缺失才加载 |
| `/opt/deps/images/*.tar` | 依赖镜像离线包 | postgres / minio / logto 三个 |
| `/opt/deps/images/images.list` | 离线包清单 | `<镜像引用> <离线包文件名>`，加载脚本按它逐条处理 |
| `/workspace` | 便捷空目录 | 容器层目录（非 volume），随容器删除而消失 |

## 构建

```bash
# 在仓库根目录执行；--network=none 保证 RUN 阶段不触网
docker build --network=none \
  --build-arg DOCKER_CLI_VERSION=29.6.2 \
  -t sandbox-platform/base:0.1.0 \
  platform/base-image
```

构建分两个阶段：

1. `FROM docker:29.6.2-cli` —— 抠出 `/usr/local/bin/docker`（静态二进制，可直接放进任意发行版底座）；
2. `FROM debian:bookworm-slim` —— 最终底座（体积优先；bookworm-slim 自带 bash，无需额外安装）。

所有 `RUN` 步骤只做本地文件操作（改权限、建目录、检查离线包是否存在），不访问网络。构建期唯一会访问网络的是 daemon 拉取基础镜像层。

### 构建参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `DOCKER_CLI_VERSION` | `29.6.2` | docker 客户端版本，**必须与宿主守护进程版本一致**（client/server 版本一致性是验收判据） |
| `BASE_IMAGE` | `debian:bookworm-slim` | 底座发行版 |
| `BASE_VERSION` | `0.1.0` | 只写入 OCI label |

宿主守护进程升级后，必须用新版本号重建基础镜像，否则容器内 `docker version` 的客户端与服务端版本会不一致。

## 镜像标签规则

- 命名：`sandbox-platform/base:<平台语义化版本>`，例如 `sandbox-platform/base:0.1.0`。
- 版本号语义：`<主>.<次>.<修订>`，主次跟随平台自身版本，修订号在**依赖离线包更新**或**入口脚本行为变更**时递增。
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
  sandbox-platform/base:0.1.0
```

## 入口行为

`/entrypoint.sh` 的行为是固定的：

1. `docker` 命令不存在 → 打印一行含 `docker client missing` 的错误，**退出码 127**；
2. `docker` 命令存在 → 后台启动 `/opt/deps/load-deps.sh`（日志落 `/tmp/load-deps.log`，**不阻塞**），随后 `exec bash -i` 进入交互式 shell。

## 依赖镜像离线包

### 当前内容（版本已钉死）

| 镜像 | tag | 来源 | 离线包 |
|------|-----|------|--------|
| Postgres | `postgres:16.15-alpine3.24` | Docker Hub `library/postgres` | `deps/images/postgres-16.15-alpine3.24.tar` |
| MinIO | `minio/minio:RELEASE.2025-04-22T22-12-26Z` | Docker Hub `minio/minio`（官方仓库已从 Docker Hub 下架，本包取自宿主已有镜像） | `deps/images/minio-minio-RELEASE.2025-04-22T22-12-26Z.tar` |
| Logto | `ghcr.io/logto-io/logto:1.29.0` | GHCR `logto-io/logto` | `deps/images/logto-1.29.0.tar` |

`deps/images/SHA256SUMS` 记录三个包的 sha256；`deps/images/images.list` 是加载脚本的唯一事实来源。

### 更新方式

改 `deps/images/images.list` 里的版本号，然后：

```bash
cd platform/base-image
./fetch-deps.sh          # 拉取 → docker save → 重算 SHA256SUMS
docker build --network=none -t sandbox-platform/base:0.1.1 platform/base-image
```

`fetch-deps.sh` 拉取失败会直接报错退出，**不会**用别的镜像顶替；离线包与清单不一致时镜像构建会在 `RUN` 阶段直接失败。

> 离线包 tar 共约 489 MB，未纳入 git 版本库（见 `.gitignore`），由 `fetch-deps.sh` + `SHA256SUMS` 保证可复现。克隆仓库后先跑一次 `fetch-deps.sh` 再构建。

### 加载行为

`/opt/deps/load-deps.sh` 幂等：逐条用 `docker images` 检查目标镜像是否已存在，存在则记 `skip`，不存在才 `docker load` 并记 `loaded`，日志同时打印加载前后的镜像列表。容器内查看日志：

```bash
docker exec <容器> cat /tmp/load-deps.log
```

## 在默认镜像上叠加用户层

基础镜像就是普通底座，用户镜像直接 `FROM` 它：

```dockerfile
FROM sandbox-platform/base:0.1.0

# 用户自己的层：代码、配置、其它工具
COPY ./app /opt/app
WORKDIR /opt/app
```

构建用户镜像时**不需要**重复 `--network=none`（基础镜像已经就位），但用户层自己的 `RUN` 若要下载内容，需要放开网络：

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
| `verify.sh` | 镜像级判定：业务运行时缺席、无 volume 挂载点、`/workspace` 语义、入口脚本静态检查与入口行为 | 宿主 docker 守护进程 |
| `verify-rootless.sh` | 免 root 守护进程联调：入口脚本后台自动加载、幂等、客户端与服务端版本一致性 | 复用 `platform/probe/rootless/` 的 00/01/04 脚本 |

```bash
cd platform/base-image
./verify.sh                                   # 镜像级判定
BASE_IMAGE=sandbox-platform/base:0.1.0 ./verify-rootless.sh   # 免 root 联调（测完自动回收）
```

实测数据见 [RESULTS.md](RESULTS.md)。

## 目录内容

| 文件 | 作用 |
|------|------|
| `Dockerfile` | 多阶段构建定义 |
| `entrypoint.sh` | 容器入口（纯 bash） |
| `load-deps.sh` | 依赖离线包幂等加载 |
| `fetch-deps.sh` | 拉取并重新生成离线包 |
| `verify.sh` | 镜像级判定脚本 |
| `verify-rootless.sh` | 免 root 守护进程联调脚本 |
| `deps/images/` | 离线包、清单与校验和 |
| `RESULTS.md` | 实测记录（体积、耗时、踩坑） |
