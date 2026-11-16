"""Server-owned session message queue: enqueue, dispatch, and controls."""

from __future__ import annotations

import asyncio
from typing import Any

from test_backend_mvp import (
    FakeLocalRpc,
    create_connector_and_session,
    make_client,
)

from agent_server.infra.connector_rpc import ConnectorRpcError


def _running(session_id: str, status: str = "running") -> dict[str, Any]:
    return {
        "sessionId": session_id,
        "runtime": "codex",
        "status": status,
        "selections": {},
        "metadata": {"source": "test.queue"},
    }


def _setup(tmp_path, *, status: str = "running"):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    fake_rpc = FakeLocalRpc()
    fake_rpc.runtime_states[session_id] = _running(session_id, status)
    client.app.state.rpc = fake_rpc
    asyncio.run(client.app.state.store.set_connector_status(connector_id, "online"))
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    return client, fake_rpc, session_id, headers


def _send(client, session_id, headers, content, *, queue="auto", client_message_id=None):
    body: dict[str, Any] = {"content": content}
    if queue is not None:
        body["queue"] = queue
    if client_message_id is not None:
        body["clientMessageId"] = client_message_id
    return client.post(f"/sessions/{session_id}/runtime/messages", headers=headers, json=body)


def _sent(fake_rpc) -> list[dict[str, Any]]:
    return [params for _, method, params, _ in fake_rpc.requests if method == "session.send_message"]


def _fail_sends(fake_rpc) -> None:
    """Refuse ``session.send_message`` only; state reads keep working."""
    original = fake_rpc.request

    async def request(connector_id, method, params, *, timeout=30):
        if method == "session.send_message" and getattr(fake_rpc, "fail_sends", False):
            fake_rpc.requests.append((connector_id, method, params, timeout))
            raise ConnectorRpcError("codex_error", "runtime refused the turn")
        return await original(connector_id, method, params, timeout=timeout)

    fake_rpc.request = request
    fake_rpc.fail_sends = True


def _drain(client, session_id) -> None:
    asyncio.run(client.app.state.message_queue_dispatcher.drain_now(session_id))


def _queue(client, session_id, headers) -> dict[str, Any]:
    response = client.get(f"/sessions/{session_id}/runtime/queue", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_wake_does_not_block_the_caller(tmp_path):
    """The connector notification path wakes the queue without waiting on RPC."""
    client, _, session_id, _ = _setup(tmp_path)
    dispatcher = client.app.state.message_queue_dispatcher
    started = asyncio.Event()

    async def scenario() -> None:
        async def slow_attempt(_session_id: str, *, owner: str | None = None) -> None:
            started.set()
            await asyncio.sleep(10)

        dispatcher._attempt = slow_attempt  # type: ignore[method-assign]
        dispatcher.wake(session_id)
        # Returned synchronously; the attempt runs in the background.
        await asyncio.wait_for(started.wait(), timeout=1)
        await dispatcher.close()

    asyncio.run(scenario())


def test_published_queue_becomes_a_live_queue_event():
    import json

    from agent_server.infra.shared_message import prepare_session_events

    queue = {"sessionId": "sess_1", "revision": 3, "items": []}
    events = prepare_session_events(
        json.dumps({"sessionId": "sess_1", "nextSeq": 42, "queueState": queue})
    )

    assert [event.event_type for event in events] == ["runtime.queue.updated"]
    encoded = json.loads(events[0].encoded_json)
    assert encoded["payload"] == {"queue": queue}
    assert encoded["protocolVersion"] == "1.0"
    assert encoded["sequence"] == 42
