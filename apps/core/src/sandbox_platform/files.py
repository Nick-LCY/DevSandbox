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
- 注入源不得落在**任何沙箱用户家目录**内（含本次目标沙箱自己的家目录）；
- 命中宿主敏感清单（``/etc`` ``/proc`` ``/root`` 等、平台数据根、宿主 Docker
  套接字）一律拒绝；
- 注入源的校验是**双重**的：词法归一化（``..``、前导多斜杠）之后比一次，
  符号链接解析出的真实路径再比一次。
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

from .command import run
from .errors import ValidationError
from .mounts import (
    MountSpec,
    is_under,
    normalize_host_path,
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


@dataclass(frozen=True)
class FileSpec:
    """一条文件注入声明（宿主路径 + 容器内路径）。"""

    host_path: str
    container_path: str


@dataclass(frozen=True)
class SandboxHomeScope:
    """注入源的宿主范围限制（信任边界收口）。

    注入源不得落在**任何**沙箱用户家目录内（含本次目标沙箱自己的家目录）：
    那是沙箱账号的家，平台以特权身份把它复制进沙箱，等于替别人读了文件。

    - ``user_prefix``：平台沙箱用户名前缀（取自配置的 ``user_prefix``），
      沙箱用户的家目录名形如 ``<前缀>-<沙箱名>``；
    - ``privilege``：宿主命令通道（读系统用户表用；``None`` 表示普通通道）。

    家目录集合每次现查：沙箱会被创建也会被删，集合不能是启动时的快照。
    同一个 scope 实例内取一次快照（同一次声明解析里不重复查系统用户表）。
    """

    user_prefix: str
    privilege: Privilege | None = None

    def homes(self) -> tuple[Path, ...]:
        """宿主上属于平台沙箱用户的家目录。"""
        return self._homes

    @cached_property
    def _homes(self) -> tuple[Path, ...]:
        """家目录快照（同一个 scope 实例内只查一次系统用户表）。"""
        return sandbox_user_homes(self.user_prefix, privilege=self.privilege)


def sandbox_user_homes(
    user_prefix: str,
    *,
    privilege: Privilege | None = None,
) -> tuple[Path, ...]:
    """枚举宿主上平台沙箱用户的家目录（经 ``getent passwd``）。

    - 只认系统用户名以 ``<前缀>-`` 开头的条目（沙箱用户的家目录名就是
      ``<前缀>-<沙箱名>``）；
    - 家目录取系统用户表里的家目录字段，**不猜固定家目录根**：宿主把沙箱
      用户的家放在别处（``/srv/homes`` 等）同样覆盖得到；
    - 家目录必须真实存在：用户条目残留但目录已删的不算。
    """
    prefix = f"{user_prefix}-"
    result = run(_host_argv(privilege, ["getent", "passwd"]), check=False)
    if not result.ok:
        logger.warning(
            "读取系统用户表失败，沙箱用户家目录范围限制暂时失效：%s",
            result.output.strip(),
        )
        return ()
    homes: list[Path] = []
    seen: set[str] = set()
    for line in result.stdout.splitlines():
        fields = line.strip().split(":")
        if len(fields) < 6:
            continue
        name, home_raw = fields[0], fields[5]
        if not name.startswith(prefix) or not home_raw:
            continue
        key = normalize_host_path(home_raw)
        if key in seen:
            continue
        seen.add(key)
        if not _home_dir_exists(Path(key), privilege):
            continue
        homes.append(Path(key))
    return tuple(homes)


def _host_argv(privilege: Privilege | None, argv: list[str]) -> list[str]:
    """宿主命令参数：给了特权通道就走特权通道，否则走普通通道。"""
    if privilege is None:
        return list(argv)
    return privilege.wrap(argv)


def _home_dir_exists(home: Path, privilege: Privilege | None) -> bool:
    """家目录是否存在。

    走宿主命令判定而不是 ``Path.is_dir()``：沙箱用户的家目录权限是 0700
    且属主是那个沙箱用户，服务身份（普通用户）根本 stat 不了，会把真实存在
    的家目录误判成不存在。
    """
    result = run(_host_argv(privilege, ["test", "-d", str(home)]), check=False)
    return result.ok


def reject_sandbox_user_home(path: str | Path, scope: SandboxHomeScope) -> None:
    """注入源落在沙箱用户家目录内时拒绝（含本次目标沙箱自己的家目录）。"""
    target = Path(normalize_host_path(str(path)))
    for home in scope.homes():
        if is_under(target, home):
            raise ValidationError(
                f"注入的宿主路径落在沙箱用户家目录内，不允许注入：{target}"
                f"（含本次沙箱自己的家目录）"
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
    ``/etc/shadow``，用原始路径比会漏掉它；``//etc/shadow`` 同理（``normpath``
    会把两个前导斜杠原样留着，必须额外压平）。
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

    host_norm = normalize_host_path(host_raw)
    reject_sensitive_host_path(Path(host_norm), forbidden, action="注入文件")
    if home_scope is not None:
        reject_sandbox_user_home(host_norm, home_scope)
    return FileSpec(
        host_path=host_norm,
        container_path=normalize_host_path(container_raw),
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
def probe_host_path(
    privilege: Privilege,
    path: str,
    *,
    extra_forbidden: Iterable[str | Path] = (),
    home_scope: SandboxHomeScope | None = None,
) -> str:
    """探测宿主路径的类型：``f``（普通文件）或 ``d``（目录）。

    先用 ``find -printf %y`` 判类型（悬空符号链接也判得出「符号链接」，
    不误报成「不存在」），命令失败才报不存在。符号链接一律拒绝：
    跟随会带出非预期内容，复制链接本身又会留下一条断链。

    末尾再做一次**真实路径复核**：``readlink -f`` 解析出符号链接指向的实际
    位置，对真实路径重跑一遍敏感清单与家目录范围校验。词法归一化管不到
    「中间路径段是符号链接」的情况——``/tmp/link/secret``（``link`` 指向
    ``/home/sandbox-x``）词法上既不在 ``/etc`` 之下也不在任何家目录之下，
    只有解析后的真实路径才看得穿。
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
        detected = "d"
    elif output == "f":
        detected = "f"
    elif output:
        raise ValidationError(f"注入的宿主路径不是普通文件或目录：{path}")
    else:
        raise ValidationError(f"注入的宿主路径不存在（平台不会代为创建）：{path}")
    _reject_resolved_restricted(privilege, path, extra_forbidden, home_scope)
    return detected


def _reject_resolved_restricted(
    privilege: Privilege,
    path: str,
    extra_forbidden: Iterable[str | Path],
    home_scope: SandboxHomeScope | None,
) -> None:
    """符号链接解析后的真实路径复核：落在受限范围里就拒绝。

    受限范围有两层：宿主敏感清单（固定清单 + 调用方追加项，如平台数据根）
    与沙箱用户家目录。
    """
    real = _resolve_real_path(privilege, path)
    if real is None:
        return
    forbidden = sensitive_host_paths(extra_forbidden)
    try:
        reject_sensitive_host_path(Path(real), forbidden, action="注入文件")
    except ValidationError:
        raise ValidationError(
            f"注入的宿主路径经符号链接解析后落在受限范围：{real}（声明路径 {path}）"
        ) from None
    if home_scope is None:
        return
    try:
        reject_sandbox_user_home(real, home_scope)
    except ValidationError:
        raise ValidationError(
            f"注入的宿主路径经符号链接解析后落在受限范围：{real}（声明路径 {path}）"
        ) from None


def _resolve_real_path(privilege: Privilege, path: str) -> str | None:
    """解析宿主路径的真实位置（跟随全部路径段上的符号链接）。

    ``readlink -f`` 走特权通道：别的用户的家目录普通身份读不了，中间的
    符号链接也穿不过去。解析不出来（命令失败）时返回 ``None``：不做判定。
    """
    result = run(privilege.wrap(["readlink", "-f", "--", path]), check=False)
    if not result.ok:
        return None
    real = result.stdout.strip()
    if not real:
        return None
    return normalize_host_path(real)


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
    extra_forbidden: Iterable[str | Path] = (),
    home_scope: SandboxHomeScope | None = None,
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
            probe_host_path(
                privilege,
                spec.host_path,
                extra_forbidden=extra_forbidden,
                home_scope=home_scope,
            )
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
