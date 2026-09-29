"""Tests for the OpenCode service-HTTP runtime.

A `httpx.MockTransport` stands in for the host service, so these exercise the
real client + real decoding against recorded 2.0.18 response shapes rather than
against a stubbed client. The approval tests are the security-critical ones:
`always` never leaves this process, and an action outside the read-only
allowlist must not be answerable remotely at all.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from connector.runtimes.opencode.serve.client import OpenCodeServerClient
from connector.runtimes.opencode.serve.runtime import (
    OpenCodeServiceRuntime,
    remote_actions,
    requires_local_confirmation,
)
from connector.runtimes.opencode.serve.service import OpenCodeService
from connector.runtime_protocol import RuntimeConfig, RuntimeInvalidRequestError, RuntimeUnsupportedError
from connector.runtimes.opencode.serve import mappers

SERVICE = OpenCodeService(
    url="http://127.0.0.1:49374", pid=18772, version="2.0.18", password="pw", path=__import__("pathlib").Path("s.json")
)
# Opaque paths: the runtime only forwards/echoes them, so nothing here may
# depend on a directory that exists on the machine running the tests.
DIRECTORY = "/work/repo"
EXTERNAL = "ses_f22107110ffdwOAm3Bcv9JiTBV"
# Agents Anywhere addresses a session by the id derived from the inventory, exactly
# as the production caller does after list_sessions().
MAIN_PLATFORM = mappers.platform_session_id("ns_test", EXTERNAL)


def envelope(rows: Any, cursor: Any = None) -> httpx.Response:
    return httpx.Response(200, json={"data": rows, "cursor": cursor or {"previous": None, "next": None}})


SESSION_ROWS = [
    {"id": EXTERNAL, "title": "主会话", "location": {"directory": DIRECTORY}, "time": {"updated": 10}},
    {
        "id": "ses_child",
        "parentID": EXTERNAL,
        "title": "子会话",
        "agent": "general",
        "location": {"directory": DIRECTORY},
        "time": {"updated": 20},
    },
]

MESSAGES = [
    {"id": "msg_u", "type": "user", "text": "做点什么"},
    {
        "id": "msg_a",
        "type": "assistant",
        "content": [{"type": "text", "text": "好的"}, {"type": "tool", "id": "t1", "name": "read", "state": {"status": "completed"}}],
    },
    {"id": "msg_i", "type": "idle", "outcome": "ok"},
]


class Recorder:
    def __init__(self) -> None:
        self.health: list[tuple[str, Any]] = []
        self.requests: list[tuple[str, str, Any]] = []
        self.query: list[tuple[str, str, tuple[tuple[str, str], ...]]] = []
        self.published: list[tuple[str, dict[str, Any]]] = []

    async def runtime_health_update(self, status: str, detail: Any = None) -> None:
        self.health.append((status, detail))

    async def runtime_capabilities_update(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def session_state_update(self, **kwargs: Any) -> None:
        self.published.append(("state", kwargs))

    async def session_turn_ended(self, **kwargs: Any) -> None:
        self.published.append(("turnEnded", kwargs))

    async def timeline_sync(self, **kwargs: Any) -> None:
        self.published.append(("timeline", kwargs))

    async def notice_upsert(self, notice: Any) -> None:
        self.published.append(("notice", {"notice_id": notice.notice_id, "actions": [a["actionId"] for a in notice.actions]}))

    async def session_meta_upsert(self, **kwargs: Any) -> None:
        self.published.append(("meta", kwargs))

    async def model_catalog_update(self, catalog: Any) -> None:
        self.published.append(("modelCatalog", {"count": len(catalog.models)}))

    async def agent_catalog_update(self, catalog: Any) -> None:
        self.published.append(("agentCatalog", {"count": len(catalog.agents)}))


HOST_METHODS = (
    "runtime_health_update", "runtime_capabilities_update", "session_state_update", "session_turn_ended",
    "timeline_sync", "notice_upsert", "session_meta_upsert", "model_catalog_update", "agent_catalog_update",
)


def build(
    routes: dict[tuple[str, str], Any],
    values: dict[str, Any] | None = None,
    service_reader: Any = None,
) -> tuple[OpenCodeServiceRuntime, Recorder]:
    host = Recorder()

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode()) if request.content else None
        key = (request.method, request.url.path)
        host.requests.append((request.method, request.url.path, body))
        host.query.append((request.method, request.url.path, tuple(sorted(request.url.params.items()))))
        outcome = routes.get(key, httpx.Response(404, json={"_tag": "NotFound"}))
        return outcome if isinstance(outcome, httpx.Response) else envelope(outcome)

    runtime = OpenCodeServiceRuntime(
        RuntimeConfig(RUNTIME_NAME, 1, values={"location": DIRECTORY, **(values or {})}),
        SimpleNamespace(connector_id="conn_test", session_namespace="ns_test", **{k: getattr(host, k) for k in HOST_METHODS}),
        service_reader=service_reader or (lambda: SERVICE),
        client_factory=lambda service: OpenCodeServerClient(service, transport=httpx.MockTransport(handler)),
    )
    return runtime, host


RUNTIME_NAME = "opencode"

BASE_ROUTES: dict[tuple[str, str], Any] = {
    ("GET", "/api/info"): httpx.Response(200, json={"version": "2.0.18", "pid": 18772, "urls": [], "paths": {"tmp": "T"}}),
    ("GET", "/api/debug/location"): [{"directory": DIRECTORY}],
    ("GET", "/api/session"): SESSION_ROWS,
    ("GET", "/api/session/active"): [],
    ("GET", f"/api/session/{EXTERNAL}/message"): MESSAGES,
    ("GET", f"/api/session/{EXTERNAL}"): httpx.Response(200, json={"data": {"id": EXTERNAL}}),
    ("GET", "/api/session/ses_child/message"): MESSAGES,
    # The pump starts with the runtime; give it a stream that simply ends so a
    # test that never calls stop() does not sit reconnecting.
    ("GET", "/api/event"): httpx.Response(
        200, headers={"content-type": "text/event-stream"}, text=": heartbeat\n\n"
    ),
}


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


# ------------------------------------------------------------------- lifecycle


def test_start_reports_running_once_attached() -> None:
    runtime, host = build(dict(BASE_ROUTES))

    async def scenario() -> None:
        await runtime.start()

    run(scenario())
    assert host.health[0][0] == "starting"
    assert host.health[-1] == ("running", None)
    assert runtime.identity.runtime_version == "2.0.18"


def test_missing_registration_is_actionable_not_a_crash() -> None:
    host = Recorder()
    runtime = OpenCodeServiceRuntime(
        RuntimeConfig(RUNTIME_NAME, 1, values={"location": DIRECTORY, "maxRestartAttempts": 0}),
        SimpleNamespace(connector_id="c", session_namespace="ns", **{k: getattr(host, k) for k in ("runtime_health_update", "runtime_capabilities_update")}),
        service_reader=lambda: None,
    )

    async def scenario() -> None:
        await runtime.start()

    run(scenario())
    _status, detail = host.health[-1]
    assert detail["code"] == "runtime_unavailable"
    assert "opencode serve" in detail["message"], "the message must name what the user can actually run"


def test_a_location_that_cannot_be_opened_is_named_not_shown_as_empty() -> None:
    # `/api/session?directory=` answers `[]` for anything the host has not
    # loaded, so "no sessions" and "wrong path typed" are the same symptom at
    # that layer. Only a location that cannot be a project at all is refused.
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/debug/location")] = [{"directory": "/other/place"}]
    runtime, host = build(routes, values={"location": "/work/repo/definitely-not-here", "maxRestartAttempts": 0})

    async def scenario() -> None:
        await runtime.start()

    run(scenario())
    _status, detail = host.health[-1]
    assert detail["code"] == "location_not_loaded"
    assert "/work/repo/definitely-not-here" in detail["message"]
    assert "/other/place" not in detail["message"], "the ask is the user's own path, not a dump of the host's"


def test_an_unloaded_but_real_location_runs_and_reports_partial_discovery(tmp_path) -> None:
    # The host loads a location when the first session is created there, so a
    # project OpenCode has not opened yet must attach and say what it can see
    # rather than refuse to start.
    location = str(tmp_path / "new-project")
    Path(location).mkdir()
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/debug/location")] = [{"directory": str(tmp_path / "already-open")}
                                              ]
    routes[("POST", "/api/session")] = httpx.Response(
        200, json={"data": {"id": "ses_new", "location": {"directory": location}}}
    )
    routes[("POST", "/api/session/ses_new/prompt")] = httpx.Response(200, json={})
    runtime, _ = build(routes, values={"location": location})

    async def discovery_row() -> tuple[Any, Any]:
        caps = await runtime.get_runtime_capabilities()
        row = next(item for item in caps.capabilities if item.capability_id == "session.discovery")
        return (row.available, dict(row.metadata), runtime.supports_complete_session_inventory())

    async def scenario() -> Any:
        await runtime.start()
        before = await discovery_row()
        created = await runtime.create_and_start_session("any", "开工")
        return before, created, await discovery_row()

    before, created, after = run(scenario())
    assert before == (False, {"discoveryState": "partial"}, False)
    assert created.ok is True
    assert after == (True, {"discoveryState": "complete"}, True), "the create response taught us the host's spelling"


def test_a_location_the_host_opens_later_is_picked_up_without_a_restart(tmp_path) -> None:
    # The host closes and reopens locations as it works. Resolving once at attach
    # pinned such an instance to `partial` discovery and an empty inventory
    # forever, which is what a live Hub showed while the same service answered
    # 83 sessions for the very same path.
    location = str(tmp_path / "project")
    Path(location).mkdir()
    loaded: list[dict[str, Any]] = [{"directory": str(tmp_path / "other")}]
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/debug/location")] = loaded
    routes[("GET", "/api/session")] = [
        {"id": EXTERNAL, "location": {"directory": location}, "time": {"updated": 10}},
        {"id": "ses_foreign", "location": {"directory": str(tmp_path / "other")}, "time": {"updated": 20}},
    ]
    runtime, _ = build(routes, values={"location": location})

    async def scenario() -> Any:
        await runtime.start()
        before = await runtime.get_runtime_capabilities()
        while_unresolved = await runtime.list_complete_session_inventory()
        loaded.clear()
        loaded.append({"directory": location})
        after = await runtime.get_runtime_capabilities()
        return before, while_unresolved, after

    before, while_unresolved, after = run(scenario())
    row_before = next(item for item in before.capabilities if item.capability_id == "session.discovery")
    row_after = next(item for item in after.capabilities if item.capability_id == "session.discovery")
    assert (row_before.available, row_before.metadata["discoveryState"]) == (False, "partial")
    # Unresolved is reported as partial, and the row-level location check is what
    # still keeps another project's sessions out.
    assert [row.external_session_id for row in while_unresolved] == [EXTERNAL]
    assert (row_after.available, row_after.metadata["discoveryState"]) == (True, "complete")


def test_an_empty_success_body_is_not_read_as_an_outage() -> None:
    # `/model`, `/agent`, `/command` and `DELETE /api/session/{id}` all answer
    # with no body; parsing that as JSON used to raise "service unreachable".
    routes = dict(BASE_ROUTES)
    routes[("POST", f"/api/session/{EXTERNAL}/model")] = httpx.Response(204)
    runtime, _ = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.update_session_selections(MAIN_PLATFORM, EXTERNAL, {"model": "lxns-uni/glm-5.3"})

    assert run(scenario()).result["applied"] == ["model"]


HOST_SPELLINGS = [
    # Any spelling that resolves to the same place is a match: the runtime must
    # query with the string the host reports, not the one from the config.
    ("/work/repo", "/work/./repo"),
    pytest.param(
        "d:/work/repo",
        "D:\\Work\\Repo",
        id="windows-case-spelling",
        marks=pytest.mark.skipif(os.name != "nt", reason="case-insensitive paths only exist on Windows"),
    ),
]


@pytest.mark.parametrize("configured,reported", HOST_SPELLINGS)
def test_scoped_queries_use_the_hosts_own_spelling_of_the_location(configured: str, reported: str) -> None:
    # The host compares `?directory=` with its own spelling, so what goes out must
    # be the string it reports, not what was typed into the config.
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/debug/location")] = [{"directory": reported}]
    routes[("GET", "/api/session")] = [
        {"id": EXTERNAL, "location": {"directory": reported}, "time": {"updated": 10}}
    ]
    runtime, host = build(routes, values={"location": configured})

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.list_complete_session_inventory()

    assert [row.external_session_id for row in run(scenario())] == [EXTERNAL]
    scoped = [call for call in host.query if call[1] in ("/api/session", "/api/model", "/api/agent", "/api/command")]
    assert scoped, "the runtime must scope its location-bound queries"
    for _method, _path, params in scoped:
        assert ("directory", reported) in params, params


# ------------------------------------------------------------------- inventory


def test_inventory_rows_from_another_location_are_not_attributed_here() -> None:
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/session")] = SESSION_ROWS + [
        {"id": "ses_foreign", "location": {"directory": "/somewhere/else"}, "time": {"updated": 30}}
    ]
    runtime, _ = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.list_complete_session_inventory()

    assert [row.external_session_id for row in run(scenario())] == [EXTERNAL]


def test_the_inventory_leaves_the_hosts_subagent_children_out() -> None:
    # A Team turn writes one child session per worker into the same location. They
    # are the host's internals: surfacing them as Agents Anywhere sessions is what
    # the user sees as "the subagent became a new chat".
    runtime, host = build(dict(BASE_ROUTES))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.list_complete_session_inventory()

    rows = run(scenario())
    assert [row.external_session_id for row in rows] == [EXTERNAL]
    assert ("GET", "/api/session", (("directory", DIRECTORY), ("limit", "100"), ("parentID", "null"))) in host.query
    assert rows[0].session_id.startswith("sess_opencode_")
    assert runtime.supports_complete_session_inventory() is True


def test_list_sessions_pages_by_offset_over_the_inventory() -> None:
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/session")] = [
        {"id": EXTERNAL, "title": "主会话", "location": {"directory": DIRECTORY}, "time": {"updated": 10}},
        {"id": "ses_second", "title": "另一个会话", "location": {"directory": DIRECTORY}, "time": {"updated": 20}},
    ]
    runtime, _ = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        first = await runtime.list_sessions(limit=1)
        second = await runtime.list_sessions(limit=1, cursor=str(len(first)))
        return first, second

    first, second = run(scenario())
    assert [row.external_session_id for row in first] == [EXTERNAL]
    assert [row.external_session_id for row in second] == ["ses_second"]


def test_a_bad_cursor_is_rejected_not_guessed() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> None:
        await runtime.start()
        await runtime.list_sessions(cursor="not-a-number")

    with pytest.raises(RuntimeInvalidRequestError):
        run(scenario())


def test_discovery_state_is_partial_without_a_location() -> None:
    routes = dict(BASE_ROUTES)
    runtime, _ = build(routes, values={"location": None})
    runtime.config = RuntimeConfig(RUNTIME_NAME, 1, values={})

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_runtime_capabilities()

    caps = run(scenario())
    discovery = next(row for row in caps.capabilities if row.capability_id == "session.discovery")
    assert discovery.available is False
    assert runtime.supports_complete_session_inventory() is False


# ------------------------------------------------------------------- timeline


def test_snapshot_projects_stored_messages_and_is_complete() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_session_snapshot("unused", external_session_id=EXTERNAL)

    snapshot = run(scenario())
    assert snapshot.external_session_id == EXTERNAL
    assert snapshot.complete is True
    assert [item.type for item in snapshot.items] == ["turn.start", "message", "message", "tool", "turn.end"]


def test_snapshot_with_a_limit_is_not_marked_complete() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_session_snapshot("unused", external_session_id=EXTERNAL, limit=2)

    assert run(scenario()).complete is False


def test_session_id_is_resolved_through_the_inventory() -> None:
    runtime, host = build(dict(BASE_ROUTES))

    async def scenario() -> Any:
        await runtime.start()
        rows = await runtime.list_complete_session_inventory()
        return await runtime.get_session_snapshot(rows[0].session_id)

    snapshot = run(scenario())
    assert snapshot.external_session_id == EXTERNAL
    assert ("GET", f"/api/session/{EXTERNAL}/message", None) in host.requests


def test_a_subagent_child_is_still_readable_by_its_own_id() -> None:
    # Excluding children from the inventory must not make them unreadable: the
    # parent's timeline names each child with a `<subagent sessionID=…>` marker, and
    # the caller can ask for that session by its external id.
    runtime, host = build(dict(BASE_ROUTES))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_session_snapshot("unused", external_session_id="ses_child")

    assert run(scenario()).external_session_id == "ses_child"
    assert ("GET", "/api/session/ses_child/message", None) in host.requests


# ------------------------------------------------------------------- state


def test_state_follows_the_active_endpoint() -> None:
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/session/active")] = [{"id": EXTERNAL}]
    routes[("GET", f"/api/session/{EXTERNAL}")] = httpx.Response(
        200, json={"data": {"id": EXTERNAL, "agent": "team", "model": {"id": "glm", "providerID": "lxns"}}}
    )
    runtime, _ = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_session_state("any", external_session_id=EXTERNAL)

    state = run(scenario())
    assert state.status == "running"
    assert state.selections == {"agent": "team", "model": "lxns/glm"}


# ------------------------------------------------------------------ approvals


def test_read_only_actions_are_the_only_remote_answerable_ones() -> None:
    assert requires_local_confirmation("read") is False
    for action in ("write", "bash", "edit_file", "", None, "APPLY_PATCH"):
        assert requires_local_confirmation(action) is True, action
    assert [item["actionId"] for item in remote_actions("grep")] == ["allow_once", "deny"]
    assert remote_actions("write") == []


def _permission_routes(rows: list[dict[str, Any]]) -> dict[tuple[str, str], Any]:
    routes = dict(BASE_ROUTES)
    routes[("GET", f"/api/session/{EXTERNAL}/permission")] = rows
    return routes


def test_permission_notice_exposes_actions_and_context() -> None:
    runtime, _ = build(_permission_routes([{"id": "per_1", "action": "read", "resources": ["/work/repo/src/a.ts"]}]))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_session_notices("any", external_session_id=EXTERNAL)

    notices = run(scenario())
    assert len(notices) == 1
    assert notices[0].notice_id == "per_1"
    assert [item["actionId"] for item in notices[0].actions] == ["allow_once", "deny"]
    assert notices[0].context["resources"] == ["/work/repo/src/a.ts"]


def test_high_risk_notice_cannot_be_answered_remotely() -> None:
    runtime, host = build(_permission_routes([{"id": "per_2", "action": "write", "resources": ["/work/repo/x"]}]))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.respond_interaction(MAIN_PLATFORM, "per_2", "allow_once")

    result = run(scenario())
    assert result.ok is False
    assert not [call for call in host.requests if call[0] == "POST"], "no reply may reach the host"


def test_always_is_refused_locally_even_for_a_read_action() -> None:
    runtime, host = build(_permission_routes([{"id": "per_3", "action": "read", "resources": []}]))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.respond_interaction("any", "per_3", "always")

    result = run(scenario())
    assert result.ok is False
    assert not [call for call in host.requests if call[0] == "POST"]


def test_allow_once_posts_the_once_decision_to_the_host() -> None:
    routes = _permission_routes([{"id": "per_4", "action": "read", "resources": []}])
    routes[("POST", f"/api/session/{EXTERNAL}/permission/per_4/reply")] = httpx.Response(200, json={})
    runtime, host = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.respond_interaction(MAIN_PLATFORM, "per_4", "allow_once")

    result = run(scenario())
    assert result.ok is True
    posted = [call for call in host.requests if call[0] == "POST" and call[1].endswith("/reply")]
    assert posted == [("POST", f"/api/session/{EXTERNAL}/permission/per_4/reply", {"decision": "once"})]


def test_answering_a_request_that_is_no_longer_pending_is_refused() -> None:
    runtime, _ = build(_permission_routes([]))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.respond_interaction(MAIN_PLATFORM, "per_gone", "deny")

    assert run(scenario()).ok is False


# --------------------------------------------------------------------- writes


def test_start_turn_posts_the_prompt_text() -> None:
    routes = dict(BASE_ROUTES)
    routes[("POST", f"/api/session/{EXTERNAL}/prompt")] = httpx.Response(200, json={"data": {"id": "msg_new"}})
    runtime, host = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.start_turn("any", EXTERNAL, "继续", client_message_id="msg_client")

    result = run(scenario())
    assert result.ok is True
    assert ("POST", f"/api/session/{EXTERNAL}/prompt", {"text": "继续", "id": "msg_client"}) in host.requests


def test_a_client_message_id_outside_the_host_namespace_is_namespaced_not_dropped() -> None:
    # The host answers 400 `Expected a string starting with "msg_"` for any other
    # id shape, and Android mints `opt_<uuid>`. Dropping the id would silence the
    # 400 but lose the retry-once guarantee, so it is namespaced.
    routes = dict(BASE_ROUTES)
    routes[("POST", f"/api/session/{EXTERNAL}/prompt")] = httpx.Response(200, json={"data": {}})
    runtime, host = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.start_turn("any", EXTERNAL, "继续", client_message_id="opt_3f0d6a2e-7bb1-4d3f")

    assert run(scenario()).ok is True
    assert ("POST", f"/api/session/{EXTERNAL}/prompt", {"text": "继续", "id": "msg_opt_3f0d6a2e-7bb1-4d3f"}) in host.requests


def test_steer_is_unsupported_on_this_transport() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> None:
        await runtime.start()
        await runtime.steer_turn("any", EXTERNAL, "改一下")

    with pytest.raises(RuntimeUnsupportedError):
        run(scenario())


def test_create_session_asks_for_its_own_location_and_applies_selections_then_prompts() -> None:
    routes = dict(BASE_ROUTES)
    routes[("POST", "/api/session")] = httpx.Response(200, json={"data": {"id": "ses_new"}})
    routes[("POST", "/api/session/ses_new/model")] = httpx.Response(200, json={})
    routes[("POST", "/api/session/ses_new/prompt")] = httpx.Response(200, json={"data": {}})
    runtime, host = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.create_and_start_session("any", "开工", selections={"model": "lxns-uni/glm-5.3", "agent": "team"})

    result = run(scenario())
    assert result.result["externalSessionId"] == "ses_new"
    assert result.result["sessionId"].startswith("sess_opencode_")
    created = next(call for call in host.requests if call[1] == "/api/session")
    assert created[2] == {
        "title": "开工",
        "location": {"directory": DIRECTORY},
        "model": {"id": "glm-5.3", "providerID": "lxns-uni"},
        "agent": "team",
    }, "a session created without a location lands outside the inventory we read"
    assert not [call for call in host.requests if call[1].endswith("/model")], "the create body already carries them"
    assert any(call[1].endswith("/prompt") for call in host.requests)


def test_a_bare_model_selection_is_rejected_not_guessed() -> None:
    routes = dict(BASE_ROUTES)
    routes[("POST", "/api/session")] = httpx.Response(200, json={"data": {"id": "ses_new2"}})
    runtime, _ = build(routes)

    async def scenario() -> None:
        await runtime.start()
        await runtime.create_and_start_session("any", "开工", selections={"model": "glm-5.3"})

    with pytest.raises(RuntimeInvalidRequestError):
        run(scenario())


def test_interrupt_posts_to_the_host() -> None:
    routes = dict(BASE_ROUTES)
    routes[("POST", f"/api/session/{EXTERNAL}/interrupt")] = httpx.Response(200, json={"data": {"interrupted": True}})
    runtime, host = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        rows = await runtime.list_complete_session_inventory()
        return await runtime.interrupt_session(rows[0].session_id)

    result = run(scenario())
    assert result.ok is True
    assert ("POST", f"/api/session/{EXTERNAL}/interrupt", None) in host.requests, "the endpoint declares no body"


def test_an_interrupt_the_host_did_not_act_on_is_reported_as_a_no_op() -> None:
    routes = dict(BASE_ROUTES)
    routes[("POST", f"/api/session/{EXTERNAL}/interrupt")] = httpx.Response(200, json={"data": {"interrupted": False}})
    runtime, _ = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        rows = await runtime.list_complete_session_inventory()
        return await runtime.interrupt_session(rows[0].session_id)

    # Nothing-running is benign, so it follows the shape Claude's interrupt
    # already reports instead of surfacing a failure.
    assert run(scenario()).result["alreadyStopped"] is True


def test_execute_command_sends_the_hosts_own_field_names() -> None:
    routes = dict(BASE_ROUTES)
    routes[("POST", f"/api/session/{EXTERNAL}/command")] = httpx.Response(200, json={})
    runtime, host = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.execute_command(MAIN_PLATFORM, "review", raw="the diff", external_session_id=EXTERNAL)

    result = run(scenario())
    assert result.ok is True
    assert ("POST", f"/api/session/{EXTERNAL}/command", {"name": "review", "text": "the diff"}) in host.requests


# ------------------------------------------------------------------- catalogs


def test_model_catalog_is_keyed_by_provider_and_model() -> None:
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/model")] = [
        {"id": "longcat", "providerID": "a", "name": "LongCat A"},
        {"id": "longcat", "providerID": "b", "name": "LongCat B"},
    ]
    runtime, _ = build(routes)

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.list_model_catalog()

    catalog = run(scenario())
    assert [item.id for item in catalog.models] == ["a/longcat", "b/longcat"]


def test_permission_catalog_is_declared_unsupported() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> None:
        await runtime.start()
        await runtime.list_permission_catalog()

    with pytest.raises(RuntimeUnsupportedError):
        run(scenario())


def test_capabilities_report_the_attached_service_version() -> None:
    runtime, _ = build(dict(BASE_ROUTES))

    async def scenario() -> Any:
        await runtime.start()
        return await runtime.get_runtime_capabilities()

    caps = run(scenario())
    assert caps.metadata["transport"] == "service-http"
    assert caps.metadata["serviceVersion"] == "2.0.18"
    steer = next(row for row in caps.capabilities if row.capability_id == "session.steer")
    assert steer.supported is False


# ------------------------------------------------------------------ event pump


def frame(event_type: str, *, directory: str = DIRECTORY, seq: int | None = None, data: dict | None = None) -> dict:
    payload: dict[str, Any] = {"id": f"evt_{event_type}", "type": event_type, "data": data or {"sessionID": EXTERNAL}}
    if directory is not None:
        payload["location"] = {"directory": directory}
    if seq is not None:
        payload["durable"] = {"aggregateID": EXTERNAL, "seq": seq, "version": 1}
    return payload


async def feed(runtime: OpenCodeServiceRuntime, *frames: dict) -> None:
    for item in frames:
        await runtime._handle_frame(item)


def published(host: Recorder, kind: str) -> list[dict[str, Any]]:
    return [payload for name, payload in host.published if name == kind]


def test_a_finished_turn_publishes_state_a_turn_end_and_the_timeline() -> None:
    runtime, host = build(dict(BASE_ROUTES))

    async def scenario() -> None:
        await runtime.start()
        await feed(runtime, frame("session.execution.succeeded", data={"sessionID": EXTERNAL, "outcome": "succeeded"}))
        await runtime.stop()

    run(scenario())
    assert published(host, "state")[-1]["status"] == "idle"
    assert published(host, "turnEnded")[-1]["outcome"] == "completed"
    assert published(host, "timeline"), "the session must be re-read when its turn ends"


def test_a_frame_from_another_location_publishes_nothing() -> None:
    runtime, host = build(dict(BASE_ROUTES))

    async def scenario() -> None:
        await runtime.start()
        await feed(runtime, frame("session.execution.succeeded", directory="/other/place"))
        await runtime.stop()

    run(scenario())
    assert host.published == []
    assert runtime._event_actions["skipped:session.execution.succeeded"] == 1


def test_streaming_frames_are_coalesced_into_one_re_read(monkeypatch) -> None:
    from connector.runtimes.opencode.serve import runtime as runtime_module

    monkeypatch.setattr(runtime_module, "EVENT_REFRESH_SECONDS", 0.05)
    runtime, host = build(dict(BASE_ROUTES))

    async def scenario() -> None:
        await runtime.start()
        await feed(runtime, *(frame("message.part.delta") for _ in range(6)))
        await asyncio.sleep(0.3)
        await runtime.stop()

    run(scenario())
    assert len(published(host, "timeline")) == 1, "one turn emits dozens of deltas"


def test_a_sequence_gap_forces_a_re_read_even_for_an_unrouted_event(monkeypatch) -> None:
    from connector.runtimes.opencode.serve import runtime as runtime_module

    monkeypatch.setattr(runtime_module, "EVENT_REFRESH_SECONDS", 0.05)
    runtime, host = build(dict(BASE_ROUTES))

    async def scenario() -> None:
        await runtime.start()
        # An event type this build does not route would be dropped; a gap in the
        # per-session sequence says we missed frames and cannot ask for them, so
        # the session is re-read instead.
        await feed(runtime, frame("session.something.invented", seq=3))
        assert published(host, "timeline") == []
        await feed(runtime, frame("session.something.invented", seq=9))
        await asyncio.sleep(0.3)
        await runtime.stop()

    run(scenario())
    assert len(published(host, "timeline")) == 1, "the stream cannot resume, so a gap must re-read"


def test_an_asked_permission_becomes_a_notice_the_user_can_answer() -> None:
    routes = _permission_routes([{"id": "per_9", "action": "read", "resources": ["/work/repo/src/a.ts"]}])
    runtime, host = build(routes)

    async def scenario() -> None:
        await runtime.start()
        await feed(runtime, frame("permission.asked"))
        await runtime.stop()

    run(scenario())
    assert published(host, "state")[-1]["status"] == "waiting_approval"
    notices = published(host, "notice")
    assert notices and notices[0]["notice_id"] == "per_9"
    assert notices[0]["actions"] == ["allow_once", "deny"]


def test_a_catalog_event_republishes_both_catalogs() -> None:
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/model")] = [{"id": "m", "providerID": "p", "name": "M"}]
    routes[("GET", "/api/agent")] = [{"id": "build", "name": "build", "mode": "primary"}]
    runtime, host = build(routes)

    async def scenario() -> None:
        await runtime.start()
        await feed(runtime, frame("model.updated", directory=None))
        await runtime.stop()

    run(scenario())
    assert published(host, "modelCatalog") == [{"count": 1}]
    assert published(host, "agentCatalog") == [{"count": 1}]


def test_a_catalog_event_from_another_location_still_republishes_catalogs() -> None:
    # `?directory=` does not scope /api/model or /api/agent, so the catalogs
    # describe the whole service: a provider change opened in another project
    # still changes what this instance can offer.
    routes = dict(BASE_ROUTES)
    routes[("GET", "/api/model")] = [{"id": "m", "providerID": "p", "name": "M"}]
    routes[("GET", "/api/agent")] = [{"id": "build", "name": "build", "mode": "primary"}]
    runtime, host = build(routes)

    async def scenario() -> None:
        await runtime.start()
        await feed(runtime, frame("model.updated", directory="/other/place"))
        await runtime.stop()

    run(scenario())
    assert published(host, "modelCatalog") == [{"count": 1}]
    assert not [entry for entry in host.published if entry[0] == "state"]


def test_a_session_row_event_only_updates_the_row_for_this_location() -> None:
    routes = dict(BASE_ROUTES)
    routes[("GET", f"/api/session/{EXTERNAL}")] = httpx.Response(
        200, json={"data": {"id": EXTERNAL, "title": "改名了", "location": {"directory": DIRECTORY}, "time": {"updated": 99}}}
    )
    runtime, host = build(routes)

    async def scenario() -> None:
        await runtime.start()
        await feed(runtime, frame("session.model.selected", data={"sessionID": EXTERNAL, "model": {"id": "space-bunny-free", "providerID": "opencode-go"}}))
        await runtime.stop()

    run(scenario())
    metas = published(host, "meta")
    assert metas and metas[0]["title"] == "改名了"
    assert metas[0]["external_session_id"] == EXTERNAL


# ------------------------------------------------ review findings on the pin
#
# The reviewer reproduced four configuration/recovery behaviours with fixtures.
# These are those fixtures: a pin that did not pin, a re-registration nobody
# followed, and `maxRestartAttempts=0` that retried anyway.


def test_a_pinned_pid_that_is_not_registered_never_connects() -> None:
    runtime, host = build(dict(BASE_ROUTES), values={"servicePid": 99999, "maxRestartAttempts": 0})

    async def scenario() -> None:
        await runtime.start()

    run(scenario())
    _status, detail = host.health[-1]
    assert detail["code"] == "runtime_unavailable"
    assert host.requests == [], "refusing a pin mismatch must happen before any request leaves the process"
    assert runtime.pinned_pid == 99999


def test_a_re_registered_service_is_followed_instead_of_failing_reads() -> None:
    first = OpenCodeService(url="http://127.0.0.1:49374", pid=10101, version="2.0.18", password="pw", path=Path("s.json"))
    second = OpenCodeService(url="http://127.0.0.1:50505", pid=20202, version="2.0.18", password="pw", path=Path("s.json"))
    holder = {"service": first}
    ports: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        ports.append(request.url.port or 0)
        if request.url.path == "/api/info":
            return httpx.Response(200, json={"version": "2.0.18", "pid": holder["service"].pid, "urls": []})
        if request.url.path == "/api/debug/location":
            return envelope([{"directory": DIRECTORY}])
        if request.url.path == "/api/session":
            return envelope(SESSION_ROWS)
        return httpx.Response(404, json={"_tag": "NotFound"})

    host = Recorder()
    runtime = OpenCodeServiceRuntime(
        RuntimeConfig(RUNTIME_NAME, 1, values={"location": DIRECTORY, "maxRestartAttempts": 0}),
        SimpleNamespace(connector_id="conn_test", session_namespace="ns_test", **{k: getattr(host, k) for k in HOST_METHODS}),
        service_reader=lambda: holder["service"],
        client_factory=lambda service: OpenCodeServerClient(service, transport=httpx.MockTransport(handler)),
    )

    async def scenario() -> Any:
        await runtime.start()
        before = await runtime.list_sessions(limit=2)
        holder["service"] = second
        after = await runtime.list_sessions(limit=2)
        await runtime.stop()
        return before, after

    before, after = run(scenario())
    assert [row.external_session_id for row in after] == [row.external_session_id for row in before]
    assert set(ports) == {49374, 50505}, "reads after the re-registration must go to the new endpoint"


def test_zero_restart_attempts_means_no_re_read_of_the_registration() -> None:
    reads: list[int] = []

    def reader() -> None:
        reads.append(1)
        return None

    runtime, host = build(dict(BASE_ROUTES), values={"maxRestartAttempts": 0}, service_reader=reader)

    async def scenario() -> None:
        await runtime.start()

    run(scenario())
    assert len(reads) == 1, "an explicit 0 must not become the default three retries"
    assert runtime._restart_task is None
    assert runtime._restart_exhausted is True
