"""HTTP 请求与响应模型。

请求模型负责把 HTTP 载荷翻译成核心包入参，响应模型负责把核心包的数据类
翻译成 JSON 友好的结构。字段语义与一期命令行一一对应。
"""

from __future__ import annotations

import shlex
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from sandbox_platform import (
    IMAGE_SOURCE_AUTO,
    ConnectionInfo,
    CreateRequest,
    CreateResult,
    DeleteResult,
    ReclaimPlan,
    SandboxMetadata,
)
from sandbox_platform import ValidationError as PlatformValidationError

# 环境变量值的脱敏占位：详情接口只回键名
ENV_VALUE_MASK = "***"


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
        """转成核心包的创建入参。"""
        return CreateRequest(
            name=self.name,
            image=self.image,
            mount_declarations=tuple(self.mounts),
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
