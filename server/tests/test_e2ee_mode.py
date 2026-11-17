"""E2EE ``required`` mode on the Server: settings, the content-route gate, command registrations and the
off -> required switch (docs/v3/11-e2ee-noise.md §10–§11, contracts/e2ee/1.0)."""

from __future__ import annotations

import asyncio
import json

import pytest
from sqlalchemy import select, update
from starlette.websockets import WebSocketDisconnect
from test_backend_mvp import auth_headers, create_connector_and_session, make_client

from agent_server.core.e2ee import (
    SEALED_UPLOAD_HEADER,
    SEALED_UPLOAD_VALUE,
    input_digest,
)
from agent_server.core.e2ee_settings import (
    E2eeSettings,
    accept_display_envelope,
    requires_secure_channel,
)
from agent_server.infra.db.schema import sessions
from agent_server.services.e2ee_commands import E2eeCommandService
from agent_server.services.e2ee_mode import SETTING_E2EE_MODE, apply_e2ee_mode

DIGEST_A = input_digest(b"\x01" * 32, b'{"content":"a"}')
DIGEST_B = input_digest(b"\x01" * 32, b'{"content":"b"}')


# ---------------------------------------------------------------------------
# Settings and route policy
# ---------------------------------------------------------------------------


def test_settings_default_off_and_validate(monkeypatch):
    for name in ("AGENT_SERVER_E2EE", "AGENT_SERVER_E2EE_WEB", "AGENT_SERVER_E2EE_PREVIEW"):
        monkeypatch.delenv(name, raising=False)
    assert E2eeSettings.from_environment() == E2eeSettings("off", "allow", "allow")

    monkeypatch.setenv("AGENT_SERVER_E2EE", "Required")
    monkeypatch.setenv("AGENT_SERVER_E2EE_WEB", "deny")
    monkeypatch.setenv("AGENT_SERVER_E2EE_PREVIEW", "deny")
    settings = E2eeSettings.from_environment()
    assert settings.required
    assert settings.view() == {"mode": "required", "web": "deny", "preview": "deny"}

    monkeypatch.setenv("AGENT_SERVER_E2EE", "on")
    with pytest.raises(ValueError, match="AGENT_SERVER_E2EE"):
        E2eeSettings.from_environment()


@pytest.mark.parametrize(
    ("method", "path", "refused"),
    [
        # Content: creation (first message), reads, the session socket, commands, files, terminals, queue.
        ("POST", "/api/v2/sessions", True),
        ("POST", "/api/v2/sessions/create-and-start", True),
        ("GET", "/api/v2/sessions/s1/snapshot", True),
        ("GET", "/api/v2/sessions/s1/timeline", True),
        ("GET", "/api/v2/sessions/s1/events", True),
        ("GET", "/api/v2/sessions/s1/ws", True),
        ("POST", "/api/v2/sessions/s1/runtime/messages", True),
        ("POST", "/api/v2/sessions/s1/runtime/notices/n1/respond", True),
        ("GET", "/api/v2/sessions/s1/runtime/queue", True),
        ("POST", "/api/v2/sessions/s1/shares", True),
        ("GET", "/api/v2/sessions/s1/attachments/f1", True),
        ("POST", "/api/v2/sessions/s1/attachments", True),
        ("GET", "/api/v2/connectors/c1/fs/list", True),
        ("POST", "/api/v2/connectors/c1/shell/exec", True),
        ("GET", "/api/v2/connectors/c1/terminals-v2/t1/stream", True),
        ("GET", "/api/v2/connectors/fs/preview/read", True),
        ("POST", "/api/v2/runtime-workflows/creations", True),
        ("POST", "/api/v2/runtime-workflows/preparations", True),
        ("POST", "/api/v2/runtime-workflows/creation/w1/responses", True),
        ("GET", "/api/v2/runtime-workflows/sessions/s1/tree", True),
        ("POST", "/api/v2/runtime-workflows/sessions/s1/operations", True),
        # Metadata stays plaintext.
        ("GET", "/api/v2/sessions", False),
        ("GET", "/api/v2/sessions/list", False),
        ("GET", "/api/v2/sessions/s1/meta", False),
        ("PATCH", "/api/v2/sessions/s1/meta", False),
        ("GET", "/api/v2/sessions/s1/runtime/state", False),
        ("GET", "/api/v2/sessions/s1/runtime/capabilities", False),
        ("POST", "/api/v2/sessions/archive", False),
        ("POST", "/api/v2/sessions/read", False),
        ("GET", "/api/v2/connectors", False),
        ("GET", "/api/v2/connectors/c1", False),
        ("PATCH", "/api/v2/connectors/c1/preferences", False),
        ("GET", "/api/v2/connectors/c1/runtimes", False),
        ("GET", "/api/v2/auth/config", False),
        ("GET", "/api/v2/ws", False),
        ("GET", "/api/v2/public/shares/sh1", False),
        ("POST", "/api/v3/e2ee/commands", False),
        ("GET", "/api/v3/tunnel", False),
    ],
)
def test_required_mode_route_policy(method, path, refused):
    assert requires_secure_channel(method, path) is refused


