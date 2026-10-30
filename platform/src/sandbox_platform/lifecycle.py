"""沙箱生命周期编排。

一期由命令行薄壳调用，二期由同一模块暴露为 HTTP 路由，行为保持等价。

创建固定 7 步：建用户 → 登记子 ID 段 → 写并起用户级守护进程 → 解析用户声明挂载
→ 起沙箱容器 → 写元数据 → 输出连接方式。任一步失败立即中断，并回滚已完成步骤。

安全约定：

- 沙箱名、镜像名、网络名、环境变量名一律先校验再使用。
- 删除路径不信任元数据：用户信息现查 ``getent passwd``，家目录取查询结果，
  单元路径按查询到的家目录重算，网络只回收平台自建的那一个。
"""

from __future__ import annotations

import logging
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from .command import CommandResult, run
from .config import PlatformConfig
from .daemon import (
    LABEL_MANAGED,
    LABEL_NAME,
    LABEL_ROLE,
    ROLE_SANDBOX,
    UserContext,
    UserDaemon,
)
from .errors import (
    AlreadyExistsError,
    ImageError,
    LifecycleError,
    NotFoundError,
    ProxyError,
    SandboxError,
    ValidationError,
)
from .images import (
    IMAGE_SOURCE_AUTO,
    IMAGE_SOURCE_CHOICES,
    ImageManager,
)
from .metadata import (
    STATE_DELETED,
    STATE_RUNNING,
    STATE_STOPPED,
    MetadataStore,
    SandboxMetadata,
)
from .mounts import MountSpec, parse_mounts, socket_mount
from .proxy import RegistryProxyManager
from .userspace import Privilege, SystemUser, UserSpaceManager

logger = logging.getLogger(__name__)

SANDBOX_NAME_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{0,23}")
IMAGE_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:@-]*")
NETWORK_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
ENV_KEY_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
SYSTEM_USER_NAME_PATTERN = re.compile(r"[a-z_][a-z0-9_-]{0,30}")

MAX_SYSTEM_USER_LENGTH = 31

RECLAIM_UNTOUCHED_NOTE = "用户挂载的宿主机目录不受影响"
RECLAIM_INCOMPLETE_NOTE = "依赖容器清单可能不完整（实时探测失败，仅列出元数据中已知的依赖容器）"

CREATE_STEP_NAMES = (
    "创建专属用户",
    "登记子 UID/GID 段",
    "写入并启动 systemd 用户单元",
    "解析用户声明挂载",
    "启动沙箱容器",
    "写入沙箱元数据",
    "输出连接方式与命令提示",
)


# ---------------------------------------------------------------- 请求与结果
@dataclass(frozen=True)
class CreateRequest:
    """创建沙箱的入参。

    ``image_source`` 取 ``auto``（默认，一期行为）或 ``host``（强制从宿主注入）。
    """

    name: str
    image: str | None = None
    mount_declarations: tuple[str, ...] = ()
    command: tuple[str, ...] | None = None
    env: dict[str, str] = field(default_factory=dict)
    workdir: str | None = None
    network_name: str | None = None
    image_source: str = IMAGE_SOURCE_AUTO


@dataclass(frozen=True)
class ConnectionInfo:
    """沙箱连接方式与命令提示。"""

    socket_path: str
    container_name: str
    exec_command: str
    docker_command: str
    notes: tuple[str, ...] = ()


@dataclass(frozen=True)
class CreateResult:
    """创建沙箱的结果。"""

    metadata: SandboxMetadata
    connection: ConnectionInfo
    steps: tuple[str, ...] = ()


@dataclass(frozen=True)
class ReclaimPlan:
    """删除沙箱时的回收清单。"""

    sandbox_name: str
    items: tuple[str, ...] = ()
    untouched_note: str = RECLAIM_UNTOUCHED_NOTE
    user_mounts: tuple[str, ...] = ()
    incomplete: bool = False


@dataclass(frozen=True)
class DeleteResult:
    """删除沙箱的结果。

    ``removed`` 是确实回收掉的资源；``failed`` 是尝试过但没成功的条目，
    带原因，如实上报，不吞掉。
    """

    name: str
    existed: bool
    removed: tuple[str, ...] = ()
    failed: tuple[str, ...] = ()
    plan: ReclaimPlan | None = None


# ---------------------------------------------------------------- 入参校验
def validate_sandbox_name(name: str) -> str:
    """校验沙箱名（整串匹配，不接受前后多余字符）。"""
    if not name or not SANDBOX_NAME_PATTERN.fullmatch(name):
        raise ValidationError(
            f"沙箱名非法：{name!r}，只允许小写字母、数字、连字符与下划线，且以字母或数字开头（长度 1~24）"
        )
    return name


