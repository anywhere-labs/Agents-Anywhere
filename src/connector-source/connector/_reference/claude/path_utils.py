from __future__ import annotations

import hashlib


def stable_claude_session_id(connector_id: str, claude_uuid: str) -> str:
    """Deterministic session_id derived from (connector, claude session uuid).

    Mirrors connector.codex.adapter.stable_session_id so the backend never
    sees two ids referring to the same upstream session.
    """
    digest = hashlib.sha256(f"{connector_id}:claude:{claude_uuid}".encode("utf-8")).hexdigest()[:24]
    return f"sess_claude_{digest}"
