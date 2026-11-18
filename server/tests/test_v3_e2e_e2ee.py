"""v3 encrypted mode end to end: ``AGENT_SERVER_E2EE=required`` with the real Server, Router and TS Connector.

Same environment as ``test_v3_e2e.py`` (``v3_e2e_harness``), with the Server in ``required`` mode. The client is the
TS client channel (``connector-ts/test/support/e2ee-client.ts``: ``ClientSecureChannel`` over ``WS /api/v3/tunnel``)
driven by this test as JSON lines; the Server only relays ciphertext between it and the device.

- The device registers no plaintext service; the Server refuses plaintext content requests.
- Pairing: ``anywhere-cli pair-client`` on the device prints the ``aa-pair://`` code, the client pairs with
  ``Noise_XXpsk0`` and then reconnects with ``Noise_KK`` on a new channel id; a wrong pinned key is refused.
- Through the channel: create a session with its first message and get the reply, the session list with its sealed
  display envelope (decrypted here with the directory key), selections, planning and goal reads, files, terminal,
  the queue, and slash commands (sent as messages: the channel has no command catalog route yet).
- Canaries (random strings) go into everything the user produces; afterwards PostgreSQL, the Server's file root,
  the Server's and the Router's logs and both directions of every Router connection (a recording proxy in front of
  it) must not contain any of them, while plaintext metadata the Server may keep is found (positive control).

    MESHCALL_ROUTER_BINARY=/path/to/meshcall-router uv run pytest tests/test_v3_e2e_e2ee.py -v
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import subprocess
import threading
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from test_e2ee_canary import LoggedRouter, RecordingProxy
from v3_e2e_harness import (
    CONNECTOR_TS,
    E2E,
    RUNTIME_TYPE,
    STARTUP_TIMEOUT,
    create_project,
    e2e_environment,
    enable_fake_agent,
    node_command,
    skip_reason,
    wait_for,
)

from agent_server.core.e2ee import b64url_decode, display_envelope_ad, input_digest
from scripts.e2ee_canary_scan import (
    new_canary,
    scan_bytes,
    scan_postgres,
    scan_tree,
    scan_websocket,
)

# The steps share one Server, Router and device and run in order; scripts/check_tests.py distributes
# with --dist loadfile so the whole file stays on one xdist worker.
pytestmark = pytest.mark.skipif(skip_reason() is not None, reason=skip_reason() or "")

CLIENT_SCRIPT = CONNECTOR_TS / "test/support/e2ee-client.ts"
PLAINTEXT_SERVICES = ("Sessions", "Store", "Runtime", "Workspace")


class ProxiedRouter(LoggedRouter):
    """A Router with its log kept, reached only through a recording proxy (``url`` is the proxy's)."""

    def __init__(self) -> None:
        super().__init__()
        self.proxy = RecordingProxy(self.port)
        self.proxy.start()

    @property
    def url(self) -> str:
        return self.proxy.url

    def stop(self) -> None:
        super().stop()
        with contextlib.suppress(Exception):
            self.proxy.stop()


class ChannelError(AssertionError):
    def __init__(self, message: str, code: str | None) -> None:
        super().__init__(f"{message} ({code})")
        self.code = code


class TunnelClient:
    """``e2ee-client.ts`` in its own process: one encrypted channel to the device through the Server."""

    def __init__(self, root: Path, server_url: str, token: str) -> None:
        self.stderr = (root / "e2ee-client.log").open("ab")
        self.proc = subprocess.Popen(
            node_command(CLIENT_SCRIPT, server_url, token),
            cwd=str(CONNECTOR_TS),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.stderr,
        )
        self._lock = threading.Lock()
        self._answers: dict[int, dict[str, Any]] = {}
        self._signal = threading.Condition(self._lock)
        self.events: list[dict[str, Any]] = []
        self.closed: list[str] = []
        self._next = 0
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()
        wait_for(lambda: self._ready, 30, 0.05, "the client process")

    _ready = False

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for raw in iter(self.proc.stdout.readline, b""):
            message = json.loads(raw)
            with self._signal:
                if message.get("ready"):
                    self._ready = True
                elif "id" in message:
                    self._answers[int(message["id"])] = message
                elif "event" in message:
                    self.events.append(message)
                elif "closed" in message:
                    self.closed.append(str(message["closed"]))
                self._signal.notify_all()

    def call(self, op: str, timeout: float = 60.0, **params: Any) -> Any:
        with self._signal:
            self._next += 1
            ident = self._next
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps({"id": ident, "op": op, **params}) + "\n").encode())
        self.proc.stdin.flush()
        deadline = time.monotonic() + timeout
        with self._signal:
            while ident not in self._answers:
                remaining = deadline - time.monotonic()
                assert remaining > 0, f"{op} did not answer within {timeout}s"
                self._signal.wait(remaining)
            answer = self._answers.pop(ident)
        if not answer["ok"]:
            raise ChannelError(answer.get("error") or "failed", answer.get("code"))
        return answer["result"]

    def request(self, method: str, path: str, body: Any = None, timeout: float = 60.0) -> tuple[int, Any]:
        response = self.call("request", timeout, method=method, path=path, body=body)
        return int(response["status"]), response["body"]

    def ok(self, method: str, path: str, body: Any = None) -> Any:
        status, answer = self.request(method, path, body)
        assert status == 200, f"{method} {path} -> {status}: {answer}"
        return answer

    def seen(self, sub: str) -> list[dict[str, Any]]:
        with self._lock:
            return [message["event"] for message in self.events if message.get("sub") == sub]

    def close(self) -> None:
        with contextlib.suppress(Exception):
            assert self.proc.stdin is not None
            self.proc.stdin.close()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.stderr.close()


