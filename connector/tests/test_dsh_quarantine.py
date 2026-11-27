from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from connector.runtime_protocol import timeline_content_hash
from connector.runtimes.dsh.bridge.host import SubscriptionRegistry
from connector.runtimes.dsh.bridge.sync import SyncRelay
from connector.server.errors import ConnectorNetworkError
from connector.server.ingest import (
    ConnectorIngestDeferredError,
    ConnectorIngestRejectedError,
)
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
        self.uploads = 0
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
        assert kwargs.get("ordered") is False, "the relay orders its own deliveries"
        list(items)
        self.uploads += 1
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
        relay.quarantine_retry_delay = 60
        try:
            result = await harness.capture()
            assert result.accepted is False and result.quarantined is True
            assert result.reason == "history_rejected"
            assert relay.quarantined["session"].reason == "history_rejected"
            assert harness.uploads == 1

            # The plugin captures an unpublished session again on its next change.
            # Before the retry is due that capture is answered without an upload.
            result = await harness.capture()
            assert result.accepted is False and result.quarantined is True and result.reason == "history_rejected"
            assert harness.uploads == 1 and relay.quarantined["session"].attempts == 1

            # Once due, the capture is uploaded; another refusal counts and backs off further.
            relay.quarantined["session"].retry_at = 0
            await harness.capture()
            assert harness.uploads == 2 and relay.quarantined["session"].attempts == 2
            loop = asyncio.get_running_loop()
            assert relay.quarantined["session"].retry_at - loop.time() > 100, "the second refusal waits twice as long"
            assert harness.published()[-1]["params"]["reason"] == "history_rejected"
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_a_withheld_capture_neither_stages_nor_checks_its_pages():
    async def exercise():
        harness = Harness(failure=http_error(413))
        relay = harness.relay
        relay.quarantine_too_large_retry_delay = 60
        try:
            await harness.capture()
            await begin_snapshot(relay, session_id="session", meta={"externalSessionId": "native"}, through_seq=13)
            await add_page(relay, [item(), item()])  # a duplicate would fail a staged capture
            assert relay.items == [] and relay.item_ids == set() and relay.file is None
            result = await relay.commit_snapshot()
            assert result.accepted is False and result.reason == "history_too_large"
            assert harness.uploads == 1

            # Other sessions are captured and uploaded as usual meanwhile.
            harness.failure = None
            await begin_snapshot(relay, session_id="other", meta={"externalSessionId": "other-native"})
            await add_page(relay, [item("x", "other")])
            assert (await relay.commit_snapshot()).accepted is True
            assert harness.snapshots == ["other"]
        finally:
            await relay.close()
    asyncio.run(exercise())


class Bridge:
    """The plugin end of a relay: one confirmed sync stream and a request log."""

    def __init__(self) -> None:
        self.host = SimpleNamespace(registry=SubscriptionRegistry())
        self.connected = True
        self.requests: list[tuple[str, dict | None]] = []

    async def stream(self, method, params=None):
        yield {"kind": "subscribed", "projectionVersion": 3, "checkpointVersion": 1}
        await asyncio.Event().wait()

    async def request(self, method, params=None):
        self.requests.append((method, params))
        return {"accepted": True}


def test_a_rebuilt_relay_keeps_the_quarantine_and_its_retry_schedule():
    async def exercise():
        harness = Harness(failure=ConnectorIngestRejectedError("backend ingest rejected 1 notification(s)"))
        bridge = Bridge()
        shared: dict = {}
        first = SyncRelay(bridge, harness.receiver, quarantined=shared, quarantine_retry_delay=0.3)
        first.start()
        second = None
        try:
            await asyncio.wait_for(first.confirmed.wait(), 1)
            harness.relay = first
            assert (await harness.capture()).quarantined is True
            # A backend reconnect or a crash replaces the relay before the retry is due.
            await first.close()
            second = SyncRelay(bridge, harness.receiver, quarantined=shared)
            second.start()
            await asyncio.wait_for(second.confirmed.wait(), 1)
            harness.relay = second
            assert (await harness.capture()).quarantined is True
            assert harness.uploads == 1, "the new relay does not upload the refused session again at once"
            for _ in range(200):
                if bridge.requests:
                    break
                await asyncio.sleep(0.01)
            assert bridge.requests == [("refreshSync", {"sessionId": "session", "externalSessionId": "native"})]
            harness.failure = None
            assert (await harness.capture()).accepted is True
            assert shared == {} and harness.uploads == 2
        finally:
            await first.close()
            if second is not None:
                await second.close()
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


