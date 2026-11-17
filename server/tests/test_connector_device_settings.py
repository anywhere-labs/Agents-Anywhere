from __future__ import annotations

import asyncio
from typing import Any

import pytest
from conftest import ApiV2TestClient as TestClient
from test_runtime_config import _auth_headers

from agent_server.app import create_app
from agent_server.core.device_settings import (
    DEVICE_SETTINGS_COMMAND,
    ConnectorDeviceSettings,
    ConnectorDeviceSettingsPatch,
    device_settings_command_payload,
    device_settings_from_stored,
)
from agent_server.core.models import ConnectorView
from agent_server.services.connector_device_settings import (
    get_device_settings,
    update_device_settings,
)
from agent_server.services.device_commands import (
    CommandOutcome,
    DeviceCommandOffline,
    DeviceCommandOutcomeUnknown,
    DeviceCommandRejected,
)

V3_CONTRACT = "device-meshcall/1.0"


class FakeStore:
    def __init__(
        self,
        stored: dict[str, Any] | None = None,
        owner: str = "user",
        link_contract: str | None = V3_CONTRACT,
    ) -> None:
        self.stored = stored if stored is not None else {}
        self.owner = owner
        self.link_contract = link_contract
        self.writes: list[dict[str, Any]] = []

    async def get_connector(self, connector_id: str) -> ConnectorView:
        return ConnectorView(
            id=connector_id,
            userId=self.owner,
            name="dev",
            connectorKind="desktop",
            status="online",
            createdAt="2026-11-09T00:00:00Z",
            updatedAt="2026-11-09T00:00:00Z",
        )

    async def get_connector_device_settings(self, connector_id: str) -> dict[str, Any]:
        return dict(self.stored)

    async def update_connector_device_settings(
        self, connector_id: str, settings: dict[str, Any]
    ) -> dict[str, Any]:
        self.stored = dict(settings)
        self.writes.append(dict(settings))
        return settings

    async def connector_link_contract(self, connector_id: str) -> str | None:
        return self.link_contract


class FakeCommands:
    """``DeviceCommandService.send`` answering with ``result`` or raising ``error``."""

    def __init__(self, result: Any = None, error: Exception | None = None) -> None:
        self.result = {"applied": True} if result is None else result
        self.error = error
        self.sent: list[tuple[str, str, dict[str, Any]]] = []

    async def send(self, *, user_id, device_id, kind, command_id, payload, **_kwargs) -> CommandOutcome:
        self.sent.append((device_id, kind, payload))
        if self.error is not None:
            raise self.error
        return CommandOutcome(command_id=command_id, result=self.result, replayed=False)


def _update(store: FakeStore, commands: FakeCommands, patch: ConnectorDeviceSettingsPatch):
    return asyncio.run(update_device_settings(store, commands, "conn", patch, user_id="user"))


def test_stored_settings_default_and_ignore_invalid_values() -> None:
    assert device_settings_from_stored(None) == ConnectorDeviceSettings()
    assert device_settings_from_stored({"confirmQuitOnShutdown": "yes", "x": 1}) == (
        ConnectorDeviceSettings()
    )
    assert device_settings_from_stored({"confirmQuitOnShutdown": True}).confirmQuitOnShutdown


def test_patch_rejects_unknown_fields() -> None:
    with pytest.raises(ValueError):
        ConnectorDeviceSettingsPatch.model_validate({"blockShutdown": True})


def test_update_stores_then_delivers_to_a_v3_device() -> None:
    store = FakeStore()
    commands = FakeCommands()

    settings, delivered = _update(store, commands, ConnectorDeviceSettingsPatch(confirmQuitOnShutdown=True))

    assert settings.confirmQuitOnShutdown is True
    assert delivered is True
    assert store.writes == [{"confirmQuitOnShutdown": True}]
    assert commands.sent == [("conn", DEVICE_SETTINGS_COMMAND, device_settings_command_payload(settings))]


def test_update_keeps_change_when_the_device_does_not_apply_it() -> None:
    for commands in (
        FakeCommands(error=DeviceCommandOffline()),
        FakeCommands(error=DeviceCommandOutcomeUnknown(None)),
        FakeCommands(error=DeviceCommandRejected("unsupported", "not supported", None)),
        FakeCommands(result={"unexpected": True}),
    ):
        store = FakeStore()
        settings, delivered = _update(store, commands, ConnectorDeviceSettingsPatch(confirmQuitOnShutdown=True))
        assert settings.confirmQuitOnShutdown is True
        assert delivered is False
        assert store.stored == {"confirmQuitOnShutdown": True}


def test_a_v2_connector_only_stores_the_change() -> None:
    store = FakeStore(link_contract=None)
    commands = FakeCommands()

    settings, delivered = _update(store, commands, ConnectorDeviceSettingsPatch(confirmQuitOnShutdown=True))

    assert settings.confirmQuitOnShutdown is True
    assert delivered is False
    assert store.stored == {"confirmQuitOnShutdown": True}
    assert commands.sent == []


def test_omitted_fields_keep_their_value() -> None:
    store = FakeStore({"confirmQuitOnShutdown": True})
    settings, _ = _update(store, FakeCommands(), ConnectorDeviceSettingsPatch())
    assert settings.confirmQuitOnShutdown is True


def test_settings_of_another_user_are_not_found() -> None:
    with pytest.raises(KeyError):
        asyncio.run(get_device_settings(FakeStore(owner="other"), "conn", user_id="user"))


def test_device_settings_api_round_trip(tmp_path) -> None:
    client = TestClient(create_app())
    headers = _auth_headers(client)
    created = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert created.status_code == 200, created.text
    connector_id = created.json()["connector"]["id"]
    path = f"/connectors/{connector_id}/device-settings"

    initial = client.get(path, headers=headers)
    assert initial.status_code == 200, initial.text
    assert initial.json()["settings"] == {"confirmQuitOnShutdown": False}
    assert initial.json()["delivered"] is None

    changed = client.patch(path, headers=headers, json={"confirmQuitOnShutdown": True})
    assert changed.status_code == 200, changed.text
    assert changed.json()["settings"] == {"confirmQuitOnShutdown": True}
    # The device has never linked, so the change waits for it.
    assert changed.json()["delivered"] is False
    assert client.get(path, headers=headers).json()["settings"] == {"confirmQuitOnShutdown": True}

    assert client.patch(path, headers=headers, json={"unknown": True}).status_code == 422

    client.patch("/admin/settings", headers=headers, json={"registrationOpen": True}).raise_for_status()
    registered = client.post(
        "/auth/register",
        json={"email": "other@example.com", "displayName": "Other", "password": "secret"},
    )
    assert registered.status_code == 200, registered.text
    other = {"Authorization": f"Bearer {registered.json()['accessToken']}"}
    assert client.get(path, headers=other).status_code == 404
    assert client.patch(path, headers=other, json={"confirmQuitOnShutdown": False}).status_code == 404
