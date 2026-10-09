from __future__ import annotations

import asyncio
import json
import threading
from copy import deepcopy
from pathlib import Path

import httpx
import pytest

from connector.server.ingest import ConnectorIngestClient


def timeline(items, *, complete=False, session="test-session"):
    return {"method": "timeline.sync", "params": {
        "sessionId": session, "runtime": "codex", "runtimeId": "test-runtime",
        "externalSessionId": "test-external", "complete": complete,
        "metadata": {"source": "synthetic", "example": "[]\\\"🙂"}, "items": items,
    }}


def item(index, content="x" * 80):
    return {"id": f"item-{index}", "orderSeq": index + 1, "content": {"text": content}}


def client_for(http, budget=900, token=None):
    async def default_token(force):
        return "test-token"
    client = ConnectorIngestClient("https://aa.example.invalid", token or default_token,
                                   lambda: http, lambda timeout: http)
    client._max_body_bytes = budget
    return client


def test_CE_413_001_incremental_unicode_pages_fit_and_preserve_data():
    fixture = json.loads((Path(__file__).parents[1] / "fixtures/counterexamples/CE-413-001.json").read_text())
    rows = [item(i, fixture["content"] * fixture["repeat"]) for i in range(fixture["itemCount"])]
    notification = timeline(rows)
    original = deepcopy(notification)
    async def run():
        bodies = []
        def transport(request):
            bodies.append(request.content)
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            await client_for(http, fixture["budgetBytes"]).ingest_notifications([notification])
        assert len(bodies) > 1, "S1: original unbounded sender has only one oversized request"
        assert all(len(body) <= fixture["budgetBytes"] for body in bodies), "P1"
        pages = [n for b in bodies for n in json.loads(b)["notifications"]]
        assert [i for p in pages for i in p["params"]["items"]] == rows, "P2"
        for page in pages:
            assert {k: v for k, v in page["params"].items() if k != "items"} == {
                k: v for k, v in original["params"].items() if k != "items"}
        assert notification == original
    asyncio.run(run())


def test_S8_envelope_exact_budget_and_plus_one():
    async def run():
        notification = {"method": "test", "params": {"value": "测试🙂\\\""}}
        encoded = json.dumps({"notifications": [notification]}, ensure_ascii=False,
                             separators=(",", ":"), allow_nan=False).encode()
        bodies = []
        def transport(request):
            bodies.append(request.content)
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            await client_for(http, len(encoded)).ingest_notifications([notification])
            assert bodies == [encoded]
            # Over the page budget an indivisible notification still travels
            # whole; only the server decides it is too large.
            await client_for(http, len(encoded) - 1).ingest_notifications([notification])
            assert bodies == [encoded, encoded]
    asyncio.run(run())


@pytest.mark.parametrize("complete,rows", [(True, [item(i) for i in range(20)]),
                                           (False, [item(1, "private-test-content" * 1000)])])
def test_S2_oversized_atomic_data_never_truncated_or_split(complete, rows):
    async def run():
        bodies = []
        def transport(request):
            bodies.append(request.content)
            return httpx.Response(200, json={"rejected": []})
        notification = timeline(rows, complete=complete)
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            await client_for(http).ingest_notifications([notification])
        assert len(bodies) == 1, "P3: an indivisible notification is never split"
        assert json.loads(bodies[0])["notifications"] == [notification]
    asyncio.run(run())


@pytest.mark.parametrize("complete,rows", [(True, [item(i) for i in range(20)]),
                                           (False, [item(1, "private-test-content" * 1000)])])
def test_S2_server_413_for_atomic_data_is_typed_and_sanitized(complete, rows):
    async def run():
        from connector.server.ingest_batching import ConnectorIngestSizeError
        bodies = []
        def transport(request):
            bodies.append(request.content)
            return httpx.Response(413)
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            with pytest.raises(ConnectorIngestSizeError) as error:
                await client_for(http).ingest_notifications([timeline(rows, complete=complete)])
        assert len(bodies) == 1
        assert error.value.reason == "http_413"
        assert "private-test-content" not in str(error.value)
        assert "test-session" not in str(error.value)
    asyncio.run(run())


