# 默认全栈沙箱镜像 · 实测记录

- 执行日期：2026-10-29
- 宿主：Ubuntu 26.04 LTS / 内核 7.0.0-38-generic / cgroup v2
- Docker：客户端 + 服务端 **29.6.2**（宿主 root 守护进程）
- 免 root 守护进程：平台自建（`platform/src/sandbox_platform/` 的 systemd 用户单元 + RootlessKit）
- 镜像：`sandbox-platform/sandbox-default:0.1.0`，image id `sha256:cc053354831d7f4e3caaff9d25779fc57565a5c8a79d2cc3f1d29cdfe4f2333a`
- 同名不带 tag 的 `sandbox-platform/sandbox-default:latest` 指向同一 image id

## 一、体积

### 镜像总体积

| 口径 | 数值 |
|------|------|
| `docker image inspect .Size`（验收口径） | **1,271,770,215 B = 1212.9 MB = 1184.4 MiB** |
| 底座 `sandbox-platform/base:0.1.0` | 534,391,230 B = 534.4 MB |
| 本层净增 | 737,378,985 B = 703.1 MB |
| `docker images` 显示的虚拟大小 | 3.9 GB（展开后口径，含与其它镜像共享的层） |
| `docker save` 导出 tar | 1,271,795,712 B |

分层构成（`docker history`，未压缩）：

| 层 | 体积 | 内容 |
|----|------|------|
| apt 系统依赖层 | 455 MB | git / build-essential / python3(-dev/-venv) / jq / iproute2 / openssh-client 等 |
| nvm + node 层 | 249 MB | nvm 0.40.8 仓库 + node v22.23.1（含 npm 10.9.8） |
| npm 全局包层 | 191 MB | pnpm 10.32.1 + pi CLI 1.4.0（`@earendil-works/*` 占 156 MB） |
| uv 层 | 66.1 MB | uv 0.11.29 + uvx（`/usr/local/bin`） |
| Playwright 层 | 1.04 GB | playwright 1.64.1 包 + chromium 浏览器 + chromium 系统依赖库 |
| 初始化脚本与软链层 | 82 kB | `.bashrc` 追加、`/etc/profile.d` 片段、`/usr/local/bin` 软链、`nvm` 包装脚本 |

镜像内目录体积（`du -sm`）：

| 路径 | 体积 | 说明 |
|------|------|------|
| `/opt/deps` | 467 MB | 继承自底座：三个依赖镜像离线包 |
| `/opt/playwright-browsers` | 681 MB | Playwright 浏览器 |
| `/usr/local/nvm` | 433 MB | nvm 仓库 + node 发行版 + npm 全局包（versions 占 399 MB） |
| `/usr/lib` | 553 MB | 系统库（含 chromium 装进来的依赖库） |
| `/usr/share` | 110 MB | 系统文档与补全 |
| `/usr/bin` | 98 MB | 系统命令 |
| `/usr/local/bin` | 104 MB | docker 客户端 42 MB + uv 66 MB + 软链 |

### chromium 浏览器体积

`PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers`，目录内容与体积：

| 子目录 | 体积 | 说明 |
|--------|------|------|
| `chromium-1248` | 403 MB | 完整 chromium（Google Chrome for Testing 156.0.8078.4） |
| `chromium_headless_shell-1248` | 273 MB | chromium 无头 shell，Playwright 无头模式的默认载体 |
| `ffmpeg-1013` | 6 MB | Playwright 录屏用 ffmpeg |
| **合计** | **681 MB** | 占镜像体积的 56% |

**未安装**：firefox、webkit（`playwright install chromium` 只装 chromium 系产物）。实测目录清单：

```
chromium-1248
chromium_headless_shell-1248
ffmpeg-1013
```

### 工具版本实测

