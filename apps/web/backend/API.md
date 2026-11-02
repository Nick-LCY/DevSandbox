# 控制面核心模块接口

一期由 `apps/cli/sandboxctl.py` 调用；二期将由**同一批模块**暴露为 FastAPI 路由，行为与一期等价。

约定：

- 核心模块只返回数据与抛异常，不做参数解析、不直接输出。
- 所有宿主特权操作通过 `Privilege` 包装：进程本身是 root 时直接执行，否则走免密 `sudo`。
- 以某个系统用户身份执行命令时，前缀按运行身份分两种（行为等价）：
  非 root 走 `sudo -n -u <用户>`；进程本身是 root 走 `setpriv --reuid <uid> --regid <gid> --clear-groups`
  （root 环境下 `sudo` 未必存在，省掉前缀会产出非法命令行）。
- 数据根目录由环境变量 `SANDBOX_PLATFORM_HOME` 决定，默认 `/var/lib/sandbox-platform`。

---

## 1. `config.py` —— 平台配置

### `PlatformConfig`

冻结数据类，字段如下。

| 字段 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `home` | `Path` | `/var/lib/sandbox-platform` | `SANDBOX_PLATFORM_HOME` | 平台数据根目录 |
| `user_prefix` | `str` | `sandbox` | `SANDBOX_PLATFORM_USER_PREFIX` | 沙箱系统用户名前缀 |
| `subid_base` | `int` | `100000` | `SANDBOX_PLATFORM_SUBID_BASE` | 子 ID 段最小起点 |
| `subid_length` | `int` | `65536` | `SANDBOX_PLATFORM_SUBID_LENGTH` | 子 ID 段长度 |
| `socket_mount_path` | `str` | `/var/run/docker.sock` | `SANDBOX_PLATFORM_SOCKET_MOUNT` | 套接字在容器内的路径 |
| `proxy_image` | `str` | `rpardini/docker-registry-proxy:0.8.0` | `SANDBOX_PLATFORM_PROXY_IMAGE` | 统一镜像代理镜像 |
| `proxy_port` | `int` | `3128` | `SANDBOX_PLATFORM_PROXY_PORT` | 代理在宿主回环上的监听端口 |
| `proxy_address` | `str` | `127.0.0.1` | `SANDBOX_PLATFORM_PROXY_ADDRESS` | 沙箱守护进程访问代理用的地址（见下注） |
| `proxy_registries` | `tuple[str, ...]` | `docker.io ghcr.io quay.io gcr.io registry.k8s.io` | `SANDBOX_PLATFORM_PROXY_REGISTRIES` | 代理拦截并缓存的仓库清单（空格分隔） |
| `system_ca_bundle` | `Path` | `/etc/ssl/certs/ca-certificates.crt` | `SANDBOX_PLATFORM_SYSTEM_CA_BUNDLE` | 宿主系统 CA 束（与代理 CA 合并成单个文件） |

> **默认镜像已退役**（镜像退役轮）：平台不再有默认沙箱镜像，`default_image` 字段与
> `SANDBOX_PLATFORM_IMAGE` 环境变量已彻底删除（不留环境变量口子）。创建沙箱必须
> 显式指定镜像；命令行的 `--image` 是必填参数，服务端缺 `image` 字段回 422。
>
> **镜像前缀机制已下线**：`local_image_prefixes` 字段与
> `SANDBOX_PLATFORM_LOCAL_IMAGE_PREFIXES` 环境变量已删除。镜像来源不再按命名前缀
> 判定，只看「宿主本地有没有这个镜像」这一条事实。

> 代理地址默认为 `127.0.0.1`：`dockerd-rootless.sh` 默认启用 `--detach-netns`，
> 免 root 守护进程进程本身留在宿主网络命名空间（只有容器在 slirp4netns 命名空间里），
> 所以守护进程用宿主回环地址访问代理；slirp 网关 `10.0.2.2` 只在沙箱容器内可达。
> 若宿主上把守护进程放进 slirp 命名空间运行，需把该地址改成 `10.0.2.2`。

| 函数 | 签名 | 说明 |
|---|---|---|
| 构造 | `PlatformConfig.from_env(env: dict[str, str] \| None = None) -> PlatformConfig` | 按环境变量装配并校验 |
| 覆盖 | `PlatformConfig.with_overrides(**kwargs) -> PlatformConfig` | 返回覆盖部分字段的新配置 |
| 校验 | `PlatformConfig.validate() -> None` | 非法取值抛 `ConfigError` |
| 路径 | `sandbox_root` / `lock_root` / `temp_root` / `proxy_root` / `proxy_cache_dir` / `proxy_ca_dir` / `sandbox_dir(name)` / `metadata_path(name)` | 数据目录布局 |
| 命名 | `system_user_name(sandbox_name: str) -> str` | 沙箱名 → 系统用户名 |
| 准备 | `ensure_directories() -> None` | 创建数据目录（幂等） |

---

## 2. `mounts.py` —— 挂载解析与容器参数

| 函数 | 签名 | 说明 |
|---|---|---|
| 解析单条 | `parse_mount_declaration(declaration: str, *, extra_forbidden: Iterable[str \| Path] = ()) -> MountSpec` | 解析 `宿主路径:容器路径[:ro]`；宿主路径必须已存在且是绝对路径，平台不代为创建；路径含逗号一律拒绝；命中敏感清单（`/etc` `/proc` `/sys` `/dev` `/boot` `/root`、宿主 Docker 套接字、追加项如平台数据根）一律拒绝（**先归一化再比对**：`/tmp/../etc` 绕不过去） |
| 解析多条 | `parse_mounts(declarations: list[str] \| tuple[str, ...] \| None, *, extra_forbidden: Iterable[str \| Path] = ()) -> list[MountSpec]` | 逐条解析并校验容器内路径不重复 |
| 敏感清单 | `sensitive_host_paths(extra: Iterable[str \| Path] = ()) -> tuple[str, ...]` | 固定敏感清单 + 调用方追加项（平台数据根由调用方追加） |
| 固定挂载 | `socket_mount(socket_path: str, container_path: str) -> MountSpec` | 平台唯一固定挂载（角色 `socket`） |
| 转参数 | `MountSpec.to_docker_args() -> list[str]` | 生成 `--mount type=bind,src=…,dst=…[,readonly]` |
| 拼参数 | `mounts_to_docker_args(mounts: list[MountSpec]) -> list[str]` | 多条挂载拼成一段参数 |
| 文本化 | `describe_mounts(mounts: list[MountSpec]) -> str` | 人类可读清单 |

`MountSpec` 字段：`host_path: str`、`container_path: str`、`read_only: bool`、`role: str`（`socket` / `user`）。

---

## 2bis. `files.py` —— 文件注入解析与副本准备

文件注入是「把宿主文件复制进沙箱」的机制：创建沙箱时声明 `宿主路径:容器路径`，
平台把宿主文件**复制**一份到沙箱用户家目录内的暂存目录，属主改成沙箱用户，
再以只读方式挂进容器。

**信任边界（两条口径）**：

- 注入源由平台**以特权身份读取**：控制台 / 命令行的调用者被视为平台受信主体，
  文件注入**不提供跨账号隔离**；
- 源路径不得位于**其他沙箱用户家目录**内（那是别的沙箱账号的家）。

| 函数 | 签名 | 说明 |
|---|---|---|
| 解析单条 | `parse_file_declaration(declaration: str, *, extra_forbidden: Iterable[str \| Path] = (), home_scope: SandboxHomeScope \| None = None) -> FileSpec` | 解析 `宿主路径:容器路径`（**固定两段**，没有读写标记段）；宿主路径必须是绝对路径、不得含逗号、不得命中敏感清单（与挂载同一套清单）；容器路径必须是绝对路径。**宿主路径先归一化再校验**（`/tmp/../etc/passwd` 绕不过敏感清单） |
| 解析多条 | `parse_file_declarations(declarations: Iterable[str], *, extra_forbidden: Iterable[str \| Path] = (), home_scope: SandboxHomeScope \| None = None) -> list[FileSpec]` | 逐条解析并做跨声明校验：宿主路径不得重复、容器内路径不得重复 |
| 家目录范围 | `SandboxHomeScope(user_prefix: str, home_root: Path \| None = None, exclude_home: Path \| None = None)` | 注入源的宿主范围限制：`user_prefix` 是平台沙箱用户名前缀（取自配置的 `user_prefix`），家目录名形如 `<前缀>-<沙箱名>`；`exclude_home` 是本次创建流程自己新建的那一个家目录（不算「其他」） |
| 家目录拒绝 | `reject_sandbox_user_home(path: str \| Path, scope: SandboxHomeScope) -> None` | 注入源落在其他沙箱用户家目录内时拒绝（家目录根下以 `<前缀>-` 开头的现有目录） |
| 暂存目录 | `staging_root(home: str \| Path) -> Path` | 暂存目录：`<沙箱用户家目录>/.sandbox-files` |
| 副本路径 | `staged_path(home: str \| Path, index: int, host_path: str \| Path) -> Path` | 单个副本：`<暂存目录>/<序号>-<原件名>`（原件名取不到时兜底为 `file`） |
| 宿主探测 | `probe_host_path(privilege: Privilege, path: str) -> str` | 特权探测宿主路径：返回 `f`（普通文件）或 `d`（目录）；先 `find -printf %y` 判类型（悬空符号链接判「符号链接」而非「不存在」），命令失败才报不存在；路径是符号链接、目录里有符号链接、目录里有 FIFO / 设备 / 套接字，一律报错 |
| 副本准备 | `stage_file_copies(specs: list[FileSpec], *, user: SystemUser, privilege: Privilege) -> list[MountSpec]` | 清掉既有暂存目录 → 建暂存目录 → 逐条**复探类型后**复制 → 改属主（uid / gid 数值）→ 目录 0700 → 文件 0600；任一步失败先删暂存目录再抛原异常 |

