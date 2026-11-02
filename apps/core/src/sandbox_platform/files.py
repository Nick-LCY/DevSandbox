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

信任边界（注入源可见范围）：

- 注入源由平台**以特权身份读取**（复制动作走 root 通道）：控制台 / 命令行的
  调用者被视为平台受信主体，文件注入**不提供跨账号隔离**；
- 注入源不得落在**其他沙箱用户家目录**内（那是别的沙箱账号的家）；
- 命中宿主敏感清单（``/etc`` ``/proc`` ``/root`` 等、平台数据根、宿主 Docker
  套接字）一律拒绝。
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from .command import run
from .errors import ValidationError
from .mounts import (
    MountSpec,
    is_under,
    reject_sensitive_host_path,
    sensitive_host_paths,
)
from .userspace import Privilege, SystemUser

logger = logging.getLogger(__name__)

# 暂存目录名（落在沙箱用户家目录内，点开头：不进用户家目录的普通视图）
STAGING_DIRNAME = ".sandbox-files"

# 注入副本在元数据里的角色标记（与用户声明挂载、平台套接字三者区分开）
FILE_MOUNT_ROLE = "file"

# 副本名兜底：宿主路径末段取不到时用它
DEFAULT_STAGED_NAME = "file"

# 宿主家目录根：平台沙箱用户的家目录都落在这里（useradd 默认落点）
DEFAULT_HOME_ROOT = "/home"


@dataclass(frozen=True)
class FileSpec:
    """一条文件注入声明（宿主路径 + 容器内路径）。"""

    host_path: str
    container_path: str


@dataclass(frozen=True)
class SandboxHomeScope:
    """注入源的宿主范围限制（信任边界收口）。

    注入源不得落在**其他**沙箱用户家目录内：那是别的沙箱账号的家，平台
    以特权身份把它复制进沙箱，等于替别人读了文件。

    - ``user_prefix``：平台沙箱用户名前缀（取自配置的 ``user_prefix``），
      沙箱用户的家目录名形如 ``<前缀>-<沙箱名>``；
    - ``home_root``：家目录根（缺省 ``/home``）；
    - ``exclude_home``：本次创建流程自己新建的沙箱用户家目录——它不算
      「其他沙箱用户家目录」，其余一律拒绝。
    """

    user_prefix: str
    home_root: Path | None = None
    exclude_home: Path | None = None

    def homes(self) -> tuple[Path, ...]:
        """宿主上属于平台沙箱用户的家目录。

        判定规则：家目录根下名字以 ``<用户前缀>-`` 开头的**现有目录**
        （沙箱用户的家目录名就是 ``<用户前缀>-<沙箱名>``）。
        """
        root = (
            Path(self.home_root)
            if self.home_root is not None
            else Path(DEFAULT_HOME_ROOT)
        )
        prefix = f"{self.user_prefix}-"
        try:
            entries = sorted(root.iterdir())
        except OSError:
            return ()
        return tuple(
            entry
            for entry in entries
            if entry.name.startswith(prefix)
            and entry.is_dir()
            and not entry.is_symlink()
        )


def reject_sandbox_user_home(path: str | Path, scope: SandboxHomeScope) -> None:
    """注入源落在其他沙箱用户家目录内时拒绝。"""
    target = Path(path)
    exclude = Path(scope.exclude_home) if scope.exclude_home is not None else None
    for home in scope.homes():
        if exclude is not None and home == exclude:
            continue
        if is_under(target, home):
            raise ValidationError(
                f"注入的宿主路径落在其他沙箱用户家目录内，不允许注入：{target}"
            )


