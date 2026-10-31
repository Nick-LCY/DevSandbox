"""HTTP 请求与响应模型。

请求模型负责把 HTTP 载荷翻译成核心包入参，响应模型负责把核心包的数据类
翻译成 JSON 友好的结构。字段语义与一期命令行一一对应。
"""

from __future__ import annotations

import os
import shlex
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sandbox_platform import (
    IMAGE_SOURCE_AUTO,
    ConnectionInfo,
    CreateRequest,
    CreateResult,
    DeleteResult,
    HostImage,
    ProxyRestartResult,
    ProxyStatus,
    ReclaimPlan,
    SandboxMetadata,
)
from sandbox_platform import ValidationError as PlatformValidationError

# 环境变量值的脱敏占位：详情接口只回键名
ENV_VALUE_MASK = "***"


def expand_home_prefix(declaration: str) -> str:
    """展开挂载声明里**宿主路径段**的前导 ``~``。

    口径：

    - 宿主路径段恰为 ``~`` 或以 ``~/`` 开头：开头的 ``~`` 换成服务运行用户的家目录。
    - ``~other`` 形式不展开（原样交给核心包）。
    - 容器路径段与读写标记段不展开；环境变量值、命令、工作目录也不展开。
    - 取不到家目录时保持原样。
    """
    parts = declaration.split(":", 2)
    host = parts[0]
    expanded = _expand_home_segment(host)
    if expanded == host:
        return declaration
    parts[0] = expanded
    return ":".join(parts)


def expand_mounts_home_prefix(mounts: list[str]) -> list[str]:
    """批量展开挂载声明列表里宿主路径段的前导 ``~``。"""
    return [expand_home_prefix(item) for item in mounts]


def _expand_home_segment(host: str) -> str:
    """展开单个宿主路径段的前导 ``~``（只处理 ``~`` 与 ``~/`` 两种形态）。"""
    if host != "~" and not host.startswith("~/"):
        return host
    home = os.path.expanduser("~")
    if not home.startswith("/"):
        # 取不到家目录（HOME 为空或不是绝对路径）：保持原样
        return host
    if host == "~":
        return home
    return home + host[1:]


class CreateSandboxRequest(BaseModel):
    """创建沙箱的请求体。"""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="沙箱名（小写字母、数字、连字符、下划线）")
    image: str | None = Field(default=None, description="沙箱镜像（缺省取平台默认镜像）")
    image_source: Literal["auto", "host"] = Field(
        default=IMAGE_SOURCE_AUTO,
        description="镜像来源：auto（默认，走代理拉取）/ host（强制从宿主注入，不经代理）",
    )
    mounts: list[str] = Field(
        default_factory=list,
        description="用户声明挂载，格式 宿主路径:容器路径[:ro]；平台不创建也不删除宿主目录",
    )
    command: str | list[str] | None = Field(
        default=None, description="容器启动命令（覆盖镜像默认入口）"
    )
    env: dict[str, str] = Field(default_factory=dict, description="容器环境变量")
    workdir: str | None = Field(default=None, description="容器工作目录")
    network: str | None = Field(
        default=None, description="网桥网络名（缺省 <沙箱名>-net；用户指定的网络平台不回收）"
    )

    def to_core_request(self) -> CreateRequest:
        """转成核心包的创建入参。

        挂载声明的宿主路径段在这里展开 ``~``：展开目标是服务运行用户的家目录。
        容器路径、环境变量、命令与工作目录一律不展开。
        """
        return CreateRequest(
            name=self.name,
            image=self.image,
            mount_declarations=tuple(expand_mounts_home_prefix(self.mounts)),
            command=self._command_tuple(),
            env=dict(self.env),
            workdir=self.workdir,
            network_name=self.network,
            image_source=self.image_source,
        )

    def _command_tuple(self) -> tuple[str, ...] | None:
        """命令统一成参数元组（字符串按 shell 引号规则切分，与命令行一致）。

        引号不配对时抛平台 :class:`ValidationError`（映射为 400），
        不让 ``shlex`` 的原始异常穿透成 500。
        """
        if self.command is None:
            return None
        if isinstance(self.command, str):
            try:
                return tuple(shlex.split(self.command))
            except ValueError as exc:
                raise PlatformValidationError(
                    f"容器启动命令的引号不配对：{self.command}"
                ) from exc
        return tuple(self.command)


