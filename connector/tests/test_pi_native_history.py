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


def test_resynchronize_republishes_aa_sessions_not_yet_in_native_index(tmp_path):
    from dataclasses import asdict

    from connector.runtimes.acp.domain.definitions import Workspace
    from connector.runtimes.acp.domain.sessions import SessionBinding

    async def run():
        agent = tmp_path / "agent"
        history_file(agent / "sessions", tmp_path)

        async def publish(_runtime, notifications, **kwargs):
            pass

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
            native = (await runtime.list_sessions())[0].session_id
            # A live AA-created session has a binding but no native source row yet.
            binding = SessionBinding("aa-live", "pi", "fixture", Workspace(str(tmp_path), str(tmp_path)), "g", "g", "not-yet-indexed", attachment="attached", foreground="idle")
            runtime.app.store.put("binding", "aa-live", asdict(binding))
            events = []
            runtime.app._emit = lambda method, params: events.append((method, params["sessionId"]))
            await runtime.resynchronize()
            for method in ("session.meta.upsert", "session.state.updated", "runtime.capability.updated"):
                assert (method, "aa-live") in events
            assert ("runtime.capability.updated", native) in events
            events.clear()
            await runtime.resynchronize(native)
            assert all(session != "aa-live" for _method, session in events)
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


def test_native_attachment_presentation_survives_scan_without_execution_paths(tmp_path):
    path = history_file(tmp_path, tmp_path)
    attachment = {"fileId": "file_note", "name": "note.txt", "mediaType": "text/plain", "sha256": "a" * 64}
    record = {"type": "message", "id": "attached", "parentId": "assistant1", "message": {
        "role": "user", "content": [{"type": "text", "text": 'read\n[resource_link name="note.txt" path="/private/cache/file"]'}],
        "aaClientMessageId": "attached-id", "aaDisplayText": "read", "aaAttachments": [attachment],
    }}
    with path.open("a") as output:
        output.write(json.dumps(record) + "\n")
    before = path.read_bytes()
    item = timeline(read_history(path, (tmp_path,)), "platform")[-1]
    assert item["content"]["text"] == "read"
    assert item["content"]["attachments"] == [attachment]
    assert item["source"]["clientMessageId"] == "attached-id"
    assert path.read_bytes() == before


def test_text_only_model_rejects_images_before_dispatch_and_tracks_model_changes(tmp_path):
    from connector.runtimes.acp.domain.definitions import PromptRejectedBeforeDispatch
    from connector.runtimes.acp.profiles.pi.client import PiClient

    async def callback(*_args):
        raise AssertionError("Rejected input must not execute or publish a user message")

    client = PiClient(callback, callback, agent_dir=tmp_path)
    option = {"id": "model", "category": "model", "currentValue": "provider/text", "_meta": {"aa": {
        "modelInputModalities": {"provider/text": ["text"], "provider/vision": ["text", "image"]},
    }}}
    client.configuration["s"] = [option]
    with pytest.raises(PromptRejectedBeforeDispatch, match="不支持图片"):
        asyncio.run(client.prompt("s", "describe", "message", [{"type": "image"}]))
    assert not client.active_messages
    option["currentValue"] = "provider/vision"
    client.validate_input("s", [{"type": "image"}])
    assert client.attachment_metadata("s")["inputModalities"] == ["text", "image"]


def test_attachment_first_message_title_does_not_expose_execution_paths(tmp_path):
    path = history_file(tmp_path, tmp_path)
    entries = [json.loads(line) for line in path.read_text().splitlines()]
    entries[1]["message"].update(
        content='clean title\n[resource_link name="note.txt" path="/private/cache"]',
        aaDisplayText="clean title",
    )
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
    before = path.read_bytes()
    assert read_history(path, (tmp_path,)).title == "clean title"
    assert path.read_bytes() == before