class Secure:
    """The paired encrypted client next to the E2E environment, and every canary the tests used."""

    def __init__(self, env: E2E, client: TunnelClient, paired: dict[str, Any]) -> None:
        self.env = env
        self.client = client
        self.device_id = paired["deviceId"]
        self.directory_key_id = paired["directoryKey"]["keyId"]
        self.directory_key = b64url_decode(paired["directoryKey"]["key"])
        self.canaries: list[str] = []
        self.session_id = ""

    def canary(self, label: str) -> str:
        value = new_canary(label)
        self.canaries.append(value)
        return value

    def register(self, command_id: str, body: Any) -> None:
        """``POST /api/v3/e2ee/commands`` before a command goes through the channel (contracts/e2ee/1.0)."""
        digest = input_digest(self.directory_key, json.dumps(body).encode())
        response = self.env.api.http.post(
            f"{self.env.server.url}/api/v3/e2ee/commands",
            json={"commandId": command_id, "deviceId": self.device_id, "inputDigest": digest},
            headers={"Authorization": f"Bearer {self.env.api.token}"},
        )
        assert response.status_code == 200, response.text

    def send(self, session_id: str, content: str, **options: Any) -> Any:
        body = {"content": content, "clientMessageId": f"cm_{uuid.uuid4().hex}", **options}
        self.register(body["clientMessageId"], body)
        return self.client.ok("POST", f"/api/v2/sessions/{session_id}/runtime/messages", body)

    def assistant_texts(self, session_id: str) -> list[str]:
        timeline = self.client.ok("GET", f"/api/v2/sessions/{session_id}/timeline?mode=latest&limit=200")
        return [
            str((item.get("content") or {}).get("text") or "")
            for item in timeline["items"]
            if item.get("type") == "message" and item.get("role") == "assistant"
        ]

    def wait_reply(self, session_id: str, text: str, timeout: float = 30.0) -> list[str]:
        return wait_for(lambda: (found := self.assistant_texts(session_id)) and any(text in t for t in found)
                        and found, timeout, 0.2, f"assistant message containing {text!r}")

    def meta(self, session_id: str) -> dict[str, Any]:
        return self.client.ok("GET", f"/api/v2/sessions/{session_id}/meta")

    def open_envelope(self, session_id: str, envelope: dict[str, Any], slot: str) -> dict[str, Any]:
        assert envelope["mode"] == "sealed", envelope
        assert envelope["keyId"] == self.directory_key_id, envelope
        sealed = b64url_decode(envelope["payload"])
        ad = display_envelope_ad(self.device_id, session_id, slot, envelope["keyId"])  # type: ignore[arg-type]
        return json.loads(AESGCM(self.directory_key).decrypt(sealed[:12], sealed[12:], ad))

    def create_session(self, content: str, title: str | None = None) -> str:
        body = {
            "connectorId": self.device_id,
            "projectId": self.env.project_id,
            "runtime": RUNTIME_TYPE,
            "runtimeId": self.env.runtime_id,
            "cwd": str(self.env.device.workspace),
            "content": content,
            "clientMessageId": f"cm_{uuid.uuid4().hex}",
            **({"title": title} if title else {}),
        }
        self.register(body["clientMessageId"], body)
        created = self.client.ok("POST", "/api/v2/sessions/create-and-start", body)
        return created["session"]["id"]

    def ensure_session(self) -> str:
        if not self.session_id:
            content = f"first {self.canary('first')}"
            self.session_id = self.create_session(content)
            self.wait_reply(self.session_id, f"echo: {content}")
        return self.session_id