def validate_image_name(image: str) -> str:
    """校验镜像名（字符集限制，避免把任意字符串塞进 docker 参数）。"""
    if not image or not IMAGE_NAME_PATTERN.fullmatch(image):
        raise ValidationError(
            f"镜像名非法：{image!r}，只允许字母、数字与 . _ - / : @ 字符，且以字母或数字开头"
        )
    return image


def validate_network_name(name: str) -> str:
    """校验网桥网络名。"""
    if not name or not NETWORK_NAME_PATTERN.fullmatch(name):
        raise ValidationError(
            f"网络名非法：{name!r}，只允许字母、数字与 . _ - 字符，且以字母或数字开头"
        )
    return name


def validate_env_pairs(env: dict[str, str]) -> dict[str, str]:
    """校验容器环境变量的键名（白名单字符集）。"""
    for key in env:
        if not key or not ENV_KEY_PATTERN.fullmatch(key):
            raise ValidationError(
                f"环境变量名非法：{key!r}，只允许字母、数字与下划线，且不能以数字开头"
            )
    return env


def validate_image_source(source: str) -> str:
    """校验镜像来源取值（``auto`` / ``host``）。"""
    if source not in IMAGE_SOURCE_CHOICES:
        raise ValidationError(
            f"镜像来源非法：{source!r}，只允许 {' / '.join(IMAGE_SOURCE_CHOICES)}"
        )
    return source


def validate_system_user_name(name: str) -> str:
    """校验系统用户名（会进 ``sudo -u`` 等特权命令，必须先过白名单）。"""
    if (
        not name
        or len(name) > MAX_SYSTEM_USER_LENGTH
        or not SYSTEM_USER_NAME_PATTERN.fullmatch(name)
    ):
        raise ValidationError(f"系统用户名非法：{name!r}")
    return name