def test_sealed_upload_is_the_only_exception():
    path = "/api/v2/sessions/s1/attachments"
    assert not requires_secure_channel("POST", path, sealed_upload=True)
    # The header does not open any other route.
    assert requires_secure_channel("GET", "/api/v2/sessions/s1/snapshot", sealed_upload=True)
    assert requires_secure_channel("GET", "/api/v2/sessions/s1/attachments/f1", sealed_upload=True)


def test_required_mode_never_stores_plaintext_display_envelopes():
    plain = {"mode": "plain", "payload": {"title": "secret"}}
    sealed = {"mode": "sealed", "keyId": "k1", "payload": "AAAA"}
    assert accept_display_envelope("off", plain) == plain
    assert accept_display_envelope("required", plain) is None
    assert accept_display_envelope("required", sealed) == sealed
    assert accept_display_envelope("required", None) is None


# ---------------------------------------------------------------------------
# The gate in the running app
# ---------------------------------------------------------------------------


def _client(tmp_path, monkeypatch, mode: str):
    monkeypatch.setenv("AGENT_SERVER_E2EE", mode)
    return make_client(tmp_path)


def _setup(tmp_path, monkeypatch, mode: str = "required"):
    """Create a device and a session in off mode, then switch the running app to ``mode``."""

    client = _client(tmp_path, monkeypatch, "off")
    connector_id, token, session_id, headers = create_connector_and_session(client)
    client.app.state.e2ee_settings = E2eeSettings(mode)  # type: ignore[arg-type]
    return client, connector_id, token, session_id, headers


def test_off_mode_changes_nothing(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch, "off")
    _, _, session_id, headers = create_connector_and_session(client)
    assert client.get("/auth/config").json()["e2ee"] == {"mode": "off", "web": "allow", "preview": "allow"}
    # The gate is off: a content route is answered by its own handler (a v2 session without a v3 device may
    # get ``device_upgrade_required``), never refused with ``e2ee_required``.
    response = client.get(f"/sessions/{session_id}/timeline", headers=headers)
    assert "e2ee_required" not in response.text


def test_required_mode_refuses_plaintext_content(tmp_path, monkeypatch):
    client, connector_id, _, session_id, headers = _setup(tmp_path, monkeypatch)

    assert client.get("/auth/config").json()["e2ee"]["mode"] == "required"

    for method, path in (
        ("GET", f"/sessions/{session_id}/timeline"),
        ("GET", f"/sessions/{session_id}/snapshot"),
        ("POST", f"/sessions/{session_id}/runtime/messages"),
        ("GET", f"/connectors/{connector_id}/fs/list?path=/"),
    ):
        response = client.request(method, path, headers=headers, json={} if method == "POST" else None)
        assert response.status_code == 409, (path, response.text)
        assert response.json()["detail"]["code"] == "e2ee_required"

    # The directory and scheduling state stay readable.
    assert client.get(f"/sessions/{session_id}/meta", headers=headers).status_code == 200
    assert client.get("/sessions", headers=headers).status_code == 200
    assert client.get(f"/connectors/{connector_id}", headers=headers).status_code == 200

    # The session socket is refused before it opens.
    with pytest.raises(WebSocketDisconnect) as closed, client.websocket_connect(f"/sessions/{session_id}/ws"):
        pass
    assert closed.value.code == 1008


def test_required_mode_refusal_keeps_cors_headers(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch, "required")
    response = client.get(
        "/sessions/s1/snapshot",
        headers={"Origin": "http://localhost:3000"},
    )
    assert response.status_code == 409
    assert response.headers.get("access-control-allow-origin") == "http://localhost:3000"


def test_required_mode_lets_sealed_uploads_through_the_gate(tmp_path, monkeypatch):
    client, _, _, session_id, headers = _setup(tmp_path, monkeypatch)
    sealed = client.post(
        f"/sessions/{session_id}/attachments",
        headers={**headers, SEALED_UPLOAD_HEADER: SEALED_UPLOAD_VALUE},
        files={"file": ("blob.bin", b"\x00" * 32, "application/octet-stream")},
    )
    # Past the gate: whatever the upload route answers, it is not the E2EE refusal.
    assert sealed.status_code != 409 or sealed.json()["detail"].get("code") != "e2ee_required"
    plain = client.post(
        f"/sessions/{session_id}/attachments",
        headers=headers,
        files={"file": ("a.txt", b"hello", "text/plain")},
    )
    assert plain.status_code == 409
    assert plain.json()["detail"]["code"] == "e2ee_required"


