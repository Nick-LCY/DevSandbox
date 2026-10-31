"""启动模板路由：列表、创建、重命名、删除。

模板是一份沙箱启动配置，路由只做编排：落盘与种子注入在
``sandbox_platform/server/templates.py``，请求响应模型在 ``schemas.py``。

四条接口：

- ``GET /api/templates``：裸数组（不包对象），带完整配置体。
- ``POST /api/templates``：创建模板，201。名称零限制（不 strip、不限长）。
- ``POST /api/templates/{id}/rename``：只改名称，标识与其余字段一律不动。
- ``DELETE /api/templates/{id}``：删除模板；删的是内置模板时写墓碑
  （用户删过就不复活）。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sandbox_platform import NotFoundError
from sandbox_platform.metadata import utc_now

from ..deps import get_template_store
from ..schemas import (
    TemplateCreateRequest,
    TemplateDeleteResponse,
    TemplateRenameRequest,
    TemplateResponse,
)
from ..templates import (
    TemplateRecord,
    TemplateStore,
    builtin_template_ids,
    ensure_builtin_templates,
    new_template_id,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/templates", tags=["模板"])


@router.get("", response_model=list[TemplateResponse], summary="列出全部启动模板")
def list_templates(
    store: TemplateStore = Depends(get_template_store),
) -> list[TemplateResponse]:
    """列出全部模板（裸数组），带完整配置体。

    读取时也补一次内置种子：新增内置模板不必等重启。
    种子注入失败只记日志（降级为 warning），不影响模板列表本身。
    """
    try:
        ensure_builtin_templates(store.config)
    except Exception as exc:
        logger.warning("内置模板注入失败（不影响模板列表）：%s", exc)
    return [TemplateResponse.from_record(record) for record in store.list_all()]


@router.post(
    "",
    response_model=TemplateResponse,
    status_code=201,
    summary="创建启动模板",
)
def create_template(
    payload: TemplateCreateRequest,
    store: TemplateStore = Depends(get_template_store),
) -> TemplateResponse:
    """创建模板。

    名称零限制：不 strip、不限长、不校验字符集与保留字。
    配置体只落用户真正填过的字段：「字段缺失」与「字段填了空值」不混同。
    """
    now = utc_now()
    record = TemplateRecord(
        id=new_template_id(),
        name=payload.name,
        config=payload.config.model_dump(exclude_unset=True),
        created_at=now,
        updated_at=now,
    )
    store.save(record)
    return TemplateResponse.from_record(record)


@router.post(
    "/{template_id}/rename",
    response_model=TemplateResponse,
    summary="重命名启动模板",
)
def rename_template(
    template_id: str,
    payload: TemplateRenameRequest,
    store: TemplateStore = Depends(get_template_store),
) -> TemplateResponse:
    """只改名称：模板标识与其余字段一律不动。模板不存在回 404。"""
    record = store.load(template_id)
    if record is None:
        raise NotFoundError(f"模板不存在：{template_id}")
    record.name = payload.name
    record.updated_at = utc_now()
    store.save(record)
    return TemplateResponse.from_record(record)


@router.delete(
    "/{template_id}",
    response_model=TemplateDeleteResponse,
    summary="删除启动模板",
)
def delete_template(
    template_id: str,
    store: TemplateStore = Depends(get_template_store),
) -> TemplateDeleteResponse:
    """删除模板。模板不存在回 404。

    删的是内置模板时顺手写墓碑：后续启动不再把它注入回来（删了不复活）。
    """
    record = store.load(template_id)
    if record is None:
        raise NotFoundError(f"模板不存在：{template_id}")
    deleted = store.delete(template_id)
    if deleted and template_id in builtin_template_ids():
        store.mark_builtin_deleted(template_id)
        logger.info("内置模板已删除并写入墓碑：%s", template_id)
    return TemplateDeleteResponse(id=template_id, deleted=deleted)