class StopSandboxRequest(BaseModel):
    """停止沙箱的请求体（可省略）。"""

    model_config = ConfigDict(extra="forbid")

    stop_dependencies: bool = Field(default=True, description="是否一并停止依赖容器")


class MountInfo(BaseModel):
    """用户声明挂载。"""

    host_path: str
    container_path: str
    read_only: bool
    role: str


class SandboxSummary(BaseModel):
    """列表项：名字 / 状态 / 镜像 / 创建时间。"""

    name: str
    state: str
    state_label: str
    image: str
    created_at: str

    @classmethod
    def from_metadata(cls, metadata: SandboxMetadata) -> SandboxSummary:
        """由沙箱元数据生成列表项。"""
        return cls(
            name=metadata.name,
            state=metadata.state,
            state_label=metadata.state_label,
            image=metadata.image,
            created_at=metadata.created_at,
        )


class SandboxDetail(BaseModel):
    """单个沙箱的详情。

    ``env`` 只回键名，值固定为 ``***``：环境变量里常有凭据，不进 HTTP 响应。
    """

    name: str
    state: str
    state_label: str
    image: str
    image_source: str
    created_at: str
    updated_at: str
    system_user: str
    uid: int
    gid: int
    home: str
    subid_start: int
    subid_length: int
    socket_path: str
    socket_mount_path: str
    container_name: str
    container_id: str
    network_name: str
    network_owned: bool
    unit_path: str
    mounts: list[MountInfo]
    dependency_containers: list[str]
    command: list[str]
    env: dict[str, str]
    workdir: str

    @classmethod
    def from_metadata(cls, metadata: SandboxMetadata) -> SandboxDetail:
        """由沙箱元数据生成详情。"""
        return cls(
            name=metadata.name,
            state=metadata.state,
            state_label=metadata.state_label,
            image=metadata.image,
            image_source=metadata.image_source,
            created_at=metadata.created_at,
            updated_at=metadata.updated_at,
            system_user=metadata.system_user,
            uid=metadata.uid,
            gid=metadata.gid,
            home=metadata.home,
            subid_start=metadata.subid_start,
            subid_length=metadata.subid_length,
            socket_path=metadata.socket_path,
            socket_mount_path=metadata.socket_mount_path,
            container_name=metadata.container_name,
            container_id=metadata.container_id,
            network_name=metadata.network_name,
            network_owned=metadata.network_owned,
            unit_path=metadata.unit_path,
            mounts=[
                MountInfo(
                    host_path=mount.host_path,
                    container_path=mount.container_path,
                    read_only=mount.read_only,
                    role=mount.role,
                )
                for mount in metadata.mounts
            ],
            dependency_containers=list(metadata.dependency_containers),
            command=list(metadata.command),
            env={key: ENV_VALUE_MASK for key in metadata.env},
            workdir=metadata.workdir,
        )


class ConnectionModel(BaseModel):
    """沙箱连接方式与命令提示。"""

    socket_path: str
    container_name: str
    exec_command: str
    docker_command: str
    notes: list[str]

    @classmethod
    def from_connection(cls, connection: ConnectionInfo) -> ConnectionModel:
        """由核心包的连接信息生成。"""
        return cls(
            socket_path=connection.socket_path,
            container_name=connection.container_name,
            exec_command=connection.exec_command,
            docker_command=connection.docker_command,
            notes=list(connection.notes),
        )


class CreateSandboxResponse(BaseModel):
    """创建沙箱的结果。"""

    metadata: SandboxDetail
    connection: ConnectionModel
    steps: list[str]

    @classmethod
    def from_result(cls, result: CreateResult) -> CreateSandboxResponse:
        """由核心包的创建结果生成。"""
        return cls(
            metadata=SandboxDetail.from_metadata(result.metadata),
            connection=ConnectionModel.from_connection(result.connection),
            steps=list(result.steps),
        )


