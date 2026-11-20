"""User-chosen device settings (docs/api/device-settings.md).

The server owns these switches and hands them to the connector; the stored
JSON may be missing, partial or written by an older server, so every read goes
through :func:`device_settings_from_stored`.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from agent_server.core.agent_collab import (
    DEVICE_SETTINGS_KEY,
    AgentCollaborationSettings,
    collaboration_settings_from_stored,
)

# v2 Connector RPC method (the v2 WebSocket only).
DEVICE_SETTINGS_APPLY_METHOD = "connector.deviceSettings.apply"
# v3 device command (contracts/device-meshcall/1.0 ``Commands/deviceSettingsApply``); deferrable: an
# offline device gets the stored settings in ``LinkWelcome.desired.deviceSettings``.
DEVICE_SETTINGS_COMMAND = "device.settings.apply"


class ConnectorDeviceSettings(BaseModel):
    confirmQuitOnShutdown: bool = False


class DeviceSettingsPayload(ConnectorDeviceSettings):
    """What a device gets (``device.settings.apply``, ``LinkWelcome.desired.deviceSettings``): its own settings and
    the account's agent collaboration settings, which every device of the account shares."""

    agentCollaboration: AgentCollaborationSettings = Field(default_factory=AgentCollaborationSettings)


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


def device_settings_payload(
    settings: ConnectorDeviceSettings, collaboration: AgentCollaborationSettings | dict[str, Any] | None
) -> DeviceSettingsPayload:
    """The device's settings with the account's collaboration settings under ``agentCollaboration``."""

    if not isinstance(collaboration, AgentCollaborationSettings):
        collaboration = collaboration_settings_from_stored(collaboration)
    return DeviceSettingsPayload(**settings.model_dump(), **{DEVICE_SETTINGS_KEY: collaboration})


def device_settings_command_payload(settings: ConnectorDeviceSettings) -> dict[str, Any]:
    """``device.settings.apply`` payload: the whole settings object, as ``LinkWelcome.desired`` has it (a plain
    ``ConnectorDeviceSettings`` gets the default, all-off ``agentCollaboration``)."""
    if not isinstance(settings, DeviceSettingsPayload):
        settings = device_settings_payload(settings, None)
    return {"settings": settings.model_dump(mode="json")}
