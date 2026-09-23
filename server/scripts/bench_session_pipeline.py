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
import platform
import statistics
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument("--output", type=Path)
parser.add_argument(
    "--offload-workers",
    type=int,
    help="Also compare concurrent fanout with inline and N warmed process workers",
)
args = parser.parse_args() if __name__ == "__main__" else parser.parse_args([])
for key in tuple(os.environ):
    if key.startswith("AGENT_SERVER_"):
        os.environ.pop(key)
sys.path[:0] = [str(args.repo / "server"), str(args.repo / "connector")]

from agent_server.core.events import events_from_invalidation
from agent_server.core.models import SessionView
from agent_server.core.protocol import ProtocolCapabilitySet
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.effective_capabilities import (
    _INHERITED_RUNTIME_CAPABILITY_IDS,
    derive_session_effective_capabilities,
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
    lag_samples = []
    for _ in range(3):
        wall, cpu = time.perf_counter(), time.thread_time()
        facts = await work()
        samples.append(
            ((time.perf_counter() - wall) * 1000, (time.thread_time() - cpu) * 1000)
        )
        if "max_loop_lag_ms" in facts:
            lag_samples.append(facts["max_loop_lag_ms"])
    if lag_samples:
        facts["max_loop_lag_ms"] = round(statistics.median(lag_samples), 3)
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
        self.stamp_reads = 0
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

    async def get_protocol_capabilities_stamp(self, _connector):
        self.stamp_reads += 1
        return (1, "unchanged")

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
        "stamp_reads": store.stamp_reads,
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


async def single_session_capabilities():
    store = CapabilityStore()
    source = ProtocolCapabilitySet.model_validate_json(store.raw)
    for session in store.sessions:
        result = derive_session_effective_capabilities(
            session=session,
            runtime_capabilities=source,
        )
        assert len(result.capabilities) == 10
    return {
        "projections": 200,
        "capability_records": 2000,
        "scope": "single-session projection API",
    }


async def main():
    result = {
        "repo": str(args.repo),
        "python": sys.version.split()[0],
        "platform": f"{platform.system()} {platform.machine()}",
        "policy": "warm once, median of three; event-loop CPU; no network/database",
        "results": {},
    }
    for name, work in (
        ("connector", connector),
        ("capabilities", capabilities),
        ("single_session_capabilities", single_session_capabilities),
        ("fanout", fanout),
    ):
        result["results"][name] = await measure(work)
    if args.offload_workers is not None:
        for workers in (0, args.offload_workers):
            broker = TimelineBroker(event_workers=workers)
            started = time.perf_counter()
            await broker.start()
            startup_ms = (time.perf_counter() - started) * 1000
            try:
                result["results"][f"concurrent_fanout_{workers}_workers"] = {
                    **await measure(lambda broker=broker: concurrent_fanout(broker)),
                    "pool_startup_ms": round(startup_ms, 3),
                }
            finally:
                await broker.close()
    output = json.dumps(result, indent=2)
    if args.output:
        args.output.write_text(output + "\n")
    print(output)


async def concurrent_fanout(broker):
    queues = [
        [await broker.register(f"session_{session}") for _ in range(4)]
        for session in range(4)
    ]
    lag_samples = []
    stopped = False

    async def monitor():
        while not stopped:
            due = time.perf_counter() + 0.002
            await asyncio.sleep(0.002)
            lag_samples.append(max(0.0, time.perf_counter() - due) * 1000)

    async def replay(session, subscribers):
        session_id = f"session_{session}"
        for sequence in range(1, 7):
            item = {
                "id": "message",
                "sessionId": session_id,
                "type": "message",
                "role": "assistant",
                "status": "running",
                "revision": sequence,
                "updatedSeq": sequence,
                "content": {
                    "blocks": [{"type": "text", "text": "x" * 256} for _ in range(1024)]
                },
            }
            await broker.publish(
                session_id,
                {
                    "sessionId": session_id,
                    "nextSeq": sequence,
                    "items": [item],
                },
            )
            for queue in subscribers:
                batch = await (await queue.get()).prepared_events()
                assert len(batch) == 1
                assert batch[0].event_id.startswith(f"evt_{sequence}_")
        return 6 * len(subscribers)

    monitor_task = asyncio.create_task(monitor())
    try:
        sent = sum(
            await asyncio.gather(
                *(
                    replay(session, subscribers)
                    for session, subscribers in enumerate(queues)
                )
            )
        )
    finally:
        stopped = True
        await monitor_task
        for session, subscribers in enumerate(queues):
            for queue in subscribers:
                await broker.unregister(f"session_{session}", queue)
    return {
        "sessions": 4,
        "notifications": 24,
        "subscribers_per_session": 4,
        "sent": sent,
        "max_loop_lag_ms": max(lag_samples, default=0.0),
        "scope": "actual broker; warm pool; 2ms event-loop timer; no network/database",
    }


if __name__ == "__main__":
    asyncio.run(main())
