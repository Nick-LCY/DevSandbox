"""沙箱生命周期编排。

一期由命令行薄壳调用，二期由同一模块暴露为 HTTP 路由，行为保持等价。

创建固定 7 步：建用户 → 登记子 ID 段 → 写并起用户级守护进程 → 解析用户声明挂载
→ 起沙箱容器 → 写元数据 → 输出连接方式。任一步失败立即中断，并回滚已完成步骤。
"""

from __future__ import annotations

import logging
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from .command import run
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
    LifecycleError,
    NotFoundError,
    SandboxError,
    ValidationError,
)
from .images import ImageManager
from .metadata import (
    STATE_DELETED,
    STATE_RUNNING,
    STATE_STOPPED,
    MetadataStore,
    SandboxMetadata,
)
from .mounts import parse_mounts, socket_mount
from .userspace import Privilege, SystemUser, UserSpaceManager

logger = logging.getLogger(__name__)

SANDBOX_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,23}$")
MAX_SYSTEM_USER_LENGTH = 31

RECLAIM_UNTOUCHED_NOTE = "用户挂载的宿主机目录不受影响"

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
    """创建沙箱的入参。"""

    name: str
    image: str | None = None
    mount_declarations: tuple[str, ...] = ()
    command: tuple[str, ...] | None = None
    env: dict[str, str] = field(default_factory=dict)
    workdir: str | None = None
    network_name: str | None = None


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


@dataclass(frozen=True)
class DeleteResult:
    """删除沙箱的结果。"""

    name: str
    existed: bool
    removed: tuple[str, ...] = ()
    plan: ReclaimPlan | None = None


