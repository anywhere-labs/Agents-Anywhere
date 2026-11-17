"""Deployment-level E2EE settings and the route policy of ``required`` mode (docs/v3/11-e2ee-noise.md §9–§11).

``AGENT_SERVER_E2EE=off|required`` (default ``off``) is a *declaration*: the Server tells clients and devices
about it, and in ``required`` mode refuses every plaintext content route. Devices and clients keep their own
local policy and never relax because the Server later says ``off``.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Literal

from agent_server.core.client_routes import (
    content_route_patterns,
    sealed_upload_patterns,
)

E2eeMode = Literal["off", "required"]
AllowDeny = Literal["allow", "deny"]


def _choice(name: str, default: str, allowed: tuple[str, ...]) -> str:
    raw = os.environ.get(name, "").strip().lower()
    value = raw or default
    if value not in allowed:
        raise ValueError(f"{name} must be one of {', '.join(allowed)} (got {raw!r})")
    return value


@dataclass(frozen=True, slots=True)
class E2eeSettings:
    mode: E2eeMode = "off"
    #: ``AGENT_SERVER_E2EE_WEB``: whether the Web client may be used in required mode (it only resists passive leaks).
    web: AllowDeny = "allow"
    #: ``AGENT_SERVER_E2EE_PREVIEW``: port preview stays on by default; its traffic is not end-to-end encrypted.
    preview: AllowDeny = "allow"

    @classmethod
    def from_environment(cls) -> E2eeSettings:
        return cls(
            mode=_choice("AGENT_SERVER_E2EE", "off", ("off", "required")),  # type: ignore[arg-type]
            web=_choice("AGENT_SERVER_E2EE_WEB", "allow", ("allow", "deny")),  # type: ignore[arg-type]
            preview=_choice("AGENT_SERVER_E2EE_PREVIEW", "allow", ("allow", "deny")),  # type: ignore[arg-type]
        )

    @property
    def required(self) -> bool:
        return self.mode == "required"

    def view(self) -> dict[str, str]:
        """What clients see in ``/auth/config`` (public, before login)."""

        return {"mode": self.mode, "web": self.web, "preview": self.preview}


# ---------------------------------------------------------------------------
# Plaintext content routes refused in required mode
# ---------------------------------------------------------------------------
#
# Everything that carries conversation content, files or terminal bytes goes through the secure channel in
# required mode. Metadata routes stay: auth, account, devices and their settings, projects, the session
# directory (display envelopes are sealed), archive/read/pin flags, usage, model configuration, the dashboard
# stream, public share reads (ciphertext) and the tunnel itself.

#: Derived from the client route table (``core.client_routes``): its route families and content routes.
_CONTENT_ROUTE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = content_route_patterns()

#: Encrypted uploads (``agent_server.core.e2ee.SEALED_UPLOAD_HEADER``) are allowed on the attachment route.
_SEALED_UPLOADS: tuple[re.Pattern[str], ...] = sealed_upload_patterns()


def requires_secure_channel(method: str, path: str, *, sealed_upload: bool = False) -> bool:
    """True when ``method path`` is a plaintext content route that ``required`` mode refuses."""

    method = method.upper()
    if sealed_upload and method == "POST" and any(pattern.fullmatch(path) for pattern in _SEALED_UPLOADS):
        return False
    return any(
        (expected == "*" or expected == method) and pattern.fullmatch(path)
        for expected, pattern in _CONTENT_ROUTE_PATTERNS
    )


def e2ee_required_error() -> dict[str, str]:
    return {
        "code": "e2ee_required",
        "message": "This server requires end-to-end encryption; use the secure channel (/api/v3/tunnel).",
    }


def accept_display_envelope(mode: E2eeMode, envelope: dict | None) -> dict | None:
    """What the session directory may store. In required mode a plaintext envelope is dropped (the list shows
    "encrypting until the device is online") instead of being written, even if a device sends one."""

    if envelope is None:
        return None
    if mode == "required" and envelope.get("mode") != "sealed":
        return None
    return envelope
