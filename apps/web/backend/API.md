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
| `forward_image` | `str` | `alpine/socat:1.8.1.3@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed` | `SANDBOX_PLATFORM_FORWARD_IMAGE` | 端口转发的转发镜像（**钉 digest**；镜像的 ENTRYPOINT 是 `socat`） |
| `forward_container_template` | `str` | `{sandbox}-fwd-{port}` | `SANDBOX_PLATFORM_FORWARD_CONTAINER_TEMPLATE` | 转发容器名模板；必须同时含 `{sandbox}` 与 `{port}` 占位符（其它占位符在配置校验时就报错） |

> **转发侧没有端口区间配置**：链路两点化后后端宿主零端口，宿主侧不再有平台分配的转发端口（ADR 0014 第二次修订）。

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
| 路径 | `sandbox_root` / `lock_root` / `temp_root` / `proxy_root` / `proxy_cache_dir` / `proxy_ca_dir` / `forward_root` / `sandbox_dir(name)` / `metadata_path(name)` | 数据目录布局 |
| 命名 | `system_user_name(sandbox_name: str) -> str` | 沙箱名 → 系统用户名 |
| 准备 | `ensure_directories() -> None` | 创建数据目录（幂等）；**转发记录目录单独收紧到 `0700`** |

---

## 2. `mounts.py` —— 挂载解析与容器参数

| 函数 | 签名 | 说明 |
|---|---|---|
| 解析单条 | `parse_mount_declaration(declaration: str, *, extra_forbidden: Iterable[str \| Path] = ()) -> MountSpec` | 解析 `宿主路径:容器路径[:ro]`；宿主路径必须已存在且是绝对路径，平台不代为创建；路径含逗号一律拒绝；命中敏感清单（`/etc` `/proc` `/sys` `/dev` `/boot` `/root`、宿主 Docker 套接字、追加项如平台数据根）一律拒绝（**先归一化再比对**：`/tmp/../etc` 与 `//etc` 都绕不过去） |
| 解析多条 | `parse_mounts(declarations: list[str] \| tuple[str, ...] \| None, *, extra_forbidden: Iterable[str \| Path] = ()) -> list[MountSpec]` | 逐条解析并校验容器内路径不重复 |
| 敏感清单 | `sensitive_host_paths(extra: Iterable[str \| Path] = ()) -> tuple[str, ...]` | 固定敏感清单 + 调用方追加项（平台数据根由调用方追加） |
| 路径归一化 | `normalize_host_path(raw: str) -> str` | 宿主路径的**唯一**归一化口径（`mounts.py` 与 `files.py` 共用）：折叠 `.` / `..`，并把前导多斜杠压成一个。`os.path.normpath` 按 POSIX 规则把**恰好两个**前导斜杠原样留着（`//etc`），`pathlib` 又把 `//etc` 当成独立根，不额外压平就能绕开按 `/etc` 根的清单比对 |
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
- 源路径不得位于**任何沙箱用户家目录**内（含目标沙箱自己的家目录）。

| 函数 | 签名 | 说明 |
|---|---|---|
| 解析单条 | `parse_file_declaration(declaration: str, *, extra_forbidden: Iterable[str \| Path] = (), home_scope: SandboxHomeScope \| None = None) -> FileSpec` | 解析 `宿主路径:容器路径`（**固定两段**，没有读写标记段）；宿主路径必须是绝对路径、不得含逗号、不得命中敏感清单（与挂载同一套清单）；容器路径必须是绝对路径。**宿主路径先归一化再校验**（`/tmp/../etc/passwd` 与 `//etc/shadow` 都绕不过敏感清单） |
| 解析多条 | `parse_file_declarations(declarations: Iterable[str], *, extra_forbidden: Iterable[str \| Path] = (), home_scope: SandboxHomeScope \| None = None) -> list[FileSpec]` | 逐条解析并做跨声明校验：宿主路径不得重复、容器内路径不得重复 |
| 家目录范围 | `SandboxHomeScope(user_prefix: str, privilege: Privilege \| None = None)` | 注入源的宿主范围限制：`user_prefix` 是平台沙箱用户名前缀（取自配置的 `user_prefix`），系统用户名形如 `<前缀>-<沙箱名>`；`privilege` 是读系统用户表的宿主命令通道（`None` 表示普通通道）。家目录集合**每次现查**，不是启动时的快照 |
| 家目录枚举 | `sandbox_user_homes(user_prefix: str, *, privilege: Privilege \| None = None) -> tuple[Path, ...]` | 经 `getent passwd` 枚举平台沙箱用户的家目录：只认系统用户名以 `<前缀>-` 开头的条目，家目录取 passwd 的家目录字段（**不扫 `/home` 固定根**，宿主把家目录放在别处同样覆盖得到），且家目录必须真实存在（条目残留但目录已删的不算） |
| 家目录拒绝 | `reject_sandbox_user_home(path: str \| Path, scope: SandboxHomeScope) -> None` | 注入源落在**任何**沙箱用户家目录内时拒绝（含本次目标沙箱自己的家目录） |
| 暂存目录 | `staging_root(home: str \| Path) -> Path` | 暂存目录：`<沙箱用户家目录>/.sandbox-files` |
| 副本路径 | `staged_path(home: str \| Path, index: int, host_path: str \| Path) -> Path` | 单个副本：`<暂存目录>/<序号>-<原件名>`（原件名取不到时兜底为 `file`） |
| 宿主探测 | `probe_host_path(privilege: Privilege, path: str, *, extra_forbidden: Iterable[str \| Path] = (), home_scope: SandboxHomeScope \| None = None) -> str` | 特权探测宿主路径：返回 `f`（普通文件）或 `d`（目录）；先 `find -printf %y` 判类型（悬空符号链接判「符号链接」而非「不存在」），命令失败才报不存在；路径是符号链接、目录里有符号链接、目录里有 FIFO / 设备 / 套接字，一律报错；末尾再按 `readlink -f` 解析出的**真实路径**复核一遍受限范围 |
| 副本准备 | `stage_file_copies(specs: list[FileSpec], *, user: SystemUser, privilege: Privilege, extra_forbidden: Iterable[str \| Path] = (), home_scope: SandboxHomeScope \| None = None) -> list[MountSpec]` | 清掉既有暂存目录 → 建暂存目录 → 逐条**复探类型后**复制 → 改属主（uid / gid 数值）→ 目录 0700 → 文件 0600；任一步失败先删暂存目录再抛原异常 |

`FileSpec` 字段：`host_path: str`、`container_path: str`。

四条口径：

| 口径 | 说明 |
|---|---|
| 暂存目录 | 副本落在沙箱用户家目录内的 `.sandbox-files` 目录（属主沙箱用户、权限 0700），**随沙箱删除时的家目录回收一起消失**，停止 / 启动期间保留 |
| 权限位 | 副本文件 0600、副本目录 0700，属主与主组都是沙箱用户（用 uid / gid 数值设置，不依赖「主组与用户同名」）；原件的权限位、属主、内容、mtime 一律不变（**原件零接触**） |
| 只读挂载 | 副本以 `readonly` 方式挂进容器，容器内一律不可写，也不支持容器写回宿主 |
| 不走可读性预检 | 用户声明挂载要过「宿主路径对沙箱用户可读且可穿过」那道预检，文件注入**不走**它——副本属主就是沙箱用户，那道预检对注入没有意义。符号链接一律拒绝（既不跟随、也不复制链接本身）；**路径段上的符号链接**（中间某一段是链接）由 `readlink -f` 真实路径复核兜住 |

三条边界：

