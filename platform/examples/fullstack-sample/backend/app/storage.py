"""MinIO 对象存储访问层（走 S3 协议）。

严禁用本地目录替代：这里的每个读写都真的经过 S3 协议打到 MinIO 容器。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from .config import Settings, get_settings

_client_lock = threading.Lock()
_clients: dict[tuple[str, str, bool], boto3.client] = {}


def _client(settings: Settings) -> boto3.client:
    """取（并缓存）S3 客户端。"""
    key = (settings.minio_endpoint, settings.minio_region, settings.minio_secure)
    with _client_lock:
        client = _clients.get(key)
        if client is None:
            client = boto3.client(
                "s3",
                endpoint_url=(
                    f"https://{settings.minio_endpoint}"
                    if settings.minio_secure
                    else f"http://{settings.minio_endpoint}"
                ),
                aws_access_key_id=settings.minio_access_key,
                aws_secret_access_key=settings.minio_secret_key,
                region_name=settings.minio_region,
                config=Config(
                    signature_version="s3v4",
                    s3={"addressing_style": "path"},
                    retries={"max_attempts": 3, "mode": "standard"},
                ),
            )
            _clients[key] = client
        return client


def ensure_bucket(settings: Settings | None = None) -> str:
    """确保桶存在（幂等）。"""
    conf = settings or get_settings()
    client = _client(conf)
    try:
        client.head_bucket(Bucket=conf.minio_bucket)
    except ClientError:
        client.create_bucket(Bucket=conf.minio_bucket)
    return conf.minio_bucket


@dataclass(frozen=True)
class StoredObject:
    """一次对象存储写入的结果。"""

    key: str
    size: int
    content_type: str


def put_object(
    key: str,
    payload: bytes,
    content_type: str,
    settings: Settings | None = None,
) -> StoredObject:
    """上传对象到 MinIO。"""
    conf = settings or get_settings()
    client = _client(conf)
    client.put_object(
        Bucket=conf.minio_bucket,
        Key=key,
        Body=payload,
        ContentType=content_type or "application/octet-stream",
    )
    return StoredObject(key=key, size=len(payload), content_type=content_type)


def get_object(key: str, settings: Settings | None = None) -> tuple[bytes, str]:
    """从 MinIO 下载对象，返回（内容, 内容类型）。"""
    conf = settings or get_settings()
    client = _client(conf)
    response = client.get_object(Bucket=conf.minio_bucket, Key=key)
    try:
        body = response["Body"].read()
    finally:
        response["Body"].close()
    return body, response.get("ContentType", "application/octet-stream")


def object_exists(key: str, settings: Settings | None = None) -> bool:
    """判断对象是否存在。"""
    conf = settings or get_settings()
    client = _client(conf)
    try:
        client.head_object(Bucket=conf.minio_bucket, Key=key)
    except ClientError:
        return False
    return True


def build_object_key(record_id: str, filename: str) -> str:
    """生成对象键：按记录归档，避免同名覆盖。"""
    safe_name = filename.replace("/", "_").replace("\\", "_").strip() or "file.bin"
    return f"records/{record_id}/{safe_name}"