def test_a_deferred_snapshot_is_quarantined_until_the_wait_is_over():
    async def exercise():
        harness = Harness(failure=ConnectorIngestDeferredError(600.0))
        relay, receiver = harness.relay, harness.receiver
        try:
            result = await harness.capture()  # acknowledged: returning, so the feed moves on
            assert result.accepted is False and result.quarantined is True
            assert result.reason == "history_deferred"
            record = relay.quarantined["session"]
            assert record.reason == "history_deferred" and record.attempts == 1
            remaining = record.retry_at - asyncio.get_running_loop().time()
            assert 595 < remaining <= 600, "a fresh capture is asked for when the wait is over"
            source = harness.published()[-1]
            assert source["method"] == "session.source.updated"
            assert source["params"]["availability"] == "unavailable" and source["params"]["reason"] == "history_deferred"
            await relay.save_checkpoint("native", checkpoint())
            receiver.sync_state_write.assert_not_awaited()

            # A capture the plugin makes before then is acknowledged without being uploaded...
            record.retry_at = asyncio.get_running_loop().time() + 60
            result = await harness.capture()
            assert result.accepted is False and result.quarantined is True
            assert harness.uploads == 1 and harness.requests == []

            # ...and once it is over, one fresh capture is asked for.
            record.retry_at = asyncio.get_running_loop().time()
            for _ in range(100):
                if harness.requests:
                    break
                await asyncio.sleep(0.01)
            assert harness.requests == [("refreshSync", {"sessionId": "session", "externalSessionId": "native"})]
            harness.failure = None
            result = await harness.capture(through_seq=20)
            assert result.accepted is True and relay.quarantined == {}
            assert harness.published()[-1]["params"]["availability"] == "available"
            await relay.save_checkpoint("native", checkpoint(20))
            receiver.sync_state_write.assert_awaited_once()
        finally:
            await relay.close()
    asyncio.run(exercise())


class PluginFeed:
    """The plugin's sync feed as its SyncService runs it: the inventory, then the baseline of a session without a checkpoint."""

    def __init__(self) -> None:
        self.subscribes = self.captures = self.failures = self.quarantined = self.refreshes = 0
        self.ended: asyncio.Event | None = None
        self.relay: SyncRelay | None = None
        self.client = SimpleNamespace(
            host=SimpleNamespace(registry=SubscriptionRegistry()), connected=True,
            stream=self.stream, request=self.request,
        )

    async def stream(self, method, params):
        assert method == "sync"
        self.subscribes += 1
        self.ended = asyncio.Event()
        yield {"kind": "subscribed", "projectionVersion": 3, "checkpointVersion": 1}
        baseline = asyncio.ensure_future(self.baseline())
        try:
            await self.ended.wait()  # the stream lives as long as the plugin's feed does
        finally:
            baseline.cancel()

    async def request(self, method, params):
        assert method == "refreshSync"
        self.refreshes += 1
        await self.baseline()

    async def baseline(self):
        meta = {"externalSessionId": "native", "sourceState": {"availability": "available"}}
        try:
            await ingest(self.relay, {"kind": "notifications", "notifications": [
                {"method": "session.inventory.begin", "params": {"scanToken": "scan"}},
            ]})
            await begin_snapshot(self.relay, session_id="session", meta=meta, through_seq=12)
            await add_page(self.relay, [item()])
            self.captures += 1
            result = await self.relay.commit_snapshot()
        except Exception:  # noqa: BLE001 - the plugin's delivery(): any error fails the whole feed
            self.failures += 1
            self.ended.set()
            return
        self.quarantined += result.accepted is False


def test_a_deferred_baseline_keeps_the_feed_instead_of_failing_every_resubscribe():
    async def exercise():
        harness = Harness(failure=ConnectorIngestDeferredError(600.0))
        feed = PluginFeed()
        # The production delay is one second; a fraction of it shows a resubscribe loop without a long test.
        relay = SyncRelay(feed.client, harness.receiver, retry_delay=0.01)
        feed.relay = relay
        running = asyncio.ensure_future(relay.run())
        try:
            await asyncio.sleep(0.3)
            assert (feed.subscribes, feed.captures, feed.failures) == (1, 1, 0), "one feed, one capture, nothing failed"
            assert feed.quarantined == 1 and relay.quarantined["session"].reason == "history_deferred"
            assert harness.uploads == 1, "the stalled path saw one upload attempt in that time"

            # The wait is over: the relay asks for one fresh capture, which now gets through.
            harness.failure = None
            # The retry task went to sleep for the whole wait when it was scheduled: ask again now that it is over.
            relay.quarantined["session"].retry_at = asyncio.get_running_loop().time()
            relay._schedule_retry("session", relay.quarantined["session"])
            for _ in range(300):
                if not relay.quarantined:
                    break
                await asyncio.sleep(0.01)
            assert relay.quarantined == {} and feed.refreshes == 1 and feed.captures == 2
            assert feed.subscribes == 1 and feed.failures == 0, "the same feed carried the retry"
        finally:
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)
            await relay.close()
            await harness.relay.close()
    asyncio.run(exercise())