| 工具 | 版本 | 来源 |
|------|------|------|
| git | 2.39.5 | Debian bookworm 官方包 |
| nvm | 0.40.8 | 官方安装脚本，nvm-sh/nvm v0.40.8 |
| node | v22.23.1 | nvm 管理，LTS 线（Jod）；npm 10.9.8 |
| pnpm | 10.32.1 | npm 全局包 |
| pi | 1.4.0 | npm 包 `@earendil-works/pi-coding-agent@1.4.0` |
| uv | 0.11.29 | 官方安装脚本（astral.sh），装在 `/usr/local/bin` |
| playwright | 1.64.1 | npm 全局包；chromium 构建号 1248 / Chrome 156.0.8078.4 |
| python3 | 3.11.2 | Debian bookworm 官方包 |
| docker | client 29.6.2 / server 29.6.2 | 继承自底座，与宿主守护进程一致 |

## 二、耗时

| 场景 | 数值 |
|------|------|
| 镜像构建（首次完整，无缓存，含 node 与 chromium 下载） | **5 分 22 秒** |
| 镜像构建（增量，改动 npm 层，node 与 chromium 层命中缓存） | **2 分 49 秒** |
| `docker save` 导出镜像（宿主 root 守护进程） | 8.65 秒 |
| `docker load` 导入镜像（宿主 root 守护进程） | 4.63 秒 |
| `sandboxctl create` 全程（建用户 → 起守护进程 → 镜像导出注入 → 建容器） | **27.4 秒** |
| `sandboxctl start`（复用守护进程，重建容器） | 0.72 秒 |
| **离线包首次加载**（三个包 489.5 MB，免 root 守护进程） | **23 秒** |
| 离线包二次启动（幂等，3 个包全部 skip） | < 1 秒 |
| **容器冷启动到 bash 可用**（`docker rm -f` + `docker run -d -i` → `docker exec` 成功） | **0.17 ~ 0.42 秒** |

冷启动耗时说明：入口脚本把离线包加载放在**后台**，随即 `exec bash -i`，所以 bash 可用不受 23 秒的加载过程影响。实测值随守护进程当时的忙碌程度在 0.17 ~ 0.42 秒之间波动。

## 三、判定结果

### `verify.sh`（镜像级，宿主 root 守护进程）：23 项全通过

| 判定组 | 结果 |
|--------|------|
| 交互式 bash 内 `pi / git / uv / node / pnpm / nvm / npx playwright --version` 全部有版本输出 | 通过（7 项） |
| nvm 目录存在、`nvm --version` = 0.40.8、node 与 pnpm 都落在 nvm 目录下 | 通过 |
| 镜像 Env 固定 `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers` | 通过 |
| chromium 已安装、firefox 未安装、webkit 未安装 | 通过 |
| 离线判据：`--network=none` 起容器，`npx playwright screenshot` 对 `data:text/html,<h1>ok</h1>` 截图成功，产物是合法 PNG（5292 字节） | 通过 |
| 凭证不落镜像：`docker image inspect` 的 Env 无密码类字段；镜像内无 `.env` 文件、无凭证类文件、配置类文件无密码赋值 | 通过（4 项） |

### `verify-sandbox.sh`（真实沙箱平台联调）：18 项全通过

| 判定 | 结果 |
|------|------|
| 用新镜像 `sandboxctl create` 创建沙箱成功（27.4 秒） | 通过 |
| 沙箱容器内交互式 bash 的工具链全部有版本输出 | 通过（7 项） |
| 容器内 `docker version`：client 29.6.2 == server 29.6.2 | 通过 |
| 入口脚本后台自动加载三个离线包，首启日志 3 条 `loaded` | 通过 |
| 沙箱守护进程里能看到 postgres / minio / logto 三个镜像 | 通过（3 项） |
| 二次启动 3 个离线包全部 `skip`、`loaded=0`（幂等） | 通过 |
| 容器冷启动到 bash 可用 | 通过（0.37 秒） |
| `sandboxctl create` 零参数用上平台默认镜像 | 通过 |

沙箱容器内的工具链输出：

```
pi --version               => 1.4.0
git --version              => git version 2.39.5
uv --version               => uv 0.11.29 (x86_64-unknown-linux-gnu)
node --version             => v22.23.1
pnpm --version             => 10.32.1
nvm --version              => 0.40.8
npx playwright --version   => Version 1.64.1
docker version             => client=29.6.2 server=29.6.2
```

依赖离线包首次加载日志（沙箱容器内 `/tmp/load-deps.log`）：

