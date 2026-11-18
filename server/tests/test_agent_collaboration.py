"""Agent collaboration on the Server: settings, delegations, the agent gate, edges, origin and target signals.

Real Server app, a real MeshCall Router and fake devices (``scripts.v3_fake_device``), like the other device tests.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from device_link_helpers import acked, eventually, server, summary, user_and_device
from mesh_fixtures import RouterProcess
from sqlalchemy import update

from agent_server.core.agent_collab import (
    AgentCollaborationSettings,
    agent_route,
    collaboration_settings_from_stored,
    creates_cycle,
)
from agent_server.core.auth import create_user_access_token
from agent_server.infra.db.schema import agent_delegations
from scripts.v3_fake_device import FakeDevice, connect_device

SUP = "sess_sup"
SUP2 = "sess_sup2"
TGT = "sess_tgt"
ON = {
    "enabled": True,
    "crossDevice": True,
    "instances": {"codex": {"enabled": True, "crossDevice": True}},
}


@dataclass
class Device:
    id: str
    token: str
    fake: FakeDevice
    access: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access}"}

    async def push(self, method: str, payload: dict[str, Any]) -> None:
        item = self.fake.state.push_outbox(method, payload)
        await eventually(lambda: acked(self.fake, item.oid))


@dataclass
class World:
    app: Any
    client: httpx.AsyncClient
    headers: dict[str, str]
    a: Device
    b: Device
    #: deviceId -> the project of ``/repo`` on it
    projects: dict[str, str]

    async def delegation(self, *, grant: str = "grant_1", scope: Any = "account", session: str = SUP) -> str:
        response = await self.client.post(
            "/api/v3/device/agent-delegations",
            headers=self.a.headers,
            json={"grantId": grant, "supervisorSessionId": session, "scope": {"devices": scope}},
        )
        assert response.status_code == 200, response.text
        return response.json()["token"]

    async def edge(self, supervision: str, supervisor: str, target: str, target_device: str, *, state: str = "active",
                   at: str = "2026-11-18T10:00:00Z", via: Device | None = None) -> None:
        await (via or self.a).push(
            "collab.supervision.changed",
            {
                "supervisionId": supervision,
                "supervisorSessionId": supervisor,
                "targetSessionId": target,
                "targetDeviceId": target_device,
                "state": state,
                "createdBy": "agent",
                "at": at,
            },
        )


async def _device(client: httpx.AsyncClient, connector_id: str, token: str) -> Device:
    fake, _welcome, access = await connect_device(client, connector_id=connector_id, connector_token=token)
    return Device(connector_id, token, fake, access)


@asynccontextmanager
async def world(router: RouterProcess, monkeypatch) -> AsyncIterator[World]:
    async with server(router, monkeypatch) as (app, client):
        headers, a_id, a_token = await user_and_device(app, client)
        created = await client.post("/api/v2/connectors", headers=headers, json={"name": "desk"})
        created.raise_for_status()
        b_id, b_token = created.json()["connector"]["id"], created.json()["connectorToken"]
        project = await client.post(
            "/api/v2/projects", headers=headers, json={"connectorId": b_id, "name": "repo-b", "workspacePath": "/repo"}
        )
        project.raise_for_status()
        projects = {
            item["connectorId"]: item["id"]
            for item in (await client.get("/api/v2/projects", headers=headers)).json()["projects"]
        }
        a = await _device(client, a_id, a_token)
        b = await _device(client, b_id, b_token)
        try:
            await a.push("session.summary", summary(SUP, 1))
            await a.push("session.summary", summary(SUP2, 1))
            await b.push("session.summary", summary(TGT, 1))
            yield World(app, client, headers, a, b, projects)
        finally:
            await app.state.collab.drain()
            for device in (a, b):
                with contextlib.suppress(Exception):
                    await device.fake.stop()


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _code(response: httpx.Response) -> str:
    return response.json()["detail"]["code"]


async def _other_user(app: Any, client: httpx.AsyncClient) -> tuple[dict[str, str], str]:
    user = await app.state.store.create_user(user_id="user_other", password="password-other")
    headers = {"Authorization": f"Bearer {create_user_access_token(user.userId)}"}
    created = await client.post("/api/v2/connectors", headers=headers, json={"name": "theirs"})
    created.raise_for_status()
    return headers, created.json()["connector"]["id"]


# -- pure rules -----------------------------------------------------------------------------------


def test_settings_default_off_and_read_tolerantly() -> None:
    assert AgentCollaborationSettings().model_dump() == {"enabled": False, "crossDevice": False, "instances": {}}
    stored = collaboration_settings_from_stored(
        {"enabled": True, "crossDevice": "yes", "instances": {"codex": {"enabled": True, "authority": {"interrupt": 1}},
                                                               "": {"enabled": True}, "pi": "bad"}}
    )
    assert stored.enabled is True and stored.crossDevice is False and list(stored.instances) == ["codex"]
    assert stored.instances["codex"].authority.model_dump() == {
        "steer": True, "interrupt": False, "respondApproval": False, "reviewPlan": False, "close": True,
    }
    settings = AgentCollaborationSettings.model_validate(ON)
    assert settings.instance_enabled("codex") and settings.instance_cross_device("codex")
    assert not settings.instance_enabled("claude")
    assert not settings.model_copy(update={"crossDevice": False}).instance_cross_device("codex")
    assert not settings.model_copy(update={"enabled": False}).instance_enabled("codex")


def test_cycles_and_agent_routes() -> None:
    edges = [("a", "b"), ("b", "c")]
    assert creates_cycle(edges, "c", "a") and creates_cycle(edges, "a", "a")
    assert not creates_cycle(edges, "a", "c") and not creates_cycle(edges, "d", "a")
    assert agent_route("GET", "/api/v2/sessions/s1/meta").params == {"session_id": "s1"}  # type: ignore[union-attr]
    assert agent_route("POST", "/api/v2/sessions/s1/runtime/messages") is not None
    assert agent_route("GET", "/api/v2/connectors/c1/runtimes").params == {"connector_id": "c1"}  # type: ignore[union-attr]
    assert agent_route("WS", "/api/v3/tunnel") is not None
    for method, path in (
        ("PATCH", "/api/v2/sessions/s1/meta"),
        ("GET", "/api/v2/sessions/s1/runtime/commands"),
        ("POST", "/api/v2/connectors"),
        ("GET", "/api/v2/agent-collaboration/settings"),
        ("POST", "/api/v2/sessions/s1/collab/supervisions"),
        ("GET", "/api/v2/auth/me"),
    ):
        assert agent_route(method, path) is None, (method, path)


# -- settings ---------------------------------------------------------------------------------------


def test_settings_are_stored_and_pushed_to_every_device(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with world(mesh_router, monkeypatch) as w:
            path = "/api/v2/agent-collaboration/settings"
            initial = await w.client.get(path, headers=w.headers)
            assert initial.status_code == 200 and initial.json() == {"enabled": False, "crossDevice": False,
                                                                    "instances": {}}
            assert (await w.client.put(path, headers=w.headers, json={"enabled": True, "bogus": 1})).status_code == 422
            changed = await w.client.put(
                path, headers=w.headers, json={"enabled": True, "instances": {"codex": {"enabled": True}}}
            )
            assert changed.status_code == 200, changed.text
            expected = {
                "enabled": True,
                "crossDevice": False,
                "instances": {"codex": {"enabled": True, "crossDevice": False, "authority": {
                    "steer": True, "interrupt": False, "respondApproval": False, "reviewPlan": False, "close": True,
                }}},
            }
            assert changed.json() == expected
            assert (await w.client.get(path, headers=w.headers)).json() == expected
            # Both online devices got it with their own settings beside it.
            for device in (w.a, w.b):
                applied = [p for m, p in device.fake.state.command_log if m == "device.settings.apply"]
                assert applied[-1]["settings"] == {"confirmQuitOnShutdown": False, "agentCollaboration": expected}
            # A per-device change keeps the account's collaboration settings in the payload.
            patched = await w.client.patch(
                f"/api/v2/connectors/{w.a.id}/device-settings", headers=w.headers, json={"confirmQuitOnShutdown": True}
            )
            assert patched.status_code == 200 and patched.json()["settings"] == {"confirmQuitOnShutdown": True}
            applied = [p for m, p in w.a.fake.state.command_log if m == "device.settings.apply"]
            assert applied[-1]["settings"] == {"confirmQuitOnShutdown": True, "agentCollaboration": expected}
            # A device that links again gets them in its desired state.
            hello = await w.client.post(
                "/api/v3/device/hello",
                headers=w.b.headers,
                json={"deviceId": w.b.id, "connectorVersion": "3.0.0", "contractVersions": ["1.0"], "os": "macos",
                      "host": "cli", "sessionsHead": []},
            )
            assert hello.status_code == 200, hello.text
            assert hello.json()["desired"]["deviceSettings"]["agentCollaboration"] == expected

    asyncio.run(scenario())


# -- delegations and the agent gate ---------------------------------------------------------------------


def test_delegations_are_issued_refused_revoked_and_expire(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with world(mesh_router, monkeypatch) as w:
            url = "/api/v3/device/agent-delegations"
            body = {"grantId": "grant_1", "supervisorSessionId": SUP, "scope": {"devices": "account"}}
            # Collaboration off: refused.
            refused = await w.client.post(url, headers=w.a.headers, json=body)
            assert refused.status_code == 403 and _code(refused) == "agent_delegation_unavailable"
            put = {**ON, "crossDevice": False}
            await w.client.put("/api/v2/agent-collaboration/settings", headers=w.headers, json=put)
            refused = await w.client.post(url, headers=w.a.headers, json=body)
            assert refused.status_code == 403 and _code(refused) == "agent_delegation_unavailable"
            await w.client.put("/api/v2/agent-collaboration/settings", headers=w.headers, json=ON)
            # The supervisor session must be the calling device's; a user token is not a device credential.
            other_device = await w.client.post(url, headers=w.b.headers, json=body)
            assert other_device.status_code == 403 and _code(other_device) == "agent_delegation_unavailable"
            assert (await w.client.post(url, headers=w.headers, json=body)).status_code == 401
            foreign = await w.client.post(url, headers=w.a.headers, json={**body, "scope": {"devices": ["conn_x"]}})
            assert foreign.status_code == 403

            issued = await w.client.post(url, headers=w.a.headers, json=body)
            assert issued.status_code == 200, issued.text
            data = issued.json()
            assert data["delegationId"].startswith("dlg_") and data["expiresAt"].endswith("Z")
            token = data["token"]
            listed = await w.client.get("/api/v2/connectors", headers=_bearer(token))
            assert listed.status_code == 200, listed.text
            assert sorted(listed.json()["connectors"], key=lambda item: item["name"]) == [
                {"id": w.b.id, "name": "desk", "online": True, "e2eeMode": "off"},
                {"id": w.a.id, "name": "laptop", "online": True, "e2eeMode": "off"},
            ]

            # Revoking the grant ends every token of it.
            second = await w.delegation()
            revoked = await w.client.delete(f"{url}/grant_1", headers=w.a.headers)
            assert revoked.status_code == 200 and revoked.json() == {"grantId": "grant_1", "revoked": 2}
            for value in (token, second):
                denied = await w.client.get("/api/v2/connectors", headers=_bearer(value))
                assert denied.status_code == 401 and _code(denied) == "agent_grant_revoked"

            # Expired in the database: refused even though the token's own clock still allows it.
            third = await w.delegation(grant="grant_2")
            async with w.app.state.store.engine.begin() as conn:
                await conn.execute(
                    update(agent_delegations)
                    .where(agent_delegations.c.grant_id == "grant_2")
                    .values(expires_at="2026-01-01T00:00:00Z")
                )
            expired = await w.client.get("/api/v2/connectors", headers=_bearer(third))
            assert expired.status_code == 401 and _code(expired) == "agent_delegation_invalid"

            # Turning cross-device collaboration off makes live tokens useless at once.
            fourth = await w.delegation(grant="grant_3")
            assert (await w.client.get("/api/v2/connectors", headers=_bearer(fourth))).status_code == 200
            await w.client.put("/api/v2/agent-collaboration/settings", headers=w.headers,
                               json={**ON, "crossDevice": False})
            off = await w.client.get("/api/v2/connectors", headers=_bearer(fourth))
            assert off.status_code == 401 and _code(off) == "agent_grant_revoked"

            # A collab.grant.changed revocation from the device does the same.
            await w.client.put("/api/v2/agent-collaboration/settings", headers=w.headers, json=ON)
            fifth = await w.delegation(grant="grant_4")
            await w.a.push(
                "collab.grant.changed",
                {"grantId": "grant_4", "supervisorSessionId": SUP, "state": "revoked", "at": "2026-11-18T10:00:00Z"},
            )
            gone = await w.client.get("/api/v2/connectors", headers=_bearer(fifth))
            assert gone.status_code == 401 and _code(gone) == "agent_grant_revoked"

    asyncio.run(scenario())


def test_the_gate_admits_only_agent_routes_in_scope(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with world(mesh_router, monkeypatch) as w:
            await w.client.put("/api/v2/agent-collaboration/settings", headers=w.headers, json=ON)
            agent = _bearer(await w.delegation())
            for path in (
                "/api/v2/sessions",
                "/api/v2/sessions/list",
                f"/api/v2/sessions/{TGT}/meta",
                f"/api/v2/connectors/{w.b.id}/runtimes",
            ):
                allowed = await w.client.get(path, headers=agent)
                assert allowed.status_code == 200, (path, allowed.text)
            meta = (await w.client.get(f"/api/v2/sessions/{TGT}/meta", headers=agent)).json()["session"]
            assert meta["id"] == TGT and meta["connectorId"] == w.b.id
            for method, path in (
                ("PATCH", f"/api/v2/sessions/{TGT}/meta"),
                ("GET", f"/api/v2/sessions/{TGT}/runtime/commands"),
                ("GET", "/api/v2/agent-collaboration/settings"),
                ("POST", "/api/v2/connectors"),
                ("DELETE", f"/api/v2/connectors/{w.b.id}"),
                ("GET", "/api/v2/projects"),
            ):
                denied = await w.client.request(method, path, headers=agent, json={})
                assert denied.status_code == 403 and _code(denied) == "agent_route_denied", (method, path)

            # Another account's session and device are unknown to the Agent.
            _other_headers, other_device = await _other_user(w.app, w.client)
            unknown = await w.client.get(f"/api/v2/connectors/{other_device}/runtimes", headers=agent)
            assert unknown.status_code == 404 and _code(unknown) == "agent_target_unknown"
            unknown = await w.client.get("/api/v2/sessions/sess_nope/meta", headers=agent)
            assert unknown.status_code == 404 and _code(unknown) == "agent_target_unknown"

            # A delegation limited to device A: device B's session is out of scope and not listed.
            narrow = _bearer(await w.delegation(grant="grant_narrow", scope=[w.a.id]))
            outside = await w.client.get(f"/api/v2/sessions/{TGT}/meta", headers=narrow)
            assert outside.status_code == 403 and _code(outside) == "agent_scope_denied"
            listed = (await w.client.get("/api/v2/sessions", headers=narrow)).json()["sessions"]
            assert sorted(item["id"] for item in listed) == [SUP, SUP2]
            devices = (await w.client.get("/api/v2/connectors", headers=narrow)).json()["connectors"]
            assert [item["id"] for item in devices] == [w.a.id]
            started = await w.client.post(
                "/api/v2/sessions/create-and-start", headers=narrow,
                json={"connectorId": w.b.id, "projectId": w.projects[w.b.id], "runtime": "codex", "content": "hi"},
            )
            assert started.status_code == 403 and _code(started) == "agent_scope_denied"

            # A person's token is not affected by the gate.
            assert (await w.client.get("/api/v2/projects", headers=w.headers)).status_code == 200

    asyncio.run(scenario())


def test_forwarded_requests_carry_the_agent_and_the_receipt_records_it(
    mesh_router: RouterProcess, monkeypatch
) -> None:
    async def scenario() -> None:
        async with world(mesh_router, monkeypatch) as w:
            store = w.app.state.store
            await w.client.put("/api/v2/agent-collaboration/settings", headers=w.headers, json=ON)
            agent = _bearer(await w.delegation())
            assert (await w.client.post(f"/api/v2/sessions/{TGT}/takeover", headers=w.headers)).status_code == 200
            state = w.b.fake.state
            state.client_handler = lambda request: (200, {"ok": True})
            sent = await w.client.post(
                f"/api/v2/sessions/{TGT}/runtime/messages",
                headers={**agent, "X-Client-Platform": "agent"},
                json={"clientMessageId": "m_agent_1", "content": "run the tests"},
            )
            assert sent.status_code == 200, sent.text
            request = state.client_calls[-1]
            assert request["route"] == "session.runtime.messages"
            assert request["caller"]["userId"] == "user_v3"
            assert request["caller"]["agent"] == {"deviceId": w.a.id, "sessionId": SUP, "grantId": "grant_1"}
            receipt = await store.get_device_command("user_v3", "m_agent_1")
            assert receipt["actor"] == f"agent:{w.a.id}/{SUP}"

            person = await w.client.post(
                f"/api/v2/sessions/{TGT}/runtime/messages",
                headers=w.headers,
                json={"clientMessageId": "m_person_1", "content": "hello"},
            )
            assert person.status_code == 200, person.text
            assert state.client_calls[-1]["caller"].get("agent") is None
            assert (await store.get_device_command("user_v3", "m_person_1"))["actor"] == "user"

            # A collaboration read of a session, forwarded to its device.
            state.client_handler = lambda request: (200, {"supervisions": []})
            collab = await w.client.get(f"/api/v2/sessions/{TGT}/collab", headers=agent)
            assert collab.status_code == 200 and collab.json() == {"supervisions": []}
            assert state.client_calls[-1]["route"] == "session.collab.get"

    asyncio.run(scenario())


def test_create_and_start_by_an_agent_records_its_origin_and_depth(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with world(mesh_router, monkeypatch) as w:
            store = w.app.state.store
            await w.client.put("/api/v2/agent-collaboration/settings", headers=w.headers, json=ON)
            agent = _bearer(await w.delegation())
            w.b.fake.state.client_handler = lambda request: (
                200, {"connectorResult": {"created": True, "messageAccepted": True}}
            )

            def body(message_id: str) -> dict[str, Any]:
                return {"connectorId": w.b.id, "projectId": w.projects[w.b.id], "runtime": "codex",
                        "content": "fix it", "clientMessageId": message_id}

            started = await w.client.post("/api/v2/sessions/create-and-start", headers=agent, json=body("m_spawn_1"))
            assert started.status_code == 200, started.text
            child = started.json()["session"]
            assert child["origin"] == {"kind": "agent", "bySessionId": SUP, "byDeviceId": w.a.id, "depth": 1}
            assert w.b.fake.state.client_calls[-1]["caller"]["agent"]["sessionId"] == SUP
            meta = (await w.client.get(f"/api/v2/sessions/{child['id']}/meta", headers=w.headers)).json()["session"]
            assert meta["origin"]["depth"] == 1
            assert (await store.get_device_command("user_v3", "m_spawn_1"))["actor"] == f"agent:{w.a.id}/{SUP}"

            # A person's session has no origin.
            person = await w.client.post("/api/v2/sessions/create-and-start", headers=w.headers, json=body("m_p"))
            assert person.status_code == 200 and person.json()["session"]["origin"] is None

            # Created by a supervisor that is itself 8 deep: refused.
            assert await store.set_session_origin(SUP, {"kind": "agent", "bySessionId": "sess_root", "depth": 8})
            deep = await w.client.post("/api/v2/sessions/create-and-start", headers=agent, json=body("m_spawn_2"))
            assert deep.status_code == 403 and _code(deep) == "agent_depth_exceeded"
            assert await store.get_device_command("user_v3", "m_spawn_2") is None

    asyncio.run(scenario())


# -- device outbox ------------------------------------------------------------------------------------


def test_supervision_edges_are_stored_shown_and_cycles_refused(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with world(mesh_router, monkeypatch) as w:
            store = w.app.state.store

            async def meta(session_id: str) -> dict[str, Any]:
                return (await w.client.get(f"/api/v2/sessions/{session_id}/meta", headers=w.headers)).json()["session"]

            await w.edge("sup_1", SUP, TGT, w.b.id)
            edge = {"supervisionId": "sup_1", "supervisorSessionId": SUP, "targetSessionId": TGT, "state": "active",
                    "createdBy": "agent"}
            assert (await meta(TGT))["supervisors"] == [edge] and (await meta(TGT))["supervised"] == []
            assert (await meta(SUP))["supervised"] == [edge] and (await meta(SUP))["supervisors"] == []
            listed = {item["id"]: item for item in
                      (await w.client.get("/api/v2/sessions", headers=w.headers)).json()["sessions"]}
            assert listed[TGT]["supervisors"] == [edge] and listed[SUP2]["supervised"] == []

            # The reverse edge would close a cycle: stored as ended, never shown.
            await w.edge("sup_back", TGT, SUP, w.a.id, via=w.b)
            assert (await store.get_collab_edge("sup_back"))["state"] == "ended"
            assert (await meta(TGT))["supervised"] == []
            # A device may report only edges of its own supervisor sessions.
            await w.edge("sup_forged", TGT, SUP2, w.a.id)
            assert await store.get_collab_edge("sup_forged") is None
            # The target must be on the device the report names, and the account's.
            await w.edge("sup_wrong", SUP, TGT, w.a.id)
            assert await store.get_collab_edge("sup_wrong") is None
            # Another account's session is never a target.
            other_headers, foreign_device = await _other_user(w.app, w.client)
            foreign_project = await w.client.post(
                "/api/v2/projects", headers=other_headers,
                json={"connectorId": foreign_device, "name": "theirs", "workspacePath": "/theirs"},
            )
            foreign_project.raise_for_status()
            foreign = await store.create_session(
                connector_id=foreign_device, project_id=foreign_project.json()["project"]["id"], runtime="codex",
                external_session_id=None, title=None, cwd="/theirs", session_id="sess_foreign",
            )
            await w.edge("sup_foreign", SUP, foreign.id, foreign_device)
            assert await store.get_collab_edge("sup_foreign") is None

            # Paused still shows; an older report changes nothing; ended disappears and stays ended.
            await w.edge("sup_1", SUP, TGT, w.b.id, state="paused", at="2026-11-18T10:01:00Z")
            assert (await meta(TGT))["supervisors"][0]["state"] == "paused"
            await w.edge("sup_1", SUP, TGT, w.b.id, state="active", at="2026-11-18T09:00:00Z")
            assert (await meta(TGT))["supervisors"][0]["state"] == "paused"
            await w.edge("sup_1", SUP, TGT, w.b.id, state="ended", at="2026-11-18T10:02:00Z")
            assert (await meta(TGT))["supervisors"] == [] and (await meta(SUP))["supervised"] == []
            await w.edge("sup_1", SUP, TGT, w.b.id, state="active", at="2026-11-18T10:03:00Z")
            assert (await store.get_collab_edge("sup_1"))["state"] == "ended"
            # With the first edge gone the reverse direction is allowed.
            await w.edge("sup_back_2", TGT, SUP, w.a.id, via=w.b)
            assert (await meta(SUP))["supervisors"][0]["supervisionId"] == "sup_back_2"

    asyncio.run(scenario())


def test_a_reported_origin_never_changes(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with world(mesh_router, monkeypatch) as w:
            first = summary("sess_child", 1)
            first["summary"]["origin"] = {"kind": "agent", "bySessionId": SUP, "byDeviceId": w.a.id, "depth": 2}
            await w.b.push("session.summary", first)
            later = summary("sess_child", 2)
            later["summary"]["origin"] = {"kind": "agent", "bySessionId": "sess_other", "depth": 5}
            await w.b.push("session.summary", later)
            none = summary("sess_child", 3)
            await w.b.push("session.summary", none)
            meta = (await w.client.get("/api/v2/sessions/sess_child/meta", headers=w.headers)).json()["session"]
            assert meta["origin"] == {"kind": "agent", "bySessionId": SUP, "byDeviceId": w.a.id, "depth": 2}
            assert await w.app.state.store.session_origin_depth("sess_child") == 2

    asyncio.run(scenario())


# -- target signals ---------------------------------------------------------------------------------


def test_target_signals_follow_changes_batched_per_supervisor_device(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with world(mesh_router, monkeypatch) as w:
            collab = w.app.state.collab

            def signals() -> list[dict[str, Any]]:
                return [p for m, p in w.a.fake.state.command_log if m == "collab.signal"]

            await w.edge("sup_1", SUP, TGT, w.b.id)
            await w.edge("sup_2", SUP2, TGT, w.b.id)
            # A change of a signalled field: one command to device A with a signal per edge.
            await w.b.push("session.summary", summary(TGT, 2, status="running"))
            await collab.drain()
            [batch] = signals()
            assert [item["supervisionId"] for item in batch["signals"]] == ["sup_1", "sup_2"]
            signal = batch["signals"][0]
            assert (signal["supervisorSessionId"], signal["targetSessionId"], signal["targetDeviceId"]) == (
                SUP, TGT, w.b.id
            )
            assert (signal["status"], signal["headSeq"], signal["latestTurnEndSeq"], signal["deviceOnline"]) == (
                "running", 2, 2, True
            )
            # The same summary again changes nothing: no signal.
            await w.b.push("session.summary", summary(TGT, 2, status="running"))
            await collab.drain()
            assert len(signals()) == 1
            # A title change is not a scheduling change either.
            await w.b.push("session.summary", summary(TGT, 2, status="running", title="Renamed"))
            await collab.drain()
            assert len(signals()) == 1
            await w.b.push("session.summary", summary(TGT, 3, status="idle"))
            await collab.drain()
            assert len(signals()) == 2 and signals()[-1]["signals"][0]["status"] == "idle"
            # A paused edge still signals; an ended one does not.
            await w.edge("sup_2", SUP2, TGT, w.b.id, state="ended", at="2026-11-18T11:00:00Z")
            await w.b.push("session.summary", summary(TGT, 4, status="running"))
            await collab.drain()
            assert [item["supervisionId"] for item in signals()[-1]["signals"]] == ["sup_1"]

            # The target's device goes offline (as the link hub reports it): its supervisors are told.
            await w.app.state.device_link.handle_presence(w.b.id, False)
            await collab.drain()
            assert [item["deviceOnline"] for item in signals()[-1]["signals"]] == [False]
            assert len(signals()) == 4

    asyncio.run(scenario())


def test_deleting_a_device_ends_its_edges_and_revokes_its_delegations(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with world(mesh_router, monkeypatch) as w:
            store = w.app.state.store
            await w.client.put("/api/v2/agent-collaboration/settings", headers=w.headers, json=ON)
            token = await w.delegation()
            await w.edge("sup_1", SUP, TGT, w.b.id)
            deleted = await w.client.delete(f"/api/v2/connectors/{w.b.id}", headers=w.headers)
            assert deleted.status_code in (200, 202, 204), deleted.text
            await eventually(lambda: _edge_state(store, "sup_1", "ended"))
            meta = (await w.client.get(f"/api/v2/sessions/{SUP}/meta", headers=w.headers)).json()["session"]
            assert meta["supervised"] == []
            assert (await w.client.get("/api/v2/connectors", headers=_bearer(token))).status_code == 200
            deleted = await w.client.delete(f"/api/v2/connectors/{w.a.id}", headers=w.headers)
            assert deleted.status_code in (200, 202, 204), deleted.text
            await eventually(lambda: _revoked(w.client, token))

    asyncio.run(scenario())


async def _edge_state(store: Any, supervision_id: str, state: str) -> bool:
    edge = await store.get_collab_edge(supervision_id)
    return edge is not None and edge["state"] == state


async def _revoked(client: httpx.AsyncClient, token: str) -> bool:
    return (await client.get("/api/v2/connectors", headers=_bearer(token))).status_code == 401


@pytest.mark.parametrize("route_id", ["session.collab.get", "session.collab.supervise",
                                      "session.collab.supervision.update"])
def test_collaboration_routes_are_device_routes(route_id: str) -> None:
    from agent_server.core.client_routes import ROUTES_BY_ID

    route = ROUTES_BY_ID[route_id]
    assert route.owner == "device" and route.via == "call"