def test_sdk_bridge_binds_identity_to_each_queued_message(tmp_path):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is not installed")
    sdk = tmp_path / "sdk.mjs"
    sdk.write_text("""
export class SessionManager {}
export const VERSION='fixture';
export async function createAgentSessionFromServices() {
 const messages=[];
 return {session:{agent:{messages,normalizePromptInput:x=>typeof x==='string'?[{role:'user',content:[{type:'text',text:x}]}]:Array.isArray(x)?x:[x],prompt:async xs=>messages.push(...xs),steer:m=>messages.push(m),followUp:m=>messages.push(m)}}};
}
""")
    bridge = tmp_path / "bridge.mjs"
    source = (Path(__file__).parents[1] / "connector/runtimes/acp/profiles/pi/sdk-bridge.mjs").read_text()
    bridge.write_text(source.replace("__AA_PI_SDK_URL__", sdk.as_uri()))
    script = """
import assert from 'node:assert/strict';
const {aaWithMessage,createAgentSessionFromServices}=await import(process.argv[1]);
const {session:{agent}}=await createAgentSessionFromServices({});
const attachment={fileId:'file_note',name:'note.txt',mediaType:'text/plain'};
await Promise.all(['original','steer-one','steer-two'].map(id=>aaWithMessage({aa:{clientMessageId:id},prompt:[{type:'text',text:id},{type:'resource_link',_meta:{aa:{attachment}}}]},async()=>{
 await Promise.resolve();
 if(id==='original')await agent.prompt('expanded original');
 else agent.steer({role:'user',content:[{type:'text',text:'same expanded text'}]});
})));
assert.deepEqual(agent.messages.map(m=>m.aaClientMessageId),['original','steer-one','steer-two']);
assert.deepEqual(agent.messages.map(m=>m.aaDisplayText),['original','steer-one','steer-two']);
assert.deepEqual(agent.messages[2].aaAttachments,[attachment]);
agent.steer({role:'user',content:[]});
assert.equal(agent.messages[3].aaClientMessageId,undefined);
"""
    subprocess.run([node, "--input-type=module", "-e", script, bridge.as_uri()], check=True, timeout=20)


def test_sdk_bridge_does_not_label_extension_messages_as_aa_input(tmp_path):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is not installed")
    sdk = tmp_path / "sdk.mjs"
    sdk.write_text("""
export class SessionManager {}
export async function createAgentSessionFromServices() {
 const messages=[];
 const agent={messages,normalizePromptInput:x=>typeof x==='string'?[{role:'user',content:[{type:'text',text:x}]}]:Array.isArray(x)?x:[x],steer:m=>messages.push(m),followUp:m=>messages.push(m),prompt:async function(xs){
  messages.push(...xs);
  if(xs.some(m=>m.aaClientMessageId)) { await Promise.resolve();this.followUp({role:'user',content:[{type:'text',text:'extension-after'}]}); }
 }};
 const session={agent,prompt:async function(text,options){
  if(options?.source==='rpc') await this.prompt('extension-before',{source:'extension'});
  return agent.prompt(text);
 }};
 return {session};
}
""")
    bridge = tmp_path / "bridge.mjs"
    source = (Path(__file__).parents[1] / "connector/runtimes/acp/profiles/pi/sdk-bridge.mjs").read_text()
    bridge.write_text(source.replace("__AA_PI_SDK_URL__", sdk.as_uri()))
    script = """
import assert from 'node:assert/strict';
const {aaWithMessage,createAgentSessionFromServices}=await import(process.argv[1]);
const {session}=await createAgentSessionFromServices({});
await aaWithMessage({aa:{clientMessageId:'aa-original'},prompt:[{type:'text',text:'original'}]},()=>session.prompt('expanded original',{source:'rpc'}));
const xs=session.agent.messages;
assert.deepEqual(xs.map(m=>m.content[0].text),['extension-before','expanded original','extension-after']);
assert.deepEqual(xs.map(m=>m.aaClientMessageId),[undefined,'aa-original',undefined]);
assert.deepEqual(xs.map(m=>m.aaDisplayText),[undefined,'original',undefined]);
assert.equal(xs[0].aaAttachments,undefined);assert.equal(xs[2].aaAttachments,undefined);
"""
    subprocess.run([node, "--input-type=module", "-e", script, bridge.as_uri()], check=True, timeout=20)


