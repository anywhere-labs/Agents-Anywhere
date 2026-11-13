from __future__ import annotations

import asyncio
import json
import re

import httpx
import pytest
from meshcall import MeshCallError

from connector.runtimes.dsh.bridge.host import (
    BACKEND_UNAVAILABLE,
    SubscriptionRegistry,
    SyncBatch,
    SyncService,
)
from connector.server import ingest as ingest_module
from connector.server.auth import ConnectorAuthenticationError
from connector.server.errors import ConnectorNetworkError
from connector.server.ingest import (
    ConnectorIngestClient,
    ConnectorIngestRejectedError,
    upload_timeout,
)
from connector.server.rpc import ConnectorRpcChannel


def test_network_failure_and_server_503_keep_fifo_for_recovery():
    async def run():
        attempts = []
        delivered = asyncio.Event()

        async def token(force):
            return "token"

        async def transport(request):
            import json

            batch = json.loads(request.content)["notifications"]
            attempts.append(batch)
            if len(attempts) == 1:
                raise httpx.ConnectError("offline", request=request)
            if len(attempts) == 2:
                return httpx.Response(503)
            delivered.set()
            return httpx.Response(200, json={"accepted": len(batch), "rejected": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = ConnectorIngestClient(
                "https://server.test", token, lambda: http, lambda timeout: http
            )
            ingest._retry_delay = 0.001
            await ingest.enqueue("session.state.updated", {"status": "running"})
            await ingest.enqueue("session.state.updated", {"status": "idle"})
            task = asyncio.create_task(ingest.flush_loop())
            await asyncio.wait_for(delivered.wait(), 1)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert attempts[0] == attempts[1] == attempts[2]
            assert [row["params"]["status"] for row in attempts[2]] == [
                "running",
                "idle",
            ]
            assert not ingest.has_pending

    asyncio.run(run())


def test_cancelled_http_batch_survives_flush_worker_restart():
    async def run():
        started = asyncio.Event()
        delivered = asyncio.Event()
        calls = []

        async def token(force):
            return "token"

        async def transport(request):
            calls.append(request.content)
            if len(calls) == 1:
                started.set()
                await asyncio.Event().wait()
            delivered.set()
            return httpx.Response(200, json={"accepted": 1, "rejected": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = ConnectorIngestClient(
                "https://server.test", token, lambda: http, lambda timeout: http
            )
            await ingest.enqueue("timeline.sync", {"sessionId": "session", "items": []})
            task = asyncio.create_task(ingest.flush_loop())
            await started.wait()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert ingest.has_pending
            task = asyncio.create_task(ingest.flush_loop())
            await asyncio.wait_for(delivered.wait(), 1)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert calls[0] == calls[1]

    asyncio.run(run())


def test_synchronous_batch_retries_transient_failures_then_surfaces_them(monkeypatch):
    monkeypatch.setattr(ingest_module, "SYNC_BATCH_RETRY_BACKOFF_SECONDS", 0.001)

    async def run():
        async def token(force):
            return "token"

        def uplink(failures):
            attempts = []

            async def transport(request):
                attempts.append(request.content)
                if len(attempts) <= len(failures):
                    failure = failures[len(attempts) - 1]
                    if isinstance(failure, Exception):
                        raise failure
                    return httpx.Response(failure)
                return httpx.Response(200, json={"accepted": 1, "rejected": []})

            return attempts, httpx.MockTransport(transport)

        # A dropped connection and a 502 no longer fail the caller (and the DSH feed with it).
        attempts, transport = uplink([httpx.RemoteProtocolError("Server disconnected"), 502])
        async with httpx.AsyncClient(transport=transport) as http:
            ingest = ConnectorIngestClient("https://server.test", token, lambda: http, lambda timeout: http)
            await ingest.ingest_notifications([{"method": "session.state.updated", "params": {"status": "idle"}}])
            assert len(attempts) == 3 and attempts[0] == attempts[2]

        attempts, transport = uplink([httpx.ConnectError("down")] * (ingest_module.SYNC_BATCH_RETRIES + 1))
        async with httpx.AsyncClient(transport=transport) as http:
            ingest = ConnectorIngestClient("https://server.test", token, lambda: http, lambda timeout: http)
            with pytest.raises(ConnectorNetworkError):
                await ingest.ingest_notifications([{"method": "session.state.updated", "params": {"status": "idle"}}])
            assert len(attempts) == ingest_module.SYNC_BATCH_RETRIES + 1

        # A permanent refusal is final.
        attempts, transport = uplink([400])
        async with httpx.AsyncClient(transport=transport) as http:
            ingest = ConnectorIngestClient("https://server.test", token, lambda: http, lambda timeout: http)
            with pytest.raises(httpx.HTTPStatusError):
                await ingest.ingest_notifications([{"method": "session.state.updated", "params": {"status": "idle"}}])
            assert len(attempts) == 1

    asyncio.run(run())


def test_synchronous_batch_retries_retryable_rejections(monkeypatch):
    monkeypatch.setattr(ingest_module, "SYNC_BATCH_RETRY_BACKOFF_SECONDS", 0.001)

    async def run():
        async def token(force):
            return "token"

        attempts = []

        async def transport(request):
            attempts.append(request.content)
            if len(attempts) == 1:
                return httpx.Response(
                    200,
                    json={
                        "accepted": 0,
                        "rejected": [
                            {
                                "index": 0,
                                "method": "timeline.itemUpsert",
                                "code": "notification_failed",
                                "message": (
                                    "timed out acquiring distributed lock: "
                                    "session-revision:sess_1"
                                ),
                                "errorType": "TimeoutError",
                                "retryable": True,
                            }
                        ],
                    },
                )
            return httpx.Response(200, json={"accepted": 1, "rejected": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = ConnectorIngestClient(
                "https://server.test", token, lambda: http, lambda timeout: http
            )
            await ingest.ingest_notifications(
                [{"method": "timeline.itemUpsert", "params": {"sessionId": "sess_1"}}]
            )

        assert len(attempts) == 2
        assert attempts[0] == attempts[1]

    asyncio.run(run())


def test_synchronous_batch_does_not_retry_permanent_rejections():
    async def run():
        async def token(force):
            return "token"

        attempts = []

        async def transport(request):
            attempts.append(request.content)
            return httpx.Response(
                200,
                json={
                    "accepted": 0,
                    "rejected": [
                        {
                            "index": 0,
                            "method": "timeline.itemUpsert",
                            "code": "notification_failed",
                            "message": "invalid timeline item",
                            "errorType": "ValueError",
                            "retryable": False,
                        }
                    ],
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = ConnectorIngestClient(
                "https://server.test", token, lambda: http, lambda timeout: http
            )
            with pytest.raises(ConnectorIngestRejectedError):
                await ingest.ingest_notifications(
                    [
                        {
                            "method": "timeline.itemUpsert",
                            "params": {"sessionId": "sess_1"},
                        }
                    ]
                )

        assert len(attempts) == 1

    asyncio.run(run())


def _rejection(index: int, *, retryable: bool) -> dict:
    return {
        "index": index,
        "method": "timeline.itemUpsert",
        "code": "notification_failed",
        "message": "timed out acquiring distributed lock" if retryable else "invalid timeline item",
        "errorType": "TimeoutError" if retryable else "ValueError",
        "retryable": retryable,
    }


def _scripted_ingest(responses):
    """An ingest client whose Server answers ``responses`` in turn (the last one repeats)."""

    attempts: list[list[dict]] = []

    async def token(force):
        return "token"

    async def transport(request):
        attempts.append(json.loads(request.content)["notifications"])
        return httpx.Response(200, json=responses[min(len(attempts), len(responses)) - 1])

    http = httpx.AsyncClient(transport=httpx.MockTransport(transport))
    ingest = ConnectorIngestClient("https://server.test", token, lambda: http, lambda timeout: http)
    return ingest, http, attempts


TWO_SESSIONS = [
    {"method": "timeline.itemUpsert", "params": {"sessionId": "sess_1"}},
    {"method": "timeline.itemUpsert", "params": {"sessionId": "sess_2"}},
]


def test_mixed_rejection_batch_stays_permanent(monkeypatch):
    monkeypatch.setattr(ingest_module, "SYNC_BATCH_RETRY_BACKOFF_SECONDS", 0.001)

    async def run():
        ingest, http, attempts = _scripted_ingest(
            [{"accepted": 0, "rejected": [_rejection(0, retryable=True), _rejection(1, retryable=False)]}]
        )
        async with http:
            with pytest.raises(ConnectorIngestRejectedError) as caught:
                await ingest.ingest_notifications(TWO_SESSIONS)
        # The permanent failure is reported as such instead of being retried away.
        assert not isinstance(caught.value, ConnectorNetworkError)
        assert len(attempts) == 1

    asyncio.run(run())


def test_rejection_without_retryable_flag_stays_permanent(monkeypatch):
    """An older Server sends no ``retryable``; its rejections keep their meaning."""

    monkeypatch.setattr(ingest_module, "SYNC_BATCH_RETRY_BACKOFF_SECONDS", 0.001)
    legacy = _rejection(0, retryable=True)
    del legacy["retryable"]

    async def run():
        ingest, http, attempts = _scripted_ingest([{"accepted": 0, "rejected": [legacy]}])
        async with http:
            with pytest.raises(ConnectorIngestRejectedError):
                await ingest.ingest_notifications(TWO_SESSIONS[:1])
        assert len(attempts) == 1

    asyncio.run(run())


def test_partially_accepted_batch_is_resent_whole_and_in_order(monkeypatch):
    """Delivery stays at least once: notifications are retried as the batch they came in."""

    monkeypatch.setattr(ingest_module, "SYNC_BATCH_RETRY_BACKOFF_SECONDS", 0.001)

    async def run():
        ingest, http, attempts = _scripted_ingest(
            [
                {"accepted": 1, "rejected": [_rejection(0, retryable=True)]},
                {"accepted": 2, "rejected": []},
            ]
        )
        async with http:
            await ingest.ingest_notifications(TWO_SESSIONS)
        assert attempts == [TWO_SESSIONS, TWO_SESSIONS]

    asyncio.run(run())


def test_retryable_rejections_surface_as_network_errors_once_retries_run_out(monkeypatch):
    monkeypatch.setattr(ingest_module, "SYNC_BATCH_RETRY_BACKOFF_SECONDS", 0.001)

    async def run():
        ingest, http, attempts = _scripted_ingest(
            [{"accepted": 0, "rejected": [_rejection(0, retryable=True)]}]
        )
        async with http:
            with pytest.raises(ingest_module.ConnectorIngestRetryableError):
                await ingest.ingest_notifications(TWO_SESSIONS[:1])
        assert len(attempts) == ingest_module.SYNC_BATCH_RETRIES + 1

    asyncio.run(run())


def test_flush_loop_keeps_a_retryable_rejection_until_it_is_accepted():
    async def run():
        responses = [
            {"accepted": 0, "rejected": [_rejection(0, retryable=True)]},
            {"accepted": 1, "rejected": []},
        ]
        ingest, http, attempts = _scripted_ingest(responses)
        async with http:
            ingest._retry_delay = 0.001
            await ingest.enqueue("session.state.updated", {"status": "idle"})
            task = asyncio.create_task(ingest.flush_loop())
            while len(attempts) < 2:
                await asyncio.sleep(0.001)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert attempts[0] == attempts[1]
            assert not ingest.has_pending

    asyncio.run(run())


def test_revoked_credentials_stop_retry_and_reject_new_admission():
    async def run():
        async def token(force):
            raise ConnectorAuthenticationError("revoked")

        ingest = ConnectorIngestClient(
            "https://server.test", token, lambda: None, lambda timeout: None
        )
        await ingest.enqueue("connector.heartbeat", {})
        with pytest.raises(ConnectorAuthenticationError):
            await asyncio.wait_for(ingest.flush_loop(), 1)
        with pytest.raises(ConnectorAuthenticationError):
            await ingest.enqueue("connector.heartbeat", {})

    asyncio.run(run())


def test_old_rpc_completion_cannot_reply_on_replacement_socket():
    async def run():
        class Socket:
            def __init__(self):
                self.frames = []

            async def send(self, payload):
                self.frames.append(payload)

        entered, release = asyncio.Event(), asyncio.Event()
        channel = ConnectorRpcChannel()
        old, new = Socket(), Socket()
        channel.set_connection(old)

        async def dispatch(method, params):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                # Some runtime operations finish cleanup despite cancellation.
                await release.wait()
            return {"status": "stopped"}

        channel.start_request(
            {"type": "request", "id": "old", "method": "runtime.stop"}, dispatch
        )
        await entered.wait()
        old_tasks = list(channel._request_tasks)
        channel.set_connection(new)
        release.set()
        await asyncio.gather(*old_tasks)
        assert not old.frames and not new.frames
        await channel.close_connection()

    asyncio.run(run())


def test_failed_websocket_sender_stops_admission_instead_of_hanging_next_send():
    async def run():
        class Socket:
            async def send(self, payload):
                raise ConnectionError("link lost")

        channel = ConnectorRpcChannel()
        channel.set_connection(Socket())
        with pytest.raises(ConnectionError):
            await channel.send_notification("connector.heartbeat", {})
        assert not channel.connected
        with pytest.raises(RuntimeError, match="not connected"):
            await asyncio.wait_for(
                channel.send_notification("connector.heartbeat", {}), 1
            )
        await channel.close_connection()

    asyncio.run(run())


def test_upload_read_timeout_outlasts_a_proxy_that_buffers_the_body() -> None:
    # A 5.6 MB batch took 55-79 s through a local proxy (#502): the client had
    # finished writing, so all of that time counted against the read timeout.
    timeout = upload_timeout(5_672_509)
    assert timeout.read is not None and timeout.read > 79
    assert timeout.connect == 15
    # A real stall still fails: writing has no allowance for size.
    assert timeout.write == 60
    assert upload_timeout(0).read == 60
    # Each retry after a read timeout waits twice as long.
    assert upload_timeout(5_672_509, read_timeouts=2).read == timeout.read * 4


def test_batch_timeout_scales_and_the_failure_says_what_happened() -> None:
    async def exercise() -> tuple[list[httpx.Timeout | dict], ConnectorNetworkError]:
        seen: list[httpx.Timeout | dict] = []

        async def token(_force: bool) -> str:
            return "token"

        def transport(request: httpx.Request) -> httpx.Response:
            seen.append(request.extensions["timeout"])
            json.loads(request.content)
            # httpx timeouts carry an empty message in practice.
            raise httpx.ReadTimeout("", request=request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = ConnectorIngestClient("https://server.test", token, lambda: http, lambda timeout: http)
            notification = {"method": "timeline.itemUpsert", "params": {"text": "x" * 200_000}}
            with pytest.raises(ConnectorNetworkError) as failed:
                await ingest._post_batch([notification])
            return seen, failed.value

    seen, error = asyncio.run(exercise())
    assert seen[0]["read"] > 60
    assert "ReadTimeout" in str(error)
    assert re.search(r"body \d{6} bytes, after \d+\.\ds", str(error))


def test_a_batch_that_keeps_timing_out_waits_longer_on_each_retry(monkeypatch) -> None:
    monkeypatch.setattr(ingest_module, "SYNC_BATCH_RETRY_BACKOFF_SECONDS", 0)

    async def exercise() -> list[float]:
        reads: list[float] = []

        async def token(_force: bool) -> str:
            return "token"

        def transport(request: httpx.Request) -> httpx.Response:
            reads.append(request.extensions["timeout"]["read"])
            if len(reads) < 3:
                raise httpx.ReadTimeout("", request=request)
            return httpx.Response(200, json={"accepted": 1, "rejected": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = ConnectorIngestClient("https://server.test", token, lambda: http, lambda timeout: http)
            await ingest.post_batch([{"method": "timeline.itemUpsert", "params": {"text": "x" * 200_000}}])
        return reads

    reads = asyncio.run(exercise())
    assert reads == [reads[0], reads[0] * 2, reads[0] * 4]


def test_batch_with_a_lone_surrogate_still_uploads() -> None:
    async def exercise() -> dict:
        received: list[dict] = []

        async def token(_force: bool) -> str:
            return "token"

        def transport(request: httpx.Request) -> httpx.Response:
            assert request.headers["content-type"] == "application/json"
            assert int(request.headers["content-length"]) == len(request.content)
            received.append(json.loads(request.content))
            return httpx.Response(200, json={"accepted": 1, "rejected": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = ConnectorIngestClient("https://server.test", token, lambda: http, lambda timeout: http)
            await ingest._post_batch([{"method": "m", "params": {"text": "a\ud800b"}}])
        return received[0]

    assert asyncio.run(exercise())["notifications"][0]["method"] == "m"


def test_unreachable_server_reaches_the_plugin_as_a_retryable_code() -> None:
    class Subscriber:
        def __init__(self, error: Exception) -> None:
            self.error = error

        async def ingest(self, _batch: SyncBatch) -> None:
            raise self.error

    async def outcome(error: Exception) -> BaseException:
        registry = SubscriptionRegistry()
        registry.add("sub", Subscriber(error))  # type: ignore[arg-type]
        service = SyncService(registry, asyncio.get_running_loop())
        batch = SyncBatch(subscriptionId="sub", batchSeq=1, projectionVersion=1, operations=[{"kind": "notifications"}])
        try:
            await service.ingestBatch(batch)
        except Exception as failure:  # noqa: BLE001 - the test inspects it.
            return failure
        raise AssertionError("expected a failure")

    mapped = asyncio.run(outcome(ConnectorNetworkError("backend ingest request failed")))
    assert isinstance(mapped, MeshCallError)
    assert mapped.code == BACKEND_UNAVAILABLE
    assert mapped.retryable is True
    other = asyncio.run(outcome(ValueError("Out-of-order event batch")))
    assert isinstance(other, ValueError)
    contended = asyncio.run(outcome(ingest_module.ConnectorIngestRetryableError("session lock busy")))
    assert isinstance(contended, MeshCallError)
    assert contended.code == BACKEND_UNAVAILABLE
    assert contended.retryable is True
    refused = asyncio.run(outcome(ConnectorIngestRejectedError("invalid timeline item")))
    assert isinstance(refused, ConnectorIngestRejectedError)
