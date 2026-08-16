from __future__ import annotations

import hashlib


def stable_runtime_session_id(
    connector_id: str,
    runtime: str,
    external_session_id: str,
) -> str:
    """Return the canonical AA session ID for a discovered runtime session."""
    if not connector_id:
        raise ValueError("connector_id must not be empty")
    if not runtime:
        raise ValueError("runtime must not be empty")
    if not external_session_id:
        raise ValueError("external_session_id must not be empty")
    digest = hashlib.sha256(
        f"{connector_id}:{runtime}:{external_session_id}".encode("utf-8")
    ).hexdigest()[:24]
    return f"sess_{runtime}_{digest}"
