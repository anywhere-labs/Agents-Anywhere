from __future__ import annotations

from typing import Any


def read_local_preferences() -> dict[str, Any]:
    """Read connector-wide local preferences.

    Runtime-specific preference readers belong in runtime implementations. The
    active Connector no longer imports reference Codex/Claude packages.
    """

    return {}
