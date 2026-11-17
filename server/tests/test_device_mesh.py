"""The per-worker MeshCall client against a real Router (device-meshcall 1.0)."""

from __future__ import annotations

import asyncio

import pytest
from mesh_fixtures import RouterProcess

from agent_server.core.device_meshcall import (
    LINK_ROUTES,
    REQUEST_METHODS,
    CommandAck,
    CommandCall,
    CommandStatusRequest,
    CommandStatusResponse,
    LinkAttachItem,
    LinkAttachRequest,
    classify_mesh_error,
    command_route,
)
from agent_server.infra.device_mesh import (
    DEVICE_SERVICES,
    DeviceCallError,
    DeviceMesh,
    MeshSettings,
    router_auth_document,
)
from scripts.v3_fake_device import FakeDevice

READ = REQUEST_METHODS["command.status"]
SEND = command_route("session.sync")


def run(coro):
    return asyncio.run(coro)


def test_classification_keeps_unknown_outcomes_apart_from_offline() -> None:
    # Not delivered: the call never reached a device.
    assert classify_mesh_error("unavailable", "no_instances", opened=True) == "not_delivered"
    assert classify_mesh_error("unavailable", "instance_unknown", opened=True) == "not_delivered"
    assert classify_mesh_error("unavailable", None, opened=False) == "not_delivered"
    # Opened and then lost: may have run, never offline (#441 review).
    assert classify_mesh_error("unavailable", "instance_lost", opened=True) == "outcome_unknown"
    assert classify_mesh_error("unavailable", None, opened=True) == "outcome_unknown"
    assert classify_mesh_error("unavailable", "router_shutdown", opened=True) == "outcome_unknown"
    assert classify_mesh_error("deadline_exceeded", None, opened=True) == "outcome_unknown"
    assert classify_mesh_error("connector_busy", None, opened=True) == "application"


def test_auth_document_grants_device_services_and_token_administration() -> None:
    user = router_auth_document("hash")["users"][0]
    assert user["username"] == "aa-server"
    assert user["register"] == list(DEVICE_SERVICES)
    assert "meshcall.router.v1.AuthService/issue_token" in user["call"]
    assert all(entry.endswith("/*") or "AuthService" in entry for entry in user["call"])


def test_router_down_never_blocks_and_reads_as_not_delivered() -> None:
    async def scenario() -> None:
        mesh = DeviceMesh(MeshSettings(router_url="ws://127.0.0.1:9", password="x"))
        await mesh.start()
        health = await mesh.check(timeout=1)
        assert health["status"] == "error"
        with pytest.raises(DeviceCallError) as failure:
            await mesh.unary("dev_1", READ, CommandStatusRequest(commandId="c_0"), CommandStatusResponse)
        assert failure.value.not_delivered
        await mesh.close()

    run(scenario())


def test_unconfigured_mesh_reports_not_configured() -> None:
    async def scenario() -> None:
        mesh = DeviceMesh(MeshSettings())
        assert (await mesh.check())["status"] == "not_configured"

    run(scenario())


def test_server_calls_a_registered_device_and_classifies_failures(mesh_router: RouterProcess) -> None:
    async def scenario() -> None:
        mesh = DeviceMesh(mesh_router.settings())
        assert (await mesh.check())["status"] == "ok"

        # Nobody registered: not delivered (offline), not unknown.
        with pytest.raises(DeviceCallError) as offline:
            await mesh.unary("dev_1", READ, CommandStatusRequest(commandId="c_0"), CommandStatusResponse)
        assert offline.value.not_delivered

        token = await mesh.issue_device_token("dev_1")
        device = FakeDevice("dev_1", mesh_router.url, token.token)
        await device.start()
        try:
            assert await mesh.registered_services("dev_1") >= {
                "aa.device.v1.Link",
                "aa.device.v1.Commands",
            }
            status = await mesh.unary(
                "dev_1", READ, CommandStatusRequest(commandId="c_0"), CommandStatusResponse
            )
            assert status.commandId == "c_0" and status.known is False

            ack = await mesh.unary(
                "dev_1",
                SEND,
                CommandCall(commandId="c_1", deadline="2099-01-01T00:00:00Z", p={"sessionId": "s", "takeover": True}),
                CommandAck,
                idempotency_key="c_1",
                timeout=5,
            )
            assert ack.outcome == "accepted"

            # The device dies while a command runs: the outcome is unknown, never "offline".
            device.state.command_delay = 5
            call = asyncio.create_task(
                mesh.unary(
                    "dev_1",
                    SEND,
                    CommandCall(commandId="c_2", deadline="2099-01-01T00:00:00Z"),
                    CommandAck,
                    idempotency_key="c_2",
                    timeout=10,
                )
            )
            await asyncio.sleep(0.3)
            await device.stop()
            with pytest.raises(DeviceCallError) as lost:
                await call
            assert lost.value.outcome_unknown, lost.value
        finally:
            await device.stop()
            await mesh.close()

    run(scenario())


def test_token_registers_only_its_own_device_and_revocation_disconnects(mesh_router: RouterProcess) -> None:
    async def scenario() -> None:
        mesh = DeviceMesh(mesh_router.settings())
        token = await mesh.issue_device_token("dev_a")
        impostor = FakeDevice("dev_b", mesh_router.url, token.token)
        with pytest.raises(Exception):  # noqa: B017 - the Router refuses the foreign instance id
            await asyncio.wait_for(impostor.start(), 5)
            # A refused registration may surface only once the Router closes the connection.
            await asyncio.wait_for(impostor.server.wait_refused(), 5)
            raise AssertionError("registered a foreign instance id")
        await impostor.stop()

        device = FakeDevice("dev_a", mesh_router.url, token.token)
        await device.start()
        try:
            stream = mesh.stream(
                "dev_a", LINK_ROUTES["link.attach"], LinkAttachRequest(connectionId="lc_1"), LinkAttachItem
            )
            first = await anext(stream)
            assert first.kind == "heartbeat"
            # Revoking the token closes the device connection (4401): the held stream fails.
            assert await mesh.revoke_token(token.token_id)
            with pytest.raises(DeviceCallError):
                await asyncio.wait_for(anext(stream), 10)
            await stream.aclose()
            with pytest.raises(DeviceCallError) as offline:
                await mesh.unary(
                    "dev_a", READ, CommandStatusRequest(commandId="c_0"), CommandStatusResponse
                )
            assert offline.value.not_delivered
        finally:
            await device.stop()
            await mesh.close()

    run(scenario())


def test_router_restart_reconnects_the_worker_client(mesh_router: RouterProcess) -> None:
    async def scenario() -> None:
        mesh = DeviceMesh(mesh_router.settings())
        assert (await mesh.check())["status"] == "ok"
        mesh_router.stop()
        assert (await mesh.check(timeout=1))["status"] == "error"
        mesh_router.start()
        for _ in range(20):
            if (await mesh.check(timeout=1))["status"] == "ok":
                break
            await asyncio.sleep(0.2)
        assert (await mesh.check())["status"] == "ok"
        # Tokens did not survive the restart; issuing works again.
        assert (await mesh.issue_device_token("dev_1")).token
        await mesh.close()

    run(scenario())
