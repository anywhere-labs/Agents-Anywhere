"""The client route table (``core.client_routes``) against the API and the E2EE policy derived from it."""

from __future__ import annotations

import importlib
import re
from typing import get_args

from agent_server.core import client_routes as cr
from agent_server.core import device_meshcall as dl
from agent_server.core.api_namespace import API_V2_PREFIX
from agent_server.core.e2ee_settings import requires_secure_channel

API_MODULES = (
    "connectors", "connector_files", "connector_runtimes", "runtime_workflows", "connector_shell",
    "connector_terminal", "client_ws", "sessions", "session_planning", "session_queue", "session_goals",
    "sessions_fs", "sessions_terminal", "shares",
)


def _api_routes() -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for name in API_MODULES:
        for route in importlib.import_module(f"agent_server.api.{name}").router.routes:
            methods = getattr(route, "methods", None) or {"WS"}
            found.update((method, API_V2_PREFIX + route.path) for method in methods if method != "HEAD")
    return found


def test_the_table_is_consistent() -> None:
    assert cr.check_table() == []


def test_every_route_exists_in_the_api() -> None:
    api = _api_routes()
    missing = [f"{route.id}: {route.method} {route.path}" for route in cr.CLIENT_ROUTES
               if (route.method, route.path) not in api]
    assert missing == []


def test_every_session_and_device_content_route_is_in_the_table() -> None:
    """A route the device answers cannot be added without its table entry (owner, lane, command id)."""

    listed = {(route.method, route.path) for route in cr.CLIENT_ROUTES}
    content = [
        f"{method} {path}" for method, path in sorted(_api_routes())
        if requires_secure_channel(method if method != "WS" else "GET", path.replace("{", "x").replace("}", ""))
        and (method, path) not in listed
    ]
    # Server-owned routes under the session family: takeover, and the Server's signed copy of a local file.
    assert content == [
        "DELETE /api/v2/sessions/{session_id}/takeover",
        "GET /api/v2/sessions/local/{session_id}/{file_id}",
        "POST /api/v2/sessions/{session_id}/takeover",
    ]


# The hand-written list the table replaced; the derived policy must refuse exactly the same requests.
_SID = r"[^/]+"
_PREVIOUS_POLICY = tuple(
    (method, re.compile(pattern))
    for method, pattern in (
        ("POST", r"/api/v2/sessions"),
        ("POST", r"/api/v2/sessions/create-and-start"),
        ("*", rf"/api/v2/sessions/{_SID}/(?!(meta|runtime/state|runtime/capabilities)$).+"),
        ("*", rf"/api/v2/connectors/{_SID}/(fs|shell|terminals|terminals-v2)(/.*)?"),
        ("*", r"/api/v2/connectors/fs/.+"),
        ("*", r"/api/v2/runtime-workflows(/.*)?"),
    )
)
_PREVIOUS_UPLOAD = re.compile(rf"/api/v2/sessions/{_SID}/attachments")


def _previous(method: str, path: str, sealed_upload: bool) -> bool:
    if sealed_upload and method == "POST" and _PREVIOUS_UPLOAD.fullmatch(path):
        return False
    return any((expected in ("*", method)) and pattern.fullmatch(path) for expected, pattern in _PREVIOUS_POLICY)


def test_the_derived_policy_refuses_what_the_previous_list_refused() -> None:
    paths = {re.sub(r"\{[a-z_]+\}", "x1", path) for _method, path in _api_routes()}
    paths |= {route.path.replace("{session_id}", "s1").replace("{connector_id}", "c1") for route in cr.CLIENT_ROUTES}
    paths |= {
        "/api/v2/sessions", "/api/v2/sessions/s1", "/api/v2/sessions/s1/", "/api/v2/sessions/s1/meta/x",
        "/api/v2/sessions/s1/runtime", "/api/v2/sessions/s1/runtime/state/x", "/api/v2/connectors/c1/fs",
        "/api/v2/connectors/c1/fs/", "/api/v2/connectors/c1/fsx", "/api/v2/connectors/fs",
        "/api/v2/connectors/fs/", "/api/v2/runtime-workflows", "/api/v2/runtime-workflowsx",
        "/api/v2/connectors/c1/runtimes/r1/catalogs/model", "/api/v2/sessions/s1/attachments",
        "/api/v2/sessions/create-and-start",
    }
    for path in paths:
        for method in ("GET", "POST", "PUT", "PATCH", "DELETE"):
            for sealed in (False, True):
                assert requires_secure_channel(method, path, sealed_upload=sealed) == _previous(method, path, sealed), (
                    method, path, sealed
                )