`FileSpec` 字段：`host_path: str`、`container_path: str`。

四条口径：

| 口径 | 说明 |
|---|---|
| 暂存目录 | 副本落在沙箱用户家目录内的 `.sandbox-files` 目录（属主沙箱用户、权限 0700），**随沙箱删除时的家目录回收一起消失**，停止 / 启动期间保留 |
| 权限位 | 副本文件 0600、副本目录 0700，属主与主组都是沙箱用户（用 uid / gid 数值设置，不依赖「主组与用户同名」）；原件的权限位、属主、内容、mtime 一律不变（**原件零接触**） |
| 只读挂载 | 副本以 `readonly` 方式挂进容器，容器内一律不可写，也不支持容器写回宿主 |
| 不走可读性预检 | 用户声明挂载要过「宿主路径对沙箱用户可读且可穿过」那道预检，文件注入**不走**它——副本属主就是沙箱用户，那道预检对注入没有意义。符号链接一律拒绝（既不跟随、也不复制链接本身） |

三条边界：

| 边界 | 说明 |
|---|---|
| 源路径范围 | 注入源不得落在**其他沙箱用户家目录**内（家目录根下以平台沙箱用户名前缀开头的现有目录）；命中即拒绝，文案为「注入的宿主路径落在其他沙箱用户家目录内，不允许注入：{路径}」 |
| 非常规文件 | 注入的目录里含 FIFO / 设备 / 套接字时拒绝（复制它们在容器里没有意义，读 FIFO 还会阻塞）；文案为「注入的宿主目录里含非常规文件（FIFO/设备/套接字），不支持注入：{条目}」 |
| 启动前副本存在性 | 启动沙箱前逐条特权探测副本还在不在：副本没了（家目录被清理）直接报「注入文件副本已不存在，无法启动沙箱：{路径}」，不让 Docker 静默建一个空目录挂进容器 |

> 复制是**创建时快照**：宿主原件之后的变更不会回灌到沙箱，要新鲜内容就重建沙箱。

---

## 3. `metadata.py` —— 沙箱元数据

### `SandboxMetadata`

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `str` | 沙箱名 |
| `system_user` / `uid` / `gid` / `home` | `str` / `int` / `int` / `str` | 沙箱专属用户 |
| `subid_start` / `subid_length` | `int` | 子 UID/GID 段 |
| `image` | `str` | 沙箱镜像 |
| `socket_path` / `socket_mount_path` | `str` | 宿主套接字路径 / 容器内挂载点 |
| `container_name` / `container_id` / `network_name` | `str` | 沙箱容器与网桥网络 |
| `unit_path` | `str` | systemd 用户单元路径 |
| `state` | `str` | `running` / `stopped` / `deleted` |
| `network_owned` | `bool` | 网络是否平台自建：`False` 表示用户指定，只接入不回收 |
| `mounts` | `list[MountSpec]` | 用户声明挂载 |
| `files` | `list[MountSpec]` | 注入文件的只读副本挂载（**不进** `mounts`：那一份是「平台不回收」的口径，注入副本随家目录回收） |
| `dependency_containers` | `list[str]` | 已知依赖容器名 |
| `command` / `env` / `workdir` | `list[str]` / `dict[str, str]` / `str` | 容器启动参数（重启时复用） |
| `created_at` / `updated_at` | `str` | 时间戳 |

### `MetadataStore`

| 函数 | 签名 | 说明 |
|---|---|---|
| 构造 | `MetadataStore(config: PlatformConfig)` | 仓库入口 |
| 路径 | `root` / `sandbox_dir(name)` / `path_for(name)` | 元数据目录布局；`sandbox_dir` 带兜底断言：沙箱名不得含路径分隔符 |
| 写入 | `save(metadata: SandboxMetadata) -> Path` | 原子写入 `<home>/sandboxes/<name>/metadata.json`，文件权限 `0600` |
| 读取 | `load(name: str) -> SandboxMetadata \| None` | 不存在返回 `None` |
| 列表 | `list_all() -> list[SandboxMetadata]` | 按名称排序，损坏文件跳过 |
| 删除 | `delete(name: str) -> bool` | 删除整个沙箱元数据目录 |

---

## 4. `userspace.py` —— 系统用户与子 ID 段

| 函数 | 签名 | 说明 |
|---|---|---|
| 分配空闲段 | `pick_free_range(ranges: list[tuple[int, int]], base: int, length: int) -> int` | 纯函数：挑一段不重叠的区间起点 |
| 特权前缀 | `Privilege.prefix()` / `Privilege.wrap(argv)` | 宿主特权命令前缀：进程本身是 root 时直接执行，否则走免密 `sudo` |
| 身份切换前缀 | `Privilege.user_prefix(user: str, uid: int, gid: int) -> list[str]` | 「切到某个系统用户」的前缀：非 root 是 `sudo -n -u <用户>`；进程本身是 root 是 `setpriv --reuid <uid> --regid <gid> --clear-groups`（root 环境下 `sudo` 未必存在，省掉前缀会产出非法命令行） |
| 用户查询 | `UserSpaceManager.lookup_user(name: str) -> SystemUser \| None` | 读 uid/gid/家目录 |
| 用户存在 | `UserSpaceManager.user_exists(name: str) -> bool` | — |
| 建用户 | `UserSpaceManager.ensure_user(name: str) -> SystemUser` | 已存在则沿用（返回值的 `created=False`）；新建带家目录（`created=True`）。**只有 `created=True` 的用户允许进回滚清单** |
| 登记段 | `UserSpaceManager.allocate_subid_range(user_name: str) -> SubIdRange` | 动态分配不重叠段，写入 `/etc/subuid` 与 `/etc/subgid`；已有合规段则沿用（文件锁保护并发） |
| 回收段 | `UserSpaceManager.remove_subid_range(user_name: str) -> bool` | 清除两个文件里的条目；与分配路径共用 `subid.lock`，读—改—写整段在临界区内 |
| 读条目 | `UserSpaceManager.read_subid_entries(user_name: str) -> dict[str, tuple[int, int]]` | 只读查询 |
| 写单元 | `UserSpaceManager.write_docker_unit(user: SystemUser) -> Path` | 写 `~/.config/systemd/user/docker.service`（含 `Delegate=yes` 与 `--rootless`），目录与文件属主必须是沙箱用户 |
| 单元内容 | `UserSpaceManager.render_unit(user: SystemUser) -> str` | 纯函数：渲染单元文本 |
| 保活 | `enable_linger(user_name) -> bool` / `disable_linger(user_name) -> bool` | `loginctl enable-linger` |
| 保活状态 | `UserSpaceManager.linger_state(user_name: str) -> bool \| None` | 查 linger 是否开启；查不到返回 `None` |
| 终止会话 | `UserSpaceManager.terminate_user(user_name: str, uid: int \| None = None) -> bool` | 删用户前必须先做；返回**真实结果**：进程全部退出才为 `True`。常规终止超时后升级处置（停 `user@<uid>.service` → `kill -9` 残留进程） |
| 等待回收 | `UserSpaceManager.wait_for_runtime_gone(uid: int, timeout: int = 30) -> bool` | 等 `/run/user/<uid>` 消失，避免 uid 复用竞态 |
| 删用户 | `UserSpaceManager.remove_user(user: SystemUser, remove_home: bool = True) -> bool` | 终止会话 → `userdel -r` → 兜底清家目录；返回 `True` 表示用户与家目录都已回收，进程未清空时保留家目录并返回 `False` |

`SystemUser` 字段：`name`、`uid`、`gid`、`home`、`created`（本次是否新建）；派生属性 `runtime_dir`（`/run/user/<uid>`）、`socket_path`。
`SubIdRange` 字段：`start`、`length`；派生属性 `end`、`spec`。

---

## 5. `daemon.py` —— 用户级守护进程与容器操作

`UserContext`：`user`、`uid`、`gid`、`home`；派生 `runtime_dir`、`socket_path`、`env()`。

`UserDaemon(context: UserContext, privilege: Privilege | None = None)` 全部方法都以沙箱用户身份执行：非 root 走 `sudo -n -u <用户> env -i …`，进程本身是 root 走 `setpriv --reuid <uid> --regid <gid> --clear-groups env -i …`；两种形态都带 `XDG_RUNTIME_DIR` 与 `DOCKER_HOST`。

