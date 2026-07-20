from __future__ import annotations


API_V2_PREFIX = "/api/v2"


def api_v2_path(path: str) -> str:
    normalized = path if path.startswith("/") else f"/{path}"
    return f"{API_V2_PREFIX}{normalized}"
