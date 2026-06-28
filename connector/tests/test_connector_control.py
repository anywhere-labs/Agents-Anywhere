from __future__ import annotations

import asyncio
from typing import Any

from connector.control import ConnectorController, config_to_payload
from connector.runtime import ConnectorConfig


class FakeBackendRpcClient:
    started: list[ConnectorConfig] = []

    def __init__(self, config: ConnectorConfig) -> None:
        self.config = config

    async def run_forever(self) -> None:
        self.started.append(self.config)
        await asyncio.Event().wait()


def test_connector_controller_saves_config_and_starts_runtime(tmp_path) -> None:
    async def exercise() -> tuple[dict[str, Any], list[tuple[str, Any]]]:
        events: list[tuple[str, Any]] = []

        async def notify(method: str, params: Any) -> None:
            events.append((method, params))

        FakeBackendRpcClient.started = []
        controller = ConnectorController(
            config_path=tmp_path / "connector.json",
            notifier=notify,
            client_factory=FakeBackendRpcClient,  # type: ignore[arg-type]
        )
        config = {
            "serverUrl": "http://127.0.0.1:8000/",
            "connectorId": "conn_1",
            "connectorToken": "cxt_secret",
        }
        saved = await controller.save_config(config)
        state = await controller.start()
        await asyncio.sleep(0)
        assert FakeBackendRpcClient.started[0].server_url == "http://127.0.0.1:8000"
        assert state["running"] is True
        await controller.stop()
        return saved, events

    saved, events = asyncio.run(exercise())

    assert saved["serverUrl"] == "http://127.0.0.1:8000"
    assert [method for method, _params in events].count("connector/state") >= 2


def test_connector_controller_returns_default_config_when_missing(tmp_path) -> None:
    controller = ConnectorController(config_path=tmp_path / "missing.json")

    config = controller.get_config()

    assert config["serverUrl"] == ""
    assert config["heartbeatSeconds"] == 20


def test_config_to_payload_keeps_optional_state_db_path() -> None:
    payload = config_to_payload(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            state_db_path="/tmp/state.db",
        )
    )

    assert payload["stateDbPath"] == "/tmp/state.db"