def test_a_deferred_session_is_taken_again_as_soon_as_the_wait_ends_early():
    async def exercise():
        wait = [600.0]
        harness = Harness(failure=ConnectorIngestDeferredError(600.0))
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        try:
            assert (await harness.capture()).accepted is False
            # The client's wait ends early: an upload it had admitted before the stall got through.
            wait[0] = 0.0
            harness.failure = None
            for _ in range(300):
                if harness.requests:
                    break
                await asyncio.sleep(0.01)
            assert len(harness.requests) == 1, "asked for once the wait is over, not at retry_at"
            result = await harness.capture(through_seq=20)
            assert result.accepted is True and relay.quarantined == {}
            assert harness.uploads == 2 and harness.snapshots == ["session"], "the capture was not withheld"
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_the_retry_of_a_deferred_session_waits_for_a_wait_that_grew():
    async def exercise():
        wait = [30.0]
        harness = Harness(failure=ConnectorIngestDeferredError(0.0))  # due at once by retry_at
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        try:
            assert (await harness.capture()).accepted is False
            assert relay.quarantined["session"].retry_at <= asyncio.get_running_loop().time()
            await asyncio.sleep(0.05)
            assert harness.requests == [], "retry_at is due, but the client still waits: nothing is asked"
            wait[0] = 0.0
            for _ in range(300):
                if harness.requests:
                    break
                await asyncio.sleep(0.01)
            assert len(harness.requests) == 1
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_without_the_clients_say_so_a_deferral_lasts_until_retry_at():
    async def exercise():
        harness = Harness(failure=ConnectorIngestDeferredError(600.0))
        relay = harness.relay
        try:
            assert (await harness.capture()).accepted is False
            harness.failure = None
            result = await harness.capture(through_seq=20)
            assert result.accepted is False and harness.uploads == 1, "still withheld: the relay knows no better"
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_a_deferred_session_whose_refresh_keeps_failing_is_asked_again_only_after_the_backoff():
    async def exercise():
        wait = [30.0]
        harness = Harness(failure=ConnectorIngestDeferredError(0.0))  # due at once by retry_at
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        relay.quarantine_retry_delay = 0.5
        calls = 0

        async def not_answering(method, params=None):
            nonlocal calls
            calls += 1
            raise RuntimeError("the plugin is not answering")

        relay.client.request = not_answering
        try:
            assert (await harness.capture()).accepted is False
            wait[0] = 0.0  # the wait is over: asked at once
            for _ in range(300):
                if calls:
                    break
                await asyncio.sleep(0.01)
            assert calls == 1
            # The plugin keeps failing and no wait is on: the backoff of the failed request holds.
            await asyncio.sleep(0.3)
            assert calls == 1, f"asked {calls} times in 0.3 s after a failed request: the backoff must hold"
            for _ in range(300):
                if calls >= 2:
                    break
                await asyncio.sleep(0.01)
            assert calls == 2
            # A wait that begins during the next backoff holds the request until it is over.
            wait[0] = 30.0
            await asyncio.sleep(1.0)
            assert calls == 2
            wait[0] = 0.0
            for _ in range(300):
                if calls >= 3:
                    break
                await asyncio.sleep(0.01)
            assert calls == 3
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_a_capture_dropped_because_a_new_wait_began_after_the_refresh_was_answered_is_asked_for_again():
    async def exercise():
        wait = [600.0]
        harness = Harness(failure=ConnectorIngestDeferredError(600.0))
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        try:
            assert (await harness.capture()).accepted is False
            wait[0] = 0.0  # the client's wait ends early
            harness.failure = None
            for _ in range(300):
                if harness.requests:
                    break
                await asyncio.sleep(0.01)
            assert len(harness.requests) == 1
            # The plugin answers a refresh at once and captures after it does; a new wait begins
            # in between. The capture is dropped, and the retry that asked for it has answered.
            wait[0] = 600.0
            result = await harness.capture(through_seq=20)
            assert result.accepted is False and harness.uploads == 1, "withheld: the client takes no snapshot"
            await asyncio.sleep(0.05)
            assert len(harness.requests) == 1, "the new wait is on: nothing is asked"
            wait[0] = 0.0
            for _ in range(300):
                if len(harness.requests) >= 2:
                    break
                await asyncio.sleep(0.01)
            assert len(harness.requests) == 2, "the dropped capture is asked for again once the new wait is over"
            result = await harness.capture(through_seq=20)
            assert result.accepted is True and relay.quarantined == {}
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_a_capture_dropped_because_a_new_wait_began_before_the_refresh_was_answered_is_asked_for_again():
    async def exercise():
        wait = [600.0]
        harness = Harness(failure=ConnectorIngestDeferredError(600.0))
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        held = asyncio.Event()
        refreshes = 0

        async def capturing_before_the_answer(method, params=None):
            nonlocal refreshes
            refreshes += 1
            harness.requests.append((method, params))
            if refreshes == 1:
                # This plugin captures before it answers; meanwhile a new wait began.
                wait[0] = 600.0
                result = await harness.capture(through_seq=20)
                assert result.accepted is False and harness.uploads == 1, "withheld: the client takes no snapshot"
                held.set()
            return {"ok": True}

        relay.client.request = capturing_before_the_answer
        try:
            assert (await harness.capture()).accepted is False
            wait[0] = 0.0  # the client's wait ends early
            harness.failure = None
            await asyncio.wait_for(held.wait(), 5)
            await asyncio.sleep(0.05)
            assert len(harness.requests) == 1, "the new wait is on: nothing is asked"
            wait[0] = 0.0
            for _ in range(300):
                if len(harness.requests) >= 2:
                    break
                await asyncio.sleep(0.01)
            assert len(harness.requests) == 2, "the retry that asked does not give up on an answered request"
            result = await harness.capture(through_seq=20)
            assert result.accepted is True and relay.quarantined == {}
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_a_withheld_capture_the_plugin_gives_up_is_asked_for_again():
    async def exercise():
        wait = [600.0]
        harness = Harness(failure=ConnectorIngestDeferredError(600.0))
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        meta = {"externalSessionId": "native", "sourceState": {"availability": "available"}}
        try:
            assert (await harness.capture()).accepted is False
            wait[0] = 0.0  # the client's wait ends early
            harness.failure = None
            for _ in range(300):
                if harness.requests:
                    break
                await asyncio.sleep(0.01)
            assert len(harness.requests) == 1
            # A new wait begins and the plugin's capture is withheld; the plugin gives that
            # capture up (its read failed): aborted, not committed.
            wait[0] = 600.0
            await begin_snapshot(relay, session_id="session", meta=meta, through_seq=20)
            await relay.abort_snapshot()
            await asyncio.sleep(0.05)
            assert len(harness.requests) == 1, "the new wait is on: nothing is asked"
            wait[0] = 0.0
            for _ in range(300):
                if len(harness.requests) >= 2:
                    break
                await asyncio.sleep(0.01)
            assert len(harness.requests) == 2, "a withheld capture that was aborted is asked for again too"
            result = await harness.capture(through_seq=20)
            assert result.accepted is True and relay.quarantined == {}
            await asyncio.sleep(0.05)
            assert relay.retry_owners == {}, "nothing is left speaking for a released session"
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_after_a_failed_refresh_the_next_ask_does_not_sleep_the_backoff_of_that_failure():
    async def exercise():
        wait = [30.0]
        harness = Harness(failure=ConnectorIngestDeferredError(0.0))  # due at once by retry_at
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        relay.quarantine_retry_delay = 0.5
        asks: list[float] = []

        async def answering(method, params=None):
            asks.append(asyncio.get_running_loop().time())
            if len(asks) == 1:
                raise RuntimeError("the plugin is not answering")
            if len(asks) == 2:
                wait[0] = 30.0  # a wait began before this answer
            return {"ok": True}

        relay.client.request = answering
        try:
            assert (await harness.capture()).accepted is False
            wait[0] = 0.0
            for _ in range(300):
                if len(asks) >= 2:
                    break
                await asyncio.sleep(0.01)
            assert len(asks) == 2 and asks[1] - asks[0] >= 0.4, "a failed ask keeps its backoff"
            await asyncio.sleep(0.05)
            assert len(asks) == 2, "a wait is on after the answer: nothing is asked"
            # The wait is over: asked at once, not after the backoff of the failed ask.
            over = asyncio.get_running_loop().time()
            wait[0] = 0.0
            for _ in range(300):
                if len(asks) >= 3:
                    break
                await asyncio.sleep(0.01)
            assert len(asks) == 3 and asks[2] - over < 0.3, f"the third ask came {asks[2] - over if len(asks) > 2 else -1:.2f} s after the wait was over"
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_an_abort_that_arrives_while_the_relay_is_closing_schedules_nothing():
    async def exercise():
        wait = [600.0]
        harness = Harness(failure=ConnectorIngestDeferredError(600.0))
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        meta = {"externalSessionId": "native", "sourceState": {"availability": "available"}}
        try:
            assert (await harness.capture()).accepted is False
            relay.retry_owners.clear()  # its retry has answered, as after a wait that ended early
            relay._closing = True
            await begin_snapshot(relay, session_id="session", meta=meta, through_seq=20)
            await relay.abort_snapshot()
            assert relay.retry_owners == {}, "a closing relay schedules no retry"
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_an_abort_that_arrives_while_a_retry_is_still_to_ask_does_not_make_a_second_one():
    async def exercise():
        wait = [600.0]
        harness = Harness(failure=ConnectorIngestDeferredError(600.0))
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        meta = {"externalSessionId": "native", "sourceState": {"availability": "available"}}
        try:
            assert (await harness.capture()).accepted is False
            # The retry of that refusal is polling the wait; the plugin gives a withheld capture up.
            await begin_snapshot(relay, session_id="session", meta=meta, through_seq=20)
            await relay.abort_snapshot()
            await asyncio.sleep(0.05)
            assert len(relay.retry_tasks) == 1, "no second retry is made while one is still to ask"
            assert relay.retry_owners == {"session": next(iter(relay.retry_tasks))}
            wait[0] = 0.0
            for _ in range(300):
                if harness.requests:
                    break
                await asyncio.sleep(0.01)
            await asyncio.sleep(0.1)
            assert len(harness.requests) == 1, "the retry that was already there asks once"
            assert relay.retry_owners == {}
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_a_retry_that_ends_after_its_record_was_replaced_does_not_take_the_newer_one_s_place():
    async def exercise():
        wait = [600.0]
        harness = Harness(failure=ConnectorIngestDeferredError(0.2))
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        try:
            assert (await harness.capture()).accepted is False
            await asyncio.sleep(0.3)  # past the first retry_at; the wait keeps that retry from asking
            assert (await harness.capture()).accepted is False
            assert relay.quarantined["session"].attempts == 2, "a newer refusal replaced the record"
            for _ in range(300):  # the first retry has seen that its record is gone, and is discarded
                if len(relay.retry_tasks) == 1:
                    break
                await asyncio.sleep(0.01)
            assert len(relay.retry_tasks) == 1
            assert relay.retry_owners == {"session": next(iter(relay.retry_tasks))}, "the newer retry keeps its place"
            assert relay._retry_pending("session") is True
        finally:
            await relay.close()
    asyncio.run(exercise())


