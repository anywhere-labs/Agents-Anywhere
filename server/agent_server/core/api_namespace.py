from __future__ import annotations


API_V2_PREFIX = "/api/v2"


def api_v2_path(path: str) -> str:
    normalized = path if path.startswith("/") else f"/{path}"
    return f"{API_V2_PREFIX}{normalized}"


# v3 additions (device link, secure-channel tunnel, E2EE side channels) live beside /api/v2.
API_V3_PREFIX = "/api/v3"
