"""Read, change and deliver user-chosen device settings.

The server is the source of truth: a change is stored first and then handed to
the connector if it is online. A connector that connects later receives the
stored settings once its socket is ready, so offline changes are not lost.
"""

from __future__ import annotations

import asyncio
import secrets
from typing import Any, Protocol

from loguru import logger

from agent_server.core.device_settings import (
    DEVICE_SETTINGS_APPLY_METHOD,
    DEVICE_SETTINGS_COMMAND,
    ConnectorDeviceSettings,
    ConnectorDeviceSettingsPatch,
    apply_device_settings_patch,
    device_settings_command_payload,
    device_settings_from_stored,
)
from agent_server.core.models import ConnectorView
from agent_server.services.device_runtimes import device_commands_of

# Delivery is a courtesy on top of the stored value; never hold a client
# request or a connection's startup on a slow device for long.
DELIVERY_TIMEOUT_SECONDS = 5.0


class ConnectorDeviceSettingsRepository(Protocol):
    async def get_connector(self, connector_id: str) -> ConnectorView: ...

    async def get_connector_device_settings(self, connector_id: str) -> dict[str, Any]: ...

    async def update_connector_device_settings(
        self,
        connector_id: str,
        settings: dict[str, Any],
    ) -> dict[str, Any]: ...


class DeviceSettingsRequester(Protocol):
    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float = 30,
    ) -> Any: ...


async def get_device_settings(
    store: ConnectorDeviceSettingsRepository,
    connector_id: str,
    *,
    user_id: str,
) -> ConnectorDeviceSettings:
    """Raise ``KeyError`` when the connector does not exist or is not the user's."""
    connector = await store.get_connector(connector_id)
    if connector.userId != user_id:
        raise KeyError(connector_id)
    return device_settings_from_stored(await store.get_connector_device_settings(connector_id))


async def update_device_settings(
    store: ConnectorDeviceSettingsRepository,
    requester: DeviceSettingsRequester,
    connector_id: str,
    patch: ConnectorDeviceSettingsPatch,
    *,
    user_id: str,
) -> tuple[ConnectorDeviceSettings, bool]:
    """Store the change, then try to deliver it; returns the settings and delivery."""
    current = await get_device_settings(store, connector_id, user_id=user_id)
    settings = apply_device_settings_patch(current, patch)
    await store.update_connector_device_settings(connector_id, settings.model_dump())
    link_contract = getattr(store, "connector_link_contract", None)
    if link_contract is not None and await link_contract(connector_id):
        delivered = await deliver_device_settings_v3(requester, connector_id, settings)
    else:
        delivered = await deliver_device_settings(requester, connector_id, settings)
    return settings, delivered


async def deliver_device_settings_v3(
    requester: Any,
    connector_id: str,
    settings: ConnectorDeviceSettings,
    *,
    commands: Any | None = None,
) -> bool:
    """v3 devices: the ``device.settings.apply`` command.

    Offline (or the outcome unknown), the stored value still reaches the device in
    ``LinkWelcome.desired.deviceSettings`` when it links again, so the change is never lost.
    """
    commands = commands or device_commands_of(requester)
    if commands is None:
        return False
    try:
        outcome = await commands.send(
            user_id=None,
            device_id=connector_id,
            kind=DEVICE_SETTINGS_COMMAND,
            command_id=f"ds_{secrets.token_urlsafe(16)}",
            payload=device_settings_command_payload(settings),
            timeout=DELIVERY_TIMEOUT_SECONDS,
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - offline, unknown outcome or a rejection
        logger.info(
            "device settings not delivered connector_id={} error={}",
            connector_id,
            getattr(exc, "code", None) or str(exc) or exc.__class__.__name__,
        )
        return False
    return isinstance(outcome.result, dict) and outcome.result.get("applied") is True


async def deliver_stored_device_settings(
    store: ConnectorDeviceSettingsRepository,
    requester: DeviceSettingsRequester,
    connector_id: str,
) -> bool:
    """Hand the stored settings to a connector that has just connected."""
    try:
        stored = await store.get_connector_device_settings(connector_id)
    except KeyError:
        return False
    return await deliver_device_settings(
        requester, connector_id, device_settings_from_stored(stored)
    )


async def deliver_device_settings(
    requester: DeviceSettingsRequester,
    connector_id: str,
    settings: ConnectorDeviceSettings,
) -> bool:
    """Return whether the connector confirmed; offline or older connectors do not."""
    try:
        result = await requester.request(
            connector_id,
            DEVICE_SETTINGS_APPLY_METHOD,
            {"settings": settings.model_dump()},
            timeout=DELIVERY_TIMEOUT_SECONDS,
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - offline, timeout or an older connector
        logger.info(
            "device settings not delivered connector_id={} error={}",
            connector_id,
            str(exc) or exc.__class__.__name__,
        )
        return False
    return isinstance(result, dict) and result.get("applied") is True