# ---------------------------------------------------------------- 声明解析
def parse_file_declaration(
    declaration: str,
    *,
    extra_forbidden: Iterable[str | Path] = (),
    home_scope: SandboxHomeScope | None = None,
) -> FileSpec:
    """解析单条文件注入声明。

    合法写法固定两段：``宿主路径:容器路径``。与挂载声明的差别是没有读写标记
    段（容器内一律只读），``/ro`` 这类第三段按格式非法拒绝。

    宿主路径**先归一化再校验**：敏感清单比对与家目录范围限制都用归一化后的
    路径——``/tmp/../etc/shadow`` 词法上不在 ``/etc`` 之下，却实实在在指向
    ``/etc/shadow``，用原始路径比会漏掉它。
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

    host_norm = os.path.normpath(host_raw)
    reject_sensitive_host_path(Path(host_norm), forbidden, action="注入文件")
    if home_scope is not None:
        reject_sandbox_user_home(host_norm, home_scope)
    return FileSpec(
        host_path=host_norm,
        container_path=os.path.normpath(container_raw),
    )


def parse_file_declarations(
    declarations: Iterable[str],
    *,
    extra_forbidden: Iterable[str | Path] = (),
    home_scope: SandboxHomeScope | None = None,
) -> list[FileSpec]:
    """解析多条文件注入声明并做整体校验。

    两条跨声明约束：宿主路径不得重复声明（同一份原件不复制两遍），
    容器内路径不得重复声明（否则容器里两个挂载点抢同一个路径）。
    """
    specs: list[FileSpec] = []
    seen_host: dict[str, str] = {}
    seen_container: dict[str, str] = {}
    for declaration in declarations or ():
        spec = parse_file_declaration(
            declaration,
            extra_forbidden=extra_forbidden,
            home_scope=home_scope,
        )
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

    先用 ``find -printf %y`` 判类型（悬空符号链接也判得出「符号链接」，
    不误报成「不存在」），命令失败才报不存在。符号链接一律拒绝：
    跟随会带出非预期内容，复制链接本身又会留下一条断链。
    """
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
        _reject_directory_content(privilege, path)
        return "d"
    if output == "f":
        return "f"
    if output:
        raise ValidationError(f"注入的宿主路径不是普通文件或目录：{path}")
    raise ValidationError(f"注入的宿主路径不存在（平台不会代为创建）：{path}")


def _reject_directory_content(privilege: Privilege, path: str) -> None:
    """目录内容探测：符号链接与非常规文件一律拒绝。

    - 目录里有符号链接：复制会把断链或预期外的内容带进沙箱；
    - 目录里有 FIFO / 设备 / 套接字：它们在容器里没有意义，
      复制时还可能阻塞（读 FIFO 会一直等下去）。
    """
    links = run(
        privilege.wrap(["find", path, "-type", "l", "-print", "-quit"]),
        check=False,
    )
    found = links.stdout.strip() if links.ok else ""
    if found:
        raise ValidationError(
            f"注入的宿主路径里有符号链接，文件注入不支持符号链接：{found}"
        )
    irregular = run(
        privilege.wrap(
            ["find", path, "!", "-type", "f", "!", "-type", "d", "-print", "-quit"]
        ),
        check=False,
    )
    entry = irregular.stdout.strip() if irregular.ok else ""
    if entry:
        raise ValidationError(
            f"注入的宿主目录里含非常规文件（FIFO/设备/套接字），不支持注入：{entry}"
        )


# ---------------------------------------------------------------- 副本准备
def stage_file_copies(
    specs: list[FileSpec],
    *,
    user: SystemUser,
    privilege: Privilege,
) -> list[MountSpec]:
    """把宿主文件复制成沙箱用户拥有的副本，并生成只读挂载声明。

    六步：清掉既有暂存目录 → 建暂存目录 → 逐条复探类型并复制 → 改属主
    → 目录 0700 → 文件 0600。属主与主组都设成沙箱用户（用 uid / gid 数值，
    不依赖「主组与用户同名」的假设），免 root 守护进程以该用户身份运行，
    能穿过暂存目录把副本挂进容器。

    每条复制前**就地复探一次**类型：预检与复制之间的时间窗里宿主文件
    可能被换掉，不信任早期探测结果。

    任一步失败先删掉整个暂存目录再抛原异常：不留半截副本在宿主上。
    """
    if not specs:
        return []
    staging = staging_root(user.home)
    try:
        # 复用旧账号时先清掉既有暂存目录：不留上一轮的孤儿副本
        run(privilege.wrap(["rm", "-rf", str(staging)]), check=False)
        run(
            privilege.wrap(
                [
                    "install",
                    "-d",
                    "-o",
                    str(user.uid),
                    "-g",
                    str(user.gid),
                    "-m",
                    "0700",
                    str(staging),
                ]
            ),
            check=True,
        )
        for index, spec in enumerate(specs):
            # 复制前就地复探一次：预检与复制之间宿主文件可能被换掉
            probe_host_path(privilege, spec.host_path)
            target = staged_path(user.home, index, spec.host_path)
            # 目标位置先清干净：目录已存在时 cp 会把原件复制进目录里（多一层目录名）
            run(privilege.wrap(["rm", "-rf", str(target)]), check=False)
            run(
                privilege.wrap(["cp", "-r", "--", spec.host_path, str(target)]),
                check=True,
            )
        run(
            privilege.wrap(["chown", "-R", f"{user.uid}:{user.gid}", str(staging)]),
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
        cleanup = run(privilege.wrap(["rm", "-rf", str(staging)]), check=False)
        if not cleanup.ok:
            logger.error(
                "删除注入文件暂存目录失败：%s（%s）", staging, cleanup.output.strip()
            )
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