| 方法 | 签名 | 说明 |
|---|---|---|
| 执行 | `run_as_user(argv, *, check=False, timeout=300) -> CommandResult` | 以沙箱用户身份执行任意命令 |
| 用户级 systemd | `systemctl(args, *, check=False, timeout=120) -> CommandResult` | `systemctl --user …` |
| 重试 | `systemctl_retry(args, *, attempts=5, delay=1.0) -> CommandResult` | 用户级管理器未就绪时重试（默认最多 5 次） |
| 守护进程状态 | `is_active() -> bool` / `is_enabled() -> bool` / `socket_ready() -> bool` | — |
| 等待 | `wait_for_runtime_dir(timeout=60) -> bool` / `wait_for_socket(timeout=90) -> bool` | — |
| 用户管理器 | `ensure_user_manager(timeout=120) -> CommandResult` | 从系统级显式启动 `user@<uid>.service`（带 `--no-block`，不阻塞等待就绪），规避 uid 复用时的启动竞态 |
| 单元动作 | `daemon_reload()` / `enable_daemon()` / `disable_daemon()` / `start_daemon()` / `stop_daemon()` / `restart_daemon()` | 返回 `CommandResult`；`start_daemon` 带 `--no-block`，就绪判定统一交给 `wait_for_socket` |
| 镜像 | `image_exists(image) -> bool` / `pull_image(image) -> CommandResult` / `load_image(tar_path) -> CommandResult` / `image_id(image) -> str \| None` | — |
| 容器 | `container_exists(name) -> bool` / `container_id(name) -> str \| None` / `container_running(name) -> bool` / `list_containers(all_containers=True) -> list[dict]` | — |
| 网络容器 | `containers_on_network(network) -> list[str] \| None` | 探测失败返回 `None`（与「确实没有容器」区分开），调用方据此判断清单是否完整 |
| 起容器 | `run_container(*, name, image, mounts, network=None, command=None, env=None, labels=None, workdir=None) -> CommandResult` | `docker run -d -i`；给了 `command` 时用 `--entrypoint ""` 覆盖镜像入口；`-i` 保持标准输入打开，镜像入口里的交互式 shell 才不会立即退出 |
| 停删容器 | `stop_container(name)` / `start_container(name)` / `remove_container(name, force=True)` | — |
| 容器内执行 | `exec_in_container(name, argv, *, check=False, timeout=120) -> CommandResult` | — |
| 网络 | `network_exists(name) -> bool` / `create_network(name)` / `remove_network(name)` / `connect_network(name, network)` | — |
| 路径可见性 | `can_access_path(path) -> bool` | 宿主路径对沙箱用户是否可读可穿过 |
| 伪终端 | `exec_pty(argv, *, cols=80, rows=24) -> PtyProcess` | 以沙箱用户身份在伪终端里执行命令（复用 `user_argv` 的执行身份与环境变量） |
| 容器内交互式 shell | `exec_pty_shell(container, *, session_id, cols=80, rows=24, shell="bash") -> PtyProcess` | 容器内进程拿到真实 TTY；会话标识同时注入容器内环境变量与宿主侧进程命令行 |
| 容器内 shell | `container_shell(name) -> str` | 探测容器内可用的交互式 shell（优先 `bash`，退回 `sh`） |

---

## 6. `images.py` —— 镜像可用性

平台不再维护离线镜像包（ADR 0008）：沙箱免 root 守护进程自己的 `docker pull`
经统一镜像代理完成，平台只管两条路径。

| 函数 | 签名 | 说明 |
|---|---|---|
| 枚举宿主镜像 | `ImageManager.list_host_images() -> list[HostImage]` | 实时枚举宿主 root 守护进程里的本地镜像（含用户自己本地构建、任何仓库都没有的镜像）；悬空镜像（`<none>:<none>`）不进列表；结果按镜像引用排序 |
| 保证可用 | `ImageManager.ensure_image(image: str, daemon: UserDaemon) -> str` | 顺序：沙箱守护进程已有 → 交由沙箱守护进程经统一镜像代理拉取（缓存命中走本地）→ 代理拉取失败且宿主本地有该镜像则由宿主导出注入 → 两条途径都失败抛 `ImageNotFoundError`（文案说明两种途径均失败，**不降级直连**）；返回来源标记（`present` / `remote` / `injected`）。**不再按命名前缀判定**（前缀机制已下线） |
| 按来源准备 | `ImageManager.ensure_image_from_source(image: str, daemon: UserDaemon, source: str = "auto", *, require_host_image: bool = True) -> str` | `auto` 同上；`host` 强制从宿主注入（见下方「镜像来源的判定语义」）；非法来源抛 `ValidationError`，**不静默降级成 auto** |
| 镜像引用摘要 | `image_digest(image: str) -> str` | 镜像引用的 sha256 前 16 位；注入中转归档的文件名用它（按字符替换分隔符会让 `a/b:1` 与 `a_b:1` 撞名） |
| 宿主镜像 | `ImageManager.host_image_exists(image: str) -> bool` | 宿主 root 守护进程里是否已有该镜像 |
| 导出注入 | `ImageManager.inject_from_host(image: str, daemon: UserDaemon) -> str` | `docker save` → `docker load` 注入沙箱守护进程，失败抛 `ImageError` |

`HostImage` 字段：`reference`（`仓库:标签` 形式的镜像引用）、`image_id`（镜像 ID）、`size_bytes`（体积，字节）、`created_at`（创建时间，RFC 3339 文本，取不到时为空串）。

#### 镜像来源的判定语义

`host` 模式的「宿主必须有该镜像」要求分两条路径：

| 路径 | 调用 | 判定 |
|---|---|---|
| 创建 | `ensure_image_from_source(..., "host")`（`require_host_image=True`） | 宿主必须有该镜像，否则抛 `ImageNotFoundError`；**不经镜像代理拉取** |
| 启动 | `ensure_image_from_source(..., "host", require_host_image=False)` | 沙箱守护进程里已有该镜像就直接用（宿主镜像已删、守护进程还在时仍能启动）；守护进程里没有时才把宿主副本作为注入源；两边都没有则报 `ImageNotFoundError` |

---

## 6bis. `proxy.py` —— 统一镜像代理

代理用上游项目 `rpardini/docker-registry-proxy`（版本钉在 0.8.0），以宿主 root
守护进程容器方式运行，监听宿主回环 `127.0.0.1:3128`；缓存与 CA 目录落在
`<home>/registry-proxy/` 下（`SANDBOX_PLATFORM_HOME` 重定向时跟随）。

| 函数 | 签名 | 说明 |
|---|---|---|
| 容器名 | `proxy_container_name(port: int) -> str` | 默认端口用固定名 `sandbox-platform-registry-proxy`，其它端口加后缀避免抢端口 |
| CA 束路径 | `ca_bundle_path(user_home: str \| Path) -> Path` | 沙箱用户家目录里「系统 CA 束 + 代理 CA」合并文件的路径 |
| 构造 | `RegistryProxyManager(config: PlatformConfig \| None = None, privilege: Privilege \| None = None)` | 代理管理入口 |
| 目录 | `ensure_directories() -> None` | 创建缓存目录与 CA 目录（幂等） |
| 镜像 | `ensure_image() -> bool` | 宿主上无代理镜像时拉取一次（首启自动拉取） |
| 拉起 | `ensure_running(timeout: int = 120) -> bool` | 幂等拉起并等到健康；并发调用由文件锁串行化；失败返回 `False`（**调用方必须直接失败，不降级直连**） |
| 重启 | `restart(timeout: int = 120) -> bool` | 容器存在则重启（**挂载与当前配置不一致时删除后按首次启动路径重建**），不存在则先拉起，随后轮询健康检查直到通过；失败返回 `False` 并把原因写进 `last_error`（**不做降级直连**）；与 `ensure_running` 共用同一把文件锁 |
| 容器状态 | `container_status() -> ProxyContainerStatus` | 容器是否存在 / 是否运行中 |
| 缓存占用 | `cache_size_bytes() -> int` | 缓存目录占用字节数；目录不存在按 0 计，统计失败只记日志并返回 0（`du` 超时按 30 秒封顶，路径用 `--` 隔开） |
| 证书就绪 | `certificate_ready() -> bool` | 代理 CA 证书是否存在且可读 |
| 完整状态 | `status() -> ProxyStatus` | 容器状态 + 健康状态 + 缓存占用 + 证书就绪 + 代理访问地址（设置页展示用）；**永不抛异常**：宿主命令失败、命令超时、证书读不出来都降级成「不健康 + 明细」，状态接口不会变成 500 |
| CA 指纹 | `ca_cert_digest() -> str` | 代理 CA 证书内容的 sha256 前 16 位（**先做空白归一化再哈希**，换行差异不算变更）；取不到证书时返回空串 |
| 健康 | `probe() -> ProxyProbe` / `health_check() -> bool` | TCP 可连 + 能从 `http://127.0.0.1:<port>/ca.crt` 取到证书才算健康 |
| CA | `read_ca_certificate() -> str` / `read_system_ca_bundle() -> str` | 读代理 CA / 系统 CA 束，缺失或不是合法 UTF-8 文本时抛 `ProxyError` |
| 合并 CA 束 | `install_ca_bundle(user: SystemUser) -> Path` | 「系统 CA 束 + 代理 CA」合并成单个文件，装到沙箱用户家目录（属主沙箱用户、权限 0644） |
| 权限 | `harden_ca_permissions() -> None` | CA 私钥 `0600`、证书 `0644` |
| 停止/删除 | `stop() -> bool` / `remove() -> bool` | 停止 / 删除代理容器（缓存与 CA 目录保留） |

`ProxyProbe` 字段：`tcp`、`http`、`detail`；属性 `healthy`。

`ProxyContainerStatus` 字段：`exists`、`running`。

`ProxyStatus` 字段：`container`（`ProxyContainerStatus`）、`healthy`、`tcp_ok`、`ca_fetchable`、`detail`（健康明细）、`cache_size_bytes`、`certificate_ready`、`proxy_url`。

