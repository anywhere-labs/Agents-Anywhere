"""
A modular, sync and async S3 client.
"""

from .client import S3Client
from .aclient import AsyncS3Client
from .config import S3Config
from .exceptions import S3ClientError, S3AuthError, S3ObjectNotFoundError
from .signing import AWSSigV4Auth
from .kv import S3KV, AsyncS3KV

__all__ = [
    "S3Client",
    "AsyncS3Client",
    "S3Config",
    "S3ClientError",
    "S3AuthError",
    "S3ObjectNotFoundError",
    "AWSSigV4Auth",
    "ContentTypes",
    "S3KV",
    "AsyncS3KV",
]

from .utils import ContentTypes
