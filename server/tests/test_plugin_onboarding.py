from __future__ import annotations

from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest

from agent_server.core.oauth_clients import DSH_PLUGIN_OAUTH_CLIENT
from test_auth import admin_token, bearer, make_client, pkce_challenge, register


@pytest.mark.parametrize("uri", [
    "http://127.0.0.1:42189/oauth/callback",
    "http://127.0.0.1:65535/oauth/callback",
])
def test_plugin_oauth_round_trip_and_replay(tmp_path, uri):
    client = make_client(tmp_path)
    token = admin_token(client)
    verifier = "plugin-verifier-" + "x" * 48
    authorized = client.post("/oauth/authorize", headers=bearer(token), json={
        "response_type": "code", "client_id": DSH_PLUGIN_OAUTH_CLIENT.client_id,
        "redirect_uri": uri, "code_challenge": pkce_challenge(verifier),
        "code_challenge_method": "S256", "scope": "profile", "state": "plugin-state",
    })
    assert authorized.status_code == 200, authorized.text
    redirect = authorized.json()["redirectUrl"]
    assert redirect.startswith(uri + "?")
    query = parse_qs(urlparse(redirect).query)
    assert query["state"] == ["plugin-state"]
    exchange = {
        "grant_type": "authorization_code", "client_id": DSH_PLUGIN_OAUTH_CLIENT.client_id,
        "code": query["code"][0], "redirect_uri": uri, "code_verifier": verifier,
    }
    wrong_port = client.post("/oauth/token", data={**exchange, "redirect_uri": "http://127.0.0.1:42190/oauth/callback"})
    assert wrong_port.status_code == 400
    wrong_verifier = client.post("/oauth/token", data={**exchange, "code_verifier": "wrong"})
    assert wrong_verifier.status_code == 400
    received = client.post("/oauth/token", data=exchange)
    assert received.status_code == 200, received.text
    plugin_auth = bearer(received.json()["access_token"])
    assert client.get("/auth/me", headers=plugin_auth).status_code == 200
    assert client.post("/connectors", headers=plugin_auth, json={"name": "Plugin device", "installationId": str(uuid4())}).status_code == 200
    assert client.post("/oauth/token", data=exchange).status_code == 400


@pytest.mark.parametrize("uri", [
    "https://127.0.0.1:5000/oauth/callback", "http://localhost:5000/oauth/callback",
    "http://127.0.0.1:80/oauth/callback", "http://127.0.0.1:65536/oauth/callback",
    "http://127.0.0.1:5000/callback", "http://127.0.0.1:5000/oauth/callback?next=https://evil.test",
    "http://127.0.0.1:5000/oauth/callback#fragment", "http://127.0.0.1.evil.test:5000/oauth/callback",
    "http://user@127.0.0.1:5000/oauth/callback", "http://127.1:5000/oauth/callback",
    "http://127.0.0.1:5000/oauth/callback\n", "file:///oauth/callback",
])
def test_plugin_redirect_has_exact_loopback_boundary(uri):
    assert not DSH_PLUGIN_OAUTH_CLIENT.allows_redirect(uri)


def test_registration_retry_reuses_device_and_recovers_credential(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    body = {"name": "DSH local device", "installationId": str(uuid4())}
    first = client.post("/connectors", headers=bearer(token), json=body)
    assert first.status_code == 200, first.text
    second = client.post("/connectors", headers=bearer(token), json=body)
    assert second.status_code == 200, second.text
    first, second = first.json(), second.json()
    assert first["connector"]["id"] == second["connector"]["id"]
    assert first["connectorToken"] != second["connectorToken"]
    assert len(client.get("/connectors", headers=bearer(token)).json()["connectors"]) == 1
    connector_id = second["connector"]["id"]
    assert client.post("/connector/auth", headers={"Authorization": f"Connector {connector_id}:{first['connectorToken']}"}).status_code == 401
    assert client.post("/connector/auth", headers={"Authorization": f"Connector {connector_id}:{second['connectorToken']}"}).status_code == 200


def test_registration_key_is_scoped_to_account_and_target_requires_ownership(tmp_path):
    client = make_client(tmp_path)
    first_token = admin_token(client)
    client.patch("/admin/settings", headers=bearer(first_token), json={"registrationOpen": True})
    second_token = register(client, "another-user").json()["accessToken"]
    body = {"name": "Same computer", "installationId": str(uuid4())}
    first = client.post("/connectors", headers=bearer(first_token), json=body).json()["connector"]
    second = client.post("/connectors", headers=bearer(second_token), json=body).json()["connector"]
    assert first["id"] != second["id"]
    assert client.get(f"/connectors/{first['id']}", headers=bearer(second_token)).status_code == 404


def test_registration_without_key_keeps_existing_create_behavior(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    ids = [client.post("/connectors", headers=bearer(token), json={"name": "CLI"}).json()["connector"]["id"] for _ in range(2)]
    assert ids[0] != ids[1]


def test_registration_retry_cannot_revive_a_deleted_installation(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    body = {"name": "Deleted device", "installationId": str(uuid4())}
    connector_id = client.post("/connectors", headers=bearer(token), json=body).json()["connector"]["id"]
    assert client.delete(f"/connectors/{connector_id}", headers=bearer(token)).status_code == 204
    assert client.post("/connectors", headers=bearer(token), json=body).status_code == 409
    assert client.get("/connectors", headers=bearer(token)).json()["connectors"] == []
