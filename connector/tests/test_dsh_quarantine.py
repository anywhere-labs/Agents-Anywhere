from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from connector.runtime_protocol import timeline_content_hash
from connector.server.errors import ConnectorNetworkError
from connector.server.ingest import ConnectorIngestRejectedError
from tests.dsh_sync_helpers import add_page, begin_snapshot, ingest, ready_relay


def item(item_id="one", session_id="session"):
    content = {"text": "hello", "format": "markdown"}
    return {"id": item_id, "sessionId": session_id, "type": "message", "role": "assistant",
            "status": "done", "orderSeq": 1, "revision": 1, "content": content,
            "source": {"runtime": "dsh"},
            "contentHash": timeline_content_hash("message", "done", "assistant", content)}


def checkpoint(through_seq=12):
    return {"version": 1, "projectionVersion": 3, "throughSeq": through_seq, "historyHash": "a" * 64, "settled": True}


def http_error(status: int) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "http://server/api/v2/connector/ingest")
    return httpx.HTTPStatusError(f"HTTP {status}", request=request, response=httpx.Response(status, request=request))


class Harness:
    def __init__(self, *, failure: Exception | None):
        self.failure = failure
        self.requests: list[tuple[str, dict | None]] = []
        self.snapshots: list[str] = []
        self.receiver = SimpleNamespace(
            connector_id="test",
            publish_runtime_notifications=AsyncMock(),
            sync_state_write=AsyncMock(),
            runtime_health_update=AsyncMock(),
            timeline_item_upsert=AsyncMock(),
            session_source_update=AsyncMock(),
        )
        self.receiver.publish_runtime_snapshot = self.snapshot
        self.relay = ready_relay(self.receiver)
        self.relay.quarantine_retry_delay = 0.01
        self.relay.quarantine_too_large_retry_delay = 0.02
        self.relay.client.request = self._request

    async def _request(self, method, params=None):
        self.requests.append((method, params))
        return {"ok": True}

    async def snapshot(self, runtime, session_id, meta, items, **kwargs):
        list(items)
        if self.failure is not None:
            raise self.failure
        self.snapshots.append(session_id)

    async def capture(self, through_seq=12):
        meta = {"externalSessionId": "native", "sourceState": {"availability": "available"}}
        await begin_snapshot(self.relay, session_id="session", meta=meta, through_seq=through_seq)
        await add_page(self.relay, [item()])
        return await self.relay.commit_snapshot()

    def published(self) -> list[dict]:
        return [n for call in self.receiver.publish_runtime_notifications.await_args_list for n in call.args[1]]


def test_a_refused_snapshot_quarantines_only_that_session_and_recovers_on_a_fresh_capture():
    async def exercise():
        harness = Harness(failure=http_error(413))
        relay, receiver = harness.relay, harness.receiver
        try:
            result = await harness.capture()  # acknowledged: returning, so the feed moves on
            assert result.accepted is False and result.quarantined is True
            assert result.reason == "history_too_large"
            record = relay.quarantined["session"]
            assert record.reason == "history_too_large" and record.attempts == 1
            source = harness.published()[-1]
            assert source["method"] == "session.source.updated"
            assert source["params"]["availability"] == "unavailable" and source["params"]["reason"] == "history_too_large"
            assert source["params"]["externalSessionId"] == "native"

            # The plugin believes its capture landed; its checkpoint must not be saved. Others still are.
            await relay.save_checkpoint("native", checkpoint())
            receiver.sync_state_write.assert_not_awaited()
            await relay.save_checkpoint("other-native", checkpoint())
            receiver.sync_state_write.assert_awaited_once()

            # Live history for the quarantined session is withheld, other sessions flow, the
            # inventory reports it unavailable and the runtime still becomes healthy.
            receiver.publish_runtime_notifications.reset_mock()
            await ingest(relay, {"kind": "notifications", "notifications": [
                {"method": "timeline.itemUpsert", "params": {"sessionId": "session", "item": item()}},
                {"method": "timeline.itemUpsert", "params": {"sessionId": "other", "item": item("x", "other")}},
                {"method": "session.source.updated", "params": {"sessionId": "session", "externalSessionId": "native", "availability": "available"}},
                {"method": "session.meta.upsert", "params": {"sessionId": "session", "externalSessionId": "native", "sourceState": {"availability": "available"}}},
                {"method": "session.inventory.complete", "params": {"complete": True, "sessions": [
                    {"sessionId": "session", "sourceState": {"availability": "available"}}, {"sessionId": "other"}]}},
            ]})
            delivered = harness.published()
            assert [n["method"] for n in delivered] == ["timeline.itemUpsert", "session.meta.upsert", "session.inventory.complete"]
            assert delivered[0]["params"]["sessionId"] == "other"
            assert delivered[1]["params"]["sourceState"]["availability"] == "unavailable"
            sessions = delivered[2]["params"]["sessions"]
            assert sessions[0]["sourceState"]["reason"] == "history_too_large" and "sourceState" not in sessions[1]
            assert record.stale is True
            receiver.runtime_health_update.assert_awaited_with("running")

            # A fresh capture is requested after the (shortened) delay.
            for _ in range(100):
                if harness.requests:
                    break
                await asyncio.sleep(0.01)
            assert harness.requests == [("refreshSync", {"sessionId": "session", "externalSessionId": "native"})]

            # The next accepted capture releases the quarantine and restates availability.
            harness.failure = None
            receiver.publish_runtime_notifications.reset_mock()
            result = await harness.capture(through_seq=20)
            assert result.accepted is True and result.quarantined is False
            assert relay.quarantined == {} and harness.snapshots == ["session"]
            restated = harness.published()[-1]
            assert restated["method"] == "session.source.updated" and restated["params"]["availability"] == "available"
            await relay.save_checkpoint("native", checkpoint(20))
            assert receiver.sync_state_write.await_count == 2
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_a_rejected_notification_is_quarantined_with_its_own_reason_and_counts_attempts():
    async def exercise():
        harness = Harness(failure=ConnectorIngestRejectedError("backend ingest rejected 1 notification(s)"))
        relay = harness.relay
        try:
            result = await harness.capture()
            assert result.accepted is False and result.quarantined is True
            assert result.reason == "history_rejected"
            assert relay.quarantined["session"].reason == "history_rejected"
            await harness.capture()
            assert relay.quarantined["session"].attempts == 2
            assert harness.published()[-1]["params"]["reason"] == "history_rejected"
        finally:
            await relay.close()
    asyncio.run(exercise())


@pytest.mark.parametrize("failure", [ConnectorNetworkError("backend down"), http_error(503)])
def test_transient_failures_still_fail_the_subscription_instead_of_quarantining(failure):
    async def exercise():
        harness = Harness(failure=failure)
        relay = harness.relay
        try:
            with pytest.raises(type(failure)):
                await harness.capture()
            assert relay.quarantined == {}
            assert all(n["method"] != "session.source.updated" for n in harness.published())
        finally:
            await relay.close()
    asyncio.run(exercise())