def test_client_call_routes_are_the_route_enum() -> None:
    assert get_args(dl.ClientRouteId) == cr.CLIENT_CALL_ROUTE_IDS
    calls = {route.id for route in cr.CLIENT_ROUTES if route.via == "call"}
    assert calls == set(cr.CLIENT_CALL_ROUTE_IDS)
    # Every content command a client retries carries a receipt identity.
    for route_id in ("session.runtime.messages", "session.runtime.notices.respond", "session.planning.execute",
                     "session.runtime.interrupt", "session.runtime.queue.sendNow", "session.createAndStart"):
        assert cr.ROUTES_BY_ID[route_id].command_id is not None


def test_held_shell_routes_outlast_their_longest_timeout() -> None:
    """``shell/exec`` and a shell task's ``wait`` hold the call for up to the request's ``timeoutMs``."""

    for route_id in ("connector.shell.exec", "connector.shell.tasks.wait"):
        route = cr.ROUTES_BY_ID[route_id]
        assert route.via == "call" and route.timeout == "long"
    assert cr.LONG_TIMEOUT_SECONDS > cr.MAX_HOLD_MS / 1000
    assert cr.ROUTES_BY_ID["connector.shell.tasks.wait"].kind == "stream"
    for route_id in ("connector.shell.tasks.start", "connector.shell.tasks.cancel"):
        assert cr.ROUTES_BY_ID[route_id].via == "call"


def test_matching_a_request() -> None:
    route = cr.match_route("post", "/api/v2/sessions/s1/runtime/notices/n1/respond")
    assert route is not None and route.id == "session.runtime.notices.respond"
    assert route.kind == "critical" and route.command_id == "responseId" and route.writes_command_id
    assert cr.match_route("GET", "/api/v2/sessions/s1/snapshot").offline is True  # type: ignore[union-attr]
    assert cr.match_route("GET", "/api/v2/sessions/s1/nothing") is None


def test_client_errors_cover_every_case_once() -> None:
    cases = [rule.case for rule in cr.CLIENT_ERROR_RULES]
    assert sorted(cases) == sorted(get_args(cr.ClientFailureCase))
    by_case = {rule.case: rule for rule in cr.CLIENT_ERROR_RULES}
    assert by_case["not_delivered"].command.receipt == "delete"
    assert by_case["outcome_unknown"].command.code == "command_outcome_unknown"
    assert by_case["device_busy"].read.status == 503 and by_case["device_busy"].read.retryable
    assert cr.device_code_status("queue_item_not_found") == 404
    assert cr.device_code_status("anything_else") == cr.DEVICE_CODE_DEFAULT_STATUS


def test_encrypted_mode_registers_no_client_service() -> None:
    assert "aa.device.v1.Client" in dl.registered_services("off")
    assert "aa.device.v1.Client" not in dl.registered_services("required")


def test_agent_session_routes_reach_the_device() -> None:
    """The Agent session behind a session: reads by ``Client/call``, changes as commands under a receipt."""

    reads = ("workflow.session.tree", "workflow.session.configuration.get")
    for route_id in reads:
        route = cr.ROUTES_BY_ID[route_id]
        assert (route.via, route.kind, route.command_id) == ("call", "read", None)
    receipts = {
        "workflow.session.configuration.update": "operationId",
        "workflow.session.operations": "operationId",
        "workflow.session.recover": "operationId",
        "workflow.session.position": cr.GENERATED_COMMAND_ID,
        "workflow.session.close": cr.GENERATED_COMMAND_ID,
    }
    for route_id, command_id in receipts.items():
        route = cr.ROUTES_BY_ID[route_id]
        assert (route.via, route.kind, route.command_id) == ("call", "command", command_id)
    assert cr.ROUTES_BY_ID["workflow.session.recover"].timeout == "create"
    assert not [route.id for route in cr.CLIENT_ROUTES if route.via == "unsupported" and route.id.startswith("workflow.")]
