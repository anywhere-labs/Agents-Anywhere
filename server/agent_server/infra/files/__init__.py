from __future__ import annotations

import os
from pathlib import Path

from agent_server.infra.files.base import FileStorage
from agent_server.infra.files.local import LocalFileStorage

LOCAL_BACKEND = "local"
S3_BACKEND = "s3"


def build_file_storage(*, default_local_root: Path) -> FileStorage:
    """Construct a FileStorage based on env configuration.

    Env vars:
      AGENT_SERVER_FILES_BACKEND — "local" (default) or "s3"
      AGENT_SERVER_FILES_LOCAL_ROOT — override the local root directory
    """
    backend = os.environ.get("AGENT_SERVER_FILES_BACKEND", LOCAL_BACKEND).lower()
    if backend == LOCAL_BACKEND:
        root_env = os.environ.get("AGENT_SERVER_FILES_LOCAL_ROOT")
        root = Path(root_env) if root_env else default_local_root
        return LocalFileStorage(root)
    if backend == S3_BACKEND:
        raise NotImplementedError(
            "S3 file storage is not yet implemented; "
            "set AGENT_SERVER_FILES_BACKEND=local to use the default."
        )
    raise ValueError(f"unknown AGENT_SERVER_FILES_BACKEND: {backend!r}")


__all__ = ["FileStorage", "LocalFileStorage", "build_file_storage"]
