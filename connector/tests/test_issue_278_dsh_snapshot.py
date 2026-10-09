"""Issue #278: one oversized DSH session must not stall the whole runtime.

Use the real DSH relay, host binding and ingest client with synthetic history and
an in-process gateway that rejects bodies over a size limit (50 MiB like the
public ingress unless stated otherwise). Never send history to a real server.

The Connector now isolates a session whose complete snapshot the backend refuses;
its history stays unsynchronized. Uploading such a snapshot needs the staged
snapshot protocol, which these tests do not claim.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx

from connector.runtime_protocol import (
    RuntimeInstanceHost,
    RuntimeInstanceSpec,
    timeline_content_hash,
)
from connector.runtimes.dsh.bridge.sync import SyncRelay
from connector.runtimes.dsh.runtime import DshRuntime
from connector.server.ingest import ConnectorIngestClient
from connector.server.runtime_host import ConnectorRuntimeHost

MIB = 1024 * 1024
SESSION = "test-session"
EXTERNAL = "test-native"
CHECKPOINT = {"version": 1, "projectionVersion": 3, "throughSeq": 11,
              "historyHash": "a" * 64, "settled": True}
CHECKPOINT_KEY = f"dsh/sync/checkpoints/{EXTERNAL}"


def make_items(count: int, payload_bytes: int, session: str = SESSION):
    content = {"text": "x" * payload_bytes, "format": "markdown"}
    digest = timeline_content_hash("message", "done", "assistant", content)
    return [{"id": f"item-{i}", "sessionId": session, "type": "message", "role": "assistant",
             "status": "done", "orderSeq": i + 1, "revision": 1, "content": content,
             "source": {"runtime": "dsh"}, "contentHash": digest} for i in range(count)]


def op(kind: str, **values):
    return {"kind": kind, "sessionId": SESSION, "snapshotId": "test-capture", **values}


class Gateway:
    def __init__(self, limit: int = 50 * MIB):
        self.limit = limit
        self.sizes = []
        self.statuses = []
        self.ids = []
        self.complete_flags = []
        self.notes = []

    def __call__(self, request):
        self.sizes.append(len(request.content))
        if len(request.content) > self.limit:
            self.statuses.append(413)
            return httpx.Response(413)
        notes = json.loads(request.content)["notifications"]
        self.statuses.append(200)
        self.notes.extend(notes)
        for note in notes:
            if note["method"] == "timeline.sync":
                self.ids.extend(item["id"] for item in note["params"]["items"])
                self.complete_flags.append(note["params"]["complete"])
        return httpx.Response(200, json={"accepted": len(notes), "rejected": []})

    def methods(self):
        return [note["method"] for note in self.notes]


class RejectingGateway(Gateway):
    """Rejects the first complete snapshots inside an HTTP 200, as the server
    does when applying a notification raises (a database deadlock, say)."""

    def __init__(self, failures: int):
        super().__init__()
        self.failures = failures

    def __call__(self, request):
        notes = json.loads(request.content)["notifications"]
        index = next((i for i, note in enumerate(notes) if note["method"] == "timeline.sync"), None)
        if index is None or not self.failures:
            return super().__call__(request)
        self.failures -= 1
        self.statuses.append(200)
        return httpx.Response(200, json={"accepted": len(notes) - 1, "rejected": [{
            "index": index, "method": "timeline.sync", "code": "notification_failed",
            "message": "deadlock detected", "errorType": "DeadlockDetected"}]})


def stack(http, *, legacy=False, budget=8 * MIB):
    async def token(force):
        return "test-token"

    client = ConnectorIngestClient("https://aa.example.invalid", token, lambda: http, lambda _: http)
    client._max_body_bytes = budget

    async def single_post(notifications):
        # Exact old wire behavior: one complete HTTP JSON request, no paging.
        response = await http.post("https://aa.example.invalid/api/v2/connector/ingest",
                                   json={"notifications": notifications})
        response.raise_for_status()

    receiver = single_post if legacy else client.ingest_notifications
    base = ConnectorRuntimeHost("test-connector", AsyncMock(), AsyncMock(), ingest_notifications=receiver)
    health = AsyncMock()
    bound = RuntimeInstanceHost(base, RuntimeInstanceSpec(runtime_id="rti_test", runtime_type="dsh", name="test"),
                                status_reporter=health)
    return bound, health


async def capture(relay, items, *, through_seq=11):
    relay.durable_checkpoints = True
    await relay.operation(op("snapshot.begin", throughSeq=through_seq,
                             meta={"externalSessionId": EXTERNAL, "cwd": "/test", "title": "synthetic",
                                   "sourceState": {"availability": "available"}}))
    for item in items:
        # Each bridge transport page is small enough; commit still reassembles it.
        await relay.operation(op("snapshot.items", items=[item]))
    await relay.operation(op("snapshot.commit", totalItems=len(items), throughSeq=through_seq))


def notifications(*notes):
    return {"kind": "notifications", "notifications": list(notes)}


def test_issue278_legacy_complete_snapshot_over_50_mib_receives_413():
    async def run():
        gateway = Gateway()
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway)) as http:
            host, health = stack(http, legacy=True)
            relay = SyncRelay(Mock(), host)
            try:
                await capture(relay, make_items(11, 5 * MIB))
                assert gateway.statuses[0] == 413 and gateway.sizes[0] > 50 * MIB
                assert await host.sync_state_read(CHECKPOINT_KEY) is None
                # Even through the old single request, the 413 isolates only
                # this session as too large instead of failing the whole feed.
                assert relay.quarantined[SESSION].source_state["reason"] == "history_too_large"
                assert not relay.retry_tasks
                health.assert_not_awaited()
            finally:
                await relay.close()
    asyncio.run(run())


def test_issue278_oversized_snapshot_quarantines_only_that_session():
    async def run():
        gateway = Gateway()
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway)) as http:
            host, health = stack(http)
            relay = SyncRelay(Mock(), host)
            try:
                await capture(relay, make_items(11, 5 * MIB))
                assert gateway.statuses == [200, 413, 200], "meta, rejected snapshot, source update"
                assert gateway.methods() == ["session.meta.upsert", "session.source.updated"]
                source = gateway.notes[-1]["params"]
                assert source["availability"] == "unavailable" and source["reason"] == "history_too_large"
                health.assert_not_awaited()
                # The same history cannot fit later: no new capture is requested.
                assert not relay.retry_tasks

                # No resumable boundary for history the backend never received.
                await relay.operation({"kind": "checkpoint.save", "externalSessionId": EXTERNAL,
                                       "checkpoint": CHECKPOINT})
                assert await host.sync_state_read(CHECKPOINT_KEY) is None

                gateway.notes.clear()
                other_item = make_items(1, 10, session="other-session")[0]
                await relay.operation(notifications(
                    {"method": "timeline.itemUpsert", "params": {"sessionId": SESSION, "item": make_items(1, 10)[0]}},
                    {"method": "session.turnEnded", "params": {"sessionId": SESSION, "turnId": "t"}},
                    {"method": "session.source.updated", "params": {"sessionId": SESSION, "availability": "available",
                                                                    "observationOrigin": "event"}},
                    {"method": "session.state.updated", "params": {"sessionId": SESSION, "status": "idle"}},
                    {"method": "timeline.itemUpsert", "params": {"sessionId": "other-session", "item": other_item}},
                    {"method": "session.inventory.complete", "params": {"scanToken": "s", "complete": True, "sessions": [
                        {"sessionId": SESSION, "externalSessionId": EXTERNAL, "sourceState": {"availability": "available"}},
                        {"sessionId": "other-session", "externalSessionId": "other",
                         "sourceState": {"availability": "available"}},
                    ]}},
                ))
                assert gateway.methods() == ["session.state.updated", "timeline.itemUpsert",
                                             "session.inventory.complete"]
                assert gateway.notes[1]["params"]["sessionId"] == "other-session"
                inventory = {entry["sessionId"]: entry["sourceState"] for entry in gateway.notes[2]["params"]["sessions"]}
                quarantined_state = {k: source[k] for k in ("availability", "reason", "observedAt", "observationOrigin")}
                assert inventory == {SESSION: quarantined_state, "other-session": {"availability": "available"}}
                health.assert_awaited_once_with("rti_test", "running", None)
            finally:
                await relay.close()
    asyncio.run(run())


def test_issue278_unchanged_rejected_capture_is_not_uploaded_again_and_a_new_one_is():
    async def run():
        gateway = Gateway(limit=64 * 1024)
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway)) as http:
            host, _ = stack(http, budget=16 * 1024)
            relay = SyncRelay(Mock(), host)
            try:
                await capture(relay, make_items(4, 30 * 1024))
                assert gateway.statuses.count(413) == 1

                # Resubscription replays the same capture: metadata only.
                gateway.notes.clear()
                await capture(relay, make_items(4, 30 * 1024))
                assert gateway.statuses.count(413) == 1
                assert gateway.methods() == ["session.meta.upsert"]
                assert gateway.notes[0]["params"]["sourceState"]["availability"] == "unavailable"

                # A later capture that the backend accepts lifts the quarantine.
                gateway.notes.clear()
                await capture(relay, make_items(2, 1024), through_seq=12)
                assert gateway.methods() == [
                    "session.meta.upsert", "timeline.sync", "session.source.updated"]
                assert gateway.notes[-1]["params"]["availability"] == "available"
                assert gateway.complete_flags[-1] is True
                await relay.operation({"kind": "checkpoint.save", "externalSessionId": EXTERNAL,
                                       "checkpoint": {**CHECKPOINT, "throughSeq": 12}})
                assert (await host.sync_state_read(CHECKPOINT_KEY))["throughSeq"] == 12
                await relay.operation(notifications(
                    {"method": "timeline.itemUpsert", "params": {"sessionId": SESSION, "item": make_items(1, 10)[0]}}))
                assert gateway.methods()[-1] == "timeline.itemUpsert"
            finally:
                await relay.close()
    asyncio.run(run())


def test_issue278_incremental_55_mib_pages_pass_gateway_but_are_not_replacements():
    async def run():
        gateway = Gateway()
        items = make_items(11, 5 * MIB)
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway)) as http:
            host, _ = stack(http)
            await host.publish_runtime_notifications("dsh", [{"method": "timeline.sync", "params": {
                "sessionId": SESSION, "externalSessionId": EXTERNAL, "items": items, "complete": False}}])
        assert len(gateway.sizes) > 1 and sum(gateway.sizes) > 50 * MIB
        assert max(gateway.sizes) <= 8 * MIB
        assert set(gateway.statuses) == {200}
        assert gateway.ids == [item["id"] for item in items]
        assert all(flag is False for flag in gateway.complete_flags)
    asyncio.run(run())


def test_issue278_9_mib_snapshot_is_accepted_whole_like_legacy():
    async def run():
        items = make_items(3, 3 * MIB)
        for legacy in (True, False):
            gateway = Gateway()
            async with httpx.AsyncClient(transport=httpx.MockTransport(gateway)) as http:
                host, _ = stack(http, legacy=legacy)
                relay = SyncRelay(Mock(), host)
                try:
                    await capture(relay, items)
                    assert set(gateway.statuses) == {200}
                    assert gateway.complete_flags == [True]
                    assert 8 * MIB < max(gateway.sizes) < 50 * MIB
                    assert not relay.quarantined
                finally:
                    await relay.close()
    asyncio.run(run())


def test_issue278_oversized_snapshot_is_acked_and_feed_reaches_running():
    async def run():
        gateway = Gateway(limit=4096)
        subscribed = asyncio.Event()
        acks = asyncio.Queue()
        acked = []
        subscriptions = 0

        async def request(method, params=None):
            nonlocal subscriptions
            if method == "runtime.sync.subscribe":
                subscriptions += 1
                subscribed.set()
                return {"streamId": f"stream-{subscriptions}", "projectionVersion": 3, "checkpointVersion": 1}
            assert method == "runtime.sync.ack"
            acked.append(params["batchSeq"])
            acks.put_nowait(params["batchSeq"])

        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway)) as http:
            host, health = stack(http, budget=2048)
            previous = {**CHECKPOINT, "throughSeq": 1}
            await host.sync_state_write(CHECKPOINT_KEY, previous)
            client = SimpleNamespace(request=request, writer=Mock(), connected=True)
            relay = SyncRelay(client, host, retry_delay=0.001)
            relay.start()
            try:
                await asyncio.wait_for(subscribed.wait(), 2)
                operations = [
                    op("snapshot.begin", throughSeq=11, meta={"externalSessionId": EXTERNAL}),
                    op("snapshot.items", items=make_items(2, 3000)),
                    op("snapshot.commit", throughSeq=11, totalItems=2),
                    {"kind": "checkpoint.save", "externalSessionId": EXTERNAL, "checkpoint": CHECKPOINT},
                    notifications({"method": "session.inventory.complete",
                                   "params": {"scanToken": "s", "complete": True, "sessions": []}}),
                ]
                for index, operation in enumerate(operations, 1):
                    relay.accept({"streamId": "stream-1", "batchSeq": index, "projectionVersion": 3,
                                  "operations": [operation]})
                    assert await asyncio.wait_for(acks.get(), 2) == index
                assert subscriptions == 1 and acked == [1, 2, 3, 4, 5]
                assert 413 in gateway.statuses
                assert [call.args[1] for call in health.await_args_list] == ["starting", "running"]
                assert await host.sync_state_read(CHECKPOINT_KEY) == previous
                client.writer.close.assert_not_called()
            finally:
                await relay.close()
    asyncio.run(run())


def test_issue278_rejected_snapshot_is_retried_with_a_fresh_capture():
    async def run():
        gateway = RejectingGateway(failures=2)
        refreshes = asyncio.Queue()

        async def request(method, params=None):
            assert method == "runtime.sync.refresh"
            refreshes.put_nowait(params)

        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway)) as http:
            host, _ = stack(http)
            relay = SyncRelay(SimpleNamespace(request=request), host, rejected_retry_delay=0.01)
            items = make_items(3, 1024)
            try:
                for attempt in (1, 2):
                    await capture(relay, items)
                    assert gateway.notes[-1]["method"] == "session.source.updated"
                    assert gateway.notes[-1]["params"]["reason"] == "history_rejected"
                    unavailable_at = gateway.notes[-1]["params"]["observedAt"]
                    assert relay.quarantined[SESSION].attempts == attempt
                    params = await asyncio.wait_for(refreshes.get(), 2)
                    assert params == {"sessionId": SESSION, "externalSessionId": EXTERNAL}

                # The Host answers with a new capture of the same history; it
                # is uploaded again, not skipped like an oversized one.
                gateway.notes.clear()
                await capture(relay, items)
                assert gateway.methods() == [
                    "session.meta.upsert", "timeline.sync", "session.source.updated"]
                assert gateway.complete_flags == [True]
                assert not relay.quarantined
                # The capture's own source fact may predate the unavailable
                # one; the recovery is restated as of now so the Server keeps it.
                restated = gateway.notes[-1]["params"]
                assert restated["availability"] == "available"
                assert restated["observedAt"] > unavailable_at
                await relay.operation({"kind": "checkpoint.save", "externalSessionId": EXTERNAL,
                                       "checkpoint": CHECKPOINT})
                assert await host.sync_state_read(CHECKPOINT_KEY) == CHECKPOINT
                await asyncio.sleep(0.05)
                assert refreshes.empty()
            finally:
                await relay.close()
    asyncio.run(run())


def test_issue278_recovery_does_not_restate_over_a_newer_host_fact():
    async def run():
        gateway = RejectingGateway(failures=1)

        async def request(method, params=None):
            return None

        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway)) as http:
            host, _ = stack(http)
            relay = SyncRelay(SimpleNamespace(request=request), host, rejected_retry_delay=60)
            items = make_items(2, 1024)
            try:
                await capture(relay, items)
                assert SESSION in relay.quarantined
                # The user archives the session while its history is held back.
                await relay.operation(notifications({"method": "session.source.updated", "params": {
                    "sessionId": SESSION, "externalSessionId": EXTERNAL,
                    "availability": "archived", "observedAt": "2099-01-01T00:00:00.000Z"}}))
                gateway.notes.clear()
                await capture(relay, items)
                assert gateway.methods() == ["session.meta.upsert", "timeline.sync"]
                assert not relay.quarantined
            finally:
                await relay.close()
    asyncio.run(run())


def test_issue278_state_reads_and_host_metadata_keep_a_quarantined_session_unavailable(tmp_path):
    async def run():
        gateway = Gateway(limit=64 * 1024)
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway)) as http:
            host, _ = stack(http, budget=16 * 1024)
            relay = SyncRelay(Mock(), host)
            try:
                await capture(relay, make_items(4, 30 * 1024))
                quarantined = gateway.notes[-1]["params"]
                assert quarantined["reason"] == "history_too_large"

                # Opening the session reads a fresh native source fact. It must
                # not report the session usable while its history is held back.
                runtime = DshRuntime(SimpleNamespace(values={"dshHome": str(tmp_path)}), host)
                runtime._sync = relay
                runtime._request = AsyncMock(return_value={
                    "runtime": "dsh", "sessionId": SESSION, "externalSessionId": EXTERNAL,
                    "status": "idle", "selections": {},
                    "sourceState": {"availability": "available", "observedAt": "2026-10-10T00:00:00.000Z"}})
                gateway.notes.clear()
                await runtime.get_session_state(SESSION, EXTERNAL)
                (note,) = gateway.notes
                assert note["method"] == "session.source.updated"
                assert (note["params"]["availability"], note["params"]["reason"]) == ("unavailable", "history_too_large")
                assert note["params"]["observedAt"] >= quarantined["observedAt"]

                gateway.notes.clear()
                await relay.operation(notifications({"method": "session.meta.upsert", "params": {
                    "sessionId": SESSION, "externalSessionId": EXTERNAL, "title": "synthetic",
                    "sourceState": {"availability": "available"}}}))
                assert gateway.notes[0]["params"]["sourceState"]["availability"] == "unavailable"

                # An archived fact is still reported as is.
                runtime._request.return_value["sourceState"] = {"availability": "archived"}
                gateway.notes.clear()
                await runtime.get_session_state(SESSION, EXTERNAL)
                assert gateway.notes[0]["params"]["availability"] == "archived"
            finally:
                await relay.close()
    asyncio.run(run())
