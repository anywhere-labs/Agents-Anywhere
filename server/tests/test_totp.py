"""Authenticator-app two-step verification for password sign-in."""

from __future__ import annotations

import asyncio
from urllib.parse import parse_qs, urlparse

import pytest
from agent_server.core.totp import (
    code_at_step,
    current_step,
    generate_secret,
    matching_step,
    provisioning_uri,
)
from conftest import ApiV2TestClient as TestClient
from conftest import make_test_client

pytestmark = pytest.mark.usefixtures("server_secret")


def register_admin(client: TestClient, name: str = "owner", password: str = "secret") -> str:
    body = {"email": f"{name}@example.test", "displayName": name, "password": password}
    if client.get("/auth/config").json()["needsBootstrap"]:
        body["setupToken"] = client.app.state.setup_token.peek()
    response = client.post("/auth/register", json=body)
    assert response.status_code == 200, response.text
    return response.json()["accessToken"]


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def enable_totp(client: TestClient, token: str) -> tuple[str, list[str]]:
    setup = client.post("/auth/totp/setup", headers=bearer(token))
    assert setup.status_code == 200, setup.text
    secret = setup.json()["secret"]
    enabled = client.post(
        "/auth/totp/enable",
        headers=bearer(token),
        json={"code": code_at_step(secret, current_step())},
    )
    assert enabled.status_code == 200, enabled.text
    return secret, enabled.json()["recoveryCodes"]


def password_login(client: TestClient, name: str = "owner", password: str = "secret"):
    return client.post("/auth/login", json={"email": f"{name}@example.test", "password": password})


def forget_last_step(client: TestClient, user_email: str = "owner@example.test") -> None:
    """Let the next test code reuse the current period, as if 30 seconds passed."""
    store = client.app.state.store
    user = asyncio.run(store.user_for_email(user_email))

    async def reset() -> None:
        from agent_server.infra.db.schema import user_totp
        from sqlalchemy import update

        async with store._engine.begin() as conn:
            await conn.execute(
                update(user_totp)
                .where(user_totp.c.user_id == user.userId)
                .values(last_used_step=current_step() - 2)
            )

    asyncio.run(reset())


