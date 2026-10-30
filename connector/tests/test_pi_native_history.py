import asyncio
import json
import shutil
import subprocess
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from connector.runtimes.acp.domain.definitions import AcpError
from connector.runtimes.acp.infrastructure.projection import Projection
from connector.runtimes.acp.profiles.pi.history import (
    read_history,
    scan_histories,
    timeline,
)
from connector.runtimes.acp.profiles.pi.installation import PACKAGE, resolve_local
from connector.runtimes.acp.profiles.pi.provider import PiProvider


def history_file(root, cwd, *, name="history", native_id="native-session", version=3):
    root.mkdir(parents=True, exist_ok=True)
    path = root / (name + ".jsonl")
    records = [
        {
            "type": "session",
            "version": version,
            "id": native_id,
            "cwd": str(cwd),
            "timestamp": "2026-10-30T00:00:00Z",
        },
        {
            "type": "message",
            "id": "user1",
            "parentId": None,
            "message": {"role": "user", "content": "original question"},
        },
        {
            "type": "message",
            "id": "assistant1",
            "parentId": "user1",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "original reply"}],
            },
        },
    ]
    path.write_text("".join(json.dumps(record) + "\n" for record in records))
    return path


def test_native_history_is_read_only_and_stable(tmp_path):
    path = history_file(tmp_path / "sessions", tmp_path)
    before = path.read_bytes()
    histories, errors = scan_histories((path.parent,))
    assert not errors
    first = timeline(histories[path], "platform-session")
    assert first == timeline(read_history(path, (path.parent,)), "platform-session")
    assert [item["content"]["text"] for item in first] == [
        "original question",
        "original reply",
    ]
    assert path.read_bytes() == before


def test_partial_history_does_not_claim_complete(tmp_path):
    path = history_file(tmp_path, tmp_path)
    with path.open("a") as output:
        output.write('{"type":"message","id":')
    history = read_history(path, (tmp_path,))
    assert not history.complete
    assert len(timeline(history, "platform")) == 2
    with pytest.raises(AcpError, match="正在写入"):
        history.require_resumable()


def test_legacy_history_browses_without_migration(tmp_path):
    path = history_file(tmp_path, tmp_path, version=2)
    before = path.read_bytes()
    history = read_history(path, (tmp_path,))
    assert len(timeline(history, "platform")) == 2
    with pytest.raises(AcpError, match="迁移"):
        history.require_resumable()
    assert path.read_bytes() == before


def test_history_symlink_cannot_escape_source(tmp_path):
    outside = history_file(tmp_path / "outside", tmp_path)
    source = tmp_path / "source"
    source.mkdir()
    link = source / "escape.jsonl"
    link.symlink_to(outside)
    with pytest.raises(AcpError, match="超出"):
        read_history(link, (source,))


def test_branches_and_compaction_keep_original_nodes(tmp_path):
    path = history_file(tmp_path, tmp_path)
    records = [
        {
            "type": "message",
            "id": "branch",
            "parentId": "user1",
            "message": {"role": "assistant", "content": "other branch"},
        },
        {
            "type": "compaction",
            "id": "compaction",
            "parentId": "branch",
            "summary": "summary",
        },
    ]
    with path.open("a") as output:
        output.write("".join(json.dumps(record) + "\n" for record in records))
    items = timeline(read_history(path, (tmp_path,)), "platform")
    assert len(items) == 4
    assert items[2]["source"]["parentId"] == "user1"
    assert items[3]["content"]["nativeEntryType"] == "compaction"


def test_native_runtime_browses_without_execution_environment(tmp_path):
    async def run():
        agent = tmp_path / "agent"
        source = history_file(agent / "sessions", tmp_path)
        before = source.read_bytes()
        published = []

        async def publish(_runtime, notifications, **kwargs):
            published.extend(notifications)

        host = SimpleNamespace(
            session_namespace="fixture",
            runtime_id="pi",
            runtime_kv=SimpleNamespace(path=tmp_path / "state/runtime.json"),
            publish_runtime_notifications=publish,
        )
        provider = PiProvider()
        config = replace(
            await provider.validate_config(
                {"agentDir": str(agent), "cliPath": str(tmp_path / "missing-pi")}
            ),
            runtime_id="pi",
        )
        runtime = await provider.create_runtime(config, host)
        await runtime.start()
        try:
            rows = await runtime.list_sessions()
            assert len(rows) == 1
            assert not runtime.app.contexts and not runtime.environment_ready
            assert source.read_bytes() == before
            assert not (agent / "settings.json").exists()
            snapshot = await runtime.get_session_snapshot(rows[0].session_id)
            assert len(snapshot.items) == 2
            caps = await runtime.get_session_capabilities(rows[0].session_id)
            assert any(
                cap.capability_id == "session.recover" and cap.available
                for cap in caps.capabilities
            )
            assert any(
                cap.capability_id == "session.send_message" and not cap.available
                for cap in caps.capabilities
            )
            state = await runtime.get_session_state(rows[0].session_id)
            values = {
                "sessionId": rows[0].session_id,
                "operationId": "resume1",
                "expectedGeneration": state.metadata["ownerGeneration"],
                "sourceRevision": state.metadata["sourceRevision"],
            }
            with pytest.raises(AcpError, match="退出"):
                await runtime._begin_resume(values)
            assert not runtime.app.contexts
            values["cliExited"] = True
            values["sourceRevision"] = "stale"
            with pytest.raises(AcpError, match="变化"):
                await runtime._begin_resume(values)
            assert source.read_bytes() == before
            await runtime.sync.flush()
            published_before = len(published)
            appended = {
                "type": "message",
                "id": "cli-increment",
                "parentId": "assistant1",
                "message": {"role": "user", "content": "incremental update"},
            }
            with source.open("a") as output:
                output.write(json.dumps(appended) + "\n")
            await runtime.scan()
            await runtime.sync.flush()
            incremental = published[published_before:]
            assert not any(item["method"] == "timeline.sync" for item in incremental)
            assert (
                sum(item["method"] == "timeline.itemUpsert" for item in incremental)
                == 1
            )
            assert not runtime.app.contexts
        finally:
            await runtime.stop()

    asyncio.run(run())


