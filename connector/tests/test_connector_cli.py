from __future__ import annotations

import asyncio
from typing import Any

import connector.cli as cli_module
from connector.runtime import ConnectorConfig


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self.payload


class FakeHttpClient:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.calls: list[tuple[str, dict[str, Any] | None]] = []

    async def __aenter__(self) -> FakeHttpClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    async def post(self, url: str, json: dict[str, Any] | None = None) -> FakeResponse:
        self.calls.append((url, json))
        if url.endswith("/pairing/start"):
            return FakeResponse({"pairingId": "pair_1", "code": "123456"})
        if url.endswith("/pairing/poll"):
            return FakeResponse(
                {
                    "status": "claimed",
                    "config": {
                        "serverUrl": "http://127.0.0.1:8000",
                        "connectorId": "conn_1",
                        "connectorToken": "cxt_secret",
                    },
                }
            )
        raise AssertionError(f"unexpected url: {url}")


class FakeBackendRpcClient:
    started_configs: list[ConnectorConfig] = []

    def __init__(self, config: ConnectorConfig) -> None:
        self.config = config

    async def run_forever(self) -> None:
        self.started_configs.append(self.config)


def test_login_starts_connector_after_saving_credentials(monkeypatch, tmp_path) -> None:
    config_path = tmp_path / "connector.json"
    FakeBackendRpcClient.started_configs = []
    monkeypatch.setattr(cli_module.httpx, "AsyncClient", FakeHttpClient)
    monkeypatch.setattr(cli_module, "BackendRpcClient", FakeBackendRpcClient)

    args = cli_module._build_parser().parse_args(
        [
            "login",
            "--server-url",
            "http://127.0.0.1:8000",
            "--config",
            str(config_path),
            "--poll-interval",
            "0",
        ]
    )
    asyncio.run(cli_module._login(args))

    loaded = ConnectorConfig.load(config_path)
    assert loaded.connector_id == "conn_1"
    assert [config.connector_id for config in FakeBackendRpcClient.started_configs] == ["conn_1"]


def test_login_no_start_only_saves_credentials(monkeypatch, tmp_path) -> None:
    config_path = tmp_path / "connector.json"
    FakeBackendRpcClient.started_configs = []
    monkeypatch.setattr(cli_module.httpx, "AsyncClient", FakeHttpClient)
    monkeypatch.setattr(cli_module, "BackendRpcClient", FakeBackendRpcClient)

    args = cli_module._build_parser().parse_args(
        [
            "login",
            "--server-url",
            "http://127.0.0.1:8000",
            "--config",
            str(config_path),
            "--poll-interval",
            "0",
            "--no-start",
        ]
    )
    asyncio.run(cli_module._login(args))

    assert ConnectorConfig.load(config_path).connector_token == "cxt_secret"
    assert FakeBackendRpcClient.started_configs == []
