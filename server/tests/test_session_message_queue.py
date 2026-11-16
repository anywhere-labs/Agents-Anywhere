"""Server-owned session message queue: enqueue, dispatch, and controls."""

from __future__ import annotations

import asyncio
from typing import Any

from test_backend_mvp import (
    FakeLocalRpc,
    create_connector_and_session,
    make_client,
)

from agent_server.core.message_queue import MESSAGE_QUEUE_MAX_ITEMS
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


def test_running_session_without_queue_mode_keeps_rejecting(tmp_path):
    client, _fake_rpc, session_id, headers = _setup(tmp_path)

    response = _send(client, session_id, headers, "hi", queue=None)

    assert response.status_code == 409
    assert response.json()["detail"] == "session is running"
    assert _queue(client, session_id, headers)["items"] == []


def test_queue_never_rejects_with_a_code(tmp_path):
    client, _, session_id, headers = _setup(tmp_path)

    response = _send(client, session_id, headers, "hi", queue="never")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "session_busy"


def test_running_session_queues_and_dispatches_after_idle(tmp_path):
    client, fake_rpc, session_id, headers = _setup(tmp_path)

    first = _send(client, session_id, headers, "first", client_message_id="cm-1")
    second = _send(client, session_id, headers, "second", client_message_id="cm-2")

    assert first.status_code == 200, first.text
    result = first.json()["result"]
    assert result["delivery"] == "queued"
    assert result["queuePosition"] == 1
    assert second.json()["result"]["queuePosition"] == 2
    assert _sent(fake_rpc) == []

    # Still running: nothing goes out.
    _drain(client, session_id)
    assert _sent(fake_rpc) == []

    fake_rpc.runtime_states[session_id] = _running(session_id, "idle")
    _drain(client, session_id)

    sent = _sent(fake_rpc)
    assert [params["content"] for params in sent] == ["first"]
    assert sent[0]["clientMessageId"] == "cm-1"
    queue = _queue(client, session_id, headers)
    assert [item["content"] for item in queue["items"]] == ["second"]
    assert queue["items"][0]["position"] == 1


def test_idle_session_with_waiting_messages_queues_behind_them(tmp_path):
    client, fake_rpc, session_id, headers = _setup(tmp_path)
    _send(client, session_id, headers, "first").raise_for_status()
    fake_rpc.runtime_states[session_id] = _running(session_id, "idle")

    response = _send(client, session_id, headers, "second")

    assert response.json()["result"]["delivery"] == "queued"
    assert response.json()["result"]["queuePosition"] == 2
    assert _sent(fake_rpc) == [] or _sent(fake_rpc)[0]["content"] == "first"


def test_idle_session_with_empty_queue_sends_directly(tmp_path):
    client, fake_rpc, session_id, headers = _setup(tmp_path, status="idle")

    response = _send(client, session_id, headers, "hello")

    assert response.status_code == 200, response.text
    assert (response.json()["result"] or {}).get("delivery") != "queued"
    assert [params["content"] for params in _sent(fake_rpc)] == ["hello"]


def test_same_client_message_id_is_queued_once(tmp_path):
    client, _, session_id, headers = _setup(tmp_path)

    _send(client, session_id, headers, "once", client_message_id="cm-dup").raise_for_status()
    again = _send(client, session_id, headers, "once", client_message_id="cm-dup")

    assert again.status_code == 200
    assert len(_queue(client, session_id, headers)["items"]) == 1


def test_queue_is_bounded(tmp_path):
    client, _, session_id, headers = _setup(tmp_path)
    for index in range(MESSAGE_QUEUE_MAX_ITEMS):
        _send(client, session_id, headers, f"m{index}").raise_for_status()

    response = _send(client, session_id, headers, "one too many")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "queue_full"


def test_error_state_pauses_queue_until_resumed(tmp_path):
    client, fake_rpc, session_id, headers = _setup(tmp_path)
    _send(client, session_id, headers, "after error").raise_for_status()
    fake_rpc.runtime_states[session_id] = _running(session_id, "error")

    _drain(client, session_id)
    assert _sent(fake_rpc) == []

    response = client.post(f"/sessions/{session_id}/runtime/queue/resume", headers=headers)
    assert response.status_code == 200, response.text
    _drain(client, session_id)
    assert [params["content"] for params in _sent(fake_rpc)] == ["after error"]


def test_failed_head_stops_the_queue_and_can_be_retried(tmp_path):
    client, fake_rpc, session_id, headers = _setup(tmp_path)
    _send(client, session_id, headers, "first").raise_for_status()
    _send(client, session_id, headers, "second").raise_for_status()
    fake_rpc.runtime_states[session_id] = _running(session_id, "idle")
    _fail_sends(fake_rpc)

    _drain(client, session_id)

    queue = _queue(client, session_id, headers)
    assert [item["status"] for item in queue["items"]] == ["failed", "queued"]
    assert queue["items"][0]["error"]["code"]

    fake_rpc.fail_sends = False
    fake_rpc.requests.clear()
    _drain(client, session_id)
    assert _sent(fake_rpc) == []  # the failure blocks later messages

    head = queue["items"][0]["messageId"]
    response = client.post(f"/sessions/{session_id}/runtime/queue/{head}/retry", headers=headers)
    assert response.status_code == 200, response.text
    _drain(client, session_id)
    assert [params["content"] for params in _sent(fake_rpc)] == ["first"]


