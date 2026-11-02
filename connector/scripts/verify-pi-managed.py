"""Actual npm OpenMA/Pi execution against a local SSE model, without paid requests."""

import argparse
import asyncio
import hashlib
import json
import re
import sys
import tempfile
import threading
import time
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

from connector.runtime_protocol.models import RuntimeAttachmentContent
from connector.runtime_protocol.workflows import RuntimeWorkflowRequest
from connector.runtimes.acp.profiles.pi.provider import PiProvider

parser = argparse.ArgumentParser(
    description="Verify the published OpenMA/Pi runtime with a local model fixture; no provider credentials are used."
)
parser.add_argument(
    "--scenario",
    choices=[
        "allow",
        "deny",
        "readonly",
        "attachment",
        "steer",
        "slow",
        "reasoning",
        "interrupt",
    ],
    default="allow",
)
parser.add_argument(
    "--cache-root",
    type=Path,
    help="Reuse only managed runtime dependencies across scenarios",
)
args = parser.parse_args()
scenario = args.scenario
root = Path(tempfile.mkdtemp(prefix="aa-pi-npm-qa-"))
requests = []
attachment = b"AA_PI_ATTACHMENT_PRIVATE_PROOF_7e39f1"


class FixtureServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if isinstance(sys.exception(), (BrokenPipeError, ConnectionResetError)):
            return  # Expected when the cancellation scenario aborts its model request.
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(body)
        if scenario in {"slow", "interrupt"}:
            time.sleep(5)
        had_result = any(item.get("role") == "tool" for item in body["messages"]) or (
            scenario == "interrupt" and len(requests) > 1
        )
        if had_result:
            deltas = [{"role": "assistant", "content": "AA_PI_OK"}]
            reason = "stop"
        else:
            deltas = [
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_fixture",
                            "type": "function",
                            "function": {
                                "name": "read" if scenario == "attachment" else "write",
                                "arguments": json.dumps(
                                    {
                                        "path": json.loads(
                                            re.search(
                                                r'path=("[^"]+")', str(body["messages"])
                                            ).group(1)
                                        )
                                    }
                                    if scenario == "attachment"
                                    else {
                                        "path": str(root / "workspace" / "proof.txt"),
                                        "content": "AA_PI_TOOL_OK",
                                    }
                                ),
                            },
                        }
                    ],
                }
            ]
            reason = "tool_calls"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for delta in deltas:
            self.wfile.write(
                (
                    "data: "
                    + json.dumps(
                        {
                            "id": "fixture",
                            "object": "chat.completion.chunk",
                            "created": 1,
                            "model": "fixture",
                            "choices": [
                                {"index": 0, "delta": delta, "finish_reason": None}
                            ],
                        }
                    )
                    + "\n\n"
                ).encode()
            )
        self.wfile.write(
            (
                "data: "
                + json.dumps(
                    {
                        "id": "fixture",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "fixture",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": reason}],
                        "usage": {
                            "prompt_tokens": 1,
                            "completion_tokens": 1,
                            "total_tokens": 2,
                        },
                    }
                )
                + "\n\ndata: [DONE]\n\n"
            ).encode()
        )
        self.wfile.flush()


server = FixtureServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()