---

## 7. `lifecycle.py` —— 生命周期编排

### 数据类

| 名称 | 字段 | 说明 |
|---|---|---|
| `CreateRequest` | `name`、`image`（**必填**）、`mount_declarations=()`、`files=()`、`command=None`、`env={}`、`workdir=None`、`network_name=None`、`image_source="auto"` | 创建入参；**镜像必填**：默认镜像已退役，平台没有兜底镜像；`files` 是文件注入声明（`宿主路径:容器路径`） |
| `CreateResult` | `metadata`、`connection`、`steps` | 创建结果；`steps` 是固定 7 步名称 |
| `ConnectionInfo` | `socket_path`、`container_name`、`exec_command`、`docker_command`、`notes` | 连接方式与命令提示（身份切换前缀与实际执行同源：非 root 是 `sudo -u`，root 是 `setpriv`） |
| `ReclaimPlan` | `sandbox_name`、`items`、`untouched_note`、`user_mounts`、`incomplete` | 删除前的回收清单；`untouched_note` 固定为「用户挂载的宿主机目录不受影响」；依赖容器清单 = 元数据已知列表 ∪ 删除前实时扫描，探测失败时保留旧列表并置 `incomplete=True` |
| `DeleteResult` | `name`、`existed`、`removed`、`failed`、`plan` | 删除结果；沙箱不存在时 `existed=False` 且不抛异常；`removed` 是确实回收掉的资源，`failed` 是尝试过但没成功的条目（带原因） |
| `ProxyRestartResult` | `success`、`ca_changed`、`message`、`reinstalled_users`、`failed_users`、`ca_reinstalled` | 重启结果；`ca_changed` 的口径见 11.5；`ca_reinstalled` 表示合并证书链**确实重装过**（CA 变了但新 CA 读不到时为 `False`，不把未修复报成已修复）；`failed_users` 是重装失败的用户（单个用户失败不阻断其余用户） |

### `SandboxService`

| 方法 | 签名 | 说明 |
|---|---|---|
| 构造 | `SandboxService(config: PlatformConfig \| None = None, privilege: Privilege \| None = None)` | 控制面服务入口 |
| 查询 | `find(name) -> SandboxMetadata \| None` | 不存在返回 `None`；先过沙箱名校验 |
| 查询 | `get(name) -> SandboxMetadata` | 不存在抛 `NotFoundError`；先过沙箱名校验 |
| 列表 | `list() -> list[SandboxMetadata]` | 尽力刷新运行状态（用户已删 → `deleted`） |
| 创建 | `create(request: CreateRequest) -> CreateResult` | 固定 7 步，任一步失败回滚已完成步骤；同名创建串行化并原子占用名字 |
| 启动 | `start(name: str) -> SandboxMetadata` | 复用同一用户、同一子 ID 段、同一守护进程单元；只恢复沙箱容器，依赖容器由使用方自行拉起 |
| 关闭 | `stop(name: str, stop_dependencies: bool = True) -> SandboxMetadata` | 依赖容器是否一并停止由显式参数控制，默认停 |
| 回收清单 | `reclaim_plan(name: str) -> ReclaimPlan` | 删除前展示用 |
| 删除 | `delete(name: str) -> DeleteResult` | 按固定回收清单回收，幂等 |
| 宿主镜像 | `list_host_images() -> list[HostImage]` | 实时枚举宿主本地镜像（创建页下拉用）；悬空镜像不进列表 |
| 代理状态 | `proxy_status() -> ProxyStatus` | 代理的容器状态、健康状态、缓存占用、证书就绪与访问地址 |
| 代理重启 | `restart_proxy(timeout: int = 120) -> ProxyRestartResult` | 重启代理并等健康；重启后比对代理 CA 指纹，变了就为已有沙箱用户重装合并 CA 束；`ca_changed` 的口径与 `ca_reinstalled` / `failed_users` 的含义见 11.5 |

### 同名沙箱的互斥与名字占用

同名沙箱的 `create` / `start` / `stop` / `delete` 在进程内**按名串行化**：
并发创建同名沙箱会并行建同一套用户、子 ID 段与容器，后到者的回滚会删掉先到者
已跑起来的沙箱。串行化在核心包内完成（进程内互斥锁字典），命令行与服务端共用。

「占用沙箱名」是原子操作：占位文件 ``<平台数据根>/locks/<沙箱名>.lock`` 用
`O_EXCL` 落（并发时只有一个能占住，另一个直接拿到「沙箱已存在」）。
占位文件在创建失败时回收，创建成功后保留（名字随沙箱一起被占用），
删除沙箱时释放；创建中断留下的残留占位会被下一次创建接管。

### 创建的 7 步与回滚

| 步 | 动作 | 失败回滚 |
|---|---|---|
| ① | 创建专属系统用户 | 删除用户与家目录（**仅本次新建的用户**进回滚清单） |
| ② | 登记子 UID/GID 段 | 清除 `/etc/subuid`、`/etc/subgid` 条目 |
| ③ | 写 systemd 用户单元、开启 linger、启动守护进程 | 停用并删除单元、关闭 linger（回滚动作在写单元后立刻登记，启动失败也会回滚） |
| ④ | 解析用户声明挂载（校验宿主路径存在、容器路径绝对、套接字路径不被占用、宿主路径对沙箱用户可见） | 无宿主副作用，无需回滚 |
| ⑤ | 准备镜像与网络，启动沙箱容器（挂载套接字、用户声明挂载与注入文件副本） | 删除容器与网络 |
| ⑥ | 写入沙箱元数据 | 删除元数据 |
| ⑦ | 组装连接方式与命令提示 | 无 |

文件注入是 7 步之外的**旁路一步**（步骤名「注入文件副本」，不进上面的步骤清单）：
排在第 ④ 步之后、第 ⑤ 步之前，把声明的宿主文件复制成沙箱用户家目录里的副本并
只读挂载；它失败时回滚动作是删掉整个暂存目录（**只有真复制了副本才登记**这个
回滚动作：没有副本时删暂存目录会误伤同一账号上上一轮留下的东西）。

启动路径把注入副本一并挂回之前，先逐条特权探测副本还在不在：副本没了直接报
「注入文件副本已不存在，无法启动沙箱：{路径}」，不让 Docker 静默建一个空目录
挂进容器。

### 创建前置：统一镜像代理

创建流程在**任何宿主改动之前**先做代理预检（不计在 7 步里）：

1. `RegistryProxyManager.ensure_running()` —— 幂等拉起代理容器并等健康（首次会拉一次代理镜像）；
2. 健康检查不通过 → 直接抛 `LifecycleError`（步骤名「准备镜像代理」），**不降级直连**；
3. 用户创建之后、守护进程启动之前，把「系统 CA 束 + 代理 CA」合并文件装到沙箱用户家目录
   （`~/.config/sandbox-platform/registry-proxy-ca-bundle.crt`，属主沙箱用户、权限 0644）。

沙箱守护进程的 systemd 单元由此拿到三个代理环境变量与合并 CA 束路径，
沙箱内 `docker pull` 自动经代理并命中缓存。

删除的固定回收清单：沙箱容器与依赖容器 → 网桥网络（仅平台自建）→ 停止并禁用 systemd 用户单元 → 删除用户与家目录 → 回收子 UID/GID 段 → 删除平台元数据。
**用户声明挂载的宿主机目录一律不触碰**（平台不创建、不删除、不修改）。

### 镜像来源：`image_source`

`CreateRequest.image_source` 是**可选**字段，默认 `auto`，命令行不传该字段，**一期行为零变化**。

| 取值 | 语义 | 准备镜像的路径 |
|---|---|---|
| `auto`（默认） | 先走代理，失败再回退宿主 | 沙箱守护进程已有 → 交给沙箱守护进程经统一镜像代理拉取（缓存命中走本地）→ 代理拉取失败且宿主本地有该镜像则由宿主导出注入 → 两条途径都失败直接报错（**不降级直连**） |
| `host` | 强制从宿主导出注入 | 创建路径：宿主没有该镜像直接报错（`ImageNotFoundError`），**不经镜像代理拉取**；宿主有则 `docker save` → `docker load` 注入沙箱守护进程（守护进程里已有时跳过重复注入）。启动路径：守护进程里已有就直接用，宿主副本只在守护进程缺失时作为注入源（见 `images.py` 章节） |

> `auto` 分支的判定只看「宿主本地有没有这个镜像」，**不再按镜像命名前缀区分**
> 「平台自建镜像」——前缀机制已下线，`sandbox-platform/` 前缀不再有任何特殊含义。
>
> `auto` 的顺序是「先代理、后宿主回退」：一切外部镜像统一经统一镜像代理拉取，
> 宿主上恰好存在的公共镜像也走代理（不绕过代理缓存）；宿主导出注入实际只对
> 本地构建镜像（不在任何仓库）生效——这类镜像代理必然拉不到，只能回退注入。

`host` 模式与 `auto` 模式都在创建第 ⑤ 步准备镜像时执行；`host` 强制从宿主注入，
因此不经镜像代理。该来源随沙箱元数据一起落盘（`SandboxMetadata.image_source`），
`start` 时按同一来源准备镜像（启动路径不强制要求宿主镜像），
旧的元数据文件没有该字段时按 `auto` 处理。非法取值直接报错，不静默降级。

### 入参校验