# ---------------------------------------------------------------------------
# Command registrations
# ---------------------------------------------------------------------------


def _register(client, headers, *, command_id="cmd-1", device_id, digest=DIGEST_A):
    return client.post(
        "/api/v3/e2ee/commands",
        headers=headers,
        json={"commandId": command_id, "deviceId": device_id, "inputDigest": digest},
    )


def test_command_registration_is_idempotent_and_detects_conflicts(tmp_path, monkeypatch):
    client, device_id, _, _, headers = _setup(tmp_path, monkeypatch)

    first = _register(client, headers, device_id=device_id)
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["commandId"] == "cmd-1"
    assert body["deviceId"] == device_id
    assert body["outcome"] is None
    assert body["duplicate"] is False
    assert "userId" not in body

    again = _register(client, headers, device_id=device_id)
    assert again.status_code == 200
    assert again.json()["duplicate"] is True
    assert again.json()["registeredAt"] == body["registeredAt"]

    conflict = _register(client, headers, device_id=device_id, digest=DIGEST_B)
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "command_conflict"

    bad = _register(client, headers, command_id="cmd-2", device_id=device_id, digest="sha256:abc")
    assert bad.status_code == 422

    status = client.get("/api/v3/e2ee/commands/cmd-1", headers=headers)
    assert status.status_code == 200
    assert status.json()["inputDigest"] == DIGEST_A


def test_command_registration_is_scoped_to_the_owner(tmp_path, monkeypatch):
    client, device_id, _, _, owner = _setup(tmp_path, monkeypatch)
    other = auth_headers(client, user_id="user2")

    # Someone else's device looks the same as a missing one.
    assert _register(client, other, device_id=device_id).status_code == 404
    assert _register(client, owner, device_id="no-such-device").status_code == 404

    assert _register(client, owner, device_id=device_id).status_code == 200
    assert client.get("/api/v3/e2ee/commands/cmd-1", headers=other).status_code == 404
    # Re-using another user's command id is a conflict, never a read of their registration.
    other_device = client.post("/connectors", headers=other, json={"name": "other"}).json()["connector"]["id"]
    reuse = _register(client, other, device_id=other_device)
    assert reuse.status_code == 409
    assert "inputDigest" not in reuse.text


def test_device_reported_outcome_first_report_wins(tmp_path, monkeypatch):
    client, device_id, _, _, headers = _setup(tmp_path, monkeypatch)
    assert _register(client, headers, device_id=device_id).status_code == 200
    service = E2eeCommandService(client.app.state.store)

    assert asyncio.run(service.record_result("other-device", "cmd-1", "accepted")) is None
    done = asyncio.run(service.record_result(device_id, "cmd-1", "rejected", "runtime_busy"))
    assert done is not None and done["outcome"] == "rejected" and done["errorCode"] == "runtime_busy"
    later = asyncio.run(service.record_result(device_id, "cmd-1", "accepted"))
    assert later is not None and later["outcome"] == "rejected"

    status = client.get("/api/v3/e2ee/commands/cmd-1", headers=headers).json()
    assert status["outcome"] == "rejected"
    assert status["errorCode"] == "runtime_busy"
    assert status["finishedAt"]


# ---------------------------------------------------------------------------
# off -> required
# ---------------------------------------------------------------------------


async def _session_display(store, session_id):
    async with store.engine.connect() as conn:
        row = (
            await conn.execute(
                select(sessions.c.title, sessions.c.title_source, sessions.c.cwd).where(
                    sessions.c.id == session_id
                )
            )
        ).first()
    return tuple(row)


def test_switching_to_required_clears_plaintext_display_once(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch, "off")
    _, _, session_id, headers = create_connector_and_session(client)
    store = client.app.state.store
    client.patch(f"/sessions/{session_id}/meta", headers=headers, json={"title": "Payroll fix"}).raise_for_status()
    title, _, _ = asyncio.run(_session_display(store, session_id))
    assert title == "Payroll fix"

    off = asyncio.run(apply_e2ee_mode(store, E2eeSettings("off")))
    assert off.purged_sessions == 0
    assert asyncio.run(store.get_setting(SETTING_E2EE_MODE)) == "off"
    assert asyncio.run(_session_display(store, session_id))[0] == "Payroll fix"

    switched = asyncio.run(apply_e2ee_mode(store, E2eeSettings("required")))
    assert switched.previous == "off"
    assert switched.purged_sessions >= 1
    assert asyncio.run(_session_display(store, session_id)) == (None, None, None)
    assert asyncio.run(store.get_setting(SETTING_E2EE_MODE)) == "required"

    # Restarting in required mode purges nothing more; going back to off keeps what is stored.
    assert asyncio.run(apply_e2ee_mode(store, E2eeSettings("required"))).purged_sessions == 0
    back = asyncio.run(apply_e2ee_mode(store, E2eeSettings("off")))
    assert back.previous == "required" and back.purged_sessions == 0