def _pairing_uri(env: E2E) -> str:
    output = env.device.run("pair-client")
    return next(line.strip() for line in output.splitlines() if line.strip().startswith("aa-pair://"))


@pytest.fixture(scope="module")
def secure(request: pytest.FixtureRequest) -> Iterator[Secure]:
    with e2e_environment(request, server_env={"AGENT_SERVER_E2EE": "required"}, router_cls=ProxiedRouter) as env:
        env.wait_status("online", STARTUP_TIMEOUT)
        enable_fake_agent(env)
        create_project(env)
        client = TunnelClient(env.root, env.server.url, env.api.token)
        try:
            paired = client.call("pair", uri=_pairing_uri(env), label="e2e client")
            yield Secure(env, client, paired)
        finally:
            client.close()


# ---------------------------------------------------------------------------------------------------------------------


def test_device_registers_no_plaintext_service_and_the_server_refuses_plaintext(secure: Secure) -> None:
    env = secure.env
    registered = env.device.log.find(r"registered (.*) at .* as .*; e2ee (\w+)")
    assert registered is not None and registered.group(2) == "required", env.diagnostics()
    services = [name.strip() for name in registered.group(1).split(",")]
    assert "Secure" in services and not set(services) & set(PLAINTEXT_SERVICES), services
    sid = secure.ensure_session()
    api = env.api
    body = {"content": "plain", "clientMessageId": f"cm_{uuid.uuid4().hex}"}
    for method, path, payload in (
        ("GET", f"/sessions/{sid}/timeline", None),
        ("GET", f"/sessions/{sid}/snapshot", None),
        ("POST", f"/sessions/{sid}/runtime/messages", body),
        ("POST", "/sessions/create-and-start", {**body, "connectorId": env.connector_id, "runtime": RUNTIME_TYPE}),
        ("POST", f"{env.dev}/fs/list", {"root": str(env.device.workspace), "path": ""}),
        ("POST", f"{env.dev}/terminals-v2?root={env.device.workspace}", {"cols": 80, "rows": 24}),
        ("POST", f"{env.dev}/shell/tasks?root={env.device.workspace}", {"command": "true", "timeoutMs": 1000}),
    ):
        refused = api.call(method, path, json=payload, expect=None)
        assert refused.status_code in {403, 409}, (path, refused.status_code, refused.text)
        assert "e2ee" in refused.text, (path, refused.text)


def test_pairing_then_kk_reconnect_and_a_wrong_pin_is_refused(secure: Secure) -> None:
    client = secure.client
    connected = client.call("connect")
    assert connected["ready"]["deviceId"] == secure.device_id, connected
    assert connected["ready"]["clientId"] == connected["clientId"]
    # The reconnected channel serves requests.
    secure.ensure_session()
    # Another device key than the pinned one: the client refuses the device (it cannot answer KK).
    with pytest.raises(ChannelError) as wrong:
        client.call("connect", devicePub=base64.urlsafe_b64encode(b"\x09" * 32).decode().rstrip("="), timeout=30)
    assert wrong.value.code in {"device_pin_mismatch", "e2ee_handshake_failed", "e2ee_not_paired"}, wrong.value
    client.call("connect")


