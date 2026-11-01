"""NativeZcodeRuntime scan/publish/recover orchestration with a fixture database."""

import asyncio
import json
import sqlite3
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

from connector.runtime_protocol import RuntimeConfig
from connector.runtime_protocol.workflows import RuntimeWorkflowRequest
from connector.runtimes.acp.domain.definitions import AgentProfile, LaunchDefinition
from connector.runtimes.zcode.discovery import ZCodeLaunch
from connector.runtimes.zcode.native_runtime import NativeZcodeRuntime
from connector.runtimes.zcode.provider import ZCodeClient, ZCodeProvider

SCHEMA = """
CREATE TABLE session (
    id text primary key, title text, directory text,
    time_created integer, time_updated integer, time_deleted integer, task_type text
);
CREATE TABLE message (
    id text primary key, session_id text, sequence integer, data text, time_created integer
);
CREATE TABLE part (
    id text primary key, message_id text, sequence integer, data text, time_created integer
);
"""


def build_fixture_db(path: Path, workspace: Path) -> str:
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.execute(
        "INSERT INTO session (id, title, directory, time_created, time_updated, time_deleted, task_type)"
        " VALUES ('sess-fix-1', '修复登录页', ?, 50, 120, NULL, 'interactive')",
        (str(workspace),),
    )
    conn.execute(
        "INSERT INTO message (id, session_id, sequence, data, time_created)"
        " VALUES ('m1', 'sess-fix-1', 1, ?, 60)",
        (json.dumps({"role": "user", "semantics": {"origin": "real_user"}}),),
    )
    conn.execute(
        "INSERT INTO part (id, message_id, sequence, data, time_created)"
        " VALUES ('p1', 'm1', 1, ?, 70)",
        (json.dumps({"type": "text", "text": "请修复登录页"}),),
    )
    conn.commit()
    conn.close()
    return "sess-fix-1"


def make_runtime(tmp_path: Path, db_path: Path) -> tuple[NativeZcodeRuntime, list, str]:
    workspace = tmp_path / "workspace"
    workspace.mkdir(exist_ok=True)
    native_id = build_fixture_db(db_path, workspace)
    notifications: list = []

    async def publish_notifications(*args, **kwargs):
        notifications.append(args)

    host = SimpleNamespace(
        session_namespace="test-zcode-native",
        runtime_kv=SimpleNamespace(path=tmp_path / "kv/runtime.json"),
        publish_runtime_notifications=publish_notifications,
    )
    config = RuntimeConfig(runtime="zcode", revision=1, values={}, schema={})
    runtime = NativeZcodeRuntime(
        config,
        host,
        AgentProfile("zcode", "ZCode"),
        LaunchDefinition(sys.executable, ("-c", "pass"), "fixture"),
        client_factory=ZCodeClient,
        history_db_path=db_path,
    )
    return runtime, notifications, native_id


def test_scan_publishes_native_session(tmp_path):
    async def run():
        runtime, notifications, native_id = make_runtime(
            tmp_path, tmp_path / "db.sqlite"
        )
        await runtime.start()
        try:
            await runtime.sync.flush()
            sources = {row["sessionId"]: row for row in
                       runtime.app.store.values("zcode_native_source")}
            assert set(sources) == {native_id}
            platform_id = sources[native_id]["platformSessionId"]
            assert platform_id.startswith("zcode_native_")

            metas = [
                payload
                for batch in notifications
                for payload in batch[1]
                if payload.get("method") == "session.meta.upsert"
                and payload["params"]["sessionId"] == platform_id
            ]
            assert metas, "scan must publish session.meta.upsert"
            assert metas[0]["params"]["metadata"]["origin"] == "zcode_native_history"
            assert metas[0]["params"]["externalSessionId"] == native_id

            synced = [
                payload
                for batch in notifications
                for payload in batch[1]
                if payload.get("method") == "timeline.sync"
                and payload["params"]["sessionId"] == platform_id
            ]
            assert synced, "scan must publish timeline.sync"
            texts = [item["content"]["text"] for item in synced[0]["params"]["items"]]
            assert texts == ["请修复登录页"]

            state = await runtime.get_session_state(platform_id)
            assert state.status == "idle"
            assert state.status_reason == "zcode_continue_required"

            caps = runtime._session_capabilities(platform_id)
            by_id = {cap.capability_id: cap for cap in caps.capabilities}
            assert by_id["session.recover"].available is True
            assert by_id["session.send_message"].available is False
            assert by_id["session.send_message"].unavailable_reason == "zcode_continue_required"

            sessions = await runtime.list_sessions()
            assert any(row.session_id == platform_id for row in sessions)

            # A second scan with unchanged signature must not republish.
            before = len(runtime.app.store.values("projection"))
            await runtime.scan()
            assert len(runtime.app.store.values("projection")) == before
        finally:
            await runtime.stop()

    asyncio.run(run())


