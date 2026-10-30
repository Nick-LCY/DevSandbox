# 控制面核心模块接口

一期由 `platform/cli/sandboxctl.py` 调用；二期将由**同一批模块**暴露为 FastAPI 路由，行为与一期等价。

约定：

- 核心模块只返回数据与抛异常，不做参数解析、不直接输出。
- 所有宿主特权操作通过 `Privilege` 包装：进程本身是 root 时直接执行，否则走免密 `sudo`。
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
| `default_image` | `str` | `sandbox-platform/sandbox-default` | `SANDBOX_PLATFORM_IMAGE` | 默认沙箱镜像 |
| `socket_mount_path` | `str` | `/var/run/docker.sock` | `SANDBOX_PLATFORM_SOCKET_MOUNT` | 套接字在容器内的路径 |
| `proxy_image` | `str` | `rpardini/docker-registry-proxy:0.8.0` | `SANDBOX_PLATFORM_PROXY_IMAGE` | 统一镜像代理镜像 |
| `proxy_port` | `int` | `3128` | `SANDBOX_PLATFORM_PROXY_PORT` | 代理在宿主回环上的监听端口 |
| `proxy_address` | `str` | `127.0.0.1` | `SANDBOX_PLATFORM_PROXY_ADDRESS` | 沙箱守护进程访问代理用的地址（见下注） |
| `proxy_registries` | `tuple[str, ...]` | `docker.io ghcr.io quay.io gcr.io registry.k8s.io` | `SANDBOX_PLATFORM_PROXY_REGISTRIES` | 代理拦截并缓存的仓库清单（空格分隔） |
| `system_ca_bundle` | `Path` | `/etc/ssl/certs/ca-certificates.crt` | `SANDBOX_PLATFORM_SYSTEM_CA_BUNDLE` | 宿主系统 CA 束（与代理 CA 合并成单个文件） |
| `local_image_prefixes` | `tuple[str, ...]` | `sandbox-platform/` | `SANDBOX_PLATFORM_LOCAL_IMAGE_PREFIXES` | 平台自建镜像前缀：这类镜像由宿主导出注入，不走代理 |

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
| 解析单条 | `parse_mount_declaration(declaration: str, *, extra_forbidden: Iterable[str \| Path] = ()) -> MountSpec` | 解析 `宿主路径:容器路径[:ro]`；宿主路径必须已存在且是绝对路径，平台不代为创建；路径含逗号一律拒绝；命中敏感清单（`/etc` `/proc` `/sys` `/dev` `/boot` `/root`、宿主 Docker 套接字、追加项如平台数据根）一律拒绝 |
| 解析多条 | `parse_mounts(declarations: list[str] \| tuple[str, ...] \| None, *, extra_forbidden: Iterable[str \| Path] = ()) -> list[MountSpec]` | 逐条解析并校验容器内路径不重复 |
| 敏感清单 | `sensitive_host_paths(extra: Iterable[str \| Path] = ()) -> tuple[str, ...]` | 固定敏感清单 + 调用方追加项（平台数据根由调用方追加） |
| 固定挂载 | `socket_mount(socket_path: str, container_path: str) -> MountSpec` | 平台唯一固定挂载（角色 `socket`） |
| 转参数 | `MountSpec.to_docker_args() -> list[str]` | 生成 `--mount type=bind,src=…,dst=…[,readonly]` |
| 拼参数 | `mounts_to_docker_args(mounts: list[MountSpec]) -> list[str]` | 多条挂载拼成一段参数 |
| 文本化 | `describe_mounts(mounts: list[MountSpec]) -> str` | 人类可读清单 |

`MountSpec` 字段：`host_path: str`、`container_path: str`、`read_only: bool`、`role: str`（`socket` / `user`）。

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

`UserDaemon(context: UserContext, privilege: Privilege | None = None)` 全部方法都以沙箱用户身份执行（`sudo -u <用户> env -i …`，带 `XDG_RUNTIME_DIR` 与 `DOCKER_HOST`）。

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

---

## 6. `images.py` —— 镜像可用性

平台不再维护离线镜像包（ADR 0008）：沙箱免 root 守护进程自己的 `docker pull`
经统一镜像代理完成，平台只管两条路径。

