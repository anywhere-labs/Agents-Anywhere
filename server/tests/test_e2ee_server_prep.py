"""Server parts of E2EE ``required`` mode that do not depend on the E2EE contract branch.

- A v2 Connector's plaintext session title and working directory are dropped.
- ``PATCH /sessions/{id}/meta`` accepts only a sealed ``displayUser``.
- The v3 fake device registers only the services a device may register in that mode.
"""

from __future__ import annotations

import asyncio

from device_link_helpers import server, user_and_device
from mesh_fixtures import RouterProcess
from test_backend_mvp import create_connector_and_session, make_client

from agent_server.core.device_meshcall import registered_services
from agent_server.core.e2ee_settings import E2eeSettings
from scripts.v3_fake_device import connect_device


def _meta_upsert(session_id: str, **fields) -> dict:
    return {
        "notifications": [
            {
                "method": "session.meta.upsert",
                "params": {"sessionId": session_id, "runtime": "codex", "runtimeId": "codex", **fields},
            }
        ]
    }


def test_required_mode_drops_v2_plaintext_titles_and_working_directories(tmp_path) -> None:
    client = make_client(tmp_path)
    _connector_id, token, session_id, _headers = create_connector_and_session(client)
    store = client.app.state.store
    ingest = {"Authorization": f"Bearer {token}"}

    client.app.state.e2ee_settings = E2eeSettings(mode="required")
    kept = client.post("/connector/ingest", headers=ingest, json=_meta_upsert(session_id, title="plain", cwd="/other"))
    assert kept.status_code == 200, kept.text
    session = asyncio.run(store.get_session(session_id))
    assert session.title == "Demo" and session.cwd == "/repo"

    # A session the Server does not know yet has no working directory, so it is not created.
    unknown = client.post(
        "/connector/ingest", headers=ingest, json=_meta_upsert("sess_v2_new", title="secret", cwd="/repo")
    )
    assert unknown.status_code == 200, unknown.text
    titles = [s.title for s in asyncio.run(store.list_sessions_for_connector(_connector_id))]
    assert "secret" not in titles

    client.app.state.e2ee_settings = E2eeSettings(mode="off")
    renamed = client.post("/connector/ingest", headers=ingest, json=_meta_upsert(session_id, title="plain"))
    assert renamed.status_code == 200, renamed.text
    assert asyncio.run(store.get_session(session_id)).title == "plain"


def test_session_meta_user_display_by_mode(tmp_path) -> None:
    client = make_client(tmp_path)
    _connector_id, _token, session_id, headers = create_connector_and_session(client)
    store = client.app.state.store

    sealed = {"mode": "sealed", "keyId": "k1", "payload": "c2VhbGVk"}
    response = client.patch(f"/sessions/{session_id}/meta", headers=headers, json={"displayUser": sealed})
    assert response.status_code == 200, response.text
    assert asyncio.run(store.session_directory_fields(session_id))["displayUser"] == sealed

    for rejected in (
        {"mode": "sealed", "payload": {"title": "not ciphertext"}},
        {"payload": "c2VhbGVk"},
    ):
        refused = client.patch(f"/sessions/{session_id}/meta", headers=headers, json={"displayUser": rejected})
        assert refused.status_code == 422, refused.text
        assert refused.json()["detail"]["code"] == "display_envelope_not_sealed"
    empty = client.patch(
        f"/sessions/{session_id}/meta", headers=headers, json={"displayUser": {"mode": "plain", "payload": {}}}
    )
    assert empty.status_code == 422 and empty.json()["detail"]["code"] == "invalid_display_user"

    # Normal mode: a plain {title} renames (title column and plain displayUser), like ``title``.
    plain = {"mode": "plain", "payload": {"title": "Renamed"}}
    renamed = client.patch(f"/sessions/{session_id}/meta", headers=headers, json={"displayUser": plain})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["session"]["title"] == "Renamed"
    assert renamed.json()["session"]["displayUser"] == plain
    by_title = client.patch(f"/sessions/{session_id}/meta", headers=headers, json={"title": "Again"})
    assert by_title.json()["session"]["displayUser"] == {"mode": "plain", "payload": {"title": "Again"}}

    # Required mode: only sealed.
    client.app.state.e2ee_settings = E2eeSettings(mode="required")
    refused = client.patch(f"/sessions/{session_id}/meta", headers=headers, json={"displayUser": plain})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "display_envelope_not_sealed"



def test_fake_device_registers_only_e2ee_services_in_required_mode(mesh_router: RouterProcess, monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SERVER_E2EE", "required")

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _headers, device_id, token = await user_and_device(app, client)
            device, welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                assert welcome["e2eeMode"] == "required"
                assert await app.state.device_mesh.registered_services(device_id) == set(registered_services("required"))
            finally:
                await device.stop()

    asyncio.run(scenario())
