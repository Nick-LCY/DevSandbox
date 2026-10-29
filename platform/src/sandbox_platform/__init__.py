"""沙箱平台控制面核心包。

一期由 ``platform/cli/sandboxctl.py`` 调用，二期由同一批模块暴露为 HTTP 路由。
包内不含命令行解析与直接输出逻辑。
"""

from __future__ import annotations

from .config import PlatformConfig
from .daemon import UserContext, UserDaemon
from .errors import (
    AlreadyExistsError,
    CommandError,
    ConfigError,
    ImageError,
    LifecycleError,
    NotFoundError,
    SandboxError,
    ValidationError,
)
from .images import ImageManager, OfflineImagePackage
from .lifecycle import (
    CREATE_STEP_NAMES,
    RECLAIM_INCOMPLETE_NOTE,
    RECLAIM_UNTOUCHED_NOTE,
    ConnectionInfo,
    CreateRequest,
    CreateResult,
    DeleteResult,
    ReclaimPlan,
    SandboxService,
    validate_env_pairs,
    validate_image_name,
    validate_network_name,
    validate_sandbox_name,
    validate_system_user_name,
)
from .metadata import (
    STATE_DELETED,
    STATE_RUNNING,
    STATE_STOPPED,
    MetadataStore,
    SandboxMetadata,
)
from .mounts import (
    SENSITIVE_HOST_DIRS,
    SENSITIVE_HOST_FILES,
    MountSpec,
    describe_mounts,
    mounts_to_docker_args,
    parse_mount_declaration,
    parse_mounts,
    sensitive_host_paths,
    socket_mount,
)
from .userspace import Privilege, SubIdRange, SystemUser, UserSpaceManager

__all__ = [
    "CREATE_STEP_NAMES",
    "RECLAIM_INCOMPLETE_NOTE",
    "RECLAIM_UNTOUCHED_NOTE",
    "SENSITIVE_HOST_DIRS",
    "SENSITIVE_HOST_FILES",
    "STATE_DELETED",
    "STATE_RUNNING",
    "STATE_STOPPED",
    "AlreadyExistsError",
    "CommandError",
    "ConfigError",
    "ConnectionInfo",
    "CreateRequest",
    "CreateResult",
    "DeleteResult",
    "ImageError",
    "ImageManager",
    "LifecycleError",
    "MetadataStore",
    "MountSpec",
    "NotFoundError",
    "OfflineImagePackage",
    "PlatformConfig",
    "Privilege",
    "ReclaimPlan",
    "SandboxError",
    "SandboxMetadata",
    "SandboxService",
    "SubIdRange",
    "SystemUser",
    "UserContext",
    "UserDaemon",
    "UserSpaceManager",
    "ValidationError",
    "describe_mounts",
    "mounts_to_docker_args",
    "parse_mount_declaration",
    "parse_mounts",
    "sensitive_host_paths",
    "socket_mount",
    "validate_env_pairs",
    "validate_image_name",
    "validate_network_name",
    "validate_sandbox_name",
    "validate_system_user_name",
]

__version__ = "0.1.0"
