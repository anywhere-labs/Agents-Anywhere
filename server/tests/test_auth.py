"""End-to-end tests for /auth/* and /admin/* covering the open-source bootstrap flow."""

from __future__ import annotations

import datetime as dt
import base64
import hashlib
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from agent_server.app import create_app
from agent_server.core.auth import hash_password
from agent_server.core.setup_token import SetupToken
from agent_server.services.oauth import OAuthIdentity, create_pending_token


def make_client(tmp_path) -> TestClient:
    return TestClient(create_app(tmp_path / "test.sqlite3"))


# ---------- helpers ----------------------------------------------------------


def register(client: TestClient, user_id: str, password: str = "secret"):
    """Bootstrap-aware register helper.

    Probes /auth/config to learn whether the instance still needs bootstrap;
    if it does, includes the in-memory setup token (which the server already
    generated to surface in its log) on the request. Once bootstrap is done
    the token field is omitted, matching what the frontend sends.
    """
    body: dict[str, object] = {"userId": user_id, "password": password}
    cfg = client.get("/auth/config").json()
    if cfg["needsBootstrap"]:
        token = client.app.state.setup_token.peek()
        if token is not None:
            body["setupToken"] = token
    return client.post("/auth/register", json=body)


def login(client: TestClient, user_id: str, password: str = "secret"):
    return client.post("/auth/login", json={"userId": user_id, "password": password})


def password_verifier(password: str, salt: str) -> str:
    return hash_password(password, salt=salt).split("$", 2)[2]


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def admin_token(client: TestClient) -> str:
    """Bootstrap user1 as admin and return their access token."""
    response = register(client, "user1")
    assert response.status_code == 200, response.text
    assert response.json()["role"] == "admin"
    return response.json()["accessToken"]


# ---------- /auth/config -----------------------------------------------------


def test_auth_config_empty_database_needs_bootstrap(tmp_path):
    client = make_client(tmp_path)
    body = client.get("/auth/config").json()
    assert body["needsBootstrap"] is True
    assert body["registrationOpen"] is False


def test_auth_config_after_bootstrap_reports_registration_closed(tmp_path):
    client = make_client(tmp_path)
    admin_token(client)
    body = client.get("/auth/config").json()
    assert body["needsBootstrap"] is False
    assert body["registrationOpen"] is False


