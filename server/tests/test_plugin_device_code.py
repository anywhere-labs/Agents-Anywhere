"""End-to-end tests for the RFC 8628 device authorization grant.

The grant backs headless / SSH plug-in sign-in: a plug-in starts a request, the
user approves the short code from an authenticated web session, and the plug-in
polls for the token.
"""

from __future__ import annotations

import asyncio
from typing import Any

from sqlalchemy import text
from test_auth import admin_token, bearer, make_client, register

from agent_server.core.oauth_clients import (
    DESKTOP_OAUTH_CLIENT,
    DSH_PLUGIN_OAUTH_CLIENT,
    MOBILE_OAUTH_CLIENT,
    OPENCODE_PLUGIN_OAUTH_CLIENT,
)
from agent_server.core.oauth_device import (
    DEVICE_GRANT_TYPE,
    hash_secret,
    normalize_user_code,
)

CLIENT_ID = OPENCODE_PLUGIN_OAUTH_CLIENT.client_id


def _start_device_code(client, *, client_id: str = CLIENT_ID):
    return client.post("/oauth/device/code", data={"client_id": client_id, "scope": "profile"})


def _poll(client, device_code: str, *, client_id: str = CLIENT_ID):
    return client.post(
        "/oauth/device/token",
        data={
            "grant_type": DEVICE_GRANT_TYPE,
            "device_code": device_code,
            "client_id": client_id,
        },
    )


def _lookup(client, token: str, user_code: str):
    return client.post(
        "/oauth/device/lookup",
        headers=bearer(token),
        json={"userCode": user_code},
    )


def _approve(client, token: str, user_code: str, *, approved: bool = True):
    return client.post(
        "/oauth/device/approve",
        headers=bearer(token),
        json={"userCode": user_code, "approved": approved},
    )


def _device_code_row(client, device_code: str) -> dict[str, Any]:
    """Read the stored row, so a test sees what actually reached the database."""

    store = client.app.state.store

    async def run() -> dict[str, Any]:
        async with store.engine.connect() as conn:
            result = await conn.execute(
                text("SELECT * FROM oauth_device_codes WHERE device_code_hash = :h"),
                {"h": hash_secret(device_code)},
            )
            return dict(result.mappings().first())

    return asyncio.run(run())


def _expire_device_codes(client) -> None:
    store = client.app.state.store

    async def run() -> None:
        async with store.engine.begin() as conn:
            await conn.execute(
                text("UPDATE oauth_device_codes SET expires_at = '2000-01-01T00:00:00Z'")
            )

    asyncio.run(run())


def test_device_code_request_polls_pending_then_exchanges_token(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)

    started = _start_device_code(client)
    assert started.status_code == 200, started.text
    body = started.json()
    assert body["verification_uri"].endswith("/#/plugin-device")
    assert body["verification_uri_complete"].startswith(body["verification_uri"] + "?user_code=")
    assert body["expires_in"] == 600
    assert body["interval"] == 5
    assert body["user_code"] in body["verification_uri_complete"]
    # The code is readable: XXXX-XXXX over an unambiguous alphabet.
    assert len(body["user_code"]) == 9 and body["user_code"][4] == "-"
    assert all(ch.isalnum() or ch == "-" for ch in body["user_code"])

    pending = _poll(client, body["device_code"])
    assert pending.status_code == 400, pending.text
    assert pending.json()["error"] == "authorization_pending"

    # Polling again inside the interval must slow the client down, and the new
    # interval must be persisted (an unwritten penalty would still answer
    # slow_down and leave the limiter useless).
    slow = _poll(client, body["device_code"])
    assert slow.json()["error"] == "slow_down"
    assert _device_code_row(client, body["device_code"])["interval_seconds"] == 10

    # The web page can inspect the request before approving it.
    lookup = client.post(
        "/oauth/device/lookup",
        headers=bearer(token),
        json={"userCode": body["user_code"].lower().replace("-", "")},
    )
    assert lookup.status_code == 200, lookup.text
    assert lookup.json()["clientName"] == "Agents Anywhere OpenCode Plugin"
    assert lookup.json()["status"] == "pending"

    approved = _approve(client, token, body["user_code"])
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "approved"

    received = _poll(client, body["device_code"])
    assert received.status_code == 200, received.text
    assert client.get("/auth/me", headers=bearer(received.json()["access_token"])).status_code == 200

    # A device code is single-use: a second poll is rejected.
    replayed = _poll(client, body["device_code"])
    assert replayed.status_code == 400
    assert replayed.json()["error"] == "invalid_grant"