| 函数 | 说明 |
|---|---|
| `validate_sandbox_name(name)` | 沙箱名整串匹配（`[a-z0-9][a-z0-9_-]{0,23}`），`find` / `get` / `reclaim_plan` / `create` / `start` / `stop` / `delete` 七个入口统一先校验 |
| `validate_image_name(image)` | 镜像名字符集限制（字母数字与 `. _ - / : @`） |
| `require_image_name(image)` | 镜像名必填校验：缺失或空串直接抛 `ValidationError`（「必须显式指定沙箱镜像（默认镜像已退役）」），再走字符集校验 |
| `validate_network_name(name)` | 网络名字符集限制（字母数字与 `. _ -`） |
| `validate_env_pairs(env)` | 环境变量键白名单 `^[A-Za-z_][A-Za-z0-9_]*$` |
| `validate_image_source(source)` | 镜像来源只允许 `auto` / `host`，创建前干跑校验（非法取值不留下宿主副作用） |
| `validate_system_user_name(name)` | 系统用户名白名单（会进 `sudo -u` 等特权命令） |

---

## 8. `command.py` —— 宿主命令封装

| 函数 | 签名 | 说明 |
|---|---|---|
| 执行 | `run(argv, *, env=None, check=False, timeout=300, cwd=None, stdin_text=None) -> CommandResult` | 超时或命令不存在抛 `CommandError`；日志与异常消息里的命令行用 `shlex.join` 的 shell 引号形式 |

`CommandResult` 字段：`argv`、`returncode`、`stdout`、`stderr`；属性 `ok`、`output`；方法 `raise_for_status()`。

---

## 9. `errors.py` —— 异常

| 异常 | 继承 | 触发场景 |
|---|---|---|
| `SandboxError` | `Exception` | 业务异常基类 |
| `ConfigError` | `SandboxError` | 配置或数据目录不可用 |
| `ValidationError` | `SandboxError` | 沙箱名、挂载声明等输入非法 |
| `NotFoundError` | `SandboxError` | 沙箱不存在 |
| `AlreadyExistsError` | `SandboxError` | 沙箱已存在 |
| `CommandError` | `SandboxError` | 宿主命令失败（带 `argv`、`returncode`、`stdout`、`stderr`） |
| `ImageError` | `SandboxError` | 镜像不可用（导出注入失败等） |
| `ImageNotFoundError` | `ImageError` | 宿主与沙箱守护进程都没有该镜像（用户侧错误：服务层映射成 400） |
| `ProxyError` | `SandboxError` | 统一镜像代理不可用（CA 不可读、合并 CA 束装不上等） |
| `LifecycleError` | `SandboxError` | 生命周期步骤失败（带 `step`、`cause`） |

---

## 10. 与命令行的对应关系

| 命令 | 调用的核心接口 |
|---|---|
| `create` | `SandboxService.create` |
| `start` | `SandboxService.start` |
| `stop` | `SandboxService.stop`（`--keep-dependencies` 对应 `stop_dependencies=False`） |
| `delete` | `SandboxService.reclaim_plan` + `SandboxService.delete` |
| `list` | `SandboxService.list` |

二期把 `SandboxService` 的方法映射为 HTTP 路由时，请求体可直接用 `CreateRequest`，响应体可用 `CreateResult`、`SandboxMetadata`、`ReclaimPlan`、`DeleteResult`。

---

## 11. 二期 HTTP 接口

服务端包 `sandbox_console`（FastAPI，独立 Python 包，位于 `apps/web/backend/`）把上面的核心接口暴露为 HTTP 路由。
**命令行与服务端共用同一 `SandboxService`，行为等价**：服务层只做编排与转译，
不重复实现任何生命周期逻辑，宿主交互仍收敛在 `daemon.py` / `images.py` / `proxy.py` 内。

| 项 | 值 |
|---|---|
| 前缀 | `/api` |
| 启动入口 | `uv run --project apps/web/backend python -m sandbox_console` |
| 监听地址 | 默认 `127.0.0.1:8000`，用 `SANDBOX_CONSOLE_HOST` / `SANDBOX_CONSOLE_PORT` 覆盖；非回环地址启动时打醒目告警 |
| 前端目录 | 默认 `apps/web/frontend/dist`（前端与后端同在 `apps/web/` 下），用 `SANDBOX_CONSOLE_DIST` 覆盖；目录不存在时跳过静态托管并告警（`/api/health` 的 `console_mounted` 为 false） |
| 接口文档 | `/docs` 与 `/openapi.json` **默认关闭**；用 `SANDBOX_CONSOLE_DOCS=1` 显式开启（无认证环境不公开接口清单） |
| 错误响应体 | 统一 `{"detail": "中文消息"}`；400 / 404 / 409 保留平台异常原文，500 只给固定文案（原文只进日志） |
| 鉴权 | 无（只监听回环或内网地址，不得暴露公网） |

创建接口支持两类路径声明：**挂载**（`mounts`，平台不处置宿主目录）与
**文件注入**（`files`，平台把宿主文件复制一份再只读挂进容器）。注入副本落在
沙箱用户家目录内的暂存目录 `.sandbox-files`，**随沙箱删除时家目录回收一起消失**；
复制是**创建时快照**，宿主原件之后的变更不回灌到沙箱（原件本身零接触）。

**注入源的可见范围（信任边界）**：

- 注入源由平台**以特权身份读取**（复制动作走特权通道）：控制台 / 命令行的调用者
  被视为平台受信主体，**文件注入不提供跨账号隔离**；
- 源路径不得位于**其他沙箱用户家目录**内（那是别的沙箱账号的家）：命中即 400，
  文案为「注入的宿主路径落在其他沙箱用户家目录内，不允许注入：{路径}」；
- 源路径同样不得命中宿主敏感清单（`/etc` `/proc` `/root` 等、平台数据根、宿主
  Docker 套接字），且**先归一化再比对**（`/tmp/../etc/passwd` 绕不过去）。


### 11.1 路由表

| 方法 | 路径 | 请求体 | 响应体 | 对应的核心接口 |
|---|---|---|---|---|
| GET | `/api/health` | — | 服务自检（版本、数据根是否就绪、前端是否挂载） | — |
| POST | `/api/sandboxes` | `CreateSandboxRequest` | 201 + `CreateSandboxResponse` | `SandboxService.create` |
| GET | `/api/sandboxes` | — | `SandboxSummary[]` | `SandboxService.list` |
| GET | `/api/sandboxes/{name}` | — | `SandboxDetail` | `SandboxService.get` |
| POST | `/api/sandboxes/{name}/start` | — | `SandboxDetail` | `SandboxService.start` |
| POST | `/api/sandboxes/{name}/stop` | `StopSandboxRequest`（可省略） | `SandboxDetail` | `SandboxService.stop` |
| GET | `/api/sandboxes/{name}/reclaim` | — | `ReclaimPlanModel`（沙箱不存在 → 404） | `SandboxService.reclaim_plan` |
| DELETE | `/api/sandboxes/{name}` | — | `DeleteSandboxResponse` | `SandboxService.delete` |
| GET | `/api/images` | — | `HostImageModel[]` | `SandboxService.list_host_images` |
| GET | `/api/proxy/status` | — | `ProxyStatusModel` | `SandboxService.proxy_status` |
| POST | `/api/proxy/restart` | — | `ProxyRestartModel` | `SandboxService.restart_proxy` |
| POST | `/api/terminal/sessions` | `TerminalSessionCreateRequest` | 201 + `TerminalSessionResponse` | 终端会话管理器（见第 12 节） |
| GET | `/api/terminal/sessions` | 查询参数 `sandbox`（可选） | `TerminalSessionModel[]` | 终端会话管理器（见第 12 节） |
| DELETE | `/api/terminal/sessions/{session_id}` | — | `TerminalSessionDeleteResponse` | 终端会话管理器（见第 12 节） |
| WS | `/api/terminal/sessions/{session_id}` | 帧协议见 12.3 | 二进制帧 + 文本帧 | 终端会话管理器（见第 12 节） |
| GET / POST / DELETE | `/api/templates`、`/api/templates/{id}/rename` | `TemplateCreateRequest` / `TemplateRenameRequest` | `TemplateResponse[]` / `TemplateResponse` / `TemplateDeleteResponse` | 启动模板（见第 13 节） |

### 11.2 请求字段

`CreateSandboxRequest`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `name` | `str` | 必填 | 沙箱名，走一期白名单校验 |
| `image` | `str` | 必填 | 沙箱镜像（**必须显式指定**：默认镜像已退役，平台无兜底镜像）；缺失回 422 |
| `image_source` | `"auto" \| "host"` | `auto` | `auto`（先经镜像代理拉取，失败再回退宿主副本注入）/ `host`（强制从宿主注入，不经镜像代理）；只允许这两个取值 |
| `mounts` | `list[str]` | `[]` | 用户声明挂载，格式 `宿主路径:容器路径[:ro]`；平台不创建也不删除宿主目录 |
| `files` | `list[str]` | `[]` | 注入文件声明，格式 `宿主路径:容器路径`（固定两段，无读写标记）；平台复制到沙箱用户家目录后以只读方式挂进容器，原件零接触 |
| `command` | `str \| list[str] \| null` | `null` | 容器启动命令；给字符串时按 shell 引号规则切分，与命令行一致（引号不配对 → 400） |
| `env` | `dict[str, str]` | `{}` | 容器环境变量，键名走白名单校验 |
| `workdir` | `str \| null` | `null` | 容器工作目录 |
| `network` | `str \| null` | `null` | 网桥网络名，缺省 `<沙箱名>-net`；用户指定的网络平台只接入不回收 |