def validate_sandbox_name(name: str) -> str:
    """校验沙箱名。"""
    if not name or not SANDBOX_NAME_PATTERN.match(name):
        raise ValidationError(
            f"沙箱名非法：{name!r}，只允许小写字母、数字、连字符与下划线，且以字母或数字开头（长度 1~24）"
        )
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
        self.store = MetadataStore(self.config)

    # ---------------------------------------------------------------- 查询
    def find(self, name: str) -> SandboxMetadata | None:
        """取沙箱元数据；不存在返回 ``None``。"""
        return self.store.load(name)

    def get(self, name: str) -> SandboxMetadata:
        """取沙箱元数据；不存在抛 :class:`NotFoundError`。"""
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
        """按元数据构造守护进程操作入口。"""
        context = UserContext(
            user=metadata.system_user,
            uid=metadata.uid,
            gid=metadata.gid,
            home=Path(metadata.home),
        )
        return UserDaemon(context, self.privilege)

    def _system_user_for(self, metadata: SandboxMetadata) -> SystemUser:
        """按元数据构造系统用户对象。"""
        return SystemUser(
            name=metadata.system_user,
            uid=metadata.uid,
            gid=metadata.gid,
            home=Path(metadata.home),
        )

    def _container_name(self, name: str) -> str:
        """沙箱容器名。"""
        return f"sandbox-{name}"

    def _network_name(self, name: str) -> str:
        """沙箱网桥网络名。"""
        return f"{name}-net"

    def _dependency_containers(
        self, daemon: UserDaemon, metadata: SandboxMetadata
    ) -> list[str]:
        """列出本沙箱网络上的依赖容器（不含沙箱容器自身）。"""
        names = daemon.containers_on_network(metadata.network_name)
        result: list[str] = []
        for container in names:
            if container == metadata.container_name:
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
        if self.store.exists(name):
            raise AlreadyExistsError(f"沙箱已存在：{name}")

        # 前置校验：输入不合法时不得在宿主上留下任何副作用
        self._precheck(request)

        self._ensure_data_directories()

        completed: list[tuple[str, object]] = []
        current_step = CREATE_STEP_NAMES[0]
        try:
            # ① 创建专属用户
            system_user = self.userspace.ensure_user(system_user_name)
            completed.append((current_step, self._rollback_user(system_user)))

            # ② 登记子 UID/GID 段
            current_step = CREATE_STEP_NAMES[1]
            subid = self.userspace.allocate_subid_range(system_user.name)
            completed.append((current_step, self._rollback_subid(system_user.name)))

            # ③ 写入并启动 systemd 用户单元（含 enable-linger）
            current_step = CREATE_STEP_NAMES[2]
            unit_path = self.userspace.write_docker_unit(system_user)
            self.userspace.enable_linger(system_user.name)
            daemon = UserDaemon(
                UserContext(
                    user=system_user.name,
                    uid=system_user.uid,
                    gid=system_user.gid,
                    home=system_user.home,
                ),
                self.privilege,
            )
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
            daemon.systemctl_retry(["start", "docker.service"])
            if not daemon.wait_for_socket(timeout=120):
                raise LifecycleError(
                    current_step,
                    f"守护进程套接字未出现：{daemon.context.socket_path}"
                    f"（可用 journalctl --user -u docker.service 查看用户级日志）",
                )
            completed.append((current_step, self._rollback_unit(daemon, system_user, unit_path)))

            # ④ 解析用户声明挂载（只解析与校验，不动宿主目录）
            current_step = CREATE_STEP_NAMES[3]
            user_mounts = parse_mounts(list(request.mount_declarations))
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
            image = request.image or self.config.default_image
            self.images.ensure_image(image, daemon)
            network_name = request.network_name or self._network_name(name)
            if not daemon.network_exists(network_name):
                created = daemon.create_network(network_name)
                if not created.ok:
                    raise LifecycleError(current_step, f"创建网络 {network_name} 失败：{created.output.strip()}")
            container_name = self._container_name(name)
            if daemon.container_exists(container_name):
                daemon.remove_container(container_name)
            completed.append((current_step, self._rollback_container(daemon, container_name, network_name)))
            run_result = daemon.run_container(
                name=container_name,
                image=image,
                mounts=all_mounts,
                network=network_name,
                command=request.command,
                env=request.env,
                labels={
                    LABEL_NAME: name,
                    LABEL_ROLE: ROLE_SANDBOX,
                    LABEL_MANAGED: "true",
                },
                workdir=request.workdir,
            )
            if not run_result.ok:
                raise LifecycleError(
                    current_step, f"启动沙箱容器失败：{run_result.output.strip()}"
                )
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

    def _precheck(self, request: CreateRequest) -> None:
        """创建前的干跑校验：只解析不落地，避免非法输入留下宿主副作用。"""
        for mount in parse_mounts(list(request.mount_declarations)):
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
        metadata = self.get(name)
        daemon = self._daemon_for(metadata)

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
            daemon.systemctl_retry(["start", "docker.service"])
        if not daemon.wait_for_socket(timeout=120):
            raise LifecycleError("启动沙箱", f"守护进程套接字未出现：{daemon.context.socket_path}")

        self.images.ensure_image(metadata.image, daemon)

        if not daemon.network_exists(metadata.network_name):
            created = daemon.create_network(metadata.network_name)
            if not created.ok:
                raise LifecycleError("启动沙箱", f"创建网络 {metadata.network_name} 失败：{created.output.strip()}")

        if daemon.container_exists(metadata.container_name):
            daemon.remove_container(metadata.container_name)

        socket = socket_mount(metadata.socket_path, metadata.socket_mount_path)
        all_mounts = [socket, *metadata.mounts]
        run_result = daemon.run_container(
            name=metadata.container_name,
            image=metadata.image,
            mounts=all_mounts,
            network=metadata.network_name,
            command=tuple(metadata.command) if metadata.command else None,
            env=dict(metadata.env),
            labels={
                LABEL_NAME: metadata.name,
                LABEL_ROLE: ROLE_SANDBOX,
                LABEL_MANAGED: "true",
            },
            workdir=metadata.workdir or None,
        )
        if not run_result.ok:
            raise LifecycleError("启动沙箱", f"启动沙箱容器失败：{run_result.output.strip()}")

        metadata.container_id = daemon.container_id(metadata.container_name) or ""
        metadata.state = STATE_RUNNING
        self.store.save(metadata)
        return metadata

    def stop(self, name: str, stop_dependencies: bool = True) -> SandboxMetadata:
        """关闭沙箱：停止沙箱容器（依赖容器是否一并停止由显式参数控制，默认停）。"""
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
        """列出删除沙箱时平台会回收的资源。"""
        metadata = self.find(name)
        if metadata is None:
            return ReclaimPlan(sandbox_name=name, items=(), untouched_note=RECLAIM_UNTOUCHED_NOTE)
        items: list[str] = [
            f"沙箱容器 {metadata.container_name}",
            f"网桥网络 {metadata.network_name}",
            f"systemd 用户单元 {metadata.unit_path}",
            f"系统用户 {metadata.system_user} 与家目录 {metadata.home}",
            f"子 UID/GID 段 {metadata.subid_start}:{metadata.subid_length}（/etc/subuid、/etc/subgid）",
            f"平台元数据 {self.store.path_for(metadata.name)}",
        ]
        dependencies = metadata.dependency_containers or []
        if dependencies:
            items.insert(1, f"依赖容器 {', '.join(dependencies)}")
        user_mounts = tuple(mount.host_path for mount in metadata.mounts)
        return ReclaimPlan(
            sandbox_name=name,
            items=tuple(items),
            untouched_note=RECLAIM_UNTOUCHED_NOTE,
            user_mounts=user_mounts,
        )

    def delete(self, name: str) -> DeleteResult:
        """删除沙箱：按固定回收清单回收平台资源，用户声明挂载的宿主机目录一律不触碰。"""
        metadata = self.find(name)
        if metadata is None:
            return DeleteResult(
                name=name,
                existed=False,
                removed=(),
                plan=ReclaimPlan(sandbox_name=name, items=(), untouched_note=RECLAIM_UNTOUCHED_NOTE),
            )

        plan = self.reclaim_plan(name)
        daemon = self._daemon_for(metadata)
        removed: list[str] = []

        # ① 删除沙箱容器与依赖容器
        containers = {metadata.container_name, *metadata.dependency_containers}
        containers.update(daemon.containers_on_network(metadata.network_name))
        for container in sorted(containers):
            if daemon.container_exists(container):
                daemon.remove_container(container)
                removed.append(f"容器 {container}")
        if daemon.network_exists(metadata.network_name):
            daemon.remove_network(metadata.network_name)
            removed.append(f"网络 {metadata.network_name}")

        # ② 停止并禁用 systemd 用户单元
        daemon.disable_daemon()
        daemon.stop_daemon()
        self._remove_unit_files(metadata)
        removed.append(f"systemd 用户单元 {metadata.unit_path}")

        # ③ 删除用户与家目录
        system_user = self._system_user_for(metadata)
        if self.userspace.user_exists(system_user.name):
            self.userspace.remove_user(system_user)
        else:
            shutil.rmtree(system_user.home, ignore_errors=True)
        removed.append(f"系统用户 {system_user.name} 与家目录 {system_user.home}")

        # ④ 回收子 UID/GID 段
        had_entries = bool(self.userspace.read_subid_entries(system_user.name))
        self.userspace.remove_subid_range(system_user.name)
        if had_entries:
            removed.append(f"子 UID/GID 段 {metadata.subid_start}:{metadata.subid_length}")
        else:
            removed.append(
                f"子 UID/GID 段 {metadata.subid_start}:{metadata.subid_length}（此前已随用户删除回收）"
            )

        # ⑤ 删除平台元数据
        if self.store.delete(name):
            removed.append(f"平台元数据 {self.store.path_for(name)}")

        return DeleteResult(name=name, existed=True, removed=tuple(removed), plan=plan)

    def _remove_unit_files(self, metadata: SandboxMetadata) -> None:
        """删除用户级单元文件与 enable 软链。"""
        unit_path = Path(metadata.unit_path)
        wants_path = unit_path.parent / "default.target.wants" / unit_path.name
        for path in (unit_path, wants_path):
            run(self.privilege.wrap(["rm", "-f", str(path)]), check=False)

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
        """回滚：删除用户与家目录。"""

        def action() -> None:
            if self.userspace.user_exists(system_user.name):
                self.userspace.remove_user(system_user)
            else:
                shutil.rmtree(system_user.home, ignore_errors=True)

        return action

    def _rollback_subid(self, user_name: str):
        """回滚：回收子 ID 段。"""

        def action() -> None:
            self.userspace.remove_subid_range(user_name)

        return action

    def _rollback_unit(self, daemon: UserDaemon, system_user: SystemUser, unit_path: Path):
        """回滚：停用并删除用户级单元。"""

        def action() -> None:
            daemon.disable_daemon()
            daemon.stop_daemon()
            self.userspace.disable_linger(system_user.name)
            for path in (unit_path, unit_path.parent / "default.target.wants" / unit_path.name):
                run(self.privilege.wrap(["rm", "-f", str(path)]), check=False)

        return action

    def _rollback_container(self, daemon: UserDaemon, container_name: str, network_name: str):
        """回滚：删除沙箱容器与网络。"""

        def action() -> None:
            if daemon.container_exists(container_name):
                daemon.remove_container(container_name)
            if daemon.network_exists(network_name):
                daemon.remove_network(network_name)

        return action

    def _rollback_metadata(self, name: str):
        """回滚：删除平台元数据。"""

        def action() -> None:
            self.store.delete(name)

        return action
