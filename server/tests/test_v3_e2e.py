"""v3 end to end: the real Server, a real MeshCall Router and the real TS Connector with a fake ACP Agent.

The Server's other device tests use ``scripts/v3_fake_device.py``, written to the Server's expectations, and
connector-ts tests its handlers against a stand-in Server; a field that one side renamed passed both. Here nothing
is faked between the two: the Server runs as its own process (uvicorn), the Connector is ``anywhere-cli`` from
``connector-ts`` (``test/support/e2e-device.ts``: ``runCli`` with the system keychain swapped for none), paired
with a pairing code like a person would, and the test only uses the HTTP and WebSocket API the clients use.

The only fake is the Agent: ``connector-ts/test/support/fake-acp-e2e.mjs`` installed as ``opencode`` on the
device's PATH. Its replies depend on the prompt (``#slow`` waits for a cancel, ``#plan`` writes a Markdown plan).

Run with ``AA_E2E_KEEP=1`` to keep the Server's and the device's logs (a failed run always keeps them).

Needs, else skipped: a Router binary (``MESHCALL_ROUTER_BINARY`` or ``meshcall-router`` on PATH), Node >= 22.13
with ``connector-ts/node_modules`` installed, and the PostgreSQL of ``AGENT_SERVER_TEST_DB_URL`` (a fresh database
is created next to it for the Server process and dropped afterwards).

    MESHCALL_ROUTER_BINARY=/path/to/meshcall-router uv run pytest tests/test_v3_e2e.py -v
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import functools
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import TEST_DATABASE_URL, _asyncpg_url, _run_maintenance
from mesh_fixtures import RouterProcess, router_binary

REPO = Path(__file__).resolve().parents[2]
SERVER_DIR = REPO / "server"
CONNECTOR_TS = REPO / "connector-ts"
DEVICE_SCRIPT = CONNECTOR_TS / "test/support/e2e-device.ts"
FAKE_AGENT = CONNECTOR_TS / "test/support/fake-acp-e2e.mjs"
RUNTIME_TYPE = "opencode"
STARTUP_TIMEOUT = 60.0


@functools.cache
def _node() -> str | None:
    """The real Node binary (version managers put a shim on PATH that needs their environment)."""
    node = shutil.which("node")
    if node is None:
        return None
    try:
        found = subprocess.run(
            [node, "-p", "process.execPath + ' ' + process.versions.node"],
            check=True, capture_output=True, text=True, timeout=20,
        ).stdout.strip()
        path, version = found.rsplit(" ", 1)
        major, minor = (int(part) for part in version.split(".")[:2])
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return path if (major, minor) >= (22, 13) else None


def _skip_reason() -> str | None:
    if router_binary() is None:
        return "MeshCall Router binary not available (set MESHCALL_ROUTER_BINARY)"
    if _node() is None:
        return "Node >= 22.13 not on PATH"
    if not (CONNECTOR_TS / "node_modules/meshcall").exists():
        return "connector-ts dependencies not installed (cd connector-ts && yarn install)"
    return None


pytestmark = pytest.mark.skipif(_skip_reason() is not None, reason=_skip_reason() or "")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait(check: Callable[[], Any], timeout: float = 15.0, interval: float = 0.1, what: str = "condition") -> Any:
    deadline = time.monotonic() + timeout
    last: Any = None
    while True:
        try:
            last = check()
        except AssertionError as exc:  # a failed check is retried until the deadline
            last = exc
        else:
            if last:
                return last
        if time.monotonic() > deadline:
            raise AssertionError(f"{what} not reached within {timeout}s; last: {last!r}")
        time.sleep(interval)


class LogTail:
    """A child's output, kept in memory and on disk, searchable while it runs."""

    def __init__(self, proc: subprocess.Popen[bytes], path: Path) -> None:
        self.lines: list[str] = []
        self.path = path
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._pump, args=(proc,), daemon=True)
        self._thread.start()

    def _pump(self, proc: subprocess.Popen[bytes]) -> None:
        assert proc.stdout is not None
        with self.path.open("a", encoding="utf-8") as sink:
            for raw in iter(proc.stdout.readline, b""):
                line = raw.decode("utf-8", "replace").rstrip("\n")
                sink.write(line + "\n")
                sink.flush()
                with self._lock:
                    self.lines.append(line)

    def find(self, pattern: str) -> re.Match[str] | None:
        with self._lock:
            lines = list(self.lines)
        for line in lines:
            match = re.search(pattern, line)
            if match:
                return match
        return None

    def tail(self, count: int = 60) -> str:
        with self._lock:
            return "\n".join(self.lines[-count:])


