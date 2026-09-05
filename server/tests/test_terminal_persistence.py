from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException, WebSocketDisconnect

from agent_server.api import connector_ingress as connector_ingress_api
from agent_server.api import connector_terminal as connector_terminal_api
from agent_server.core.models import TerminalCreateRequest, TerminalPersistenceRequest
from agent_server.infra.connector_rpc import ConnectorRpcError
from agent_server.infra.terminal_broker import Terminal, TerminalBroker
from agent_server.services import terminal as terminal_service_module
from agent_server.services.connector_rpc import ConnectorUpstreamError
from agent_server.services.terminal import TerminalService


class _FakeStore:
    def __init__(self) -> None:
        self.recorded_root: dict[str, Any] | None = None

    async def record_connector_terminal_root(self, **values: Any) -> None:
        self.recorded_root = values

    async def get_connector_terminal_root(
        self,
        *,
        connector_id: str,
        terminal_id: str,
    ) -> dict[str, Any] | None:
        if self.recorded_root is None:
            return None
        if (
            self.recorded_root["connector_id"] != connector_id
            or self.recorded_root["terminal_id"] != terminal_id
        ):
            return None
        return self.recorded_root

    async def forget_connector_terminal_root(
        self,
        *,
        connector_id: str,
        terminal_id: str,
    ) -> None:
        if (
            self.recorded_root is not None
            and self.recorded_root["connector_id"] == connector_id
            and self.recorded_root["terminal_id"] == terminal_id
        ):
            self.recorded_root = None


class _FakeManager:
    async def is_connection_id_current(
        self, connector_id: str, connection_id: str
    ) -> bool:
        return connector_id == "conn_1" and connection_id == "connection_1"


class _RelayWebSocket:
    def __init__(self, token: str) -> None:
        self.query_params = {"token": token}
        self.sent: list[dict[str, Any]] = []
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, **_kwargs: Any) -> None:
        return None

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)

    async def receive_json(self) -> dict[str, Any]:
        raise WebSocketDisconnect()


def test_terminal_create_request_defaults_to_non_persistent() -> None:
    assert TerminalCreateRequest().persistent is False


def test_terminal_create_paths_forward_persistent(monkeypatch) -> None:
    async def run() -> None:
        direct_calls: list[tuple[str, str, dict[str, Any], float]] = []

        async def allow_connector(*_args: Any, **_kwargs: Any) -> None:
            return None

        async def request_connector(
            _manager: Any,
            connector_id: str,
            method: str,
            params: dict[str, Any],
            *,
            timeout: float,
        ) -> dict[str, Any]:
            direct_calls.append((connector_id, method, params, timeout))
            if method == "terminal.setPersistent":
                return {
                    "terminalId": params["terminalId"],
                    "sessionId": params["sessionId"],
                    "persistent": params["persistent"],
                }
            return {
                "terminalId": params["terminalId"],
                "sessionId": params["sessionId"],
                "cwd": params["cwd"],
                "persistent": params["persistent"],
            }

        monkeypatch.setattr(
            connector_terminal_api,
            "require_owned_online_connector",
            allow_connector,
        )
        monkeypatch.setattr(
            connector_terminal_api,
            "request_connector",
            request_connector,
        )

        store = _FakeStore()
        response = await connector_terminal_api.connector_terminal_create_v2(
            "conn_1",
            TerminalCreateRequest(cwd="src"),
            root="/repo",
            user_id="user_1",
            db=store,  # type: ignore[arg-type]
            manager=object(),  # type: ignore[arg-type]
        )

        assert direct_calls[0][1] == "terminal.create"
        assert direct_calls[0][2]["persistent"] is False
        assert response.result["persistent"] is False

        promoted = await connector_terminal_api.connector_terminal_set_persistence_v2(
            "conn_1",
            response.result["terminalId"],
            TerminalPersistenceRequest(persistent=True),
            user_id="user_1",
            db=store,  # type: ignore[arg-type]
            manager=object(),  # type: ignore[arg-type]
        )

        assert direct_calls[1][1] == "terminal.setPersistent"
        assert direct_calls[1][2]["persistent"] is True
        assert promoted.result["persistent"] is True

        async def request_missing_terminal(*_args: Any, **_kwargs: Any) -> None:
            cause = ConnectorRpcError("terminal_not_found", "terminal not found")
            raise ConnectorUpstreamError("terminal not found") from cause

        monkeypatch.setattr(
            connector_terminal_api,
            "request_connector",
            request_missing_terminal,
        )
        with pytest.raises(HTTPException) as exc_info:
            await connector_terminal_api.connector_terminal_set_persistence_v2(
                "conn_1",
                response.result["terminalId"],
                TerminalPersistenceRequest(persistent=True),
                user_id="user_1",
                db=store,  # type: ignore[arg-type]
                manager=object(),  # type: ignore[arg-type]
            )
        assert exc_info.value.status_code == 404
        assert store.recorded_root is None

        session_calls: list[tuple[str, dict[str, Any]]] = []

        async def local_rpc_session(*_args: Any, **_kwargs: Any) -> Any:
            return SimpleNamespace(id="sess_1", connectorId="conn_1", cwd="/repo")

        async def request_connector_bound(
            _manager: Any,
            _connector_id: str,
            method: str,
            params: dict[str, Any],
            *,
            timeout: float,
        ) -> tuple[dict[str, Any], str]:
            assert timeout == 15
            session_calls.append((method, params))
            return {"pid": 123}, "connection_1"

        monkeypatch.setattr(
            terminal_service_module,
            "local_rpc_session",
            local_rpc_session,
        )
        monkeypatch.setattr(
            terminal_service_module,
            "request_connector_bound",
            request_connector_bound,
        )

        service = TerminalService(
            object(),  # type: ignore[arg-type]
            _FakeManager(),  # type: ignore[arg-type]
            TerminalBroker(),
        )
        created = await service.create(
            "sess_1",
            TerminalCreateRequest(persistent=True),
            user_id="user_1",
        )

        assert session_calls[0][0] == "terminal.create"
        assert session_calls[0][1]["persistent"] is True
        assert created.terminal.persistent is True

    asyncio.run(run())


def test_terminal_relay_start_forwards_persistent() -> None:
    async def run() -> None:
        broker = TerminalBroker()
        terminal = await broker.register(
            session_id="sess_1",
            connector_id="conn_1",
            label="Shell",
            root="/repo",
            cwd="/repo",
            shell="/bin/zsh",
            cols=80,
            rows=24,
            persistent=True,
        )
        restored = Terminal._from_payload(terminal._payload())
        websocket = _RelayWebSocket(terminal.relay_token)

        await connector_ingress_api.connector_terminal_relay_ws(
            websocket,  # type: ignore[arg-type]
            terminal.id,
            broker,
        )

        assert restored.persistent is True
        assert websocket.accepted is True
        assert websocket.sent[0]["type"] == "start"
        assert websocket.sent[0]["persistent"] is True

    asyncio.run(run())