# ---------------------------------------------------------------- 服务实现
class SandboxService:
    """沙箱生命周期服务（可复用模块，不依赖命令行）。"""

    def __init__(
        self,
        config: PlatformConfig | None = None,
        privilege: Privilege | None = None,
    ) -> None:
        self.config = config or PlatformConfig.from_env()
        self.privilege = privilege or Privilege()
        self.userspace = UserSpaceManager(self.config, self.privilege)
        self.images = ImageManager(self.config, self.privilege)
        self.proxy = RegistryProxyManager(self.config, self.privilege)
        self.store = MetadataStore(self.config)

    # ---------------------------------------------------------------- 查询
    def find(self, name: str) -> SandboxMetadata | None:
        """取沙箱元数据；不存在返回 ``None``。"""
        name = validate_sandbox_name(name)
        return self.store.load(name)

    def get(self, name: str) -> SandboxMetadata:
        """取沙箱元数据；不存在抛 :class:`NotFoundError`。"""
        name = validate_sandbox_name(name)
        metadata = self.store.load(name)
        if metadata is None:
            raise NotFoundError(f"沙箱不存在：{name}")
        return metadata

    def list(self) -> list[SandboxMetadata]:
        """列出全部沙箱，并尽力刷新运行状态。"""
        result: list[SandboxMetadata] = []
        for metadata in self.store.list_all():
            result.append(self._refresh_state(metadata))
        return result

    def _refresh_state(self, metadata: SandboxMetadata) -> SandboxMetadata:
        """按实际运行情况刷新沙箱状态。"""
        if not self.userspace.user_exists(metadata.system_user):
            metadata.state = STATE_DELETED
            return metadata
        daemon = self._daemon_for(metadata)
        if not daemon.socket_ready():
            metadata.state = STATE_STOPPED
            return metadata
        if daemon.container_running(metadata.container_name):
            metadata.state = STATE_RUNNING
        else:
            metadata.state = STATE_STOPPED
        return metadata

    # ---------------------------------------------------------------- 内部辅助
    def _daemon_for(self, metadata: SandboxMetadata) -> UserDaemon:
        """按元数据构造守护进程操作入口（优先用宿主上现查到的用户信息）。"""
        user = self._resolve_user(metadata)
        if user is not None:
            return self._daemon_for_user(user)
        return UserDaemon(
            UserContext(
                user=metadata.system_user,
                uid=metadata.uid,
                gid=metadata.gid,
                home=Path(metadata.home),
            ),
            self.privilege,
        )

    def _daemon_for_user(self, user: SystemUser) -> UserDaemon:
        """按已确认的系统用户构造守护进程操作入口。"""
        return UserDaemon(
            UserContext(user=user.name, uid=user.uid, gid=user.gid, home=user.home),
            self.privilege,
        )

    def _resolve_user(self, metadata: SandboxMetadata) -> SystemUser | None:
        """按元数据里的用户名现查系统用户信息。

        删除路径不信任元数据：uid / gid / 家目录一律现查 ``getent passwd``。
        用户名非法或查不到时返回 ``None``，调用方据此拒绝执行特权命令。
        """
        try:
            validate_system_user_name(metadata.system_user)
        except ValidationError:
            logger.error("元数据里的系统用户名非法，拒绝使用：%r", metadata.system_user)
            return None
        return self.userspace.lookup_user(metadata.system_user)

    def _container_name(self, name: str) -> str:
        """沙箱容器名。"""
        return f"sandbox-{name}"

    def _network_name(self, name: str) -> str:
        """沙箱网桥网络名。"""
        return f"{name}-net"

    def _network_reclaimable(self, metadata: SandboxMetadata) -> bool:
        """该网络是否由平台自建、可以回收。

        只有平台按 ``<沙箱名>-net`` 规则自建的网络才回收；用户指定的网络只接入不回收。
        """
        if not metadata.network_owned:
            return False
        return metadata.network_name == self._network_name(metadata.name)

    def _dependency_containers(
        self, daemon: UserDaemon, metadata: SandboxMetadata
    ) -> list[str]:
        """列出本沙箱网络上的依赖容器（不含沙箱容器自身）。

        实时探测失败时退回元数据里已知的依赖容器列表。
        """
        known = list(metadata.dependency_containers or [])
        scanned = daemon.containers_on_network(metadata.network_name)
        if scanned is None:
            logger.warning("探测网络 %s 上的容器失败，改用元数据已知列表", metadata.network_name)
            return known
        result: list[str] = []
        for container in known + scanned:
            if container == metadata.container_name or container in result:
                continue
            result.append(container)
        return result

    # ---------------------------------------------------------------- 创建
    def create(self, request: CreateRequest) -> CreateResult:
        """创建沙箱（固定 7 步，任一步失败回滚已完成步骤）。"""
        name = validate_sandbox_name(request.name)
        system_user_name = self.config.system_user_name(name)
        if len(system_user_name) > MAX_SYSTEM_USER_LENGTH:
            raise ValidationError(f"沙箱名过长，系统用户名会超过 {MAX_SYSTEM_USER_LENGTH} 字符：{name}")
        validate_system_user_name(system_user_name)
        if self.store.exists(name):
            raise AlreadyExistsError(f"沙箱已存在：{name}")

        # 前置校验：输入不合法时不得在宿主上留下任何副作用
        self._precheck(request)

        # 统一镜像代理必须先就绪：代理不可达时不做降级直连（用户已拍板），
        # 直接终止创建并给出明确报错（此时尚未在宿主上做任何改动）。
        self._ensure_proxy_running("准备镜像代理")

        self._ensure_data_directories()

        completed: list[tuple[str, object]] = []
        current_step = CREATE_STEP_NAMES[0]
        try:
            # ① 创建专属用户（只有本次新建的用户才进回滚清单）
            system_user = self.userspace.ensure_user(system_user_name)
            if system_user.created:
                completed.append((current_step, self._rollback_user(system_user)))

            # ② 登记子 UID/GID 段
            current_step = CREATE_STEP_NAMES[1]
            subid = self.userspace.allocate_subid_range(system_user.name)
            completed.append((current_step, self._rollback_subid(system_user.name)))

            # ③ 写入并启动 systemd 用户单元（含 enable-linger）
            current_step = CREATE_STEP_NAMES[2]
            # 合并 CA 束必须先于守护进程就位（单元里的 SSL_CERT_FILE 指向它）
            self._install_ca_bundle(current_step, system_user)
            daemon = UserDaemon(
                UserContext(
                    user=system_user.name,
                    uid=system_user.uid,
                    gid=system_user.gid,
                    home=system_user.home,
                ),
                self.privilege,
            )
            unit_path = self.userspace.write_docker_unit(system_user)
            # 单元文件与 linger 一旦落地就要有回滚动作：回滚动作在启动守护进程之前登记
            completed.append((current_step, self._rollback_unit(daemon, system_user, unit_path)))
            self.userspace.enable_linger(system_user.name)
            if not daemon.wait_for_runtime_dir(timeout=60):
                daemon.ensure_user_manager()
                if not daemon.wait_for_runtime_dir(timeout=60):
                    raise LifecycleError(
                        current_step,
                        f"用户级 systemd 运行时目录未就绪：{daemon.context.runtime_dir}",
                    )
            daemon.ensure_user_manager()
            daemon.systemctl_retry(["daemon-reload"])
            daemon.systemctl_retry(["enable", "docker.service"])
            started = daemon.systemctl_retry(["start", "--no-block", "docker.service"])
            if not started.ok:
                raise LifecycleError(
                    current_step,
                    f"启动用户级守护进程失败：{started.output.strip()}",
                )
            if not daemon.wait_for_socket(timeout=120):
                raise LifecycleError(
                    current_step,
                    f"守护进程套接字未出现：{daemon.context.socket_path}"
                    f"（可用 journalctl --user -u docker.service 查看用户级日志）",
                )

            # ④ 解析用户声明挂载（只解析与校验，不动宿主目录）
            current_step = CREATE_STEP_NAMES[3]
            user_mounts = self._parse_user_mounts(request.mount_declarations)
            socket = socket_mount(str(daemon.context.socket_path), self.config.socket_mount_path)
            for mount in user_mounts:
                if mount.container_path == socket.container_path:
                    raise ValidationError(
                        f"容器内路径 {mount.container_path} 是平台固定挂载的套接字路径，用户不能重复声明"
                    )
                if not daemon.can_access_path(mount.host_path):
                    raise ValidationError(
                        f"宿主路径对沙箱用户 {daemon.context.user} 不可访问（需可读且可穿过）：{mount.host_path}"
                    )
            all_mounts = [socket, *user_mounts]

            # ⑤ 启动沙箱容器并挂载套接字与用户声明挂载
            current_step = CREATE_STEP_NAMES[4]
            image = validate_image_name(request.image or self.config.default_image)
            self._prepare_image(image, daemon, request.image_source)
            network_name = request.network_name or self._network_name(name)
            network_owned = request.network_name is None
            if not daemon.network_exists(network_name):
                created = daemon.create_network(network_name)
                if not created.ok:
                    raise LifecycleError(current_step, f"创建网络 {network_name} 失败：{created.output.strip()}")
            container_name = self._container_name(name)
            if daemon.container_exists(container_name):
                daemon.remove_container(container_name)
            completed.append((current_step, self._rollback_container(daemon, container_name, network_name, network_owned)))
            run_result = self._run_sandbox_container(
                daemon,
                container_name=container_name,
                image=image,
                mounts=all_mounts,
                network=network_name,
                command=request.command,
                env=dict(request.env),
                workdir=request.workdir,
                name=name,
            )
            if not run_result.ok:
                detail = run_result.output.strip()
                if not daemon.image_exists(image):
                    detail = (
                        f"镜像 {image} 在沙箱守护进程与宿主上都不存在，"
                        f"沙箱内经镜像代理拉取失败：{detail}"
                    )
                raise LifecycleError(current_step, f"启动沙箱容器失败：{detail}")
            container_id = daemon.container_id(container_name) or ""

            # ⑥ 写入沙箱元数据
            current_step = CREATE_STEP_NAMES[5]
            metadata = SandboxMetadata(
                name=name,
                system_user=system_user.name,
                uid=system_user.uid,
                gid=system_user.gid,
                home=str(system_user.home),
                subid_start=subid.start,
                subid_length=subid.length,
                image=image,
                socket_path=str(daemon.context.socket_path),
                socket_mount_path=socket.container_path,
                container_name=container_name,
                container_id=container_id,
                network_name=network_name,
                unit_path=str(unit_path),
                state=STATE_RUNNING,
                image_source=request.image_source,
                network_owned=network_owned,
                mounts=user_mounts,
                command=list(request.command or ()),
                env=dict(request.env),
                workdir=request.workdir or "",
            )
            self.store.save(metadata)
            completed.append((current_step, self._rollback_metadata(name)))

            # ⑦ 输出连接方式与命令提示
            current_step = CREATE_STEP_NAMES[6]
            connection = self._connection_info(metadata, daemon)
            return CreateResult(metadata=metadata, connection=connection, steps=CREATE_STEP_NAMES)
        except SandboxError:
            self._rollback(completed)
            raise
        except Exception as exc:  # pragma: no cover - 兜底：非预期异常也要回滚
            self._rollback(completed)
            raise LifecycleError(current_step, str(exc), cause=exc) from exc

    def _prepare_image(self, image: str, daemon: UserDaemon, image_source: str) -> str:
        """按镜像来源准备镜像，返回来源标记。

        ``auto``（一期行为，默认）：沙箱守护进程已有 → 平台自建镜像由宿主导出注入
        → 其余交由沙箱守护进程经统一镜像代理拉取。

        ``host``（强制从宿主注入）：宿主没有该镜像直接报错，**不经镜像代理拉取**。
        """
        return self.images.ensure_image_from_source(image, daemon, image_source)

    def _run_sandbox_container(
        self,
        daemon: UserDaemon,
        *,
        container_name: str,
        image: str,
        mounts: list[MountSpec],
        network: str,
        command: tuple[str, ...] | None,
        env: dict[str, str],
        workdir: str | None,
        name: str,
    ) -> CommandResult:
        """启动沙箱容器；镜像拉取失败且宿主有本地副本时，注入后重试一次。

        常规路径：镜像不在沙箱守护进程里时，守护进程自己经统一镜像代理拉取。
        例外：镜像只存在于宿主（用户自建镜像、不在任何仓库），代理拉不到，
        这时把宿主副本导出注入沙箱守护进程再重试一次。
        """
        labels = {
            LABEL_NAME: name,
            LABEL_ROLE: ROLE_SANDBOX,
            LABEL_MANAGED: "true",
        }
        result = daemon.run_container(
            name=container_name,
            image=image,
            mounts=mounts,
            network=network,
            command=command,
            env=env,
            labels=labels,
            workdir=workdir,
        )
        if result.ok or daemon.image_exists(image):
            return result
        if not self.images.host_image_exists(image):
            return result
        logger.info("镜像 %s 经代理拉取失败，改为从宿主本地副本注入后重试", image)
        try:
            self.images.inject_from_host(image, daemon)
        except ImageError as exc:
            logger.warning("宿主镜像注入失败：%s", exc)
            return result
        if daemon.container_exists(container_name):
            daemon.remove_container(container_name)
        return daemon.run_container(
            name=container_name,
            image=image,
            mounts=mounts,
            network=network,
            command=command,
            env=env,
            labels=labels,
            workdir=workdir,
        )

    def _ensure_proxy_ready(self, step: str, user: SystemUser) -> None:
        """确保统一镜像代理就绪，并把合并 CA 束装到沙箱用户家目录。

        代理不可达时直接失败：**不降级直连**（用户已拍板）。合并 CA 束必须在守护进程
        启动前就位——单元里的 ``SSL_CERT_FILE`` 指向它。
        """
        self._ensure_proxy_running(step)
        try:
            self.proxy.install_ca_bundle(user)
        except ProxyError as exc:
            raise LifecycleError(step, f"安装合并 CA 束失败：{exc}") from exc

    def _install_ca_bundle(self, step: str, user: SystemUser) -> None:
        """把「系统 CA 束 + 代理 CA」合并文件装到沙箱用户家目录。"""
        try:
            self.proxy.install_ca_bundle(user)
        except ProxyError as exc:
            raise LifecycleError(step, f"安装合并 CA 束失败：{exc}") from exc

    def _ensure_proxy_running(self, step: str) -> None:
        """拉起代理并做健康检查；不通过则直接失败（不降级直连）。"""
        if not self.proxy.ensure_running():
            probe = self.proxy.probe()
            detail = probe.detail
            if self.proxy.last_error:
                detail = f"{detail}；{self.proxy.last_error}"
            raise LifecycleError(
                step,
                f"镜像代理未就绪（{self.proxy.proxy_url}）：{detail}；"
                "平台不做降级直连，请先修复代理后重试",
            )

    def _ensure_data_directories(self) -> None:
        """准备平台数据目录（特权创建，属主为当前调用者）。"""
        for path in (
            self.config.home,
            self.config.sandbox_root,
            self.config.lock_root,
            self.config.temp_root,
        ):
            run(
                self.privilege.wrap(
                    [
                        "install",
                        "-d",
                        "-m",
                        "0755",
                        "-o",
                        str(os.getuid()),
                        "-g",
                        str(os.getgid()),
                        str(path),
                    ]
                ),
                check=True,
            )

    def _parse_user_mounts(self, declarations: tuple[str, ...] | list[str]) -> list[MountSpec]:
        """解析用户声明挂载（平台数据根等敏感路径一律拒绝）。"""
        return parse_mounts(
            list(declarations),
            extra_forbidden=[self.config.home],
        )

    def _precheck(self, request: CreateRequest) -> None:
        """创建前的干跑校验：只解析不落地，避免非法输入留下宿主副作用。"""
        validate_image_name(request.image or self.config.default_image)
        validate_image_source(request.image_source)
        if request.network_name:
            validate_network_name(request.network_name)
        validate_env_pairs(dict(request.env))
        for mount in self._parse_user_mounts(request.mount_declarations):
            if mount.container_path == self.config.socket_mount_path:
                raise ValidationError(
                    f"容器内路径 {mount.container_path} 是平台固定挂载的套接字路径，用户不能重复声明"
                )

    def _connection_info(self, metadata: SandboxMetadata, daemon: UserDaemon) -> ConnectionInfo:
        """组装连接方式与命令提示。"""
        context = daemon.context
        env_prefix = (
            f"sudo -u {context.user} env "
            f"XDG_RUNTIME_DIR={context.runtime_dir} "
            f"DOCKER_HOST=unix://{context.socket_path}"
        )
        notes = (
            f"沙箱容器：{metadata.container_name}",
            f"套接字挂载点（容器内）：{metadata.socket_mount_path}",
            "平台不预置任何默认目录，未声明挂载时容器内只有套接字一个挂载点",
        )
        return ConnectionInfo(
            socket_path=str(context.socket_path),
            container_name=metadata.container_name,
            exec_command=f"{env_prefix} docker exec -it {metadata.container_name} bash",
            docker_command=f"{env_prefix} docker ps",
            notes=notes,
        )

    # ---------------------------------------------------------------- 启动与关闭
    def start(self, name: str) -> SandboxMetadata:
        """启动沙箱（复用同一用户、同一子 ID 段、同一守护进程单元）。"""
        name = validate_sandbox_name(name)
        metadata = self.get(name)
        user = self._resolve_user(metadata)
        if user is None:
            raise LifecycleError("启动沙箱", f"沙箱系统用户在宿主上不存在：{metadata.system_user}")
        daemon = self._daemon_for_user(user)

        # 代理不可达时不做降级直连（与创建路径一致）
        self._ensure_proxy_ready("启动沙箱", user)

        if not daemon.is_active():
            if not daemon.wait_for_runtime_dir(timeout=60):
                daemon.ensure_user_manager()
                if not daemon.wait_for_runtime_dir(timeout=60):
                    raise LifecycleError(
                        "启动沙箱", f"用户级 systemd 运行时目录未就绪：{daemon.context.runtime_dir}"
                    )
            daemon.ensure_user_manager()
            daemon.systemctl_retry(["daemon-reload"])
            daemon.systemctl_retry(["enable", "docker.service"])
            started = daemon.systemctl_retry(["start", "--no-block", "docker.service"])
            if not started.ok:
                raise LifecycleError(
                    "启动沙箱", f"启动用户级守护进程失败：{started.output.strip()}"
                )
        if not daemon.wait_for_socket(timeout=120):
            raise LifecycleError("启动沙箱", f"守护进程套接字未出现：{daemon.context.socket_path}")

        self._prepare_image(metadata.image, daemon, metadata.image_source)

        if not daemon.network_exists(metadata.network_name):
            created = daemon.create_network(metadata.network_name)
            if not created.ok:
                raise LifecycleError("启动沙箱", f"创建网络 {metadata.network_name} 失败：{created.output.strip()}")

        if daemon.container_exists(metadata.container_name):
            daemon.remove_container(metadata.container_name)

        socket = socket_mount(metadata.socket_path, metadata.socket_mount_path)
        all_mounts = [socket, *metadata.mounts]
        run_result = self._run_sandbox_container(
            daemon,
            container_name=metadata.container_name,
            image=metadata.image,
            mounts=all_mounts,
            network=metadata.network_name,
            command=tuple(metadata.command) if metadata.command else None,
            env=dict(metadata.env),
            workdir=metadata.workdir or None,
            name=metadata.name,
        )
        if not run_result.ok:
            raise LifecycleError("启动沙箱", f"启动沙箱容器失败：{run_result.output.strip()}")

        metadata.container_id = daemon.container_id(metadata.container_name) or ""
        metadata.state = STATE_RUNNING
        self.store.save(metadata)
        return metadata

    def stop(self, name: str, stop_dependencies: bool = True) -> SandboxMetadata:
        """关闭沙箱：停止沙箱容器（依赖容器是否一并停止由显式参数控制，默认停）。"""
        name = validate_sandbox_name(name)
        metadata = self.get(name)
        daemon = self._daemon_for(metadata)

        if daemon.container_exists(metadata.container_name):
            daemon.stop_container(metadata.container_name)

        dependencies = self._dependency_containers(daemon, metadata)
        if stop_dependencies:
            for container in dependencies:
                daemon.stop_container(container)

        metadata.dependency_containers = dependencies
        metadata.state = STATE_STOPPED
        self.store.save(metadata)
        return metadata

    # ---------------------------------------------------------------- 删除
    def reclaim_plan(self, name: str) -> ReclaimPlan:
        """列出删除沙箱时平台会回收的资源。

        依赖容器清单 = 元数据里的已知列表 ∪ 删除前实时扫描到的容器；
        实时探测失败时保留旧列表并标注清单可能不完整。
        """
        name = validate_sandbox_name(name)
        metadata = self.find(name)
        if metadata is None:
            return ReclaimPlan(sandbox_name=name, items=(), untouched_note=RECLAIM_UNTOUCHED_NOTE)
        items: list[str] = [
            f"沙箱容器 {metadata.container_name}",
        ]

        known = list(metadata.dependency_containers or [])
        scanned = self._scan_network_containers(metadata)
        incomplete = scanned is None
        dependencies: list[str] = []
        for container in known + (scanned or []):
            if container == metadata.container_name or container in dependencies:
                continue
            dependencies.append(container)
        if dependencies:
            items.append(f"依赖容器 {', '.join(dependencies)}")
        if incomplete:
            items.append(RECLAIM_INCOMPLETE_NOTE)

        items.append(
            f"网桥网络 {metadata.network_name}"
            if metadata.network_owned
            else f"网桥网络 {metadata.network_name}（用户指定，平台不回收）"
        )
        items.extend(
            [
                f"systemd 用户单元 {metadata.unit_path}",
                f"系统用户 {metadata.system_user} 与家目录 {metadata.home}",
                f"子 UID/GID 段 {metadata.subid_start}:{metadata.subid_length}（/etc/subuid、/etc/subgid）",
                f"平台元数据 {self.store.path_for(metadata.name)}",
            ]
        )
        user_mounts = tuple(mount.host_path for mount in metadata.mounts)
        return ReclaimPlan(
            sandbox_name=name,
            items=tuple(items),
            untouched_note=RECLAIM_UNTOUCHED_NOTE,
            user_mounts=user_mounts,
            incomplete=incomplete,
        )

    def _scan_network_containers(self, metadata: SandboxMetadata) -> list[str] | None:
        """实时扫描沙箱网络上的容器；探测失败返回 ``None``。"""
        user = self._resolve_user(metadata)
        if user is None:
            return None
        daemon = self._daemon_for_user(user)
        return daemon.containers_on_network(metadata.network_name)

    def delete(self, name: str) -> DeleteResult:
        """删除沙箱：按固定回收清单回收平台资源，用户声明挂载的宿主机目录一律不触碰。"""
        name = validate_sandbox_name(name)
        metadata = self.find(name)
        if metadata is None:
            return DeleteResult(
                name=name,
                existed=False,
                removed=(),
                failed=(),
                plan=ReclaimPlan(sandbox_name=name, items=(), untouched_note=RECLAIM_UNTOUCHED_NOTE),
            )

        plan = self.reclaim_plan(name)
        removed: list[str] = []
        failed: list[str] = []

        # 用户信息现查 getent passwd：元数据里的 uid / gid / 家目录不可信
        user = self._resolve_user(metadata)

        if user is None:
            failed.append(
                f"系统用户 {metadata.system_user} 在宿主上不存在或名字非法：容器与网络未回收"
            )
        else:
            daemon = self._daemon_for_user(user)

            # ① 删除沙箱容器与依赖容器（元数据已知列表 ∪ 实时扫描）
            containers = {metadata.container_name, *(metadata.dependency_containers or [])}
            scanned = daemon.containers_on_network(metadata.network_name)
            if scanned is not None:
                containers.update(scanned)
            for container in sorted(containers):
                if not daemon.container_exists(container):
                    continue
                result = daemon.remove_container(container)
                if result.ok:
                    removed.append(f"容器 {container}")
                else:
                    failed.append(f"容器 {container} 删除失败：{result.output.strip()}")

            # ② 删除网桥网络（仅平台自建的网络）
            if self._network_reclaimable(metadata) and daemon.network_exists(
                metadata.network_name
            ):
                result = daemon.remove_network(metadata.network_name)
                if result.ok:
                    removed.append(f"网络 {metadata.network_name}")
                else:
                    failed.append(f"网络 {metadata.network_name} 删除失败：{result.output.strip()}")
            elif not metadata.network_owned:
                logger.info(
                    "网络 %s 由用户指定，平台只接入不回收（如需清理请在沙箱内自行删除）",
                    metadata.network_name,
                )

            # ③ 停止并禁用 systemd 用户单元（单元路径按现查到的家目录重算）
            unit_path = self.userspace.unit_path(user)
            disable_result = daemon.disable_daemon()
            if not disable_result.ok and daemon.is_enabled():
                failed.append(f"禁用用户级守护进程单元失败：{disable_result.output.strip()}")
            stop_result = daemon.stop_daemon()
            if not stop_result.ok and daemon.is_active():
                failed.append(f"停止用户级守护进程失败：{stop_result.output.strip()}")
            if not self.userspace.disable_linger(user.name):
                if self.userspace.linger_state(user.name) is True:
                    failed.append(f"关闭 linger 保活失败：{user.name}")
                else:
                    logger.warning("关闭 linger 保活失败：%s（已确认 linger 未开启）", user.name)
            if self._remove_unit_files(unit_path):
                removed.append(f"systemd 用户单元 {unit_path}")
            else:
                failed.append(f"systemd 用户单元 {unit_path} 删除失败")

            # ④ 删除用户与家目录
            if self.userspace.user_exists(user.name):
                if self.userspace.remove_user(user):
                    removed.append(f"系统用户 {user.name} 与家目录 {user.home}")
                else:
                    removed.append(f"系统用户 {user.name}")
                    failed.append(
                        f"系统用户 {user.name} 仍有残留进程，家目录 {user.home} 未回收"
                    )
            else:
                removed.append(f"系统用户 {user.name}（此前已不存在）")
                self._remove_home(user.home)

        # ⑤ 回收子 UID/GID 段（用户名必须先过白名单）
        try:
            validate_system_user_name(metadata.system_user)
        except ValidationError:
            failed.append(f"系统用户名非法，未回收子 UID/GID 段：{metadata.system_user!r}")
        else:
            had_entries = bool(self.userspace.read_subid_entries(metadata.system_user))
            try:
                self.userspace.remove_subid_range(metadata.system_user)
            except SandboxError as exc:
                failed.append(f"子 UID/GID 段回收失败：{exc}")
            else:
                if had_entries:
                    removed.append(f"子 UID/GID 段 {metadata.subid_start}:{metadata.subid_length}")
                else:
                    removed.append(
                        f"子 UID/GID 段 {metadata.subid_start}:{metadata.subid_length}（此前已随用户删除回收）"
                    )

        # ⑥ 删除平台元数据
        try:
            deleted_metadata = self.store.delete(name)
        except OSError as exc:
            failed.append(f"平台元数据 {self.store.path_for(name)} 删除失败：{exc}")
        else:
            if deleted_metadata:
                removed.append(f"平台元数据 {self.store.path_for(name)}")
            else:
                failed.append(f"平台元数据 {self.store.path_for(name)} 删除失败")

        return DeleteResult(
            name=name,
            existed=True,
            removed=tuple(removed),
            failed=tuple(failed),
            plan=plan,
        )

    def _remove_unit_files(self, unit_path: Path) -> bool:
        """删除用户级单元文件与 enable 软链；全部成功返回 ``True``。"""
        wants_path = unit_path.parent / "default.target.wants" / unit_path.name
        ok = True
        for path in (unit_path, wants_path):
            result = run(self.privilege.wrap(["rm", "-f", str(path)]), check=False)
            if not result.ok:
                logger.error("删除单元文件失败：%s（%s）", path, result.output.strip())
                ok = False
        return ok

    def _remove_home(self, home: Path) -> None:
        """清理已不存在用户的残留家目录（失败只记日志，不吞异常）。"""
        try:
            if not home.exists():
                return
            shutil.rmtree(home)
        except OSError as exc:
            logger.error("删除家目录失败：%s（%s）", home, exc)

    # ---------------------------------------------------------------- 回滚
    def _rollback(self, completed: list[tuple[str, object]]) -> None:
        """按相反顺序回滚已完成的步骤。"""
        for step, action in reversed(completed):
            try:
                action()  # type: ignore[operator]
                logger.info("已回滚步骤：%s", step)
            except Exception as exc:  # noqa: BLE001 - 回滚尽力而为，不因单步失败中断
                logger.error("回滚步骤「%s」失败：%s", step, exc)

    def _rollback_user(self, system_user: SystemUser):
        """回滚：删除用户与家目录（只针对本次新建的用户）。"""

        def action() -> None:
            if self.userspace.user_exists(system_user.name):
                self.userspace.remove_user(system_user)
            else:
                self._remove_home(system_user.home)

        return action

    def _rollback_subid(self, user_name: str):
        """回滚：回收子 ID 段。"""

        def action() -> None:
            self.userspace.remove_subid_range(user_name)

        return action

    def _rollback_unit(self, daemon: UserDaemon, system_user: SystemUser, unit_path: Path):
        """回滚：停用并删除用户级单元，同时关闭 linger。"""

        def action() -> None:
            daemon.disable_daemon()
            daemon.stop_daemon()
            self.userspace.disable_linger(system_user.name)
            self._remove_unit_files(unit_path)

        return action

    def _rollback_container(
        self, daemon: UserDaemon, container_name: str, network_name: str, network_owned: bool
    ):
        """回滚：删除沙箱容器与网络（用户指定的网络不回收）。"""

        def action() -> None:
            if daemon.container_exists(container_name):
                daemon.remove_container(container_name)
            if network_owned and daemon.network_exists(network_name):
                daemon.remove_network(network_name)

        return action

    def _rollback_metadata(self, name: str):
        """回滚：删除平台元数据。"""

        def action() -> None:
            self.store.delete(name)

        return action