| 边界 | 说明 |
|---|---|
| 源路径范围 | 注入源不得落在**任何沙箱用户家目录**内（含本次目标沙箱自己的家目录）；家目录集合经 `getent passwd` 现查（只认系统用户名以平台沙箱用户名前缀开头的条目，家目录取 passwd 字段，必须真实存在）；命中即拒绝，文案为「注入的宿主路径落在沙箱用户家目录内，不允许注入：{路径}（含本次沙箱自己的家目录）」 |
| 双重校验 | 受限范围查**两遍**：① 词法归一化后比一遍（折叠 `.` / `..`、压平前导多斜杠）；② `readlink -f` 解析出符号链接指向的真实路径后再比一遍。中间路径段是符号链接的情况（`/tmp/link/secret`，`link` 指向受限目录）词法上看不出来，只有真实路径看得穿；命中即拒绝，文案为「注入的宿主路径经符号链接解析后落在受限范围：{真实路径}（声明路径 {声明路径}）」 |
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
| 容器标签 | `container_labels(name) -> dict[str, str]` | 取容器标签（取不到返回空字典）；转发容器的重建判定靠它比对转发标识 |
| 按标签枚举 | `container_names_by_label(label) -> list[str]` | `docker ps -a --filter label=<label>`；枚举平台自建资源用（转发容器回收） |
| 网络容器 | `containers_on_network(network) -> list[str] \| None` | 探测失败返回 `None`（与「确实没有容器」区分开），调用方据此判断清单是否完整 |
| 起容器 | `run_container(*, name, image, mounts, network=None, command=None, env=None, labels=None, workdir=None) -> CommandResult` | `docker run -d -i`；给了 `command` 时用 `--entrypoint ""` 覆盖镜像入口；`-i` 保持标准输入打开，镜像入口里的交互式 shell 才不会立即退出 |
| 停删容器 | `stop_container(name)` / `start_container(name)` / `remove_container(name, force=True)` | — |
| 强停容器 | `kill_container(name) -> CommandResult` | `docker kill`：**不等宽限期**。转发容器的 PID 1 是 busybox `tail -f /dev/null`，不响应 SIGTERM，`docker stop` 会白等 10 秒宽限期且期间占着容器名 |
| 容器内执行 | `exec_in_container(name, argv, *, check=False, timeout=120) -> CommandResult` | — |
| 流式执行 | `spawn_stream(argv) -> subprocess.Popen[bytes]` | 以沙箱用户身份起**管道**子进程（不给伪终端）：字节泵场景（`docker exec -i` 的 stdin/stdout 直接搬字节）；命令行必须自带程序名；子进程**自带新会话**（`start_new_session=True`），关闭时能按进程组整体回收 |
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

## 6ter. `forwarding.py` —— 端口转发编排

机制依据：ADR 0014（第二次修订，决策 C）——**链路两点化、后端宿主机零端口**。

- 转发只建立在「沙箱 ⇄ 用户机」之间：后端宿主是纯中继，**既不发布端口也不监听端口**。
- 转发容器是**平台自建资源**：由**沙箱自己的免 root 守护进程**启动、接入沙箱网络；
  **不发布任何端口**（启动参数里没有 `-p`）、容器主进程**常驻空转**（不监听任何端口）。
  镜像里的 `socat` 二进制**专供 exec 字节泵使用**。
- 字节通道唯一路径：`docker exec -i <转发容器> socat - TCP:<沙箱容器>:<端口>`
  （在沙箱守护进程下执行）；宿主特权交互全部收敛在本模块，调用方只拼参数与搬字节。
- 转发记录落 `<平台数据根>/forwards/<id>.json`（`0600`，原子替换），
  **没有 `host_port` 字段**（宿主侧不再有平台分配的转发端口）。
- 容器探测是**三态**（`probe_container` → `PROBE_EXISTS` / `PROBE_MISSING` /
  `PROBE_FAILED`）：沙箱守护进程不可达时**探测失败 ≠ 容器不存在**，不得据此宣称
  「容器已删除」（那会把没删掉的容器说成已回收）。探测按 `docker ps` 是否成功
  退出判定：成功退出才算探测成功。

### 数据类

| 名称 | 字段 | 说明 |
|---|---|---|
| `ForwardRecord` | `id`、`sandbox`、`container_port`、`state`、`host_pid`、`created_at`、`updated_at` | 单条转发记录；**无 `host_port`**。`state` 取 `running` / `stopped`。`host_pid` 是建这条记录的**服务进程号**（跨实例清理保护用） |
| `ForwardOpResult` | `removed`、`failed` | 转发操作结果（回收清单式）：`removed` 是确实处理掉的条目，`failed` 是尝试过但没成功的条目（带原因，如实上报） |
| `BytePump` | `process`、`forward_id` | 字节泵进程句柄：一条 TCP 连接对应一个 exec 进程；`close()` **立即回收**该进程（按**进程组**回收，不留僵尸 exec 进程与孤儿孙进程）；是**上下文管理器**（`with` 退出即回收，异常路径也回收） |

### `PortForwardManager`

| 方法 | 签名 | 说明 |
|---|---|---|
| 构造 | `PortForwardManager(config: PlatformConfig \| None = None, privilege: Privilege \| None = None, service: SandboxRuntime \| None = None)` | 转发编排入口；`service` 是沙箱侧能力（生命周期服务实现 `get` / `daemon_for` / `list`），缺失时只做记录层操作 |
| 容器名 | `container_name(sandbox: str, container_port: int) -> str` | `<沙箱名>-fwd-<容器端口>`（模板取 `config.forward_container_template`） |
| 容器标签 | `container_labels(record: ForwardRecord) -> dict[str, str]` | 见下方「容器命名与标签」 |
| 启动参数 | `run_args(record: ForwardRecord, *, network: str) -> list[str]` | `docker run` 子命令形式（见下方「容器规格」）；**无 `-p`** |
| exec 命令 | `exec_command(record: ForwardRecord) -> list[str]` | 字节泵命令（见下方「exec 命令构造口径」） |
| 查询 | `find(forward_id) -> ForwardRecord \| None` / `get(forward_id) -> ForwardRecord` / `list(sandbox: str \| None = None) -> list[ForwardRecord]` | 不存在抛 `NotFoundError` |
| 建立 | `create(sandbox: str, container_port: int) -> ForwardRecord` | **幂等**：同一沙箱同一端口已有转发则复用既有记录与容器；沙箱不存在抛 `NotFoundError`，端口非法抛 `ValidationError`，沙箱已停止抛 `ForwardError`，**容器名与非平台容器重名抛 `ForwardError`**。**并发保护**：进程内串行化（单进程假设，见 `ForwardStore`） |
| 字节泵 | `open_byte_pump(record: ForwardRecord) -> BytePump` | 转发容器缺失则**幂等重建**（沙箱停止后不自动重建，隧道建立时才补上），随后在沙箱守护进程下起 exec 字节泵进程 |
| 停止转发 | `stop(forward_id: str) -> ForwardOpResult` | 删转发容器（`docker rm -f`）+ 删记录；**容器未确认删掉就不删记录**（记录是唯一收口凭据，先删记录会留下孤儿容器） |
| 沙箱停止联动 | `stop_for_sandbox(sandbox: str) -> ForwardOpResult` | 该沙箱的转发容器一并**停止**（`docker kill`，**记录保留**，状态置 `stopped`） |
| 沙箱删除联动 | `reclaim_for_sandbox(sandbox: str) -> ForwardOpResult` | 转发容器与转发记录一并**回收**（平台自建资源）；容器删不掉时**保留记录**并报进 `failed` |
| 遗留清理 | `purge_leftover() -> ForwardOpResult` | 清理上次遗留的转发容器与记录（**由服务层在启动时调用**）：转发容器按平台标签枚举，转发记录整目录清空，写入残留的 `.forward-*.tmp` 一并清掉；**属于另一个仍活着的服务实例的转发记录与容器不动**（见下方「跨实例保护」） |

### 跨实例保护（同终端会话表语义）

清理遗留转发时，**别的服务实例正在用的转发不能动**：

- 转发记录里带 `host_pid`（建它的服务进程号）；
- `host_pid` 不是本进程、且那个进程号**还活着** → 这条记录属于另一个仍在运行的
  服务实例 → **记录与对应容器都跳过**（与 `sessions.py` 的 `purge_leftover_sessions`
  判据一致：`host_pid` 比对 + `pid_alive`）；
- 归属进程已经没了（服务重启过）→ 按「上次遗留」清掉。

### `ForwardStore`