def test_recover_requires_cli_exit_confirmation(tmp_path):
    async def run():
        runtime, _unused_notifications, _native_id = make_runtime(
            tmp_path, tmp_path / "db.sqlite"
        )
        await runtime.start()
        try:
            platform_id = next(iter(runtime.app.store.values("zcode_native_source")))[
                "platformSessionId"
            ]
            result = await runtime.execute_workflow(
                RuntimeWorkflowRequest(
                    operation="recover_session",
                    values={
                        "sessionId": platform_id,
                        "operationId": "op-1",
                        "expectedGeneration": "browse",
                        "sourceRevision": "120:1",
                    },
                )
            )
            assert result.values["phase"] == "rejected"
            assert result.values["failure"]["code"] == "zcode_cli_exit_required"
            assert runtime.app.store.get("binding", platform_id) is None
        finally:
            await runtime.stop()

    asyncio.run(run())


def test_recover_rejects_changed_source(tmp_path):
    async def run():
        runtime, _unused_notifications, _native_id = make_runtime(
            tmp_path, tmp_path / "db.sqlite"
        )
        await runtime.start()
        try:
            source = next(iter(runtime.app.store.values("zcode_native_source")))
            platform_id = source["platformSessionId"]
            generation = runtime._metadata(platform_id, source)["ownerGeneration"]
            result = await runtime.execute_workflow(
                RuntimeWorkflowRequest(
                    operation="recover_session",
                    values={
                        "sessionId": platform_id,
                        "operationId": "op-1",
                        "cliExited": True,
                        "expectedGeneration": generation,
                        "sourceRevision": "stale:1",
                    },
                )
            )
            assert result.values["phase"] == "rejected"
            assert result.values["failure"]["code"] == "zcode_source_changed"
            assert runtime.app.store.get("binding", platform_id) is None
        finally:
            await runtime.stop()

    asyncio.run(run())


def test_recover_success_creates_binding_and_holds_lease(tmp_path, monkeypatch):
    async def run():
        runtime, _unused_notifications, native_id = make_runtime(
            tmp_path, tmp_path / "db.sqlite"
        )
        await runtime.start()
        try:
            source = next(iter(runtime.app.store.values("zcode_native_source")))
            platform_id = source["platformSessionId"]
            generation = runtime._metadata(platform_id, source)["ownerGeneration"]

            recovered = []

            async def fake_recover(session_id):
                recovered.append(session_id)
                return {"status": "attached"}

            monkeypatch.setattr(runtime.app, "recover", fake_recover)

            result = await runtime.execute_workflow(
                RuntimeWorkflowRequest(
                    operation="recover_session",
                    values={
                        "sessionId": platform_id,
                        "operationId": "op-1",
                        "cliExited": True,
                        "expectedGeneration": generation,
                        "sourceRevision": source["revision"],
                    },
                )
            )
            assert result.values["phase"] == "running"
            for _ in range(100):
                rows = list(runtime.app.store.values("zcode_recovery_operation"))
                if rows and rows[0]["result"].get("phase") == "completed":
                    break
                await asyncio.sleep(0.02)
            rows = list(runtime.app.store.values("zcode_recovery_operation"))
            assert rows and rows[0]["result"]["phase"] == "completed"
            binding = runtime.app.store.get("binding", platform_id)
            assert binding is not None
            assert binding["agent_session_id"] == "zc-" + native_id
            assert binding["attachment"] == "recovery_required"
            assert recovered == [platform_id]
            # The lease is held while the recovered session stays attached.
            assert platform_id in runtime.leases

            # Idempotent replay returns the recorded result.
            replay = await runtime.execute_workflow(
                RuntimeWorkflowRequest(
                    operation="recover_session",
                    values={
                        "sessionId": platform_id,
                        "operationId": "op-1",
                        "cliExited": True,
                        "expectedGeneration": generation,
                        "sourceRevision": source["revision"],
                    },
                )
            )
            assert replay.values["phase"] == "completed"
        finally:
            await runtime.stop()
        assert not runtime.leases

    asyncio.run(run())


def test_provider_uses_native_runtime_and_metadata(tmp_path, monkeypatch):
    async def run():
        monkeypatch.setattr(
            "connector.runtimes.zcode.provider.discover_zcode",
            lambda: ZCodeLaunch("/usr/bin/node", (str(tmp_path / "zcode.cjs"), "app-server")),
        )
        monkeypatch.setenv("ZCODE_CLI_DB", str(tmp_path / "db.sqlite"))
        provider = ZCodeProvider()
        descriptor = await provider.discover()
        assert descriptor.metadata.get("nativeHistory") is True
        config = replace(await provider.validate_config({}), runtime_id="zcode")
        host = SimpleNamespace(
            session_namespace="test",
            runtime_kv=SimpleNamespace(path=tmp_path / "kv/runtime.json"),
            publish_runtime_notifications=lambda *args, **kwargs: None,
        )
        runtime = await provider.create_runtime(config, host)
        assert isinstance(runtime, NativeZcodeRuntime)
        assert runtime.history_db_path == tmp_path / "db.sqlite"

    asyncio.run(run())
