from __future__ import annotations

import base64
import hashlib
import json

import httpx

from aa_control.core.models import PresenceReport, RegisterDeviceRequest
from aa_control.core.utc import utc_now_iso


async def test_authorize_without_web_origin_stays_bearer_only_json(http_client: httpx.AsyncClient) -> None:
    asm = (await http_client.get("/.well-known/oauth-authorization-server")).json()
    assert asm["authorization_endpoint"] == "https://aa.example.test/oauth/authorize"
    res = await http_client.get(
        "/oauth/authorize",
        params={"client_id": "c", "redirect_uri": "http://127.0.0.1/cb"},
        follow_redirects=False,
    )
    assert res.status_code == 401
    assert res.json()["code"] == "unauthenticated"


def _pkce_pair() -> tuple[str, str]:
    verifier = "v" * 64
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode("ascii").rstrip("=")
    return verifier, challenge


async def test_mcp_oauth21_flow_tools_and_encrypted_isolation(
    app,
    http_client: httpx.AsyncClient,
    router_pool,
) -> None:
    # 1. Discovery metadata
    prm = await http_client.get("/.well-known/oauth-protected-resource")
    assert prm.status_code == 200
    assert prm.json()["resource"] == "https://aa.example.test/mcp"

    asm = await http_client.get("/.well-known/oauth-authorization-server")
    assert asm.status_code == 200
    assert asm.json()["registration_endpoint"] == "https://aa.example.test/oauth/register"

    # Unauthenticated /mcp returns 401 with WWW-Authenticate resource_metadata
    unauth = await http_client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert unauth.status_code == 401
    assert "resource_metadata=" in unauth.headers["www-authenticate"]

    # 2. Create user + one normal device + one encrypted device
    reg = (
        await http_client.post("/auth/register", json={"email": "mcp@example.com", "password": "password123"})
    ).json()
    user_headers = {"Authorization": f"Bearer {reg['access_token']}"}
    user_id = reg["user"]["id"]

    norm = (
        await app.state.device_service.register_device(
            user_id=user_id,
            req=RegisterDeviceRequest(name="NormalMac", platform="macos", mode_hint="normal"),
            actor=f"user:{user_id}",
        )
    ).device
    enc = (
        await app.state.device_service.register_device(
            user_id=user_id,
            req=RegisterDeviceRequest(name="EncryptedBox", platform="linux", mode_hint="encrypted"),
            actor=f"user:{user_id}",
        )
    ).device
    for dev in (norm, enc):
        await app.state.device_service.handle_presence_report(
            authenticated_device_id=dev.id,
            report=PresenceReport(
                device_id=dev.id,
                platform=dev.platform,
                connector_version="3.0.0",
                mode_hint=dev.mode_hint,
                sent_at=utc_now_iso(),
            ),
        )

    # 3. Dynamic Client Registration (RFC 7591)
    dcr = await http_client.post(
        "/oauth/register",
        json={"client_name": "Claude Desktop", "redirect_uris": ["http://127.0.0.1:4321/callback"]},
    )
    assert dcr.status_code == 201
    client_id = dcr.json()["client_id"]

    # 4. Consent preview: approvals:answer is NOT checked by default, encrypted devices excluded!
    preview = (
        await http_client.get(
            "/oauth/authorize",
            headers=user_headers,
            params={
                "client_id": client_id,
                "redirect_uri": "http://127.0.0.1:4321/callback",
                "scope": "devices:read sessions:read sessions:write approvals:answer",
            },
        )
    ).json()
    scope_map = {s["scope"]: s for s in preview["scopes"]}
    assert scope_map["devices:read"]["default_checked"] is True
    assert scope_map["approvals:answer"]["default_checked"] is False
    assert scope_map["approvals:answer"]["high_risk"] is True
    assert [d["id"] for d in preview["eligible_devices"]] == [norm.id]

    # Attempting to grant an encrypted device fails
    verifier, challenge = _pkce_pair()
    bad_approve = await http_client.post(
        "/oauth/authorize",
        headers=user_headers,
        json={
            "client_id": client_id,
            "redirect_uri": "http://127.0.0.1:4321/callback",
            "code_challenge": challenge,
            "scopes": ["devices:read"],
            "device_ids": [enc.id],
        },
    )
    assert bad_approve.status_code == 403

    # Approve WITHOUT approvals:answer first
    approved = await http_client.post(
        "/oauth/authorize",
        headers=user_headers,
        json={
            "client_id": client_id,
            "redirect_uri": "http://127.0.0.1:4321/callback",
            "code_challenge": challenge,
            "state": "xyz",
            "scopes": ["devices:read", "sessions:read", "sessions:write"],
            "device_ids": [norm.id],
        },
    )
    assert approved.status_code == 200
    code = approved.json()["code"]

    # Exchange code with PKCE verifier
    tok = await http_client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "redirect_uri": "http://127.0.0.1:4321/callback",
            "code_verifier": verifier,
        },
    )
    assert tok.status_code == 200
    mcp_token = tok.json()["access_token"]
    grant_id = tok.json()["grant_id"]
    mcp_headers = {"Authorization": f"Bearer {mcp_token}"}

    # Replaying auth code fails
    replay = await http_client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "redirect_uri": "http://127.0.0.1:4321/callback",
            "code_verifier": verifier,
        },
    )
    assert replay.status_code == 401

    # 5. MCP initialize & tools/list (answer_approval hidden because scope not granted)
    init = (await http_client.post("/mcp", headers=mcp_headers, json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})).json()
    assert init["result"]["serverInfo"]["name"] == "agents-anywhere-v3"

    tools_resp = (await http_client.post("/mcp", headers=mcp_headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})).json()
    tool_names = {t["name"] for t in tools_resp["result"]["tools"]}
    assert "list_devices" in tool_names
    assert "send_message" in tool_names
    assert "answer_approval" not in tool_names

    # 6. list_devices excludes encrypted device
    ld = (
        await http_client.post(
            "/mcp",
            headers=mcp_headers,
            json={"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_devices", "arguments": {}}},
        )
    ).json()
    assert [d["id"] for d in ld["result"]["structuredContent"]["devices"]] == [norm.id]

    # 7. send_message passes aa-via=mcp & aa-mcp-client, and audit log stores NO prompt content!
    async def mock_sessions(method, payload, meta):
        assert meta["aa-via"] == "mcp"
        assert meta["aa-mcp-client"] == "Claude Desktop"
        return {"ok": True, "session_id": payload.get("session_id", "s1")}

    router_pool.session_handlers[norm.id] = mock_sessions
    send_resp = (
        await http_client.post(
            "/mcp",
            headers=mcp_headers,
            json={
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "send_message",
                    "arguments": {"device_id": norm.id, "session_id": "s1", "text": "TOP SECRET MESSAGE"},
                },
            },
        )
    ).json()
    assert send_resp["result"]["isError"] is False

    audits = await app.state.repo.list_audit_logs(user_id)
    assert all("TOP SECRET MESSAGE" not in json.dumps(a) for a in audits)
    assert any(a["action"] == "mcp.send_message" and a["device_id"] == norm.id and a["session_id"] == "s1" for a in audits)

    # Calling answer_approval without approvals:answer scope returns JSON-RPC permission error
    denied_appr = (
        await http_client.post(
            "/mcp",
            headers=mcp_headers,
            json={
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "answer_approval",
                    "arguments": {"device_id": norm.id, "session_id": "s1", "approval_id": "ap1", "decision": "approve"},
                },
            },
        )
    ).json()
    assert denied_appr["error"]["code"] == -32003

    # Calling send_message on encrypted device is rejected
    denied_enc = (
        await http_client.post(
            "/mcp",
            headers=mcp_headers,
            json={
                "jsonrpc": "2.0",
                "id": 6,
                "method": "tools/call",
                "params": {
                    "name": "send_message",
                    "arguments": {"device_id": enc.id, "session_id": "s1", "text": "nope"},
                },
            },
        )
    ).json()
    assert denied_enc["error"]["code"] == -32003

    # 8. Revoking grant immediately invalidates MCP token
    rev = await http_client.delete(f"/mcp/grants/{grant_id}", headers=user_headers)
    assert rev.status_code == 200 and rev.json()["ok"] is True
    after_rev = await http_client.post("/mcp", headers=mcp_headers, json={"jsonrpc": "2.0", "id": 7, "method": "tools/list"})
    assert after_rev.status_code == 401
