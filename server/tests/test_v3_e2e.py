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

import base64
import contextlib
import json
import os
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from v3_e2e_harness import (
    E2E,
    RUNTIME_TYPE,
    STARTUP_TIMEOUT,
    SessionSocket,
    e2e_environment,
    skip_reason,
)
from v3_e2e_harness import new_session as _new_session
from v3_e2e_harness import send_message as _send
from v3_e2e_harness import session_meta as _session
from v3_e2e_harness import texts as _texts
from v3_e2e_harness import wait_for as _wait
from v3_e2e_harness import wait_session as _wait_session
from v3_e2e_harness import wait_text as _wait_text

# The steps share one Server, Router and device and run in order; scripts/check_tests.py distributes
# with --dist loadfile so the whole file stays on one xdist worker.
pytestmark = pytest.mark.skipif(skip_reason() is not None, reason=skip_reason() or "")


@pytest.fixture(scope="module")
def e2e(request: pytest.FixtureRequest) -> Iterator[E2E]:
    with e2e_environment(request) as env:
        # Start every test from an online device, whichever runs first.
        env.wait_status("online", STARTUP_TIMEOUT)
        yield env


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


def test_snapshot_opens_the_session(e2e: E2E) -> None:
    # The first screen of the Web client: one snapshot with the latest Timeline page and the event cursor.
    sid = e2e.need("session_id")
    snapshot = e2e.api.get(f"/sessions/{sid}/snapshot", params={"limit": 50})
    assert snapshot["session"]["id"] == sid, snapshot
    texts = json.dumps(snapshot["timeline"]["items"])
    assert "echo: hello e2e" in texts and "echo: second message" in texts, snapshot
    assert snapshot["eventCursor"], snapshot
    assert snapshot["state"]["sessionId"] == sid and snapshot["state"]["selections"], snapshot


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
