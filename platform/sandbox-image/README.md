# 默认全栈沙箱镜像 `sandbox-platform/sandbox-default`

平台官方默认沙箱镜像。在平台基础镜像 `sandbox-platform/base` 之上叠加**全栈开发工具链**与**Playwright chromium**，供 agent 在隔离沙箱里完成端到端开发与测试。

底座能力（继承自基础镜像）：bash、docker 客户端、纯 bash 入口脚本、依赖镜像离线包、`/workspace` 便捷目录。

本层新增：**git、nvm + node LTS、pnpm、uv、pi CLI、Playwright chromium**。

## 镜像内容

| 工具 | 版本 | 安装位置 | 说明 |
|------|------|----------|------|
| git | 2.39.5 | `/usr/bin/git` | Debian 官方包 |
| nvm | 0.40.8 | `/usr/local/nvm` | node 版本管理器，装在全局路径 |
| node | v22.23.1 | `/usr/local/nvm/versions/node/v22.23.1/bin` | LTS 线（Jod），与宿主 pi 运行环境同版本 |
| npm | 10.9.8 | 同上 | node 自带 |
| pnpm | 10.32.1 | 同上 | npm 全局包，跟随 nvm 切换版本 |
| pi CLI | 1.4.0 | 同上 | npm 包 `@earendil-works/pi-coding-agent`，与宿主安装版本钉死 |
| playwright | 1.64.1 | 同上 | npm 全局包，提供 `playwright` / `npx playwright` 命令 |
| uv | 0.11.29 | `/usr/local/bin/uv` | 官方安装脚本装到系统路径，`uvx` 同目录 |
| python3 | 3.11.2 | `/usr/bin/python3` | Debian 官方包；uv 另可自行装 python |
| chromium | 156.0.8078.4 | `/opt/playwright-browsers/chromium-1248` | Playwright 构建号 1248 |

### 环境变量

| 变量 | 值 | 作用 |
|------|-----|------|
| `PLAYWRIGHT_BROWSERS_PATH` | `/opt/playwright-browsers` | 浏览器固定安装路径，不依赖 `HOME` |
| `NVM_DIR` | `/usr/local/nvm` | nvm 安装目录 |
| `NODE_PATH` | `/usr/local/nvm/versions/node/v22.23.1/lib/node_modules` | 让任意目录下的脚本能 `require('playwright')` 等全局包 |
| `PATH` | 以 nvm 的 node bin 目录开头 | 非交互式 shell 也能直接用 node 工具链 |

### 浏览器目录

`/opt/playwright-browsers` 下只有 chromium 系产物，**不含 firefox / webkit**：

| 子目录 | 体积 | 说明 |
|--------|------|------|
| `chromium-1248` | 403 MB | 完整 chromium |
| `chromium_headless_shell-1248` | 273 MB | chromium 的无头 shell（Playwright 无头模式的默认载体） |
| `ffmpeg-1013` | 6 MB | Playwright 录屏用的 ffmpeg |
| **合计** | **681 MB** | 镜像体积的大头 |

### 交互式 shell 初始化

容器入口执行的是 `exec bash -i`（交互式非登录 shell），**只会读 `~/.bashrc`，不会读 `/etc/profile`**。因此 nvm 的初始化写进了两处：

- `/root/.bashrc` 末尾追加一行引用 `/etc/profile.d/sandbox-platform-nvm.sh`——覆盖 `bash -i` 与 `docker exec -it <容器> bash`；
- `/etc/profile.d/sandbox-platform-nvm.sh`——覆盖登录 shell（`bash -l`）。

另外 `/usr/local/bin` 下有 node / npm / npx / pnpm / pnpx / pi / playwright 的软链，以及一个 `nvm` 包装脚本，使**非交互式 shell**（`docker exec <容器> bash -c "nvm ls"`）也能直接使用这些命令。

## 构建

```bash
# 在仓库根目录执行（构建期需要外网：拉 node 发行包 / npm 包 / uv / chromium）
docker build \
  -t sandbox-platform/sandbox-default:0.1.0 \
  platform/sandbox-image
```

