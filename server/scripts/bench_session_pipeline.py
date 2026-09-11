"""Headless Connector/Server CPU comparisons; no network or database is used.

Run with the Server uv environment. --repo selects the checkout being measured,
so the same script can measure the committed baseline and the candidate.
"""

from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
import statistics
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument("--output", type=Path)
args = parser.parse_args()
for key in tuple(os.environ):
    if key.startswith("AGENT_SERVER_"):
        os.environ.pop(key)
sys.path[:0] = [str(args.repo / "server"), str(args.repo / "connector")]

from agent_server.core.events import events_from_invalidation
from agent_server.core.models import SessionView
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.effective_capabilities import (
    _INHERITED_RUNTIME_CAPABILITY_IDS,
    publish_connector_session_capabilities,
)
from connector.runtime_protocol import (
    MessageTimelineItem,
    MultimodalMessageContent,
    TimelineSource,
)
from connector.server.notification_coalescer import TimelineItemNotificationCoalescer
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.runtime_rpc_payloads import server_payload_without_turn_data
from loguru import logger

logger.remove()


async def measure(work):
    await work()
    samples = []
    for _ in range(3):
        wall, cpu = time.perf_counter(), time.thread_time()
        facts = await work()
        samples.append(
            ((time.perf_counter() - wall) * 1000, (time.thread_time() - cpu) * 1000)
        )
    return {
        "wall_ms": round(statistics.median(x[0] for x in samples), 3),
        "loop_cpu_ms": round(statistics.median(x[1] for x in samples), 3),
        **facts,
    }


async def connector():
    emitted = []
    supports_deferred = (
        "defer_payload_projection" in inspect.signature(ConnectorRuntimeHost).parameters
    )

    async def send(method, params):
        if supports_deferred and method != "session.turnEnded":
            params = server_payload_without_turn_data(params)
        emitted.append(
            json.dumps(
                {"method": method, "params": params},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )

    async def download(*_args):
        raise AssertionError("network is not part of this benchmark")

    coalescer = TimelineItemNotificationCoalescer(send, window_seconds=10)
    kwargs = {"defer_payload_projection": True} if supports_deferred else {}
    host = ConnectorRuntimeHost("bench", coalescer.send, download, **kwargs)
    for sequence in range(96):
        content = MultimodalMessageContent(
            metadata={
                "blocks": [{"type": "text", "text": "x" * 256} for _ in range(256)],
                "last": str(sequence),
            }
        )
        item = MessageTimelineItem(
            id="message_1",
            type="message",
            status="running",
            role="assistant",
            content=content,
            source=TimelineSource(runtime="codex"),
            revision=sequence + 1,
        ).to_platform_item("session_1", 1)
        await host.timeline_item_upsert(item)
    await coalescer.close()
    assert len(emitted) == 1
    final = json.loads(emitted[0])["params"]["item"]
    assert final["revision"] == 96 and final["content"]["last"] == "95"
    return {
        "inputs": 96,
        "sent": len(emitted),
        "final_hash": final["contentHash"],
        "wire_bytes": len(emitted[0].encode()),
        "scope": "projection, hash, coalescing, JSON",
    }


class CapabilityStore:
    def __init__(self):
        self.reads = 0
        self.sessions = [
            SessionView(
                id=f"s{i}",
                connectorId="bench",
                runtime="codex",
                connectorStatus="online",
                takeover=True,
                status="idle",
                updatedSeq=9,
            )
            for i in range(200)
        ]
        self.raw = json.dumps(
            {
                "revision": 9,
                "capabilities": [
                    {
                        "runtime": "codex",
                        "scope": "session",
                        "sessionId": session.id,
                        "capabilityId": capability_id,
                    }
                    for session in self.sessions
                    for capability_id in _INHERITED_RUNTIME_CAPABILITY_IDS
                ],
            }
        )

    async def list_sessions_for_connector(self, _connector):
        return self.sessions

    async def get_protocol_capabilities(self, _connector, *, user_id=None):
        self.reads += 1
        return json.loads(self.raw)

    async def get_session_seq(self, _session):
        return 9

    @asynccontextmanager
    async def session_revision_fence(self, _session):
        yield


class Presence:
    async def is_online(self, _connector):
        return True


class Publisher:
    def __init__(self):
        self.sent = []

    async def publish(self, session_id, payload):
        self.sent.append((session_id, payload))


async def capabilities():
    store, publisher = CapabilityStore(), Publisher()
    await publish_connector_session_capabilities(store, Presence(), publisher, "bench")
    assert len(publisher.sent) == 200
    assert all(
        len(value["capabilitySet"]["capabilities"]) == 10 for _, value in publisher.sent
    )
    return {
        "sessions": 200,
        "capability_records": 2000,
        "capability_reads": store.reads,
        "scope": "actual publication service, in-memory ports",
    }


async def fanout():
    broker = TimelineBroker()
    queues = [await broker.register("session_1") for _ in range(4)]
    raw_item = {
        "id": "message_1",
        "sessionId": "session_1",
        "type": "message",
        "role": "assistant",
        "status": "done",
        "revision": 2,
        "updatedSeq": 10,
        "content": {
            "blocks": [{"type": "text", "text": "x" * 256} for _ in range(1024)]
        },
    }
    sent = 0
    for _ in range(24):
        await broker.publish(
            "session_1", {"sessionId": "session_1", "nextSeq": 10, "items": [raw_item]}
        )
        for queue in queues:
            message = await queue.get()
            if hasattr(message, "prepared_events"):
                events = await message.prepared_events()
                assert len(events) == 1 and events[0].event_id.startswith("evt_10_")
                sent += len(events)
            else:
                for event in events_from_invalidation(json.loads(message)):
                    json.dumps(
                        event.model_dump(mode="json"),
                        ensure_ascii=False,
                        separators=(",", ":"),
                        allow_nan=False,
                    )
                    sent += 1
    await broker.close()
    return {
        "notifications": 24,
        "subscribers": 4,
        "sent": sent,
        "scope": "actual local broker plus outbound event preparation; no sockets",
    }


async def main():
    result = {
        "repo": str(args.repo),
        "python": sys.version.split()[0],
        "policy": "warm once, median of three; event-loop CPU; no network/database",
        "results": {},
    }
    for name, work in (
        ("connector", connector),
        ("capabilities", capabilities),
        ("fanout", fanout),
    ):
        result["results"][name] = await measure(work)
    output = json.dumps(result, indent=2)
    if args.output:
        args.output.write_text(output + "\n")
    print(output)


if __name__ == "__main__":
    asyncio.run(main())
