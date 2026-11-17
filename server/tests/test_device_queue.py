"""The in-run queue of a v3 session is the device's (real Router, fake device)."""

from __future__ import annotations

import asyncio
import json

from device_link_helpers import (
    acked,
    eventually,
    offline,
    server,
    summary,
    user_and_device,
)
from mesh_fixtures import RouterProcess

from agent_server.core.device_meshcall import LinkError
from agent_server.core.events import events_from_invalidation
from scripts.v3_fake_device import connect_device


def _queue(revision: int, *message_ids: str) -> dict:
    return {
        "sessionId": "sess_q1",
        "revision": revision,
        "items": [
            {
                "messageId": mid,
                "sessionId": "sess_q1",
                "clientMessageId": f"c_{mid}",
                "content": "later",
                "status": "queued",
                "position": index + 1,
                "createdBy": "user_v3",
                "createdAt": "2026-11-16T10:00:00Z",
                "updatedAt": "2026-11-16T10:00:00Z",
            }
            for index, mid in enumerate(message_ids)
        ],
    }


def test_queue_reads_changes_and_messages_go_to_the_device(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                pushed = device.state.push_outbox("session.summary", summary("sess_q1", 0, status="running"))
                await eventually(lambda: acked(device, pushed.oid))

                def handle(method: str, p: dict):
                    if method == "session.sendMessage":
                        device.state.queues["sess_q1"] = _queue(1, "q_1")
                        return {"delivery": "queued", "queuePosition": 1, "queue": _queue(1, "q_1")}
                    if method == "session.queue.delete":
                        if p["messageId"] != "q_1":
                            return LinkError(code="queue_item_not_found", message="no such item")
                        device.state.queues["sess_q1"] = _queue(2)
                        return {"queue": _queue(2)}
                    return {"ok": True}

                device.state.command_handler = handle
                takeover = await client.post("/api/v2/sessions/sess_q1/takeover", headers=headers)
                assert takeover.status_code == 200, takeover.text
                sent = await client.post(
                    "/api/v2/sessions/sess_q1/runtime/messages",
                    headers=headers,
                    json={"content": "later", "clientMessageId": "m_q", "queue": "auto"},
                )
                assert sent.status_code == 200, sent.text
                assert sent.json()["result"]["delivery"] == "queued"
                method, payload = device.state.command_log[-1]
                assert method == "session.sendMessage" and payload["queue"] == "auto"

                read = await client.get("/api/v2/sessions/sess_q1/runtime/queue", headers=headers)
                assert read.status_code == 200, read.text
                assert [item["messageId"] for item in read.json()["items"]] == ["q_1"]

                missing = await client.delete("/api/v2/sessions/sess_q1/runtime/queue/q_9", headers=headers)
                assert missing.status_code == 404
                assert missing.json()["detail"]["code"] == "queue_item_not_found"
                deleted = await client.delete("/api/v2/sessions/sess_q1/runtime/queue/q_1", headers=headers)
                assert deleted.status_code == 200, deleted.text
                assert deleted.json() == {**deleted.json(), "revision": 2, "items": []}
                assert device.state.command_log[-1] == (
                    "session.queue.delete",
                    {"sessionId": "sess_q1", "messageId": "q_1"},
                )

                # The device's live queue updates reach the session's subscribers.
                queue = await app.state.timeline_broker.register("sess_q1")
                device.state.emit("runtime.queue.updated", {"sessionId": "sess_q1", "queue": _queue(3, "q_2")})
                while True:
                    message = await asyncio.wait_for(queue.get(), 10)
                    events = events_from_invalidation(json.loads(str(message)))
                    if any(event.type == "runtime.queue.updated" for event in events):
                        break
                event = next(event for event in events if event.type == "runtime.queue.updated")
                assert event.payload["queue"]["revision"] == 3
            finally:
                await device.stop()

            await eventually(lambda: offline(app.state.rpc, device_id))
            read = await client.get("/api/v2/sessions/sess_q1/runtime/queue", headers=headers)
            assert read.status_code == 200
            assert read.json()["items"] == [] and read.json()["deviceOffline"] is True

    asyncio.run(scenario())
