"""用户声明挂载的解析、校验与容器参数生成。

契约要点：

- 唯一固定挂载是 Docker 套接字，平台自己挂，不接受用户声明同一路径。
- 其余挂载全部来自用户的 ``--mount 宿主路径:容器路径[:ro]`` 声明，可多次。
- 平台只解析与校验，不创建、不修改、不清理用户声明的宿主路径。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .errors import ValidationError

SOCKET_MOUNT_ROLE = "socket"
USER_MOUNT_ROLE = "user"


@dataclass(frozen=True)
class MountSpec:
    """一条挂载声明。"""

    host_path: str
    container_path: str
    read_only: bool = False
    role: str = USER_MOUNT_ROLE

    @property
    def bind_spec(self) -> str:
        """Docker 卷参数写法：``宿主路径:容器路径[:ro]``。"""
        suffix = ":ro" if self.read_only else ""
        return f"{self.host_path}:{self.container_path}{suffix}"

    def to_docker_args(self) -> list[str]:
        """转成 ``docker run`` 的挂载参数。"""
        parts = [
            "type=bind",
            f"src={self.host_path}",
            f"dst={self.container_path}",
        ]
        if self.read_only:
            parts.append("readonly")
        return ["--mount", ",".join(parts)]

    def describe(self) -> str:
        """人类可读描述，供命令行展示。"""
        return f"{self.host_path} → {self.container_path}{'（只读）' if self.read_only else ''}"


def _validate_host_path(raw: str) -> Path:
    if not raw.startswith("/"):
        raise ValidationError(f"挂载的宿主路径必须是绝对路径：{raw}")
    path = Path(raw)
    if not path.exists():
        raise ValidationError(f"挂载的宿主路径不存在（平台不会代为创建）：{raw}")
    if not (path.is_dir() or path.is_file()):
        raise ValidationError(f"挂载的宿主路径不是普通文件或目录：{raw}")
    return path


def parse_mount_declaration(declaration: str) -> MountSpec:
    """解析单条 ``--mount`` 声明。

    合法写法：``宿主路径:容器路径``、``宿主路径:容器路径:ro``、``宿主路径:容器路径:rw``。
    """
    if not declaration or not declaration.strip():
        raise ValidationError("挂载声明不能为空")
    parts = declaration.split(":")
    if len(parts) == 2:
        host_raw, container_raw, mode = parts[0], parts[1], ""
    elif len(parts) == 3:
        host_raw, container_raw, mode = parts[0], parts[1], parts[2]
    else:
        raise ValidationError(
            f"挂载声明格式非法（应为 宿主路径:容器路径[:ro]）：{declaration}"
        )

    host_raw = host_raw.strip()
    container_raw = container_raw.strip()
    mode = mode.strip().lower()

    if not container_raw.startswith("/"):
        raise ValidationError(f"挂载的容器内路径必须是绝对路径：{declaration}")
    if mode not in ("", "ro", "rw"):
        raise ValidationError(f"挂载声明只支持 ro / rw 读写标记：{declaration}")

    _validate_host_path(host_raw)
    return MountSpec(
        host_path=os.path.normpath(host_raw),
        container_path=os.path.normpath(container_raw),
        read_only=(mode == "ro"),
    )


def parse_mounts(declarations: list[str] | tuple[str, ...] | None) -> list[MountSpec]:
    """解析多条挂载声明并做整体校验。"""
    specs: list[MountSpec] = []
    seen_container: dict[str, str] = {}
    for declaration in declarations or ():
        spec = parse_mount_declaration(declaration)
        if spec.container_path in seen_container:
            raise ValidationError(
                f"容器内路径重复声明：{spec.container_path}"
                f"（{seen_container[spec.container_path]} 与 {spec.host_path}）"
            )
        seen_container[spec.container_path] = spec.host_path
        specs.append(spec)
    return specs


def socket_mount(socket_path: str, container_path: str) -> MountSpec:
    """构造平台唯一固定挂载：Docker 套接字。"""
    if not container_path.startswith("/"):
        raise ValidationError(f"套接字容器内路径必须是绝对路径：{container_path}")
    return MountSpec(
        host_path=socket_path,
        container_path=container_path,
        read_only=False,
        role=SOCKET_MOUNT_ROLE,
    )


def mounts_to_docker_args(mounts: list[MountSpec]) -> list[str]:
    """把挂载列表拼成 ``docker run`` 参数片段。"""
    args: list[str] = []
    for mount in mounts:
        args.extend(mount.to_docker_args())
    return args


def describe_mounts(mounts: list[MountSpec]) -> str:
    """人类可读的挂载清单，逗号分隔。"""
    if not mounts:
        return "（无）"
    return ", ".join(mount.describe() for mount in mounts)