| 函数 | 签名 | 说明 |
|---|---|---|
| 保证可用 | `ImageManager.ensure_image(image: str, daemon: UserDaemon) -> str` | 顺序：沙箱守护进程已有 → 平台自建镜像（`local_image_prefixes` 前缀匹配）由宿主导出注入 → 其余交给沙箱守护进程经镜像代理拉取；返回来源标记（`present` / `injected` / `remote`） |
| 按来源准备 | `ImageManager.ensure_image_from_source(image: str, daemon: UserDaemon, source: str = "auto") -> str` | `auto` 同上；`host` 强制从宿主导出注入，宿主无此镜像直接抛 `ImageError`，**不经镜像代理拉取** |
| 平台自建判定 | `ImageManager.is_platform_local(image: str) -> bool` | 镜像是否属平台自建命名空间（只在宿主构建、不存在于任何仓库） |
| 宿主镜像 | `ImageManager.host_image_exists(image: str) -> bool` | 宿主 root 守护进程里是否已有该镜像 |
| 导出注入 | `ImageManager.inject_from_host(image: str, daemon: UserDaemon) -> str` | `docker save` → `docker load` 注入沙箱守护进程，失败抛 `ImageError` |

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
| 健康 | `probe() -> ProxyProbe` / `health_check() -> bool` | TCP 可连 + 能从 `http://127.0.0.1:<port>/ca.crt` 取到证书才算健康 |
| CA | `read_ca_certificate() -> str` / `read_system_ca_bundle() -> str` | 读代理 CA / 系统 CA 束，缺失抛 `ProxyError` |
| 合并 CA 束 | `install_ca_bundle(user: SystemUser) -> Path` | 「系统 CA 束 + 代理 CA」合并成单个文件，装到沙箱用户家目录（属主沙箱用户、权限 0644） |
| 权限 | `harden_ca_permissions() -> None` | CA 私钥 `0600`、证书 `0644` |
| 停止/删除 | `stop() -> bool` / `remove() -> bool` | 停止 / 删除代理容器（缓存与 CA 目录保留） |

`ProxyProbe` 字段：`tcp`、`http`、`detail`；属性 `healthy`。

---

## 7. `lifecycle.py` —— 生命周期编排

### 数据类

| 名称 | 字段 | 说明 |
|---|---|---|
| `CreateRequest` | `name`、`image=None`、`mount_declarations=()`、`command=None`、`env={}`、`workdir=None`、`network_name=None`、`image_source="auto"` | 创建入参 |
| `CreateResult` | `metadata`、`connection`、`steps` | 创建结果；`steps` 是固定 7 步名称 |
| `ConnectionInfo` | `socket_path`、`container_name`、`exec_command`、`docker_command`、`notes` | 连接方式与命令提示 |
| `ReclaimPlan` | `sandbox_name`、`items`、`untouched_note`、`user_mounts`、`incomplete` | 删除前的回收清单；`untouched_note` 固定为「用户挂载的宿主机目录不受影响」；依赖容器清单 = 元数据已知列表 ∪ 删除前实时扫描，探测失败时保留旧列表并置 `incomplete=True` |
| `DeleteResult` | `name`、`existed`、`removed`、`failed`、`plan` | 删除结果；沙箱不存在时 `existed=False` 且不抛异常；`removed` 是确实回收掉的资源，`failed` 是尝试过但没成功的条目（带原因） |

### `SandboxService`

| 方法 | 签名 | 说明 |
|---|---|---|
| 构造 | `SandboxService(config: PlatformConfig \| None = None, privilege: Privilege \| None = None)` | 控制面服务入口 |
| 查询 | `find(name) -> SandboxMetadata \| None` | 不存在返回 `None`；先过沙箱名校验 |
| 查询 | `get(name) -> SandboxMetadata` | 不存在抛 `NotFoundError`；先过沙箱名校验 |
| 列表 | `list() -> list[SandboxMetadata]` | 尽力刷新运行状态（用户已删 → `deleted`） |
| 创建 | `create(request: CreateRequest) -> CreateResult` | 固定 7 步，任一步失败回滚已完成步骤 |
| 启动 | `start(name: str) -> SandboxMetadata` | 复用同一用户、同一子 ID 段、同一守护进程单元；只恢复沙箱容器，依赖容器由使用方自行拉起 |
| 关闭 | `stop(name: str, stop_dependencies: bool = True) -> SandboxMetadata` | 依赖容器是否一并停止由显式参数控制，默认停 |
| 回收清单 | `reclaim_plan(name: str) -> ReclaimPlan` | 删除前展示用 |
| 删除 | `delete(name: str) -> DeleteResult` | 按固定回收清单回收，幂等 |

