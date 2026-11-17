"""v3 recovery end to end (S6): the MeshCall Router and the Server restart under a running device.

Same environment as ``test_v3_e2e.py`` (``v3_e2e_harness``): the real Server, a real Router and the real TS
Connector with the fake ACP Agent. Each test builds its own environment, so the tests are independent.

- Router killed and started again on the same port: the device says hello again (new Mesh token), registers its
  services and calls ready; clients see it offline and then online; a command in flight when the Router died is
  reported as ``command_outcome_unknown`` (not offline) and is never re-sent; what the device produced meanwhile
  (a ``command.result``, the summary of a turn that ended) reaches the Server through the outbox exactly once;
  messages, reads and the session WebSocket work again.
- Server killed and started again on the same database: the device keeps its Router connection and calls ready
  again; with Redis (``AA_E2E_REDIS_URL``, keys under a prefix of their own) the new worker takes the link over without a new hello, a
  single process without Redis refuses the stale connection and the device says hello once more. Either way the
  new worker holds the link.

    MESHCALL_ROUTER_BINARY=/path/to/meshcall-router uv run pytest tests/test_v3_e2e_recovery.py -v
"""

from __future__ import annotations

import json
import os
import secrets
import signal
import threading
import time
import uuid
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from v3_e2e_harness import (
    E2E,
    STARTUP_TIMEOUT,
    SessionSocket,
    create_project,
    e2e_environment,
    enable_fake_agent,
    new_session,
    send_message,
    session_meta,
    skip_reason,
    texts,
    wait_for,
    wait_session,
    wait_text,
)

pytestmark = pytest.mark.skipif(skip_reason() is not None, reason=skip_reason() or "")

REGISTERED = r"registered .* as "
READY_AGAIN = r"Link/attach .*; calling ready again"
HELLO_AGAIN = r"ready refused .*; saying hello again"


def _redis_url() -> str | None:
    # Not AGENT_SERVER_TEST_REDIS_URL: test_e2ee_canary.py needs that database empty and flushes it.
    return os.environ.get("AA_E2E_REDIS_URL", "").strip() or None


@pytest.fixture
def recovery(request: pytest.FixtureRequest) -> Iterator[E2E]:
    server_env: dict[str, str] = {}
    if getattr(request, "param", None) == "redis":
        redis = _redis_url()
        if redis is None:
            pytest.skip("AA_E2E_REDIS_URL not set")
        # A prefix of its own: the keys of other runs on the same Redis are not touched.
        server_env = {"AGENT_SERVER_REDIS_URL": redis, "AGENT_SERVER_REDIS_PREFIX": f"aa-e2e-{secrets.token_hex(4)}"}
    with e2e_environment(request, server_env=server_env) as env:
        env.wait_status("online", STARTUP_TIMEOUT)
        enable_fake_agent(env)
        create_project(env)
        env.session_id = new_session(env, "hello recovery")
        wait_text(env, env.session_id, "echo: hello recovery")
        wait_session(env, env.session_id, "idle")
        yield env


def _receipts(env: E2E, session_id: str) -> list[dict[str, Any]]:
    return env.query(
        "SELECT command_id, kind, state FROM device_commands WHERE session_id = $1 ORDER BY created_at", session_id
    )


def _count(found: list[str], text: str) -> int:
    return sum(1 for t in found if text in t)


def _in_background(call: Any) -> tuple[threading.Thread, dict[str, Any]]:
    out: dict[str, Any] = {}

    def run() -> None:
        try:
            out["response"] = call()
        except Exception as exc:  # noqa: BLE001 - reported by the test
            out["error"] = exc

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, out