def test_legacy_gateway_configuration_keeps_managed_source():
    config = asyncio.run(
        PiProvider().validate_config(
            {"modelGateway": {"baseUrl": "http://127.0.0.1:9/v1", "apiKey": "fixture"}}
        )
    )
    assert config.values["executionMode"] == "managed"


def test_legacy_repeated_messages_have_distinct_stable_identities(tmp_path):
    path = history_file(tmp_path, tmp_path, version=1)
    entry = {"type": "message", "message": {"role": "user", "content": "same text"}}
    with path.open("a") as output:
        output.write((json.dumps(entry) + "\n") * 2)
    items = timeline(read_history(path, (tmp_path,)), "platform")
    assert len({item["id"] for item in items}) == len(items) == 4


def test_native_user_correlation_survives_canonical_projection(tmp_path):
    path = history_file(tmp_path, tmp_path)
    entry = {
        "type": "message",
        "id": "aa-user",
        "parentId": "assistant1",
        "message": {
            "role": "user",
            "content": "continued",
            "aaClientMessageId": "message-id",
        },
    }
    with path.open("a") as output:
        output.write(json.dumps(entry) + "\n")
    item = timeline(read_history(path, (tmp_path,)), "platform")[-1]
    assert item["source"]["clientMessageId"] == "message-id"
    assert item["source"]["itemId"] == "aa-user"
    streaming = Projection("platform", "generation", runtime_type="pi").apply(
        {
            "sessionUpdate": "user_message_chunk",
            "messageId": "message-id",
            "aaProjectionVerified": True,
            "content": {"type": "text", "text": "continued"},
            "_meta": {"aa": {"clientMessageId": "message-id"}},
        }
    )
    assert streaming["source"]["clientMessageId"] == item["source"]["clientMessageId"]


def test_permission_channel_error_blocks_tools_and_user_bash():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is not installed")
    guard = (
        Path(__file__).parents[1] / "connector/runtimes/acp/profiles/pi/permissions.mjs"
    )
    script = """
const {default:guard}=await import(process.argv[1]);
const handlers={};guard({on:(name,handler)=>handlers[name]=handler});
const ctx={sessionManager:{getSessionId:()=> 'session'},ui:{confirm:async()=>{throw new Error('channel lost')}}};
const tool=await handlers.tool_call({toolName:'write',toolCallId:'call',input:{}},ctx);
const bash=await handlers.user_bash({command:'touch forbidden'},ctx);
if(tool.block!==true||bash.result.exitCode!==1)process.exit(1);
"""
    subprocess.run(
        [node, "--input-type=module", "-e", script, guard.resolve().as_uri()],
        check=True,
        timeout=20,
    )


def test_local_cli_binds_its_own_exported_sdk(tmp_path, monkeypatch):
    sdk = tmp_path / "lib/node_modules" / PACKAGE
    (sdk / "dist/bundle").mkdir(parents=True)
    (sdk / "package.json").write_text(
        json.dumps(
            {"name": PACKAGE, "version": "1.4.0", "bin": {"pi": "dist/bundle/cli.js"}}
        )
    )
    (sdk / "dist/index.js").write_text("export const VERSION='1.4.0'")
    target = sdk / "dist/bundle/cli.js"
    target.write_text("// native CLI")
    (tmp_path / "bin").mkdir()
    cli = tmp_path / "bin/pi"
    cli.symlink_to(target)
    node = tmp_path / "bin/node"
    node.write_text("// node")
    monkeypatch.setattr(
        shutil, "which", lambda name: str(cli if name == "pi" else node)
    )
    monkeypatch.setattr(
        subprocess,
        "check_output",
        lambda *_args, **_kwargs: json.dumps({"path": str(node), "version": "22.23.2"}),
    )
    installation = resolve_local({})
    assert installation.sdk == sdk
    assert installation.cli == target
    # An arbitrary wrapper is not evidence that the active Node's other Pi is the same installation.
    cli.unlink()
    cli.write_text('#!/bin/sh\nexec some-other-pi "$@"\n')
    with pytest.raises(AcpError, match="无法将此 pi 入口绑定"):
        resolve_local({})