async def main():
    (root / "workspace").mkdir()
    state_root = (args.cache_root or root / "state").resolve()
    state_root.mkdir(parents=True, exist_ok=True)

    async def publish(*args, **kwargs):
        pass

    async def download(session_id, file_id):
        return RuntimeAttachmentContent(
            file_id,
            "proof.txt",
            "text/plain",
            attachment,
            hashlib.sha256(attachment).hexdigest(),
        )

    host = SimpleNamespace(
        session_namespace="fixture:" + root.name,
        runtime_id="rti_pifixture00000000000000000000001",
        runtime_kv=SimpleNamespace(path=state_root / "runtime.json"),
        publish_runtime_notifications=publish,
        attachment_download=download,
    )
    provider = PiProvider()
    config = await provider.validate_config(
        {
            "modelGateway": {
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                "apiKey": "fixture-key",
            },
            "customModels": [
                {
                    "modelId": "fixture",
                    "displayName": "Fixture",
                    **(
                        {"efforts": [{"effortId": "high", "displayName": "High"}]}
                        if scenario == "reasoning"
                        else {}
                    ),
                }
            ],
        }
    )
    config = replace(config, runtime_id=host.runtime_id)
    print("Installing published npm runtime", flush=True)
    runtime = await provider.create_runtime(config, host)
    await runtime.start()
    await runtime.wait_ready()
    print("Installed and ready", flush=True)
    app = runtime.app

    async def wait(predicate):
        async with asyncio.timeout(80):
            while not predicate():
                await asyncio.sleep(0.03)

    try:
        app.prepare(
            {
                "preparationId": "prepare",
                "clientPreparationId": "client",
                "cwd": str(root / "workspace"),
            }
        )
        await wait(
            lambda: (
                app.preparation_view("prepare")["phase"]
                in {"ready", "failed", "outcome_unknown"}
            )
        )
        prepared = app.preparation_view("prepare")
        print("Preparation:", prepared["phase"], prepared.get("failure"), flush=True)
        assert prepared["phase"] == "ready", prepared
        choices = prepared["catalog"]["models"]
        assert choices, prepared
        selections = {
            "model": choices[0]["selectionId"],
            "permission": "readonly" if scenario == "readonly" else "ask",
        }
        if scenario == "reasoning":
            assert choices[0]["reasoningItems"]
            selections["model"] = next(
                item["selectionId"]
                for item in choices[0]["reasoningItems"]
                if item["id"] == "high"
            )
        common = {
            "preparationId": "prepare",
            "createOperationId": "create",
            "sessionId": "session",
            "platformSessionId": "session",
            "configuration": {},
            "selections": selections,
        }
        reserved = app.reserve(
            {
                **common,
                "expectedRevision": prepared["revision"],
                "catalogRevision": prepared["catalogRevision"],
            }
        )
        assert reserved["reserved"], reserved
        values = {
            **common,
            "clientMessageId": "first",
            "content": "Read the attached file."
            if scenario == "attachment"
            else "Write the proof file with the write tool.",
        }
        if scenario == "attachment":
            values["attachments"] = [
                {
                    "fileId": "file_fixture",
                    "name": "proof.txt",
                    "mediaType": "text/plain",
                    "size": len(attachment),
                    "sha256": hashlib.sha256(attachment).hexdigest(),
                }
            ]
        await runtime.execute_workflow(RuntimeWorkflowRequest("begin_creation", values))

        async def answer():
            async with asyncio.timeout(80):
                while True:
                    state = app.creation_view("create")
                    assert state["phase"] not in {
                        "failed",
                        "rejected",
                        "outcome_unknown",
                    }, state
                    for notice in app.interactions.views("create"):
                        if notice["status"] == "open":
                            print("Answering interaction:", notice["kind"], flush=True)
                            assert notice["kind"] == "approval", notice
                            if scenario == "steer":
                                native = app.store.require("binding", "session")[
                                    "agent_session_id"
                                ]
                                steered = await runtime.steer_turn(
                                    "session",
                                    native,
                                    "STEERING_PRIVATE_MARKER",
                                    client_message_id="steer-first",
                                )
                                assert steered.ok, steered
                                duplicate = await runtime.steer_turn(
                                    "session",
                                    native,
                                    "STEERING_PRIVATE_MARKER",
                                    client_message_id="steer-first",
                                )
                                assert duplicate.ok
                                normal = await app.submit(
                                    "session", "steer-first", "STEERING_PRIVATE_MARKER"
                                )
                                assert normal["messageAccepted"] is True
                                print(
                                    "Running-turn steering and duplicate receipt: PASSED",
                                    flush=True,
                                )
                            app.interactions.respond(
                                "create",
                                {
                                    "interactionId": notice["interactionId"],
                                    "ownerGeneration": notice["ownerGeneration"],
                                    "requestRevision": notice["requestRevision"],
                                    "responseOperationId": "answer-"
                                    + notice["interactionId"],
                                    "actionId": "deny"
                                    if scenario == "deny"
                                    else "allow",
                                },
                            )
                    if app.state("session")["status"] == "idle" and requests:
                        return
                    await asyncio.sleep(0.03)

        if scenario == "interrupt":
            await wait(
                lambda: (
                    app.creation_view("create")["messageAccepted"] is True
                    and bool(requests)
                )
            )
            await runtime.interrupt_session("session")
            await wait(lambda: app.state("session")["status"] == "idle")
            print(
                "Interrupt in-flight model request before tool execution: PASSED",
                flush=True,
            )
        else:
            await answer()
        print("Creation:", app.creation_view("create")["messageAccepted"], flush=True)
        assert app.creation_view("create")["messageAccepted"] is True
        if scenario == "reasoning":
            assert requests[0].get("reasoning_effort") == "high"
        if scenario == "attachment":
            assert attachment.decode() in str(requests[-1]["messages"])
        elif scenario in {"readonly", "deny", "interrupt"}:
            assert not (root / "workspace" / "proof.txt").exists()
        else:
            assert (root / "workspace" / "proof.txt").read_text() == "AA_PI_TOOL_OK"
        snapshot = await runtime.get_session_snapshot("session")
        if scenario != "interrupt":
            assert any("AA_PI_OK" in str(item.content) for item in snapshot.items), (
                snapshot
            )
        assert all(item.source["runtime"] == "pi" for item in snapshot.items)
        users = [item for item in snapshot.items if item.role == "user"]
        assert users and any(
            user.content["clientMessageId"] == "first" for user in users
        )
        if scenario == "steer":
            assert any(
                user.content["clientMessageId"] == "steer-first" for user in users
            )
            assert "STEERING_PRIVATE_MARKER" in str(requests[-1]["messages"])
        if scenario == "attachment":
            assert users[0].content["attachments"][0]["fileId"] == "file_fixture"
        if scenario == "readonly":
            native = app.store.require("binding", "session")["agent_session_id"]
            command_result = await runtime.execute_command(
                "session",
                "bash",
                external_session_id=native,
                args=(
                    "printf BYPASS > "
                    + str(root / "workspace" / "readonly-bypass.txt"),
                ),
            )
            assert (
                command_result.ok is False
                and command_result.code == "permission_denied"
            )
            assert not (root / "workspace" / "readonly-bypass.txt").exists()
            rejected = await runtime.start_turn(
                "session",
                native,
                "/bash printf BYPASS > " + str(root / "workspace" / "raw-bypass.txt"),
                client_message_id="raw-bash-refused",
            )
            assert not rejected.ok and app.state("session")["status"] == "idle"
            assert not (root / "workspace" / "raw-bypass.txt").exists()
            print("Read-only native bash command: PASSED", flush=True)
        print(
            "Real OpenMA + Pi SDK, local model SSE, tool permission, timeline and acceptance: PASSED",
            flush=True,
        )
        if scenario == "allow":
            output_file = root / "workspace" / "quoted-command.txt"
            raw = '/bash printf "%s" "value with spaces" > "' + str(output_file) + '"'
            native = app.store.require("binding", "session")["agent_session_id"]
            command_task = asyncio.create_task(
                runtime.execute_command(
                    "session",
                    "bash",
                    external_session_id=native,
                    raw=raw,
                    args=("not-the-raw-input",),
                )
            )
            await wait(
                lambda: any(
                    item["status"] == "open"
                    for item in app.interactions.views("session")
                )
            )
            notice = next(
                item
                for item in app.interactions.views("session")
                if item["status"] == "open"
            )
            assert (
                notice["metadata"]["toolCall"]["rawInput"]["command"] == raw[5:].strip()
            )
            app.interactions.respond(
                "session",
                {
                    "interactionId": notice["interactionId"],
                    "ownerGeneration": notice["ownerGeneration"],
                    "requestRevision": notice["requestRevision"],
                    "responseOperationId": "allow-quoted-command",
                    "actionId": "allow",
                },
            )
            assert (await command_task).ok
            assert output_file.read_text() == "value with spaces"
            invalid = await runtime.execute_command(
                "session", "status", external_session_id=native, raw="/bash echo bypass"
            )
            assert not invalid.ok and app.state("session")["status"] == "idle"
            print(
                "Native command quoting, approval and mismatched-command rejection: PASSED",
                flush=True,
            )
        previous_max_order = max(
            item.order_seq
            for item in (await runtime.get_session_snapshot("session")).items
        )
        generation = app.store.require("binding", "session")["owner_generation"]
        await app.close_session("session", generation)
        recovered = await app.recover("session")
        assert recovered["status"] == "idle", recovered
        native = app.store.require("binding", "session")["agent_session_id"]
        began = time.monotonic()
        result = await runtime.start_turn(
            "session", native, "Reply again.", client_message_id="second"
        )
        assert result.ok and result.result["messageAccepted"] is True, result
        if scenario == "slow":
            assert time.monotonic() - began < 3
        await wait(lambda: app.state("session")["status"] == "idle")
        from connector.runtimes.acp.domain.definitions import fingerprint

        assert (
            app.store.get("prompt", fingerprint(["session", "second"]))[
                "message_accepted"
            ]
            is True
        )
        after = await runtime.get_session_snapshot("session")
        later = next(
            item
            for item in after.items
            if item.content.get("clientMessageId") == "second"
        )
        assert later.order_seq > previous_max_order
        print(
            "Close, resume same native session, subsequent message: PASSED", flush=True
        )
    finally:
        await runtime.stop()
        server.shutdown()
    print("QA output:", root, flush=True)


asyncio.run(main())
