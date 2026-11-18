"""The v3 end-to-end environment: the real Server, a real MeshCall Router and the real TS Connector.

Shared by ``test_v3_e2e.py`` (the feature walk), ``test_v3_e2e_recovery.py`` (Router and Server restarts),
``test_v3_e2e_e2ee.py`` (``AGENT_SERVER_E2EE=required``) and ``scripts/bench_v3_e2e.py`` (latency baselines).

- ``Server``: ``uvicorn agent_server.app:create_app`` on a database of its own; restartable on the same port.
- ``Device``: ``anywhere-cli`` from ``connector-ts`` (``test/support/e2e-device.ts``) with a temporary home, PATH
  and workspace; the only fake is the Agent (``test/support/fake-acp-e2e.mjs`` installed as ``opencode``).
- ``Api`` / ``SessionSocket``: the client side, only the HTTP and WebSocket API the clients use.
- ``e2e_environment()``: creates the database, starts Router, Server and device, signs up and pairs; tears
  everything down and keeps the logs of a failed run (or with ``AA_E2E_KEEP=1``).

Needs a Router binary (``MESHCALL_ROUTER_BINARY`` or ``meshcall-router`` on PATH), Node >= 22.13 with
``connector-ts/node_modules`` installed and the PostgreSQL of ``AGENT_SERVER_TEST_DB_URL``; ``skip_reason()``
says what is missing.
"""

from __future__ import annotations

import asyncio
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
def node_binary() -> str | None:
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


def skip_reason() -> str | None:
    if router_binary() is None:
        return "MeshCall Router binary not available (set MESHCALL_ROUTER_BINARY)"
    if node_binary() is None:
        return "Node >= 22.13 not on PATH"
    if not (CONNECTOR_TS / "node_modules/meshcall").exists():
        return "connector-ts dependencies not installed (cd connector-ts && yarn install)"
    return None


def node_command(script: Path, *args: str) -> list[str]:
    """Runs a TS file of ``connector-ts`` with Node's type stripping and the repository's import hooks."""
    return [
        node_binary() or "node",
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        str(CONNECTOR_TS / "test/support/ts-resolve.mjs"),
        str(script),
        *args,
    ]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(check: Callable[[], Any], timeout: float = 15.0, interval: float = 0.1, what: str = "condition") -> Any:
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

    def count(self, pattern: str) -> int:
        with self._lock:
            lines = list(self.lines)
        return sum(1 for line in lines if re.search(pattern, line))

    def tail(self, count: int = 60) -> str:
        with self._lock:
            return "\n".join(self.lines[-count:])