两个请求模型都开了 `extra="forbid"`：拼错的字段名直接 400，不静默忽略。

`StopSandboxRequest`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `stop_dependencies` | `bool` | `true` | 是否一并停止依赖容器（对应命令行 `--keep-dependencies` 的反面） |

### 11.3 响应字段

| 模型 | 字段 | 说明 |
|---|---|---|
| `SandboxSummary` | `name`、`state`、`state_label`、`image`、`created_at` | 列表项：名字 / 状态 / 镜像 / 创建时间 |
| `SandboxDetail` | `name`、`state`、`state_label`、`image`、`image_source`、`created_at`、`updated_at`、`system_user`、`uid`、`gid`、`home`、`subid_start`、`subid_length`、`socket_path`、`socket_mount_path`、`container_name`、`container_id`、`network_name`、`network_owned`、`unit_path`、`mounts`、`files`、`dependency_containers`、`command`、`env`、`workdir` | 单个沙箱的完整信息（取自 `SandboxMetadata`）；**`env` 只回键名，值固定 `***`**（环境变量里常有凭据）；**`files` 是注入文件的只读副本挂载**（结构同 `mounts`，单列不进 `mounts`），没有注入声明时返回空列表 |
| `CreateSandboxResponse` | `metadata`、`connection`、`steps` | 创建结果：`steps` 是固定 7 步名称，`connection` 含套接字路径与进入沙箱的命令提示 |
| `ReclaimPlanModel` | `sandbox_name`、`items`、`untouched_note`、`user_mounts`、`incomplete` | 删除前的回收清单；`untouched_note` 固定为「用户挂载的宿主机目录不受影响」；`incomplete` 表示依赖容器清单可能不完整 |
| `DeleteSandboxResponse` | `name`、`existed`、`removed`、`failed`、`plan` | 删除结果；`removed` 是确实回收掉的资源，`failed` 是尝试过但没成功的条目 |
| `HealthResponse` | `status`、`version`、`data_root_configured`、`console_mounted` | 服务自检；**不回显宿主平台数据根的绝对路径**，只给「数据根是否就绪」与「前端是否挂载」 |
| `HostImageModel` | `reference`、`image_id`、`size_bytes`、`created_at` | 宿主本地镜像项：`reference` 是 `仓库:标签` 形式的镜像引用，`size_bytes` 是体积（字节），`created_at` 是创建时间；悬空镜像不进列表 |
| `ProxyContainerStatusModel` | `exists`、`running` | 代理容器是否存在 / 是否运行中 |
| `ProxyStatusModel` | `container`、`healthy`、`tcp_ok`、`ca_fetchable`、`detail`、`cache_size_bytes`、`certificate_ready`、`proxy_url` | 代理状态：容器运行状态、健康状态（端口可连 / 能取到证书 / 明细）、缓存目录占用字节数、代理 CA 证书就绪状态、代理访问地址；**代理没起来不是错误**：如实回报「不健康」与明细（明细区分「容器不存在」「容器未运行」「端口不通」），不报 4xx / 500 |
| `ProxyRestartModel` | `ProxyStatusModel` 的全部字段 + `restarted`、`ca_changed`、`ca_reinstalled`、`message`、`reinstalled_users`、`failed_users` | 重启代理的结果；`restarted` 表示重启后已通过健康检查，`ca_changed` 表示代理 CA 指纹与重启前不一致，`ca_reinstalled` 表示合并证书链确实重装过（未重装时为 `false`），`reinstalled_users` 是因此重装了合并 CA 束的沙箱用户，`failed_users` 是重装失败的用户 |

### 11.4 错误码映射

| 场景 | 状态码 | 响应体 |
|---|---|---|
| 缺必填的 `image` 字段（默认镜像已退役后的硬性要求） | 422 | `{"detail": "请求参数不合法：image（必填：默认镜像已退役，必须显式指定沙箱镜像）"}` |
| `image` 传空串、纯空白串或 null（与缺失同义） | 422 | 同上（都归入「必须显式指定沙箱镜像」语义） |
| `image` 与 `name` 同时缺失 | 422 | `{"detail": "请求参数不合法：name（必填）；image（必填：默认镜像已退役，必须显式指定沙箱镜像）"}` |
| 入参非法（沙箱名、镜像名、挂载声明、镜像来源等） | 400 | `{"detail": "平台异常原文"}` |
| `files` 声明非法（格式错、敏感路径、符号链接、宿主路径不存在、重复声明、撞挂载点、落在其他沙箱用户家目录内） | 400 | `{"detail": "平台异常原文"}` |
| 请求体不合法（缺字段、类型不对、多余字段） | 400 | `{"detail": "请求参数不合法：字段（原因）"}` |
| 宿主与沙箱守护进程都没有该镜像（`image_source=host`） | 400 | `{"detail": "平台异常原文"}` |
| 沙箱不存在 | 404 | `{"detail": "平台异常原文"}` |
| 接口不存在 | 404 | `{"detail": "接口不存在：METHOD /path"}` |
| 沙箱已存在 | 409 | `{"detail": "平台异常原文"}` |
| 其余平台异常（代理不可达、生命周期步骤失败、宿主命令失败、镜像注入失败等） | 500 | `{"detail": "平台内部错误，请查看服务日志"}` |

映射在服务层统一完成：平台异常不吞。
500 分支**不回显异常原文**（原文可能带宿主绝对路径与特权命令行），只进日志。

### 11.5 镜像代理接口的口径

| 项 | 口径 |
|---|---|
| 代理不可达不降级 | 代理不可达时**一律直接失败，不降级直连**（一期既定原则）：创建 / 启动沙箱时报错，`POST /api/proxy/restart` 报 `restarted=false`。接口层不提供任何绕过代理的开关 |
| 代理没起来不是接口错误 | `GET /api/proxy/status` 如实回报「不健康」与明细（`healthy=false`、`detail` 给出原因），不报 4xx / 500；状态查询永不抛异常（宿主命令失败、超时、证书读不出来都降级成不健康 + 明细） |
| 重启失败的返回方式 | `POST /api/proxy/restart` 仍返回 200，用 `restarted=false` 与 `message` 说明结果；失败原因（宿主命令原文）只进服务日志，不回显到响应。失败分支的 `message` 会追加 CA 状态说明（CA 变了但证书链未重装） |
| CA 指纹变化 | 重启后比对代理 CA 指纹；指纹与重启前不一致时自动为已有沙箱用户重装合并 CA 束（复用 `install_ca_bundle`），并回传 `ca_changed=true` 与 `reinstalled_users` |
| CA 指纹的口径 | `ca_changed = bool(变更前) and bool(变更后) and 变更前 != 变更后`：**变更前后都读得到证书**才算「变了」。读不到（空串）不等于变了——CA 首次生成不会被误报成「CA 已变更」。指纹对内容做**空白归一化**后哈希，换行与缩进差异不算变更 |
| 不把未修复报成已修复 | 另有 `ca_reinstalled` 字段：CA 变了但新 CA 读不到（或合并证书链没装上）时为 `false`，`message` 如实说「CA 指纹已变更，但新 CA 读取失败，未能重装合并证书链」。重装失败的用户进 `failed_users`，单个用户失败不阻断其余用户 |
| 代理锁语义 | 创建流程与重启共用同一把文件锁（`<平台数据根>/locks/registry-proxy.lock`）：**创建流程会阻塞等待代理锁，重启结束后再判定可达性**（不是看到「代理不可达」就直接失败）。`docker restart` 的超时跟 `restart(timeout)` 参数挂钩（取 `min(timeout, 120)`），不写死 |
| 缓存只增不减 | **不提供任何清理代理缓存的接口**：缓存目录只增不减，`GET /api/proxy/status` 只展示占用字节数 |
| 不做远程拉取 | **不提供网页拉取镜像的接口**：`GET /api/images` 只实时枚举宿主本地镜像（含用户本地构建、任何仓库都没有的镜像），创建沙箱时只从这份列表里选 |

> **未认证特权端点（风险说明）**：`POST /api/proxy/restart` 是**未认证的特权端点**。服务只绑回环地址，但本机任意进程都能调用它：反复重启代理会打断正在拉镜像的沙箱（代理不可达时创建 / 启动直接失败）。不要把服务改成监听公网或不受控的内网地址；如需对外提供服务，必须先加认证。


---

## 12. 网页终端接口与 WebSocket 协议

网页终端 = 容器内一个带真实 TTY 的交互式进程 + 宿主侧一个伪终端 + 一条 WebSocket 桥接。
服务层只做编排：伪终端分配与特权命令构造在核心包 `daemon.py`，会话元数据落盘在
`sandbox_console/sessions.py`，会话承载与输出缓冲在
`sandbox_console/terminal.py`，路由在 `sandbox_console/routes/terminal.py`。

### 12.1 路由表

