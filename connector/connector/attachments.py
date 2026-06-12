from __future__ import annotations

import re
from pathlib import Path


ATTACHMENTS_ROOT_ENV = "AGENT_CONNECTOR_ATTACHMENTS_ROOT"
DEFAULT_ATTACHMENTS_DIR = ".agents-anywhere/attachments"
_SAFE_FILENAME_RE = re.compile(r"[^\w.\-+]+")


def attachments_root() -> Path:
    """Return the connector-local root used for runtime attachment copies."""
    import os

    configured = os.environ.get(ATTACHMENTS_ROOT_ENV)
    root = Path(configured).expanduser() if configured else Path.home() / DEFAULT_ATTACHMENTS_DIR
    return root.resolve(strict=False)


def session_attachments_dir(session_id: str) -> Path:
    session = _safe_filename(session_id) or "session"
    return attachments_root() / session


def attachment_target(session_id: str, file_id: str, original_name: str | None) -> Path:
    safe_file_id = _safe_filename(file_id) or "file"
    safe_name = _safe_filename(original_name or "") or safe_file_id
    return session_attachments_dir(session_id) / f"{safe_file_id}-{safe_name}"


def _safe_filename(name: str) -> str:
    """Reduce arbitrary user/server values to safe single path components."""
    name = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    sanitized = _SAFE_FILENAME_RE.sub("_", name).strip("._") or ""
    return sanitized[:120]