async def _set_envelopes(store, session_id, *, device, user):
    async with store.engine.begin() as conn:
        await conn.execute(
            update(sessions)
            .where(sessions.c.id == session_id)
            .values(display_device=json.dumps(device), display_user=json.dumps(user))
        )


async def _envelopes(store, session_id):
    async with store.engine.connect() as conn:
        row = (
            await conn.execute(
                select(sessions.c.display_device, sessions.c.display_user).where(sessions.c.id == session_id)
            )
        ).first()
    return tuple(json.loads(value) if value else None for value in row)


SEALED = {"mode": "sealed", "keyId": "k1", "payload": "c2VhbGVk"}


@pytest.mark.parametrize(
    ("device", "user", "kept"),
    [
        ({"mode": "plain", "payload": {"title": "Payroll", "cwd": "/srv/payroll"}}, SEALED, (None, SEALED)),
        (SEALED, {"mode": "plain", "payload": {"title": "Payroll fix"}}, (SEALED, None)),
    ],
)
def test_switching_to_required_clears_plain_envelopes_and_keeps_sealed_ones(tmp_path, monkeypatch, device, user, kept):
    client = _client(tmp_path, monkeypatch, "off")
    _, _, session_id, _ = create_connector_and_session(client)
    store = client.app.state.store
    asyncio.run(_set_envelopes(store, session_id, device=device, user=user))
    asyncio.run(apply_e2ee_mode(store, E2eeSettings("off")))

    switched = asyncio.run(apply_e2ee_mode(store, E2eeSettings("required")))
    assert switched.purged_sessions >= 1
    assert asyncio.run(_envelopes(store, session_id)) == kept
    assert asyncio.run(_session_display(store, session_id)) == (None, None, None)


# ---------------------------------------------------------------------------
# E-1 on the Server: nothing a client sends in required mode reaches the database in plaintext
# ---------------------------------------------------------------------------


async def _database_text(store) -> str:
    """Every row of every table, as text."""

    from sqlalchemy import text as sql

    from agent_server.infra.db.schema import metadata

    chunks: list[str] = []
    async with store.engine.connect() as conn:
        for table in metadata.sorted_tables:
            rows = (await conn.execute(sql(f'SELECT * FROM "{table.name}"'))).all()
            chunks.extend(repr(tuple(row)) for row in rows)
    return "\n".join(chunks)


def test_required_mode_canary_never_reaches_the_database(tmp_path, monkeypatch):
    import secrets as _secrets

    client, device_id, _, session_id, headers = _setup(tmp_path, monkeypatch)
    canary = f"canary-{_secrets.token_hex(12)}"

    # Everything a client could try to send in plaintext.
    attempts = [
        ("POST", "/sessions", {"connectorId": device_id, "runtime": "codex", "content": canary, "title": canary}),
        ("POST", "/sessions/create-and-start", {"connectorId": device_id, "runtime": "codex", "content": canary}),
        ("POST", f"/sessions/{session_id}/runtime/messages", {"content": canary, "clientMessageId": canary}),
        ("POST", f"/sessions/{session_id}/runtime/steer", {"content": canary}),
        ("POST", f"/sessions/{session_id}/shares", {"scope": "session", "title": canary}),
        ("POST", f"/connectors/{device_id}/fs/write", {"path": f"/tmp/{canary}", "content": canary}),
        ("POST", f"/connectors/{device_id}/shell/exec", {"command": f"echo {canary}"}),
        ("PATCH", f"/sessions/{session_id}/meta", {"title": canary}),
    ]
    for method, path, body in attempts:
        response = client.request(method, path, headers=headers, json=body)
        assert response.status_code == 409, (path, response.status_code, response.text)
        assert response.json()["detail"]["code"] == "e2ee_required"
    upload = client.post(
        f"/sessions/{session_id}/attachments",
        headers=headers,
        files={"file": (f"{canary}.txt", canary.encode(), "text/plain")},
    )
    assert upload.status_code == 409

    # What the client may send: the command registration, keyed digest only.
    body = json.dumps({"content": canary, "clientMessageId": "m1"}).encode()
    registered = client.post(
        "/api/v3/e2ee/commands",
        headers=headers,
        json={"commandId": "m1", "deviceId": device_id, "inputDigest": input_digest(b"\x07" * 32, body)},
    )
    assert registered.status_code == 200
    # Metadata changes stay allowed.
    assert client.patch(f"/sessions/{session_id}/meta", headers=headers, json={"pinned": True}).status_code == 200

    dump = asyncio.run(_database_text(client.app.state.store))
    assert "e2ee_command_registrations" not in dump  # sanity: rows, not table names
    assert "m1" in dump  # the registration is there
    assert canary not in dump
