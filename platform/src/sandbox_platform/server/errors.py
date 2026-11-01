"""HTTP 错误映射：平台异常 → 状态码 + ``{"detail": "中文消息"}``。

映射固定：入参非法 400、缺必填镜像字段 422、沙箱不存在 404、沙箱已存在 409、
镜像不存在 400、其余平台异常 500。

消息策略：

- 400 / 404 / 409 / 422：保留平台异常原文（都是用户侧信息，不含宿主敏感路径）。
- 500：只回固定文案「平台内部错误，请查看服务日志」。平台异常原文可能带宿主
  绝对路径与特权命令行，**只进日志**，不进 HTTP 响应。

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
# 缺必填镜像字段：422（默认镜像退役后，镜像是硬性必填项，不是「取值不合法」）
STATUS_UNPROCESSABLE = 422

# 缺 image 字段时的固定提示（422 分支）
MISSING_IMAGE_DETAIL = "image（必填：默认镜像已退役，必须显式指定沙箱镜像）"

# 500 分支的固定文案：平台异常原文只进日志，不回显宿主路径与特权命令行
INTERNAL_ERROR_MESSAGE = "平台内部错误，请查看服务日志"

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
