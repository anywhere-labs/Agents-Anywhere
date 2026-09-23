"""Fault simulation through the real scan/commit path and instance JSON storage."""
import asyncio
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from test_codex_runtime import FakeCodexClient, _config
from connector.core.config import ConnectorConfig
from connector.runtime_protocol import RuntimeInstanceHost, RuntimeInstanceSpec
from connector.runtimes.codex.runtime import CodexRuntime
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.runtime_sync import RuntimeSyncRunner
from connector.server.sync_state import JsonSyncStateStore


@pytest.mark.parametrize("fault", ["before_ingest", "lost_reply", "before_flush", "after_flush"])
def test_restart_recovery_fault_matrix(tmp_path, monkeypatch, fault):
    async def run():
        monkeypatch.setenv("AGENT_CONNECTOR_KV_FILE", str(tmp_path / "legacy-kv.json"))
        ledger, uploads = {}, []
        armed = False

        async def ingest(notifications):
            nonlocal armed
            data = [n for n in notifications if n["method"] == "timeline.sync"]
            if armed and fault == "before_ingest" and data:
                armed = False
                raise ConnectionError("simulated network outage before backend commit")
            for n in data:
                params = n["params"]
                if params["complete"]:
                    ledger.clear()
                for item in params["items"]:
                    ledger[item["id"]] = copy.deepcopy(item)
                    uploads.append(item["id"])
            if armed and fault == "lost_reply" and data:
                armed = False
                raise ConnectionError("simulated backend committed, response lost")

        client = FakeCodexClient()
        spec = RuntimeInstanceSpec(runtime_id="rti_simulation", runtime_type="codex", name="simulation")
        async def boot():
            base = ConnectorRuntimeHost("conn_test", AsyncMock(), AsyncMock(),
                JsonSyncStateStore(tmp_path / "connector-state.json"), ingest)
            bound = RuntimeInstanceHost(await base.prepare_runtime_host(spec.runtime_id), spec)
            runtime = CodexRuntime(config=_config(), host=bound, client=client)
            runner = RuntimeSyncRunner(ConnectorConfig("http://simulation", "conn_test", "unused"),
                SimpleNamespace(), bound, dict, AsyncMock(), ingest_notifications=ingest)
            return base, bound, runtime, runner

        async def scan(runtime, runner):
            session = (await runtime.list_sessions(force=True))[0]
            await runner.sync_existing_session(runtime, session, recovering=True)

        base, host, runtime, runner = await boot()
        await scan(runtime, runner)
        baseline = len(ledger)
        assert baseline >= 2
        base.flush_runtime_storage()
        base, host, runtime, runner = await boot()
        uploads.clear()
        await scan(runtime, runner)
        assert uploads == [], "restart resent unchanged history"
        prior = copy.deepcopy(await host.sync_state_read("codex/timeline-sync/thread_1"))
        raw = client.results["thread/read"]["thread"]["items"]
        next(item for item in raw if item.get("id") == "item_assistant")["text"] = "modified"
        raw.append({"id": "new-item", "type": "message", "role": "assistant", "status": "done", "text": "added"})
        armed = True
        if fault in {"before_ingest", "lost_reply"}:
            with pytest.raises(ConnectionError):
                await scan(runtime, runner)
            assert await host.sync_state_read("codex/timeline-sync/thread_1") == prior
        else:
            await scan(runtime, runner)
            assert len(uploads) == 2
        if fault == "after_flush":
            base.flush_runtime_storage()
        # Drop every runtime/storage object, as if the Connector process died.
        base, host, runtime, runner = await boot()
        uploads.clear()
        await scan(runtime, runner)
        assert len(uploads) == (0 if fault == "after_flush" else 2)
        assert len(ledger) == baseline + 1, "recovery duplicated or lost items"
        texts = [item["content"].get("text") for item in ledger.values()]
        assert texts.count("modified") == 1 and texts.count("added") == 1
        base.flush_runtime_storage()
        base, host, runtime, runner = await boot()
        uploads.clear()
        await scan(runtime, runner)
        assert uploads == []
    asyncio.run(run())