class ReclaimPlanModel(BaseModel):
    """删除前的回收清单。"""

    sandbox_name: str
    items: list[str]
    untouched_note: str
    user_mounts: list[str]
    incomplete: bool

    @classmethod
    def from_plan(cls, plan: ReclaimPlan) -> ReclaimPlanModel:
        """由核心包的回收清单生成。"""
        return cls(
            sandbox_name=plan.sandbox_name,
            items=list(plan.items),
            untouched_note=plan.untouched_note,
            user_mounts=list(plan.user_mounts),
            incomplete=plan.incomplete,
        )


class DeleteSandboxResponse(BaseModel):
    """删除沙箱的结果。"""

    name: str
    existed: bool
    removed: list[str]
    failed: list[str]
    plan: ReclaimPlanModel | None

    @classmethod
    def from_result(cls, result: DeleteResult) -> DeleteSandboxResponse:
        """由核心包的删除结果生成。"""
        return cls(
            name=result.name,
            existed=result.existed,
            removed=list(result.removed),
            failed=list(result.failed),
            plan=None if result.plan is None else ReclaimPlanModel.from_plan(result.plan),
        )


class HealthResponse(BaseModel):
    """服务自检。

    不回显宿主平台数据根的绝对路径（属敏感信息），只给「数据根是否就绪」。
    """

    status: str
    version: str
    data_root_configured: bool
    console_mounted: bool


class HostImageModel(BaseModel):
    """宿主本地镜像的一项。"""

    reference: str
    image_id: str
    size_bytes: int
    created_at: str

    @classmethod
    def from_core(cls, image: HostImage) -> HostImageModel:
        """由核心包的镜像项生成。"""
        return cls(
            reference=image.reference,
            image_id=image.image_id,
            size_bytes=image.size_bytes,
            created_at=image.created_at,
        )


class ProxyContainerStatusModel(BaseModel):
    """代理容器的存在与运行状态。"""

    exists: bool
    running: bool


class ProxyStatusModel(BaseModel):
    """镜像代理的完整状态（设置页展示用）。"""

    container: ProxyContainerStatusModel
    healthy: bool
    tcp_ok: bool
    ca_fetchable: bool
    detail: str
    cache_size_bytes: int
    certificate_ready: bool
    proxy_url: str

    @classmethod
    def from_core(cls, status: ProxyStatus) -> ProxyStatusModel:
        """由核心包的代理状态生成。"""
        return cls(
            container=ProxyContainerStatusModel(
                exists=status.container.exists,
                running=status.container.running,
            ),
            healthy=status.healthy,
            tcp_ok=status.tcp_ok,
            ca_fetchable=status.ca_fetchable,
            detail=status.detail,
            cache_size_bytes=status.cache_size_bytes,
            certificate_ready=status.certificate_ready,
            proxy_url=status.proxy_url,
        )


class ProxyRestartModel(ProxyStatusModel):
    """重启代理的结果：状态字段 + ``ca_changed`` 与中文结论。"""

    restarted: bool
    ca_changed: bool
    ca_reinstalled: bool
    message: str
    reinstalled_users: list[str]
    failed_users: list[str]

    @classmethod
    def from_core(
        cls, status: ProxyStatus, result: ProxyRestartResult
    ) -> ProxyRestartModel:
        """由核心包的代理状态与重启结果生成。"""
        base = ProxyStatusModel.from_core(status)
        return cls(
            **base.model_dump(),
            restarted=result.success,
            ca_changed=result.ca_changed,
            ca_reinstalled=result.ca_reinstalled,
            message=result.message,
            reinstalled_users=list(result.reinstalled_users),
            failed_users=list(result.failed_users),
        )


class TerminalSessionCreateRequest(BaseModel):
    """新建终端会话的请求体。"""

    model_config = ConfigDict(extra="forbid")

    sandbox: str = Field(description="沙箱名（走一期白名单校验）")
    cols: int = Field(default=80, ge=1, le=1000, description="初始窗口宽度（列）")
    rows: int = Field(default=24, ge=1, le=1000, description="初始窗口高度（行）")


class TerminalSessionResponse(BaseModel):
    """新建终端会话的结果。"""

    session_id: str
    sandbox: str
    container_name: str
    cols: int
    rows: int
    state: str
    created_at: str

    @classmethod
    def from_session(cls, session: Any) -> TerminalSessionResponse:
        """由终端会话生成。"""
        record = session.record
        return cls(
            session_id=record.session_id,
            sandbox=record.sandbox_name,
            container_name=record.container_name,
            cols=record.cols,
            rows=record.rows,
            state=record.state,
            created_at=record.created_at,
        )