| 方法 | 路径 | 入参 | 出参 | 说明 |
|---|---|---|---|---|
| POST | `/api/terminal/sessions` | `TerminalSessionCreateRequest` | 201 + `TerminalSessionResponse` | 新建终端会话（沙箱内起一个交互式 shell） |
| GET | `/api/terminal/sessions` | 查询参数 `sandbox`（可选） | `TerminalSessionModel[]` | 列出会话；给了沙箱名则只列该沙箱的会话，缺省列全部 |
| DELETE | `/api/terminal/sessions/{session_id}` | — | `TerminalSessionDeleteResponse` | 删除会话（会话不存在或标识非法 → 404） |
| WS | `/api/terminal/sessions/{session_id}` | 见 12.3 帧协议 | 二进制帧 + 文本帧 | 附着到已有会话（先回放缓冲再接实时流） |

### 12.2 请求与响应字段

`TerminalSessionCreateRequest`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `sandbox` | `str` | 必填 | 沙箱名，走一期白名单校验 |
| `cols` | `int` | `80` | 初始窗口宽度（列），取值 1~1000 |
| `rows` | `int` | `24` | 初始窗口高度（行），取值 1~1000 |

`TerminalSessionResponse`（新建结果）：

| 字段 | 说明 |
|---|---|
| `session_id` | 会话标识（重连时带回这个标识） |
| `sandbox` / `container_name` | 所属沙箱名与容器名 |
| `cols` / `rows` | 初始窗口大小 |
| `state` | 会话状态（`running` / `exited`） |
| `created_at` | 创建时间 |

`TerminalSessionModel`（会话表一行，字段与落盘文件一致）：

| 字段 | 说明 |
|---|---|
| `session_id` | 会话标识 |
| `sandbox_name` / `container_name` / `system_user` | 所属沙箱、容器名、执行身份 |
| `created_at` / `last_attached_at` | 创建与最近附着时间 |
| `state` | `running` / `exited` / `orphaned` |
| `exit_code` | 终端进程退出码（未退出为空） |
| `exit_reason` | 会话结束的原因（未结束为空）：`exited` = 容器内进程自己退出；`closed_by_user` = 用户主动关闭；`reclaimed` = 空闲回收；`shutdown` = 服务退出兜底 |
| `pid` | 宿主侧 exec 进程号（服务重启后据此清理遗留进程） |
| `cols` / `rows` | 最近一次窗口大小 |
| `attached_count` | 当前附着的浏览器连接数 |
| `host_pid` | 建会话的服务进程号（启动清理时用来识别「这条记录是不是另一个实例的」） |

`TerminalSessionDeleteResponse`（删除会话的结果）：

| 字段 | 说明 |
|---|---|
| `session_id` | 被移除的会话标识 |
| `state` | 移除前的会话状态（`running` / `exited`） |
| `closed` | 关闭流程是否走完：运行中的会话走完整关闭（宿主伪终端已终止、容器内按会话标识清过进程树）、已退出的会话走完收尾（回收伪终端文件描述符、顺带清一次容器内残留进程树）时为 `true`；关闭流程中途出错时为 `false`（**记录已删，但关闭流程未走完**） |
| `removed` | 会话记录文件是否确实删掉了 |

### 12.2bis 删除会话的口径

| 场景 | 行为 |
|---|---|
| 运行中的会话 | 先走完整关闭流程（终止宿主伪终端、容器内按会话标识清进程树、状态落盘），再删会话记录；两件事都做完才回 200 |
| 已退出 / 孤儿的会话 | **不重复终止进程**（进程早没了），但仍走一次收尾：回收伪终端文件描述符，并顺带清一次容器内可能残留的进程树，再删会话记录 |
| 关闭流程中途出错 | 记录**照删**（留着会让用户以为没删掉），接口仍回 200；响应里 `closed` 为 `false`（记录已删，但关闭流程未走完），异常只进服务端日志 |
| 附着中的浏览器连接 | 走**既有的退出帧路径**：服务端发 `exit` 帧后断开连接，浏览器据此收尾。结束标记在关闭流程**一开始**就发（不等容器内清理跑完），浏览器的等待时间不被清理耗时绑住。退出帧带 `reason=closed_by_user`，客户端据此提示「成功关闭」而不是「异常结束」 |
| 会话不存在 / 标识非法 | 回 404，`detail` 固定为「终端会话不存在或已失效」（**不回显**用户输入的会话标识）；标识不是 16 位十六进制时直接按不存在处理 |
| 已退出的会话的自动清理 | **不做**：已退出的会话不进空闲回收，保留在列表里等用户手动删 |

**两类会话的去向不同**：空闲回收（超过 30 分钟无附着的运行中会话）处理掉的会话
从「后端保留的会话」列表里消失，落盘的记录文件留到下一次服务启动时随遗留记录
一起清掉；用户自己退出（容器内进程 `exit`）的会话**保留在列表里**，等用户手动删除。

### 12.3 WebSocket 帧协议

| 方向 | 帧类型 | 载荷 | 说明 |
|---|---|---|---|
| 客户端 → 服务端 | 二进制 | 终端输入字节 | 原样写进容器内的 TTY |
| 客户端 → 服务端 | 文本 | `{"type":"resize","cols":..,"rows":..}` | 同步窗口大小（设置宿主伪终端窗口大小，容器内 TTY 随之更新） |
| 服务端 → 客户端 | 二进制 | 终端输出字节 | 容器内进程的输出 |
| 服务端 → 客户端 | 文本 | `{"type":"hello","session_id":..,"sandbox":..,"cols":..,"rows":..}` | 附着成功，回当前窗口大小 |
| 服务端 → 客户端 | 文本 | `{"type":"exit","code":n,"reason":".."}` | 容器内进程已退出，`code` 是退出码；`reason` 是结束原因（`exited` 容器内进程自己退出 / `closed_by_user` 用户主动关闭 / `reclaimed` 空闲回收 / `shutdown` 服务退出兜底，可能为空） |
| 服务端 → 客户端 | 文本 | `{"type":"error","message":".."}` | 指令非法、会话不存在，或输入被截断（待发输入超过 1 MiB 上限，丢的是最新的字节） |

握手与时序：

1. 浏览器连上 `WS /api/terminal/sessions/{session_id}`；
2. 服务端先登记附着（连接数加一），再回 `hello`；
3. 接着把环形缓冲里的历史输出作为二进制帧**回放**（单帧不超过 64 KiB，超出就切多帧），之后接实时流；
4. 浏览器断开：容器内进程不退出，输出继续写进环形缓冲，重连同一 `session_id` 即可恢复现场；
5. 服务重启：全部会话失效（见 12.4），旧 `session_id` 不可再附着。

### 12.4 终端会话表

会话表落在 `<平台数据根>/terminal-sessions/<session_id>.json`，字段见 12.2 的
`TerminalSessionModel`。会话创建、退出、附着、断开、窗口大小变更五个时机落盘；
落盘走后台线程的合并写（窗口大小抖动这类高频变更在合并窗口内只写一次），
事件循环线程不做文件 I/O。

| 场景 | 行为 |
|---|---|
| 服务启动 | 全部遗留记录标记为 `orphaned`，按记录的 `pid` 终止遗留 exec 进程（**仅当该进程命令行含本次会话标识时才终止**，避免误杀被复用的进程号），再按同一个标识把容器内残留的 shell 收掉（杀宿主侧 exec 客户端收不掉容器内进程），随后删除记录文件。容器已被删除时静默跳过 |
| 服务启动（多实例） | 记录的 `host_pid` 不是本进程且那个进程号还活着时**跳过清理**：那是另一个实例正在用的会话 |
| 服务退出 | 关闭全部会话：容器内进程一并收掉（宿主侧 exec 进程终止 + 容器内按标识清理） |
| 会话数超限 | 全部会话达 20 个、或单沙箱达 5 个时，`POST /api/terminal/sessions` 回 400，不创建会话（上限可用环境变量 `SANDBOX_TERMINAL_MAX_SESSIONS` / `SANDBOX_TERMINAL_MAX_SESSIONS_PER_SANDBOX` 覆盖）。**已退出的会话也占名额**（它们不做自动清理），要腾位置就手动删掉。错误文案带上已退出的会话数与清理入口，例：「沙箱 demo 的终端会话数已达上限（5 个，其中 3 个已退出待清理），请先在『后端保留的会话』列表中移除已退出的会话」 |
| 会话空闲 | 无浏览器附着且空闲超过 30 分钟的**运行中**会话自动回收（走正常关闭流程 + 会话表更新；时长可用环境变量 `SANDBOX_TERMINAL_IDLE_TIMEOUT` 覆盖，单位秒）。**已退出的会话不纳入回收**：它不留现场，保留在列表里等用户手动删 |
| 沙箱不存在 | `POST /api/terminal/sessions` 回 404，不创建会话 |
| 沙箱未运行 / 容器已被删除 | `POST /api/terminal/sessions` 回 400 并给出中文错误，不创建空会话 |
| 沙箱名 / 入参非法 | 回 400 |

### 12.5 伪终端与特权命令构造（核心包）