### 创建的 7 步与回滚

| 步 | 动作 | 失败回滚 |
|---|---|---|
| ① | 创建专属系统用户 | 删除用户与家目录（**仅本次新建的用户**进回滚清单） |
| ② | 登记子 UID/GID 段 | 清除 `/etc/subuid`、`/etc/subgid` 条目 |
| ③ | 写 systemd 用户单元、开启 linger、启动守护进程 | 停用并删除单元、关闭 linger（回滚动作在写单元后立刻登记，启动失败也会回滚） |
| ④ | 解析用户声明挂载（校验宿主路径存在、容器路径绝对、套接字路径不被占用、宿主路径对沙箱用户可见） | 无宿主副作用，无需回滚 |
| ⑤ | 准备镜像与网络，启动沙箱容器（挂载套接字与用户声明挂载） | 删除容器与网络 |
| ⑥ | 写入沙箱元数据 | 删除元数据 |
| ⑦ | 组装连接方式与命令提示 | 无 |

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
| `auto`（默认） | 一期行为 | 沙箱守护进程已有 → 平台自建镜像（`sandbox-platform/` 前缀）由宿主导出注入 → 其余交给沙箱守护进程经统一镜像代理拉取 |
| `host` | 强制从宿主导出注入 | 宿主没有该镜像直接报错（`ImageError`），**不经镜像代理拉取**；宿主有则 `docker save` → `docker load` 注入沙箱守护进程（守护进程里已有时跳过重复注入） |

`host` 模式在创建第 ⑤ 步准备镜像时执行，沙箱启动镜像因此不经镜像代理。
该来源随沙箱元数据一起落盘（`SandboxMetadata.image_source`），
`start` 时按同一来源准备镜像，旧的元数据文件没有该字段时按 `auto` 处理。

### 入参校验

| 函数 | 说明 |
|---|---|
| `validate_sandbox_name(name)` | 沙箱名整串匹配（`[a-z0-9][a-z0-9_-]{0,23}`），`find` / `get` / `reclaim_plan` / `create` / `start` / `stop` / `delete` 七个入口统一先校验 |
| `validate_image_name(image)` | 镜像名字符集限制（字母数字与 `. _ - / : @`） |
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

服务层子包 `sandbox_platform.server`（FastAPI）把上面的核心接口暴露为 HTTP 路由。
**命令行与服务端共用同一 `SandboxService`，行为等价**：服务层只做编排与转译，
不重复实现任何生命周期逻辑，宿主交互仍收敛在 `daemon.py` / `images.py` / `proxy.py` 内。

| 项 | 值 |
|---|---|
| 前缀 | `/api` |
| 启动入口 | `uv run python -m sandbox_platform.server` |
| 监听地址 | 默认 `127.0.0.1:8000`，用 `SANDBOX_CONSOLE_HOST` / `SANDBOX_CONSOLE_PORT` 覆盖 |
| 前端目录 | 默认 `<项目目录>/console/dist`，用 `SANDBOX_CONSOLE_DIST` 覆盖；目录不存在时跳过静态托管并记日志 |
| 错误响应体 | 统一 `{"detail": "中文消息"}`，消息取平台异常原文 |
| 鉴权 | 无（只监听回环或内网地址，不得暴露公网） |

### 11.1 路由表