class TerminalSessionDeleteResponse(BaseModel):
    """删除终端会话的结果。"""

    session_id: str
    state: str = Field(description="移除前的会话状态（running / exited）")
    closed: bool = Field(
        description=(
            "关闭流程是否走完：true = 完整走完（运行中的会话走完整关闭，"
            "已退出的会话走完收尾）；false = 记录已删，但关闭流程未走完"
        )
    )
    removed: bool = Field(description="会话记录文件是否确实删掉了")

    @classmethod
    def from_removal(cls, removal: Any) -> TerminalSessionDeleteResponse:
        """由会话移除结果生成。"""
        return cls(
            session_id=removal.session_id,
            state=removal.state,
            closed=removal.closed,
            removed=removal.removed,
        )


class TerminalSessionModel(BaseModel):
    """终端会话表的一行（会话元数据）。"""

    session_id: str
    sandbox_name: str
    container_name: str
    system_user: str
    created_at: str
    last_attached_at: str
    state: str
    exit_code: int | None
    pid: int
    cols: int
    rows: int
    attached_count: int
    host_pid: int
    # 会话结束的原因（未结束为空）：见 SESSION_EXIT_REASON_* 常量
    exit_reason: str | None = None

    @classmethod
    def from_record(cls, record: Any) -> TerminalSessionModel:
        """由会话表记录生成。"""
        return cls(
            session_id=record.session_id,
            sandbox_name=record.sandbox_name,
            container_name=record.container_name,
            system_user=record.system_user,
            created_at=record.created_at,
            last_attached_at=record.last_attached_at,
            state=record.state,
            exit_code=record.exit_code,
            pid=record.pid,
            cols=record.cols,
            rows=record.rows,
            attached_count=record.attached_count,
            host_pid=getattr(record, "host_pid", 0),
            exit_reason=getattr(record, "exit_reason", None),
        )


# ---------------------------------------------------------------- 启动模板
class TemplateConfig(BaseModel):
    """启动模板的配置体（六项全选填）。

    开了 ``extra="forbid"``：多传字段直接 400，不静默吞掉。
    落盘只导出用户真正填过的字段——「字段缺失」与「字段填了空值」不混同
    （模板应用语义是「出现字段整体替换、缺失字段保持现状」）。
    """

    model_config = ConfigDict(extra="forbid")

    image: str | None = Field(default=None, description="沙箱镜像（缺省取平台默认镜像）")
    mounts: list[str] = Field(
        default_factory=list,
        description="用户声明挂载，格式 宿主路径:容器路径[:ro]；平台不创建也不删除宿主目录",
    )
    command: str | list[str] | None = Field(
        default=None, description="容器启动命令（覆盖镜像默认入口）"
    )
    workdir: str | None = Field(default=None, description="容器工作目录")
    env: dict[str, str] = Field(default_factory=dict, description="容器环境变量")
    network: str | None = Field(
        default=None, description="网桥网络名（缺省 <沙箱名>-net；用户指定的网络平台不回收）"
    )


class TemplateCreateRequest(BaseModel):
    """创建启动模板的请求体。"""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="模板名称（零限制：不 strip、不限长、不校验字符集）")
    config: TemplateConfig = Field(default_factory=TemplateConfig, description="模板配置体")


class TemplateRenameRequest(BaseModel):
    """重命名启动模板的请求体。"""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="模板新名称（零限制：不 strip、不限长、不校验字符集）")


class TemplateResponse(BaseModel):
    """启动模板的一条记录。

    ``config`` 原样透传：用户没填过的字段就是没有，不是空值。
    """

    id: str
    name: str
    config: dict[str, Any] = Field(description="模板配置体（原样透传）")
    created_at: str
    updated_at: str

    @classmethod
    def from_record(cls, record: Any) -> TemplateResponse:
        """由模板记录生成。"""
        return cls(
            id=record.id,
            name=record.name,
            config=dict(record.config),
            created_at=record.created_at,
            updated_at=record.updated_at,
        )


class TemplateDeleteResponse(BaseModel):
    """删除启动模板的结果。"""

    id: str
    deleted: bool = Field(description="模板记录文件是否确实删掉了")
