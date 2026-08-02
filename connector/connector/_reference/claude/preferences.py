from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from connector.time import utc_now


def _settings_path() -> Path:
    return Path.home() / ".claude" / "settings.json"


def read_local_preferences(path: Path | None = None) -> dict[str, Any]:
    """Read the user's ~/.claude/settings.json and surface the fields the
    backend cares about. Returns an empty dict if the file is missing or
    unreadable; missing fields surface as None so the frontend can fall back
    to the seeded `is_default` choice.

    Shape mirrors what `connector.preferencesUpdated` puts on the wire.
    """
    target = path or _settings_path()
    if not target.exists():
        return {}
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    permissions = data.get("permissions")
    permission_mode = permissions.get("defaultMode") if isinstance(permissions, dict) else None
    return {
        "permissionMode": permission_mode if isinstance(permission_mode, str) else None,
        "model": data.get("model") if isinstance(data.get("model"), str) else None,
        "effort": data.get("effort") if isinstance(data.get("effort"), str) else None,
        "readAt": utc_now(),
    }