async def _elapse(relay: SyncRelay, session_id: str = "session") -> None:
    """Let the backoff of the session's record run out.

    The retry the refusal scheduled went to sleep for the whole backoff, and it runs
    first (nothing in the harness yields before this), so the record's time alone
    does not wake it. The retry is scheduled again, as for a wait that ended early
    or a relay that was rebuilt; the one still asleep outlives the test."""
    record = relay.quarantined[session_id]
    await asyncio.sleep(0)
    record.retry_at = asyncio.get_running_loop().time()
    relay._schedule_retry(session_id, record)


async def _until(over) -> None:
    for _ in range(300):
        if over():
            return
        await asyncio.sleep(0.01)


def _own_stall(retry_in: float = 60.0) -> ConnectorIngestDeferredError:
    """What the ingest client raises for the upload whose own page stalled."""
    return ConnectorIngestDeferredError(retry_in, stalled=True)


def test_a_session_whose_own_page_stalled_waits_its_own_backoff_not_the_clients_cool_down():
    from connector.runtimes.dsh.bridge import sync as relay_module

    async def exercise():
        wait = [60.0]
        lines: list[str] = []
        sink = relay_module.logger.add(lines.append, level="WARNING")
        harness = Harness(failure=_own_stall())
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        try:
            assert (await harness.capture()).accepted is False
            record = relay.quarantined["session"]
            assert record.reason == "history_deferred" and record.stalled is True and record.attempts == 1
            assert record.stalls == 1
            remaining = record.retry_at - asyncio.get_running_loop().time()
            assert 595 < remaining <= 600, "ten minutes of its own, not the minute the client's cool-down takes"
            (own,) = [line for line in lines if "DSH session history deferred: its upload stalled; session quarantined" in line]
            # One wait in the line: the session's backoff. (The error at its end repeats the client's.)
            assert "attempts=1 stalls=1 backoff=600s" in own and "retry_in=" not in own, lines
            assert "the path cannot carry it now" not in own and own.rstrip().endswith(str(_own_stall())), lines
            source = harness.published()[-1]
            assert source["method"] == "session.source.updated" and source["params"]["reason"] == "history_deferred"

            # The client's cool-down ends a minute in and the path takes snapshots again: nothing is asked...
            wait[0] = 0.0
            harness.failure = None
            await asyncio.sleep(0.05)
            assert harness.requests == [], "the client's wait ending does not shorten the session's backoff"
            # ...and a capture the plugin makes on its own is withheld for as long.
            result = await harness.capture(through_seq=20)
            assert result.accepted is False and result.quarantined is True and harness.uploads == 1

            # Ten minutes on: asked for once, and that capture lands.
            await _elapse(relay)
            await _until(lambda: harness.requests)
            assert harness.requests == [("refreshSync", {"sessionId": "session", "externalSessionId": "native"})]
            result = await harness.capture(through_seq=20)
            assert result.accepted is True and relay.quarantined == {}
            assert harness.uploads == 2 and harness.snapshots == ["session"], "the capture was not withheld"
        finally:
            relay_module.logger.remove(sink)
            await relay.close()
    asyncio.run(exercise())