**单进程口径**：记录目录由单个服务实例独占；同一进程内的并发访问由
`PortForwardManager` 的锁串行化，**跨进程并发不在本期的假设范围内**
（跨实例的遗留清理按 `host_pid` 判归属，见上方「跨实例保护」）。

| 方法 | 签名 | 说明 |
|---|---|---|
| 目录 | `root -> Path` | `<平台数据根>/forwards` |
| 路径 | `path_for(forward_id: str) -> Path` | 单条记录路径；转发标识非法直接抛 `ValidationError` |
| 写入 | `save(record: ForwardRecord) -> Path` | **原子替换**（临时文件 + `os.replace`），文件权限固定 `0600`，目录权限 `0700` |
| 读取 | `load(forward_id: str) -> ForwardRecord \| None` | 不存在返回 `None`；**文件损坏抛 `ValidationError`**（含标识/端口非法） |
| 枚举 | `list_all() -> list[ForwardRecord]` / `list_for_sandbox(sandbox: str) -> list[ForwardRecord]` / `find_by_sandbox_port(sandbox: str, container_port: int) -> ForwardRecord \| None` | 枚举时**跳过损坏文件**（一条坏记录不拖垮整批）：JSON 解析失败、**内容不是 JSON 对象**（合法 JSON 但结构不对）、**标识或端口非法**——三种都只记告警并跳过 |
| 删除 | `delete(forward_id: str) -> bool` | 返回是否确实删掉了东西 |
| 文件清单 | `record_files() -> list[Path]` / `temp_files() -> list[Path]` | 全部记录文件（含损坏的）/ 写入残留的 `.forward-*.tmp` |

### 容器命名与标签

| 项 | 取值 |
|---|---|
| 容器名 | `<沙箱名>-fwd-<容器端口>`（例：`demo-fwd-8080`） |
| 标签 | `sandbox-platform.role=forward`、`sandbox-platform.forward.id=<转发标识>`、`sandbox-platform.forward.sandbox=<沙箱名>` |
| 标签用途 | 枚举与回收（`docker ps -a --filter label=sandbox-platform.role=forward`）；容器标签与记录不一致时按遗留处理并重建（Docker 不允许改容器标签） |

> **标签命名空间（两套并存）**：转发容器用 `sandbox-platform.*`（连字符），
> 既有沙箱容器用 `sandbox.platform/*`（斜杠，如 `sandbox.platform/role=sandbox`）。
> 枚举平台自建资源时**两套都要看**，只按一套枚举会漏掉另一套的容器。

**同名容器的处置口径**（`_ensure_container`）：

| 现存容器 | 处置 |
|---|---|
| 标签里的转发标识与记录一致 | 就是本条转发的容器：不在跑就拉起来（幂等） |
| 标识对不上，但带 `sandbox-platform.role=forward`（**平台自建**） | 上次中断留下的遗留容器：删掉重建（标签必须与记录一致） |
| **不带平台标签**（用户自建） | **平台不删**：抛 `ForwardError`（文案写明「与现有非平台容器重名」），请换沙箱/端口或自行处理 |

### 容器规格（无端口发布）

启动参数（`run_args`）固定如下：

| 参数 | 取值 | 说明 |
|---|---|---|
| `--name` | `<沙箱名>-fwd-<容器端口>` | — |
| `--network` | 沙箱的网桥网络名 | 转发容器接入沙箱网络，才能按容器名解析沙箱容器 |
| `--restart` | `no` | 生命周期由平台显式管理 |
| `--label` | 三个平台标签 | 见上表 |
| `--entrypoint` | `/bin/sh` | **必须显式覆盖**：转发镜像的 ENTRYPOINT 是 `socat`，不覆盖就会把 socat 当监听命令跑起来 |
| 命令 | `-c "exec tail -f /dev/null"` | **常驻空转**：容器不监听任何端口，只提供 `socat` 二进制与沙箱网络内的一等公民身份（exec 字节泵的落点） |
| 端口发布 | **无** | 参数里没有 `-p` / `--publish`：宿主侧零端口 |

镜像：`config.forward_image`（默认 `alpine/socat:1.8.1.3@sha256:466c8a…`，**钉 digest**），
经统一镜像代理在**沙箱守护进程内**拉取（复用 `images.py` 的 `ensure_image` 通道）。

### 转发记录结构

落盘路径 `<平台数据根>/forwards/<id>.json`，权限 `0600`，写入走原子替换：

```json
{
  "container_port": 8080,
  "created_at": "2026-11-03T10:31:00+00:00",
  "host_pid": 4711,
  "id": "a1b2c3d4e5f6",
  "sandbox": "demo",
  "state": "running",
  "updated_at": "2026-11-03T10:31:00+00:00"
}
```

- **转发标识（`id`）的生成规则**：`uuid4().hex` 的**前 12 位十六进制**（小写）。
  标识只允许 `[0-9a-f]{8,32}`（记录文件名由它拼出，必须挡住路径分隔符），
  非法标识按 `ValidationError` 拒绝；**载入时也校验**：标识非法的记录当作损坏
  记录处理（整批枚举跳过并告警），不会流到删除路径上。
- **`host_pid`**：建这条记录的**服务进程号**。清理遗留转发时用它判归属：
  归属进程还活着就不是本实例的（见「跨实例保护」）。
- **没有 `host_port`**：链路两点化后后端宿主不持有任何转发端口；
  用户机本机端口由桌面端持有，不进平台记录。

### exec 命令构造口径

`exec_command(record)` 返回**完整命令行**（首元素是 `docker`）：

```
docker exec -i <转发容器> socat - TCP:<沙箱容器名>:<容器端口>
```

- 执行身份：**沙箱的免 root 守护进程**（`UserDaemon.spawn_stream`，与既有终端桥接同一条通道）。
- 管道**非 TTY**：调用方按字节泵语义搬运（写 stdin / 读 stdout），**不加分帧协议**。
- 目标端是**沙箱容器名**（不是宿主回环端口）：后端宿主上不产生任何转发端口。
- 进程回收：一条 TCP 连接对应一个 exec 进程；连接断开时调用方必须
  `BytePump.close()` ——**立即回收，不留僵尸 exec 进程**。
- 回收按**进程组**做：字节泵子进程自带新会话（`start_new_session=True`），
  `close()` 先给整组发 SIGTERM、超时再整组 SIGKILL——`sudo` 前缀下的 docker
  客户端与它拉起的孙进程一并收掉，不留孤儿。`BytePump` 也是上下文管理器
  （`with` 退出即回收）。
- **stderr 排空（字节泵自带）**：exec 的失败原因**只在 stderr 里**，而 stderr
  管道缓冲有限（通常 64KB）——**没人排空时写满就把子进程卡死**（隧道表现为
  「静默 hang」）。`BytePump` 起一个**后台守护线程**持续排空 stderr，只保留
  **尾部**（最后 8KB，属性 `stderr_tail`；线程是否还活着看 `stderr_drain_alive`）。
  尾部内容**只给排查用**（含容器客户端原文与宿主路径），调用方**只进日志**，
  不回显给客户端。`close()` 之后排空线程退出（不留常驻后台线程）。

### 生命周期语义

| 场景 | 口径 |
|---|---|
| 建立转发 | 记录 + 起转发容器（**幂等**：同一沙箱同一端口已有转发则复用既有记录与容器；记录在而容器缺失时按记录幂等重建）。**同名非平台容器不删**，报 `ForwardError` |
| 沙箱停止 | 该沙箱的转发容器一并**停止**（`docker kill`）；**记录保留**（状态置 `stopped`） |
| 沙箱启动 | **不自动重建**；隧道建立时（`open_byte_pump`）若容器缺失则幂等重建 |
| 停止转发 | 删转发容器（`docker rm -f`）+ 删记录；**容器未确认删掉就不删记录** |
| 沙箱删除 | 转发容器与转发记录**纳入回收清单并被回收**（平台自建资源）；删不掉的容器**保留记录**并报进回收清单的 `failed` |
| 后端服务重启 | **全部转发会话丢失**：服务层启动时调用 `purge_leftover()` 清理上次遗留的转发容器与记录（与终端会话「服务重启即丢」同款语义，但**带跨实例保护**：属于另一个仍活着的服务实例的转发记录与容器不动） |
| 隧道连接断开 | 对应的 `docker exec` 字节泵进程**立即回收**（`BytePump.close()`，按进程组回收），不留僵尸进程与孤儿孙进程 |

