"""Port preview credentials (``contracts/preview/1.0``, ``docs`` 09 §5).

Everything here is shared by the Server and the preview-auth service, which run as
separate processes with one shared secret, ``AGENT_SERVER_PREVIEW_INTERNAL_TOKEN``:

- **frp token**: what the Server hands the device in ``preview.open``. frpc logs in to
  frps with it and puts it on each proxy; the frps plugin calls back to the Server, which
  checks it. Bound to the device, the preview and its slug.
- **preview cookie** (``__Host-aa_preview``): what preview-auth sets after a one-time
  ticket was redeemed. preview-auth checks it on every request without calling the
  Server. Bound to the slug and the user.
- **Redis keys** both sides read: the state of each open slug and one-time tickets.

Tokens are ``<base64url(json)>.<base64url(hmac-sha256)>`` with a purpose-specific key.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from typing import Any

COOKIE_NAME = "__Host-aa_preview"
TICKET_PATH = "/__aa/ticket"
SLUG_PATTERN = re.compile(r"^[a-z2-7]{10}$")

_DOMAIN_ENV = "AGENT_SERVER_PREVIEW_DOMAIN"
_TOKEN_ENV = "AGENT_SERVER_PREVIEW_INTERNAL_TOKEN"
_FRPS_ENV = "AGENT_SERVER_PREVIEW_FRPS_ADDR"
MIN_INTERNAL_TOKEN_LENGTH = 32


def preview_domain() -> str | None:
    """The separately registered preview domain (``example-preview.net``), or None."""

    value = os.environ.get(_DOMAIN_ENV, "").strip().lower().strip(".")
    return value or None


def internal_token() -> str | None:
    value = os.environ.get(_TOKEN_ENV, "").strip()
    return value if len(value) >= MIN_INTERNAL_TOKEN_LENGTH else None


def frps_addr() -> str | None:
    """Where frpc connects (``wss://host[:port]/path``, ``tcp://host:port``); default: the preview domain."""

    value = os.environ.get(_FRPS_ENV, "").strip()
    if value:
        return value
    domain = preview_domain()
    return f"wss://frp.{domain}" if domain else None


def slug_from_host(host: str | None, domain: str) -> str | None:
    """``k3x9q2abcd.example-preview.net[:443]`` -> ``k3x9q2abcd``."""

    if not host:
        return None
    name = host.strip().lower().split(":", 1)[0]
    suffix = "." + domain
    if not name.endswith(suffix):
        return None
    slug = name[: -len(suffix)]
    return slug if SLUG_PATTERN.match(slug) else None


def _key(secret: str, purpose: str) -> bytes:
    return hmac.new(secret.encode(), f"aa-preview:{purpose}:v1".encode(), hashlib.sha256).digest()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign(secret: str, purpose: str, claims: dict[str, Any]) -> str:
    body = _b64(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode())
    mac = hmac.new(_key(secret, purpose), body.encode(), hashlib.sha256).digest()
    return f"{body}.{_b64(mac)}"


def verify(secret: str, purpose: str, token: str | None, *, now: float | None = None) -> dict[str, Any] | None:
    """The claims of a valid, unexpired token (``exp`` in epoch seconds), else None."""

    if not token or token.count(".") != 1:
        return None
    body, mac = token.split(".")
    expected = hmac.new(_key(secret, purpose), body.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(_unb64(mac), expected):
            return None
        claims = json.loads(_unb64(body))
    except ValueError:
        return None
    if not isinstance(claims, dict):
        return None
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or exp <= (time.time() if now is None else now):
        return None
    return claims


FRP_TOKEN = "frp"
COOKIE = "cookie"


def state_key(prefix: str, slug: str) -> str:
    """Redis key of an open slug's state, read by preview-auth on every request."""

    return f"{prefix}:preview:slug:{slug}"


def ticket_key(prefix: str, ticket: str) -> str:
    return f"{prefix}:preview:ticket:{hashlib.sha256(ticket.encode()).hexdigest()}"


def ports_key(prefix: str, device_id: str) -> str:
    return f"{prefix}:preview:ports:{device_id}"
