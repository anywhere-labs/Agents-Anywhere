"""Behavioral coverage of the email identity cutover and verification policy."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from agent_server.core.auth import create_user_access_token
from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.repositories import email_accounts
from agent_server.services.email_delivery import EmailDeliveryError
from agent_server.services.oauth import OAuthIdentity, create_pending_token
from sqlalchemy import create_engine, text
from test_auth import admin_token, bearer, make_client, password_verifier, register


@pytest.fixture
def email_env(tmp_path, monkeypatch):
    client = make_client(tmp_path)
    admin = admin_token(client)
    clock = [1_900_000_000]
    monkeypatch.setattr(email_accounts, "time", SimpleNamespace(time=lambda: clock[0]))
    sent = []

    async def deliver(_db, email, code):
        sent.append((email, code))

    monkeypatch.setattr("agent_server.api.auth.send_verification_email", deliver)
    response = client.patch(
        "/admin/settings",
        headers=bearer(admin),
        json={
            "registrationOpen": True,
            "email": {
                "enabled": True,
                "apiKey": "re_example",
                "fromAddress": "test@example.test",
            },
        },
    )
    assert response.status_code == 200, response.text
    return client, admin, sent, clock


def code_request(client, email, *, token=None, purpose="register", **kwargs):
    return client.post(
        "/auth/email-code",
        headers=bearer(token) if token else {},
        json={
            "email": email,
            "purpose": purpose,
            **kwargs,
        },
    )


def email_register(client, email, *, code=None, name="Example"):
    return client.post(
        "/auth/register",
        json={
            "email": email,
            "displayName": name,
            "password": "secret",
            "code": code,
        },
    )


def test_disabled_verification_trusts_email_and_keeps_identity_on_rebind(tmp_path):
    client = make_client(tmp_path)
    created = register(client, "Admin@Example.Test").json()
    token = created["accessToken"]
    assert created["email"] == "admin@example.test"
    assert created["emailVerified"] is True
    rebound = client.put(
        "/auth/me/email", headers=bearer(token), json={"email": " New@Example.Test "}
    )
    assert rebound.status_code == 200, rebound.text
    assert rebound.json()["userId"] == created["userId"]
    assert rebound.json()["email"] == "new@example.test"
    assert rebound.json()["emailVerified"] is True
    assert (
        client.post(
            "/auth/login", json={"email": "admin@example.test", "password": "secret"}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/auth/login", json={"userId": created["userId"], "password": "secret"}
        ).status_code
        == 422
    )
    salt = client.post(
        "/auth/password-salt", json={"email": "NEW@example.test"}
    ).json()["salt"]
    logged = client.post(
        "/auth/login",
        json={
            "email": "new@example.test",
            "passwordVerifier": password_verifier("secret", salt),
        },
    )
    assert logged.status_code == 200
    assert logged.json()["userId"] == created["userId"]
    profile = client.put(
        "/auth/me/profile", headers=bearer(token), json={"displayName": "  新昵称  "}
    )
    assert profile.json()["displayName"] == "新昵称"
    assert profile.json()["email"] == "new@example.test"
    assert (
        client.put(
            "/auth/me/profile", headers=bearer(token), json={"displayName": "  "}
        ).status_code
        == 422
    )


def test_old_account_is_not_converted_or_login_compatible(tmp_path):
    client = make_client(tmp_path)
    old = asyncio.run(
        client.app.state.store.create_user(user_id="old_user", password="secret")
    )
    assert old.email is None
    assert old.displayName == ""
    assert (
        client.post(
            "/auth/login", json={"userId": "old_user", "password": "secret"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/auth/login", json={"email": "old_user", "password": "secret"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/auth/login", json={"email": "old_user@example.test", "password": "secret"}
        ).status_code
        == 401
    )
    assert asyncio.run(client.app.state.store.get_user("old_user")).email is None


def test_registration_requires_code_and_consumes_it_once(email_env):
    client, _admin, sent, _clock = email_env
    email = "member@example.test"
    assert email_register(client, email).status_code == 422
    assert code_request(client, email).status_code == 200
    code = sent[-1][1]
    assert email_register(client, email, code="wrong").status_code == 422
    created = email_register(client, email, code=code)
    assert created.status_code == 200, created.text
    assert created.json()["emailVerified"] is True
    assert email_register(client, email, code=code).status_code == 422
    assert asyncio.run(client.app.state.store.count_users()) == 2


def test_email_code_is_scoped_to_address_purpose_and_authenticated_user(email_env):
    client, admin, sent, _clock = email_env
    email = "new@example.test"
    assert code_request(client, email, purpose="bind").status_code == 401
    assert code_request(client, email).status_code == 200
    code = sent[-1][1]
    assert email_register(client, "other@example.test", code=code).status_code == 422
    assert (
        client.put(
            "/auth/me/email", headers=bearer(admin), json={"email": email, "code": code}
        ).status_code
        == 422
    )
    assert code_request(client, email, purpose="bind", token=admin).status_code == 200
    bind_code = sent[-1][1]
    other = asyncio.run(
        client.app.state.store.create_email_user(
            email="other@example.test", display_name="Other", password="secret"
        )
    )
    other_token = create_user_access_token(other.userId)
    assert (
        client.put(
            "/auth/me/email",
            headers=bearer(other_token),
            json={"email": email, "code": bind_code},
        ).status_code
        == 422
    )
    before = client.get("/auth/me", headers=bearer(admin)).json()
    assert before["email"] == "user1@example.test"
    bound = client.put(
        "/auth/me/email",
        headers=bearer(admin),
        json={"email": email, "code": bind_code},
    )
    assert bound.status_code == 200, bound.text
    assert bound.json()["userId"] == before["userId"]
    assert bound.json()["displayName"] == before["displayName"]
    assert (
        client.put(
            "/auth/me/email",
            headers=bearer(admin),
            json={"email": email, "code": bind_code},
        ).status_code
        == 422
    )


def test_expiration_resend_cooldown_and_old_code_invalidation(email_env):
    client, _admin, sent, clock = email_env
    email = "member@example.test"
    assert code_request(client, email).status_code == 200
    old_code = sent[-1][1]
    assert code_request(client, email).status_code == 429
    clock[0] += 61
    assert code_request(client, email).status_code == 200
    new_code = sent[-1][1]
    if old_code != new_code:
        assert email_register(client, email, code=old_code).status_code == 422
    clock[0] += 600
    assert email_register(client, email, code=new_code).status_code == 422


def test_incorrect_attempt_budget_survives_resend(email_env):
    client, _admin, sent, clock = email_env
    email = "member@example.test"
    assert code_request(client, email).status_code == 200
    for _ in range(3):
        assert email_register(client, email, code="bad").status_code == 422
    clock[0] += 61
    assert code_request(client, email).status_code == 200
    for _ in range(2):
        assert email_register(client, email, code="bad").status_code == 422
    assert email_register(client, email, code=sent[-1][1]).status_code == 422
    clock[0] += 61
    assert code_request(client, email).status_code == 429
    clock[0] += 3600
    assert code_request(client, email).status_code == 200
    assert email_register(client, email, code=sent[-1][1]).status_code == 200


def test_send_limits_cover_email_and_client_ip(email_env):
    client, _admin, _sent, clock = email_env
    for _ in range(10):
        assert code_request(client, "repeated@example.test").status_code == 200
        clock[0] += 61
    assert code_request(client, "repeated@example.test").status_code == 429
    for index in range(20):
        assert code_request(client, f"person{index}@example.test").status_code == 200
    assert code_request(client, "over-limit@example.test").status_code == 429


def test_delivery_failure_never_leaves_usable_code(email_env, monkeypatch):
    client, _admin, sent, _clock = email_env

    async def fail(_db, email, code):
        sent.append((email, code))
        raise EmailDeliveryError("sensitive upstream response")

    monkeypatch.setattr("agent_server.api.auth.send_verification_email", fail)
    response = code_request(client, "failed@example.test")
    assert response.status_code == 502
    assert "sensitive" not in response.text
    assert (
        email_register(client, "failed@example.test", code=sent[-1][1]).status_code
        == 422
    )


def test_settings_mask_key_validate_enable_and_restrict_members(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    assert (
        client.patch(
            "/admin/settings", headers=bearer(admin), json={"email": {"enabled": True}}
        ).status_code
        == 422
    )
    configured = client.patch(
        "/admin/settings",
        headers=bearer(admin),
        json={
            "registrationOpen": True,
            "email": {
                "apiKey": "re_private",
                "fromAddress": "Example <test@example.test>",
            },
        },
    )
    assert configured.status_code == 200
    assert "re_private" not in configured.text
    assert configured.json()["email"]["apiKeyConfigured"] is True
    member = register(client, "member").json()["accessToken"]
    assert client.get("/admin/settings", headers=bearer(member)).status_code == 403
    assert (
        client.patch(
            "/admin/settings", headers=bearer(member), json={"email": {"enabled": True}}
        ).status_code
        == 403
    )
    assert (
        client.patch(
            "/admin/settings",
            headers=bearer(admin),
            json={"email": {"enabled": True, "apiKey": ""}},
        ).status_code
        == 200
    )
    assert client.get("/auth/config").json()["emailVerificationRequired"] is True
    settings = client.get("/admin/settings", headers=bearer(admin))
    assert "re_private" not in settings.text
    assert (
        client.patch(
            "/admin/settings",
            headers=bearer(admin),
            json={"email": {"clearApiKey": True}},
        ).status_code
        == 422
    )
    disabled = client.patch(
        "/admin/settings",
        headers=bearer(admin),
        json={"email": {"enabled": False, "clearApiKey": True}},
    )
    assert disabled.status_code == 200
    assert disabled.json()["email"]["apiKeyConfigured"] is False


def test_admin_creation_obeys_verification_even_when_registration_closed(email_env):
    client, admin, sent, _clock = email_env
    client.patch(
        "/admin/settings", headers=bearer(admin), json={"registrationOpen": False}
    )
    payload = {
        "email": "managed@example.test",
        "displayName": "Managed",
        "password": "secret",
    }
    assert (
        client.post("/admin/users", headers=bearer(admin), json=payload).status_code
        == 422
    )
    assert code_request(client, payload["email"]).status_code == 403
    assert code_request(client, payload["email"], token=admin).status_code == 200
    created = client.post(
        "/admin/users", headers=bearer(admin), json={**payload, "code": sent[-1][1]}
    )
    assert created.status_code == 201, created.text
    assert created.json()["emailVerified"] is True


def test_oauth_email_claim_does_not_bypass_enabled_verification(email_env):
    client, admin, sent, _clock = email_env
    client.patch(
        "/admin/settings",
        headers=bearer(admin),
        json={"registrationOpen": False, "oauthRegistrationOpen": True},
    )
    pending = create_pending_token(
        OAuthIdentity(
            provider="oidc",
            provider_label="Example",
            subject="subject-new",
            suggested_user_id="providername",
            email="oauth@example.test",
            display_name="Provider Name",
        )
    )
    payload = {
        "pendingToken": pending,
        "email": "oauth@example.test",
        "displayName": "My Name",
    }
    assert client.post("/auth/oauth/finalize", json=payload).status_code == 422
    assert (
        code_request(client, payload["email"], pendingToken=pending).status_code == 200
    )
    response = client.post(
        "/auth/oauth/finalize", json={**payload, "code": sent[-1][1]}
    )
    assert response.status_code == 200, response.text
    auth = response.json()["auth"]
    assert auth["emailVerified"] is True
    assert auth["displayName"] == "My Name"
    repeated = client.post("/auth/oauth/finalize", json={"pendingToken": pending})
    assert repeated.status_code == 200
    assert repeated.json()["auth"]["userId"] == auth["userId"]


def test_oauth_binding_conflict_rolls_back_new_account(tmp_path):
    client = make_client(tmp_path)
    store = client.app.state.store
    oauth = {
        "provider": "oidc",
        "subject": "same",
        "email": "provider@example.test",
        "display_name": "Provider",
    }
    asyncio.run(
        store.create_email_user(
            email="first@example.test",
            display_name="First",
            password="secret",
            oauth_account=oauth,
        )
    )
    with pytest.raises(ValueError):
        asyncio.run(
            store.create_email_user(
                email="second@example.test",
                display_name="Second",
                password="secret",
                oauth_account=oauth,
            )
        )
    assert asyncio.run(store.count_users()) == 1
    assert asyncio.run(store.user_for_email("second@example.test")) is None


def test_schema_upgrade_preserves_old_identifiers_without_backfill(tmp_path):
    path = tmp_path / "old.sqlite3"
    url = f"sqlite+aiosqlite:///{path}"
    upgrade_database(db_url=url, revision="v2_24")
    engine = create_engine(f"sqlite:///{path}")
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,password_hash,role,disabled,created_at,updated_at) VALUES ('old_user','hash','admin',0,'before','before')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO oauth_accounts (provider,subject,user_id,email,display_name,created_at,updated_at) VALUES ('oidc','sub','old_user','untrusted@example.test','Provider','before','before')"
            )
        )
    upgrade_database(db_url=url)
    with engine.connect() as conn:
        row = conn.execute(
            text(
                "SELECT id,email,email_verified_at,display_name,password_hash FROM users"
            )
        ).one()
        assert tuple(row) == ("old_user", None, None, "", "hash")
        assert conn.execute(text("SELECT user_id,email FROM oauth_accounts")).one() == (
            "old_user",
            "untrusted@example.test",
        )
    engine.dispose()


def test_concurrent_code_consumption_allows_only_one_binding(email_env):
    client, admin, sent, _clock = email_env
    email = "concurrent@example.test"
    assert code_request(client, email, purpose="bind", token=admin).status_code == 200
    code = sent[-1][1]
    account_id = client.get("/auth/me", headers=bearer(admin)).json()["userId"]

    async def bind_twice():
        return await asyncio.gather(
            *[
                client.app.state.store.bind_user_email(
                    account_id,
                    email=email,
                    verification_code=code,
                    require_verification=True,
                )
                for _ in range(2)
            ],
            return_exceptions=True,
        )

    results = asyncio.run(bind_twice())
    assert sum(not isinstance(result, Exception) for result in results) == 1
    assert (
        sum(
            isinstance(result, email_accounts.EmailVerificationError)
            for result in results
        )
        == 1
    )
    assert client.get("/auth/me", headers=bearer(admin)).json()["email"] == email
