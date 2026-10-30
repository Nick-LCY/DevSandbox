# platform —— 沙箱平台控制面

一期交付：沙箱生命周期的可复用核心模块 + 薄壳命令行。

## 目录结构

| 路径 | 内容 |
|---|---|
| `src/sandbox_platform/` | 控制面核心模块（生命周期编排、用户与子 ID 段管理、镜像与挂载装配、元数据存储） |
| `src/sandbox_platform/API.md` | 各模块对外函数签名与参数表（含二期 HTTP 接口） |
| `src/sandbox_platform/server/` | 二期服务层：FastAPI 应用工厂、依赖注入、请求与响应模型、沙箱管理路由 |
| `cli/sandboxctl.py` | 命令行薄壳：只做参数解析、调用核心模块、打印结果 |
| `console/dist` | 网页控制台前端构建产物（由服务进程在 `/` 路径托管；目录不存在时跳过静态托管） |
| `server/sandbox-console.service` | systemd 单元模板（只提供模板，不自动安装、不自动启用） |
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

## 控制台服务启动方式

二期把控制面核心包常驻为 HTTP 服务（FastAPI + uvicorn）：**命令行与服务端共用同一套核心接口，行为等价**。

```bash
cd platform
uv sync --all-groups                      # 安装依赖（含 fastapi、uvicorn）
uv run python -m sandbox_platform.server   # 启动服务
```

| 项 | 说明 |
|---|---|
| 监听地址 | 默认 `127.0.0.1:8000`；用环境变量 `SANDBOX_CONSOLE_HOST` / `SANDBOX_CONSOLE_PORT` 覆盖 |
| **只绑回环地址** | 服务不做认证与多用户，允许改成内网地址，**不得暴露公网** |
| 平台数据根 | 仍走 `SANDBOX_PLATFORM_HOME`（默认 `/var/lib/sandbox-platform`），与命令行一致 |
| 权限要求 | 与一期命令行一致：进程本身是 root 时直接执行，否则走免密 `sudo` |
| 前端托管 | `console/dist` 由同一进程在 `/` 路径托管；目录不存在时跳过静态托管并记日志，不影响服务启动；部署路径不同时用 `SANDBOX_CONSOLE_DIST` 覆盖 |
| 接口文档 | `src/sandbox_platform/API.md` 的「二期 HTTP 接口」章节；运行时的交互式文档在 `/docs` |
| 常驻方式 | `server/sandbox-console.service` 是 systemd 单元模板，只提供模板，不自动安装、不自动启用 |

```bash
# 沙箱管理接口（示例）
curl -s http://127.0.0.1:8000/api/sandboxes
curl -s -X POST -H 'Content-Type: application/json' \
    -d '{"name":"demo","image_source":"host","image":"my-local/app:dev"}' \
    http://127.0.0.1:8000/api/sandboxes
```

创建入参多了一个可选字段 `image_source`：默认 `auto`（一期行为，镜像缺失时经镜像代理拉取），
`host` 表示强制从宿主导出注入（宿主没有该镜像直接报错，不经镜像代理），供网页选用宿主本地镜像。
命令行不传该字段，一期行为零变化。

## 运行前提

- 宿主已安装 Docker 与 `dockerd-rootless.sh`、`newuidmap`/`newgidmap`（`uidmap` 包）。
- 宿主操作（建用户、写 `/etc/subuid`、写用户单元、启停用户级守护进程）需要特权：进程本身是 root 时直接执行，否则走免密 `sudo`。
- 平台数据根目录默认 `/var/lib/sandbox-platform`，可用环境变量 `SANDBOX_PLATFORM_HOME` 重定向到可写路径。目录由平台用 `install -d` 创建，属主为首次创建它的那个用户；同一台机器请固定用同一种身份操作控制面。
- **统一镜像代理**：创建沙箱时平台会拉起代理容器（`rpardini/docker-registry-proxy:0.8.0`，宿主回环 `127.0.0.1:3128`）并做健康检查；代理不可达则创建直接失败，**不降级直连**。缓存与 CA 目录在 `<平台数据根>/registry-proxy/`。
- 镜像来源优先级：沙箱守护进程已有 → 平台自建镜像（`sandbox-platform/*`）由宿主导出注入 → 其余镜像由沙箱守护进程经统一镜像代理拉取（命中代理缓存）。平台不再维护任何离线镜像包。

## 沙箱容器启动约定

- 容器固定带 `-i` 启动：保持标准输入打开，镜像入口脚本里的交互式 shell（如基础镜像的 `exec bash -i`）才不会因标准输入关闭而立即退出。
- 需要自定义入口时用 `--command "…"`（命令行层用 `--entrypoint ""` 覆盖镜像入口，命令参数跟在镜像名之后）。

## 挂载契约

| 挂载 | 来源 | 平台是否处置宿主目录 |
|---|---|---|
| Docker 套接字（容器内 `/var/run/docker.sock`） | 平台固定 | 不适用 |
| `--mount 宿主路径:容器路径[:ro]` | 用户声明 | **不创建、不删除、不修改** |

用户声明的宿主路径命中敏感清单一律拒绝：`/etc`、`/proc`、`/sys`、`/dev`、`/boot`、`/root`、
宿主 Docker 套接字、平台数据根（默认 `/var/lib/sandbox-platform`），路径含逗号也拒绝
（Docker 的挂载参数以逗号分段）。

删除沙箱时平台只回收自己创建的资源：沙箱容器、依赖容器、网桥网络、守护进程与用户单元、系统用户与家目录、子 UID/GID 段、平台元数据。
删除前的提示清单会实时扫描守护进程网络上的容器并入清单（探测失败时标注「可能不完整」）；
用户通过 `--network` 指定的网络**只接入不回收**。