```
[load-deps] 开始处理依赖镜像离线包（目录：/opt/deps/images）
[load-deps] 加载前镜像列表：
sandbox-platform/sandbox-default:0.1.0 (4.04GB)
[load-deps] load  postgres:16.15-alpine3.24 <- postgres-16.15-alpine3.24.tar
[load-deps] loaded postgres:16.15-alpine3.24
[load-deps] load  minio/minio:RELEASE.2025-04-22T22-12-26Z <- minio-minio-RELEASE.2025-04-22T22-12-26Z.tar
[load-deps] loaded minio/minio:RELEASE.2025-04-22T22-12-26Z
[load-deps] load  ghcr.io/logto-io/logto:1.29.0 <- logto-1.29.0.tar
[load-deps] loaded ghcr.io/logto-io/logto:1.29.0
[load-deps] 加载后镜像列表：
sandbox-platform/sandbox-default:0.1.0 (4.04GB)
postgres:16.15-alpine3.24 (420MB)
ghcr.io/logto-io/logto:1.29.0 (1.76GB)
minio/minio:RELEASE.2025-04-22T22-12-26Z (250MB)
[load-deps] 结束：全部离线包处理完毕
```

二次启动（幂等）：

```
[load-deps] skip  postgres:16.15-alpine3.24（已存在，跳过加载）
[load-deps] skip  minio/minio:RELEASE.2025-04-22T22-12-26Z（已存在，跳过加载）
[load-deps] skip  ghcr.io/logto-io/logto:1.29.0（已存在，跳过加载）
```

## 四、完成标准逐条核对

| 完成标准 | 结论 | 依据 |
|----------|------|------|
| `platform/sandbox-image/Dockerfile` 基于 `sandbox-platform/base` 构建，产物标签 `sandbox-platform/sandbox-default:<tag>` | 通过 | `FROM sandbox-platform/base:0.1.0`；产物 `:0.1.0` 与 `:latest`（不带 tag）双 tag |
| 工具链齐备：`pi / git / uv / node / pnpm --version` 均有输出；node 与 pnpm 由 nvm 管理，`nvm --version` 有输出 | 通过 | 镜像级与沙箱内两处均验证 |
| Playwright 浏览器随镜像安装，`npx playwright --version` 有输出 | 通过 | Version 1.64.1 |
| 默认只装 chromium，firefox / webkit 不装，chromium 位于 `PLAYWRIGHT_BROWSERS_PATH` 指向的目录 | 通过 | `/opt/playwright-browsers`，目录清单只有 chromium 系三项；README 写明扩展方法 |
| 离线可运行：`--network=none` 起容器后对 `data:text/html,<h1>ok</h1>` 截图成功，PNG 落在可写目录 | 通过 | 产物 5292 字节、PNG magic 校验通过、写在 `/workspace` |
| 依赖镜像首次自动加载，首启日志有加载记录，第二次显示跳过 | 通过 | 首启 3 条 `loaded`，二启 3 条 `skip` |
| 加载后以沙箱守护进程身份执行 `docker images` 能看到 postgres / minio / logto 三个镜像 | 通过 | 三个镜像引用与 base 任务约定一致 |
| 凭证不落镜像（Env + 文件清单双重断言） | 通过 | Env 无密码类字段；无 `.env`、无凭证类文件、配置无密码赋值 |
| README 写明构建命令、标签规则、叠加用户层方法、离线包更新流程、镜像体积实测 | 通过 | README 全文 |
| RESULTS.md 记录镜像总体积、chromium 体积、离线包加载耗时、冷启动到 bash 可用耗时 | 通过 | 本文件第一、二节 |

## 五、踩坑清单