def stop_process(proc: subprocess.Popen[bytes] | None, timeout: float = 10.0) -> None:
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
        self.node = node_binary() or "node"
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

    def env(self) -> dict[str, str]:
        return {
            "HOME": str(self.home),
            # Only the fake Agent and the basics: no Codex, Claude or Pi of this machine is found.
            "PATH": f"{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin",
            "MESHCALL_ROUTER_BINARY": self.router,
            "AGENT_CONNECTOR_WORKSPACE_ROOTS": str(self.workspace),
            "TMPDIR": str(self.root),
            "LANG": "C.UTF-8",
        }

    def start(self, *command: str) -> None:
        assert self.proc is None or self.proc.poll() is not None
        self.starts += 1
        self.proc = subprocess.Popen(
            node_command(DEVICE_SCRIPT, str(self.home), *command),
            cwd=str(CONNECTOR_TS),
            env=self.env(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.log = LogTail(self.proc, self.root / f"device-{self.starts}.log")

    def run(self, *command: str, timeout: float = 60.0) -> str:
        """A second ``anywhere-cli`` command next to the running one (``pair-client``); returns its output."""
        done = subprocess.run(
            node_command(DEVICE_SCRIPT, str(self.home), *command),
            cwd=str(CONNECTOR_TS),
            env=self.env(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        output = done.stdout.decode("utf-8", "replace") + done.stderr.decode("utf-8", "replace")
        with (self.root / "device-commands.log").open("a", encoding="utf-8") as sink:
            sink.write(f"$ {' '.join(command)} -> {done.returncode}\n{output}\n")
        assert done.returncode == 0, output
        return output

    def stop(self) -> None:
        stop_process(self.proc, 15)


class Server:
    """``uvicorn agent_server.app:create_app`` on a fresh database; ``restart()`` keeps the port and the secret."""

    def __init__(
        self, root: Path, database_url: str, router: RouterProcess, *, extra_env: dict[str, str] | None = None
    ) -> None:
        self.root = root
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("AGENT_SERVER_")}
        self.env.update(
            {
                "AGENT_SERVER_DB_URL": database_url,
                "AGENT_SERVER_SECRET": secrets.token_hex(32),
                "AGENT_SERVER_PUBLIC_ORIGIN": self.url,
                "AGENT_SERVER_FILES_LOCAL_ROOT": str(root / "files"),
                "AGENT_SERVER_MESH_ROUTER_URL": router.url,
                "AGENT_SERVER_MESH_PASSWORD": router.password,
                "AGENT_SERVER_MESH_PUBLIC_URL": router.url,
                "AGENT_SERVER_PASSWORD_ITERATIONS": "1000",
                **(extra_env or {}),
            }
        )
        self.log_path = root / "server.log"
        self.proc: subprocess.Popen[bytes] | None = None
        self.log: LogTail
        self.starts = 0
        self.start()

    def start(self) -> None:
        assert self.proc is None or self.proc.poll() is not None
        self.starts += 1
        self.proc = subprocess.Popen(
            [
                sys.executable, "-m", "uvicorn", "agent_server.app:create_app", "--factory",
                "--host", "127.0.0.1", "--port", str(self.port), "--no-access-log",
            ],
            cwd=str(SERVER_DIR),
            env=self.env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.log = LogTail(self.proc, self.log_path)
        proc = self.proc

        def ready() -> bool:
            assert proc.poll() is None, f"Server exited:\n{self.log.tail()}"
            with contextlib.suppress(httpx.HTTPError):
                return httpx.get(f"{self.url}/api/v2/health", timeout=1).status_code < 500
            return False

        wait_for(ready, STARTUP_TIMEOUT, 0.2, "Server health")

    def kill(self) -> None:
        """SIGKILL: no shutdown hook runs (a crashed worker)."""
        if self.proc is not None and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(10)

    def stop(self) -> None:
        stop_process(self.proc)


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

    def __init__(self, api: Api, session_id: str, after_cursor: str | None = None) -> None:
        from websockets.sync.client import connect

        ticket = api.post("/ws-ticket", {"clientId": f"e2e-{uuid.uuid4().hex[:8]}", "scope": {"sessionId": session_id}})
        url = api.ws_url(f"/api/v2/sessions/{session_id}/ws?ticket={ticket['ticket']}&protocol=1.2")
        if after_cursor:
            url += f"&afterCursor={after_cursor}"
        self._connection = connect(url, open_timeout=10, max_size=None)
        self.socket = self._connection.__enter__()
        self.events: list[dict[str, Any]] = []
        self.closed = threading.Event()
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()

    def _read(self) -> None:
        with contextlib.suppress(Exception):
            for message in self.socket:
                with self._lock:
                    self.events.append(json.loads(message))
        self.closed.set()

    def seen(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.events)

    def types(self) -> list[str]:
        return [str(event.get("type")) for event in self.seen()]

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._connection.__exit__(None, None, None)


class E2E:
    def __init__(self, root: Path, server: Server, device: Device, router: RouterProcess, database_url: str) -> None:
        self.root = root
        self.server = server
        self.device = device
        self.router = router
        self.database_url = database_url
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
        return wait_for(lambda: (c := self.connector())["status"] == status and c, timeout, 0.2, f"device {status}")

    def device_alive(self) -> bool:
        proc = self.device.proc
        assert proc is not None and proc.poll() is None, f"the device exited:\n{self.diagnostics()}"
        return True

    def diagnostics(self) -> str:
        device_log = self.device.log.tail(80) if self.device.log else ""
        return f"--- server ---\n{self.server.log.tail(80)}\n--- device ---\n{device_log}"

    def query(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        """Reads the Server's database directly (assertions on what the Server stored)."""
        import asyncpg

        async def run() -> list[dict[str, Any]]:
            connection = await asyncpg.connect(_asyncpg_url(self.database_url))
            try:
                return [dict(row) for row in await connection.fetch(sql, *args)]
            finally:
                await connection.close()

        return asyncio.run(run())


async def _create_database(name: str) -> None:
    await _run_maintenance(_asyncpg_url(TEST_DATABASE_URL), f'CREATE DATABASE "{name}"')


async def _drop_database(name: str) -> None:
    await _run_maintenance(_asyncpg_url(TEST_DATABASE_URL), f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@contextlib.contextmanager
def e2e_environment(
    request: pytest.FixtureRequest | None,
    *,
    server_env: dict[str, str] | None = None,
    router_cls: type[RouterProcess] = RouterProcess,
    keep: bool = False,
) -> Iterator[E2E]:
    """Database, Router, Server and a paired device; ``request`` is used to keep the logs of a failed run."""
    from agent_server.infra.db.migrations import upgrade_database

    failed_before = request.session.testsfailed if request is not None else 0

    # Short: the Connector's local Router listens on a Unix socket under the home (103-byte limit).
    root = Path(tempfile.mkdtemp(prefix="aae2e-", dir="/tmp" if os.path.isdir("/tmp") else None))
    name = f"aa_e2e_test_{secrets.token_hex(4)}"
    try:
        asyncio.run(_create_database(name))
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"PostgreSQL not reachable: {exc}")
    database_url = f"{TEST_DATABASE_URL.rpartition('/')[0]}/{name}"
    router = router_cls()
    server: Server | None = None
    device: Device | None = None
    failed = False
    try:
        upgrade_database(db_url=database_url)
        router.start()
        server = Server(root, database_url, router, extra_env=server_env)
        device = Device(root / "device", router.binary)
        env = E2E(root, server, device, router, database_url)
        sign_up_and_pair(env)
        yield env
    except Exception:
        failed = True
        raise
    finally:
        if device is not None:
            device.stop()
        if server is not None:
            server.stop()
        router.stop()
        asyncio.run(_drop_database(name))
        # The Server's and the device's logs stay for a failed run (or with AA_E2E_KEEP=1).
        failed = failed or (request is not None and request.session.testsfailed > failed_before)
        if keep or os.environ.get("AA_E2E_KEEP") == "1" or failed:
            print(f"\nE2E logs kept in {root}")
        else:
            shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(router.dir, ignore_errors=True)


def sign_up_and_pair(env: E2E) -> None:
    api = env.api
    # First run: the admin signs up with the setup token from the Server's log.
    api.get("/auth/config")
    token = wait_for(lambda: env.server.log.find(r"setup-token: (\S+)"), 10, 0.1, "setup token in the Server log")
    auth = api.post("/auth/register", {"email": "e2e@example.com", "displayName": "E2E", "password": "e2e-password-123", "setupToken": token.group(1)})
    api.token = auth["accessToken"]
    # The device asks for a pairing code; the client claims it.
    env.device.start("pair", env.server.url)
    code = wait_for(lambda: env.device_alive() and env.device.log.find(r"Pairing code: (\S+)"), STARTUP_TIMEOUT, 0.1,
                    "pairing code")
    claimed = api.post("/pairing/claim", {"code": code.group(1), "name": "e2e laptop"})
    env.connector_id = claimed["connector"]["id"]


def enable_fake_agent(env: E2E) -> str:
    """Creates the ``opencode`` instance on the device and waits until it is usable; returns its id."""
    api = env.api

    def described() -> dict[str, Any] | None:
        types = api.get(f"{env.dev}/runtime-types")["runtimeTypes"]
        return next((t for t in types if t["runtimeType"] == RUNTIME_TYPE and t["available"]), None)

    wait_for(described, 30, 0.2, "the opencode Agent type")
    created = api.post(f"{env.dev}/runtimes", {"runtimeType": RUNTIME_TYPE, "name": "Fake Agent", "config": {},
                                               "active": True}, expect=201)
    env.runtime_id = created["runtimeId"]
    wait_for(lambda: api.get(f"{env.dev}/runtimes/{env.runtime_id}")["status"] in {"available", "running"},
             30, 0.2, "the instance applied on the device")
    return env.runtime_id


def create_project(env: E2E, name: str = "repo", workspace: Path | None = None) -> str:
    project = env.api.post("/projects", {"connectorId": env.connector_id, "name": name,
                                         "workspacePath": str(workspace or env.device.workspace)})
    env.project_id = project["project"]["id"]
    return env.project_id


def items(timeline: dict[str, Any]) -> list[dict[str, Any]]:
    return list(timeline.get("items") or [])


def texts(e2e: E2E, session_id: str, role: str = "assistant") -> list[str]:
    timeline = e2e.api.get(f"/sessions/{session_id}/timeline", params={"mode": "latest", "limit": 200})
    assert not timeline.get("deviceOffline"), timeline
    return [
        str((item.get("content") or {}).get("text") or "")
        for item in items(timeline)
        if item.get("type") == "message" and item.get("role") == role
    ]


def wait_text(e2e: E2E, session_id: str, text: str, role: str = "assistant", timeout: float = 30.0) -> list[str]:
    return wait_for(lambda: (found := texts(e2e, session_id, role)) and any(text in t for t in found) and found,
                    timeout, 0.2, f"{role} message containing {text!r}")


def session_meta(e2e: E2E, session_id: str) -> dict[str, Any]:
    return e2e.api.get(f"/sessions/{session_id}/meta")["session"]


def wait_session(e2e: E2E, session_id: str, status: str, timeout: float = 30.0) -> dict[str, Any]:
    return wait_for(lambda: (s := session_meta(e2e, session_id))["status"] == status and s, timeout, 0.2,
                    f"session {status}")


def wait_first_turn_reported(e2e: E2E, session_id: str, timeout: float = 30.0) -> dict[str, Any]:
    """Waits until the Server holds the device's summary of the session's finished first turn.

    ``wait_session(..., "idle")`` alone also matches the directory row the Server creates before the device's
    first ``session.summary`` arrives; until the outbox delivers it the stored state can still change
    (pending, running, idle). A turn end (``latestTurnEndSeq``) only comes with the device's report.
    """
    return wait_for(
        lambda: (s := session_meta(e2e, session_id))["status"] == "idle" and s["latestTurnEndSeq"] > 0 and s,
        timeout, 0.2, "the device's summary of the finished first turn",
    )


def new_session(e2e: E2E, content: str) -> str:
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


def send_message(e2e: E2E, session_id: str, content: str, **options: Any) -> Any:
    return e2e.api.post(f"/sessions/{session_id}/runtime/messages",
                        {"content": content, "clientMessageId": f"cm_{uuid.uuid4().hex}", **options})