def test_each_further_stall_of_the_same_session_doubles_its_backoff_up_to_an_hour():
    async def exercise():
        harness = Harness(failure=_own_stall())
        relay = harness.relay
        relay.snapshot_wait = lambda: 0.0   # the client takes snapshots: only the session's own backoff holds it
        try:
            for attempts, backoff in enumerate((600, 1200, 2400, 3600, 3600), start=1):
                assert (await harness.capture(through_seq=12 + attempts)).accepted is False
                record = relay.quarantined["session"]
                assert record.attempts == attempts and record.stalled is True
                assert record.stalls == attempts
                remaining = record.retry_at - asyncio.get_running_loop().time()
                assert backoff - 1 < remaining <= backoff, f"stall {attempts}: {backoff}s due, {remaining:.0f}s recorded"
                # The backoff runs out and the retry asks; the plugin's fresh capture stalls again.
                await _elapse(relay)
                await _until(lambda asked=attempts: len(harness.requests) >= asked)
            assert harness.requests == [("refreshSync", {"sessionId": "session", "externalSessionId": "native"})] * 5
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_a_session_that_stalled_for_weeks_waits_the_cap_and_not_an_overflow():
    """2 ** (stalls - 1) with stalls in the thousands does not fit a float: the cap is reached
    long before, and the exponent is bounded."""

    async def exercise():
        harness = Harness(failure=_own_stall())
        relay = harness.relay
        relay.snapshot_wait = lambda: 0.0
        try:
            assert (await harness.capture(through_seq=12)).accepted is False
            record = relay.quarantined["session"]
            record.stalls, record.retry_at = 5000, 0.0   # weeks of stalls; its backoff ran out
            assert (await harness.capture(through_seq=13)).accepted is False
            record = relay.quarantined["session"]
            assert record.stalls == 5001
            remaining = record.retry_at - asyncio.get_running_loop().time()
            assert 3599 < remaining <= 3600, f"the cap, not an overflow: {remaining:.0f}s"
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_a_session_deferred_by_another_sessions_stall_waits_only_for_the_clients_cool_down_as_before():
    from connector.runtimes.dsh.bridge import sync as relay_module

    async def exercise():
        wait = [60.0]
        lines: list[str] = []
        sink = relay_module.logger.add(lines.append, level="WARNING")
        harness = Harness(failure=ConnectorIngestDeferredError(60.0))
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        try:
            assert (await harness.capture()).accepted is False
            record = relay.quarantined["session"]
            assert record.reason == "history_deferred" and record.stalled is False and record.attempts == 1
            remaining = record.retry_at - asyncio.get_running_loop().time()
            assert 59 < remaining <= 60, "as long as the client says, as before"
            (other,) = [line for line in lines if "DSH session history deferred: the path cannot carry it now; session quarantined until the wait is over" in line]
            assert "attempts=1 retry_in=60s" in other and "its upload stalled" not in other, lines
            # The client's cool-down ends early: asked at once, as before.
            wait[0] = 0.0
            harness.failure = None
            await _until(lambda: harness.requests)
            assert len(harness.requests) == 1
            result = await harness.capture(through_seq=20)
            assert result.accepted is True and relay.quarantined == {}
        finally:
            relay_module.logger.remove(sink)
            await relay.close()
    asyncio.run(exercise())