### 构建参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `BASE_IMAGE` | `sandbox-platform/base:0.1.0` | 底座镜像；换底座只需改这个 |
| `SANDBOX_VERSION` | `0.1.0` | 只写入 OCI label |
| `NVM_VERSION` | `v0.40.8` | nvm 自身版本 |
| `NODE_VERSION` | `22.23.1` | node 版本。填 `lts/*` 则取当时最新 LTS；填具体版本则可复现 |
| `PNPM_VERSION` | `10.32.1` | pnpm 版本 |
| `PI_VERSION` | `1.4.0` | pi CLI 版本（npm 包 `@earendil-works/pi-coding-agent`） |
| `PLAYWRIGHT_VERSION` | `1.64.1` | playwright 版本 |
| `UV_VERSION` | `0.11.29` | uv 版本 |

### 标签规则

- 命名：`sandbox-platform/sandbox-default:<平台语义化版本>`，例如 `sandbox-platform/sandbox-default:0.1.0`。
- **必须同时打两个 tag**：带版本号的 `sandbox-platform/sandbox-default:0.1.0`，以及不带版本号的 `sandbox-platform/sandbox-default`（等价于 `:latest`）。
  原因：平台配置里 `DEFAULT_IMAGE = "sandbox-platform/sandbox-default"`（`platform/src/sandbox_platform/config.py`）**不带 tag**，docker 会把它解析成 `:latest`。只打版本号 tag 的话，`sandboxctl create <名字>` 零参数创建会去找 `sandbox-platform/sandbox-default:latest` 并失败。

  ```bash
  docker build -t sandbox-platform/sandbox-default:0.1.0 platform/sandbox-image
  docker tag  sandbox-platform/sandbox-default:0.1.0 sandbox-platform/sandbox-default
  ```

- 版本号语义：`<主>.<次>.<修订>`。主次跟随平台自身版本；**修订号在工具链版本变化时递增**（node / pi / playwright / uv 任一升级都要递增并重新打两个 tag）。

### 镜像体积（实测）

| 口径 | 数值 |
|------|------|
| `docker image inspect .Size` | **1,271,770,215 B = 1212.9 MB = 1184.4 MiB** |
| 其中底座（`sandbox-platform/base:0.1.0`） | 534.4 MB |
| 其中 Playwright 浏览器目录 | 681 MB |
| 其中 node 工具链（nvm + node + pnpm + pi + playwright 包） | 433 MB |
| 其中 uv | 66 MB |

分层构成（`docker history`，未压缩）：

| 层 | 体积 |
|----|------|
| apt 系统依赖（git / build-essential / python3 / jq 等） | 455 MB |
| nvm + node v22.23.1 | 249 MB |
| pnpm + pi CLI 全局包 | 191 MB |
| uv + uvx | 66.1 MB |
| playwright + chromium + chromium 系统依赖库 | 1.04 GB |
| 初始化脚本与软链 | 82 kB |

实测数据与完整耗时见 [RESULTS.md](RESULTS.md)。

## 在默认镜像上叠加用户自己的层

默认镜像就是普通底座，用户镜像直接 `FROM` 它：

```dockerfile
FROM sandbox-platform/sandbox-default:0.1.0

# 用户自己的层：代码、配置、其它工具
RUN npm i -g @anthropic-ai/claude-code
COPY ./app /opt/app
WORKDIR /opt/app
```

```bash
docker build -t my-sandbox:0.1.0 -f ./Dockerfile .
```

注意：

- **用户镜像不需要重复声明工具链**，git / node / pnpm / uv / pi / chromium 全部继承；
- **不要覆盖 `ENTRYPOINT`**。基础镜像的入口脚本负责「后台加载依赖离线包 + exec 交互式 bash」，覆盖它会丢掉离线包自动加载与「docker 客户端缺失时以 127 退出」的约定；
- **不要写 `VOLUME`**，也不要预置宿主机挂载目标，保持「挂载由启动沙箱时声明」的统一约定；
- 用户层里 `RUN` 需要联网时不必加 `--network=none`；
- 平台自建镜像（`sandbox-platform/*`）不进镜像仓库：沙箱守护进程里没有时，平台会自动走「宿主 root 守护进程导出 → 注入沙箱守护进程」这条路径（`docker save` → `docker load`），用户无需手动推送。