def test_device_code_denial_reports_access_denied(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    body = _start_device_code(client).json()

    denied = _approve(client, token, body["user_code"], approved=False)
    assert denied.status_code == 200, denied.text
    assert denied.json()["status"] == "denied"

    polled = _poll(client, body["device_code"])
    assert polled.status_code == 400
    assert polled.json()["error"] == "access_denied"


def test_device_code_expiry_reports_expired_token(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    body = _start_device_code(client).json()

    _expire_device_codes(client)

    polled = _poll(client, body["device_code"])
    assert polled.status_code == 400
    assert polled.json()["error"] == "expired_token"

    # An expired code can no longer be approved either.
    assert _approve(client, token, body["user_code"]).status_code == 404


def test_device_code_rejects_wrong_client_and_unknown_code(tmp_path):
    client = make_client(tmp_path)
    body = _start_device_code(client).json()

    assert _poll(client, body["device_code"], client_id=DSH_PLUGIN_OAUTH_CLIENT.client_id).status_code == 400
    unknown = _poll(client, "not-a-real-device-code")
    assert unknown.status_code == 400
    assert unknown.json()["error"] == "invalid_grant"
    assert _start_device_code(client, client_id="not-a-client").status_code == 404


def test_device_approval_requires_a_signed_in_session(tmp_path):
    client = make_client(tmp_path)
    body = _start_device_code(client).json()

    assert client.post("/oauth/device/lookup", json={"userCode": body["user_code"]}).status_code == 401
    assert client.post(
        "/oauth/device/approve",
        json={"userCode": body["user_code"], "approved": True},
    ).status_code == 401


def test_device_code_user_code_guesses_are_rate_limited(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)

    statuses = [
        _approve(client, token, "ZZZZ-ZZZZ").status_code for _ in range(10)
    ]
    assert statuses == [404] * 10
    # The 11th wrong guess trips the limiter before it reaches the code space.
    blocked = _approve(client, token, "ZZZZ-ZZZZ")
    assert blocked.status_code == 429, blocked.text

    # The limiter is per account: a different user can still approve a valid code.
    client.patch("/admin/settings", headers=bearer(token), json={"registrationOpen": True})
    other = register(client, "second").json()["accessToken"]
    body = _start_device_code(client).json()
    assert _approve(client, other, body["user_code"]).status_code == 200


def test_oauth_metadata_advertises_the_device_grant(tmp_path):
    client = make_client(tmp_path)
    body = client.get("/.well-known/oauth-authorization-server").json()
    assert body["device_authorization_endpoint"].endswith("/api/v2/oauth/device/code")
    assert DEVICE_GRANT_TYPE in body["grant_types_supported"]


def test_device_authorization_accepts_the_opencode_loopback_boundary(tmp_path):
    client = make_client(tmp_path)
    assert _start_device_code(client).status_code == 200
    assert OPENCODE_PLUGIN_OAUTH_CLIENT.allows_redirect("http://127.0.0.1:51234/oauth/callback")
    assert not OPENCODE_PLUGIN_OAUTH_CLIENT.allows_redirect("http://localhost:51234/oauth/callback")


# ---------- hardening: scope, storage, transaction and origin ----------------


def test_device_code_rejects_every_other_first_party_client(tmp_path):
    """The device grant is the OpenCode plug-in's alone (M2).

    Mobile and desktop sign in through their own redirect URIs; letting them
    start a device request would mint a user token outside the designed flow.
    """

    client = make_client(tmp_path)
    for client_id in (
        MOBILE_OAUTH_CLIENT.client_id,
        DESKTOP_OAUTH_CLIENT.client_id,
        DSH_PLUGIN_OAUTH_CLIENT.client_id,
    ):
        rejected = _start_device_code(client, client_id=client_id)
        assert rejected.status_code == 404, f"{client_id}: {rejected.text}"


def test_device_code_stores_only_hashes(tmp_path):
    """Neither secret is readable at rest (M7/M8).

    Asserted on the stored columns themselves rather than through an indirect
    effect, so dropping the hashing cannot keep the suite green.
    """

    client = make_client(tmp_path)
    body = _start_device_code(client).json()

    row = _device_code_row(client, body["device_code"])
    assert row["device_code_hash"] == hash_secret(body["device_code"])
    # The user code is stored canonical: upper case, without the separator.
    assert row["user_code_hash"] == hash_secret(normalize_user_code(body["user_code"]))
    assert row["device_code_hash"] != body["device_code"]
    assert row["user_code_hash"] != body["user_code"]

    stored_text = " ".join(str(value) for value in row.values())
    assert body["device_code"] not in stored_text
    assert body["user_code"] not in stored_text


def test_concurrent_slow_downs_accumulate_the_interval(tmp_path):
    """Two simultaneous slow-downs must add up 5 -> 15 (M1).

    A read-modify-write would have both writers persist the 5 they read and
    leave the interval at 10.
    """

    client = make_client(tmp_path)
    store = client.app.state.store
    device_code = _start_device_code(client).json()["device_code"]

    async def run() -> list[dict[str, Any]]:
        # First poll just stamps last_polled_at, so the two below both land
        # inside the interval and both take the slow-down path.
        await store.poll_oauth_device_code(device_code=device_code, client_id=CLIENT_ID)
        return await asyncio.gather(
            store.poll_oauth_device_code(device_code=device_code, client_id=CLIENT_ID),
            store.poll_oauth_device_code(device_code=device_code, client_id=CLIENT_ID),
        )

    results = asyncio.run(run())
    assert [result["status"] for result in results] == ["slow_down", "slow_down"]
    assert _device_code_row(client, device_code)["interval_seconds"] == 15


def test_device_poll_does_not_burn_the_code_when_the_user_is_gone(tmp_path, monkeypatch):
    """A failed user lookup must roll the consumption back (M4).

    The token cannot be issued without the account, so the request must stay
    unconsumed instead of being spent and mis-reported as ``invalid_grant``.
    """

    client = make_client(tmp_path)
    token = admin_token(client)
    body = _start_device_code(client).json()
    assert _approve(client, token, body["user_code"]).status_code == 200

    async def missing_user(conn, user_id):
        raise KeyError(user_id)

    monkeypatch.setattr(client.app.state.store, "_device_grant_user", missing_user)
    try:
        response = _poll(client, body["device_code"])
    except KeyError:
        response = None

    if response is not None:
        assert response.status_code != 200, response.text
    # The consumption rolled back with the failed lookup: the code is still live.
    assert _device_code_row(client, body["device_code"])["consumed_at"] is None


def test_device_approval_of_an_already_handled_code_is_a_conflict(tmp_path):
    """Re-approving a settled code answers 409, not 200 with the old status (M5)."""

    client = make_client(tmp_path)
    token = admin_token(client)

    approved = _start_device_code(client).json()
    assert _approve(client, token, approved["user_code"]).status_code == 200
    replayed = _approve(client, token, approved["user_code"])
    assert replayed.status_code == 409, replayed.text

    denied = _start_device_code(client).json()
    assert _approve(client, token, denied["user_code"], approved=False).status_code == 200
    flipped = _approve(client, token, denied["user_code"])
    assert flipped.status_code == 409, flipped.text
    # A conflicted replay must not flip the state it reported on.
    assert _poll(client, denied["device_code"]).json()["error"] == "access_denied"


def test_device_verification_uri_ignores_a_forged_forwarded_host(tmp_path, monkeypatch):
    """A spoofed X-Forwarded-Host must not move the verification link (M3)."""

    monkeypatch.setenv("AGENT_SERVER_PUBLIC_ORIGIN", "https://agents.example")
    client = make_client(tmp_path)
    forged = {"x-forwarded-host": "phish.example", "x-forwarded-proto": "https"}

    started = client.post(
        "/oauth/device/code",
        data={"client_id": CLIENT_ID, "scope": "profile"},
        headers=forged,
    )
    assert started.status_code == 200, started.text
    body = started.json()
    assert body["verification_uri"] == "https://agents.example/#/plugin-device"
    assert body["verification_uri_complete"].startswith(
        "https://agents.example/#/plugin-device?user_code="
    )

    metadata = client.get("/.well-known/oauth-authorization-server", headers=forged).json()
    assert metadata["issuer"] == "https://agents.example"
    assert metadata["device_authorization_endpoint"] == (
        "https://agents.example/api/v2/oauth/device/code"
    )


# ---------- completeness: uncovered branches ---------------------------------


def test_device_token_rejects_another_grant_type(tmp_path):
    client = make_client(tmp_path)
    body = _start_device_code(client).json()

    response = client.post(
        "/oauth/device/token",
        data={
            "grant_type": "authorization_code",
            "device_code": body["device_code"],
            "client_id": CLIENT_ID,
        },
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"] == "unsupported_grant_type"


def test_device_lookup_rejects_an_expired_code(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    body = _start_device_code(client).json()

    _expire_device_codes(client)

    expired = _lookup(client, token, body["user_code"])
    assert expired.status_code == 404, expired.text


def test_device_lookup_is_rate_limited_per_account(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)

    statuses = [_lookup(client, token, "ZZZZ-ZZZZ").status_code for _ in range(10)]
    assert statuses == [404] * 10
    assert _lookup(client, token, "ZZZZ-ZZZZ").status_code == 429


def test_user_code_normalisation_folds_confusable_letters():
    """I/L/O fold onto 1/1/0 so a hand-typed code still matches."""

    assert normalize_user_code("0O1I-2L34") == "00112134"
    assert normalize_user_code("0o1i 2l34") == "00112134"
    assert hash_secret(normalize_user_code("0O1I-2L34")) == hash_secret("00112134")
    assert normalize_user_code("0O1I") == ""
    assert normalize_user_code(None) == ""