def test_refused_unsent_behind_another_sessions_stall_then_stalling_itself_waits_ten_minutes():
    """Only the session's own stalls grow its backoff. Counted as one, a first own stall that
    followed one or three refusals unsent waited 20 or 60 minutes, just when several big
    sessions share a weak path."""
    async def exercise():
        wait = [60.0]
        harness = Harness(failure=ConnectorIngestDeferredError(60.0))
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        try:
            # Another session's page stalled and the client is cooling down: refused unsent.
            assert (await harness.capture()).accepted is False
            refused = relay.quarantined["session"]
            assert refused.stalled is False and refused.attempts == 1 and refused.stalls == 0
            wait[0] = 0.0
            await _until(lambda: harness.requests)
            # The plugin's fresh capture stalls: the session's first own stall.
            harness.failure = _own_stall()
            assert (await harness.capture(through_seq=20)).accepted is False
            record = relay.quarantined["session"]
            assert record.stalled is True and record.attempts == 2 and record.stalls == 1
            remaining = record.retry_at - asyncio.get_running_loop().time()
            assert 595 < remaining <= 600, "ten minutes for a first own stall, not the twenty of a second attempt"
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_own_stall_then_another_sessions_stall_then_own_stall_waits_twenty_minutes():
    """A refusal unsent between two own stalls carries the count on: the second is a second."""
    async def exercise():
        wait = [0.0]
        harness = Harness(failure=_own_stall())
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        try:
            assert (await harness.capture()).accepted is False
            assert relay.quarantined["session"].stalls == 1
            await _elapse(relay)
            await _until(lambda: harness.requests)
            # Another session's page stalled since: this capture is refused unsent, as before.
            wait[0], harness.failure = 60.0, ConnectorIngestDeferredError(60.0)
            assert (await harness.capture(through_seq=20)).accepted is False
            carried = relay.quarantined["session"]
            assert carried.stalled is False and carried.attempts == 2 and carried.stalls == 1
            wait[0] = 0.0
            await _until(lambda: len(harness.requests) >= 2)
            # Its next capture stalls: the second own stall, twenty minutes.
            harness.failure = _own_stall()
            assert (await harness.capture(through_seq=30)).accepted is False
            record = relay.quarantined["session"]
            assert record.stalled is True and record.attempts == 3 and record.stalls == 2
            remaining = record.retry_at - asyncio.get_running_loop().time()
            assert 1199 < remaining <= 1200, "its second own stall waits twice ten minutes"
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_the_stall_count_of_a_session_starts_over_once_one_of_its_uploads_gets_through():
    async def exercise():
        harness = Harness(failure=_own_stall())
        relay = harness.relay
        relay.snapshot_wait = lambda: 0.0
        try:
            assert (await harness.capture()).accepted is False
            assert relay.quarantined["session"].attempts == 1
            await _elapse(relay)
            await _until(lambda: harness.requests)
            # Its fresh capture stalls again: the second stall waits twice as long.
            assert (await harness.capture(through_seq=20)).accepted is False
            twice = relay.quarantined["session"]
            assert twice.attempts == 2 and twice.stalls == 2
            assert 1199 < twice.retry_at - asyncio.get_running_loop().time() <= 1200
            await _elapse(relay)
            await _until(lambda: len(harness.requests) >= 2)
            # The path came back: the upload gets through, and release() drops the record with its count.
            harness.failure = None
            assert (await harness.capture(through_seq=30)).accepted is True and relay.quarantined == {}
            # The session's next stall is its first again.
            harness.failure = _own_stall()
            assert (await harness.capture(through_seq=40)).accepted is False
            record = relay.quarantined["session"]
            assert record.attempts == 1 and record.stalls == 1 and record.stalled is True
            remaining = record.retry_at - asyncio.get_running_loop().time()
            assert 595 < remaining <= 600, "ten minutes, not the forty of a third attempt"
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_the_retry_of_a_session_whose_own_page_stalled_waits_too_for_a_client_cool_down_that_began_since():
    async def exercise():
        wait = [0.0]
        harness = Harness(failure=_own_stall())
        relay = harness.relay
        relay.snapshot_wait, relay.wait_poll_interval = lambda: wait[0], 0.01
        try:
            assert (await harness.capture()).accepted is False
            # Its backoff runs out while another session's page has the client cooling down again.
            wait[0] = 30.0
            await _elapse(relay)
            await asyncio.sleep(0.05)
            assert harness.requests == [], "retry_at is due, but the client still waits: nothing is asked"
            wait[0] = 0.0
            await _until(lambda: harness.requests)
            assert len(harness.requests) == 1
        finally:
            await relay.close()
    asyncio.run(exercise())


