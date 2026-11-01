# platform —— 沙箱平台控制面

一期交付：沙箱生命周期的可复用核心模块 + 薄壳命令行。

## 目录结构

| 路径 | 内容 |
|---|---|
| `src/sandbox_platform/` | 控制面核心模块（生命周期编排、用户与子 ID 段管理、镜像与挂载装配、元数据存储） |
| `src/sandbox_platform/API.md` | 各模块对外函数签名与参数表（含二期 HTTP 接口） |
| `src/sandbox_platform/server/` | 二期服务层：FastAPI 应用工厂、依赖注入、请求与响应模型、沙箱管理路由、宿主镜像与代理设置路由 |
| `cli/sandboxctl.py` | 命令行薄壳：只做参数解析、调用核心模块、打印结果 |
| `console/dist` | 网页控制台前端构建产物（由服务进程在 `/` 路径托管；目录不存在时跳过静态托管） |
| `server/sandbox-console.service` | systemd 单元模板（只提供模板，不自动安装、不自动启用） |
| `tests/` | 单元测试与宿主级测试（宿主级测试打 `root` 标记） |
| `base-image/rootless/` | 免 root 守护进程引导脚本（`common.sh` / `00-create-user.sh` / `01-start-dockerd.sh` / `04-cleanup.sh`），供 `base-image/verify-rootless.sh` 调用；建用户、起用户级守护进程、回收三步 |

**目录变更**

> `probe/`（一期任务 01 的打样探针目录，含 `probe/rootless/`）已于 2026-11-01 整体移除：终端探针验证的主链路已被二期网页终端覆盖；其中免 root 引导四脚本是活依赖，已迁到 `base-image/rootless/`，判定脚本 `verify-rootless.sh` 的指向同步更新，判定能力不变。

> `scripts/`（一期任务 04 的冒烟脚本目录，含 `scripts/smoke-lifecycle.sh`）已于 2026-11-01 整体移除：该脚本跑的是「创建 → 关闭 → 启动 → 删除 → 回收校验」，同一链路已由宿主级 pytest 用例 `tests/test_root_lifecycle.py::test_full_lifecycle_create_stop_start_delete` 覆盖，脚本不再单独维护。

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
uv sync --all-groups                      # 安装依赖（含 fastapi、uvicorn、websockets）
uv run python -m sandbox_platform.server   # 启动服务
```

| 项 | 说明 |
|---|---|
| 监听地址 | 默认 `127.0.0.1:8000`；用环境变量 `SANDBOX_CONSOLE_HOST` / `SANDBOX_CONSOLE_PORT` 覆盖 |
| **只绑回环地址** | 服务不做认证与多用户，允许改成内网地址，**不得暴露公网**；绑非回环地址时启动会打醒目告警 |
| 平台数据根 | 仍走 `SANDBOX_PLATFORM_HOME`（默认 `/var/lib/sandbox-platform`），与命令行一致 |
| 权限要求 | 与一期命令行一致：进程本身是 root 时直接执行，否则走免密 `sudo` |
| 前端托管 | `console/dist` 由同一进程在 `/` 路径托管；目录不存在时跳过静态托管并告警（`/api/health` 的 `console_mounted` 为 false），不影响服务启动；部署路径不同时用 `SANDBOX_CONSOLE_DIST` 覆盖 |
| 网页终端 | WebSocket 端点需要 `websockets` 库（uvicorn 的 WebSocket 实现）；未安装时握手会被拒（HTTP 404），终端会话建得起来但连不上 |
| 接口文档 | `src/sandbox_platform/API.md` 的「二期 HTTP 接口」章节；运行时的交互式文档在 `/docs`，**默认关闭**，需要时用 `SANDBOX_CONSOLE_DOCS=1` 开启 |
| 错误响应 | 统一 `{"detail": "中文消息"}`；400 / 404 / 409 保留平台异常原文，500 只回「平台内部错误，请查看服务日志」（原文只进日志，不回显宿主路径） |
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

### 宿主镜像与代理设置接口

```bash
# 实时枚举宿主本地镜像（创建页下拉的选项来源）
curl -s http://127.0.0.1:8000/api/images

# 镜像代理状态（容器 / 健康 / 缓存占用 / 证书就绪 / 访问地址）
curl -s http://127.0.0.1:8000/api/proxy/status

# 重启镜像代理（CA 指纹变了会自动为已有沙箱用户重装合并 CA 束）
curl -s -X POST http://127.0.0.1:8000/api/proxy/restart
```

| 项 | 说明 |
|---|---|
| 镜像枚举 | 实时列出宿主本地镜像（含用户自己本地构建、任何仓库都没有的镜像）；悬空镜像不进列表；**不提供网页拉取镜像的接口** |
| 代理状态 | 代理没起来不是错误：接口如实回报「不健康」与明细，页面只展示，不报错；状态查询永不抛异常（宿主命令失败或超时都降级成「不健康 + 明细」） |
| 代理重启 | 重启后轮询到健康才返回成功；**代理不可达不降级直连**（与一期一致），失败时 `restarted=false`，原因看服务日志。挂载与当前配置不一致时删除后按首次启动路径重建容器 |
| CA 指纹比对 | 代理 CA 变了自动为已有沙箱用户重装合并 CA 束，响应里回传 `ca_changed`、`ca_reinstalled` 与 `reinstalled_users`；重装失败的用户进 `failed_users` |
| CA 指纹口径 | 变更前后都读得到证书才算「变了」（读不到不等于变了）；指纹对内容做空白归一化后哈希，换行差异不算变更 |
| 缓存只增不减 | **不提供清理代理缓存的接口**，页面只展示占用大小 |

> `POST /api/proxy/restart` 是**未认证的特权端点**：服务只绑回环地址，但本机任意进程都能调用它，反复重启会打断正在拉镜像的沙箱。不要把服务改成监听公网或不受控的内网地址。

## 运行前提

- 宿主已安装 Docker 与 `dockerd-rootless.sh`、`newuidmap`/`newgidmap`（`uidmap` 包）。
- 宿主操作（建用户、写 `/etc/subuid`、写用户单元、启停用户级守护进程）需要特权：进程本身是 root 时直接执行，否则走免密 `sudo`。
- 以沙箱用户身份执行命令时：非 root 走免密 `sudo`；**进程本身是 root 时走 `setpriv`**（`util-linux` 自带，宿主需已安装）切换身份——root 环境下 `sudo` 未必存在。
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
