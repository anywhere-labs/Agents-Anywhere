"""Durable command receipts for v3 devices (real Router, fake device)."""

from __future__ import annotations

import asyncio

import pytest
from device_link_helpers import acked, eventually, offline, server, user_and_device
from mesh_fixtures import RouterProcess
from sqlalchemy import text

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
                # D1: the receipt keeps the digest and outcome, neither the message nor the device's answer.
                assert receipt["payload"] is None and receipt["result"] is None
                assert receipt["inputDigest"].startswith("sha256:")

                # Same id, same input: the recorded outcome, the device is not asked again.
                calls = device.state.calls.count("session.sendMessage")
                assert await rpc.request(device_id, "session.send_message", _message("m_1")) == {}
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
                rejected_receipt = await store.get_device_command(user_id, "m_2")
                assert rejected_receipt["state"] == "rejected"
                assert rejected_receipt["result"] == {"e": {"code": "session_busy", "retryable": False}}

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
                assert await rpc.request(device_id, "session.send_message", _message("m_u")) == {}
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
                assert settled["state"] == "accepted" and settled["result"] is None

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
            # Only the deferrable command keeps its payload; the message receipt keeps none.
            assert (await store.get_device_command(user_id, "m_late"))["payload"] is None
            device, welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                assert [(c["commandId"], c["m"], c["p"]) for c in welcome["pendingCommands"]] == [
                    ("s_late", "device.settings.apply", {"k": "s_late"})
                ]
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_receipts_store_no_conversation_content(mesh_router: RouterProcess, monkeypatch) -> None:
    """D1: message text and queue contents reach the device and the caller, never ``device_commands``."""

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            store = app.state.store
            user_id = (await store.get_connector(device_id)).userId
            secret = "the secret prompt text"
            try:
                await app.state.rpc.request(device_id, "session.send_message", _message("m_s", secret))
                assert device.state.command_log[-1][1]["content"] == secret

                queue = {"sessionId": "sess_c1", "revision": 2, "items": [{"id": "q_1", "text": secret}]}
                device.state.command_handler = lambda method, p: {"queue": queue}
                changed = await app.state.device_queue.change(
                    user_id=user_id, device_id=device_id, session_id="sess_c1", kind="update",
                    payload={"itemId": "q_1", "content": secret},
                )
                # The caller gets the device's answer at once.
                assert changed == queue
            finally:
                await device.stop()
            async with store.engine.connect() as conn:
                rows = (
                    await conn.execute(
                        text("SELECT kind, payload_json, result_json, input_digest FROM device_commands")
                    )
                ).all()
            assert {row.kind for row in rows} == {"session.sendMessage", "session.queue.update"}
            for row in rows:
                assert row.payload_json is None and row.result_json is None
                assert row.input_digest.startswith("sha256:")

    asyncio.run(scenario())


def test_receipt_fields_keep_no_content() -> None:
    from agent_server.core.device_meshcall import (
        DEFERRABLE_COMMANDS,
        receipt_payload,
        receipt_result,
    )

    assert DEFERRABLE_COMMANDS == {"runtime.apply", "device.settings.apply", "channel.switch"}
    assert receipt_payload("session.sendMessage", {"content": "secret"}) is None
    assert receipt_payload("session.queue.update", {"content": "secret"}) is None
    assert receipt_payload("runtime.apply", {"runtimeId": "codex"}) == {"runtimeId": "codex"}
    assert receipt_result({"r": {"queue": {"items": [{"text": "secret"}]}}, "e": None}) is None
    assert receipt_result(
        {"r": None, "e": {"code": "session_busy", "message": "secret", "retryable": True}}
    ) == {"e": {"code": "session_busy", "retryable": True}}
    assert receipt_result({"r": {"execution": "started", "state": {"plan": "secret"}}}) == {
        "r": {"execution": "started"}
    }
