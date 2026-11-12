"""User-chosen device settings (docs/api/device-settings.md).

The server owns these switches and hands them to the connector; the stored
JSON may be missing, partial or written by an older server, so every read goes
through :func:`device_settings_from_stored`.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict

DEVICE_SETTINGS_APPLY_METHOD = "connector.deviceSettings.apply"


class ConnectorDeviceSettings(BaseModel):
    confirmQuitOnShutdown: bool = False


class ConnectorDeviceSettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmQuitOnShutdown: bool | None = None


class ConnectorDeviceSettingsResponse(BaseModel):
    connectorId: str
    settings: ConnectorDeviceSettings
    # Only set by a write: whether an online connector confirmed the change.
    delivered: bool | None = None
    serverTime: str


def device_settings_from_stored(value: Any) -> ConnectorDeviceSettings:
    """Read stored settings, keeping known valid fields and defaulting the rest."""
    if not isinstance(value, dict):
        return ConnectorDeviceSettings()
    known = {
        name: value[name]
        for name, field in ConnectorDeviceSettings.model_fields.items()
        if field.annotation is bool and isinstance(value.get(name), bool)
    }
    return ConnectorDeviceSettings(**known)


def apply_device_settings_patch(
    current: ConnectorDeviceSettings,
    patch: ConnectorDeviceSettingsPatch,
) -> ConnectorDeviceSettings:
    changes = patch.model_dump(exclude_none=True)
    return current.model_copy(update=changes)
