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


class FakeProbeResponse:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


class FakeFallbackHttpClient:
    calls: list[str] = []

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def __aenter__(self) -> FakeFallbackHttpClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    async def get(self, url: str) -> FakeProbeResponse:
        self.calls.append(url)
        if url.startswith("https://"):
            raise cli_module.httpx.ConnectError("tls failed")
        return FakeProbeResponse(200)


class FakeBackendRpcClient:
    started_configs: list[ConnectorConfig] = []

    def __init__(self, config: ConnectorConfig) -> None:
        self.config = config

    async def run_forever(self) -> None:
        self.started_configs.append(self.config)


def test_pair_starts_connector_after_saving_credentials(monkeypatch, tmp_path, capsys) -> None:
    config_path = tmp_path / "connector.json"
    FakeBackendRpcClient.started_configs = []
    monkeypatch.setattr(cli_module.httpx, "AsyncClient", FakeHttpClient)
    monkeypatch.setattr(cli_module, "BackendRpcClient", FakeBackendRpcClient)

    args = cli_module._build_parser().parse_args(
        [
            "pair",
            "http://127.0.0.1:8000",
            "--config",
            str(config_path),
            "--poll-interval",
            "0",
        ]
    )
    asyncio.run(cli_module._pair(args))

    loaded = ConnectorConfig.load(config_path)
    assert loaded.connector_id == "conn_1"
    assert [config.connector_id for config in FakeBackendRpcClient.started_configs] == ["conn_1"]
    assert "connection will stop when this shell session ends" in capsys.readouterr().out


def test_pair_no_start_only_saves_credentials(monkeypatch, tmp_path) -> None:
    config_path = tmp_path / "connector.json"
    FakeBackendRpcClient.started_configs = []
    monkeypatch.setattr(cli_module.httpx, "AsyncClient", FakeHttpClient)
    monkeypatch.setattr(cli_module, "BackendRpcClient", FakeBackendRpcClient)

    args = cli_module._build_parser().parse_args(
        [
            "pair",
            "http://127.0.0.1:8000",
            "--config",
            str(config_path),
            "--poll-interval",
            "0",
            "--no-start",
        ]
    )
    asyncio.run(cli_module._pair(args))

    assert ConnectorConfig.load(config_path).connector_token == "cxt_secret"
    assert FakeBackendRpcClient.started_configs == []


def test_pair_accepts_legacy_server_url_flag(monkeypatch, tmp_path) -> None:
    config_path = tmp_path / "connector.json"
    FakeBackendRpcClient.started_configs = []
    monkeypatch.setattr(cli_module.httpx, "AsyncClient", FakeHttpClient)
    monkeypatch.setattr(cli_module, "BackendRpcClient", FakeBackendRpcClient)

    args = cli_module._build_parser().parse_args(
        [
            "pair",
            "--server-url",
            "http://127.0.0.1:8000",
            "--config",
            str(config_path),
            "--poll-interval",
            "0",
            "--no-start",
        ]
    )
    asyncio.run(cli_module._pair(args))

    assert ConnectorConfig.load(config_path).connector_id == "conn_1"


def test_login_alias_is_still_accepted() -> None:
    args = cli_module._build_parser().parse_args(["login", "http://127.0.0.1:8000", "--no-start"])

    assert args.command == "login"
    assert args.server == "http://127.0.0.1:8000"
    assert args.no_start is True


def test_rpc_command_uses_config_path(tmp_path) -> None:
    config_path = tmp_path / "connector.json"

    args = cli_module._build_parser().parse_args(["rpc", "--config", str(config_path)])

    assert args.command == "rpc"
    assert args.config == str(config_path)


def test_pair_server_without_scheme_falls_back_to_http(monkeypatch) -> None:
    FakeFallbackHttpClient.calls = []
    monkeypatch.setattr(cli_module.httpx, "AsyncClient", FakeFallbackHttpClient)

    resolved = asyncio.run(cli_module._resolve_server_url_for_pair("anywhere.test:6664", timeout=0.1))

    assert resolved == "http://anywhere.test:6664"
    assert FakeFallbackHttpClient.calls == [
        "https://anywhere.test:6664/api/v2/health",
        "http://anywhere.test:6664/api/v2/health",
    ]
