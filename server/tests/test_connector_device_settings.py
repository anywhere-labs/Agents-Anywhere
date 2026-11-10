from __future__ import annotations

import asyncio
from typing import Any

import pytest
from test_backend_mvp import auth_headers, create_connector_and_session, make_client

from agent_server.core.device_settings import (
    DEVICE_SETTINGS_APPLY_METHOD,
    ConnectorDeviceSettings,
    ConnectorDeviceSettingsPatch,
    device_settings_from_stored,
)
from agent_server.core.models import ConnectorView
from agent_server.infra.connector_rpc import ConnectorOfflineError
from agent_server.services.connector_device_settings import (
    deliver_stored_device_settings,
    get_device_settings,
    update_device_settings,
)


class FakeStore:
    def __init__(self, stored: dict[str, Any] | None = None, owner: str = "user") -> None:
        self.stored = stored if stored is not None else {}
        self.owner = owner
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


class FakeRequester:
    def __init__(self, result: Any = None, error: Exception | None = None) -> None:
        self.result = {"applied": True} if result is None else result
        self.error = error
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    async def request(self, connector_id, method, params, *, timeout=30):
        self.calls.append((connector_id, method, params))
        if self.error is not None:
            raise self.error
        return self.result


def test_stored_settings_default_and_ignore_invalid_values() -> None:
    assert device_settings_from_stored(None) == ConnectorDeviceSettings()
    assert device_settings_from_stored({"confirmQuitOnShutdown": "yes", "x": 1}) == (
        ConnectorDeviceSettings()
    )
    assert device_settings_from_stored({"confirmQuitOnShutdown": True}).confirmQuitOnShutdown


def test_patch_rejects_unknown_fields() -> None:
    with pytest.raises(ValueError):
        ConnectorDeviceSettingsPatch.model_validate({"blockShutdown": True})


def test_update_stores_then_delivers_to_online_connector() -> None:
    store = FakeStore()
    requester = FakeRequester()

    settings, delivered = asyncio.run(
        update_device_settings(
            store,
            requester,
            "conn",
            ConnectorDeviceSettingsPatch(confirmQuitOnShutdown=True),
            user_id="user",
        )
    )

    assert settings.confirmQuitOnShutdown is True
    assert delivered is True
    assert store.writes == [{"confirmQuitOnShutdown": True}]
    assert requester.calls == [
        ("conn", DEVICE_SETTINGS_APPLY_METHOD, {"settings": {"confirmQuitOnShutdown": True}})
    ]


def test_update_keeps_change_when_connector_is_offline_or_too_old() -> None:
    for requester in (
        FakeRequester(error=ConnectorOfflineError("connector is offline")),
        FakeRequester(error=RuntimeError("unsupported connector method")),
        FakeRequester(result={"unexpected": True}),
    ):
        store = FakeStore()
        settings, delivered = asyncio.run(
            update_device_settings(
                store,
                requester,
                "conn",
                ConnectorDeviceSettingsPatch(confirmQuitOnShutdown=True),
                user_id="user",
            )
        )
        assert settings.confirmQuitOnShutdown is True
        assert delivered is False
        assert store.stored == {"confirmQuitOnShutdown": True}


def test_omitted_fields_keep_their_value() -> None:
    store = FakeStore({"confirmQuitOnShutdown": True})
    settings, _ = asyncio.run(
        update_device_settings(
            store, FakeRequester(), "conn", ConnectorDeviceSettingsPatch(), user_id="user"
        )
    )
    assert settings.confirmQuitOnShutdown is True


def test_settings_of_another_user_are_not_found() -> None:
    with pytest.raises(KeyError):
        asyncio.run(get_device_settings(FakeStore(owner="other"), "conn", user_id="user"))


def test_connect_delivers_stored_settings() -> None:
    requester = FakeRequester()
    assert asyncio.run(
        deliver_stored_device_settings(FakeStore({"confirmQuitOnShutdown": True}), requester, "conn")
    )
    assert requester.calls[0][2] == {"settings": {"confirmQuitOnShutdown": True}}


def test_device_settings_api_round_trip(tmp_path) -> None:
    client = make_client(tmp_path)
    connector_id, _access_token, _session_id, headers = create_connector_and_session(client)
    path = f"/connectors/{connector_id}/device-settings"

    initial = client.get(path, headers=headers)
    assert initial.status_code == 200, initial.text
    assert initial.json()["settings"] == {"confirmQuitOnShutdown": False}
    assert initial.json()["delivered"] is None

    changed = client.patch(path, headers=headers, json={"confirmQuitOnShutdown": True})
    assert changed.status_code == 200, changed.text
    assert changed.json()["settings"] == {"confirmQuitOnShutdown": True}
    # No connector socket is open in this test, so the change waits for it.
    assert changed.json()["delivered"] is False
    assert client.get(path, headers=headers).json()["settings"] == {"confirmQuitOnShutdown": True}

    assert client.patch(path, headers=headers, json={"unknown": True}).status_code == 422

    other = auth_headers(client, user_id="user2")
    assert client.get(path, headers=other).status_code == 404
    assert client.patch(path, headers=other, json={"confirmQuitOnShutdown": False}).status_code == 404