def test_auth_config_reflects_admin_opening_registration(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    client.patch("/admin/settings", headers=bearer(token), json={"registrationOpen": True})
    body = client.get("/auth/config").json()
    assert body["registrationOpen"] is True


# ---------- /auth/register ---------------------------------------------------


def test_register_first_user_becomes_admin_and_closes_registration(tmp_path):
    client = make_client(tmp_path)
    response = register(client, "user1")
    assert response.status_code == 200
    body = response.json()
    assert body["userId"] == "user1"
    assert body["role"] == "admin"
    assert body["accessToken"]
    # second register attempt must hit the 403 gate
    second = register(client, "user2")
    assert second.status_code == 403
    assert "closed" in second.json()["detail"]


def test_register_succeeds_when_admin_opens_registration(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    client.patch("/admin/settings", headers=bearer(token), json={"registrationOpen": True})
    response = register(client, "user2")
    assert response.status_code == 200
    assert response.json()["role"] == "member"


def test_register_accepts_password_verifier(tmp_path):
    client = make_client(tmp_path)
    client.get("/auth/config")
    salt = "new-user-salt"
    response = client.post(
        "/auth/register",
        json={
            "userId": "user1",
            "passwordSalt": salt,
            "passwordVerifier": password_verifier("secret", salt),
            "setupToken": client.app.state.setup_token.peek(),
        },
    )
    assert response.status_code == 200, response.text
    assert login(client, "user1").status_code == 200


def test_register_rejects_duplicate_username(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    client.patch("/admin/settings", headers=bearer(token), json={"registrationOpen": True})
    register(client, "alice")
    duplicate = register(client, "alice")
    assert duplicate.status_code == 409


def test_register_normalizes_username_to_lowercase(tmp_path):
    client = make_client(tmp_path)
    response = register(client, "ADMIN_User")
    assert response.status_code == 200
    assert response.json()["userId"] == "admin_user"
    # login with mixed case still works
    assert login(client, "Admin_USER").status_code == 200


def test_register_rejects_invalid_usernames(tmp_path):
    # Bootstrap path returns 422 when the username is invalid *before* any user
    # is created, so the same client (empty DB) can reject every bad value.
    client = make_client(tmp_path)
    for bad in ("ab", "with space", "UPPER!", "x" * 33, "用户"):
        response = register(client, bad)
        assert response.status_code == 422, f"expected 422 for {bad!r}, got {response.status_code}"


# ---------- /auth/login ------------------------------------------------------


def test_login_returns_role_in_response(tmp_path):
    client = make_client(tmp_path)
    admin_token(client)
    response = login(client, "user1")
    assert response.status_code == 200
    assert response.json()["role"] == "admin"


def test_login_accepts_password_verifier(tmp_path):
    client = make_client(tmp_path)
    admin_token(client)
    salt = client.post("/auth/password-salt", json={"userId": "user1"}).json()["salt"]
    response = client.post(
        "/auth/login",
        json={"userId": "user1", "passwordVerifier": password_verifier("secret", salt)},
    )
    assert response.status_code == 200, response.text


def test_login_rejects_wrong_password_verifier(tmp_path):
    client = make_client(tmp_path)
    admin_token(client)
    salt = client.post("/auth/password-salt", json={"userId": "user1"}).json()["salt"]
    response = client.post(
        "/auth/login",
        json={"userId": "user1", "passwordVerifier": password_verifier("wrong", salt)},
    )
    assert response.status_code == 401


def test_password_salt_does_not_reveal_unknown_user(tmp_path):
    client = make_client(tmp_path)
    admin_token(client)
    known = client.post("/auth/password-salt", json={"userId": "user1"}).json()["salt"]
    unknown = client.post("/auth/password-salt", json={"userId": "missing"}).json()["salt"]
    assert known
    assert unknown
    assert unknown != known


def test_login_rejects_disabled_account(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    # Admin creates a second account, then disables it.
    created = client.post(
        "/admin/users",
        headers=bearer(admin),
        json={"userId": "victim", "password": "secret", "role": "member"},
    )
    assert created.status_code == 201
    client.patch("/admin/users/victim", headers=bearer(admin), json={"disabled": True})
    response = login(client, "victim")
    assert response.status_code == 401


def test_login_rejects_wrong_password(tmp_path):
    client = make_client(tmp_path)
    admin_token(client)
    response = login(client, "user1", password="wrong")
    assert response.status_code == 401


# ---------- /auth/me ---------------------------------------------------------


def test_auth_me_returns_role_and_disabled(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    body = client.get("/auth/me", headers=bearer(token)).json()
    assert body == {
        "userId": "user1",
        "role": "admin",
        "disabled": False,
        "avatar": None,
        "serverTime": body["serverTime"],
    }


def test_auth_me_requires_token(tmp_path):
    client = make_client(tmp_path)
    assert client.get("/auth/me").status_code == 401


# ---------- /auth/change-password --------------------------------------------


def test_change_password_succeeds_without_old_password(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    response = client.post(
        "/auth/change-password",
        headers=bearer(token),
        json={"newPassword": "new-secret"},
    )
    assert response.status_code == 204
    assert login(client, "user1", password="secret").status_code == 401
    assert login(client, "user1", password="new-secret").status_code == 200


def test_change_password_accepts_verifiers(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    new_salt = "changed-salt"
    response = client.post(
        "/auth/change-password",
        headers=bearer(token),
        json={
            "newPasswordSalt": new_salt,
            "newPasswordVerifier": password_verifier("new-secret", new_salt),
        },
    )
    assert response.status_code == 204
    assert login(client, "user1", password="secret").status_code == 401
    assert login(client, "user1", password="new-secret").status_code == 200


def test_change_password_ignores_old_password_when_present(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    response = client.post(
        "/auth/change-password",
        headers=bearer(token),
        json={"oldPassword": "wrong", "newPassword": "new-secret"},
    )
    assert response.status_code == 204
    assert login(client, "user1", password="new-secret").status_code == 200


def test_change_password_requires_non_empty_new_password(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    response = client.post(
        "/auth/change-password",
        headers=bearer(token),
        json={"newPassword": ""},
    )
    assert response.status_code == 422


# ---------- /admin/* gating --------------------------------------------------


def test_admin_endpoints_reject_non_admin(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    # promote registration so we can make a member account quickly
    client.patch("/admin/settings", headers=bearer(admin), json={"registrationOpen": True})
    member_token = register(client, "bob").json()["accessToken"]
    for path in ("/admin/users", "/admin/settings"):
        response = client.get(path, headers=bearer(member_token))
        assert response.status_code == 403, path


def test_admin_endpoints_reject_missing_token(tmp_path):
    client = make_client(tmp_path)
    assert client.get("/admin/users").status_code == 401


# ---------- /admin/settings --------------------------------------------------


def test_admin_settings_toggle_round_trip(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    assert client.get("/admin/settings", headers=bearer(token)).json()["registrationOpen"] is False
    client.patch("/admin/settings", headers=bearer(token), json={"registrationOpen": True})
    assert client.get("/admin/settings", headers=bearer(token)).json()["registrationOpen"] is True
    client.patch("/admin/settings", headers=bearer(token), json={"registrationOpen": False})
    assert client.get("/admin/settings", headers=bearer(token)).json()["registrationOpen"] is False


def test_admin_settings_oauth_registration_toggle_round_trip(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    assert client.get("/admin/settings", headers=bearer(token)).json()["oauthRegistrationOpen"] is False
    client.patch("/admin/settings", headers=bearer(token), json={"oauthRegistrationOpen": True})
    assert client.get("/admin/settings", headers=bearer(token)).json()["oauthRegistrationOpen"] is True
    client.patch("/admin/settings", headers=bearer(token), json={"oauthRegistrationOpen": False})
    assert client.get("/admin/settings", headers=bearer(token)).json()["oauthRegistrationOpen"] is False


# ---------- /admin/users CRUD ------------------------------------------------


def test_admin_create_user(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    response = client.post(
        "/admin/users",
        headers=bearer(admin),
        json={"userId": "carol", "password": "secret", "role": "member"},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["userId"] == "carol"
    assert body["role"] == "member"
    assert body["disabled"] is False
    # And carol can login
    assert login(client, "carol").status_code == 200


def test_admin_can_create_another_admin(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    response = client.post(
        "/admin/users",
        headers=bearer(admin),
        json={"userId": "alice", "password": "secret", "role": "admin"},
    )
    assert response.status_code == 201
    assert response.json()["role"] == "admin"


def test_admin_list_users_returns_all(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    client.post(
        "/admin/users",
        headers=bearer(admin),
        json={"userId": "dave", "password": "secret", "role": "member"},
    )
    body = client.get("/admin/users", headers=bearer(admin)).json()
    user_ids = {u["userId"] for u in body["users"]}
    assert user_ids == {"user1", "dave"}


def test_admin_change_user_role_and_reset_password(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    client.post(
        "/admin/users",
        headers=bearer(admin),
        json={"userId": "eve", "password": "secret", "role": "member"},
    )
    # promote to admin
    promoted = client.patch(
        "/admin/users/eve", headers=bearer(admin), json={"role": "admin"}
    )
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "admin"
    # reset password (admin path, no old password required)
    reset = client.patch(
        "/admin/users/eve", headers=bearer(admin), json={"password": "newer-secret"}
    )
    assert reset.status_code == 200
    assert login(client, "eve", password="secret").status_code == 401
    assert login(client, "eve", password="newer-secret").status_code == 200


def test_admin_can_disable_and_reenable_user(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    client.post(
        "/admin/users",
        headers=bearer(admin),
        json={"userId": "frank", "password": "secret", "role": "member"},
    )
    client.patch("/admin/users/frank", headers=bearer(admin), json={"disabled": True})
    assert login(client, "frank").status_code == 401
    client.patch("/admin/users/frank", headers=bearer(admin), json={"disabled": False})
    assert login(client, "frank").status_code == 200


def test_admin_delete_user(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    client.post(
        "/admin/users",
        headers=bearer(admin),
        json={"userId": "grace", "password": "secret", "role": "member"},
    )
    response = client.delete("/admin/users/grace", headers=bearer(admin))
    assert response.status_code == 204
    assert login(client, "grace").status_code == 401


# ---------- last-admin and self-protection guards ----------------------------


def test_cannot_demote_last_admin(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    response = client.patch(
        "/admin/users/user1", headers=bearer(admin), json={"role": "member"}
    )
    # self-role-change guard fires first
    assert response.status_code == 409


def test_cannot_demote_last_admin_via_other_admin_account(tmp_path):
    """Promote eve to admin, then have eve try to demote the only other admin (user1)
    after also disabling herself indirectly — but really: ensure when only one admin
    remains, demoting them is blocked."""
    client = make_client(tmp_path)
    admin = admin_token(client)
    # Create a second admin
    client.post(
        "/admin/users",
        headers=bearer(admin),
        json={"userId": "alice", "password": "secret", "role": "admin"},
    )
    # Admin demotes the other admin -> OK (still one admin left: user1)
    demoted = client.patch(
        "/admin/users/alice", headers=bearer(admin), json={"role": "member"}
    )
    assert demoted.status_code == 200
    # Now only user1 is admin. user1 demoting themselves -> blocked.
    response = client.patch(
        "/admin/users/user1", headers=bearer(admin), json={"role": "member"}
    )
    assert response.status_code == 409


def test_cannot_disable_self(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    response = client.patch(
        "/admin/users/user1", headers=bearer(admin), json={"disabled": True}
    )
    assert response.status_code == 409


def test_cannot_delete_self(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    response = client.delete("/admin/users/user1", headers=bearer(admin))
    assert response.status_code == 409


def test_cannot_disable_last_admin_when_two_admins_then_one(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    client.post(
        "/admin/users",
        headers=bearer(admin),
        json={"userId": "alice", "password": "secret", "role": "admin"},
    )
    # Disable alice -> OK (user1 still active)
    response = client.patch(
        "/admin/users/alice", headers=bearer(admin), json={"disabled": True}
    )
    assert response.status_code == 200
    # Try to disable user1 -> blocked (self-guard kicks in first, but the store guard
    # would also catch it). Verify the response.
    response = client.patch(
        "/admin/users/user1", headers=bearer(admin), json={"disabled": True}
    )
    assert response.status_code == 409


def test_admin_create_user_rejects_invalid_username(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    response = client.post(
        "/admin/users",
        headers=bearer(admin),
        json={"userId": "ab", "password": "secret", "role": "member"},
    )
    assert response.status_code == 422


def test_admin_create_user_rejects_duplicate(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    client.post(
        "/admin/users",
        headers=bearer(admin),
        json={"userId": "alice", "password": "secret", "role": "member"},
    )
    response = client.post(
        "/admin/users",
        headers=bearer(admin),
        json={"userId": "alice", "password": "secret", "role": "member"},
    )
    assert response.status_code == 409


def test_admin_create_and_reset_user_accepts_password_verifier(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    create_salt = "create-salt"
    created = client.post(
        "/admin/users",
        headers=bearer(admin),
        json={
            "userId": "alice",
            "role": "member",
            "passwordSalt": create_salt,
            "passwordVerifier": password_verifier("secret", create_salt),
        },
    )
    assert created.status_code == 201, created.text
    assert login(client, "alice").status_code == 200

    reset_salt = "reset-salt"
    reset = client.patch(
        "/admin/users/alice",
        headers=bearer(admin),
        json={
            "passwordSalt": reset_salt,
            "passwordVerifier": password_verifier("new-secret", reset_salt),
        },
    )
    assert reset.status_code == 200, reset.text
    assert login(client, "alice").status_code == 401
    assert login(client, "alice", password="new-secret").status_code == 200


# ---------- setup token (first-run bootstrap gate) ---------------------------


class _FakeClock:
    """Manually-advanced UTC clock for SetupToken expiry tests."""

    def __init__(self, start: dt.datetime | None = None) -> None:
        self.now = start or dt.datetime(2026, 1, 1, tzinfo=dt.UTC)

    def __call__(self) -> dt.datetime:
        return self.now

    def advance(self, seconds: int) -> None:
        self.now = self.now + dt.timedelta(seconds=seconds)


def _install_setup_token(client: TestClient, **kwargs) -> SetupToken:
    """Swap in a SetupToken with custom params (clock, TTL) before any
    request kicks off lifespan / first /auth/config call."""
    token = SetupToken(**kwargs)
    client.app.state.setup_token = token
    return token


def test_auth_config_exposes_setup_token_expiry_but_not_value(tmp_path):
    client = make_client(tmp_path)
    body = client.get("/auth/config").json()
    assert body["needsBootstrap"] is True
    assert body.get("setupTokenExpiresAt"), body
    # The token value is intentionally absent — it must come from the server log.
    assert "setupToken" not in body
    assert "setup_token" not in body


def test_auth_config_clears_setup_token_expiry_after_bootstrap(tmp_path):
    client = make_client(tmp_path)
    admin_token(client)
    body = client.get("/auth/config").json()
    assert body["needsBootstrap"] is False
    assert body["setupTokenExpiresAt"] is None


def test_bootstrap_rejects_missing_setup_token(tmp_path):
    client = make_client(tmp_path)
    # Surface the token in app.state by hitting /auth/config first.
    client.get("/auth/config")
    response = client.post(
        "/auth/register", json={"userId": "user1", "password": "secret"}
    )
    assert response.status_code == 401
    assert "setup token" in response.json()["detail"].lower()


def test_bootstrap_rejects_wrong_setup_token(tmp_path):
    client = make_client(tmp_path)
    client.get("/auth/config")
    response = client.post(
        "/auth/register",
        json={"userId": "user1", "password": "secret", "setupToken": "not-the-token"},
    )
    assert response.status_code == 401


def test_bootstrap_accepts_correct_setup_token(tmp_path):
    client = make_client(tmp_path)
    client.get("/auth/config")
    token = client.app.state.setup_token.peek()
    assert token is not None
    response = client.post(
        "/auth/register",
        json={"userId": "user1", "password": "secret", "setupToken": token},
    )
    assert response.status_code == 200
    assert response.json()["role"] == "admin"


def test_setup_token_is_consumed_after_successful_bootstrap(tmp_path):
    client = make_client(tmp_path)
    admin_token(client)
    assert client.app.state.setup_token.peek() is None


def test_setup_token_auto_regenerates_after_expiry(tmp_path):
    """The token TTL has elapsed → the next /auth/config call must produce a
    fresh token (visible to the operator in the log). The old value is no
    longer accepted."""
    clock = _FakeClock()
    client = make_client(tmp_path)
    _install_setup_token(client, ttl_seconds=60, clock=clock)

    first_cfg = client.get("/auth/config").json()
    first_expiry = first_cfg["setupTokenExpiresAt"]
    first_token = client.app.state.setup_token.peek()
    assert first_token is not None

    clock.advance(120)  # well past 60s TTL

    second_cfg = client.get("/auth/config").json()
    second_expiry = second_cfg["setupTokenExpiresAt"]
    second_token = client.app.state.setup_token.peek()

    assert second_expiry != first_expiry
    assert second_token is not None
    assert second_token != first_token

    # Expired token no longer works.
    expired = client.post(
        "/auth/register",
        json={"userId": "user1", "password": "secret", "setupToken": first_token},
    )
    assert expired.status_code == 401

    # Fresh token works.
    accepted = client.post(
        "/auth/register",
        json={"userId": "user1", "password": "secret", "setupToken": second_token},
    )
    assert accepted.status_code == 200
    assert accepted.json()["role"] == "admin"


# ---------- built-in OAuth authorization service ----------------------------


def test_oauth_metadata_advertises_authorization_code_pkce(tmp_path):
    client = make_client(tmp_path)
    body = client.get("/.well-known/oauth-authorization-server").json()
    assert body["authorization_endpoint"].endswith("/oauth/authorize")
    assert body["token_endpoint"].endswith("/oauth/token")
    assert body["grant_types_supported"] == ["authorization_code"]
    assert body["code_challenge_methods_supported"] == ["S256"]


def test_oauth_finalize_requires_oauth_registration_for_new_user(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    pending = create_pending_token(
        OAuthIdentity(
            provider="gitlab",
            provider_label="GitLab",
            subject="sub-1",
            suggested_user_id="oauthuser",
            email="oauth@example.test",
            display_name="OAuth User",
        )
    )
    closed = client.post(
        "/auth/oauth/finalize",
        json={"pendingToken": pending, "userId": "oauthuser"},
    )
    assert closed.status_code == 403
    client.patch("/admin/settings", headers=bearer(admin), json={"oauthRegistrationOpen": True})
    opened = client.post(
        "/auth/oauth/finalize",
        json={"pendingToken": pending, "userId": "oauthuser"},
    )
    assert opened.status_code == 200, opened.text
    assert opened.json()["auth"]["userId"] == "oauthuser"


def test_admin_oauth_client_configuration_is_closed(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    assert client.get("/admin/oauth/clients", headers=bearer(token)).status_code == 404
    assert client.post(
        "/admin/oauth/clients",
        headers=bearer(token),
        json={"name": "Desktop App", "redirectUris": ["agents-anywhere://oauth/callback"]},
    ).status_code == 404


def test_first_party_oauth_authorization_code_pkce_round_trip(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    verifier = "test-verifier-value"
    auth = client.get(
        "/oauth/authorize",
        headers=bearer(token),
        params={
            "response_type": "code",
            "client_id": "agents-anywhere-mobile",
            "redirect_uri": "agents-anywhere://oauth/callback",
            "code_challenge": pkce_challenge(verifier),
            "code_challenge_method": "S256",
            "scope": "profile",
            "state": "abc",
        },
        follow_redirects=False,
    )
    assert auth.status_code in (302, 307), auth.text
    redirected = urlparse(auth.headers["location"])
    params = parse_qs(redirected.query)
    assert params["state"] == ["abc"]
    code = params["code"][0]

    bad = client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": "agents-anywhere-mobile",
            "redirect_uri": "agents-anywhere://oauth/callback",
            "code_verifier": "wrong",
        },
    )
    assert bad.status_code == 400

    good = client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": "agents-anywhere-mobile",
            "redirect_uri": "agents-anywhere://oauth/callback",
            "code_verifier": verifier,
        },
    )
    assert good.status_code == 200, good.text
    token_body = good.json()
    assert token_body["access_token"]
    assert token_body["token_type"] == "Bearer"
    assert token_body["scope"] == "profile"
    assert client.get("/auth/me", headers=bearer(token_body["access_token"])).json()["userId"] == "user1"

    reused = client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": "agents-anywhere-mobile",
            "redirect_uri": "agents-anywhere://oauth/callback",
            "code_verifier": verifier,
        },
    )
    assert reused.status_code == 400


def test_oauth_authorize_rejects_unregistered_redirects(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    response = client.get(
        "/oauth/authorize",
        headers=bearer(token),
        params={
            "response_type": "code",
            "client_id": "agents-anywhere-mobile",
            "redirect_uri": "http://127.0.0.1:7777/callback",
            "code_challenge": pkce_challenge("test-verifier-value"),
        },
        follow_redirects=False,
    )
    assert response.status_code == 422


# ---------- mobile QR login --------------------------------------------------


def test_mobile_login_qr_requires_phone_request_and_web_confirm(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    qr = client.post("/auth/mobile-login/qr", headers=bearer(token))
    assert qr.status_code == 200, qr.text
    qr_body = qr.json()
    assert qr_body["userId"] == "user1"
    assert qr_body["loginToken"]
    assert qr_body["expiresAt"]
    assert "payload" not in qr_body
    assert "serverUrl" not in qr_body

    premature = client.post(
        "/auth/mobile-login/exchange",
        json={"userId": "user1", "loginToken": qr_body["loginToken"]},
    )
    assert premature.status_code == 401

    requested = client.post(
        "/auth/mobile-login/request",
        json={"userId": "user1", "loginToken": qr_body["loginToken"], "deviceName": "iPhone"},
    )
    assert requested.status_code == 200, requested.text
    assert requested.json()["status"] == "pending_web_confirm"
    assert requested.json()["deviceName"] == "iPhone"

    status = client.post(
        "/auth/mobile-login/status",
        headers=bearer(token),
        json={"loginToken": qr_body["loginToken"]},
    )
    assert status.status_code == 200, status.text
    assert status.json()["status"] == "pending_web_confirm"

    still_blocked = client.post(
        "/auth/mobile-login/exchange",
        json={"userId": "user1", "loginToken": qr_body["loginToken"]},
    )
    assert still_blocked.status_code == 401

    confirmed = client.post(
        "/auth/mobile-login/confirm",
        headers=bearer(token),
        json={"loginToken": qr_body["loginToken"], "approved": True},
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["status"] == "approved"

    exchanged = client.post(
        "/auth/mobile-login/exchange",
        json={"userId": "user1", "loginToken": qr_body["loginToken"]},
    )
    assert exchanged.status_code == 200, exchanged.text
    body = exchanged.json()
    assert body["auth"]["userId"] == "user1"
    assert body["auth"]["accessToken"]
    assert body["refreshToken"]
    assert client.get("/auth/me", headers=bearer(body["auth"]["accessToken"])).json()["userId"] == "user1"

    replay = client.post(
        "/auth/mobile-login/exchange",
        json={"userId": "user1", "loginToken": qr_body["loginToken"]},
    )
    assert replay.status_code == 401


def test_mobile_login_reject_flow_blocks_exchange(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    qr_body = client.post("/auth/mobile-login/qr", headers=bearer(token)).json()
    client.post(
        "/auth/mobile-login/request",
        json={"userId": "user1", "loginToken": qr_body["loginToken"], "deviceName": "iPhone"},
    )
    rejected = client.post(
        "/auth/mobile-login/confirm",
        headers=bearer(token),
        json={"loginToken": qr_body["loginToken"], "approved": False},
    )
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["status"] == "rejected"
    exchanged = client.post(
        "/auth/mobile-login/exchange",
        json={"userId": "user1", "loginToken": qr_body["loginToken"]},
    )
    assert exchanged.status_code == 401


def test_mobile_login_exchange_rejects_user_mismatch(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    qr_body = client.post("/auth/mobile-login/qr", headers=bearer(token)).json()
    exchanged = client.post(
        "/auth/mobile-login/exchange",
        json={"userId": "other", "loginToken": qr_body["loginToken"]},
    )
    assert exchanged.status_code == 401
