"""What the Server answers today for every client route a v3 device owns, kept as fixtures.

The same stack as ``test_v3_e2e.py`` (a real Server, Router and TS Connector with the fake ACP Agent), driven through
the HTTP API in normal mode. Each route's request and response go to ``fixtures/client_routes/<route>.json``;
connector-ts (``test/sync/client-routes.test.ts``) answers the same requests from ``DeviceTunnelApi`` and asserts that
its responses have the same shape. Once the device answers these routes itself, the fixtures pin the shape the
clients already parse.

Without ``UPDATE_CLIENT_ROUTES=1`` the run compares the Server's answers with the stored fixtures (same status, same
shape); with it the fixtures are written again.

    UPDATE_CLIENT_ROUTES=1 MESHCALL_ROUTER_BINARY=/path/to/meshcall-router uv run pytest tests/test_client_routes_record.py

Shape rules (``shape_mismatches``, the same in the vitest): values are not compared, only JSON types and object keys;
``null`` matches any type (ids, timestamps and optional fields differ from run to run); the keys of the open maps in
``OPEN_MAPS`` are not compared; array items are compared by their ``type`` when they have one, else item by item
against the first item of the other side; an empty array matches any array.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any

import httpx
import pytest
from test_v3_e2e import e2e  # noqa: F401  (the module fixture)
from test_v3_e2e import test_agent_types_and_enabling_an_instance as _enable_instance
from test_v3_e2e import test_device_pairs_and_comes_online as _come_online
from v3_e2e_harness import E2E
from v3_e2e_harness import new_session as _new_session
from v3_e2e_harness import send_message as _send
from v3_e2e_harness import skip_reason as _skip_reason
from v3_e2e_harness import wait_for as _wait
from v3_e2e_harness import wait_session as _wait_session
from v3_e2e_harness import wait_text as _wait_text

pytestmark = pytest.mark.skipif(_skip_reason() is not None, reason=_skip_reason() or "")

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "client_routes"
UPDATE = os.environ.get("UPDATE_CLIENT_ROUTES") == "1"

# Objects whose keys are data (selections, free-form metadata), not part of the shape.
OPEN_MAPS = frozenset({"selections", "metadata", "parameters", "context", "input", "content", "env", "config", "catalogs", "r", "payload", "source", "details"})


def _kind(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def shape_mismatches(expected: Any, actual: Any, path: str = "$") -> list[str]:
    """Where ``actual`` does not have the shape of ``expected`` (empty when it does)."""

    a, b = _kind(expected), _kind(actual)
    if a == "null" or b == "null":
        return []
    if a != b:
        return [f"{path}: {a} != {b}"]
    if a == "object":
        if path.rsplit(".", 1)[-1] in OPEN_MAPS:
            return []
        out: list[str] = []
        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        if missing:
            out.append(f"{path}: missing {missing}")
        if extra:
            out.append(f"{path}: extra {extra}")
        for key in sorted(set(expected) & set(actual)):
            out.extend(shape_mismatches(expected[key], actual[key], f"{path}.{key}"))
        return out
    if a == "array":
        if not expected or not actual:
            return []
        typed = all(isinstance(item, dict) and "type" in item for item in [*expected, *actual])
        out = []
        if typed:
            by_type = {item["type"]: item for item in expected}
            for index, item in enumerate(actual):
                if item["type"] in by_type:
                    out.extend(shape_mismatches(by_type[item["type"]], item, f"{path}[{index}]"))
            return out
        for index, item in enumerate(actual):
            out.extend(shape_mismatches(expected[0], item, f"{path}[{index}]"))
        return out
    return []


class Recorder:
    def __init__(self, env: E2E) -> None:
        self.env = env
        self.names: dict[str, str] = {}
        self.seen: list[str] = []

    def name(self, placeholder: str, value: str) -> None:
        self.names[placeholder] = value

    def _fill(self, value: Any) -> Any:
        text = json.dumps(value)
        for placeholder, actual in self.names.items():
            text = text.replace("{" + placeholder + "}", actual)
        return json.loads(text)

    def _template(self, value: Any) -> Any:
        text = json.dumps(value)
        # Longest first: a root path contains no id, but an id may be a prefix of another.
        for placeholder, actual in sorted(self.names.items(), key=lambda item: -len(item[1])):
            text = text.replace(json.dumps(actual)[1:-1], "{" + placeholder + "}")
        return json.loads(text)

    def record(self, route: str, method: str, path: str, *, query: dict[str, Any] | None = None,
               body: Any = None, note: str | None = None) -> Any:
        """Call the route, then write or check its fixture; returns the response body."""

        kwargs: dict[str, Any] = {}
        if query is not None:
            kwargs["params"] = self._fill(query)
        if body is not None:
            kwargs["json"] = self._fill(body)
        try:
            response = self.env.api.call(method, self._fill(path), expect=None, **kwargs)
        except httpx.TransportError:
            # The Server closes a kept-alive connection after an internal error; the next request reconnects.
            response = self.env.api.call(method, self._fill(path), expect=None, **kwargs)
        try:
            payload: Any = response.json()
        except ValueError:
            payload = response.text
        entry = {
            "route": route,
            "method": method,
            "path": path,
            "query": query,
            "body": body,
            "status": response.status_code,
            "response": self._template(payload),
            **({"note": note} if note else {}),
        }
        file = FIXTURES / f"{route}.json"
        assert route not in self.seen, f"route {route} recorded twice"
        self.seen.append(route)
        if UPDATE:
            FIXTURES.mkdir(parents=True, exist_ok=True)
            file.write_text(json.dumps(entry, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
        else:
            assert file.exists(), f"{file.name} missing: run with UPDATE_CLIENT_ROUTES=1"
            stored = json.loads(file.read_text(encoding="utf-8"))
            check_answer(route, stored, entry, payload)
        return payload


def _terminal_v1() -> dict[str, Any]:
    return {"terminalId": "x", "sessionId": "x", "label": "x", "root": "x", "cwd": "x", "cols": 1, "rows": 1,
            "purpose": "user", "pid": 1, "status": "running", "exitCode": None, "scrollbackBytes": 0,
            "scrollbackSeq": 0, "ephemeralGroupId": None, "persistent": False, "createdAt": "x"}


# Routes the device answers otherwise on purpose (the same table as ``DEVIATIONS`` in
# connector-ts/test/sync/client-routes.test.ts): the status it answers and, when given, the shape it must have
# instead of the recorded failure.
DEVIATIONS: dict[str, tuple[int, Any]] = {
    "device.runtime.catalog.model": (200, {"catalog": {"runtime": "x", "revision": 1, "models": [{
        "displayName": "x", "id": "x", "selectionId": "x", "description": None, "default": False,
        "reasoningItems": [], "group": None, "metadata": {}}]}, "serverTime": "x"}),
    "device.runtime.catalog.permission": (200, {"catalog": {"runtime": "x", "revision": 1, "permissions": []},
                                                "serverTime": "x"}),
    "device.runtime.commands": (200, {"commands": [], "serverTime": "x"}),
    "device.terminals_v1.create": (200, {"terminal": _terminal_v1(), "serverTime": "x"}),
    "session.terminals_v1.create": (200, {"terminal": _terminal_v1(), "serverTime": "x"}),
}


def check_answer(route: str, stored: dict[str, Any], entry: dict[str, Any], payload: Any) -> None:
    """The live answer against the stored one, by the rules of connector-ts/test/sync/client-routes.test.ts: a
    success has the stored shape; an error has the stored code (or, for a plain-text ``detail``, its message, which
    the device sends as ``{detail: {code, message}}``)."""

    deviation = DEVIATIONS.get(route)
    if deviation is not None:
        status, shape = deviation
        assert entry["status"] == status, (route, entry["status"], payload)
        if shape is not None:
            assert shape_mismatches(shape, entry["response"]) == [], (route, payload)
        return
    assert stored["status"] == entry["status"], (route, stored["status"], entry["status"], payload)
    if stored["status"] < 400:
        assert shape_mismatches(stored["response"], entry["response"]) == [], (route, payload)
        return
    expected = stored["response"].get("detail") if isinstance(stored["response"], dict) else None
    got = entry["response"].get("detail") if isinstance(entry["response"], dict) else None
    if isinstance(expected, str):
        message = got.get("message") if isinstance(got, dict) else got
        assert message == expected, (route, payload)
    else:
        assert isinstance(expected, dict) and isinstance(got, dict), (route, payload)
        assert got.get("code") == expected.get("code"), (route, payload)


def test_shape_rules() -> None:
    assert shape_mismatches({"a": 1, "b": None}, {"a": 2, "b": "x"}) == []
    assert shape_mismatches({"a": 1}, {"a": "1"}) == ["$.a: number != string"]
    assert shape_mismatches({"a": 1}, {"a": 1, "b": 2}) == ["$: extra ['b']"]
    assert shape_mismatches({"selections": {"m": "1"}}, {"selections": {}}) == []
    assert shape_mismatches([{"type": "x", "v": 1}], [{"type": "y", "w": 1}]) == []
    assert shape_mismatches([], [{"z": 1}]) == []


def test_record_client_routes(e2e: E2E) -> None:  # noqa: F811, PLR0915
    api = e2e.api
    _come_online(e2e)
    _enable_instance(e2e)
    rec = Recorder(e2e)
    workspace = e2e.device.workspace
    (workspace / "notes").mkdir(exist_ok=True)
    (workspace / "notes" / "a.txt").write_text("hello\n")
    project = api.post("/projects", {"connectorId": e2e.connector_id, "name": "repo", "workspacePath": str(workspace)})
    e2e.project_id = project["project"]["id"]
    session_id = _new_session(e2e, "hello e2e")
    _wait_text(e2e, session_id, "echo: hello e2e")
    _wait_session(e2e, session_id, "idle")
    _wait(lambda: api.get(f"/sessions/{session_id}/runtime/commands")["commands"], 15, 0.2, "the command catalog")
    rec.name("root", str(workspace))
    rec.name("connectorId", e2e.connector_id)
    rec.name("sessionId", session_id)
    rec.name("runtimeId", e2e.runtime_id)
    s = "/sessions/{sessionId}"
    d = "/connectors/{connectorId}"

    # Reads.
    rec.record("session.snapshot", "GET", f"{s}/snapshot", query={"limit": 50})
    rec.record("session.timeline", "GET", f"{s}/timeline", query={"mode": "latest", "limit": 50})
    rec.record("session.events", "GET", f"{s}/events", query={"after": "seq:0"})
    rec.record("session.runtime.state", "GET", f"{s}/runtime/state")
    rec.record("session.runtime.capabilities", "GET", f"{s}/runtime/capabilities")
    rec.record("session.runtime.notices", "GET", f"{s}/runtime/notices")
    rec.record("session.runtime.queue", "GET", f"{s}/runtime/queue")
    rec.record("session.planning", "GET", f"{s}/planning")
    rec.record("session.goal", "GET", f"{s}/goal")
    rec.record("session.catalog.model", "GET", f"{s}/runtime/catalogs/model")
    rec.record("session.catalog.permission", "GET", f"{s}/runtime/catalogs/permission")
    rec.record("session.commands.list", "GET", f"{s}/runtime/commands", query={"query": "rev", "limit": 5})

    # Commands.
    rec.record("session.selections", "PATCH", f"{s}/runtime/selections", body={"selections": {"model": "m2", "permission": "auto"}})
    rec.record("session.commands.execute", "POST", f"{s}/runtime/commands", body={"command": "review", "args": ["src"]})
    _wait_text(e2e, session_id, "echo: /review src")
    _wait_session(e2e, session_id, "idle")
    rec.record("session.commands.execute.unavailable", "POST", f"{s}/runtime/commands", body={"command": "nope"})
    rec.record("session.messages", "POST", f"{s}/runtime/messages", body={"content": "plain", "clientMessageId": "cm_rec_plain"})
    _wait_text(e2e, session_id, "echo: plain")
    _wait_session(e2e, session_id, "idle")
    rec.record("session.notices.respond.missing", "POST", f"{s}/runtime/notices/ntc_missing/respond", body={"actionId": "allow"})
    rec.record("session.sync", "POST", f"{s}/sync", body={})

    # Plans.
    _send(e2e, session_id, "#plan the fix")
    _wait_text(e2e, session_id, "echo: #plan the fix")
    _wait_session(e2e, session_id, "idle")
    plans = _wait(lambda: api.get(f"/sessions/{session_id}/plans"), 15, 0.2, "a plan document")
    rec.name("planId", plans[0]["planId"])
    rec.record("session.plans", "GET", f"{s}/plans")
    rec.record("session.plan", "GET", f"{s}/plans/{{planId}}/{plans[0]['revision']}")
    rec.record("session.plan.markdown", "GET", f"{s}/plans/{{planId}}/{plans[0]['revision']}/markdown")
    rec.record("session.plan.missing", "GET", f"{s}/plans/plan_missing/1")

    # A running turn: steer and the queue.
    _send(e2e, session_id, "#slow task")
    _wait_text(e2e, session_id, "working slowly")
    _wait_session(e2e, session_id, "running")
    rec.record("session.steer", "POST", f"{s}/runtime/steer", body={"content": "and also this", "clientMessageId": "cm_rec_steer"})
    rec.record("session.messages.queued", "POST", f"{s}/runtime/messages", body={"content": "queued one", "clientMessageId": "cm_rec_q1", "queue": "auto"})
    _send(e2e, session_id, "queued two", queue="auto", clientMessageId="cm_rec_q2")
    queue = api.get(f"/sessions/{session_id}/runtime/queue")
    ids = [item["messageId"] for item in queue["items"]]
    rec.name("q1", ids[0])
    rec.name("q2", ids[1])
    rec.record("session.queue.update", "PATCH", f"{s}/runtime/queue/{{q1}}", body={"content": "queued one, edited"})
    rec.record("session.queue.reorder", "PUT", f"{s}/runtime/queue/order", body={"messageIds": ["{q2}", "{q1}"]})
    rec.record("session.queue.delete", "DELETE", f"{s}/runtime/queue/{{q2}}")
    rec.record("session.queue.retry.missing", "POST", f"{s}/runtime/queue/q_missing/retry", body={})
    rec.record("session.queue.clear", "DELETE", f"{s}/runtime/queue")
    rec.record("session.queue.resume", "POST", f"{s}/runtime/queue/resume", body={})
    rec.record("session.interrupt", "POST", f"{s}/runtime/interrupt", body={})
    _wait_session(e2e, session_id, "idle")
    rec.record("session.steer.idle", "POST", f"{s}/runtime/steer", body={"content": "too late"})

    # Read-only and archived sessions.
    api.delete(f"/sessions/{session_id}/takeover")
    rec.record("session.messages.read_only", "POST", f"{s}/runtime/messages", body={"content": "read-only", "clientMessageId": "cm_rec_ro"})
    rec.record("session.selections.read_only", "PATCH", f"{s}/runtime/selections", body={"selections": {"model": "m1"}})
    api.post(f"/sessions/{session_id}/takeover")
    api.post("/sessions/archive", [session_id])
    rec.record("session.messages.archived", "POST", f"{s}/runtime/messages", body={"content": "archived", "clientMessageId": "cm_rec_arch"})
    api.post("/sessions/unarchive", [session_id])

    # Files.
    rec.record("device.fs.list", "POST", f"{d}/fs/list", body={"root": "{root}", "path": "notes"})
    rec.record("device.fs.list.empty_path", "POST", f"{d}/fs/list", body={"root": "{root}", "path": ""})
    rec.record("device.fs.list.parent", "POST", f"{d}/fs/list", body={"root": "{root}/notes", "path": ".."})
    rec.record("device.fs.readText", "POST", f"{d}/fs/readText", query={"root": "{root}"}, body={"path": "notes/a.txt", "maxBytes": 1024})
    rec.record("device.fs.readText.missing", "POST", f"{d}/fs/readText", query={"root": "{root}"}, body={"path": "notes/none.txt"})
    rec.record("device.fs.write", "POST", f"{d}/fs/write", query={"root": "{root}"}, body={"path": "notes/b.txt", "content": "written\n"})
    rec.record("device.fs.read", "POST", f"{d}/fs/read", query={"root": "{root}"}, body={"path": "notes/a.txt"})
    token = api.post(f"/connectors/{e2e.connector_id}/fs/preview-token", {"path": "notes/a.txt"}, params={"root": str(workspace)})
    access = api.post("/connectors/fs/preview-session", {"previewToken": token["previewToken"]})["previewAccessToken"]
    rec.name("previewAccessToken", access)
    rec.record("device.fs.preview.readText", "POST", "/connectors/fs/preview/readText", body={"previewAccessToken": "{previewAccessToken}", "maxBytes": 1024})
    rec.record("device.fs.preview.read", "POST", "/connectors/fs/preview/read", body={"previewAccessToken": "{previewAccessToken}"})
    rec.record("device.shell.exec", "POST", f"{d}/shell/exec", query={"root": "{root}"}, body={"command": "echo shell-ok", "cwd": "notes", "timeoutMs": 10000})

    # Terminals (v2, then the v1 routes the Web client still calls).
    created = rec.record("device.terminals.create", "POST", f"{d}/terminals-v2", query={"root": "{root}"}, body={"cols": 80, "rows": 24, "label": "rec", "cwd": "notes"})
    rec.name("terminalId", created["result"]["terminalId"])
    t = f"{d}/terminals-v2/{{terminalId}}"
    rec.record("device.terminals.list", "GET", f"{d}/terminals-v2")
    rec.record("device.terminals.rename", "PATCH", t, body={"label": "renamed"})
    rec.record("device.terminals.persistence", "PATCH", f"{t}/persistence", body={"persistent": True})
    rec.record("device.terminals.write", "POST", f"{t}/write", body={"dataBase64": base64.b64encode(b"echo hi\n").decode()})
    rec.record("device.terminals.resize", "POST", f"{t}/resize", body={"cols": 100, "rows": 30})
    rec.record("device.terminals.snapshot", "GET", f"{t}/snapshot", query={"fromSeq": 0})
    rec.record("device.terminals.close", "DELETE", t)
    rec.record("device.terminals.missing", "PATCH", f"{d}/terminals-v2/trm_missing/persistence", body={"persistent": False})
    rec.record("device.terminals_v1.create", "POST", f"{d}/terminals", query={"root": "{root}"}, body={"cols": 80, "rows": 24})
    rec.record("device.terminals_v1.list", "GET", f"{d}/terminals")
    rec.record("session.terminals_v1.create", "POST", f"{s}/terminals", body={"cols": 80, "rows": 24})
    rec.record("session.terminals_v1.list", "GET", f"{s}/terminals")

    # Runtime-level catalogs (before or without a session).
    r = f"{d}/runtimes/{{runtimeId}}"
    rec.record("device.runtime.catalog.model", "GET", f"{r}/catalogs/model")
    rec.record("device.runtime.catalog.permission", "GET", f"{r}/catalogs/permission")
    rec.record("device.runtime.commands", "GET", f"{r}/commands")