## 扩展安装其他浏览器

默认只装 chromium（体积优先）。需要 firefox / webkit 时，在**用户自己的层**里补装即可，不必重建默认镜像：

```dockerfile
FROM sandbox-platform/sandbox-default:0.1.0

# --with-deps 会用 apt 补齐该浏览器的系统依赖库；浏览器落在同一个 PLAYWRIGHT_BROWSERS_PATH 下
RUN playwright install --with-deps firefox webkit
```

也可以在**运行中的沙箱**里直接装（需要联网）：

```bash
# 在沙箱容器内执行
playwright install --with-deps firefox
```

体积增量参考（Playwright 1.64.1）：firefox 约 90 MB、webkit 约 90 MB，各自带系统依赖库约 100~300 MB。

需要更小的 chromium 变体时，可以只装无头 shell：

```dockerfile
FROM sandbox-platform/sandbox-default:0.1.0
# 去掉完整 chromium，只留无头 shell（省 403 MB）
RUN rm -rf /opt/playwright-browsers/chromium-1248
```

## 依赖离线包更新流程

离线包（postgres / minio / logto 的 `docker save` 归档）**在底座镜像里**，默认镜像只是继承。要换依赖版本：

```bash
cd platform/base-image
./fetch-deps.sh                       # 拉取 → docker save → 重算 SHA256SUMS
docker build --network=none -t sandbox-platform/base:0.1.1 platform/base-image

cd ../..
docker build -t sandbox-platform/sandbox-default:0.1.0 \
  --build-arg BASE_IMAGE=sandbox-platform/base:0.1.1 \
  platform/sandbox-image
docker tag sandbox-platform/sandbox-default:0.1.0 sandbox-platform/sandbox-default
```

要点：

- 离线包 tar 合计约 489 MB，**不进 git 版本库**（见 `platform/base-image/.gitignore`），克隆仓库后必须先跑一次 `fetch-deps.sh`；
- 加载脚本 `/opt/deps/load-deps.sh` 幂等：容器首次启动后台加载三个包（首启日志 `loaded`），第二次启动全部 `skip`；
- 加载是**后台**的，不阻塞交互式 shell（bash 可用耗时 < 1 秒，加载在后台跑约 23 秒）；
- 换底座镜像后要同步更新 `platform/base-image/RESULTS.md` 与本目录的体积记录。

## 验证脚本

| 脚本 | 作用 | 依赖 |
|------|------|------|
| `verify.sh` | 镜像级判定：工具链版本、nvm 归属、浏览器只有 chromium、离线截图、凭证不落镜像、体积统计 | 宿主 root 守护进程 |
| `verify-sandbox.sh` | 沙箱平台联调：真实创建沙箱 → 工具链 → docker 版本一致性 → 离线包加载与幂等 → 冷启动耗时 → 零参数默认镜像 | 宿主 root 权限 + systemd 用户会话 |

```bash
cd platform/sandbox-image
IMAGE=sandbox-platform/sandbox-default:0.1.0 ./verify.sh
IMAGE=sandbox-platform/sandbox-default:0.1.0 ./verify-sandbox.sh
```

`verify-sandbox.sh` 会创建并回收真实沙箱（涉及系统用户、子 UID 段、用户级守护进程）。

## 目录内容

| 文件 | 作用 |
|------|------|
| `Dockerfile` | 镜像构建定义（底座 + 工具链 + 浏览器） |
| `bashrc.d/nvm.sh` | nvm 初始化片段，装到 `/etc/profile.d` 并由 `/root/.bashrc` 引用 |
| `bin/nvm` | `nvm` 命令的非交互式包装脚本 |
| `verify.sh` | 镜像级判定脚本 |
| `verify-sandbox.sh` | 沙箱平台联调判定脚本 |
| `RESULTS.md` | 实测记录（体积、耗时、踩坑） |