@pytest.mark.parametrize("rejected,expected", [(True, "failed"), (False, "cancelled")])
def test_rejected_input_turn_outcome_matches_receipt_and_stays_usable(tmp_path, rejected, expected):
    from dataclasses import asdict

    from connector.runtimes.acp.application.sessions import SessionService
    from connector.runtimes.acp.domain.definitions import (
        AgentProfile,
        LaunchDefinition,
        PromptRejectedBeforeDispatch,
        Workspace,
        fingerprint,
    )
    from connector.runtimes.acp.domain.sessions import SessionBinding
    from connector.runtimes.acp.infrastructure.persistence import Store

    async def prompt(*_args, **_kwargs):
        if rejected:
            raise PromptRejectedBeforeDispatch("image_input_unsupported", "model rejects images")
        return {"stopReason": "cancelled"}

    async def run():
        store = Store(tmp_path / "probe.sqlite")
        app = SessionService(store, AgentProfile(id="pi", title="Pi"), LaunchDefinition("unused", (), "fixture"), None, Projection, tmp_path)
        binding = SessionBinding("s", "pi", "fixture", Workspace(str(tmp_path), str(tmp_path)), "g", "g", "native", attachment="attached", foreground="running")
        store.put("binding", "s", asdict(binding))
        operation, _ = app.prompts.prepare("s", "message", "content")
        events = []
        app._emit = lambda method, params: events.append((method, params))
        context = {"closing": False, "client": SimpleNamespace(prompt=prompt), "agentSessionId": "native", "generation": "g", "projection": Projection("s", "g", runtime_type="pi")}
        app.sessions["s"] = context
        app.active_runs.add("s")
        await app._run_prompt(context, operation, "content", None)
        assert [value["outcome"] for method, value in events if method == "session.turnEnded"] == [expected]
        row = store.require("prompt", fingerprint(["s", "message"]))
        assert row["message_accepted"] is not rejected
        assert app.state("s")["status"] == "idle"
        assert not context["closing"]
        if rejected:
            assert row["failure"]["code"] == "image_input_unsupported"
        store.db.close()

    asyncio.run(run())


@pytest.mark.parametrize("rejected", [True, False])
def test_settled_first_message_moves_later_interactions_to_session(tmp_path, rejected):
    from dataclasses import asdict

    from connector.runtimes.acp.application.sessions import SessionService
    from connector.runtimes.acp.domain.definitions import (
        AgentProfile,
        LaunchDefinition,
        PromptRejectedBeforeDispatch,
        Workspace,
    )
    from connector.runtimes.acp.domain.operations import CreationOperation
    from connector.runtimes.acp.domain.sessions import SessionBinding
    from connector.runtimes.acp.infrastructure.persistence import Store

    async def prompt(*_args, **_kwargs):
        if rejected:
            raise PromptRejectedBeforeDispatch("image_input_unsupported", "model rejects images")
        return {"stopReason": "end_turn"}

    async def run():
        store = Store(tmp_path / "probe.sqlite")
        app = SessionService(store, AgentProfile(id="pi", title="Pi"), LaunchDefinition("unused", (), "fixture"), None, Projection, tmp_path)
        binding = SessionBinding("s", "pi", "fixture", Workspace(str(tmp_path), str(tmp_path)), "g", "g", "native", attachment="attached", foreground="running")
        store.put("binding", "s", asdict(binding))
        store.put("creation", "op", asdict(CreationOperation("op", "s", "digest", phase="submitting", agent_session_created=True, client_message_id="message")))
        operation, _ = app.prompts.prepare("s", "message", "content")
        app._emit = lambda *_args: None
        app.interactions.publish_notice = lambda *_args: None
        context = {"scopeId": "op", "sessionId": "s", "closing": False, "client": SimpleNamespace(prompt=prompt), "agentSessionId": "native", "generation": "g", "projection": Projection("s", "g", runtime_type="pi")}
        app.sessions["s"] = context
        app.active_runs.add("s")
        await app._run_prompt(context, operation, "content", "op")
        creation = app.creation_view("op")
        assert creation["messageAccepted"] is not rejected
        assert (creation["failure"] or {}).get("code") == ("image_input_unsupported" if rejected else None)
        assert app.state("s")["status"] == "idle"
        # The session stays usable either way; the next turn's approval belongs to it.
        assert context["scopeId"] == "s"
        waiting = asyncio.create_task(app.interactions.open(context, "native", "permission", {"options": []}))
        await asyncio.sleep(0)
        assert app.creation_view("op")["interactions"] == []
        assert len(app.interactions.views("s")) == 1
        app.interactions.close_scope("s")
        assert await waiting == {"action": "cancel"}
        store.db.close()

    asyncio.run(run())
