"""User-chosen device settings the server hands to this Connector.

See docs/api/device-settings.md. The server stores them; the Connector only
passes the latest value on to the process that launched it (Desktop) through
the local control state. Unknown or malformed fields are dropped so an older
Connector never forwards something a newer server invented.
"""

from __future__ import annotations

from typing import Any

DEVICE_SETTINGS_APPLY_METHOD = "connector.deviceSettings.apply"

_DEFAULTS: dict[str, bool] = {"confirmQuitOnShutdown": False}


def normalize_device_settings(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    return {
        name: source[name] if isinstance(source.get(name), bool) else default
        for name, default in _DEFAULTS.items()
    }
