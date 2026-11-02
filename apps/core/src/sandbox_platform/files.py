"""宿主文件注入沙箱：复制副本 + 只读挂载。

机制（创建流程里的一步，排在专属用户建立之后、沙箱容器启动之前）：

- 平台把用户声明的宿主文件**复制**到沙箱用户家目录内的暂存目录
  ``<沙箱用户家目录>/.sandbox-files/``：暂存目录与副本的属主都改成沙箱用户，
  目录权限 0700、文件权限 0600；
- 副本以**只读**方式挂进容器（容器内路径由用户在声明里给）；
- 复制是**创建时快照**：宿主原件之后的变更不会回灌到沙箱（要新鲜内容就重建沙箱）。

三条硬约束：

1. **原件零接触**：注入过程对原件只读取——不 chmod、不 chown、不修改、不删除；
2. **副本与沙箱同寿**：副本落在沙箱用户家目录里，随沙箱删除时的「回收用户家目录」
   一起消失，停止 / 启动期间保留；
3. **不走可读性预检**：用户声明挂载要过「宿主路径对沙箱用户可读且可穿过」那道
   预检，注入**不走**它——副本属主就是沙箱用户，那道预检对注入没有意义。
   符号链接一律拒绝（既不跟随、也不复制链接本身）。
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from .command import run
from .errors import ValidationError
from .mounts import MountSpec, reject_sensitive_host_path, sensitive_host_paths
from .userspace import Privilege, SystemUser

# 暂存目录名（落在沙箱用户家目录内，点开头：不进用户家目录的普通视图）
STAGING_DIRNAME = ".sandbox-files"

# 注入副本在元数据里的角色标记（与用户声明挂载、平台套接字三者区分开）
FILE_MOUNT_ROLE = "file"

# 副本名兜底：宿主路径末段取不到时用它
DEFAULT_STAGED_NAME = "file"


@dataclass(frozen=True)
class FileSpec:
    """一条文件注入声明（宿主路径 + 容器内路径）。"""

    host_path: str
    container_path: str


# ---------------------------------------------------------------- 声明解析
def parse_file_declaration(
    declaration: str,
    *,
    extra_forbidden: Iterable[str | Path] = (),
) -> FileSpec:
    """解析单条文件注入声明。

    合法写法固定两段：``宿主路径:容器路径``。与挂载声明的差别是没有读写标记
    段（容器内一律只读），``/ro`` 这类第三段按格式非法拒绝。
    """
    if not declaration or not declaration.strip():
        raise ValidationError("文件注入声明不能为空")
    forbidden = sensitive_host_paths(extra_forbidden)
    parts = declaration.split(":")
    if len(parts) != 2:
        raise ValidationError(
            f"文件注入声明格式非法（应为 宿主路径:容器路径）：{declaration}"
        )

    host_raw = parts[0].strip()
    container_raw = parts[1].strip()

    if not host_raw.startswith("/"):
        raise ValidationError(f"注入文件的宿主路径必须是绝对路径：{host_raw}")
    if "," in host_raw:
        raise ValidationError(
            f"注入路径不得包含逗号（Docker 挂载参数以逗号分段）：{host_raw}"
        )
    if not container_raw.startswith("/"):
        raise ValidationError(
            f"注入文件的容器内路径必须是绝对路径：{declaration}"
        )
    if "," in container_raw:
        raise ValidationError(
            f"注入路径不得包含逗号（Docker 挂载参数以逗号分段）：{declaration}"
        )

    reject_sensitive_host_path(Path(host_raw), forbidden, action="注入文件")
    return FileSpec(
        host_path=os.path.normpath(host_raw),
        container_path=os.path.normpath(container_raw),
    )


def parse_file_declarations(
    declarations: Iterable[str],
    *,
    extra_forbidden: Iterable[str | Path] = (),
) -> list[FileSpec]:
    """解析多条文件注入声明并做整体校验。

    两条跨声明约束：宿主路径不得重复声明（同一份原件不复制两遍），
    容器内路径不得重复声明（否则容器里两个挂载点抢同一个路径）。
    """
    specs: list[FileSpec] = []
    seen_host: dict[str, str] = {}
    seen_container: dict[str, str] = {}
    for declaration in declarations or ():
        spec = parse_file_declaration(declaration, extra_forbidden=extra_forbidden)
        if spec.host_path in seen_host:
            raise ValidationError(
                f"宿主路径重复声明：{spec.host_path}"
                f"（{seen_host[spec.host_path]} 与 {spec.host_path} 相同）"
            )
        if spec.container_path in seen_container:
            raise ValidationError(
                f"容器内路径重复声明：{spec.container_path}"
                f"（{seen_container[spec.container_path]} 与 {spec.host_path}）"
            )
        seen_host[spec.host_path] = spec.host_path
        seen_container[spec.container_path] = spec.host_path
        specs.append(spec)
    return specs


# ---------------------------------------------------------------- 暂存布局
def staging_root(home: str | Path) -> Path:
    """注入副本的暂存目录：``<沙箱用户家目录>/.sandbox-files``。"""
    return Path(home) / STAGING_DIRNAME


def staged_path(home: str | Path, index: int, host_path: str | Path) -> Path:
    """单个副本的落盘路径：``<暂存目录>/<序号>-<原件名>``。

    原件名取宿主路径的末段；取不到（路径以斜杠结尾等）时兜底为 ``file``。
    序号前缀让同一批副本互不覆盖，也让人一眼看出是第几份。
    """
    name = Path(host_path).name or DEFAULT_STAGED_NAME
    return staging_root(home) / f"{index}-{name}"


# ---------------------------------------------------------------- 宿主探测
def probe_host_path(privilege: Privilege, path: str) -> str:
    """探测宿主路径的类型：``f``（普通文件）或 ``d``（目录）。

    三条特权命令走一遍：存在性 → 类型 → 目录内的符号链接。符号链接一律拒绝：
    跟随会带出非预期内容，复制链接本身又会留下一条断链。
    """
    exists = run(privilege.wrap(["test", "-e", path]), check=False)
    if not exists.ok:
        raise ValidationError(f"注入的宿主路径不存在（平台不会代为创建）：{path}")

    kind = run(
        privilege.wrap(["find", path, "-maxdepth", "0", "-printf", "%y\n"]),
        check=False,
    )
    output = kind.stdout.strip() if kind.ok else ""
    if output == "l":
        raise ValidationError(
            f"注入的宿主路径是符号链接，文件注入不支持符号链接：{path}"
        )
    if output == "d":
        links = run(
            privilege.wrap(["find", path, "-type", "l", "-print", "-quit"]),
            check=False,
        )
        found = links.stdout.strip() if links.ok else ""
        if found:
            raise ValidationError(
                f"注入的宿主路径里有符号链接，文件注入不支持符号链接：{found}"
            )
        return "d"
    if output == "f":
        return "f"
    raise ValidationError(f"注入的宿主路径不存在或不可访问：{path}")


# ---------------------------------------------------------------- 副本准备
def stage_file_copies(
    specs: list[FileSpec],
    *,
    user: SystemUser,
    privilege: Privilege,
) -> list[MountSpec]:
    """把宿主文件复制成沙箱用户拥有的副本，并生成只读挂载声明。

    五步：建暂存目录 → 逐条复制 → 改属主 → 目录 0700 → 文件 0600。
    属主与主组都设成沙箱用户（``useradd --create-home`` 建出来的用户主组同名），
    免 root 守护进程以该用户身份运行，能穿过暂存目录把副本挂进容器。

    任一步失败先删掉整个暂存目录再抛原异常：不留半截副本在宿主上。
    """
    if not specs:
        return []
    staging = staging_root(user.home)
    try:
        run(
            privilege.wrap(
                [
                    "install",
                    "-d",
                    "-o",
                    user.name,
                    "-g",
                    user.name,
                    "-m",
                    "0700",
                    str(staging),
                ]
            ),
            check=True,
        )
        for index, spec in enumerate(specs):
            target = staged_path(user.home, index, spec.host_path)
            # 目标位置先清干净：目录已存在时 cp 会把原件复制进目录里（多一层目录名）
            run(privilege.wrap(["rm", "-rf", str(target)]), check=False)
            run(
                privilege.wrap(["cp", "-r", "--", spec.host_path, str(target)]),
                check=True,
            )
        run(
            privilege.wrap(["chown", "-R", f"{user.name}:{user.name}", str(staging)]),
            check=True,
        )
        run(
            privilege.wrap(
                ["find", str(staging), "-type", "d", "-exec", "chmod", "0700", "{}", "+"]
            ),
            check=True,
        )
        run(
            privilege.wrap(
                ["find", str(staging), "-type", "f", "-exec", "chmod", "0600", "{}", "+"]
            ),
            check=True,
        )
    except Exception:
        run(privilege.wrap(["rm", "-rf", str(staging)]), check=False)
        raise
    return [
        MountSpec(
            host_path=str(staged_path(user.home, index, spec.host_path)),
            container_path=spec.container_path,
            read_only=True,
            role=FILE_MOUNT_ROLE,
        )
        for index, spec in enumerate(specs)
    ]