def test_session_create_reply_list_and_display_envelope(secure: Secure) -> None:
    title = f"title {secure.canary('title')}"
    content = f"hello {secure.canary('message')}"
    sid = secure.create_session(content, title=title)
    found = secure.wait_reply(sid, f"echo: {content}")
    assert any(content in t for t in found)
    # The Server's list has the session from the outbox, with its display fields sealed.
    api = secure.env.api

    def listed() -> dict[str, Any] | None:
        sessions = api.get("/sessions", params={"archived": "false"})["sessions"]
        return next((s for s in sessions if s["id"] == sid and s.get("displayDevice")), None)

    row = wait_for(listed, 30, 0.2, "the session in the Server's list")
    assert not row.get("title") and not row.get("cwd"), row
    assert row["projectId"] == secure.env.project_id, row
    device_fields = secure.open_envelope(sid, row["displayDevice"], "device")
    assert device_fields.get("cwd") == str(secure.env.device.workspace), device_fields
    user_fields = secure.open_envelope(sid, row["displayUser"], "user") if row.get("displayUser") else {}
    assert title in json.dumps([device_fields, user_fields]), (device_fields, user_fields)
    wait_for(lambda: content in json.dumps(secure.open_envelope(sid, listed()["displayDevice"], "device")), 30, 0.2,
             "the latest message as the sealed preview")
    # Live: the next reply arrives on the session subscription.
    sub = secure.client.call("subscribe", sessionId=sid)["sub"]
    try:
        text = f"live {secure.canary('live')}"
        secure.send(sid, text)
        wait_for(lambda: any(f"echo: {text}" in json.dumps(e) for e in secure.client.seen(sub)), 30, 0.1,
                 "the reply on the subscription")
    finally:
        secure.client.call("unsubscribe", sub=sub)
    snapshot = secure.client.ok("GET", f"/api/v2/sessions/{sid}/snapshot")
    assert f"echo: {text}" in json.dumps(snapshot["timeline"]), snapshot


def test_selections_planning_and_goal(secure: Secure) -> None:
    sid = secure.ensure_session()
    client = secure.client
    patched = client.ok("PATCH", f"/api/v2/sessions/{sid}/runtime/selections",
                        {"selections": {"model": "m2", "permission": "auto"}})
    assert patched["state"]["selections"]["model"] == "m2", patched
    text = f"after switch {secure.canary('switch')}"
    secure.send(sid, text)
    secure.wait_reply(sid, f"echo: {text} [model=m2 permission=auto]")
    state = client.ok("GET", f"/api/v2/sessions/{sid}/runtime/state")
    assert "m2" in json.dumps(state), state
    plan_text = f"#plan {secure.canary('plan')}"
    secure.send(sid, plan_text)
    secure.wait_reply(sid, f"echo: {plan_text}")
    planning = wait_for(lambda: (p := client.ok("GET", f"/api/v2/sessions/{sid}/planning")) and p.get("proposal")
                        and p, 15, 0.2, "the plan proposal")
    proposal = planning["proposal"]
    document = client.ok("GET", f"/api/v2/sessions/{sid}/plans/{proposal['planId']}/{proposal['revision']}")
    assert "# E2E plan" in json.dumps(document), document
    status, goal = client.request("GET", f"/api/v2/sessions/{sid}/goal")
    assert status == 200, goal


def test_files_read_and_write(secure: Secure) -> None:
    client = secure.client
    root = str(secure.env.device.workspace)
    dev = f"/api/v2/connectors/{secure.device_id}"
    content = f"file body {secure.canary('file')}\n"
    name = f"note-{secure.canary('filename')}.txt"
    client.ok("POST", f"{dev}/fs/write?root={root}", {"path": name, "content": content})
    assert (secure.env.device.workspace / name).read_text() == content
    listed = client.ok("POST", f"{dev}/fs/list", {"root": root, "path": "."})
    assert name in json.dumps(listed), listed
    text = client.ok("POST", f"{dev}/fs/readText?root={root}", {"path": name, "maxBytes": 65536})
    assert text["content"] == content, text
    chunk = client.ok("GET", f"{dev}/fs/read?root={root}&path={name}&offset=0&length=1024")
    assert base64.b64decode(chunk["data"]).decode() == content and chunk["eof"] is True, chunk


def test_spilled_tool_output_reads_back_through_the_channel(secure: Secure) -> None:
    sid = secure.ensure_session()
    client = secure.client
    secure.send(sid, "#big 9000 through the channel")
    secure.wait_reply(sid, "echo: #big 9000 through the channel")
    items = client.ok("GET", f"/api/v2/sessions/{sid}/timeline")["items"]
    ref = next(r for item in items for r in item.get("blobRefs") or [] if r["mediaType"].startswith("text/"))
    parts: list[bytes] = []
    offset = 0
    while True:
        chunk = client.ok("GET", f"/api/v2/sessions/{sid}/blobs/{ref['blobId']}?offset={offset}&length=30000")
        data = base64.b64decode(chunk["data"])
        parts.append(data)
        offset += len(data)
        if chunk["eof"]:
            break
    assert b"".join(parts).decode() == "\n".join(f"row {index}" for index in range(9000))
    status, missing = client.request("GET", f"/api/v2/sessions/{sid}/blobs/blob_{'0' * 64}")
    assert status == 404 and missing["detail"]["code"] == "blob_not_found", missing


