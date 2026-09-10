from __future__ import annotations

import sys
from urllib.parse import urljoin, urlparse, urlunparse

API_V2_PREFIX = "/api/v2"


def api_v2_path(path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        return path
    normalized = path if path.startswith("/") else f"/{path}"
    if normalized == API_V2_PREFIX or normalized.startswith(f"{API_V2_PREFIX}/"):
        return normalized
    return f"{API_V2_PREFIX}{normalized}"


def api_v2_url(server_url: str, path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        return path
    return urljoin(server_url + "/", api_v2_path(path).lstrip("/"))


def ws_url(server_url: str, path: str) -> str:
    parsed = urlparse(server_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return urlunparse((scheme, parsed.netloc, path, "", "", ""))


def is_loopback_url(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return host in {"127.0.0.1", "localhost", "::1"}


def device_os() -> str:
    if sys.platform == "darwin":
        return "macos"
    if sys.platform == "win32":
        return "windows"
    return "linux"
