"""Durable command receipts for v3 devices (real Router, fake device)."""

from __future__ import annotations

import asyncio

import pytest
from device_link_helpers import acked, eventually, offline, server, user_and_device
from mesh_fixtures import RouterProcess

from agent_server.core.device_meshcall import CommandAck, LinkError
from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorOutcomeUnknownError,
    ConnectorRpcError,
)
from scripts.v3_fake_device import connect_device


def _message(client_message_id: str, content: str = "hi") -> dict:
    return {"sessionId": "sess_c1", "clientMessageId": client_message_id, "content": content}


def test_receipts_replay_conflict_and_offline(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            rpc, store = app.state.rpc, app.state.store
            user_id = (await store.get_connector(device_id)).userId
            try:
                device.state.command_handler = lambda method, p: {"delivery": "accepted"}
                assert await rpc.request(device_id, "session.send_message", _message("m_1")) == {"delivery": "accepted"}
                receipt = await store.get_device_command(user_id, "m_1")
                assert receipt["state"] == "accepted" and receipt["kind"] == "session.sendMessage"
                assert receipt["result"]["r"] == {"delivery": "accepted"}

                # Same id, same input: the recorded result, the device is not asked again.
                calls = device.state.calls.count("session.sendMessage")
                assert await rpc.request(device_id, "session.send_message", _message("m_1")) == {"delivery": "accepted"}
                assert device.state.calls.count("session.sendMessage") == calls

                # Same id, other input: a conflict.
                with pytest.raises(ConnectorRpcError) as conflict:
                    await rpc.request(device_id, "session.send_message", _message("m_1", "other"))
                assert conflict.value.code == "command_conflict"

                # The device says no: the receipt is terminal and replays say no again.
                device.state.command_handler = lambda method, p: LinkError(code="session_busy", message="busy")
                for _ in range(2):
                    with pytest.raises(ConnectorRpcError) as rejected:
                        await rpc.request(device_id, "session.send_message", _message("m_2"))
                    assert rejected.value.code == "session_busy"
                assert (await store.get_device_command(user_id, "m_2"))["state"] == "rejected"

                # interaction.respond arrives in the device's shape.
                device.state.command_handler = None
                await rpc.request(
                    device_id,
                    "interaction.respond",
                    {"sessionId": "sess_c1", "noticeId": "n_1", "actionId": "approve", "inputData": {"a": 1}},
                )
                method, payload = device.state.command_log[-1]
                assert method == "session.respondNotice"
                assert payload["input"] == {"a": 1} and "inputData" not in payload and payload["responseId"]
            finally:
                await device.stop()

            await eventually(lambda: offline(rpc, device_id))
            with pytest.raises(ConnectorOfflineError):
                await rpc.request(device_id, "session.send_message", _message("m_3"))
            # Nothing reached the device: no receipt is left to replay on its next hello.
            assert await store.get_device_command(user_id, "m_3") is None

    asyncio.run(scenario())


def test_unknown_outcome_converges_without_resending(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            rpc, store = app.state.rpc, app.state.store
            user_id = (await store.get_connector(device_id)).userId
            try:
                device.state.ack_delay = 2
                with pytest.raises(ConnectorOutcomeUnknownError) as unknown:
                    await rpc.request(device_id, "session.send_message", _message("m_u"), timeout=0.5)
                assert unknown.value.code == "command_outcome_unknown"
                assert (await store.get_device_command(user_id, "m_u"))["state"] == "unknown"
                # Never reported as offline.
                assert await rpc.is_online(device_id)

                # The device finishes; a replay asks Commands/status instead of sending again.
                await eventually(lambda: _known(device, "m_u"))
                device.state.ack_delay = 0
                assert await rpc.request(device_id, "session.send_message", _message("m_u")) == {"ok": True}
                assert [m for m, _p in device.state.command_log].count("session.sendMessage") == 1
                assert (await store.get_device_command(user_id, "m_u"))["state"] == "accepted"

                # command.result through the outbox settles an unknown receipt as well.
                await store.record_device_command(
                    user_id=user_id,
                    command_id="m_o",
                    kind="session.sendMessage",
                    device_id=device_id,
                    session_id="sess_c1",
                    input_digest=None,
                    payload={},
                )
                await store.settle_device_command(
                    device_id=device_id, command_id="m_o", state="unknown", result=None, only_from=("pending",)
                )
                item = device.state.push_outbox(
                    "command.result", {"commandId": "m_o", "outcome": "accepted", "r": {"delivery": "queued"}}
                )
                await eventually(lambda: acked(device, item.oid))
                settled = await store.get_device_command(user_id, "m_o")
                assert settled["state"] == "accepted" and settled["result"]["r"] == {"delivery": "queued"}

                # On ready, unknown receipts the device knows are settled (read-only status call).
                await store.record_device_command(
                    user_id=user_id,
                    command_id="m_r",
                    kind="session.sendMessage",
                    device_id=device_id,
                    session_id="sess_c1",
                    input_digest=None,
                    payload={},
                )
                await store.settle_device_command(
                    device_id=device_id, command_id="m_r", state="unknown", result=None, only_from=("pending",)
                )
                device.state.receipts["m_r"] = CommandAck(outcome="rejected", e=LinkError(code="session_busy", message="b"))
                assert await app.state.device_commands.reconcile_device(device_id) == 1
                assert (await store.get_device_command(user_id, "m_r"))["state"] == "rejected"
            finally:
                await device.stop()

    asyncio.run(scenario())


async def _known(device, command_id: str) -> bool:
    return command_id in device.state.receipts


def test_hello_replays_only_deferrable_commands(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _headers, device_id, token = await user_and_device(app, client)
            store = app.state.store
            user_id = (await store.get_connector(device_id)).userId
            for command_id, kind in (("m_late", "session.sendMessage"), ("s_late", "device.settings.apply")):
                await store.record_device_command(
                    user_id=user_id,
                    command_id=command_id,
                    kind=kind,
                    device_id=device_id,
                    session_id=None,
                    input_digest=None,
                    payload={"k": command_id},
                )
            device, welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                assert [(c["commandId"], c["m"]) for c in welcome["pendingCommands"]] == [
                    ("s_late", "device.settings.apply")
                ]
            finally:
                await device.stop()

    asyncio.run(scenario())
