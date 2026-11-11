"""Actual ACP Agent execution against a local model fixture, without paid requests.

Each registered Agent says how to point it at the local model; the scenarios
are shared. ``--record`` saves the raw ACP traffic as replay fixtures.
"""

import argparse
import asyncio
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from types import SimpleNamespace

from connector.runtime_protocol.models import RuntimeAttachmentContent
from connector.runtime_protocol.workflows import RuntimeWorkflowRequest
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.profiles.hermes.provider import HermesProvider

SCENARIOS = ("allow", "deny", "attachment", "image", "steer", "interrupt", "resume")
RUNTIME_ID = "rti_acpagentfixture0000000000000001"
REPLY = "AA_AGENT_OK"
PROOF = "AA_AGENT_TOOL_OK"
STEER = "AA_AGENT_STEER_MARKER"
TEXT_ATTACHMENT = b"AA_AGENT_ATTACHMENT_PROOF_41c7"
# 1x1 transparent PNG.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)



@dataclass(frozen=True)
class AgentFixture:
    """How one Agent is pointed at the local model and cleaned up afterwards."""

    runtime_type: str
    display_name: str
    command: str
    provider: object
    write_tool: str
    permissions: tuple[str, ...]
    configure: object
    cleanup: object


def hermes_configure(home: Path, model_url: str, executable: Path) -> dict:
    (home / "config.yaml").write_text(
        json.dumps(
            {
                "model": {
                    "default": "fixture",
                    "provider": "custom",
                    "base_url": model_url,
                    "api_key": "fixture-key",
                },
                "compression": {"enabled": False},
                "memory": {"memory_enabled": False, "user_profile_enabled": False},
            }
        ),
        encoding="utf-8",
    )
    return {"cliPath": str(executable), "hermesHome": str(home)}


def hermes_cleanup(home: Path, executable: Path) -> None:
    # Hermes' gateway daemon idles for minutes; the temporary home must not outlive us.
    subprocess.run(
        [str(executable), "gateway", "stop"],
        check=False,
        env={**os.environ, "HERMES_HOME": str(home)},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=60,
    )


AGENTS = {
    "hermes": AgentFixture(
        "hermes",
        "Hermes",
        "hermes",
        HermesProvider,
        "write_file",
        ("ask", "workspace_session", "session"),
        hermes_configure,
        hermes_cleanup,
    ),
}

parser = argparse.ArgumentParser(
    description="Verify a local ACP Agent through AA's runtime; no provider credentials are used."
)
parser.add_argument("--definition", choices=sorted(AGENTS), default="hermes")
parser.add_argument("--scenario", choices=[*SCENARIOS, "all"], default="all")
parser.add_argument("--executable", help="Agent executable; defaults to the one on PATH")
parser.add_argument("--record", type=Path, help="save each scenario's ACP traffic in this directory")
args = parser.parse_args()


class FixtureServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer calls getfqdn() even for 127.0.0.1, which can stall on macOS.
        TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]

    def handle_error(self, request, client_address):
        if not isinstance(sys.exception(), (BrokenPipeError, ConnectionResetError)):
            super().handle_error(request, client_address)


