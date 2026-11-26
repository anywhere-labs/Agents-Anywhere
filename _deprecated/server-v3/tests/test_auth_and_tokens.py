from __future__ import annotations

import base64
import hashlib

import httpx

from aa_control.core.auth import hash_password, verify_password


async def test_v2_password_hash_compatibility() -> None:
    # Exact format produced by v2 server/agent_server/core/auth.py
    salt = "fixed_v2_salt_123"
    digest = hashlib.pbkdf2_hmac("sha256", b"super-secret-pw", salt.encode("utf-8"), 1_000)
    v2_stored = f"pbkdf2_sha256${salt}${base64.urlsafe_b64encode(digest).decode('ascii').rstrip('=')}"
    assert verify_password("super-secret-pw", v2_stored, iterations=1_000)
    assert not verify_password("wrong", v2_stored, iterations=1_000)
    assert hash_password("super-secret-pw", salt=salt, iterations=1_000) == v2_stored


async def test_register_login_refresh_rotation_and_logout(http_client: httpx.AsyncClient) -> None:
    cfg = (await http_client.get("/auth/config")).json()
    assert cfg["needs_bootstrap"] is True

    # First user becomes admin
    reg = await http_client.post(
        "/auth/register",
        json={"email": "alice@example.com", "password": "password123", "display_name": "Alice", "client_platform": "ios"},
    )
    assert reg.status_code == 200
    data = reg.json()
    assert data["user"]["role"] == "admin"
    assert data["refresh_token"].startswith("aart_")

    # /auth/me works
    me = await http_client.get("/auth/me", headers={"Authorization": f"Bearer {data['access_token']}"})
    assert me.status_code == 200
    assert me.json()["email"] == "alice@example.com"

    # Login works
    login = await http_client.post(
        "/auth/login",
        json={"email": "ALICE@example.com", "password": "password123", "client_id": data["client_id"]},
    )
    assert login.status_code == 200

    # Refresh rotates token; old refresh token can no longer be reused
    old_rt = data["refresh_token"]
    ref = await http_client.post("/auth/refresh", json={"refresh_token": old_rt})
    assert ref.status_code == 200
    new_rt = ref.json()["refresh_token"]
    assert new_rt != old_rt

    replay = await http_client.post("/auth/refresh", json={"refresh_token": old_rt})
    assert replay.status_code == 401

    # Logout revokes new refresh token
    out = await http_client.post("/auth/logout", json={"refresh_token": new_rt})
    assert out.status_code == 200
    after_out = await http_client.post("/auth/refresh", json={"refresh_token": new_rt})
    assert after_out.status_code == 401


async def test_client_and_device_router_token_issuance_and_rate_limit(
    app,
    http_client: httpx.AsyncClient,
) -> None:
    reg = (
        await http_client.post(
            "/auth/register",
            json={"email": "bob@example.com", "password": "password123"},
        )
    ).json()
    headers = {"Authorization": f"Bearer {reg['access_token']}"}

    # Client Router token carries user:<uid>/client:<cid>
    ctok = await http_client.post(
        "/auth/router-token",
        headers=headers,
        json={"client_id": "cli_mac_1", "platform": "desktop"},
    )
    assert ctok.status_code == 200
    body = ctok.json()
    assert body["principal"] == f"user:{reg['user']['id']}/client:cli_mac_1"
    assert len(body["tokens"]) == 1
    assert body["tokens"][0]["token"].startswith("mt_client_")

    # Register device and exchange secret for device Router token
    dev_reg = (
        await http_client.post(
            "/devices/register",
            headers=headers,
            json={"name": "Workstation", "platform": "linux", "mode_hint": "normal"},
        )
    ).json()
    device_id = dev_reg["device"]["id"]
    device_secret = dev_reg["device_secret"]
    assert device_secret.startswith("aadev_")

    dtok = await http_client.post(
        "/devices/router-token",
        json={"device_id": device_id, "device_secret": device_secret},
    )
    assert dtok.status_code == 200
    assert dtok.json()["principal"] == f"device:{device_id}"

    # Wrong device secret rejected
    bad = await http_client.post(
        "/devices/router-token",
        json={"device_id": device_id, "device_secret": "aadev_wrong_secret_value"},
    )
    assert bad.status_code == 401

    # Rate limit enforcement
    app.state.settings = app.state.settings.__class__(
        **{**app.state.settings.__dict__, "token_issue_rate_limit_per_min": 2}
    )
    app.state.auth_service._settings = app.state.settings
    r1 = await http_client.post("/auth/router-token", headers=headers, json={"client_id": "cli_mac_1", "platform": "desktop"})
    r2 = await http_client.post("/auth/router-token", headers=headers, json={"client_id": "cli_mac_1", "platform": "desktop"})
    assert r1.status_code == 200
    assert r2.status_code == 429