def test_shell_tasks_through_the_channel(secure: Secure) -> None:
    client = secure.client
    root = str(secure.env.device.workspace)
    tasks = f"/api/v2/connectors/{secure.device_id}/shell/tasks"
    marker = secure.canary("shell")
    started = client.ok("POST", f"{tasks}?root={root}", {"command": f"sleep 1; echo {marker}", "timeoutMs": 30_000})
    assert started["status"] == "running", started
    done = client.ok("GET", f"{tasks}/{started['taskId']}/wait?timeoutMs=20000")
    assert (done["status"], done["result"]["stdout"], done["result"]["exitCode"]) == ("completed", f"{marker}\n", 0)
    slow = client.ok("POST", f"{tasks}?root={root}", {"command": "sleep 30", "timeoutMs": 60_000})
    cancelled = client.ok("POST", f"{tasks}/{slow['taskId']}/cancel")
    assert (cancelled["status"], cancelled["cancelled"]) == ("cancelled", True), cancelled
    status, _answer = client.request("GET", f"{tasks}/{slow['taskId']}/wait?timeoutMs=10")
    assert status == 200
    status, _answer = client.request("GET", f"{tasks}/{slow['taskId']}/wait?timeoutMs=10")
    assert status == 404


def test_terminal_through_the_channel(secure: Secure) -> None:
    client = secure.client
    root = str(secure.env.device.workspace)
    dev = f"/api/v2/connectors/{secure.device_id}"
    created = client.ok("POST", f"{dev}/terminals-v2?root={root}", {"cols": 80, "rows": 24, "label": "e2e"})
    terminal_id = created["result"]["terminalId"]
    sub = client.call("subscribeTerminal", terminalId=terminal_id)["sub"]

    def output() -> str:
        return "".join(base64.b64decode(e["data"]).decode("utf-8", "replace")
                       for e in client.seen(sub) if e.get("type") in {"replay", "output"} and e.get("data"))

    try:
        marker = secure.canary("terminal")
        command = f"echo {marker[:20]}$((40+2)){marker[20:]}\n".encode()
        client.ok("POST", f"{dev}/terminals-v2/{terminal_id}/write", {"dataBase64": base64.b64encode(command).decode()})
        wait_for(lambda: f"{marker[:20]}42{marker[20:]}" in output(), 20, 0.1, "the command's output")
        client.ok("POST", f"{dev}/terminals-v2/{terminal_id}/resize", {"cols": 100, "rows": 30})
        client.ok("POST", f"{dev}/terminals-v2/{terminal_id}/write",
                  {"dataBase64": base64.b64encode(b"stty size\n").decode()})
        wait_for(lambda: "30 100" in output(), 20, 0.1, "the new size")
        client.ok("DELETE", f"{dev}/terminals-v2/{terminal_id}")
        wait_for(lambda: any(e.get("type") == "exit" for e in client.seen(sub)), 20, 0.1, "the exit event")
    finally:
        with contextlib.suppress(Exception):
            client.call("unsubscribe", sub=sub)


def test_queue_runs_after_the_turn(secure: Secure) -> None:
    sid = secure.ensure_session()
    client = secure.client
    secure.send(sid, "#slow queued turn")
    wait_for(lambda: secure.meta(sid)["status"] == "running", 30, 0.2, "the slow turn running")
    queued = f"queued {secure.canary('queued')}"
    sent = secure.send(sid, queued, queue="auto")
    assert sent["result"]["delivery"] == "queued", sent
    queue = client.ok("GET", f"/api/v2/sessions/{sid}/runtime/queue")
    assert [item["content"] for item in queue["items"]] == [queued], queue
    client.ok("POST", f"/api/v2/sessions/{sid}/runtime/interrupt", {})
    secure.wait_reply(sid, f"echo: {queued}")
    wait_for(lambda: queued not in json.dumps(client.ok("GET", f"/api/v2/sessions/{sid}/runtime/queue")), 15, 0.2,
             "the queue drained")