1. **nvm 的版本目录带 `v` 前缀**：装完 node 后目录是 `/usr/local/nvm/versions/node/v22.23.1`，不是 `.../22.23.1`。最初按后者写 `ENV PATH` 与软链，结果**非交互式 shell 里 `node` 直接 command not found**，而交互式 shell 因为 nvm 自动切了版本反而正常——极具迷惑性。软链那一步因为 `[ -e ]` 判断不成立被静默跳过，构建日志里也看不出来。
2. **nvm v0.40.8 的仓库根目录没有可执行的 `nvm` 文件**（旧版有，新版只留 `nvm.sh` 与 `nvm-exec`）。`ln -sf "$NVM_DIR/nvm" /usr/local/bin/nvm` 会造出一个**指向不存在文件的坏软链**，非交互式 shell 里报 `No such file or directory`。改为自写 `/usr/local/bin/nvm` 包装脚本（先 source `nvm.sh` 再转发参数），`nvm --version` 在任何 shell 下都能用。
3. **nvm 不允许创建带子目录的别名**：`nvm alias 'lts/*' 22.23.1` 报 `Aliases in subdirectories are not supported`，`lts/jod` 同样不行。所以镜像内无法把 `lts/*` 指向本机版本，`nvm use lts/*` 会去联网装当时最新 LTS（离线时报错）。镜像用 `nvm alias default 22.23.1` 固定默认版本。
4. **`nvm install` 不会改 `default` 别名**（只在没有 default 时才设），必须显式 `nvm alias default`，否则交互式 shell 里 nvm 自动切换会落到 `system` node。
5. **`bash -i` 是交互式非登录 shell，只读 `~/.bashrc`，不读 `/etc/profile`**。nvm 初始化只写 `/etc/profile.d` 的话，容器入口 `exec bash -i` 完全读不到。必须在 `/root/.bashrc` 里追加引用。
6. **`docker exec -it <容器> bash`（不带 `-i`）也是交互式 shell**（stdin 与 stderr 都是 tty 就算交互），所以它会读 `~/.bashrc`；但 `docker exec <容器> bash -c "..."` 不是交互式，只吃镜像的 `ENV PATH`。两条路径都要覆盖，所以除 `.bashrc` 外还做了 `/usr/local/bin` 软链与 `ENV PATH`。
7. **npm 缓存留在旧层里不会减小镜像**：docker 分层是叠加的，在后一层 `rm -rf /root/.npm` 只是给旧层加了「白障」，镜像总积不变。把清理放进**产生缓存的同一个 RUN 步骤**，镜像从 1309.4 MB 降到 1271.8 MB（省 37.6 MB）。
8. **`playwright` npm 包没有 postinstall**：1.64.1 的包里没有 `install.js`，装包本身不会拉浏览器；必须显式 `playwright install --with-deps chromium`。反过来 `playwright install chromium` 会同时装 `chromium` 与 `chromium_headless_shell` 两个产物（403 MB + 273 MB）——两者都是 chromium，不违反「不装 firefox/webkit」，但要知道体积大头在这。
9. **apt 列表要清两次**：`playwright install --with-deps` 自己会 `apt-get install`，所以该步骤前要先 `apt-get update`；步骤后 `rm -rf /var/lib/apt/lists/*`。
10. **平台默认镜像名不带 tag**：`config.py` 里 `DEFAULT_IMAGE = "sandbox-platform/sandbox-default"`，docker 会解析成 `:latest`。只打 `:0.1.0` 的话，`sandboxctl create` 零参数会去找 `:latest` 而失败。必须同时打不带 tag 的那个名字。
11. **构建期网络偶发失败会让 `uv` 步骤报 127**：`curl -fsSf` 拉安装脚本失败时管道右侧拿到空输入，`uv --version` 随后 command not found，退出码 127 掩盖了真正原因。给所有 curl 加 `--retry 3 --retry-delay 2 --retry-connrefused`。
12. **离线包加载日志是追加写的**：同一个容器重启后 `/tmp/load-deps.log` 里会同时留着第一轮和第二轮的记录。统计「本轮 loaded / skip 数量」必须先按「开始处理依赖镜像离线包」分段，只取最后一段，否则会把两轮加起来误判成幂等失败。
13. **入口脚本的后台加载与 `docker exec` 存在竞争**：离线包正在 `docker load` 时，免 root 守护进程的 API 会被占住，此时 `docker exec` 可能要等几秒。这是守护进程层面的串行化，不是镜像问题；bash 可用本身不受影响（入口先 exec bash 再后台加载）。
14. **别在离线包加载完成前删容器**：`docker rm -f` 会连带杀掉后台的 `load-deps.sh`，若此刻正在 `docker load` 一个包，该次导入会被中断，下次启动需要重载（实测多花约 30 秒）。