def test_totp_codes_follow_rfc6238_reference_vector() -> None:
    # RFC 6238 appendix B, SHA-1, T = 59 seconds -> 94287082 (8 digits); 6 digits keep the tail.
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    assert code_at_step(secret, 59 // 30) == "287082"
    assert matching_step(secret, "287082", now=59) == 1
    assert matching_step(secret, "287082", now=59, after_step=1) is None
    assert matching_step(secret, "28708", now=59) is None


def test_provisioning_uri_is_readable_by_authenticator_apps() -> None:
    secret = generate_secret()
    uri = urlparse(provisioning_uri(secret, account="a@example.test", issuer="Agents Anywhere"))
    query = parse_qs(uri.query)
    assert uri.scheme == "otpauth" and uri.netloc == "totp"
    assert query["secret"] == [secret]
    assert query["issuer"] == ["Agents Anywhere"]
    assert query["digits"] == ["6"] and query["period"] == ["30"]


def test_sign_in_is_unchanged_until_setup_is_confirmed(tmp_path) -> None:
    client = make_test_client()
    token = register_admin(client)
    assert client.get("/auth/totp", headers=bearer(token)).json()["enabled"] is False

    setup = client.post("/auth/totp/setup", headers=bearer(token))
    assert setup.status_code == 200
    assert setup.json()["otpauthUri"].startswith("otpauth://totp/")
    status = client.get("/auth/totp", headers=bearer(token)).json()
    assert status["enabled"] is False and status["pendingSetup"] is True
    assert password_login(client).status_code == 200

    wrong = client.post("/auth/totp/enable", headers=bearer(token), json={"code": "000000"})
    assert wrong.status_code == 401
    assert wrong.json()["detail"]["code"] == "totp_invalid_code"

    assert client.delete("/auth/totp/setup", headers=bearer(token)).status_code == 204
    assert client.get("/auth/totp", headers=bearer(token)).json()["pendingSetup"] is False


def test_password_sign_in_requires_a_code_once_enabled(tmp_path) -> None:
    client = make_test_client()
    token = register_admin(client)
    secret, recovery_codes = enable_totp(client, token)
    assert len(recovery_codes) == 10
    assert client.get("/auth/totp", headers=bearer(token)).json() | {"serverTime": None} == {
        "enabled": True,
        "pendingSetup": False,
        "recoveryCodesRemaining": 10,
        "serverTime": None,
    }

    first = password_login(client)
    assert first.status_code == 401
    detail = first.json()["detail"]
    assert detail["code"] == "totp_required"
    assert "accessToken" not in first.json()
    challenge = detail["challengeToken"]

    # The code that confirmed setup cannot be replayed in the same period.
    replay = client.post(
        "/auth/login/totp",
        json={"challengeToken": challenge, "code": code_at_step(secret, current_step())},
    )
    assert replay.status_code == 401

    forget_last_step(client)
    ok = client.post(
        "/auth/login/totp",
        json={"challengeToken": challenge, "code": code_at_step(secret, current_step())},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["accessToken"]

    # Wrong password still fails before any code is asked for.
    wrong_password = password_login(client, password="nope")
    assert wrong_password.status_code == 401
    assert wrong_password.json()["detail"] == "invalid credentials"


def test_challenge_tokens_cannot_be_forged(tmp_path) -> None:
    client = make_test_client()
    register_admin(client)
    response = client.post("/auth/login/totp", json={"challengeToken": "forged.token", "code": "123456"})
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "totp_challenge_expired"


def test_recovery_codes_work_once(tmp_path) -> None:
    client = make_test_client()
    token = register_admin(client)
    _, recovery_codes = enable_totp(client, token)
    code = recovery_codes[0]

    challenge = password_login(client).json()["detail"]["challengeToken"]
    ok = client.post("/auth/login/totp", json={"challengeToken": challenge, "code": code.upper()})
    assert ok.status_code == 200, ok.text

    challenge = password_login(client).json()["detail"]["challengeToken"]
    reused = client.post("/auth/login/totp", json={"challengeToken": challenge, "code": code})
    assert reused.status_code == 401
    assert client.get("/auth/totp", headers=bearer(token)).json()["recoveryCodesRemaining"] == 9


def test_too_many_wrong_codes_lock_sign_in(tmp_path) -> None:
    client = make_test_client()
    token = register_admin(client)
    secret, _ = enable_totp(client, token)
    challenge = password_login(client).json()["detail"]["challengeToken"]
    statuses = [
        client.post("/auth/login/totp", json={"challengeToken": challenge, "code": "000000"}).status_code
        for _ in range(5)
    ]
    assert statuses == [401, 401, 401, 401, 429]

    forget_last_step(client)
    locked = client.post(
        "/auth/login/totp",
        json={"challengeToken": challenge, "code": code_at_step(secret, current_step())},
    )
    assert locked.status_code == 429
    assert locked.json()["detail"]["code"] == "totp_locked"
    assert int(locked.headers["Retry-After"]) > 0


def test_disable_and_regenerate_require_a_valid_code(tmp_path) -> None:
    client = make_test_client()
    token = register_admin(client)
    secret, old_codes = enable_totp(client, token)

    assert client.post("/auth/totp/disable", headers=bearer(token), json={"code": "000000"}).status_code == 401
    regenerated = client.post(
        "/auth/totp/recovery-codes", headers=bearer(token), json={"code": old_codes[0]}
    )
    assert regenerated.status_code == 200
    new_codes = regenerated.json()["recoveryCodes"]
    assert set(new_codes).isdisjoint(old_codes)

    forget_last_step(client)
    disabled = client.post(
        "/auth/totp/disable",
        headers=bearer(token),
        json={"code": code_at_step(secret, current_step())},
    )
    assert disabled.status_code == 204
    assert password_login(client).status_code == 200


def test_setup_cannot_replace_an_enabled_secret(tmp_path) -> None:
    client = make_test_client()
    token = register_admin(client)
    enable_totp(client, token)
    again = client.post("/auth/totp/setup", headers=bearer(token))
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "totp_already_enabled"


@pytest.mark.parametrize("as_admin", [True, False])
def test_only_admins_can_reset_another_users_totp(tmp_path, as_admin: bool) -> None:
    client = make_test_client()
    admin = register_admin(client)
    client.patch("/admin/settings", headers=bearer(admin), json={"registrationOpen": True})
    member = client.post(
        "/auth/register",
        json={"email": "member@example.test", "displayName": "member", "password": "secret"},
    ).json()["accessToken"]
    enable_totp(client, member)
    member_id = asyncio.run(client.app.state.store.user_for_email("member@example.test")).userId

    response = client.delete(
        f"/admin/users/{member_id}/totp", headers=bearer(admin if as_admin else member)
    )
    if as_admin:
        assert response.status_code == 204
        assert password_login(client, "member").status_code == 200
    else:
        assert response.status_code == 403
        assert password_login(client, "member").status_code == 401
