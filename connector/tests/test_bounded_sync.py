from __future__ import annotations

import asyncio
import json
from collections import Counter

import httpx
import pytest
from test_bounded_ingest import client_for
from test_connector_runtime import (
    FakeAgentRuntime,
    FakeRuntimeSupervisor,
    RecordingRuntimeHost,
    _client,
    unused_notification_sender,
)

from connector.runtime_protocol import (
    PreparedSessionTimelineSync,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionMeta,
)
from connector.server.auth import ConnectorAuthenticationError
from connector.server.errors import ConnectorNetworkError
from connector.server.ingest import ConnectorIngestRejectedError
from connector.server.runtime_sync import RuntimeSyncRunner


class Runtime(FakeAgentRuntime):
    def __init__(self):
        super().__init__()
        self.reads = Counter()
        self.commits = Counter()
        self.marker = "source-v1"

    def session(self, name, needs_sync=True):
        return SessionMeta(session_id=name, external_session_id=name, runtime="codex",
                           metadata={"sync": {"changed": needs_sync, "requires_timeline_sync": needs_sync,
                                               "marker": self.marker}})

    async def list_sessions(self, **kwargs):
        return tuple(self.session(name, needs_sync=False) for name in ("large", "healthy"))

    async def get_session_state(self, *args):
        return None

    async def prepare_session_timeline_sync(self, session_id, external):
        self.reads[session_id] += 1
        async def commit():
            self.commits[session_id] += 1
        items = tuple(RuntimeTimelineItem(id=f"{session_id}-{i}", session_id=session_id,
                                          type="message", status="completed", order_seq=i + 1,
                                          content_hash=f"synthetic-hash-{i}",
                                          content={"text": "synthetic" * 30})
                      for i in range(8 if session_id == "large" else 1))
        return PreparedSessionTimelineSync(snapshot=RuntimeTimelineSnapshot(
            session_id=session_id, external_session_id=external, runtime="codex",
            items=items, complete=False), commit=commit)


def runner_for(runtime, ingest):
    return RuntimeSyncRunner(config=_client().config, supervisor=FakeRuntimeSupervisor(runtime),
                             host=RecordingRuntimeHost(), preferences_reader=dict,
                             send_notification=unused_notification_sender,
                             ingest_notifications=ingest.ingest_notifications)


def test_S3_partial_network_failure_replay_preserves_ids_and_checkpoint():
    async def run():
        runtime = Runtime()
        server_items = {}
        attempt = 0
        failing = True
        def transport(request):
            nonlocal attempt
            notifications = json.loads(request.content)["notifications"]
            # Meta-only prelude pages are not a partially uploaded timeline.
            if any(note["method"] == "timeline.sync" for note in notifications):
                attempt += 1
            if failing and attempt == 2:
                raise httpx.ConnectError("synthetic offline", request=request)
            for note in notifications:
                if note["method"] == "timeline.sync":
                    for row in note["params"]["items"]:
                        server_items[row["id"]] = row
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            runner = runner_for(runtime, client_for(http, 1200))
            with pytest.raises(ConnectorNetworkError):
                await runner.sync_existing_session(runtime, runtime.session("large"), recovering=True)
            assert not runtime.commits
            assert 0 < len(server_items) < 8
            failing = False
            await runner.sync_existing_session(runtime, runtime.session("large"), recovering=True)
            assert runtime.commits == {"large": 1}
            assert list(server_items) == [f"large-{i}" for i in range(8)]
    asyncio.run(run())


@pytest.mark.parametrize("failure", ["reject", "cancel", "401", "429", "503", "413"])
def test_S4_failed_or_cancelled_page_never_commits(failure):
    async def run():
        runtime = Runtime()
        def transport(request):
            if failure == "cancel":
                raise asyncio.CancelledError()
            if failure == "reject":
                return httpx.Response(200, json={"rejected": [{"method": "timeline.sync", "code": "test"}]})
            return httpx.Response(int(failure))
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            runner = runner_for(runtime, client_for(http, 1200))
            if failure == "413":
                assert await runner.sync_existing_session(runtime, runtime.session("large"), recovering=True) is False
            else:
                error_type = {"reject": ConnectorIngestRejectedError, "cancel": asyncio.CancelledError,
                              "401": ConnectorAuthenticationError, "429": ConnectorNetworkError,
                              "503": ConnectorNetworkError}[failure]
                with pytest.raises(error_type):
                    await runner.sync_existing_session(runtime, runtime.session("large"), recovering=True)
            assert not runtime.commits, "P4: failed page cannot commit prepared checkpoint"
    asyncio.run(run())


def test_S5_413_cooldown_is_session_local_and_source_change_retries():
    clock = [1000.0]
    async def run():
        runtime = Runtime()
        timeline_requests = Counter()
        meta_sessions = []
        def transport(request):
            notifications = json.loads(request.content)["notifications"]
            for note in notifications:
                if note["method"] == "session.meta":
                    meta_sessions.append(note["params"]["sessionId"])
                if note["method"] == "timeline.sync":
                    sid = note["params"]["sessionId"]
                    timeline_requests[sid] += 1
                    if sid == "large":
                        return httpx.Response(413)
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            runner = runner_for(runtime, client_for(http, 1200))
            runner._ingest_retry_seconds = 60
            runner._ingest_clock = lambda: clock[0]
            await runner.reconnect_event_runtimes()
            await runner.sync_existing_once()
            await runner.sync_existing_once()
            assert runtime.reads == {"large": 1, "healthy": 1}, "P5: paused history is not reread"
            assert runtime.commits == {"healthy": 1}
            assert ("codex", "large") not in runner._recovered_sessions
            runtime.marker = "source-v2"
            await runner.sync_existing_once()
            assert runtime.reads["large"] == 2, "source marker survives recovery override"
            clock[0] += 61
            await runner.sync_existing_once()
            assert runtime.reads["large"] == 3
            assert runtime.commits == {"healthy": 1}
    asyncio.run(run())


def test_S5_item_over_page_budget_travels_alone_and_commits():
    async def run():
        runtime = Runtime()
        timeline_items = []
        def transport(request):
            for note in json.loads(request.content)["notifications"]:
                if note["method"] == "timeline.sync":
                    timeline_items.append([row["id"] for row in note["params"]["items"]])
            return httpx.Response(200, json={"rejected": []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            runner = runner_for(runtime, client_for(http, 400))
            assert await runner.sync_existing_session(runtime, runtime.session("large"), recovering=True) is not False
            # Only the server may reject a request as too large.
            assert timeline_items == [[f"large-{i}"] for i in range(8)]
            assert runtime.commits == {"large": 1}
    asyncio.run(run())