def make_model(scenario, root, tool):
    agent_requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *values):
            pass

        def reply(self, body, message, finish):
            if not body.get("stream"):
                data = json.dumps(
                    {
                        "id": "fixture",
                        "object": "chat.completion",
                        "created": 1,
                        "model": "fixture",
                        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

            def chunk(delta, reason):
                value = {
                    "id": "fixture",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "fixture",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": reason}],
                }
                self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())

            delta = dict(message)
            if "tool_calls" in delta:
                delta["tool_calls"] = [{"index": 0, **delta["tool_calls"][0]}]
            chunk(delta, None)
            chunk({}, finish)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

        def do_GET(self):
            data = json.dumps({"object": "list", "data": [{"id": "fixture", "object": "model"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if not body.get("tools"):
                # Agents' auxiliary calls, such as session titles.
                self.reply(body, {"role": "assistant", "content": "Fixture title"}, "stop")
                return
            agent_requests.append(body)
            if scenario == "interrupt" and len(agent_requests) == 1:
                time.sleep(8)
            last_user = max(i for i, item in enumerate(body["messages"]) if item.get("role") == "user")
            answered = any(item.get("role") == "tool" for item in body["messages"][last_user:])
            if answered or scenario in {"attachment", "image", "interrupt"}:
                self.reply(body, {"role": "assistant", "content": REPLY}, "stop")
                return
            call = {
                "id": f"call_fixture_{len(agent_requests)}",
                "type": "function",
                "function": {
                    "name": tool,
                    "arguments": json.dumps(
                        {"path": str(root / "workspace" / "proof.txt"), "content": PROOF}
                    ),
                },
            }
            self.reply(
                body, {"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls"
            )

    server = FixtureServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, agent_requests


async def wait(predicate, seconds=120):
    async with asyncio.timeout(seconds):
        while not predicate():
            await asyncio.sleep(0.03)


async def run_scenario(scenario, fixture, executable):
    started = time.monotonic()
    print(f"{fixture.display_name} scenario {scenario}: starting", flush=True)
    root = Path(tempfile.mkdtemp(prefix=f"aa-{fixture.runtime_type}-qa-"))
    (root / "workspace").mkdir()
    (root / "state").mkdir()
    home = root / "agent-home"
    home.mkdir()
    server, requests = make_model(scenario, root, fixture.write_tool)
    instance = fixture.configure(home, f"http://127.0.0.1:{server.server_port}/v1", executable)
    recording = []
    if args.record:
        AgentClient.stream_observers = (
            lambda event: recording.append({"direction": event.direction.value, "message": event.message}),
        )
    content = PNG if scenario == "image" else TEXT_ATTACHMENT
    name, media = ("pixel.png", "image/png") if scenario == "image" else ("proof.txt", "text/plain")

    async def publish(*values, **options):
        pass

    async def download(session_id, file_id):
        return RuntimeAttachmentContent(file_id, name, media, content, hashlib.sha256(content).hexdigest())

    host = SimpleNamespace(
        session_namespace="fixture:" + root.name,
        runtime_id=RUNTIME_ID,
        runtime_kv=SimpleNamespace(path=root / "state" / "runtime.json"),
        publish_runtime_notifications=publish,
        attachment_download=download,
    )
    provider = fixture.provider()
    config = replace(await provider.validate_config(instance), runtime_id=RUNTIME_ID)
    runtime = await provider.create_runtime(config, host)
    app = runtime.app
    try:
        await runtime.start()
        app.prepare({"preparationId": "prepare", "clientPreparationId": "client", "cwd": str(root / "workspace")})
        await wait(lambda: app.preparation_view("prepare")["phase"] in {"ready", "failed", "outcome_unknown"})
        prepared = app.preparation_view("prepare")
        print("Preparation:", prepared["phase"], prepared.get("failure"), flush=True)
        assert prepared["phase"] == "ready", prepared
        models = prepared["catalog"]["models"]
        assert models and all(item["id"] and item["displayName"] for item in models), prepared
        for effort in models[0]["reasoningItems"]:
            assert effort["id"] and effort["displayName"] and effort["selectionId"], effort
        permissions = await runtime.list_permission_catalog()
        assert tuple(item.id for item in permissions.permissions) == fixture.permissions
        common = {
            "preparationId": "prepare",
            "createOperationId": "create",
            "sessionId": "session",
            "platformSessionId": "session",
            "configuration": {},
            "selections": {"model": models[0]["selectionId"], "permission": "ask"},
        }
        assert app.reserve(
            {**common, "expectedRevision": prepared["revision"], "catalogRevision": prepared["catalogRevision"]}
        )["reserved"]
        values = {**common, "clientMessageId": "first", "content": "Write the proof file."}
        if scenario in {"attachment", "image"}:
            values["content"] = "Describe the attached file."
            values["attachments"] = [
                {
                    "fileId": "file_fixture",
                    "name": name,
                    "mediaType": media,
                    "size": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                }
            ]
        await runtime.execute_workflow(RuntimeWorkflowRequest("begin_creation", values))

        answered = {"count": 0}

        async def answer(scope, final):
            async with asyncio.timeout(120):
                while True:
                    view = app.creation_view("create")
                    assert view["phase"] not in {"failed", "rejected", "outcome_unknown"}, view
                    for notice in app.interactions.views(scope):
                        if notice["status"] != "open":
                            continue
                        actions = [item["actionId"] for item in notice["actions"]]
                        print("Approval options:", actions, flush=True)
                        assert "allow_once" in actions and "deny" in actions, notice
                        if scenario == "steer" and answered["count"] == 0:
                            native = app.store.require("binding", "session")["agent_session_id"]
                            steered = await runtime.steer_turn(
                                "session", native, STEER, client_message_id="steer-first"
                            )
                            assert steered.ok, steered
                            print("Running-turn steering: PASSED", flush=True)
                        app.interactions.respond(
                            scope,
                            {
                                "interactionId": notice["interactionId"],
                                "ownerGeneration": notice["ownerGeneration"],
                                "requestRevision": notice["requestRevision"],
                                "responseOperationId": "answer-" + notice["interactionId"],
                                "actionId": "deny" if scenario == "deny" else "allow_once",
                            },
                        )
                        answered["count"] += 1
                    if final():
                        return
                    await asyncio.sleep(0.03)

        idle = lambda: app.state("session")["status"] == "idle"
        if scenario == "interrupt":
            await wait(lambda: bool(requests))
            await wait(lambda: app.state("session")["status"] == "running")
            await runtime.interrupt_session("session")
            await wait(idle)
            print("Interrupt in-flight model request: PASSED", flush=True)
        elif scenario in {"attachment", "image"}:
            await answer("create", lambda: idle() and bool(requests))
        else:
            await answer("create", lambda: idle() and answered["count"] > 0)
        assert app.creation_view("create")["messageAccepted"] is True
        proof = root / "workspace" / "proof.txt"
        if scenario in {"deny", "interrupt", "attachment", "image"}:
            assert not proof.exists()
        else:
            assert proof.read_text() == PROOF
        if scenario == "attachment":
            assert TEXT_ATTACHMENT.decode() in str(requests[-1]["messages"]) or "proof.txt" in str(requests[-1]["messages"])
            print("Attachment reached the model:", TEXT_ATTACHMENT.decode() in str(requests[-1]["messages"]), flush=True)
        if scenario == "image":
            assert "image_url" in str(requests[-1]["messages"]), requests[-1]["messages"]
        snapshot = await runtime.get_session_snapshot("session")
        if scenario != "interrupt":
            assert any(REPLY in str(item.content) for item in snapshot.items), snapshot
        assert all(item.source["runtime"] == fixture.runtime_type for item in snapshot.items)
        if scenario == "allow":
            # One tool call; an approval card must not add a second tool item.
            assert sum(1 for item in snapshot.items if item.role == "tool") == 1, snapshot
        users = [item for item in snapshot.items if item.role == "user"]
        assert any(user.content.get("clientMessageId") == "first" for user in users), users
        if scenario in {"attachment", "image"}:
            assert users[0].content["attachments"][0]["fileId"] == "file_fixture"
        if scenario == "steer":
            assert any(user.content.get("clientMessageId") == "steer-first" for user in users), users
            assert STEER in str(requests[-1]["messages"]), requests[-1]["messages"]
        if scenario == "resume":
            before = len(snapshot.items)
            native = app.store.require("binding", "session")["agent_session_id"]
            await runtime.stop()
            runtime = await provider.create_runtime(config, host)
            app = runtime.app
            await runtime.start()
            await app.recover("session")
            assert app.store.require("binding", "session")["agent_session_id"] == native
            restored = await runtime.get_session_snapshot("session")
            assert len(restored.items) == before, [str(item.content)[:80] for item in restored.items]
            print("Resume keeps identity without replayed Timeline items: PASSED", flush=True)
            await app.submit("session", "second", "Write the proof file again.")
            answered["count"] = 0
            await answer("session", lambda: idle() and answered["count"] > 0)
            assert "Write the proof file." in str(requests[-1]["messages"]), requests[-1]["messages"]
            final = await runtime.get_session_snapshot("session")
            assert any(item.content.get("clientMessageId") == "second" for item in final.items if item.role == "user")
            assert sum(1 for item in final.items if item.content.get("clientMessageId") == "first") == 1
            print("Continue after resume keeps model history: PASSED", flush=True)
        print(f"{fixture.display_name} scenario {scenario}: PASSED ({time.monotonic() - started:.1f}s)", flush=True)
    finally:
        await runtime.stop()
        AgentClient.stream_observers = ()
        await asyncio.to_thread(fixture.cleanup, home, executable)
        server.shutdown()
        await asyncio.sleep(0.2)
        if args.record:
            save_recording(recording, fixture, scenario, root, executable)
        shutil.rmtree(root, ignore_errors=True)


def save_recording(recording, fixture, scenario, root, executable):
    """Replay fixtures must not carry machine paths."""
    text = "\n".join(json.dumps(item, ensure_ascii=False, sort_keys=True) for item in recording)
    replacements = {
        str(root.resolve()): "<root>",
        str(root): "<root>",
        str(executable.parent): "<bin>",
        str(Path.home()): "<home>",
    }
    for value, placeholder in sorted(replacements.items(), key=lambda item: -len(item[0])):
        text = text.replace(json.dumps(value)[1:-1], placeholder)
    args.record.mkdir(parents=True, exist_ok=True)
    target = args.record / f"{fixture.runtime_type}-{scenario}.jsonl"
    target.write_text(text + "\n", encoding="utf-8")
    print(f"Recorded {len(recording)} ACP messages to {target}", flush=True)


async def main():
    fixture = AGENTS[args.definition]
    executable = args.executable or shutil.which(fixture.command)
    if not executable:
        raise SystemExit(f"{fixture.command} not found; pass --executable")
    for scenario in SCENARIOS if args.scenario == "all" else (args.scenario,):
        await run_scenario(scenario, fixture, Path(executable).resolve())


asyncio.run(main())