---

## 7. `lifecycle.py` —— 生命周期编排

### 数据类

| 名称 | 字段 | 说明 |
|---|---|---|
| `CreateRequest` | `name`、`image`（**必填**）、`mount_declarations=()`、`files=()`、`command=None`、`env={}`、`workdir=None`、`network_name=None`、`image_source="auto"` | 创建入参；**镜像必填**：默认镜像已退役，平台没有兜底镜像；`files` 是文件注入声明（`宿主路径:容器路径`） |
| `CreateResult` | `metadata`、`connection`、`steps` | 创建结果；`steps` 是固定 7 步名称 |
| `ConnectionInfo` | `socket_path`、`container_name`、`exec_command`、`docker_command`、`notes` | 连接方式与命令提示（身份切换前缀与实际执行同源：非 root 是 `sudo -u`，root 是 `setpriv`） |
| `ReclaimPlan` | `sandbox_name`、`items`、`untouched_note`、`user_mounts`、`incomplete` | 删除前的回收清单；`untouched_note` 固定为「用户挂载的宿主机目录不受影响」；依赖容器清单 = 元数据已知列表 ∪ 删除前实时扫描（**转发容器按标签剔除，不算依赖容器**），探测失败时保留旧列表并置 `incomplete=True` |
| `DeleteResult` | `name`、`existed`、`removed`、`failed`、`plan` | 删除结果；沙箱不存在时 `existed=False` 且不抛异常；`removed` 是确实回收掉的资源，`failed` 是尝试过但没成功的条目（带原因） |
| `ProxyRestartResult` | `success`、`ca_changed`、`message`、`reinstalled_users`、`failed_users`、`ca_reinstalled` | 重启结果；`ca_changed` 的口径见 11.5；`ca_reinstalled` 表示合并证书链**确实重装过**（CA 变了但新 CA 读不到时为 `False`，不把未修复报成已修复）；`failed_users` 是重装失败的用户（单个用户失败不阻断其余用户） |

### `SandboxService`

| 方法 | 签名 | 说明 |
|---|---|---|
| 构造 | `SandboxService(config: PlatformConfig \| None = None, privilege: Privilege \| None = None)` | 控制面服务入口 |
| 转发编排 | `forwards -> PortForwardManager` | 端口转发编排入口（能力本体在 `forwarding.py`，见 6ter 节）：删除沙箱时回收转发容器与转发记录，沙箱停止时联动停止转发容器 |
| 查询 | `find(name) -> SandboxMetadata \| None` | 不存在返回 `None`；先过沙箱名校验 |
| 查询 | `get(name) -> SandboxMetadata` | 不存在抛 `NotFoundError`；先过沙箱名校验 |
| 列表 | `list() -> list[SandboxMetadata]` | 尽力刷新运行状态（用户已删 → `deleted`） |
| 创建 | `create(request: CreateRequest) -> CreateResult` | 固定 7 步，任一步失败回滚已完成步骤；同名创建串行化并原子占用名字 |
| 启动 | `start(name: str) -> SandboxMetadata` | 复用同一用户、同一子 ID 段、同一守护进程单元；只恢复沙箱容器，依赖容器由使用方自行拉起 |
| 关闭 | `stop(name: str, stop_dependencies: bool = True) -> SandboxMetadata` | 依赖容器是否一并停止由显式参数控制，默认停；**该沙箱的转发容器也一并停止**（转发记录保留） |
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

删除的固定回收清单：**转发容器与转发记录**（平台自建资源，必须排在网络删除之前）→ 沙箱容器与依赖容器 → 网桥网络（仅平台自建）→ 停止并禁用 systemd 用户单元 → 删除用户与家目录 → 回收子 UID/GID 段 → 删除平台元数据。
**用户声明挂载的宿主机目录一律不触碰**（平台不创建、不删除、不修改）。

转发相关的两处兜底（转发侧出错**不中断**沙箱删除/停止）：

- 沙箱停止：转发联动失败只记日志，继续走完停止流程；
- 沙箱删除：转发回收失败进回收清单的 `failed` 列表，其余回收步骤照走。

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
| `ForwardError` | `SandboxError` | 端口转发链路跑不起来（见下） |

> **`ForwardError` 的语义**（与 `NotFoundError`「对象不存在」、`ValidationError`「入参非法」
> 分开）：转发链路本身不成立——**沙箱已停止**（先启动沙箱）、**沙箱网络不存在**、
> **镜像拉不到**、**转发容器起不来**、**容器名与现有非平台容器重名**（平台不删用户的
> 同名容器）、**沙箱守护进程不可达**（探测失败）。
>
> 服务端映射（三期任务 05 已落地，见第 15 章）：这几类基本都是**冲突类**（409）
> 或**依赖缺失**（502/503），而不是入参错误（400）——`沙箱已停止` / `容器名冲突` → 409；
> `网络不存在` → 502；`镜像拉不到` / `启动失败` / `守护进程不可达` → 503。
> 判定按核心包的**固定措辞**进行（服务端的 `classify_forward_error`）：措辞变更时
> 必须同步那张映射表。
>
> **响应只给固定文案**：转发链路的 `detail`（与隧道错误帧）是**固定串**
> （见 15.3 的表），核心异常原文（容器客户端输出、宿主绝对路径、多行文本）
> **只进日志**，不回显。服务端**不再按措辞截取原文**取主干——截取对没有括号的
> 原文（容器客户端的多行输出）完全失效，会把整段原文回显出去。

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
| 监听地址 | 默认 `127.0.0.1:8000`，用 `SANDBOX_CONSOLE_HOST` / `SANDBOX_CONSOLE_PORT` 覆盖；非回环地址启动时打醒目告警（口径：**已启用令牌认证**，但令牌是单一凭据） |
| 前端目录 | 默认 `apps/web/frontend/dist`（前端与后端同在 `apps/web/` 下），用 `SANDBOX_CONSOLE_DIST` 覆盖；目录不存在时跳过静态托管并告警（`/api/health` 的 `console_mounted` 为 false） |
| 接口文档 | `/docs` 与 `/openapi.json` **默认关闭**；用 `SANDBOX_CONSOLE_DOCS=1` 显式开启（接口清单不外泄）。**开启后 `/docs` 与 `/openapi.json` 不受令牌保护**（中间件只拦 `/api` 前缀），仅限本机排查时临时开启，排查完关掉 |
| 错误响应体 | 统一 `{"detail": "中文消息"}`；400 / 404 / 409 保留平台异常原文，500 只给固定文案（原文只进日志） |
| 鉴权 | **全部 `/api`（含终端 WebSocket）受访问令牌保护**；`/api/health` **不豁免**；详见第 14 章 |
| 跨源 | **CORS 放行任意来源**（响应头 `Access-Control-Allow-Origin: *`）；WebSocket 握手**不再校验 `Origin`**——准入边界只有令牌与票据（2026-11-03 用户决策，详见 14.4） |

创建接口支持两类路径声明：**挂载**（`mounts`，平台不处置宿主目录）与
**文件注入**（`files`，平台把宿主文件复制一份再只读挂进容器）。注入副本落在
沙箱用户家目录内的暂存目录 `.sandbox-files`，**随沙箱删除时家目录回收一起消失**；
复制是**创建时快照**，宿主原件之后的变更不回灌到沙箱（原件本身零接触）。

**注入源的可见范围（信任边界）**：

- 注入源由平台**以特权身份读取**（复制动作走特权通道）：控制台 / 命令行的调用者
  被视为平台受信主体，**文件注入不提供跨账号隔离**；
- 源路径不得位于**任何沙箱用户家目录**内（含目标沙箱自己的家目录）：命中即 400，
  文案为「注入的宿主路径落在沙箱用户家目录内，不允许注入：{路径}（含本次沙箱自己的家目录）」；
