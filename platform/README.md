# platform —— 沙箱平台控制面

一期交付：沙箱生命周期的可复用核心模块 + 薄壳命令行。

## 目录结构

| 路径 | 内容 |
|---|---|
| `src/sandbox_platform/` | 控制面核心模块（生命周期编排、用户与子 ID 段管理、镜像与挂载装配、元数据存储） |
| `src/sandbox_platform/API.md` | 各模块对外函数签名与参数表 |
| `cli/sandboxctl.py` | 命令行薄壳：只做参数解析、调用核心模块、打印结果 |
| `scripts/smoke-lifecycle.sh` | 端到端冒烟脚本（创建 → 关闭 → 启动 → 删除 → 回收校验） |
| `tests/` | 单元测试与宿主级测试（宿主级测试打 `root` 标记） |
| `probe/rootless/` | 一期任务 01 的免 root 打样脚本与实测记录 |

## 环境准备

```bash
cd platform
uv sync --all-groups          # 安装依赖（含测试依赖）
uv run pytest                 # 跑单元测试
uv run pytest -m root         # 额外跑需要真实 root 的宿主级测试
```

## 命令行用法

```bash
# 创建（只有套接字一个固定挂载，其余挂载全部由用户声明）
uv run python cli/sandboxctl.py create demo \
    --image docker:29.6.2-cli \
    --command "sleep infinity" \
    --mount /tmp/demo-data:/data:ro

# 关闭（默认连依赖容器一起停）
uv run python cli/sandboxctl.py stop demo

# 启动（复用同一用户、同一子 ID 段、同一守护进程）
uv run python cli/sandboxctl.py start demo

# 删除（默认交互确认，--yes 跳过）
uv run python cli/sandboxctl.py delete demo --yes

# 列表
uv run python cli/sandboxctl.py list
```

## 运行前提

- 宿主已安装 Docker 与 `dockerd-rootless.sh`、`newuidmap`/`newgidmap`（`uidmap` 包）。
- 宿主操作（建用户、写 `/etc/subuid`、写用户单元、启停用户级守护进程）需要特权：进程本身是 root 时直接执行，否则走免密 `sudo`。
- 平台数据根目录默认 `/var/lib/sandbox-platform`，可用环境变量 `SANDBOX_PLATFORM_HOME` 重定向到可写路径。目录由平台用 `install -d` 创建，属主为首次创建它的那个用户；同一台机器请固定用同一种身份操作控制面。
- 镜像来源优先级：沙箱守护进程已有 → 宿主离线包目录（默认 `/opt/deps/images`，认 `images.list` 清单）→ 宿主本地镜像导出注入 → 守护进程直拉。平台自建镜像（`sandbox-platform/*`）走「宿主导出注入」路径，不依赖镜像仓库。

## 沙箱容器启动约定

- 容器固定带 `-i` 启动：保持标准输入打开，镜像入口脚本里的交互式 shell（如基础镜像的 `exec bash -i`）才不会因标准输入关闭而立即退出。
- 需要自定义入口时用 `--command "…"`（命令行层用 `--entrypoint ""` 覆盖镜像入口，命令参数跟在镜像名之后）。

## 挂载契约

| 挂载 | 来源 | 平台是否处置宿主目录 |
|---|---|---|
| Docker 套接字（容器内 `/var/run/docker.sock`） | 平台固定 | 不适用 |
| `--mount 宿主路径:容器路径[:ro]` | 用户声明 | **不创建、不删除、不修改** |

删除沙箱时平台只回收自己创建的资源：沙箱容器、依赖容器、网桥网络、守护进程与用户单元、系统用户与家目录、子 UID/GID 段、平台元数据。
