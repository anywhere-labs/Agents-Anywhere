"""Structural tests for BridgeClient's MeshCall surface (no Router, no network).

The 1.0 client owned a TCP socket, a JSON-RPC framing loop and a notification
dispatcher. The 2.0 client only translates calls and errors between the
runtime adapter and whatever Mesh the host's Router exposes, so these tests
replace the Mesh with a recorder.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, Self

import pytest
from meshcall import (
    DeadlineExceededError,
    InvalidArgumentError,
    MeshCallError,
    MethodNotFoundError,
    UnavailableError,
)

from connector.mesh.hub import DSH_BRIDGE_SERVICE
from connector.runtimes.dsh.bridge.client import (
    CONNECTOR_METADATA,
    NAMESPACE_METADATA,
    PROTOCOL_VERSION,
    BridgeClient,
    BridgeRpcError,
    BridgeUnavailableError,
    Payload,
)


class FakeStream:
    def __init__(self, items: list[dict[str, Any]], error: MeshCallError | None = None) -> None:
        self.items = items
        self.error = error

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_args: object) -> bool:
        return False

    async def __aiter__(self):
        for item in self.items:
            yield Payload(**item)
        if self.error is not None:
            raise self.error


class FakeMesh:
    """Records calls and answers from a per-method handler."""

    def __init__(self, handlers: dict[str, Any] | None = None) -> None:
        self.handlers = handlers or {}
        self.calls: list[dict[str, Any]] = []
        self.stream_calls: list[dict[str, Any]] = []
        self.stream_items: list[dict[str, Any]] = []
        self.stream_error: MeshCallError | None = None

    async def call_unary(
        self,
        service: str,
        method: str,
        request: Payload,
        _response_type: type[Payload],
        *,
        timeout: float | None = None,
        metadata: dict[str, str] | None = None,
    ) -> Payload:
        self.calls.append({
            "service": service,
            "method": method,
            "params": request.model_dump(),
            "timeout": timeout,
            "metadata": dict(metadata or {}),
        })
        handler = self.handlers.get(method)
        if handler is None:
            raise AssertionError(f"unexpected method {method}")
        result = handler(request.model_dump())
        if asyncio.iscoroutine(result):
            result = await result
        return Payload(**result)

    def call_server_stream(
        self,
        service: str,
        method: str,
        request: Payload,
        _item_type: type[Payload],
        *,
        metadata: dict[str, str] | None = None,
    ) -> FakeStream:
        self.stream_calls.append({
            "service": service,
            "method": method,
            "params": request.model_dump(),
            "metadata": dict(metadata or {}),
        })
        return FakeStream(self.stream_items, self.stream_error)


def fake_host(mesh: FakeMesh | None) -> SimpleNamespace:
    return SimpleNamespace(hub=SimpleNamespace(mesh=mesh))


def make_client(
    mesh: FakeMesh | None,
    *,
    connector_id: str = "connector-1",
    session_namespace: str | None = None,
    startup_timeout: float = 3,
    request_timeout: float = 5,
    exit_handler: Any = None,
) -> BridgeClient:
    return BridgeClient(
        fake_host(mesh),
        connector_id=connector_id,
        session_namespace=session_namespace,
        client_version="test-client",
        startup_timeout=startup_timeout,
        request_timeout=request_timeout,
        exit_handler=exit_handler,
    )


def identity(**overrides: Any) -> dict[str, Any]:
    value = {"runtime": "dsh", "runtimeVersion": "test", "protocolVersion": PROTOCOL_VERSION}
    value.update(overrides)
    return {"identity": value}


def test_request_passes_method_params_timeout_and_session_metadata() -> None:
    async def run() -> None:
        mesh = FakeMesh({"ping": lambda params: {"nonce": params.get("nonce")}})
        client = make_client(mesh, session_namespace="namespace-1")
        try:
            assert await client.request("ping", {"nonce": "n1"}) == {"nonce": "n1"}
            assert await client.request("ping") == {"nonce": None}
            assert await client.request("ping", {"nonce": "n2"}, timeout=0.5) == {"nonce": "n2"}
        finally:
            await client.close()

        first, second, third = mesh.calls
        assert first == {
            "service": DSH_BRIDGE_SERVICE,
            "method": "ping",
            "params": {"nonce": "n1"},
            "timeout": 5,
            "metadata": {
                NAMESPACE_METADATA: "namespace-1",
                CONNECTOR_METADATA: "connector-1",
            },
        }
        assert second["params"] == {}
        assert second["timeout"] == 5
        assert third["timeout"] == 0.5

    asyncio.run(run())


def test_session_namespace_defaults_to_the_connector_id() -> None:
    async def run() -> None:
        mesh = FakeMesh({"ping": lambda _params: {}})
        client = make_client(mesh)
        await client.request("ping")
        assert mesh.calls[0]["metadata"] == {
            NAMESPACE_METADATA: "connector-1",
            CONNECTOR_METADATA: "connector-1",
        }

    asyncio.run(run())


def test_stream_passes_items_and_session_metadata() -> None:
    async def run() -> None:
        mesh = FakeMesh()
        mesh.stream_items = [
            {"kind": "subscribed", "projectionVersion": 3},
            {"kind": "batch", "batchSeq": 1},
        ]
        client = make_client(mesh, session_namespace="namespace-1")
        items = [item async for item in client.stream("sync", {"subscriptionId": "sub"})]
        assert items == mesh.stream_items
        assert mesh.stream_calls == [{
            "service": DSH_BRIDGE_SERVICE,
            "method": "sync",
            "params": {"subscriptionId": "sub"},
            "metadata": {
                NAMESPACE_METADATA: "namespace-1",
                CONNECTOR_METADATA: "connector-1",
            },
        }]

    asyncio.run(run())


def test_initialize_sends_identity_and_accepts_a_compatible_bridge() -> None:
    async def run() -> None:
        response = {
            **identity(bridgeVersion="1.4.0"),
            "features": {"syncMode": "events"},
        }
        mesh = FakeMesh({"initialize": lambda _params: response})
        client = make_client(mesh, startup_timeout=1.5)
        assert await client.start() == response
        assert client.initialize_result == response
        assert client.connected is True

        call = mesh.calls[0]
        assert call["method"] == "initialize"
        assert call["timeout"] == 1.5
        assert call["params"] == {
            "protocolVersion": PROTOCOL_VERSION,
            "runtime": "dsh",
            "clientInfo": {"name": "agents-anywhere-connector", "version": "test-client"},
        }
        assert call["metadata"][NAMESPACE_METADATA] == "connector-1"

        await client.close()
        assert client.connected is False

    asyncio.run(run())


@pytest.mark.parametrize(
    ("response", "message"),
    [
        ({"identity": {"runtime": "claude", "protocolVersion": "2.0"}}, "invalid identity"),
        ({"identity": {"protocolVersion": "2.0"}}, "invalid identity"),
        ({"identity": "dsh"}, "invalid identity"),
        ({}, "invalid identity"),
        (identity(protocolVersion="1.0"), "incompatible"),
        (identity(protocolVersion="3.0"), "incompatible"),
        (identity(protocolVersion=None), "incompatible"),
    ],
)
def test_initialize_rejects_wrong_identity_or_protocol(response: dict[str, Any], message: str) -> None:
    async def run() -> None:
        mesh = FakeMesh({"initialize": lambda _params: response})
        client = make_client(mesh)
        with pytest.raises(ValueError, match=message):
            await client.start()
        assert client.connected is False
        assert client.initialize_result is None

    asyncio.run(run())


def test_missing_router_is_reported_as_unavailable() -> None:
    async def run() -> None:
        client = make_client(None)
        with pytest.raises(BridgeUnavailableError, match="local router is not running"):
            await client.request("ping")
        with pytest.raises(BridgeUnavailableError):
            _ = [item async for item in client.stream("sync")]
        assert client.connected is False

    asyncio.run(run())


def test_unavailable_bridge_disconnects_once_and_calls_the_exit_handler() -> None:
    async def run() -> None:
        async def gone(_params: dict[str, Any]) -> dict[str, Any]:
            raise UnavailableError("the plugin left the router")

        mesh = FakeMesh({"initialize": lambda _params: identity(), "ping": gone})
        exits: list[BaseException | None] = []

        async def exited(error: BaseException | None) -> None:
            exits.append(error)

        client = make_client(mesh, exit_handler=exited)
        await client.start()
        assert client.connected is True

        with pytest.raises(BridgeUnavailableError, match="left the router"):
            await client.request("ping")
        assert client.connected is False
        await asyncio.sleep(0)
        assert len(exits) == 1
        assert isinstance(exits[0], BridgeUnavailableError)

        # A later call still reports the bridge gone, but the exit is reported once.
        with pytest.raises(BridgeUnavailableError):
            await client.request("ping")
        await asyncio.sleep(0)
        assert len(exits) == 1

    asyncio.run(run())


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (MeshCallError("PERSISTENCE_ERROR", "disk failed", details={"pathClass": "state"}), "PERSISTENCE_ERROR"),
        (MeshCallError("SESSION_NOT_FOUND", "unknown session", retryable=True), "SESSION_NOT_FOUND"),
        (MeshCallError("SESSION_ARCHIVED", "archived"), "SESSION_ARCHIVED"),
        (MethodNotFoundError("no such method"), "METHOD_NOT_FOUND"),
        (InvalidArgumentError("bad params"), "INVALID_PARAMS"),
    ],
)
def test_plugin_error_codes_are_preserved(error: MeshCallError, code: str) -> None:
    async def run() -> None:
        def fail(_params: dict[str, Any]) -> dict[str, Any]:
            raise error

        mesh = FakeMesh({"pluginCall": fail})
        client = make_client(mesh)
        with pytest.raises(BridgeRpcError) as raised:
            await client.request("pluginCall")

        mapped = raised.value
        assert mapped.bridge_code == code
        assert str(mapped) == error.message
        assert mapped.retryable is error.retryable
        assert mapped.details == dict(error.details or {})

    asyncio.run(run())


def test_deadline_is_reported_as_a_retryable_request_timeout() -> None:
    async def run() -> None:
        def slow(_params: dict[str, Any]) -> dict[str, Any]:
            raise DeadlineExceededError("slow plugin")

        mesh = FakeMesh({"pluginCall": slow})
        client = make_client(mesh)
        with pytest.raises(BridgeRpcError) as raised:
            await client.request("pluginCall")

        mapped = raised.value
        assert mapped.bridge_code == "REQUEST_TIMEOUT"
        assert mapped.retryable is True
        assert str(mapped) == "slow plugin"

    asyncio.run(run())


def test_stream_maps_plugin_errors() -> None:
    async def run() -> None:
        mesh = FakeMesh()
        mesh.stream_error = MeshCallError("SESSION_NOT_FOUND", "unknown subscription")
        client = make_client(mesh)
        with pytest.raises(BridgeRpcError) as raised:
            _ = [item async for item in client.stream("sync", {"subscriptionId": "sub"})]
        assert raised.value.bridge_code == "SESSION_NOT_FOUND"
        assert str(raised.value) == "unknown subscription"

    asyncio.run(run())