- 源路径同样不得命中宿主敏感清单（`/etc` `/proc` `/root` 等、平台数据根、宿主
  Docker 套接字），且**词法归一化 + 解析后真实路径双重校验**
  （`/tmp/../etc/passwd`、`//etc/shadow`、以及中间路径段是符号链接的情形都绕不过去）。


### 11.1 路由表

| 方法 | 路径 | 请求体 | 响应体 | 对应的核心接口 |
|---|---|---|---|---|
| GET | `/api/health` | — | 服务自检（版本、数据根是否就绪、前端是否挂载） | — |
| POST | `/api/auth/ticket` | —（`Authorization: Bearer <令牌>`，**受令牌保护**） | `{"ticket": "...", "expires_in": 30}` | 一次性票据（见第 14 章；30 秒有效、用过即废） |
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

> 三期新增的**端口转发接口**（三条 REST + 隧道 WebSocket）见**第 15 章**。

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
| `files` 声明非法（格式错、敏感路径、符号链接、宿主路径不存在、重复声明、撞挂载点、落在任何沙箱用户家目录内） | 400 | `{"detail": "平台异常原文"}` |
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

> **特权端点的风险说明（已收窄）**：`POST /api/proxy/restart` 能打断正在拉镜像的沙箱（代理不可达时创建 / 启动直接失败）。三期起它不再是「未认证的特权端点」——**全部 `/api` 都受令牌保护**（见第 14 章）。但令牌是**单一凭据**：拿到它即拥有平台的全部能力。回环这一跳没有网络边界保护（本机任意进程都能连上端口），但接口仍要求令牌；令牌是唯一准入门槛。


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
| WS | `/api/terminal/sessions/{session_id}` | 见 12.3 帧协议（**握手需带 `?ticket=` 一次性票据**） | 二进制帧 + 文本帧 | 附着到已有会话（先回放缓冲再接实时流） |

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

1. 浏览器先用 `POST /api/auth/ticket`（带 `Authorization: Bearer <令牌>`）换一张
   **一次性票据**（浏览器 `WebSocket` API 不能设自定义头，见第 14 章）；
2. 浏览器连上 `WS /api/terminal/sessions/{session_id}?ticket=<票据>`，同时带自身
   `Origin`（**服务端不再校验来源**，2026-11-03 用户决策）；
3. 服务端校验票据（**校验即作废**），过了才 `accept`；不过就
   **握手在 accept 前被拒**——生产环境（uvicorn）对客户端表现为 HTTP 403、
   关闭码不送达；TestClient 下表现为 `WebSocketDisconnect(1008)`，属测试语义；
4. 服务端先登记附着（连接数加一），再回 `hello`；
5. 接着把环形缓冲里的历史输出作为二进制帧**回放**（单帧不超过 64 KiB，超出就切多帧），之后接实时流；
6. 浏览器断开：容器内进程不退出，输出继续写进环形缓冲，重连同一 `session_id` 即可恢复现场；
7. 服务重启：全部会话失效（见 12.4），旧 `session_id` 不可再附着。

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
| 内置种子 | 常量 `BUILTIN_TEMPLATES`：**清单一条** `tpl_pi_dev`（pi agent）——配置体**只含 `files` 一个键**，五条文件注入声明逐字原样：`~/.ssh:/root/.ssh`（ssh 整目录）、`~/.pi/agent/auth.json:/root/.pi/agent/auth.json`、`~/.pi/agent/models-store.json:/root/.pi/agent/models-store.json`、`~/.pi/agent/models.json:/root/.pi/agent/models.json`、`~/.pi/agent/settings.json:/root/.pi/agent/settings.json`（四条 pi 文件的容器侧路径同为 `/root/.pi/agent/` 下同名文件）；**启动时**按标识注入，**每次列表读取都补注入**；同标识文件已存在不覆盖；删了写墓碑、不复活。将来加一条即自动生效 |
| 内置模板的前置条件 | `~` 展开以**控制台服务运行用户的家目录**为目标：按仓库自带的 systemd 单元（`User=root`）部署时，五条宿主路径都展开到 `/root` 之下，命中核心包的宿主敏感目录拒绝清单，创建沙箱返回 400——**该模板要求服务以持有这些凭证的非 root 用户运行**（该用户家目录里须有 `~/.ssh` 与 `~/.pi/agent/`）。这是既有 `~` 展开契约的自然结果，不是缺陷 |
| 内置模板的信任边界 | 该模板会把宿主 ssh 私钥与 pi 凭证**复制成只读副本**注入沙箱（宿主原件零接触；副本是创建时的快照，原件之后的改动不回灌；副本以只读方式挂进容器）。控制台服务的接口受令牌保护（见第 14 章），但令牌是单一凭据，拿到它即拥有平台的全部能力——**仅适用于本机单人部署场景** |
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

---

## 14. 认证（访问令牌 / 一次性票据 / 跨源放行）

