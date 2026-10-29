from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from meshcall import DeadlineExceededError, MeshCallError, UnavailableError

from agent_server.infra import connector_mesh_control as control_module
from agent_server.infra.connector_mesh_control import (
    MeshConnectorControlTransport,
    Payload,
)
from agent_server.infra.connector_mesh_routes import MeshRoute
from agent_server.infra.connector_rpc import (
    ConnectorNotDispatchedError,
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorTransportTimeout,
    connector_request_timeout,
    current_request_deadline,
)

ROUTE = MeshRoute("device", "base", "link-1", "router", "worker", 1, "owner-1")


@pytest.fixture
def transport():
    client = SimpleNamespace(connect=AsyncMock(), call_unary=AsyncMock(return_value=Payload(ok=True)))
    mesh = SimpleNamespace(router_id="router", routes=SimpleNamespace(get=AsyncMock(return_value=ROUTE)),
                           connection=lambda: client)
    rpc = SimpleNamespace(instance_id="worker", current_connection_id=AsyncMock(return_value="base"),
                          is_connection_id_current=AsyncMock(return_value=True))
    return MeshConnectorControlTransport(mesh, rpc)


@pytest.mark.parametrize("reason", ["no_instances", "instance_unknown", "instance_draining"])
def test_router_rejection_returns_positive_non_dispatch_without_retrying_mesh(transport, reason):
    async def exercise():
        unary = transport.mesh.connection().call_unary
        unary.side_effect = UnavailableError("old link", details={"source": "router", "reason": reason})
        with pytest.raises(ConnectorNotDispatchedError) as caught:
            await transport.request_bound("device", "session.send_message", {}, timeout=2)
        assert caught.value.details == {"source": "router", "reason": reason, "deliveryState": "not_dispatched"}
        assert unary.await_count == 1 and transport.mesh.routes.get.await_count == 1
    asyncio.run(exercise())


def test_unknown_outcome_is_not_replayed_even_when_router_marks_it_retryable(transport):
    async def exercise():
        unary = transport.mesh.connection().call_unary
        unary.side_effect = UnavailableError("response lost", retryable=True,
                                             details={"source": "router", "reason": "connection_lost"})
        with pytest.raises(ConnectorOfflineError) as caught:
            await transport.request_bound("device", "fs.writeFile", {"text": "write once"}, timeout=2)
        assert caught.value.details["deliveryState"] == "outcome_unknown"
        assert unary.await_count == 1
    asyncio.run(exercise())


@pytest.mark.parametrize("error", [
    UnavailableError("business refusal", retryable=True,
                     details={"source": "connector_domain", "reason": "no_instances"}),
    DeadlineExceededError("runtime timeout", details={"source": "connector_domain"}),
    MeshCallError("invalid_argument", "invalid file path", details={"source": "connector_domain"}),
])
def test_domain_errors_keep_their_code_and_do_not_trigger_transport_retry(transport, error):
    async def exercise():
        unary = transport.mesh.connection().call_unary
        unary.side_effect = error
        with pytest.raises(ConnectorRpcError) as caught:
            await transport.request_bound("device", "session.send_message", {}, timeout=2)
        assert caught.value.code == error.code and caught.value.message == error.message
        assert caught.value.details == error.details
        assert unary.await_count == 1
    asyncio.run(exercise())


def test_sdk_deadline_after_dispatch_reports_unknown_outcome(transport):
    async def exercise():
        unary = transport.mesh.connection().call_unary
        unary.side_effect = DeadlineExceededError("no response")
        with pytest.raises(ConnectorTransportTimeout) as caught:
            await transport.request_bound("device", "shell.exec", {}, timeout=2)
        assert caught.value.details["deliveryState"] == "outcome_unknown"
        assert unary.await_count == 1
    asyncio.run(exercise())


@pytest.mark.parametrize("error", [OSError("offline"), TimeoutError("handshake expired")])
def test_connect_failure_is_positive_non_dispatch_and_never_calls_business(transport, error):
    async def exercise():
        client = transport.mesh.connection()
        client.connect.side_effect = error
        with pytest.raises(ConnectorNotDispatchedError) as caught:
            await transport.request_bound("device", "fs.writeFile", {}, timeout=2)
        assert caught.value.details["reason"] == "mesh_connect_failed"
        assert caught.value.details["deliveryState"] == "not_dispatched"
        client.call_unary.assert_not_awaited()
    asyncio.run(exercise())


