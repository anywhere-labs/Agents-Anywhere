from __future__ import annotations

import asyncio
from typing import Any

from connector.control import ConnectorController, config_to_payload
from connector.json_rpc import JsonRpcStdioServer
from connector.runtime import ConnectorConfig


class FakeBackendRpcClient:
    started: list[ConnectorConfig] = []

    def __init__(self, config: ConnectorConfig) -> None:
        self.config = config

    async def run_forever(self) -> None:
        self.started.append(self.config)
        await asyncio.Event().wait()


class MemoryWriter:
    def __init__(self) -> None:
        self.lines: list[dict[str, Any]] = []

    def write(self, data: bytes) -> None:
        import json

        self.lines.append(json.loads(data))

    async def drain(self) -> None:
        return None


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


def test_connector_controller_getters_accept_json_rpc_params(tmp_path) -> None:
    async def exercise() -> list[dict[str, Any]]:
        reader = asyncio.StreamReader()
        writer = MemoryWriter()
        controller = ConnectorController(config_path=tmp_path / "missing.json")
        server = JsonRpcStdioServer(
            reader,
            writer,  # type: ignore[arg-type]
            {
                "connector.getState": controller.get_state,
                "connector.getConfig": controller.get_config,
            },
        )

        await server.handle_line(b'{"jsonrpc":"2.0","id":1,"method":"connector.getState","params":{}}\n')
        await server.handle_line(b'{"jsonrpc":"2.0","id":2,"method":"connector.getConfig","params":{}}\n')
        return writer.lines

    lines = asyncio.run(exercise())

    assert lines[0]["result"]["status"] == "stopped"
    assert lines[1]["result"]["serverUrl"] == ""


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