三期起，后端从「同源无认证」改成「独立 API + 令牌认证」：**全部 `/api`（含终端 WebSocket）受访问令牌保护**。
契约依据 [[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 第 3、4 节。

> **2026-11-03 用户决策（跨源口径放宽）**：CORS 改为**放行任意来源**；WebSocket 握手的
> `Origin` 校验**一并取消**。理由：`Origin` 不是安全边界（同源判定基于可伪造的 `Host` 头，
> 可被 DNS rebinding 绕过），**真正的准入边界是令牌与票据**——这两项口径不变。
> 本章中「CORS 白名单」「Origin 白名单/同源放行」等旧表述按新口径改写。

| 项 | 口径 |
|---|---|
| 令牌性质 | **单一访问凭据**：不做账号体系、不做多用户隔离、不做分级与吊销。拿到令牌即拿到平台的全部能力 |
| 令牌来源 | 环境变量 `SANDBOX_CONSOLE_TOKEN` 注入优先（**不落盘**）；未注入时服务启动自动生成，落 `<平台数据根>/console-token.json`（权限 `0600`，原子写入） |
| 令牌生成 | `sbx_` 前缀 + `secrets.token_urlsafe(32)` |
| 服务起不来的情形 | 令牌解析失败（数据根不可写等）→ 服务**启动失败**，不会在没有令牌的状态下对外提供接口 |
| 启动日志 | **只打令牌来源与文件路径，不打令牌本体** |
| 令牌比对 | 一律 `hmac.compare_digest`（常量时间）；源码里不出现对令牌的 `==` / `in` 比较 |
| 请求头 | `Authorization: Bearer <令牌>` |
| 认证失败 | `401` + `{"detail": "访问令牌无效或缺失"}`；**缺失与错误不区分**，不回显令牌，不把令牌写进日志 |
| 拦截范围 | **只拦 `/api` 前缀**：静态资源（`/`、`/assets/*`、`/fonts/*`）与 `/docs`、`/openapi.json` 不拦 |
| 接口文档开关 | `/docs` 与 `/openapi.json` **默认关闭**，用 `SANDBOX_CONSOLE_DOCS=1` 显式开启。**开启时这两个路径不受令牌保护**（令牌闸只拦 `/api` 前缀），且 CORS 已放行任意来源 → **现已跨源可读**（任意网页都能拿到接口清单）。**仅限本机排查时临时开启，排查完关掉** |
| `/api/health` | **不豁免**：没令牌同样 401。401 也是健康口径的一部分——前端靠它区分「后端不可达」与「令牌无效」 |
| WebSocket 路由准入 | 中间件对 WS scope **默认拒绝**（fail-closed）：只有显式登记的 WS 路由才放行到路由层——终端 WS 登记在**豁免清单**（票据闸在路由侧），隧道 WS 登记在 **Bearer 清单**（中间件校验 `Authorization: Bearer`，桌面端 Rust 客户端能设请求头）。**两份清单都没登记的 WS 路由一律拒握手**：将来新增 WS 路由而忘了写鉴权时，默认被拒（不是裸奔） |
| 票据 | `POST /api/auth/ticket` → `{"ticket": "...", "expires_in": 30}`；一次性、30 秒过期、进程内存态 |
| 票据过期判定 | 单调时钟（`time.monotonic`），不受系统时间调整影响 |
| CORS 放行来源 | **任意来源**（`allow_origins=["*"]`）：响应头是 `Access-Control-Allow-Origin: *` |
| CORS 其余项 | `allow_credentials=False`（不用 Cookie 认证，凭据走显式的 `Authorization` 头）；方法 `GET` / `POST` / `DELETE` / `OPTIONS`；头 `Authorization` / `Content-Type`（**这两份白名单不变**） |
| WebSocket Origin | **已取消校验**（2026-11-03 用户决策）：握手不再看 `Origin`，只认票据。见 14.4 |

### 14.1 令牌来源与落盘

| 情形 | 行为 |
|---|---|
| 注入了 `SANDBOX_CONSOLE_TOKEN` | 用注入值；**不写令牌文件**（磁盘上不留痕迹）；启动日志写「环境变量注入」 |
| 未注入、令牌文件已存在 | 沿用文件里的令牌（重启不变）；启动日志打文件路径 |
| 未注入、令牌文件不存在 | 生成一个（`sbx_` + 32 字节随机），原子写入 `<平台数据根>/console-token.json`（`0600`）；启动日志打文件路径 |

令牌文件格式（JSON）：

```json
{
  "token": "sbx_xxxxxxxx",
  "created_at": "2026-11-03T09:00:00+00:00"
}
```

写入口径：写临时文件 → 改权限 `0600` → 原子替换（进程中断不留半截文件，权限位不受进程 umask 影响）。

**轮换令牌**（本期只支持这一种）：删掉令牌文件后重启服务，或改 `SANDBOX_CONSOLE_TOKEN` 后重启。

### 14.2 请求方式

```bash
# 健康自检（/api/health 同样要令牌）
curl -s -H 'Authorization: Bearer <令牌>' http://127.0.0.1:8000/api/health

# 换一张一次性票据
curl -s -X POST -H 'Authorization: Bearer <令牌>' \
    http://127.0.0.1:8000/api/auth/ticket
# → {"ticket": "sbxt_xxxxxxxx", "expires_in": 30}
```

`Authorization` 头缺失、不是 `Bearer`、或令牌为空，都按认证失败处理（401）。

### 14.3 票据流程（为什么浏览器 WebSocket 不能带自定义头）

浏览器的 `WebSocket` API **不支持设置自定义请求头**，所以终端 WebSocket 没法直接带
`Authorization: Bearer`。为此单开一条票据通道：

```
POST /api/auth/ticket        （带 Authorization: Bearer <令牌>）
        ↓ 换到
?ticket=<票据>                （WS 握手时带上，30 秒内有效）
        ↓ 校验即作废
WS 握手通过
```

| 口径 | 说明 |
|---|---|
| 一次性 | 校验通过即从存储里摘掉：同一张票据第二次握手必然失败 |
| 有效期 | 30 秒（`expires_in` 回 30）；过期判定走单调时钟 |
| 存放位置 | **进程内存态**：不落盘、不跨进程；服务重启后已签发的票据全部失效 |
| 不放长期令牌进 URL | URL 会进访问日志与中间代理日志：长期令牌只走 `Authorization` 头 |
| 票据也会进访问日志 | 票据走 `?ticket=` 查询参数，**同样会进 uvicorn 访问日志（query string 原样记录）**。靠「30 秒过期 + 用过即废」把暴露窗口压到最小：日志里那条记录很快就没用了 |
| 终端 WS 的唯一通道 | 终端 WebSocket **只接受一次性票据**（Bearer 头不进终端 WS 的握手） |
| 非浏览器客户端 | 桌面壳的 Rust 客户端能设请求头，走 `Authorization: Bearer` 直连——**端口转发隧道已用它落地**（三期任务 05，见第 15 章：隧道 WS 走 Bearer 通道，不绕票据） |

### 14.4 CORS 与 WebSocket Origin 口径

**2026-11-03 用户决策**：CORS 放宽到**任意来源**；WebSocket 握手的 `Origin` 校验**一并取消**。
两者是同一条决策的两面——**来源从来不是安全边界，准入边界只有令牌与票据**。

| 场景 | 来源 | 结果 |
|---|---|---|
| HTTP 请求，任意来源 | 任何 `Origin`（含 `http://evil.example`） | 放行：响应带 `Access-Control-Allow-Origin: *` |
| HTTP 预检（`OPTIONS`），任意来源 | 任何 `Origin` | 放行（`200`；预检本身不带 `Authorization` 头，令牌闸不拦预检） |
| WebSocket 握手，**任意来源**（或不带 `Origin`） | 任何 `Origin` | **放行**（只要票据有效）；握手不再看来源 |
| WebSocket 握手，**票据无效 / 缺失** | 任意 `Origin` | **握手在 accept 前被拒**：生产环境（uvicorn）对客户端表现为 HTTP 403、关闭码不送达；TestClient 下表现为 `WebSocketDisconnect(1008)`，属测试语义 |
| WebSocket 握手，**未登记的 WS 路由** | 任何不在豁免清单内的路径 | **握手在 accept 前被拒**（中间件 fail-closed，不进路由层） |

**CORS 其余项不变**：`allow_credentials=False`；方法 `GET` / `POST` / `DELETE` / `OPTIONS`；
头 `Authorization` / `Content-Type`。

**为什么取消 Origin 门禁**：

- 同源判定基于请求的 `Host` 头，**可被 DNS rebinding 绕过**（攻击者让域名解析到回环地址，
  `Host` 头就跟着变成回环地址）；白名单也只是「减少误伤、挡住顺手发起的跨源连接」的辅助闸。
- 真正决定「能不能拿到数据」的是**令牌与票据**（见 14.2、14.3）：没有令牌就换不到票据，
  没有票据就连不上终端 WS——这两道闸一个都没动。
- 代价是响应头里会出现 `Access-Control-Allow-Origin: *`（旧口径里「不出现通配符」一条已作废）。
  本服务不用 Cookie 认证（`allow_credentials=False`，凭据走显式的 `Authorization` 头），
  通配符与浏览器默认的 `credentials: 'same-origin'` 不冲突。

### 14.5 绑非回环地址时的告警口径

| 旧口径（二期） | 新口径（三期） |
|---|---|
| 「本服务不做认证也不做多用户隔离，只能在可信内网使用，严禁暴露到公网」 | 「本服务**已启用令牌认证**（全部 `/api` 受令牌保护），但令牌是**单一凭据**，拿到它即拥有平台的全部能力；仍不得暴露到公网，且务必把令牌文件（0600）交给可信的人」 |

网络边界从**第一层**降级为**第二层**：令牌是硬需求，但令牌不解决多用户问题。

### 14.6 服务端模块

| 模块 | 职责 |
|---|---|
| `sandbox_console/auth.py` | 令牌来源解析与落盘、常量时间比对、票据存储、Bearer 认证中间件（含 WS 的 fail-closed 准入：**豁免清单** = 路由自己鉴权，**Bearer 清单** = 中间件校验令牌）；**跨源只管 CORS 放行任意来源，不再有 Origin 判定** |
| `sandbox_console/routes/auth.py` | `POST /api/auth/ticket`（票据签发；**必须是 `async def`**——票据存储仅限事件循环单线程使用） |
| `sandbox_console/app.py` | 挂中间件（**外层跨源放行、内层令牌认证**）、启动时解析令牌并打日志、启动时清理遗留转发、退出时关掉活动隧道 |
| `sandbox_console/routes/terminal.py` | 终端 WS 握手校验（**只认票据**；2026-11-03 起不再校验 `Origin`） |
| `sandbox_console/routes/forwards.py` | 端口转发：三条管理 REST + 隧道 WS（握手校验 **Bearer**，见第 15 章） |

中间件顺序要紧：跨源放行在**外层**，预检请求由它直接应答，不会落到内层的令牌闸上
（预检本来就不带 `Authorization` 头）。

令牌闸对 WebSocket 是 **fail-closed**：两份清单里显式登记的 WS 路由才放行到路由层
——**豁免清单**（`auth.WEBSOCKET_EXEMPT_PATHS`，当前是终端 WS）放行后由路由自己校验
票据；**Bearer 清单**（`auth.WEBSOCKET_BEARER_PATHS`，当前是端口转发隧道）由**中间件**
校验 `Authorization: Bearer`，不通过就在 accept 前拒握手。两份清单都没登记的 WS 路由
一律拒握手。新增 WS 路由要同时改两处——**登记到对应清单**与**路由自身的鉴权**。

### 14.7 部署口径（本批改动的边界）

| 事项 | 口径 |
|---|---|
| 前端未跟上之前网页控制台不可用 | 本批改动（任务 02）落地后，**前端（任务 03 之前）不发 `Authorization` 头、也不换票据**：网页控制台在 03 合并前**不可用**（`/api` 全部 401，终端 WS 换不到票据）。这是令牌硬需求的必然结果，不是缺陷 |
| 不得单独部署 | **02 不得单独部署到在跑的网页控制台**，必须与 03 **同批发布**：否则已上线的网页控制台会当场失效（拿不到数据） |
| 直接调接口的脚本 | 后端契约已变（全部 `/api` 要令牌）：任何直调 `/api` 的脚本、监控与运维命令都要补上 `Authorization: Bearer <令牌>` |
| 回环这一跳 | 回环这一跳**没有网络边界保护**（本机任意进程都能连上端口），但接口仍要求令牌；**令牌是唯一准入门槛** |

---

## 15. 端口转发接口（转发管理 REST + 隧道 WebSocket）

端口转发把「沙箱里的某个容器端口」经一条隧道送到**用户机本机**。链路**只有两点**
——「沙箱 ⇄ 用户机」——后端宿主是**纯中继**：**既不发布转发端口，也不监听转发端口**
（用户机本机的监听端口由桌面端持有，**不进平台记录**）。

机制依据 [[architecture/decisions/0014-端口转发机制选型.md|ADR 0014]]（第二次修订，
决策 C）。能力本体在核心包 `sandbox_platform.forwarding`（见 6ter）：转发容器起停、
转发记录读写、字节泵进程的执行与回收全在核心包里，**服务端只做编排与转译**
（服务端源码不含任何宿主命令直调）。

### 15.1 路由表

| 方法 | 路径 | 入参 | 出参 | 说明 |
|---|---|---|---|---|
| GET | `/api/forwards` | 查询参数 `sandbox`（可选） | `ForwardModel[]`（**裸数组**，不包对象） | 列出转发记录；给了沙箱名则只列该沙箱的 |
| POST | `/api/forwards` | `ForwardCreateRequest` | 201 + `ForwardModel` | 建立转发（**幂等**：同一沙箱同一容器端口已有转发则复用既有转发，不重复起容器） |
| DELETE | `/api/forwards/{forward_id}` | — | `ForwardDeleteResponse` | 停止转发：删转发容器 + 删记录（**没有「释放端口」动作**——宿主侧无端口）。**幂等口径**：首次停止 → 200 + 处理清单；**重复停止同一转发 → 404**（已无可停的东西，按「不存在」报，不回显标识） |
| WS | `/api/forward/tunnel/{forward_id}` | 帧协议见 15.4（**握手带 `Authorization: Bearer`**） | 二进制帧 + 文本帧 | 隧道：把转发上的字节接到本连接（**一条 WS 对一条 TCP 连接**，本期不做多路复用） |

> 三条转发 REST 与其它 `/api` 接口**同受 Bearer 令牌保护**（见第 14 章）：
> 不带令牌 / 令牌不对 → **401**。

### 15.2 请求与响应字段

`ForwardCreateRequest`（`extra="forbid"`，多传字段直接 400）：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `sandbox` | `str` | 必填 | 沙箱名（转发挂在哪个沙箱上） |
| `port` | `int` | 必填 | **容器端口**（转发目标端口）；用户机本机端口由桌面端持有，不进平台记录 |

`ForwardModel`（一条转发记录）：

| 字段 | 说明 |
|---|---|
| `id` | 转发标识（12 位十六进制） |
| `sandbox` | 所属沙箱名 |
| `container_port` | 转发目标端口（容器端口） |
| `state` | 转发状态：`running`（可用）/ `stopped`（已随沙箱停止，**记录保留**） |
| `created_at` / `updated_at` | 建立与最近变更时间 |

> **没有宿主端口字段**：响应模型与本节接口**不出现 `host_port`**——链路两点化后
> 后端宿主不持有任何转发端口（决策 C）。

`ForwardDeleteResponse`（停止转发的结果）：

| 字段 | 说明 |
|---|---|
| `id` | 被停止的转发标识 |
| `removed` | 确实处理掉的条目（如「转发记录 xxx」「转发容器 xxx」） |
| `failed` | 尝试过但没成功的条目（带原因，如实上报，不吞掉） |

### 15.3 错误码映射

| 场景 | 状态码 | 响应体 |
|---|---|---|
| 沙箱不存在 | 404 | `{"detail": "平台异常原文"}` |
| 端口非法 | 400 | `{"detail": "容器端口非法：70000（应为 1~65535）"}` |
| 请求体不合法（缺字段 / 类型不对 / 多余字段） | 400 | `{"detail": "请求参数不合法：字段（原因）"}` |
| 沙箱已停止 | 409 | `{"detail": "沙箱已停止，无法建立端口转发（请先启动沙箱）"}` |
| 容器名与现有非平台容器重名 | 409 | `{"detail": "容器名已被占用：与现有非平台容器重名（请换一个沙箱或端口，或自行处理同名容器）"}` |
| 沙箱网络不存在 | 502 | `{"detail": "沙箱网络不存在，无法建立端口转发"}` |
| 镜像拉不到 | 503 | `{"detail": "转发镜像不可用（镜像拉不到）"}` |
| 转发容器起不来 | 503 | `{"detail": "启动转发容器失败"}` |
| 沙箱守护进程不可达（探测失败） | 503 | `{"detail": "转发链路探测失败（沙箱守护进程不可达）"}` |
| 转发不存在 / 标识非法（停止转发） | 404 | `{"detail": "端口转发不存在或已失效"}`（**不回显**用户输入的标识） |
| 转发记录损坏（停止转发） | 404 | `{"detail": "端口转发不存在或已失效"}`（**不回显**宿主绝对路径） |

映射口径：`ForwardError`（转发链路跑不起来，与「对象不存在」「入参非法」分开）按
核心包的**固定措辞**判定状态码——**沙箱已停止 / 容器名冲突 → 409**、
**网络不存在 → 502**、**镜像 / 启动失败 / 守护进程不可达 → 503**；
镜像拉不到按**异常类型**（`ImageNotFoundError`）判：**转发链路的镜像失败语义是
「转发服务暂不可用」（503）**，400 只留给真正的请求参数错误。
措辞变更时**必须同步**服务端的映射表（`sandbox_console/errors.py` 的
`classify_forward_error`）。其余平台异常仍按 11.4 的既有口径。

> **转发链路的响应只给固定文案**：上表里的 `detail` 全是**固定串**，核心异常
> 原文（容器客户端输出、宿主绝对路径、探测细节、多行文本）**只进日志**
> （日志键：`forward-error` / `forward-image`），**不回显**到响应里。
> 服务端**不再按措辞截取原文**取主干——截取对没有括号的原文（容器客户端的
> 多行输出）完全失效，会把整段原文回显出去。
> 隧道错误帧（15.4）**同一口径**：只给固定文案。

### 15.4 隧道 WebSocket（路径 / 鉴权 / 帧协议 / 关闭码）

| 项 | 口径 |
|---|---|
| 路径 | `WS /api/forward/tunnel/{forward_id}`（**REST 是 `/api/forwards`（复数），隧道是 `/api/forward/tunnel`（单数）**） |
| 鉴权 | **`Authorization: Bearer <令牌>`**：桌面端 Rust 客户端能设自定义头，**直接走 Bearer 通道，不需要票据**（票据只服务浏览器侧的终端 WS）。中间件校验一道，路由再核一道（纵深防御） |
| 准入 | 令牌缺失 / 错误 → **握手在 accept 之前被拒**（生产环境表现为 HTTP 403；TestClient 下是 `WebSocketDisconnect(1008)`） |
| 转发不存在 | 回一条错误帧（`{"type":"error","message":"端口转发不存在或已失效"}`）后按 **1008** 关闭 |
| 转发已停止 / 链路不成立 | 沙箱停过 → 字节泵起不来（核心包抛转发链路异常）→ 回一条错误帧后按 **1008** 关闭。**沙箱重启过的不算「已停止」**：核心包在隧道建立时幂等重建转发容器，隧道照常可用 |
| 记录在但沙箱已删 / 记录损坏 | 字节泵起不来（沙箱不存在 / 记录损坏）→ 回一条错误帧后按 **1008** 关闭（**不是** 1011 的无错误帧关断） |
| 字节泵异常结束（exec 失败） | 失败原因**只在 stderr 里** → 服务端把 stderr 尾部**只进日志**，并给客户端发一条**原因帧**（`{"type":"error","message":"字节泵异常结束（转发链路执行失败），详见服务日志"}`）后按 **1011** 关闭 |
| 正常关闭 | **1000**（任一侧 EOF / 断开后服务端把另一侧也收掉） |
| 服务退出兜底 | **1001**（服务端主动关掉活动隧道，客户端据此重连）。**服务退出后新来的连接**：登记表已置「正在关闭」标志 → 连接**立即按 1001 关掉**，字节泵照常回收 |

帧协议（与终端桥接同款心智：**二进制 = 字节，文本 = 控制**）：

| 方向 | 帧类型 | 载荷 | 说明 |
|---|---|---|---|
| 客户端 → 服务端 | 二进制 | 透传字节 | 原样写进字节泵的 stdin |
| 客户端 → 服务端 | 文本 | `{"type":"hello"}` | 客户端握手：服务端回一条 `hello` |
| 客户端 → 服务端 | 文本 | `{"type":"error","message":".."}` | 客户端自报的隧道错误：服务端记日志，不回帧 |
| 服务端 → 客户端 | 二进制 | 透传字节 | 字节泵的 stdout（原样透传，不加任何分帧协议） |
| 服务端 → 客户端 | 文本 | `{"type":"hello","forward_id":..,"sandbox":..,"container_port":..}` | 隧道建立成功（accept 后立即发一条） |
| 服务端 → 客户端 | 文本 | `{"type":"error","message":".."}` | 转发不存在 / 链路不成立 / 指令非法 / **字节泵异常结束（原因帧）** |

> **错误帧只给固定文案**：与 REST 的 `detail` **同一口径**（见 15.3）——
> 核心异常原文（容器客户端输出、宿主绝对路径、多行文本）**只进日志**，
> 不进错误帧。帧里的文案是**固定串**（如「启动转发容器失败」「沙箱不存在或已删除，
> 端口转发已失效」）。

时序：

1. 客户端带 `Authorization: Bearer <令牌>` 发起握手；
2. 服务端校验令牌（中间件 + 路由各一道），过了才 `accept`；
3. 服务端按 `forward_id` 取转发记录：不存在 → 错误帧 + 1008；
4. 服务端起字节泵（核心包 `open_byte_pump`：转发容器缺失则幂等重建），
   起不来 → 错误帧 + 1008（沙箱已删 / 记录损坏也走这条）；
5. 服务端发 `hello` 帧，随后两个方向各自搬运：客户端二进制帧 → 字节泵 stdin，
   字节泵 stdout → 客户端二进制帧；
6. 任一侧 EOF / 断开 → 服务端收泵（回收字节泵进程）+ 关掉另一侧（1000）；
   字节泵带 stderr 异常结束 → **原因帧** + 1011；
7. 服务重启 → 全部隧道失效（见 15.6）。

### 15.5 字节泵机制与 exec 进程回收

- **字节通道只有一条**：`docker exec -i <转发容器> socat - TCP:<沙箱容器>:<端口>`
  （在沙箱的免 root 守护进程下执行）。目标端是**沙箱容器名**，不是宿主回环端口：
  **后端宿主上不产生任何转发端口**。
- **一条 TCP 连接 = 一个 exec 进程**：隧道建立时起一条字节泵，连接断开即
  `BytePump.close()`——**按进程组回收**（先 SIGTERM、超时再 SIGKILL），
  **不留僵尸 exec 进程与孤儿孙进程**。
- **stderr 有人排空**（核心包字节泵自带）：exec 的失败原因**只在 stderr 里**，
  而 stderr 管道缓冲有限（通常 64KB）——**没人排空时写满就把子进程卡死**
  （隧道表现为「静默 hang」）。字节泵起一个**后台守护线程**持续排空 stderr，
  只保留**尾部**（最后 8KB）。服务端在字节泵异常结束时把尾部**只进日志**
  （日志键 `forward-pump-failed`），并给客户端发一条**固定文案**的原因帧。
- **服务端只搬字节**：写入是裸管道写（**可能部分写入**，服务端循环写完），
  读取是阻塞读（服务端放到线程里做，事件循环不参与阻塞 I/O）。
- **取舍（本期口径）**：按**简单串行泵**实现——一条隧道两个方向各一个搬运任务，
  任一侧结束就取消另一侧并收泵。
- **字节泵 I/O 走专用线程池**（容量 32，模块级单例）：字节泵的读写是**阻塞式**
  的，若与事件循环的默认执行器共用，并发隧道一多就互相等线程（**饿死**，默认池
  只有十几个），REST 接口也会被拖慢。独立池之后：字节泵最多占 32 个线程
  （一条隧道最多 2 个：读 + 写），**超过就排队**（不饿死其它接口），**REST 不受影响**。

### 15.6 生命周期语义

| 场景 | 口径 |
|---|---|
| 建立转发 | 转发记录 + 起转发容器（**幂等**：同一沙箱同一容器端口已有转发则复用既有记录与容器；记录在而容器缺失时按记录幂等重建）。**同名非平台容器不删**，报冲突（409） |
| 沙箱停止 | 该沙箱的转发容器一并**停止**；**记录保留**（状态置 `stopped`） |
| 沙箱启动 | **不自动重建**；隧道建立时（字节泵）若容器缺失则幂等重建 |
| 停止转发 | 删转发容器 + 删记录；**容器未确认删掉就不删记录**（记录是唯一收口凭据） |
| 沙箱删除 | 转发容器与转发记录**纳入回收清单并被回收**（核心包生命周期联动） |
| **后端服务重启** | **全部转发会话丢失**：服务层启动时调用核心包的 `purge_leftover()`，清理上次遗留的转发容器与记录（与终端会话「服务重启即丢」同款语义，但**带跨实例保护**：属于另一个**仍在运行**的服务实例的转发记录与容器不动） |
| 服务退出 | 活动隧道**全部关掉**（对应的字节泵进程一并回收，不留僵尸进程） |
| 桌面端断开 | 隧道 WS 断开即回收字节泵进程；界面显示「转发已断开」 |
| 隧道连接断开 | 对应的 exec 字节泵进程**立即回收**（按进程组回收），不留僵尸进程 |

### 15.7 服务层新增模块

| 模块 | 职责 |
|---|---|
| `sandbox_console/forwards.py` | 转发服务端的装配层：活动隧道登记表（服务退出统一关掉 + 「正在关闭」标志）、字节泵写入循环（部分写入要循环）、字节泵 I/O **专用线程池**（32 线程）、stderr 尾部取用（只进日志）、关闭码常量 |
| `sandbox_console/routes/forwards.py` | 三条转发管理 REST + 隧道 WebSocket（握手校验、字节泵桥接、控制帧处理） |
| `sandbox_console/deps.py` | 转发编排入口（**取生命周期服务持有的那一个，不另建实例**）与活动隧道登记表的依赖注入（只有 WS 版：REST 侧用不到登记表） |