def test_S6_small_replacement_and_empty_timeline_remain_unchanged():
    async def run():
        expected = [timeline([item(0)], complete=True), timeline([], complete=False)]
        bodies = []
        def transport(request):
            bodies.extend(json.loads(request.content)["notifications"])
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            await client_for(http, 1000).ingest_notifications(expected)
        assert bodies == expected
    asyncio.run(run())


def test_S7_mixed_notifications_preserve_order_and_coalescing():
    async def run():
        expected = [{"method": "session.meta", "params": {"value": "before"}},
                    timeline([item(i) for i in range(12)]),
                    {"method": "session.state.updated", "params": {"value": "after"}}]
        delivered = []
        def transport(request):
            assert len(request.content) <= 900
            delivered.extend(json.loads(request.content)["notifications"])
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            await client_for(http).ingest_notifications(expected)
        assert delivered[0] == expected[0] and delivered[-1] == expected[-1]
        assert [i for n in delivered[1:-1] for i in n["params"]["items"]] == expected[1]["params"]["items"]
    asyncio.run(run())


def test_S4_401_refreshes_identical_page_and_future_pages_use_fresh_token():
    async def run():
        requests = []
        refreshes = []
        async def token(force):
            refreshes.append(force)
            return "fresh" if force else "old"
        def transport(request):
            requests.append((request.content, request.headers["Authorization"]))
            return httpx.Response(401 if len(requests) == 1 else 200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            await client_for(http, token=token).ingest_notifications([timeline([item(i) for i in range(20)])])
        assert requests[0][0] == requests[1][0]
        assert refreshes == [False, True]
        assert all(auth == "Bearer fresh" for _, auth in requests[1:])
    asyncio.run(run())


def test_S4_413_is_typed_and_sanitized():
    async def run():
        from connector.server.ingest_batching import ConnectorIngestSizeError
        def transport(request):
            return httpx.Response(413, text="sensitive upstream response must not be logged")
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            with pytest.raises(ConnectorIngestSizeError) as error:
                await client_for(http).ingest_notifications([timeline([item(0)])])
        assert error.value.reason == "http_413"
        assert "sensitive" not in str(error.value) and "example.invalid" not in str(error.value)
    asyncio.run(run())


def test_S7_pending_size_rejection_does_not_blame_or_block_direct_session():
    async def run():
        delivered = []
        def transport(request):
            if len(request.content) > 900:
                return httpx.Response(413)
            delivered.extend(json.loads(request.content)["notifications"])
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = client_for(http)
            await ingest.enqueue("timeline.sync", timeline([item(0, "x" * 3000)], session="bad")["params"])
            await ingest.ingest_notifications([timeline([item(1)], session="healthy")])
            assert not ingest.has_pending
        assert [n["params"]["sessionId"] for n in delivered] == ["healthy"]
    asyncio.run(run())


def test_S9_encoding_runs_in_worker_and_pages_are_lazy(monkeypatch):
    from connector.server import ingest_batching
    original = ingest_batching._encode_json
    threads = set()
    encoded_items = []
    def tracked(value):
        threads.add(threading.get_ident())
        if isinstance(value, dict) and "orderSeq" in value:
            encoded_items.append(value["id"])
        return original(value)
    monkeypatch.setattr(ingest_batching, "_encode_json", tracked)
    async def run():
        main = threading.get_ident()
        first_post_count = []
        def transport(request):
            if not first_post_count:
                first_post_count.append(len(encoded_items))
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            await client_for(http).ingest_notifications([timeline([item(i) for i in range(100)])])
        assert main not in threads and threads
        assert 0 < first_post_count[0] < 100, "S9: must not encode all pages before first send"
    asyncio.run(run())


def test_S8_history_over_50_MiB_uses_mocked_bounded_requests():
    async def run():
        budget = 8 * 1024 * 1024
        content = "x" * (1024 * 1024)
        rows = [item(i, content) for i in range(55)]
        sizes = []
        ids = []
        def transport(request):
            sizes.append(len(request.content))
            ids.extend(i["id"] for n in json.loads(request.content)["notifications"] for i in n["params"]["items"])
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            await client_for(http, budget).ingest_notifications([timeline(rows)])
        assert sum(sizes) > 50 * 1024 * 1024
        assert max(sizes) <= budget and len(sizes) > 1
        assert ids == [row["id"] for row in rows]
    asyncio.run(run())


def test_S10_default_budget_sends_9_MiB_replacement_whole_like_main():
    async def run():
        rows = [item(i, "x" * (1024 * 1024)) for i in range(9)]
        sizes = []
        def transport(request):
            sizes.append(len(request.content))
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = ConnectorIngestClient("https://aa.example.invalid", _token, lambda: http, lambda timeout: http)
            await ingest.ingest_notifications([timeline(rows, complete=True)])
        assert len(sizes) == 1 and sizes[0] > 9 * 1024 * 1024
    asyncio.run(run())


def test_S11_oversized_notification_rejects_only_itself_in_a_batch():
    async def run():
        from connector.server.ingest_batching import ConnectorIngestSizeError
        before = {"method": "timeline.itemUpsert", "params": {"sessionId": "a", "item": item(0)}}
        oversized = timeline([item(i) for i in range(20)], complete=True, session="x")
        after = [{"method": "session.state.updated", "params": {"sessionId": "y", "status": "idle"}},
                 {"method": "notice.upsert", "params": {"sessionId": "z", "noticeId": "n"}}]
        delivered = []
        def transport(request):
            if len(request.content) > 900:
                return httpx.Response(413)
            delivered.extend(json.loads(request.content)["notifications"])
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = client_for(http)
            with pytest.raises(ConnectorIngestSizeError):
                await ingest.ingest_notifications([before, oversized, *after])
            assert delivered == [before, *after]
            # The queued worker drops only the oversized notification as well.
            delivered.clear()
            ingest._retry_delay = 0.001
            for notification in [before, oversized, *after]:
                await ingest.enqueue(notification["method"], notification["params"])
            task = asyncio.create_task(ingest.flush_loop())
            for _ in range(200):
                if not ingest.has_pending:
                    break
                await asyncio.sleep(0.01)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert delivered == [before, *after]
    asyncio.run(run())


def test_S12_page_413_below_budget_retries_each_notification_alone():
    async def run():
        from connector.server.ingest_batching import ConnectorIngestSizeError
        small = [{"method": "session.state.updated", "params": {"sessionId": f"s{i}", "value": "v" * 150}}
                 for i in range(3)]
        large = {"method": "session.meta.upsert", "params": {"sessionId": "big", "title": "t" * 400}}
        delivered = []
        def transport(request):
            if len(request.content) > 450:
                return httpx.Response(413)
            delivered.extend(json.loads(request.content)["notifications"])
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            with pytest.raises(ConnectorIngestSizeError):
                await client_for(http).ingest_notifications([small[0], large, *small[1:]])
        assert delivered == small
    asyncio.run(run())


def test_S13_transient_failure_resumes_at_unaccepted_page_without_replay():
    async def run():
        turn_ended = {"method": "session.turnEnded", "params": {"sessionId": "s", "turnId": "t"}}
        rows = [item(i) for i in range(12)]
        bodies = []
        failed = []
        def transport(request):
            notifications = json.loads(request.content)["notifications"]
            if len(bodies) == 1 and not failed:
                failed.append(True)
                return httpx.Response(503)
            bodies.append(notifications)
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = client_for(http)
            ingest._retry_delay = 0.001
            await ingest.enqueue("session.turnEnded", turn_ended["params"])
            await ingest.enqueue("timeline.sync", timeline(rows)["params"])
            task = asyncio.create_task(ingest.flush_loop())
            for _ in range(200):
                if not ingest.has_pending:
                    break
                await asyncio.sleep(0.01)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        delivered = [n for body in bodies for n in body]
        assert failed and len(bodies) > 2
        assert [n for n in delivered if n["method"] == "session.turnEnded"] == [turn_ended]
        assert [i["id"] for n in delivered if n["method"] == "timeline.sync" for i in n["params"]["items"]] == [
            row["id"] for row in rows
        ], "every item arrives exactly once, in order"
    asyncio.run(run())


async def _token(force):
    return "test-token"
