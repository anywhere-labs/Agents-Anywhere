"""Revocable logins: token families, refresh rotation, logout (``05-server.md`` §8)."""

from __future__ import annotations

import asyncio

from conftest import make_test_client
from test_auth import admin_token, bearer, login, register, user_id

from agent_server.core.auth import create_user_access_token, verify_user_access_claims


def _me(client, token: str) -> int:
    return client.get("/auth/me", headers=bearer(token)).status_code


def test_login_opens_a_family_and_refresh_rotates_once() -> None:
    with make_test_client() as client:
        first = register(client, "user1").json()
        assert first["refreshToken"].startswith("aart_fam_")
        assert first["expiresAt"] and first["refreshExpiresAt"]
        uid, family = verify_user_access_claims(first["accessToken"])
        assert family is not None and first["refreshToken"].startswith(f"aart_{family}.")

        refreshed = client.post("/auth/refresh", json={"refreshToken": first["refreshToken"]})
        assert refreshed.status_code == 200, refreshed.text
        second = refreshed.json()
        assert verify_user_access_claims(second["accessToken"]) == (uid, family)
        assert second["refreshToken"] != first["refreshToken"]
        assert _me(client, second["accessToken"]) == 200

        # The used refresh token comes back: someone kept a copy, so the whole login ends.
        reused = client.post("/auth/refresh", json={"refreshToken": first["refreshToken"]})
        assert reused.status_code == 401
        assert _me(client, second["accessToken"]) == 401
        assert _me(client, first["accessToken"]) == 401
        assert client.post("/auth/refresh", json={"refreshToken": second["refreshToken"]}).status_code == 401

        # Garbage and forged tokens change nothing.
        other = login(client, "user1").json()
        _, other_family = verify_user_access_claims(other["accessToken"])
        for bad in ("nope", f"aart_{other_family}.{'x' * 43}", f"aart_{other_family}"):
            assert client.post("/auth/refresh", json={"refreshToken": bad}).status_code == 401
        assert _me(client, other["accessToken"]) == 200


def test_logout_ends_only_this_login() -> None:
    with make_test_client() as client:
        laptop = register(client, "user1").json()
        phone = login(client, "user1").json()

        assert client.post("/auth/logout", headers=bearer(laptop["accessToken"])).status_code == 204
        assert _me(client, laptop["accessToken"]) == 401
        # Endpoints that only need the caller's id refuse it too.
        assert client.get("/connectors", headers=bearer(laptop["accessToken"])).status_code == 401
        assert client.post("/auth/refresh", json={"refreshToken": laptop["refreshToken"]}).status_code == 401
        assert _me(client, phone["accessToken"]) == 200


def test_password_change_signs_out_every_other_login() -> None:
    with make_test_client() as client:
        current = register(client, "user1").json()
        other = login(client, "user1").json()
        changed = client.post(
            "/auth/change-password", headers=bearer(current["accessToken"]), json={"newPassword": "secret-2"}
        )
        assert changed.status_code == 204, changed.text
        assert _me(client, current["accessToken"]) == 200
        assert _me(client, other["accessToken"]) == 401
        assert client.post("/auth/refresh", json={"refreshToken": other["refreshToken"]}).status_code == 401


def test_disabling_an_account_rejects_its_tokens_everywhere() -> None:
    with make_test_client() as client:
        admin = admin_token(client)
        client.patch("/admin/settings", headers=bearer(admin), json={"registrationOpen": True}).raise_for_status()
        member = register(client, "user2").json()
        member_id = user_id(client, "user2")
        # A token from before token families (no ``fam``) is checked against the account too.
        legacy = create_user_access_token(member_id)
        assert client.get("/connectors", headers=bearer(legacy)).status_code == 200

        disabled = client.patch(f"/admin/users/{member_id}", headers=bearer(admin), json={"disabled": True})
        assert disabled.status_code == 200, disabled.text
        tokens = client.app.state.user_tokens
        tokens._cache.clear()  # what other workers see once their cache entry expires
        for token in (member["accessToken"], legacy):
            assert client.get("/connectors", headers=bearer(token)).status_code == 401
        assert client.post("/auth/refresh", json={"refreshToken": member["refreshToken"]}).status_code == 401

        # Enabled again: the old login stays ended; signing in works.
        client.patch(f"/admin/users/{member_id}", headers=bearer(admin), json={"disabled": False}).raise_for_status()
        tokens._cache.clear()
        assert _me(client, member["accessToken"]) == 401
        assert _me(client, legacy) == 200
        assert _me(client, login(client, "user2").json()["accessToken"]) == 200


def test_revocation_reaches_other_workers_after_the_cache_expires() -> None:
    from agent_server.services.user_tokens import STATUS_CACHE_SECONDS, UserTokenService

    with make_test_client() as client:
        issued = register(client, "user1").json()
        uid, family = verify_user_access_claims(issued["accessToken"])
        now = [1000.0]
        other_worker = UserTokenService(client.app.state.store, clock=lambda: now[0])

        async def check() -> bool:
            return await other_worker.allows(uid, family)

        assert asyncio.run(check()) is True
        assert client.post("/auth/logout", headers=bearer(issued["accessToken"])).status_code == 204
        assert asyncio.run(check()) is True  # still cached on that worker
        now[0] += STATUS_CACHE_SECONDS + 1
        assert asyncio.run(check()) is False


def test_mobile_refresh_follows_its_login() -> None:
    with make_test_client() as client:
        web = admin_token(client)
        uid = user_id(client, "user1")
        qr = client.post("/auth/mobile-login/qr", headers=bearer(web)).json()
        client.post(
            "/auth/mobile-login/request",
            json={"userId": uid, "loginToken": qr["loginToken"], "deviceName": "iPhone"},
        ).raise_for_status()
        client.post(
            "/auth/mobile-login/confirm", headers=bearer(web), json={"loginToken": qr["loginToken"], "approved": True}
        ).raise_for_status()
        exchanged = client.post(
            "/auth/mobile-login/exchange", json={"userId": uid, "loginToken": qr["loginToken"]}
        ).json()
        mobile_access = exchanged["auth"]["accessToken"]
        _, family = verify_user_access_claims(mobile_access)

        refreshed = client.post("/auth/mobile-login/refresh", json={"refreshToken": exchanged["refreshToken"]})
        assert refreshed.status_code == 200
        assert verify_user_access_claims(refreshed.json()["accessToken"])[1] == family

        assert client.post("/auth/logout", headers=bearer(mobile_access)).status_code == 204
        assert client.post(
            "/auth/mobile-login/refresh", json={"refreshToken": exchanged["refreshToken"]}
        ).status_code == 401
        assert _me(client, web) == 200
