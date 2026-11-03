"""HTTP 错误映射：平台异常 → 状态码 + ``{"detail": "中文消息"}``。

映射固定：入参非法 400、缺必填镜像字段 422、沙箱不存在 404、沙箱已存在 409、
镜像不存在 400、转发链路异常 409 / 502 / 503、其余平台异常 500。

消息策略：

- 400 / 404 / 409 / 422：保留平台异常原文（都是用户侧信息，不含宿主敏感路径）。
- 500：只回固定文案「平台内部错误，请查看服务日志」。平台异常原文可能带宿主
  绝对路径与特权命令行，**只进日志**，不进 HTTP 响应。
- **转发链路（409 / 502 / 503）**：只回**固定主干文案**（按情形给定，不从异常
  原文里截取）。核心异常原文（容器客户端输出、宿主绝对路径、探测细节）
  **只进日志**，不进 HTTP 响应，也不进隧道错误帧。

镜像字段的 422 口径：镜像缺失、传 null、传空串或纯空白串，一律归入
「必须显式指定沙箱镜像」语义（422）；镜像传错类型（如数字）仍算取值非法（400）。
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sandbox_platform import (
    AlreadyExistsError,
    ForwardError,
    ImageNotFoundError,
    NotFoundError,
    SandboxError,
)
from sandbox_platform import ValidationError as PlatformValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)

STATUS_BAD_REQUEST = 400
STATUS_NOT_FOUND = 404
STATUS_CONFLICT = 409
STATUS_SERVER_ERROR = 500
# 上游依赖缺失（转发链路的依赖侧故障）
STATUS_BAD_GATEWAY = 502
# 服务依赖不可用（转发链路的依赖侧故障）
STATUS_SERVICE_UNAVAILABLE = 503
# 缺必填镜像字段：422（默认镜像退役后，镜像是硬性必填项，不是「取值不合法」）
STATUS_UNPROCESSABLE = 422

# 缺 image 字段时的固定提示（422 分支）
MISSING_IMAGE_DETAIL = "image（必填：默认镜像已退役，必须显式指定沙箱镜像）"

# 500 分支的固定文案：平台异常原文只进日志，不回显宿主路径与特权命令行
INTERNAL_ERROR_MESSAGE = "平台内部错误，请查看服务日志"

# ---------------------------------------------------------------- 转发链路固定文案
# 转发链路的响应与隧道错误帧**只出现下面这些固定串**：核心异常原文（容器
# 客户端输出、宿主绝对路径、探测细节）只进日志。
FORWARD_CONFLICT_SANDBOX_STOPPED = "沙箱已停止，无法建立端口转发（请先启动沙箱）"
FORWARD_CONFLICT_CONTAINER_TAKEN = (
    "容器名已被占用：与现有非平台容器重名（请换一个沙箱或端口，或自行处理同名容器）"
)
FORWARD_BAD_GATEWAY_NETWORK = "沙箱网络不存在，无法建立端口转发"
FORWARD_UNAVAILABLE_IMAGE = "转发镜像不可用（镜像拉不到）"
FORWARD_UNAVAILABLE_CONTAINER = "启动转发容器失败"
FORWARD_UNAVAILABLE_PROBE = "转发链路探测失败（沙箱守护进程不可达）"
# 兜底文案（异常原文为空时用）
FORWARD_UNAVAILABLE_MESSAGE = "端口转发链路不可用，请查看服务日志"
# 沙箱已删（记录在、容器删不掉时记录会留下）与记录损坏：固定文案，不回显宿主路径
FORWARD_SANDBOX_MISSING = "沙箱不存在或已删除，端口转发已失效"
FORWARD_RECORD_INVALID = "端口转发记录已损坏"

# 请求体校验失败的常见类型 → 中文提示
_VALIDATION_MESSAGES = {
    "missing": "必填",
    "string_type": "应为字符串",
    "string_pattern_mismatch": "格式不合法",
    "string_too_short": "长度不足",
    "string_too_long": "长度超限",
    "int_type": "应为整数",
    "int_parsing": "应为整数",
    "list_type": "应为列表",
    "dict_type": "应为对象",
    "literal_error": "取值不在允许范围内",
    "value_error": "取值非法",
    "extra_forbidden": "不允许的字段",
}


def error_response(status_code: int, message: str) -> JSONResponse:
    """统一错误响应体。"""
    return JSONResponse(status_code=status_code, content={"detail": message})


def describe_validation_errors(exc: RequestValidationError) -> str:
    """把请求体校验错误整理成一句中文提示。"""
    parts: list[str] = []
    for error in exc.errors():
        location = ".".join(
            str(item) for item in error.get("loc", ()) if item not in ("body", "query", "path")
        )
        field = location or "请求体"
        kind = str(error.get("type", ""))
        detail = _VALIDATION_MESSAGES.get(kind, str(error.get("msg", "取值非法")))
        parts.append(f"{field}（{detail}）")
    if not parts:
        return "请求参数不合法"
    return "请求参数不合法：" + "；".join(parts)


def _is_image_field(error: dict) -> bool:
    """校验错误是不是出在 ``image`` 字段上。"""
    location = [str(item) for item in error.get("loc", ())]
    return bool(location) and location[-1] == "image"


def _is_missing_image(error: dict) -> bool:
    """``image`` 字段是不是「没给镜像」。

    缺失、null、空串、纯空白串都算「没给」：都归入「必须显式指定沙箱镜像」语义。
    类型不对（如传数字）不算：那属于取值非法，仍归 400。
    """
    if not _is_image_field(error):
        return False
    kind = str(error.get("type", ""))
    if kind == "missing":
        return True
    if kind == "string_type":
        # null 传进来等同于没给；类型不对（数字等）仍按取值非法处理
        return error.get("input", None) is None
    if kind == "string_too_short":
        # 空串与纯空白串：与缺失同义
        return True
    return False


def is_missing_image_error(exc: RequestValidationError) -> bool:
    """请求体是不是缺必填的 ``image`` 字段。

    默认沙箱镜像已退役：镜像不再有平台兜底，缺失即 422（明确指出缺哪个字段），
    不落成「取值不合法」那类 400。null、空串、纯空白串与缺失同义。
    """
    return any(_is_missing_image(error) for error in exc.errors())


def describe_missing_image_errors(exc: RequestValidationError) -> str:
    """缺镜像（422）的提示文案。

    镜像字段用固定文案说明「默认镜像已退役、必须显式指定」；
    同一请求里其它字段也缺失时一并列出（不只讲镜像）。
    """
    parts: list[str] = []
    for error in exc.errors():
        if _is_missing_image(error):
            parts.append(MISSING_IMAGE_DETAIL)
            continue
        location = ".".join(
            str(item) for item in error.get("loc", ()) if item not in ("body", "query", "path")
        )
        field = location or "请求体"
        kind = str(error.get("type", ""))
        detail = _VALIDATION_MESSAGES.get(kind, str(error.get("msg", "取值非法")))
        parts.append(f"{field}（{detail}）")
    if not parts:
        return f"请求参数不合法：{MISSING_IMAGE_DETAIL}"
    return "请求参数不合法：" + "；".join(parts)


def describe_http_error(exc: StarletteHTTPException, request: Request) -> str:
    """把框架级 HTTP 错误整理成中文提示。"""
    if exc.status_code == STATUS_NOT_FOUND:
        return f"接口不存在：{request.method} {request.url.path}"
    if exc.status_code == 405:
        return f"接口方法不支持：{request.method} {request.url.path}"
    detail = exc.detail
    return str(detail) if detail else f"请求失败（{exc.status_code}）"


# ---------------------------------------------------------------- 转发链路错误
# ``ForwardError`` 的语义是「转发链路本身跑不起来」（与「对象不存在」、
# 「入参非法」分开）。核心包用固定措辞构造这些消息，服务层按措辞判定状态码，
# 并给出**固定主干文案**：
#
# | 情形 | 状态码 | detail（固定文案） |
# |---|---|---|
# | 沙箱已停止 | 409 | 沙箱已停止，无法建立端口转发（请先启动沙箱） |
# | 容器名与现有非平台容器重名 | 409 | 容器名已被占用：与现有非平台容器重名（请换一个沙箱或端口…） |
# | 沙箱网络不存在 | 502 | 沙箱网络不存在，无法建立端口转发 |
# | 镜像拉不到 | 503 | 转发镜像不可用（镜像拉不到） |
# | 转发容器起不来 | 503 | 启动转发容器失败 |
# | 沙箱守护进程不可达（探测失败） | 503 | 转发链路探测失败（沙箱守护进程不可达） |
# | 转发编排未装配 | 500 | 平台内部错误，请查看服务日志 |
#
# **响应与隧道错误帧里只出现上表的固定文案**：核心异常原文（容器客户端输出、
# 宿主绝对路径、探测细节）**只进日志**。服务端**不再按措辞截取原文**——
# 截取对没有括号的原文（容器客户端多行输出）完全失效，会把整段原文回显出去。
#
# 措辞变更时**必须同步本表**（核心包与服务层的唯一耦合点）。
def classify_forward_error(exc: BaseException | str) -> tuple[int, str]:
    """把转发链路异常映射成（状态码, 固定主干文案）。

    ``exc`` 可以是异常本身（按类型先判：镜像拉不到是 ``ImageNotFoundError``），
    也可以是异常消息（按措辞判情形）。

    **返回值里的文案是固定串**：不含任何核心异常原文。
    """
    if isinstance(exc, ImageNotFoundError):
        # 转发链路的镜像拉不到：语义是「转发服务暂不可用」（503），
        # 不是请求参数错误（400 只留给真正的入参非法）。
        return STATUS_SERVICE_UNAVAILABLE, FORWARD_UNAVAILABLE_IMAGE
    text = exc if isinstance(exc, str) else str(exc)
    text = text or ""
    if not text:
        # 异常原文为空：给兜底文案（不臆测具体情形）
        return STATUS_SERVICE_UNAVAILABLE, FORWARD_UNAVAILABLE_MESSAGE
    if "未装配" in text:
        # 服务端装配问题（转发编排没接上沙箱侧能力）：不是用户侧错误
        return STATUS_SERVER_ERROR, INTERNAL_ERROR_MESSAGE
    if "沙箱已停止" in text:
        # 用户侧可处理：先启动沙箱
        return STATUS_CONFLICT, FORWARD_CONFLICT_SANDBOX_STOPPED
    if "已被占用" in text or "重名" in text:
        # 用户侧可处理：换个沙箱或端口
        return STATUS_CONFLICT, FORWARD_CONFLICT_CONTAINER_TAKEN
    if "网络不存在" in text:
        # 上游依赖缺失（沙箱的网络没了）
        return STATUS_BAD_GATEWAY, FORWARD_BAD_GATEWAY_NETWORK
    if "探测" in text:
        # 沙箱守护进程不可达（探测失败）
        return STATUS_SERVICE_UNAVAILABLE, FORWARD_UNAVAILABLE_PROBE
    # 其余：转发容器起不来等
    return STATUS_SERVICE_UNAVAILABLE, FORWARD_UNAVAILABLE_CONTAINER


def forward_tunnel_error_detail(exc: SandboxError) -> str:
    """隧道错误帧的固定文案（与 REST 同一口径）。

    - ``ForwardError`` / ``ImageNotFoundError``：走 :func:`classify_forward_error`
      的固定文案；
    - ``NotFoundError``：沙箱已删（记录在、容器删不掉时记录会留下）；
    - 其它（``ValidationError`` 等，记录损坏）：固定文案，**不回显宿主路径**。

    核心异常原文只进日志，不进错误帧。
    """
    if isinstance(exc, (ForwardError, ImageNotFoundError)):
        return classify_forward_error(exc)[1]
    if isinstance(exc, NotFoundError):
        return FORWARD_SANDBOX_MISSING
    return FORWARD_RECORD_INVALID


def install_exception_handlers(app: FastAPI) -> None:
    """注册异常处理器（应用工厂调用）。"""

    @app.exception_handler(PlatformValidationError)
    async def _handle_validation(
        request: Request, exc: PlatformValidationError
    ) -> JSONResponse:
        return error_response(STATUS_BAD_REQUEST, str(exc))

    @app.exception_handler(NotFoundError)
    async def _handle_not_found(request: Request, exc: NotFoundError) -> JSONResponse:
        return error_response(STATUS_NOT_FOUND, str(exc))

    @app.exception_handler(AlreadyExistsError)
    async def _handle_already_exists(
        request: Request, exc: AlreadyExistsError
    ) -> JSONResponse:
        return error_response(STATUS_CONFLICT, str(exc))

    @app.exception_handler(ImageNotFoundError)
    async def _handle_image_not_found(
        request: Request, exc: ImageNotFoundError
    ) -> JSONResponse:
        """宿主与沙箱守护进程都没有该镜像：用户侧错误（400），不是服务端故障。"""
        return error_response(STATUS_BAD_REQUEST, str(exc))

    @app.exception_handler(ForwardError)
    async def _handle_forward_error(request: Request, exc: ForwardError) -> JSONResponse:
        """转发链路跑不起来：按固定措辞映射成 409 / 502 / 503（见上表）。

        **响应只给固定主干文案**：核心异常原文（含容器客户端输出与宿主路径）
        只进日志（带日志键，便于排查）。
        """
        status_code, detail = classify_forward_error(exc)
        if status_code >= STATUS_SERVER_ERROR:
            logger.error(
                "转发链路异常[forward-error]：%s %s：%s",
                request.method,
                request.url.path,
                exc,
                exc_info=exc,
            )
        return error_response(status_code, detail)

    @app.exception_handler(SandboxError)
    async def _handle_platform_error(request: Request, exc: SandboxError) -> JSONResponse:
        """其余平台异常一律 500：原文只进日志，响应只给固定文案。"""
        logger.error(
            "平台异常：%s %s（%s）",
            request.method,
            request.url.path,
            exc,
            exc_info=exc,
        )
        return error_response(STATUS_SERVER_ERROR, INTERNAL_ERROR_MESSAGE)

    @app.exception_handler(RequestValidationError)
    async def _handle_request_validation(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # 缺必填的 image 字段：422（默认镜像退役后的硬性要求）
        if is_missing_image_error(exc):
            return error_response(STATUS_UNPROCESSABLE, describe_missing_image_errors(exc))
        return error_response(STATUS_BAD_REQUEST, describe_validation_errors(exc))

    @app.exception_handler(StarletteHTTPException)
    async def _handle_http_error(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        return error_response(exc.status_code, describe_http_error(exc, request))

    @app.exception_handler(Exception)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        """兜底分支：未预期异常一律 500，原文只进日志。"""
        logger.error(
            "服务内部错误：%s %s（%s）",
            request.method,
            request.url.path,
            exc,
            exc_info=exc,
        )
        return error_response(STATUS_SERVER_ERROR, INTERNAL_ERROR_MESSAGE)
