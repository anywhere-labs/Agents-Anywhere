from __future__ import annotations

import os
from pathlib import Path

from agent_server.infra.files.base import FileStorage
from agent_server.infra.files.local import LocalFileStorage
from agent_server.infra.files.s3 import S3FileStorage

LOCAL_BACKEND = "local"
S3_BACKEND = "s3"


def build_file_storage(*, default_local_root: Path) -> FileStorage:
    """Construct a FileStorage based on env configuration.

    Env vars:
      AGENT_SERVER_FILES_BACKEND — "local" (default) or "s3"
      AGENT_SERVER_FILES_LOCAL_ROOT — override the local root directory
      AGENT_SERVER_FILES_S3_BUCKET — S3 bucket name
      AGENT_SERVER_FILES_S3_PREFIX — optional key prefix
      AGENT_SERVER_FILES_S3_ACCESS_KEY — S3 access key
      AGENT_SERVER_FILES_S3_SECRET_KEY — S3 secret key
      AGENT_SERVER_FILES_S3_REGION — S3 region, defaults to us-east-1
      AGENT_SERVER_FILES_S3_ENDPOINT_URL — optional S3-compatible endpoint
      AGENT_SERVER_FILES_S3_VIRTUAL_HOST_STYLE — true/false
    """
    backend = os.environ.get("AGENT_SERVER_FILES_BACKEND", LOCAL_BACKEND).lower()
    if backend == LOCAL_BACKEND:
        root_env = os.environ.get("AGENT_SERVER_FILES_LOCAL_ROOT")
        root = Path(root_env) if root_env else default_local_root
        return LocalFileStorage(root)
    if backend == S3_BACKEND:
        return S3FileStorage(
            bucket=_required_env("AGENT_SERVER_FILES_S3_BUCKET"),
            prefix=os.environ.get("AGENT_SERVER_FILES_S3_PREFIX", ""),
            access_key=_required_env("AGENT_SERVER_FILES_S3_ACCESS_KEY"),
            secret_key=_required_env("AGENT_SERVER_FILES_S3_SECRET_KEY"),
            region=os.environ.get("AGENT_SERVER_FILES_S3_REGION", "us-east-1"),
            endpoint_url=os.environ.get("AGENT_SERVER_FILES_S3_ENDPOINT_URL"),
            virtual_host_style=_bool_env("AGENT_SERVER_FILES_S3_VIRTUAL_HOST_STYLE", False),
        )
    raise ValueError(f"unknown AGENT_SERVER_FILES_BACKEND: {backend!r}")


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required when AGENT_SERVER_FILES_BACKEND=s3")
    return value


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


__all__ = ["FileStorage", "LocalFileStorage", "S3FileStorage", "build_file_storage"]