| 入口 | 签名 | 说明 |
|---|---|---|
| 起伪终端 | `spawn_pty(argv, *, cols=80, rows=24, env=None, marker=None) -> PtyProcess` | 分配伪终端并在独立会话里起进程，返回进程句柄与主端文件描述符；**主端是非阻塞的**（写不进去立即返回，调用方等「可写事件」重试）；`marker` 是会话标识，终止前拿它复核命令行 |
| 伪终端句柄 | `PtyProcess` | `read` / `write` / `resize` / `winsize` / `poll` / `is_alive` / `wait` / `terminate` / `close`；`terminate` 幂等，且终止前先确认这个进程号还指着「自己的子进程」 |
| 窗口大小 | `set_pty_winsize(fd, cols, rows)` / `get_pty_winsize(fd) -> (rows, cols)` | 伪终端窗口大小读写 |
| 以沙箱用户身份执行 | `UserDaemon.exec_pty(argv, *, cols=80, rows=24, marker=None) -> PtyProcess` | 执行身份、环境变量与权限前缀复用 `UserDaemon.user_argv` |
| 容器内交互式 shell | `UserDaemon.exec_pty_shell(container, *, session_id, cols=80, rows=24, shell="bash") -> PtyProcess` | 容器内进程拿到真实 TTY；会话标识注入容器内进程的环境变量，同时出现在宿主侧 exec 进程的命令行里 |
| 容器内 shell 探测 | `UserDaemon.container_shell(name) -> str` | 优先 `bash`，没有则退回 `sh`；结果按容器名在进程内缓存 |
| 容器内会话清理 | `UserDaemon.kill_container_session(container, session_id) -> bool` | 按会话标识在容器内终止本次会话的残留进程（容器已删时静默跳过） |
| 容器内清理脚本 | `container_session_kill_script(session_id) -> str` | 构造按环境变量匹配的容器内 shell 脚本；会话标识先过白名单校验再拼进命令 |
| 遗留进程清理 | `terminate_pty_process(pid, marker=None, *, grace=3.0) -> bool` | 按进程号终止遗留进程；给了 `marker` 时只在进程命令行含该标记时才终止；终止前拿进程身份（进程组号 + 启动时刻）复核，进程号被复用就放弃 |
| 进程命令行 | `process_cmdline(pid) -> str \| None` | 读 `/proc/<pid>/cmdline`；进程不存在返回 `None` |
| 进程状态与身份 | `process_state(pid) -> str \| None` / `process_identity(pid) -> tuple[int, int] \| None` / `pid_alive(pid) -> bool` | 进程状态字符（含 `Z` 僵尸）、身份指纹（进程组号 + 启动时刻）、存活判定 |

宿主侧伪终端设为 raw 模式：宿主只做字节搬运，行编辑、回显与 Ctrl-C 全部由容器内的
TTY 负责（容器内拿到的是真实 TTY，默认 termios 生效）。

**写侧不阻塞**：伪终端主端是非阻塞的。用户粘贴大文本、而容器内进程停止读 stdin 时，
写入侧不会卡死（内核缓冲满就留着字节等下一个「可写事件」），I/O 线程因此不会停止读
输出，容器内 shell 不会被输出写满卡住，Ctrl-C 始终送得进去。

### 12.6 服务层新增模块

| 模块 | 职责 |
|---|---|
| `sandbox_console/terminal.py` | 终端会话管理器与会话承载：起会话、伪终端 I/O 线程、输出环形缓冲、实时流投递、会话上限与空闲回收、落盘合并写、会话删除 |
| `sandbox_console/sessions.py` | 终端会话表：记录读写与原子落盘、遗留记录清理（含跨实例保护） |
| `sandbox_console/routes/terminal.py` | 四条终端路由与 WebSocket 帧协议 |

---

## 13. 启动模板接口

启动模板是**控制台私有能力**：一套沙箱启动配置存起来，下次新建沙箱时一键回填。
模板只是一份配置文本，落在平台数据根的 `templates/` 目录——不进数据库、不做多用户
隔离、不做导入导出。核心包 `sandbox_platform` 与命令行 `apps/cli/` 零改动。

| 项 | 值 |
|---|---|
| 路由前缀 | `/api/templates` |
| 模板标识 | 服务端生成（`tpl_` + 12 位十六进制），与名称解耦：重命名不影响标识 |
| 名称口径 | 零限制：不 strip、不限长、不校验字符集与保留字（含空串） |
| 配置体口径 | 七项全选填；只落用户真正填过的字段，「字段缺失」与「字段填了空值」不混同 |
| 服务层模块 | `sandbox_console/templates.py`（模板库读写、内置种子与墓碑）、`sandbox_console/routes/templates.py`（四条路由） |

### 13.1 路由表

| 方法 | 路径 | 请求体 | 响应体 | 说明 |
|---|---|---|---|---|
| GET | `/api/templates` | — | `TemplateResponse[]`（**裸数组**，不包对象） | 列出全部模板，带完整配置体；读取时顺带补一次内置种子 |
| POST | `/api/templates` | `TemplateCreateRequest` | 201 + `TemplateResponse` | 创建模板，名称零限制；配置体多传字段 → 400 |
| POST | `/api/templates/{id}/rename` | `TemplateRenameRequest` | `TemplateResponse` | 只改名称，标识与其余字段不动；模板不存在 → 404 |
| DELETE | `/api/templates/{id}` | — | `TemplateDeleteResponse` | 删除模板；删的是内置模板时写墓碑；模板不存在 → 404 |

### 13.2 请求与响应字段

`TemplateConfig`（模板配置体，七项全选填，`extra="forbid"`）：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `image` | `str \| null` | `null` | 沙箱镜像（留空则创建时须另行指定） |
| `mounts` | `list[str]` | `[]` | 用户声明挂载，格式 `宿主路径:容器路径[:ro]`；平台不创建也不删除宿主目录 |
| `files` | `list[str]` | `[]` | 注入文件声明，格式 `宿主路径:容器路径`（固定两段，无读写标记）；平台复制到沙箱用户家目录后以只读方式挂进容器，原件零接触 |
| `command` | `str \| list[str] \| null` | `null` | 容器启动命令（覆盖镜像默认入口） |
| `workdir` | `str \| null` | `null` | 容器工作目录 |
| `env` | `dict[str, str]` | `{}` | 容器环境变量 |
| `network` | `str \| null` | `null` | 网桥网络名（缺省 `<沙箱名>-net`；用户指定的网络平台不回收） |

`TemplateCreateRequest`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `name` | `str` | 必填 | 模板名称，零限制（不 strip、不限长、不校验字符集） |
| `config` | `TemplateConfig` | `{}` | 模板配置体；未出现的字段不落盘 |

`TemplateRenameRequest`：`name`（`str`，必填，零限制）。

`TemplateResponse`：

| 字段 | 说明 |
|---|---|
| `id` | 模板标识（服务端生成，与名称解耦） |
| `name` | 模板名称 |
| `config` | 模板配置体，**原样透传**：用户没填过的字段就是没有，不是空值 |
| `created_at` / `updated_at` | 创建与最近修改时间 |

`TemplateDeleteResponse`：`id`（被删的模板标识）、`deleted`（模板记录文件是否确实删掉了）。

### 13.3 存储布局、内置种子与墓碑

| 项 | 口径 |
|---|---|
| 目录 | `<平台数据根>/templates/`，一个模板一个 JSON 文件 `<模板标识>.json` |
| 写入 | 写临时文件 → 改权限 0600 → 原子替换：进程中断不留半截文件 |
| 权限 | 文件权限 0600，与平台其他元数据一致 |
| 枚举 | 只扫 `templates/` 顶层的 `*.json`，**不递归子目录**；按标识排序 |
| 字段 | 只落用户真正填过的字段（`exclude_unset`）：「字段缺失」与「字段填了空值」不混同——模板应用语义是「出现字段整体替换、缺失字段保持现状」 |
| 内置种子 | 常量 `BUILTIN_TEMPLATES`（**本期为空**：只落地机制，不预置真实模板内容）；启动时按标识注入，同标识文件已存在不覆盖；每条的形状是 `{"id": ..., "name": ..., "config": {...}}`，将来加一条即自动生效 |
| 墓碑 | `templates/.builtin/state.json`，内容 `{"deleted": [...]}`；内置模板被删后写墓碑，后续启动不再注入（**删了不复活**） |
| 墓碑目录 | 点开头的隐藏目录 `.builtin`，不参与用户模板枚举 |
| 坏数据 | 记录文件或墓碑文件损坏时按「不存在 / 空集」处理，不炸服务（非 UTF-8 文件同样按损坏处理：坏记录跳过、坏墓碑按空集） |

### 13.4 `~` 展开与模板声明原样透传口径

| 项 | 口径 |
|---|---|
| 展开范围 | 只展开**路径声明的宿主路径段**（挂载声明与文件注入声明）：`~` 与 `~/` 前缀展开为**服务运行用户**的家目录 |
| 文件注入声明的展开 | `~` 展开同样作用于文件注入声明的宿主路径段，口径与挂载一致（只展开宿主路径段，容器路径段不展开） |
| 空白处理 | 宿主路径段先去掉首尾空白再判断 `~` 前缀（与核心包解析挂载声明时先 strip 的口径一致）：`" ~/data "` 同样展开 |
| 不展开 | 容器路径段、环境变量值、命令、工作目录、`~other` 形式一律不展开，原样交给核心包 |
| 取不到家目录 | 保持原样（不展开） |
| root 运行的后果 | 服务以 root 身份运行时 `~` 展开为 `/root`，命中核心包的宿主敏感目录拒绝清单 → 400。**这是既有契约的自然结果，不是缺陷** |
| 适用范围 | `~` 展开是**网页创建专属口径**：命令行创建沙箱仍要求宿主路径写绝对路径（命令行零改动） |
| 模板声明的字面量 | **模板声明中的任何字面量原样提交**：前端不做任何占位符替换，模板配置里的字符串原样回填表单、原样进创建请求（`{name}` 这样的写法也照原样提交）；服务端只原样存取——模板里的 `~` 与其他字面量都不改写 |