def test_connect_cancellation_and_programming_errors_are_not_reclassified(transport):
    async def exercise():
        for error in (asyncio.CancelledError(), TypeError("invalid client")):
            transport.mesh.connection().connect.side_effect = error
            with pytest.raises(type(error)):
                await transport.request_bound("device", "shell.exec", {}, timeout=2)
        transport.mesh.connection().call_unary.assert_not_awaited()
    asyncio.run(exercise())


def test_connect_phase_timeout_reserves_budget_for_websocket(transport):
    async def exercise():
        async def blocked():
            await asyncio.Event().wait()
        transport.mesh.connection().connect.side_effect = blocked
        async with connector_request_timeout(0.08) as budget:
            with pytest.raises(ConnectorNotDispatchedError):
                await transport.request_bound("device", "shell.exec", {}, timeout=2)
            assert budget.remaining() > 0.015
        transport.mesh.connection().call_unary.assert_not_awaited()
    asyncio.run(exercise())


@pytest.mark.parametrize("result", [{"ok": False, "code": "denied"}, {"accepted": False, "reason": "busy"}])
def test_successful_rpc_does_not_turn_a_business_rejection_into_success(transport, result):
    async def exercise():
        transport.mesh.connection().call_unary.return_value = Payload(**result)
        response, _ = await transport.request_bound("device", "session.send_message", {}, timeout=2)
        assert response == result
    asyncio.run(exercise())


def test_response_from_replaced_connection_is_rejected_without_replay(transport):
    async def exercise():
        transport.rpc.is_connection_id_current.side_effect = [True, False]
        with pytest.raises(ConnectorOfflineError) as caught:
            await transport.request_bound("device", "session.create", {}, timeout=2)
        assert caught.value.details["deliveryState"] == "outcome_unknown"
        assert transport.mesh.connection().call_unary.await_count == 1
    asyncio.run(exercise())


def test_call_identity_and_remaining_budget_reach_mesh_metadata(transport):
    async def exercise():
        async with connector_request_timeout(2, call_id="original-call") as outer:
            await transport.request_bound("device", "session.send_message", {}, timeout=100)
            call = transport.mesh.connection().call_unary.await_args
            assert call.kwargs["metadata"] == {"aa-control-call-id": "original-call", "aa-connection-id": "base"}
            assert 0 < call.kwargs["timeout"] <= 2
            assert current_request_deadline() is outer
        assert current_request_deadline() is None
    asyncio.run(exercise())


def test_oversized_request_is_rejected_before_dispatch(transport, monkeypatch):
    monkeypatch.setattr(control_module, "DEFAULT_MAX_FRAME_SIZE", 256)
    async def exercise():
        with pytest.raises(ConnectorRpcError) as caught:
            await transport.request_bound("device", "fs.writeFile", {"text": "x" * 1000}, timeout=2)
        assert caught.value.code == "resource_exhausted"
        assert caught.value.details["deliveryState"] == "not_dispatched"
        transport.mesh.connection().call_unary.assert_not_awaited()
    asyncio.run(exercise())


@pytest.mark.parametrize("phase,delivery,calls", [
    ("connection", "not_dispatched", 0), ("presence", "not_dispatched", 0),
    ("route", "not_dispatched", 0), ("target_route", "not_dispatched", 0),
    ("mesh", "outcome_unknown", 1), ("response_identity", "outcome_unknown", 1),
])
def test_request_deadline_covers_every_route_phase(transport, phase, delivery, calls):
    async def exercise():
        async def blocked(*_args, **_kwargs):
            await asyncio.Event().wait()
        unary = transport.mesh.connection().call_unary
        if phase == "connection":
            transport.rpc.current_connection_id = blocked
        elif phase == "presence":
            transport.rpc.is_connection_id_current = blocked
        elif phase == "route":
            transport.mesh.routes.get = blocked
        elif phase == "mesh":
            unary.side_effect = blocked
        elif phase == "target_route":
            transport.mesh.routes.get = blocked
        else:
            checks = 0
            async def current(*_args):
                nonlocal checks
                checks += 1
                return True if checks == 1 else await blocked()
            transport.rpc.is_connection_id_current = current
        async with asyncio.timeout(2):
            with pytest.raises(ConnectorTransportTimeout) as caught:
                if phase == "target_route":
                    from dataclasses import asdict
                    await transport.request_routed({"connectorId": "device", "connectionId": "base", "method": "shell.exec",
                        "params": {}, "meshRoute": asdict(ROUTE), "timeout": 0.01})
                else:
                    await transport.request_bound("device", "shell.exec", {}, timeout=0.01)
        assert caught.value.details["deliveryState"] == delivery
        assert unary.await_count == calls and current_request_deadline() is None
    asyncio.run(exercise())
