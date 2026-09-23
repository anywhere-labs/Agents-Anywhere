"""Codex scanner recovery against the actual backend in a temporary database.

The SDK history is scripted; no model requests or user credentials are used.
Run from server with `uv run --with-editable ../connector --with pytest python
../connector/tests/codex_recovery_probe.py`.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

# This module isolates AGENT_SERVER_DB_URL and sets both source import paths.
from dsh_event_probe import create_app, create_connector_access_token
from dsh_probe_transport import IngestTransport
from test_codex_runtime import FakeCodexClient, _config
import httpx

from connector.core.config import ConnectorConfig
from connector.runtimes.codex.runtime import CodexRuntime
from connector.server.ingest import ConnectorIngestClient
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.runtime_sync import RuntimeSyncRunner
from connector.server.sync_state import JsonSyncStateStore


class FaultTransport(IngestTransport):
    reject_next = False

    async def handle_async_request(self, request):
        notices = json.loads(request.content)["notifications"]
        if self.reject_next and any(n["method"] == "timeline.sync" for n in notices):
            self.reject_next = False
            raise httpx.ConnectError("simulated network outage", request=request)
        return await super().handle_async_request(request)


async def scenario(home, fault):
    home.mkdir()
    app = create_app(home / "server.sqlite3")
    await app.state.store.create_user(user_id="simulation", password_hash="test-only")
    async with app.router.lifespan_context(app):
        backend = app.state.store
        connector, credential, _ = await backend.create_connector(name="Codex test", user_id="simulation")
        token = create_connector_access_token(connector.id, credential_hash=hashlib.sha256(credential.encode()).hexdigest())
        transport = FaultTransport(app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
            ingest = ConnectorIngestClient("http://test", AsyncMock(return_value=token), lambda: http, lambda _: http)
            sdk = FakeCodexClient()

            async def boot():
                base = ConnectorRuntimeHost(connector.id, AsyncMock(), AsyncMock(),
                    JsonSyncStateStore(home / "connector-state.json"), ingest.ingest_notifications)
                host = await base.prepare_runtime_host("codex")
                runtime = CodexRuntime(config=_config(), host=host, client=sdk)
                runner = RuntimeSyncRunner(ConnectorConfig("http://test", connector.id, "test-only"),
                    SimpleNamespace(), host, dict, AsyncMock(), ingest_notifications=ingest.ingest_notifications)
                return base, runtime, runner

            async def scan(runtime, runner):
                session = (await runtime.list_sessions(force=True))[0]
                await runner.sync_existing_session(runtime, session, recovering=True)
                await app.state.timeline_write_buffer.flush_through(session.session_id)
                return session.session_id

            def uploaded_since(offset):
                return sum(len(n["params"]["items"]) for n in transport.notifications[offset:] if n["method"] == "timeline.sync")

            base, runtime, runner = await boot()
            sid = await scan(runtime, runner)
            baseline = len(await backend.timeline.read(sid))
            base.flush_runtime_storage()
            base, runtime, runner = await boot()
            offset = len(transport.notifications)
            await scan(runtime, runner)
            assert uploaded_since(offset) == 0
            items = sdk.results["thread/read"]["thread"]["items"]
            next(item for item in items if item.get("id") == "item_assistant")["text"] = "modified"
            items.append({"id": "added", "type": "message", "role": "assistant", "status": "done", "text": "added"})
            transport.reject_next = fault == "before_ingest"
            transport.lose_snapshot_reply = fault == "lost_reply"
            try:
                await scan(runtime, runner)
            except Exception:
                if fault not in {"before_ingest", "lost_reply"}:
                    raise
            else:
                assert fault not in {"before_ingest", "lost_reply"}, "fault did not interrupt commit"
            if fault == "after_flush":
                base.flush_runtime_storage()
            base, runtime, runner = await boot()
            offset = len(transport.notifications)
            await scan(runtime, runner)
            count = uploaded_since(offset)
            assert count == (0 if fault == "after_flush" else 2), (fault, count)
            stored = await backend.timeline.read(sid)
            assert len(stored) == baseline + 1
            texts = [item.content.get("text") for item in stored]
            assert texts.count("modified") == texts.count("added") == 1, texts
            base.flush_runtime_storage()
            base, runtime, runner = await boot()
            offset = len(transport.notifications)
            await scan(runtime, runner)
            assert uploaded_since(offset) == 0
            print(f"Codex {fault}: recovery={count} items, unchanged restart=0, database exact")


async def main():
    with tempfile.TemporaryDirectory(prefix="aa-codex-recovery-") as directory:
        for fault in ("before_ingest", "lost_reply", "before_flush", "after_flush"):
            await scenario(Path(directory) / fault, fault)


if __name__ == "__main__":
    asyncio.run(main())
