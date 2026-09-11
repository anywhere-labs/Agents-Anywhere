from __future__ import annotations

import asyncio

import pytest
from starlette.websockets import WebSocketDisconnect
from test_backend_mvp import create_connector_and_session, make_client


def test_revocation_invalidates_previously_issued_access_token(tmp_path):
    client = make_client(tmp_path)
    connector_id, token, session_id, headers = create_connector_and_session(client)
    revoked = client.post(f"/connectors/{connector_id}/revoke", headers=headers)
    assert revoked.status_code == 200
    request = {"notifications": [{"method": "session.meta.upsert", "params": {
        "sessionId": session_id, "runtime": "codex", "title": "stale write",
    }}]}
    stale_headers = {"Authorization": f"Bearer {token}"}
    response = client.post("/connector/ingest", headers=stale_headers, json=request)
    assert response.status_code == 401
    assert asyncio.run(client.app.state.store.get_session(session_id)).title == "Demo"
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/connector/ws", headers=stale_headers):
            pass
    assert closed.value.code == 1008
    new_secret = revoked.json()["connectorToken"]
    authenticated = client.post("/connector/auth", headers={
        "Authorization": f"Connector {connector_id}:{new_secret}",
    })
    assert authenticated.status_code == 200
    response = client.post("/connector/ingest", headers={
        "Authorization": f"Bearer {authenticated.json()['accessToken']}",
    }, json={"notifications": [{"method": "connector.heartbeat", "params": {}}]})
    assert response.status_code == 200


def test_access_token_cannot_be_retargeted_to_another_connector(tmp_path):
    client = make_client(tmp_path)
    _, token, _, _ = create_connector_and_session(client)
    other, _, _, _ = create_connector_and_session(client)
    forged = f"{other}.{token.split('.', 1)[1]}"
    response = client.post("/connector/ingest", headers={
        "Authorization": f"Bearer {forged}",
    }, json={"notifications": [{"method": "connector.heartbeat", "params": {}}]})
    assert response.status_code == 401