class _Link(httpx.AsyncBaseTransport):
    """A weak relay link: session A's page never gets through while `a_stalls` is set; everything else passes at once."""

    def __init__(self) -> None:
        self.a_stalls = True
        self.accepted: list[str] = []

    async def handle_async_request(self, request):
        body = json.loads(b"".join([chunk async for chunk in request.stream]))
        sessions = [n["params"]["sessionId"] for n in body["notifications"] if n["method"] == "timeline.sync"]
        if self.a_stalls and "A" in sessions:
            raise httpx.WriteTimeout("stalled")
        self.accepted.extend(sessions)
        return httpx.Response(200, json={})


def test_one_stalled_page_starves_no_other_session(monkeypatch):
    """Seen on a weak link: A's page of 45 MiB stalled, and every other session's snapshot was
    refused unsent behind it, ten minutes at a stretch. Now B's goes out one cool-down after the stall."""
    import connector.server.ingest as ingest_module
    from connector.server.ingest import ConnectorIngestClient

    async def exercise():
        # The ingest client's clock: its minute passes at a stroke. The relay keeps the loop's
        # clock, so A's ten minutes do not.
        clock = [1000.0]
        monkeypatch.setattr(ingest_module, "time", SimpleNamespace(monotonic=lambda: clock[0]))
        lines: list[str] = []
        sink = ingest_module.logger.add(lines.append, level="WARNING")
        link = _Link()
        http = httpx.AsyncClient(transport=link)
        ingest = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)
        host = SimpleNamespace(
            connector_id="test",
            publish_runtime_notifications=AsyncMock(),
            sync_state_write=AsyncMock(),
            snapshot_wait=ingest.snapshot_wait,
            publish_runtime_snapshot=lambda runtime, session_id, meta, items, **options: ingest.ingest_snapshot(
                runtime, "instance", session_id, meta, items, **options),
        )
        # The runtime hands the relay the host's wait (see runtime.py); the helper builds a bare relay.
        relay = ready_relay(host)
        relay.snapshot_wait = host.snapshot_wait
        relay.wait_poll_interval = 0.01
        asks: list[str] = []

        async def capture(session_id: str, through_seq: int = 12):
            meta = {"externalSessionId": f"native-{session_id}", "sourceState": {"availability": "available"}}
            await begin_snapshot(relay, session_id=session_id, meta=meta, through_seq=through_seq)
            await add_page(relay, [item("one", session_id)])
            return await relay.commit_snapshot()

        async def refresh(method, params=None):
            assert method == "refreshSync"
            asks.append(params["sessionId"])
            await capture(params["sessionId"], 20)   # the plugin answers at once and captures after it does
            return {"ok": True}

        relay.client.request = refresh
        try:
            async with http:
                # t=0: A's page stalls.
                assert (await capture("A")).accepted is False
                a = relay.quarantined["A"]
                assert a.reason == "history_deferred" and a.stalled is True and a.attempts == 1
                assert 595 < a.retry_at - asyncio.get_running_loop().time() <= 600, "A waits its ten minutes"
                (given_up,) = [line for line in lines if "an upload body stalled and was given up" in line]
                assert "snapshot uploads wait 60s stalls=1" in given_up, given_up

                # B's small snapshot arrives while the client cools down: refused unsent, as every
                # other session's was before...
                result = await capture("B")
                assert result.accepted is False and result.reason == "history_deferred"
                b = relay.quarantined["B"]
                assert b.stalled is False and 59 < b.retry_at - asyncio.get_running_loop().time() <= 60
                assert link.accepted == [] and asks == []

                # ...but one minute later the client takes snapshots again: B is asked for and lands.
                clock[0] += ingest_module.SNAPSHOT_STALL_WAIT_SECONDS
                await _until(lambda: "B" in link.accepted)
                assert asks == ["B"] and link.accepted == ["B"], "B and only B: A's page is not sent again"
                assert relay.quarantined == {"A": a}, "B is released; A keeps the record it was given"
                assert a.retry_at - asyncio.get_running_loop().time() > 500, "A still waits most of its ten minutes"
        finally:
            ingest_module.logger.remove(sink)
            await relay.close()
    asyncio.run(exercise())