def test_slash_commands(secure: Secure) -> None:
    sid = secure.ensure_session()
    client = secure.client
    # The device serves the catalog through the channel, as it does through ``Client/call`` in normal mode.
    catalog = wait_for(lambda: (c := client.ok("GET", f"/api/v2/sessions/{sid}/runtime/commands"))["commands"] and c,
                       15, 0.2, "the command catalog")
    assert "review" in [item.get("id") for item in catalog["commands"]], catalog
    argument = secure.canary("command")
    secure.send(sid, f"/review {argument}")
    secure.wait_reply(sid, f"echo: /review {argument}")


def test_agent_configuration_and_recovery_through_the_channel(secure: Secure) -> None:
    sid = secure.ensure_session()
    client = secure.client
    base = f"/api/v2/runtime-workflows/sessions/{sid}"
    view = client.ok("GET", f"{base}/configuration")
    generation = view["ownerGeneration"]
    assert generation and "model" in [option["id"] for option in view["configuration"]["options"]], view
    updated = client.ok("POST", f"{base}/configuration", {
        "operationId": f"op_{uuid.uuid4().hex}", "expectedRevision": view["configuration"]["revision"],
        "values": {"model": "m1"},
    })
    assert updated["phase"] == "completed", updated
    text = f"panel {secure.canary('panel')}"
    secure.send(sid, text)
    secure.wait_reply(sid, f"echo: {text} [model=m1")
    status, refused = client.request("POST", f"{base}/operations", {
        "operation": "resources.get", "operationId": f"op_{uuid.uuid4().hex}", "expectedGeneration": generation,
    })
    assert status == 409 and refused["detail"]["code"] == "agent_capability_unsupported", refused
    assert client.ok("POST", f"{base}/close", {"ownerGeneration": generation, "closeOperationId": "c1"}) == {"closed": True}
    secure.send(sid, "bye #exit")
    secure.wait_reply(sid, "echo: bye #exit")

    def recover_offered() -> bool:
        items = client.ok("GET", f"/api/v2/sessions/{sid}/runtime/capabilities")["capabilitySet"]["capabilities"]
        return any(item["capabilityId"] == "session.recover" and item["available"] for item in items)

    wait_for(recover_offered, 30, 0.2, "recovery offered")
    status, recovered = client.request("POST", f"{base}/recover", {"operationId": f"op_{uuid.uuid4().hex}",
                                                                    "expectedGeneration": generation})
    assert status == 202 and recovered["phase"] == "completed", recovered
    text = f"recovered {secure.canary('recovered')}"
    secure.send(sid, text)
    secure.wait_reply(sid, f"echo: {text}")


def test_usage_statistics_come_from_the_device(secure: Secure) -> None:
    # Required mode: the Server sees no message, so messages, sessions and turns all come from usage.report.
    secure.ensure_session()

    def counted() -> dict[str, Any] | None:
        summary = secure.env.api.get("/admin/usage/report", params={"tz": "UTC"})["summary"]
        return summary if summary["messages"] >= 1 and summary["turns"] >= 1 and summary["sessions"] >= 1 else None

    summary = wait_for(counted, 30, 0.5, "the device's counters in the usage report")
    assert summary["activeUsers"] >= 1, summary


def test_no_canary_reaches_the_server_side(secure: Secure) -> None:
    env = secure.env
    # Content of its own, so the scan has something to find even when this test runs alone.
    sid = secure.ensure_session()
    content = f"scan {secure.canary('scan')}"
    secure.send(sid, content)
    secure.wait_reply(sid, f"echo: {content}")
    time.sleep(1.0)  # outbox, logs and the proxy settle
    canaries = list(secure.canaries)
    assert len(canaries) >= 2
    hits = asyncio.run(scan_postgres(env.database_url, canaries))
    files, _ = scan_tree("files", env.root / "files", canaries) if (env.root / "files").exists() else ([], 0)
    hits += files
    hits += scan_bytes("server log", env.server.log_path.read_bytes(), canaries)
    router: ProxiedRouter = env.router  # type: ignore[assignment]
    hits += scan_bytes("router log", router.log_path.read_bytes(), canaries)
    captures = router.proxy.captures()
    assert captures, "the proxy recorded no Router traffic"
    for name, stream in captures.items():
        hits += scan_websocket(f"router traffic {name}", stream, canaries)
    assert not hits, "\n".join(str(hit) for hit in hits)
    # Positive controls: each scan sees what it is allowed to see.
    assert asyncio.run(scan_postgres(env.database_url, ["e2e laptop"])), "the device name is not in PostgreSQL"
    assert any(scan_websocket(name, stream, [secure.device_id]) for name, stream in captures.items())