def test_interrupt_mode_queues_first_and_stops_turn_once(tmp_path):
    client, fake_rpc, session_id, headers = _setup(tmp_path)
    _send(client, session_id, headers, "later").raise_for_status()

    response = _send(client, session_id, headers, "urgent", queue="interrupt")

    assert response.status_code == 200, response.text
    queue = _queue(client, session_id, headers)
    assert [item["content"] for item in queue["items"]] == ["urgent", "later"]
    assert queue["items"][0]["interruptRequested"] is True

    _drain(client, session_id)
    _drain(client, session_id)
    interrupts = [m for _, m, _, _ in fake_rpc.requests if m == "session.interrupt"]
    assert len(interrupts) == 1

    fake_rpc.runtime_states[session_id] = _running(session_id, "idle")
    _drain(client, session_id)
    assert [params["content"] for params in _sent(fake_rpc)] == ["urgent"]


def test_edit_reorder_delete_and_clear(tmp_path):
    client, _, session_id, headers = _setup(tmp_path)
    for content in ("a", "b", "c"):
        _send(client, session_id, headers, content).raise_for_status()
    ids = [item["messageId"] for item in _queue(client, session_id, headers)["items"]]

    edited = client.patch(
        f"/sessions/{session_id}/runtime/queue/{ids[1]}",
        headers=headers,
        json={"content": "b2"},
    )
    assert edited.status_code == 200, edited.text
    reordered = client.put(
        f"/sessions/{session_id}/runtime/queue/order",
        headers=headers,
        json={"messageIds": [ids[2], ids[0], ids[1]]},
    )
    assert reordered.status_code == 200, reordered.text
    assert [item["content"] for item in reordered.json()["items"]] == ["c", "a", "b2"]

    bad_order = client.put(
        f"/sessions/{session_id}/runtime/queue/order",
        headers=headers,
        json={"messageIds": [ids[0]]},
    )
    assert bad_order.status_code == 422

    deleted = client.delete(f"/sessions/{session_id}/runtime/queue/{ids[0]}", headers=headers)
    assert [item["content"] for item in deleted.json()["items"]] == ["c", "b2"]
    revision = deleted.json()["revision"]

    cleared = client.delete(f"/sessions/{session_id}/runtime/queue", headers=headers)
    assert cleared.json()["items"] == []
    assert cleared.json()["revision"] > revision

    missing = client.delete(f"/sessions/{session_id}/runtime/queue/{ids[0]}", headers=headers)
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "queue_item_not_found"


def test_sending_item_cannot_be_changed_and_stale_send_becomes_failure(tmp_path):
    client, _, session_id, headers = _setup(tmp_path)
    _send(client, session_id, headers, "in flight").raise_for_status()
    store = client.app.state.store
    head = asyncio.run(store.get_session_queue_head(session_id))
    assert asyncio.run(store.claim_session_queue_head(session_id, head["messageId"], owner="w1"))

    blocked = client.delete(
        f"/sessions/{session_id}/runtime/queue/{head['messageId']}", headers=headers
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "queue_item_sending"

    # A second claimant never sends the same message.
    assert asyncio.run(store.claim_session_queue_head(session_id, head["messageId"], owner="w2")) is None

    failed = asyncio.run(store.fail_stale_session_queue_sends(older_than_seconds=-1))
    assert failed == [session_id]
    item = _queue(client, session_id, headers)["items"][0]
    assert item["status"] == "failed"
    assert item["error"]["code"] == "queue_dispatch_unknown"


def test_queue_capability_and_snapshot(tmp_path):
    client, _, session_id, headers = _setup(tmp_path)
    _send(client, session_id, headers, "waiting").raise_for_status()

    snapshot = client.get(f"/sessions/{session_id}/snapshot", headers=headers)

    assert snapshot.status_code == 200, snapshot.text
    body = snapshot.json()
    assert [item["content"] for item in body["queue"]["items"]] == ["waiting"]
    capabilities = {
        item["capabilityId"]: item for item in body["effectiveCapabilities"]["capabilities"]
    }
    queue_capability = capabilities["session.queue"]
    assert queue_capability["supported"] is True
    assert queue_capability["available"] is True
    assert queue_capability["allowed"] is True
    # The runtime cannot start a turn while one runs; the queue still can.
    assert capabilities["session.send_message"]["available"] is False


def test_read_only_session_cannot_queue(tmp_path):
    client, _, session_id, headers = _setup(tmp_path)
    client.delete(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()

    response = _send(client, session_id, headers, "nope")

    assert response.status_code == 409
    assert _queue(client, session_id, headers)["items"] == []


def test_archived_session_drops_its_queue_on_dispatch(tmp_path):
    client, fake_rpc, session_id, headers = _setup(tmp_path)
    _send(client, session_id, headers, "never sent").raise_for_status()
    asyncio.run(client.app.state.store.set_session_archived(session_id, True))
    fake_rpc.runtime_states[session_id] = _running(session_id, "idle")

    _drain(client, session_id)

    assert _sent(fake_rpc) == []
    assert asyncio.run(client.app.state.store.get_session_queue(session_id))["items"] == []


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


def test_send_capability_lag_keeps_message_waiting(tmp_path):
    """The turn ended but the runtime still reports it cannot take a message."""
    client, fake_rpc, session_id, headers = _setup(tmp_path)
    _send(client, session_id, headers, "soon").raise_for_status()
    fake_rpc.runtime_states[session_id] = _running(session_id, "idle")
    original = fake_rpc.request

    async def lagging(connector_id, method, params, *, timeout=30):
        result = await original(connector_id, method, params, timeout=timeout)
        if method == "session.capabilities":
            for capability in result["capabilitySet"]["capabilities"]:
                if capability["capabilityId"] == "session.send_message":
                    capability["available"] = False
        return result

    fake_rpc.request = lagging
    _drain(client, session_id)

    item = _queue(client, session_id, headers)["items"][0]
    assert item["status"] == "queued"
    assert _sent(fake_rpc) == []


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