def _stop(proc: subprocess.Popen[bytes] | None, timeout: float = 10.0) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(5)


class Device:
    """``anywhere-cli`` in its own process, with a temporary home, PATH and workspace."""

    def __init__(self, root: Path, router: str) -> None:
        self.root = root
        self.home = root / "home"
        self.bin = root / "bin"
        self.workspace = root / "workspace"
        for directory in (self.home, self.bin, self.workspace):
            directory.mkdir(parents=True, exist_ok=True)
        self.router = router
        self.node = _node() or "node"
        self.proc: subprocess.Popen[bytes] | None = None
        self.log: LogTail | None = None
        self.starts = 0
        agent = self.bin / RUNTIME_TYPE
        agent.write_text(
            "#!/bin/sh\n"
            'if [ "$2" = "--help" ]; then exit 0; fi\n'
            'if [ "$1" = "--version" ]; then echo "opencode 0.0.0-e2e"; exit 0; fi\n'
            f'exec "{self.node}" "{FAKE_AGENT}"\n'
        )
        agent.chmod(0o755)

    def start(self, *command: str) -> None:
        assert self.proc is None or self.proc.poll() is not None
        self.starts += 1
        env = {
            "HOME": str(self.home),
            # Only the fake Agent and the basics: no Codex, Claude or Pi of this machine is found.
            "PATH": f"{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin",
            "MESHCALL_ROUTER_BINARY": self.router,
            "AGENT_CONNECTOR_WORKSPACE_ROOTS": str(self.workspace),
            "TMPDIR": str(self.root),
            "LANG": "C.UTF-8",
        }
        self.proc = subprocess.Popen(
            [
                self.node,
                "--experimental-transform-types",
                "--disable-warning=ExperimentalWarning",
                "--import",
                str(CONNECTOR_TS / "test/support/ts-resolve.mjs"),
                str(DEVICE_SCRIPT),
                str(self.home),
                *command,
            ],
            cwd=str(CONNECTOR_TS),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.log = LogTail(self.proc, self.root / f"device-{self.starts}.log")

    def stop(self) -> None:
        _stop(self.proc, 15)


class Server:
    """``uvicorn agent_server.app:create_app`` on a fresh database."""

    def __init__(self, root: Path, database_url: str, router: RouterProcess) -> None:
        self.port = _free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        env = {key: value for key, value in os.environ.items() if not key.startswith("AGENT_SERVER_")}
        env.update(
            {
                "AGENT_SERVER_DB_URL": database_url,
                "AGENT_SERVER_SECRET": secrets.token_hex(32),
                "AGENT_SERVER_PUBLIC_ORIGIN": self.url,
                "AGENT_SERVER_FILES_LOCAL_ROOT": str(root / "files"),
                "AGENT_SERVER_MESH_ROUTER_URL": router.url,
                "AGENT_SERVER_MESH_PASSWORD": router.password,
                "AGENT_SERVER_MESH_PUBLIC_URL": router.url,
                "AGENT_SERVER_PASSWORD_ITERATIONS": "1000",
            }
        )
        self.proc = subprocess.Popen(
            [
                sys.executable, "-m", "uvicorn", "agent_server.app:create_app", "--factory",
                "--host", "127.0.0.1", "--port", str(self.port), "--no-access-log",
            ],
            cwd=str(SERVER_DIR),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.log = LogTail(self.proc, root / "server.log")

        def ready() -> bool:
            assert self.proc.poll() is None, f"Server exited:\n{self.log.tail()}"
            with contextlib.suppress(httpx.HTTPError):
                return httpx.get(f"{self.url}/api/v2/health", timeout=1).status_code < 500
            return False

        _wait(ready, STARTUP_TIMEOUT, 0.2, "Server health")

    def stop(self) -> None:
        _stop(self.proc)


class Api:
    """The client side: ``/api/v2`` with a user's bearer token, like the Web client's ``ApiClient``."""

    def __init__(self, base: str) -> None:
        self.base = base
        self.http = httpx.Client(base_url=f"{base}/api/v2", timeout=30)
        self.token = ""

    def call(self, method: str, path: str, *, expect: int | None = 200, **kwargs: Any) -> httpx.Response:
        headers = kwargs.pop("headers", {})
        if self.token:
            headers.setdefault("Authorization", f"Bearer {self.token}")
        response = self.http.request(method, path, headers=headers, **kwargs)
        if expect is not None:
            assert response.status_code == expect, f"{method} {path} -> {response.status_code}: {response.text[:2000]}"
        return response

    def get(self, path: str, **kwargs: Any) -> Any:
        return self.call("GET", path, **kwargs).json()

    def post(self, path: str, body: Any = None, **kwargs: Any) -> Any:
        response = self.call("POST", path, json={} if body is None else body, **kwargs)
        return response.json() if response.content else None

    def patch(self, path: str, body: Any, **kwargs: Any) -> Any:
        return self.call("PATCH", path, json=body, **kwargs).json()

    def put(self, path: str, body: Any, **kwargs: Any) -> Any:
        return self.call("PUT", path, json=body, **kwargs).json()

    def delete(self, path: str, **kwargs: Any) -> Any:
        response = self.call("DELETE", path, **kwargs)
        return response.json() if response.content else None

    def ws_url(self, path: str) -> str:
        return self.base.replace("http://", "ws://", 1) + path


class SessionSocket:
    """``WS /api/v2/sessions/{id}/ws`` with a ticket, collecting every event in a thread."""

    def __init__(self, api: Api, session_id: str) -> None:
        from websockets.sync.client import connect

        ticket = api.post("/ws-ticket", {"clientId": f"e2e-{uuid.uuid4().hex[:8]}", "scope": {"sessionId": session_id}})
        url = api.ws_url(f"/api/v2/sessions/{session_id}/ws?ticket={ticket['ticket']}&protocol=1.2")
        self._connection = connect(url, open_timeout=10, max_size=None)
        self.socket = self._connection.__enter__()
        self.events: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()

    def _read(self) -> None:
        with contextlib.suppress(Exception):
            for message in self.socket:
                with self._lock:
                    self.events.append(json.loads(message))

    def seen(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.events)

    def types(self) -> list[str]:
        return [str(event.get("type")) for event in self.seen()]

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._connection.__exit__(None, None, None)


class E2E:
    def __init__(self, root: Path, server: Server, device: Device) -> None:
        self.root = root
        self.server = server
        self.device = device
        self.api = Api(server.url)
        self.connector_id = ""
        self.project_id = ""
        self.runtime_id = ""
        self.session_id = ""

    def need(self, attribute: str) -> str:
        value = getattr(self, attribute)
        if not value:
            pytest.skip(f"an earlier step did not leave {attribute}")
        return value

    @property
    def dev(self) -> str:
        return f"/connectors/{self.connector_id}"

    def connector(self) -> dict[str, Any]:
        return self.api.get(self.dev)["connector"]

    def wait_status(self, status: str, timeout: float = 30.0) -> dict[str, Any]:
        return _wait(lambda: (c := self.connector())["status"] == status and c, timeout, 0.2, f"device {status}")

    def device_alive(self) -> bool:
        proc = self.device.proc
        assert proc is not None and proc.poll() is None, f"the device exited:\n{self.diagnostics()}"
        return True

    def diagnostics(self) -> str:
        device_log = self.device.log.tail(80) if self.device.log else ""
        return f"--- server ---\n{self.server.log.tail(80)}\n--- device ---\n{device_log}"


async def _create_database(name: str) -> None:
    await _run_maintenance(_asyncpg_url(TEST_DATABASE_URL), f'CREATE DATABASE "{name}"')


async def _drop_database(name: str) -> None:
    await _run_maintenance(_asyncpg_url(TEST_DATABASE_URL), f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest.fixture(scope="module")
def e2e(request: pytest.FixtureRequest) -> Iterator[E2E]:
    from agent_server.infra.db.migrations import upgrade_database

    failed_before = request.session.testsfailed

    # Short: the Connector's local Router listens on a Unix socket under the home (103-byte limit).
    root = Path(tempfile.mkdtemp(prefix="aae2e-", dir="/tmp" if os.path.isdir("/tmp") else None))
    name = f"aa_e2e_test_{secrets.token_hex(4)}"
    try:
        asyncio.run(_create_database(name))
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"PostgreSQL not reachable: {exc}")
    database_url = f"{TEST_DATABASE_URL.rpartition('/')[0]}/{name}"
    router = RouterProcess()
    server: Server | None = None
    device: Device | None = None
    try:
        upgrade_database(db_url=database_url)
        router.start()
        server = Server(root, database_url, router)
        device = Device(root / "device", router.binary)
        env = E2E(root, server, device)
        _sign_up_and_pair(env)
        yield env
    finally:
        if device is not None:
            device.stop()
        if server is not None:
            server.stop()
        router.stop()
        asyncio.run(_drop_database(name))
        # The Server's and the device's logs stay for a failed run (or with AA_E2E_KEEP=1).
        if os.environ.get("AA_E2E_KEEP") == "1" or request.session.testsfailed > failed_before:
            print(f"\nE2E logs kept in {root}")
        else:
            shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(router.dir, ignore_errors=True)


def _sign_up_and_pair(env: E2E) -> None:
    api = env.api
    # First run: the admin signs up with the setup token from the Server's log.
    api.get("/auth/config")
    token = _wait(lambda: env.server.log.find(r"setup-token: (\S+)"), 10, 0.1, "setup token in the Server log")
    auth = api.post("/auth/register", {"email": "e2e@example.com", "displayName": "E2E", "password": "e2e-password-123", "setupToken": token.group(1)})
    api.token = auth["accessToken"]
    # The device asks for a pairing code; the client claims it.
    env.device.start("pair", env.server.url)
    code = _wait(lambda: env.device_alive() and env.device.log.find(r"Pairing code: (\S+)"), STARTUP_TIMEOUT, 0.1,
                 "pairing code")
    claimed = api.post("/pairing/claim", {"code": code.group(1), "name": "e2e laptop"})
    env.connector_id = claimed["connector"]["id"]


def _items(timeline: dict[str, Any]) -> list[dict[str, Any]]:
    return list(timeline.get("items") or [])


def _texts(e2e: E2E, session_id: str, role: str = "assistant") -> list[str]:
    timeline = e2e.api.get(f"/sessions/{session_id}/timeline", params={"mode": "latest", "limit": 200})
    assert not timeline.get("deviceOffline"), timeline
    return [
        str((item.get("content") or {}).get("text") or "")
        for item in _items(timeline)
        if item.get("type") == "message" and item.get("role") == role
    ]


def _wait_text(e2e: E2E, session_id: str, text: str, role: str = "assistant", timeout: float = 30.0) -> list[str]:
    return _wait(lambda: (texts := _texts(e2e, session_id, role)) and any(text in t for t in texts) and texts,
                 timeout, 0.2, f"{role} message containing {text!r}")


def _session(e2e: E2E, session_id: str) -> dict[str, Any]:
    return e2e.api.get(f"/sessions/{session_id}/meta")["session"]


def _wait_session(e2e: E2E, session_id: str, status: str, timeout: float = 30.0) -> dict[str, Any]:
    return _wait(lambda: (s := _session(e2e, session_id))["status"] == status and s, timeout, 0.2,
                 f"session {status}")


def _new_session(e2e: E2E, content: str) -> str:
    created = e2e.api.post(
        "/sessions/create-and-start",
        {
            "connectorId": e2e.connector_id,
            "projectId": e2e.project_id,
            "runtime": RUNTIME_TYPE,
            "runtimeId": e2e.runtime_id,
            "content": content,
            "clientMessageId": f"cm_{uuid.uuid4().hex}",
        },
    )
    return created["session"]["id"]


def _send(e2e: E2E, session_id: str, content: str, **options: Any) -> Any:
    return e2e.api.post(f"/sessions/{session_id}/runtime/messages",
                        {"content": content, "clientMessageId": f"cm_{uuid.uuid4().hex}", **options})


# The tests run in file order on one Server and one device; each step leaves what the next one uses.
# ---------------------------------------------------------------------------------------------------------------------


def test_device_pairs_and_comes_online(e2e: E2E) -> None:
    connector = e2e.wait_status("online", STARTUP_TIMEOUT)
    assert connector["name"] == "e2e laptop"
    listed = e2e.api.get("/connectors")["connectors"]
    assert [c["status"] for c in listed if c["id"] == e2e.connector_id] == ["online"]


def test_agent_types_and_enabling_an_instance(e2e: E2E) -> None:
    api = e2e.api

    def opencode() -> dict[str, Any] | None:
        types = api.get(f"{e2e.dev}/runtime-types")["runtimeTypes"]
        return next((t for t in types if t["runtimeType"] == RUNTIME_TYPE), None)

    described = _wait(opencode, 30, 0.2, "the opencode Agent type")
    assert described["available"] is True, described
    assert described["present"] is True
    created = api.post(f"{e2e.dev}/runtimes", {"runtimeType": RUNTIME_TYPE, "name": "Fake Agent", "config": {},
                                               "active": True}, expect=201)
    e2e.runtime_id = created["runtimeId"]
    assert created["name"] == "Fake Agent" and created["active"] is True
    runtime = f"{e2e.dev}/runtimes/{e2e.runtime_id}"

    def settled() -> dict[str, Any] | bool:
        view = api.get(runtime)
        return view["status"] in {"available", "running"} and view

    view = _wait(settled, 30, 0.2, "the instance applied on the device")
    assert view["error"] is None, view
    assert [r["runtimeId"] for r in api.get(f"{e2e.dev}/runtimes")["runtimes"]] == [e2e.runtime_id]

    # Change its configuration: the device applies it and the instance stays usable.
    cli = str(e2e.device.bin / RUNTIME_TYPE)
    changed = api.put(f"{runtime}/config", {"config": {"cliPath": cli}})
    assert changed["config"] == {"cliPath": cli}, changed
    view = _wait(lambda: (v := settled()) and v["config"] == {"cliPath": cli} and v, 30, 0.2, "the new config applied")
    assert view["error"] is None, view
    assert api.get(f"{runtime}/capabilities")["capabilitySet"]["revision"] >= 0


def test_session_create_and_assistant_reply(e2e: E2E) -> None:
    api = e2e.api
    project = api.post("/projects", {"connectorId": e2e.connector_id, "name": "repo",
                                     "workspacePath": str(e2e.device.workspace)})
    e2e.project_id = project["project"]["id"]
    e2e.need("runtime_id")
    session_id = _new_session(e2e, "hello e2e")
    socket = SessionSocket(api, session_id)
    try:
        _wait_text(e2e, session_id, "echo: hello e2e")
        assert any("hello e2e" in t for t in _texts(e2e, session_id, "user"))
        # Live: the next reply also arrives on the session WebSocket.
        _send(e2e, session_id, "second message")
        _wait_text(e2e, session_id, "echo: second message")
        _wait(lambda: any("echo: second message" in json.dumps(event) for event in socket.seen()), 15, 0.1,
              "the reply on the session WebSocket")
        assert socket.types()[0] == "session.subscribed"
    finally:
        socket.close()
    # With the Agent running, the instance's capabilities are known (named by the runtime type, not the instance).
    runtime_caps = _wait(
        lambda: api.get(f"{e2e.dev}/runtimes/{e2e.runtime_id}/capabilities")["capabilitySet"]["capabilities"],
        15, 0.2, "the instance's runtime capabilities")
    assert {c["runtime"] for c in runtime_caps} == {RUNTIME_TYPE}, runtime_caps
    assert "session.send_message" in {c["capabilityId"] for c in runtime_caps if c["supported"]}, runtime_caps
    capabilities = api.get(f"/sessions/{session_id}/runtime/capabilities")["capabilitySet"]["capabilities"]
    assert {c["runtime"] for c in capabilities} == {RUNTIME_TYPE}, capabilities
    usable = {c["capabilityId"] for c in capabilities if c["supported"] and c["available"]}
    assert {"session.send_message", "session.interrupt", "session.commands"} <= usable, capabilities
    listed = api.get("/sessions", params={"archived": "false"})["sessions"]
    assert session_id in [s["id"] for s in listed]
    e2e.session_id = session_id


def test_selections_switch_model_and_permission(e2e: E2E) -> None:
    api = e2e.api
    sid = e2e.need("session_id")
    patched = api.patch(f"/sessions/{sid}/runtime/selections", {"selections": {"model": "m2", "permission": "auto"}})
    assert patched["ok"] is True, patched
    assert patched["state"]["selections"] == {"mode": "default", "model": "m2", "permission": "auto"}, patched
    # The Agent really switched: it names its current model and permission in every reply.
    _send(e2e, sid, "after the switch")
    _wait_text(e2e, sid, "echo: after the switch [model=m2 permission=auto]")


def test_runtime_state_reports_the_current_selections(e2e: E2E) -> None:
    # What the composer shows after a reload: the selections from GET runtime/state.
    state = e2e.api.get(f"/sessions/{e2e.need('session_id')}/runtime/state")["state"]
    assert state.get("selections", {}).get("model") == "m2", state


def test_session_model_and_permission_catalogs(e2e: E2E) -> None:
    # The model and permission pickers' lists (served from the device's Runtime/catalogs).
    sid = e2e.need("session_id")
    models = e2e.api.get(f"/sessions/{sid}/runtime/catalogs/model")
    assert "m2" in json.dumps(models), models
    permissions = e2e.api.get(f"/sessions/{sid}/runtime/catalogs/permission")
    assert isinstance(permissions["catalog"]["permissions"], list), permissions


def test_prepared_creation_opens_the_agent_session_once(e2e: E2E) -> None:
    """The new-session page: prepare the workspace, read the real options, create; the creation reuses the session."""

    api = e2e.api
    e2e.need("runtime_id")
    # A directory of its own, so the Agent's count of sessions opened there is this test's alone.
    workspace = e2e.device.workspace / "prepared"
    workspace.mkdir(parents=True, exist_ok=True)
    project = api.post("/projects", {"connectorId": e2e.connector_id, "name": "prepared", "workspacePath": str(workspace)})
    capabilities = api.get(f"{e2e.dev}/runtimes/{e2e.runtime_id}/capabilities")["capabilitySet"]["capabilities"]
    assert "runtime.workspace.prepare" in {c["capabilityId"] for c in capabilities if c["supported"]}, capabilities
    opening = api.post("/runtime-workflows/preparations", {
        "connectorId": e2e.connector_id, "runtimeId": e2e.runtime_id, "projectId": project["project"]["id"],
        "clientPreparationId": f"client_{uuid.uuid4().hex}",
    }, expect=202)
    preparation_id = opening["id"]
    ready = _wait(lambda: (v := api.get(f"/runtime-workflows/preparation/{preparation_id}"))["state"]["phase"] == "ready" and v,
                  30, 0.2, "the preparation to be ready")
    state = ready["state"]
    models = {model["id"]: model for model in state["catalog"]["models"]}
    assert set(models) == {"m1", "m2"}, state
    assert "permission" in {option["id"] for option in state["configuration"]["options"]}, state
    # The Agent opened one session in the directory before anything was sent.
    created = api.post("/runtime-workflows/creations", {
        "preparationId": preparation_id, "createOperationId": f"op_{uuid.uuid4().hex}",
        "expectedRevision": state["revision"], "catalogRevision": state["catalogRevision"],
        "selections": {"model": models["m2"]["selectionId"]}, "configuration": {"permission": "auto"},
        "clientMessageId": f"cm_{uuid.uuid4().hex}", "content": "prepared hello",
    }, expect=202)
    assert created["state"].get("failure") is None, created
    session_id = created["sessionId"]
    accepted = _wait(
        lambda: (v := api.get(f"/runtime-workflows/creation/{created['id']}"))["state"].get("messageAccepted") is True and v,
        30, 0.2, "the first message accepted")
    assert accepted["state"]["phase"] == "accepted", accepted
    # The reply comes from the prepared session with the frozen choices applied; no second session was opened.
    _wait_text(e2e, session_id, "echo: prepared hello [model=m2 permission=auto] sessions-in-cwd=1")
    assert _session(e2e, session_id)["cwd"] == str(workspace)
    _send(e2e, session_id, "prepared again")
    _wait_text(e2e, session_id, "echo: prepared again [model=m2 permission=auto] sessions-in-cwd=1")


def test_planning_and_goal_state_are_fresh(e2e: E2E) -> None:
    api = e2e.api
    sid = e2e.need("session_id")
    # Read live from the device (offline they are "stale", see the last test).
    planning = api.get(f"/sessions/{sid}/planning")
    assert planning["sessionId"] == sid and planning["runtime"] == RUNTIME_TYPE, planning
    assert planning["freshness"] in {"fresh", "unknown"}, planning
    goal = api.get(f"/sessions/{sid}/goal")
    assert goal["sessionId"] == sid and goal["externalSessionId"], goal
    assert goal["freshness"] in {"fresh", "unknown"}, goal


def test_plan_markdown_download(e2e: E2E) -> None:
    api = e2e.api
    sid = e2e.need("session_id")
    _send(e2e, sid, "#plan the fix")
    _wait_text(e2e, sid, "echo: #plan the fix")
    plans = _wait(lambda: api.get(f"/sessions/{sid}/plans"), 15, 0.2, "a plan document")
    document = plans[0]
    planning = api.get(f"/sessions/{sid}/planning")
    assert planning["proposal"]["planId"] == document["planId"], planning
    assert "# E2E plan" in document["markdown"], document
    markdown = api.call("GET", f"/sessions/{sid}/plans/{document['planId']}/{document['revision']}/markdown")
    assert markdown.text.startswith("# E2E plan"), markdown.text
    assert "markdown" in markdown.headers.get("content-type", ""), markdown.headers


def test_interrupt_a_running_turn(e2e: E2E) -> None:
    sid = e2e.need("session_id")
    _send(e2e, sid, "#slow task")
    _wait_text(e2e, sid, "working slowly")
    _wait_session(e2e, sid, "running")
    e2e.api.post(f"/sessions/{sid}/runtime/interrupt")
    # Promptly: the device's outbox is woken by the summary, not found by its 15 s fallback poll.
    _wait_session(e2e, sid, "idle", timeout=5)
    assert not any("echo: #slow task" in t for t in _texts(e2e, sid))


def test_queued_message_runs_after_the_turn(e2e: E2E) -> None:
    api = e2e.api
    sid = e2e.need("session_id")
    _send(e2e, sid, "#slow again")
    _wait_session(e2e, sid, "running")
    sent = _send(e2e, sid, "queued message", queue="auto")
    assert sent["result"]["delivery"] == "queued", sent
    queue = api.get(f"/sessions/{sid}/runtime/queue")
    assert [item["content"] for item in queue["items"]] == ["queued message"], queue
    api.post(f"/sessions/{sid}/runtime/interrupt")
    _wait_text(e2e, sid, "echo: queued message")
    _wait(lambda: "queued message" not in json.dumps(api.get(f"/sessions/{sid}/runtime/queue")), 15, 0.2,
          "the queue drained")


def test_slash_commands_list_and_execute(e2e: E2E) -> None:
    api = e2e.api
    sid = e2e.need("session_id")
    commands = _wait(lambda: (c := api.get(f"/sessions/{sid}/runtime/commands"))["commands"] and c, 15, 0.2,
                     "the command catalog")
    names = [c.get("name") or c.get("id") for c in commands["commands"]]
    assert "review" in json.dumps(names), commands
    filtered = api.get(f"/sessions/{sid}/runtime/commands", params={"query": "rev", "limit": 5})
    assert len(filtered["commands"]) == 1, filtered
    executed = api.post(f"/sessions/{sid}/runtime/commands", {"command": "review", "args": ["src"]})
    assert executed["ok"] is True, executed
    _wait_text(e2e, sid, "echo: /review src")


def test_files_read_write_and_download(e2e: E2E) -> None:
    api = e2e.api
    root = str(e2e.device.workspace)
    (e2e.device.workspace / "notes").mkdir(exist_ok=True)
    written = api.post(f"{e2e.dev}/fs/write", {"path": "notes/a.txt", "content": "hello from the client\n"},
                       params={"root": root})
    assert (e2e.device.workspace / "notes/a.txt").read_text() == "hello from the client\n", written
    listed = api.post(f"{e2e.dev}/fs/list", {"root": root, "path": "notes"})
    assert [entry["name"] for entry in listed["result"]["entries"]] == ["a.txt"], listed
    text = api.post(f"{e2e.dev}/fs/readText", {"path": "notes/a.txt", "maxBytes": 65536}, params={"root": root})
    assert text["content"] == "hello from the client\n", text
    payload = os.urandom(300_000)
    (e2e.device.workspace / "blob.bin").write_bytes(payload)
    read = api.post(f"{e2e.dev}/fs/read", {"path": "blob.bin"}, params={"root": root})["result"]
    assert read["size"] == len(payload), read
    download = _wait(lambda: (r := api.call("GET", read["downloadUrl"].removeprefix("/api/v2"), expect=None))
                     .status_code == 200 and r, 30, 0.2, "the download")
    assert download.content == payload


def test_terminal_create_stream_write_resize_close(e2e: E2E) -> None:
    from websockets.sync.client import connect

    api = e2e.api
    root = str(e2e.device.workspace)
    created = api.post(f"{e2e.dev}/terminals-v2", {"cols": 80, "rows": 24, "label": "e2e"}, params={"root": root})
    terminal_id = created["result"]["terminalId"]
    assert [t["terminalId"] for t in api.get(f"{e2e.dev}/terminals-v2")["result"]["terminals"]] == [terminal_id]
    url = api.ws_url(f"/api/v2/connectors/{e2e.connector_id}/terminals-v2/{terminal_id}/stream"
                     f"?token={api.token}&fromSeq=0")
    frames: list[dict[str, Any]] = []
    with connect(url, open_timeout=10, max_size=None) as socket:

        def output() -> str:
            with contextlib.suppress(TimeoutError):
                while True:
                    frames.append(json.loads(socket.recv(timeout=0.2)))
            return "".join(base64.b64decode(f["data"]).decode("utf-8", "replace")
                           for f in frames if f.get("type") in {"replay", "output"} and f.get("data"))

        api.post(f"{e2e.dev}/terminals-v2/{terminal_id}/write",
                 {"dataBase64": base64.b64encode(b"echo e2e-$((40+2))\n").decode()})
        _wait(lambda: "e2e-42" in output(), 20, 0.1, "the command's output on the terminal stream")
        # Input over the stream itself, as the terminal panel sends it.
        # Input and resizing over the stream itself, as the terminal panel sends them (input in base64).
        socket.send(json.dumps({"type": "input", "data": base64.b64encode(b"echo via-ws-$((1+1))\n").decode()}))
        _wait(lambda: "via-ws-2" in output(), 20, 0.1, "input sent over the stream")
        socket.send(json.dumps({"type": "resize", "cols": 100, "rows": 30}))
        socket.send(json.dumps({"type": "input", "data": base64.b64encode(b"stty size\n").decode()}))
        _wait(lambda: "30 100" in output(), 20, 0.1, "the size set over the stream")
        api.post(f"{e2e.dev}/terminals-v2/{terminal_id}/resize", {"cols": 120, "rows": 40})
        api.post(f"{e2e.dev}/terminals-v2/{terminal_id}/write",
                 {"dataBase64": base64.b64encode(b"stty size\n").decode()})
        _wait(lambda: "40 120" in output(), 20, 0.1, "the size set through the API")
        api.delete(f"{e2e.dev}/terminals-v2/{terminal_id}")
        _wait(lambda: output() is not None and any(f.get("type") == "exit" for f in frames), 20, 0.1,
              "the exit frame")
    assert api.get(f"{e2e.dev}/terminals-v2")["result"]["terminals"] == []


def test_takeover_switch(e2e: E2E) -> None:
    api = e2e.api
    sid = e2e.need("session_id")
    on = api.post(f"/sessions/{sid}/takeover")
    assert on["session"]["takeover"] is True, on
    assert _session(e2e, sid)["takeover"] is True
    off = api.delete(f"/sessions/{sid}/takeover")
    assert off["session"]["takeover"] is False, off
    assert _session(e2e, sid)["takeover"] is False
    # Read-only now: a message is refused by the Server.
    refused = api.call("POST", f"/sessions/{sid}/runtime/messages",
                       json={"content": "read-only", "clientMessageId": f"cm_{uuid.uuid4().hex}"}, expect=409)
    assert "takeover" in refused.text, refused.text
    assert api.post(f"/sessions/{sid}/takeover")["session"]["takeover"] is True


def test_device_settings_change(e2e: E2E) -> None:
    api = e2e.api
    current = api.get(f"{e2e.dev}/device-settings")
    settings = current["settings"]
    key = next(k for k, v in settings.items() if isinstance(v, bool))
    changed = api.patch(f"{e2e.dev}/device-settings", {key: not settings[key]})
    assert changed["settings"][key] is (not settings[key]), changed
    assert changed["delivered"] is True, changed
    assert api.get(f"{e2e.dev}/device-settings")["settings"][key] is (not settings[key])


def test_offline_reads_and_commands_then_reconnect(e2e: E2E) -> None:
    api = e2e.api
    sid = e2e.need("session_id")
    e2e.device.stop()
    e2e.wait_status("offline", 90)
    assert [c["status"] for c in api.get("/connectors")["connectors"]] == ["offline"]
    # Reads answer 200 and say the device is offline.
    timeline = api.get(f"/sessions/{sid}/timeline", params={"mode": "latest", "limit": 50})
    assert timeline.get("deviceOffline") is True and timeline["items"] == [], timeline
    queue = api.get(f"/sessions/{sid}/runtime/queue")
    assert queue.get("deviceOffline") is True, queue
    for path in ("planning", "goal"):
        assert api.get(f"/sessions/{sid}/{path}")["freshness"] == "stale", path
    # Commands are refused with 409.
    for method, path, body in (
        ("POST", f"/sessions/{sid}/runtime/messages", {"content": "while offline", "clientMessageId": "cm_offline"}),
        ("POST", f"/sessions/{sid}/runtime/interrupt", {}),
        ("PATCH", f"/sessions/{sid}/runtime/selections", {"selections": {"model": "m1"}}),
        ("POST", f"{e2e.dev}/fs/list", {"root": str(e2e.device.workspace), "path": ""}),
        ("POST", f"{e2e.dev}/terminals-v2?root={e2e.device.workspace}", {"cols": 80, "rows": 24}),
    ):
        refused = api.call(method, path, json=body, expect=409)
        assert "offline" in refused.text, (path, refused.text)

    e2e.device.start("start")
    e2e.wait_status("online", STARTUP_TIMEOUT)
    assert any("echo: hello e2e" in t for t in _texts(e2e, sid))
    _send(e2e, sid, "after reconnect")
    _wait_text(e2e, sid, "echo: after reconnect")