| 方法 | 路径 | 请求体 | 响应体 | 对应的核心接口 |
|---|---|---|---|---|
| GET | `/api/health` | — | 服务自检（版本、平台数据根） | — |
| POST | `/api/sandboxes` | `CreateSandboxRequest` | `CreateSandboxResponse` | `SandboxService.create` |
| GET | `/api/sandboxes` | — | `SandboxSummary[]` | `SandboxService.list` |
| GET | `/api/sandboxes/{name}` | — | `SandboxDetail` | `SandboxService.get` |
| POST | `/api/sandboxes/{name}/start` | — | `SandboxDetail` | `SandboxService.start` |
| POST | `/api/sandboxes/{name}/stop` | `StopSandboxRequest`（可省略） | `SandboxDetail` | `SandboxService.stop` |
| GET | `/api/sandboxes/{name}/reclaim` | — | `ReclaimPlanModel` | `SandboxService.reclaim_plan` |
| DELETE | `/api/sandboxes/{name}` | — | `DeleteSandboxResponse` | `SandboxService.delete` |

### 11.2 请求字段

`CreateSandboxRequest`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `name` | `str` | 必填 | 沙箱名，走一期白名单校验 |
| `image` | `str \| null` | `null` | 沙箱镜像，缺省取平台默认镜像 |
| `image_source` | `str` | `auto` | `auto`（一期行为）/ `host`（强制从宿主注入，不经镜像代理） |
| `mounts` | `list[str]` | `[]` | 用户声明挂载，格式 `宿主路径:容器路径[:ro]`；平台不创建也不删除宿主目录 |
| `command` | `str \| list[str] \| null` | `null` | 容器启动命令；给字符串时按 shell 引号规则切分，与命令行一致 |
| `env` | `dict[str, str]` | `{}` | 容器环境变量，键名走白名单校验 |
| `workdir` | `str \| null` | `null` | 容器工作目录 |
| `network` | `str \| null` | `null` | 网桥网络名，缺省 `<沙箱名>-net`；用户指定的网络平台只接入不回收 |

`StopSandboxRequest`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `stop_dependencies` | `bool` | `true` | 是否一并停止依赖容器（对应命令行 `--keep-dependencies` 的反面） |

### 11.3 响应字段

| 模型 | 字段 | 说明 |
|---|---|---|
| `SandboxSummary` | `name`、`state`、`state_label`、`image`、`created_at` | 列表项：名字 / 状态 / 镜像 / 创建时间 |
| `SandboxDetail` | `name`、`state`、`state_label`、`image`、`image_source`、`created_at`、`updated_at`、`system_user`、`uid`、`gid`、`home`、`subid_start`、`subid_length`、`socket_path`、`socket_mount_path`、`container_name`、`container_id`、`network_name`、`network_owned`、`unit_path`、`mounts`、`dependency_containers`、`command`、`env`、`workdir` | 单个沙箱的完整信息（取自 `SandboxMetadata`） |
| `CreateSandboxResponse` | `metadata`、`connection`、`steps` | 创建结果：`steps` 是固定 7 步名称，`connection` 含套接字路径与进入沙箱的命令提示 |
| `ReclaimPlanModel` | `sandbox_name`、`items`、`untouched_note`、`user_mounts`、`incomplete` | 删除前的回收清单；`untouched_note` 固定为「用户挂载的宿主机目录不受影响」；`incomplete` 表示依赖容器清单可能不完整 |
| `DeleteSandboxResponse` | `name`、`existed`、`removed`、`failed`、`plan` | 删除结果；`removed` 是确实回收掉的资源，`failed` 是尝试过但没成功的条目 |

### 11.4 错误码映射

| 场景 | 状态码 | 响应体 |
|---|---|---|
| 入参非法（沙箱名、镜像名、挂载声明、镜像来源等） | 400 | `{"detail": "平台异常原文"}` |
| 请求体不合法（缺字段、类型不对） | 400 | `{"detail": "请求参数不合法：字段（原因）"}` |
| 沙箱不存在 | 404 | `{"detail": "平台异常原文"}` |
| 接口不存在 | 404 | `{"detail": "接口不存在：METHOD /path"}` |
| 沙箱已存在 | 409 | `{"detail": "平台异常原文"}` |
| 其余平台异常（代理不可达、生命周期步骤失败、镜像不可用等） | 500 | `{"detail": "平台异常原文"}` |

映射在服务层统一完成：平台异常不吞，消息直接取异常原文。