def test_router_restart_recovers_link_commands_outbox_and_live_events(recovery: E2E) -> None:
    env = recovery
    api = env.api
    sid = env.session_id
    workspace = env.device.workspace
    registered = env.device.log.count(REGISTERED)
    assert registered >= 1, env.diagnostics()
    socket = SessionSocket(api, sid)
    try:
        wait_for(lambda: "session.subscribed" in socket.types(), 10, 0.05, "the session WebSocket subscribed")

        # A turn that ends while the link is down (the Agent answers after 3 s): its summary waits in the outbox.
        send_message(env, sid, "#later while the router is down")
        # A command in flight when the Router dies: the Agent takes 2.5 s to switch the model; its command.result
        # waits in the outbox too.
        (workspace / ".e2e-slow-config").write_text("2500")
        calls = workspace / ".e2e-config-calls"
        select, selected = _in_background(lambda: api.call(
            "PATCH", f"/sessions/{sid}/runtime/selections", json={"selections": {"model": "m2"}}, expect=None))
        wait_for(lambda: calls.exists() or selected, 15, 0.02, "the selection reached the Agent")
        assert not selected, selected
        killed = time.monotonic()
        env.router.proc.send_signal(signal.SIGKILL)  # type: ignore[union-attr]
        env.router.proc.wait(5)  # type: ignore[union-attr]
        env.router.proc = None

        # Offline for the clients, promptly.
        env.wait_status("offline", 30)
        offline_after = time.monotonic() - killed
        select.join(40)
        assert not select.is_alive(), "the in-flight command never returned"
        response: httpx.Response = selected["response"]
        # The call had opened on the device: the outcome is unknown, not "offline".
        assert response.status_code == 504, (response.status_code, response.text)
        assert "command_outcome_unknown" in response.text, response.text
        [receipt] = [r for r in _receipts(env, sid) if r["state"] == "unknown"]
        # While the Router is down: reads say offline, commands are refused as offline.
        timeline = api.get(f"/sessions/{sid}/timeline", params={"mode": "latest", "limit": 20})
        assert timeline.get("deviceOffline") is True, timeline
        refused = api.call("POST", f"/sessions/{sid}/runtime/messages",
                           json={"content": "while down", "clientMessageId": f"cm_{uuid.uuid4().hex}"}, expect=409)
        assert "offline" in refused.text, refused.text
        # Long enough for the select (2.5 s) and the turn (3 s) to finish on the device with nobody to tell.
        time.sleep(max(0.0, 6.5 - (time.monotonic() - killed)))

        restarted = time.monotonic()
        env.router.start()
        env.wait_status("online", 60)
        online_after = time.monotonic() - restarted
        # A new hello (the Router forgot every token) and the services registered again.
        assert env.device.log.count(REGISTERED) > registered, env.diagnostics()

        # The unknown receipt converged from the outbox (or Commands/status) to accepted; nothing ran twice.
        wait_for(lambda: next(r for r in _receipts(env, sid) if r["command_id"] == receipt["command_id"])["state"]
                 == "accepted", 30, 0.2, "the unknown receipt settled")
        assert calls.read_text().splitlines() == ["model=m2"], calls.read_text()
        state = api.get(f"/sessions/{sid}/runtime/state")["state"]
        assert state["selections"]["model"] == "m2", state
        assert sum(1 for r in _receipts(env, sid) if r["command_id"] == receipt["command_id"]) == 1
        (workspace / ".e2e-slow-config").unlink()

        # The turn that ended while the link was down: its reply once in the timeline, and its summary (idle)
        # applied once on the Server.
        found = wait_text(env, sid, "echo: #later while the router is down")
        assert _count(found, "echo: #later while the router is down") == 1, found
        wait_session(env, sid, "idle", 30)
        rows = env.query("SELECT id FROM sessions WHERE connector_id = $1", env.connector_id)
        assert [row["id"] for row in rows] == [sid], rows

        # Messages and reads work again, and the reply arrives live on the session WebSocket.
        send_message(env, sid, "after the router restart")
        found = wait_text(env, sid, "echo: after the router restart")
        assert _count(found, "echo: after the router restart") == 1, found
        assert any("echo: hello recovery" in t for t in found)
        live = _live_socket(env, socket, sid, "echo: after the router restart")
        if live is not socket:
            live.close()
        print(f"\nS6 Router restart: offline after {offline_after:.2f}s, online {online_after:.2f}s after the Router"
              f" came back; session WebSocket {'kept' if live is socket else 'reconnected'}")
    finally:
        socket.close()


def _live_socket(env: E2E, socket: SessionSocket, sid: str, text: str) -> SessionSocket:
    """The reply on the WebSocket the client kept; a client whose socket closed reconnects with its cursor."""

    def seen(sock: SessionSocket) -> bool:
        return any(text in json.dumps(event) for event in sock.seen())

    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if seen(socket):
            return socket
        if socket.closed.is_set():
            break
        time.sleep(0.1)
    assert socket.closed.is_set(), f"the open session WebSocket missed the reply: {socket.types()}"
    # The Server closed the socket: reconnect like the clients do and catch up.
    fresh = SessionSocket(env.api, sid)
    wait_for(lambda: seen(fresh) or (send_message(env, sid, "nudge") and False), 15, 0.5, "the reply after a reconnect")
    return fresh


@pytest.mark.parametrize("recovery", ["memory", "redis"], indirect=True)
def test_server_restart_reattaches_the_device(recovery: E2E) -> None:
    env = recovery
    api = env.api
    sid = env.session_id
    registered = env.device.log.count(REGISTERED)
    ready_again = env.device.log.count(READY_AGAIN)
    killed = time.monotonic()
    env.server.kill()
    env.server.start()
    started = time.monotonic()
    env.wait_status("online", 90)
    online_after = time.monotonic() - started
    # The device kept its Router connection and called ready again. With Redis the new worker knows the
    # connection: no new hello, no new registration. A single process without Redis forgot it: ready is refused
    # as stale and the device says hello once more.
    wait_for(lambda: env.device.log.count(READY_AGAIN) > ready_again, 30, 0.2, "ready called again")
    if env.server.env.get("AGENT_SERVER_REDIS_URL"):
        assert env.device.log.count(REGISTERED) == registered, env.diagnostics()
    else:
        assert env.device.log.find(HELLO_AGAIN), env.diagnostics()
        assert env.device.log.count(REGISTERED) == registered + 1, env.diagnostics()
    # The new worker holds the link: commands, reads and live events go through it.
    assert session_meta(env, sid)["status"] == "idle"
    socket = SessionSocket(api, sid)
    try:
        send_message(env, sid, "after the server restart")
        found = wait_text(env, sid, "echo: after the server restart")
        assert _count(found, "echo: after the server restart") == 1, found
        wait_for(lambda: any("echo: after the server restart" in json.dumps(e) for e in socket.seen()), 15, 0.1,
                 "the reply on the session WebSocket")
    finally:
        socket.close()
    assert any("echo: hello recovery" in t for t in texts(env, sid))
    print(f"\nS6 Server restart: device online {online_after:.2f}s after the new worker started"
          f" ({time.monotonic() - killed:.2f}s since the kill)")
