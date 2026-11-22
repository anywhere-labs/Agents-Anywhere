from __future__ import annotations

import base64
import json
import time
from typing import Any

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from sqlalchemy import update

from aa_control.app import create_app
from aa_control.core.config import ControlSettings, OidcAuthConfig
from aa_control.core.entitlements import (
    ENTITLEMENT_DRIVE_QUOTA_MB,
    ENTITLEMENT_DRIVE_TTL_DAYS,
    ENTITLEMENT_MAX_DEVICES,
    EntitlementSet,
    merge_entitlements,
    sanitize_entitlements,
)
from aa_control.infra.db import schema
from aa_control.infra.oidc import OidcJwksVerifier


def _generate_rsa_jwk(kid: str) -> tuple[rsa.RSAPrivateKey, dict[str, Any]]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk_dict = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk_dict.update({"kid": kid, "use": "sig", "alg": "RS256"})
    return private_key, jwk_dict


def _generate_ec_jwk(kid: str) -> tuple[ec.EllipticCurvePrivateKey, dict[str, Any]]:
    private_key = ec.generate_private_key(ec.SECP256R1())
    jwk_dict = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(private_key.public_key()))
    jwk_dict.update({"kid": kid, "use": "sig", "alg": "ES256"})
    return private_key, jwk_dict


class FakeOidcIdp:
    """In-process OIDC Discovery + JWKS server backed by httpx.MockTransport."""

    def __init__(self, issuer: str = "https://auth.anywhere.test") -> None:
        self.issuer = issuer.rstrip("/")
        self.keys: list[dict[str, Any]] = []
        self.discovery_hits = 0
        self.jwks_hits = 0
        self.fail_jwks = False
        self.fail_discovery = False

    def add_key(self, jwk: dict[str, Any]) -> None:
        self.keys.append(jwk)

    def set_keys(self, keys: list[dict[str, Any]]) -> None:
        self.keys = list(keys)

    def transport(self) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if url == f"{self.issuer}/.well-known/openid-configuration":
                self.discovery_hits += 1
                if self.fail_discovery:
                    return httpx.Response(503, json={"error": "temporarily_unavailable"})
                return httpx.Response(
                    200,
                    json={
                        "issuer": self.issuer,
                        "authorization_endpoint": f"{self.issuer}/oauth/authorize",
                        "token_endpoint": f"{self.issuer}/oauth/token",
                        "userinfo_endpoint": f"{self.issuer}/oauth/userinfo",
                        "jwks_uri": f"{self.issuer}/.well-known/jwks.json",
                        "revocation_endpoint": f"{self.issuer}/oauth/revoke",
                    },
                )
            if url == f"{self.issuer}/.well-known/jwks.json":
                self.jwks_hits += 1
                if self.fail_jwks:
                    return httpx.Response(503, json={"error": "jwks_unavailable"})
                return httpx.Response(200, json={"keys": list(self.keys)})
            return httpx.Response(404, json={"error": "not_found"})

        return httpx.MockTransport(handler)


def _sign_token(
    private_key: Any,
    *,
    kid: str | None,
    alg: str = "RS256",
    typ: str | None = "at+jwt",
    issuer: str = "https://auth.anywhere.test",
    subject: str = "usr_global_1",
    audience: str | list[str] = "aa-v3",
    expires_in: int = 900,
    extra: dict[str, Any] | None = None,
) -> str:
    now = int(time.time())
    payload: dict[str, Any] = {
        "iss": issuer,
        "sub": subject,
        "aud": audience,
        "iat": now,
        "exp": now + expires_in,
    }
    if extra:
        payload.update(extra)
    headers: dict[str, Any] = {}
    if kid is not None:
        headers["kid"] = kid
    if typ is not None:
        headers["typ"] = typ
    return jwt.encode(payload, private_key, algorithm=alg, headers=headers)


# ---------------------------------------------------------------------------
# Entitlements & config unit tests
# ---------------------------------------------------------------------------


def test_entitlements_sanitization_merging_and_limits() -> None:
    cleaned = sanitize_entitlements(
        {
            "aa.max_devices": 10,
            "aa.drive_quota_mb": 512,
            "aa.drive_ttl_days": 7,
            "aa.beta": True,
            "aa.tier": "pro",
            "bad.nested": {"a": 1},
            "bad.none": None,
            "bad.nan": float("nan"),
        }
    )
    assert cleaned == {
        "aa.max_devices": 10,
        "aa.drive_quota_mb": 512,
        "aa.drive_ttl_days": 7,
        "aa.beta": True,
        "aa.tier": "pro",
    }

    merged = merge_entitlements(
        {ENTITLEMENT_MAX_DEVICES: 5, ENTITLEMENT_DRIVE_QUOTA_MB: 256},
        {ENTITLEMENT_MAX_DEVICES: -1, ENTITLEMENT_DRIVE_TTL_DAYS: 30},
    )
    ent = EntitlementSet.from_mapping(merged)
    assert ent.max_devices() is None  # -1 means unlimited
    assert ent.is_unlimited(ENTITLEMENT_MAX_DEVICES) is True
    assert ent.drive_quota_mb() == 256
    assert ent.drive_ttl_days() == 30
    # Booleans are never coerced to integers.
    assert EntitlementSet.from_mapping({ENTITLEMENT_MAX_DEVICES: True}).max_devices() is None


def test_oidc_config_validation_and_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # auth_mode="oidc" requires oidc_auth
    with pytest.raises(ValueError, match="oidc_auth"):
        ControlSettings(
            database_url="sqlite+aiosqlite:///:memory:",
            redis_url="redis://localhost:6379/0",
            secret_key="secret",
            auth_mode="oidc",
        )

    # Reject symmetric/none algorithms to prevent algorithm-confusion attacks
    with pytest.raises(ValueError, match="asymmetric"):
        OidcAuthConfig(issuer="https://auth.test", client_id="aa-v3", algorithms=("HS256",))

    # Require audience or client_id when verify_audience=True
    with pytest.raises(ValueError, match="AA_CONTROL_OIDC_AUDIENCE"):
        OidcAuthConfig(issuer="https://auth.test", verify_audience=True)

    # Verify from_env parsing
    monkeypatch.setenv("AA_CONTROL_AUTH_MODE", "oidc")
    monkeypatch.setenv("AA_CONTROL_OIDC_ISSUER", "https://auth.example.com/")
    monkeypatch.setenv("AA_CONTROL_OIDC_CLIENT_ID", "aa-v3")
    monkeypatch.setenv("AA_CONTROL_OIDC_AUDIENCE", "aa-v3,aa-control")
    monkeypatch.setenv("AA_CONTROL_OIDC_ADMIN_ROLES", "admin,superadmin")
    monkeypatch.setenv("AA_CONTROL_DEFAULT_ENTITLEMENTS_JSON", '{"aa.max_devices": 8, "aa.drive_quota_mb": 1024}')

    cfg = ControlSettings.from_env()
    assert cfg.auth_mode == "oidc"
    assert cfg.oidc_auth is not None
    assert cfg.oidc_auth.issuer == "https://auth.example.com"
    assert cfg.oidc_auth.effective_audiences == ("aa-v3", "aa-control")
    assert cfg.oidc_auth.admin_roles == ("admin", "superadmin")
    assert cfg.default_entitlements == {"aa.max_devices": 8, "aa.drive_quota_mb": 1024}


# ---------------------------------------------------------------------------
# JWKS caching, rotation, cooldown, and attack resistance
# ---------------------------------------------------------------------------


async def test_jwks_caching_key_rotation_cooldown_and_resilience() -> None:
    idp = FakeOidcIdp()
    rsa_key1, rsa_jwk1 = _generate_rsa_jwk("kid-1")
    rsa_key2, rsa_jwk2 = _generate_rsa_jwk("kid-2")
    idp.add_key(rsa_jwk1)

    now = [1000.0]
    http_client = httpx.AsyncClient(transport=idp.transport())
    verifier = OidcJwksVerifier(
        config=OidcAuthConfig(
            issuer=idp.issuer,
            client_id="aa-v3",
            jwks_cache_ttl_seconds=300,
            jwks_min_refresh_interval_seconds=10,
        ),
        http_client=http_client,
        clock=lambda: now[0],
    )
    try:
        tok1 = _sign_token(rsa_key1, kid="kid-1", subject="usr_1")
        ident1 = await verifier.verify_token(tok1)
        assert ident1.subject == "usr_1"
        assert idp.discovery_hits == 1
        assert idp.jwks_hits == 1

        # Second verification uses cached JWKS: zero HTTP calls.
        ident2 = await verifier.verify_token(tok1)
        assert ident2.subject == "usr_1"
        assert idp.discovery_hits == 1
        assert idp.jwks_hits == 1

        # Unknown kid spam within cooldown window does NOT hammer the IdP.
        bogus = _sign_token(rsa_key2, kid="kid-unknown", subject="usr_1")
        for _ in range(5):
            with pytest.raises(Exception) as exc_info:
                await verifier.verify_token(bogus)
            assert getattr(exc_info.value, "http_status", None) == 401
        assert idp.jwks_hits == 1  # Cooldown blocked forced refresh

        # Key rotation at the IdP + clock advances past cooldown -> automatic single refresh succeeds.
        idp.set_keys([rsa_jwk1, rsa_jwk2])
        now[0] += 15.0
        tok2 = _sign_token(rsa_key2, kid="kid-2", subject="usr_2")
        ident3 = await verifier.verify_token(tok2)
        assert ident3.subject == "usr_2"
        assert idp.jwks_hits == 2

        # Algorithm confusion attacks (HS256 and alg=none) are rejected immediately.
        forged_hs256 = jwt.encode(
            {"iss": idp.issuer, "sub": "usr_admin", "aud": "aa-v3", "exp": int(time.time()) + 300},
            "attacker-symmetric-secret-key-32bytes",
            algorithm="HS256",
            headers={"kid": "kid-1"},
        )
        b64 = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa: E731
        forged_none = (
            f"{b64({'alg': 'none', 'typ': 'JWT'})}."
            f"{b64({'iss': idp.issuer, 'sub': 'usr_admin', 'aud': 'aa-v3', 'exp': int(time.time()) + 300})}."
        )
        for forged in (forged_hs256, forged_none):
            with pytest.raises(Exception) as exc_info:
                await verifier.verify_token(forged)
            assert getattr(exc_info.value, "http_status", None) == 401

        # Graceful degradation: IdP goes down after TTL expires, stale cached keys still verify!
        idp.fail_jwks = True
        now[0] += 600.0
        ident_stale = await verifier.verify_token(tok2)
        assert ident_stale.subject == "usr_2"
    finally:
        await http_client.aclose()


async def test_cold_jwks_failure_returns_503(
    db_engine,
    redis_client,
    router_pool,
    push_provider,
) -> None:
    idp = FakeOidcIdp()
    idp.fail_jwks = True
    rsa_key, _ = _generate_rsa_jwk("kid-cold")
    http_client = httpx.AsyncClient(transport=idp.transport())
    oidc_cfg = OidcAuthConfig(issuer=idp.issuer, client_id="aa-v3")
    verifier = OidcJwksVerifier(config=oidc_cfg, http_client=http_client)
    app = create_app(
        settings=ControlSettings(
            database_url="sqlite+aiosqlite:///:memory:",
            redis_url="redis://localhost:6379/0",
            secret_key="unused-in-oidc",
            auth_mode="oidc",
            oidc_auth=oidc_cfg,
        ),
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        oidc_verifier=verifier,
        start_push_worker=False,
    )
    tok = _sign_token(rsa_key, kid="kid-cold")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://aa.example.test") as client:
        resp = await client.get("/auth/me", headers={"Authorization": f"Bearer {tok}"})
        assert resp.status_code == 503
        assert resp.json()["code"] == "unavailable"
    await http_client.aclose()


# ---------------------------------------------------------------------------
# Full FastAPI OIDC mode integration (anywhere-auth + third-party OIDC)
# ---------------------------------------------------------------------------


async def test_oidc_mode_anywhere_auth_claims_entitlements_router_and_devices(
    db_engine,
    redis_client,
    router_pool,
    push_provider,
) -> None:
    idp = FakeOidcIdp(issuer="https://auth.anywhere.test")
    rsa_key, rsa_jwk = _generate_rsa_jwk("aa-key-1")
    idp.add_key(rsa_jwk)
    idp_http = httpx.AsyncClient(transport=idp.transport())

    oidc_cfg = OidcAuthConfig(
        issuer=idp.issuer,
        client_id="aa-v3",
        provider_label="Agents Anywhere",
    )
    verifier = OidcJwksVerifier(
        config=oidc_cfg,
        default_entitlements={ENTITLEMENT_DRIVE_TTL_DAYS: 7},
        http_client=idp_http,
    )
    app = create_app(
        settings=ControlSettings(
            database_url="sqlite+aiosqlite:///:memory:",
            redis_url="redis://localhost:6379/0",
            secret_key="unused-in-oidc",
            public_origin="https://aa.example.test",
            auth_mode="oidc",
            oidc_auth=oidc_cfg,
            default_entitlements={ENTITLEMENT_DRIVE_TTL_DAYS: 7},
        ),
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        oidc_verifier=verifier,
        start_push_worker=False,
    )

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="https://aa.example.test",
        ) as client:
            # 1. /auth/config advertises OIDC mode and discovered endpoints
            cfg_resp = await client.get("/auth/config")
            assert cfg_resp.status_code == 200
            cfg_body = cfg_resp.json()
            assert cfg_body["auth_mode"] == "oidc"
            assert cfg_body["needs_bootstrap"] is False
            assert cfg_body["registration_open"] is False
            assert cfg_body["oauth_enabled"] is True
            assert cfg_body["oidc"]["issuer"] == idp.issuer
            assert cfg_body["oidc"]["client_id"] == "aa-v3"
            assert cfg_body["oidc"]["authorization_endpoint"] == f"{idp.issuer}/oauth/authorize"
            assert cfg_body["oidc"]["jwks_uri"] == f"{idp.issuer}/.well-known/jwks.json"

            # 2. Local password endpoints are disabled in oidc mode
            for method, path, body in (
                ("POST", "/auth/register", {"email": "a@b.com", "password": "password123"}),
                ("POST", "/auth/login", {"email": "a@b.com", "password": "password123"}),
                ("POST", "/auth/refresh", {"refresh_token": "aart_" + "x" * 24}),
                ("POST", "/auth/logout", {"refresh_token": "aart_" + "x" * 24}),
            ):
                blocked = await client.request(method, path, json=body)
                assert blocked.status_code == 403
                assert blocked.json()["code"] == "local_auth_disabled"

            # 3. Valid anywhere-auth RS256 token authenticates /auth/me & JIT-provisions global sub
            token = _sign_token(
                rsa_key,
                kid="aa-key-1",
                typ="at+jwt",
                subject="usr_global_alice",
                extra={
                    "email": "alice@anywhere.dev",
                    "email_verified": True,
                    "name": "Alice",
                    "role": "member",
                    "plan": "free",
                    "entitlements": {
                        ENTITLEMENT_MAX_DEVICES: 2,
                        ENTITLEMENT_DRIVE_QUOTA_MB: 512,
                    },
                    "active_context": {"type": "personal"},
                },
            )
            headers = {"Authorization": f"Bearer {token}"}
            me = await client.get("/auth/me", headers=headers)
            assert me.status_code == 200
            me_data = me.json()
            assert me_data["id"] == "usr_global_alice"
            assert me_data["email"] == "alice@anywhere.dev"
            assert me_data["display_name"] == "Alice"
            assert me_data["role"] == "member"
            assert me_data["plan"] == "free"
            assert me_data["entitlements"] == {
                ENTITLEMENT_MAX_DEVICES: 2,
                ENTITLEMENT_DRIVE_QUOTA_MB: 512,
                ENTITLEMENT_DRIVE_TTL_DAYS: 7,  # merged from defaults
            }
            assert me_data["active_context"] == {"type": "personal"}

            # 4. Organization-context token preserves active_context and org entitlements
            org_token = _sign_token(
                rsa_key,
                kid="aa-key-1",
                typ="at+jwt",
                subject="usr_global_alice",
                extra={
                    "email": "alice@anywhere.dev",
                    "email_verified": True,
                    "name": "Alice",
                    "role": "member",
                    "plan": "team-pro",
                    "entitlements": {
                        ENTITLEMENT_MAX_DEVICES: -1,
                        ENTITLEMENT_DRIVE_QUOTA_MB: 10240,
                        ENTITLEMENT_DRIVE_TTL_DAYS: 90,
                    },
                    "active_context": {
                        "type": "organization",
                        "org_id": "org_acme",
                        "org_slug": "acme",
                        "org_name": "Acme Corp",
                        "org_role": "org_admin",
                    },
                },
            )
            me_org = await client.get("/auth/me", headers={"Authorization": f"Bearer {org_token}"})
            assert me_org.status_code == 200
            assert me_org.json()["plan"] == "team-pro"
            assert me_org.json()["active_context"] == {
                "type": "organization",
                "org_id": "org_acme",
                "org_slug": "acme",
                "org_name": "Acme Corp",
                "org_role": "org_admin",
            }
            assert me_org.json()["entitlements"][ENTITLEMENT_DRIVE_TTL_DAYS] == 90

            # 5. Router token issuance uses global sub in MeshCall principal
            rtok = await client.post(
                "/auth/router-token",
                headers=headers,
                json={"client_id": "cli_ios_1", "platform": "ios"},
            )
            assert rtok.status_code == 200
            assert rtok.json()["principal"] == "user:usr_global_alice/client:cli_ios_1"

            # 6. Device registration enforces aa.max_devices=2 entitlement
            d1 = await client.post(
                "/devices/register",
                headers=headers,
                json={"name": "MacBook Pro", "platform": "macos", "mode_hint": "normal"},
            )
            d2 = await client.post(
                "/devices/register",
                headers=headers,
                json={"name": "Linux Box", "platform": "linux", "mode_hint": "normal"},
            )
            assert d1.status_code == 200
            assert d2.status_code == 200

            d3_blocked = await client.post(
                "/devices/register",
                headers=headers,
                json={"name": "Third Box", "platform": "linux", "mode_hint": "normal"},
            )
            assert d3_blocked.status_code == 403
            assert d3_blocked.json()["code"] == "device_limit_reached"

            # Unlimited (-1) in org token allows registering the 3rd device!
            d3_allowed = await client.post(
                "/devices/register",
                headers={"Authorization": f"Bearer {org_token}"},
                json={"name": "Third Box", "platform": "linux", "mode_hint": "normal"},
            )
            assert d3_allowed.status_code == 200

            # Device router-token exchange still uses device_secret independently of auth_mode
            dtok = await client.post(
                "/devices/router-token",
                json={
                    "device_id": d1.json()["device"]["id"],
                    "device_secret": d1.json()["device_secret"],
                },
            )
            assert dtok.status_code == 200
            assert dtok.json()["principal"] == f"device:{d1.json()['device']['id']}"

            # 7. MCP endpoints authenticate seamlessly with OIDC Bearer JWT
            grants = await client.get("/mcp/grants", headers=headers)
            assert grants.status_code == 200
            assert grants.json() == {"grants": []}

            # 8. Wrong audience / expired token rejected with 401
            wrong_aud = _sign_token(rsa_key, kid="aa-key-1", audience="other-client")
            expired = _sign_token(rsa_key, kid="aa-key-1", expires_in=-120)
            assert (await client.get("/auth/me", headers={"Authorization": f"Bearer {wrong_aud}"})).status_code == 401
            assert (await client.get("/auth/me", headers={"Authorization": f"Bearer {expired}"})).status_code == 401

            # 9. Locally disabled shadow user is rejected even with valid OIDC JWT
            async with db_engine.begin() as conn:
                await conn.execute(
                    update(schema.users)
                    .where(schema.users.c.id == "usr_global_alice")
                    .values(disabled=1)
                )
            disabled_resp = await client.get("/auth/me", headers=headers)
            assert disabled_resp.status_code == 401
    finally:
        await idp_http.aclose()


async def test_oidc_third_party_es256_custom_claims_and_email_collision_safety(
    db_engine,
    redis_client,
    router_pool,
    push_provider,
) -> None:
    idp = FakeOidcIdp(issuer="https://keycloak.corp.example/realms/main")
    ec_key, ec_jwk = _generate_ec_jwk("kc-ec-1")
    idp.add_key(ec_jwk)
    idp_http = httpx.AsyncClient(transport=idp.transport())

    oidc_cfg = OidcAuthConfig(
        issuer=idp.issuer,
        audiences=("aa-api",),
        admin_roles=("aa-admin",),
        entitlements_claim="https://aa.example/entitlements",
    )
    verifier = OidcJwksVerifier(
        config=oidc_cfg,
        default_entitlements={ENTITLEMENT_MAX_DEVICES: 5, ENTITLEMENT_DRIVE_QUOTA_MB: 256},
        http_client=idp_http,
    )
    app = create_app(
        settings=ControlSettings(
            database_url="sqlite+aiosqlite:///:memory:",
            redis_url="redis://localhost:6379/0",
            secret_key="unused",
            auth_mode="oidc",
            oidc_auth=oidc_cfg,
            default_entitlements={ENTITLEMENT_MAX_DEVICES: 5, ENTITLEMENT_DRIVE_QUOTA_MB: 256},
        ),
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        oidc_verifier=verifier,
        start_push_worker=False,
    )

    # Seed an unrelated pre-existing local user holding the same email to verify no crash & no hijack.
    legacy = await app.state.repo.create_user(
        email="bob@corp.example",
        password_hash="pbkdf2_sha256$x$y",
        display_name="Legacy Bob",
        role="member",
    )

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="https://aa.example.test",
        ) as client:
            # Standard third-party OIDC token (ES256, preferred_username, Keycloak realm_access.roles, no entitlements)
            token = _sign_token(
                ec_key,
                kid="kc-ec-1",
                alg="ES256",
                typ="JWT",
                issuer=idp.issuer,
                subject="kc-sub-bob-999",
                audience=["aa-api", "account"],
                extra={
                    "email": "bob@corp.example",
                    "email_verified": True,
                    "preferred_username": "bob.ops",
                    "realm_access": {"roles": ["aa-admin"]},
                },
            )
            me = await client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
            assert me.status_code == 200
            data = me.json()
            assert data["id"] == "kc-sub-bob-999"
            assert data["id"] != legacy.id  # Did NOT hijack legacy account
            assert data["display_name"] == "bob.ops"
            assert data["role"] == "admin"
            assert data["email"] == "bob@corp.example"
            # Fell back cleanly to configured default entitlements
            assert data["entitlements"] == {ENTITLEMENT_MAX_DEVICES: 5, ENTITLEMENT_DRIVE_QUOTA_MB: 256}

            # Migrated AA 2.x user continuity: if JWT sub matches an existing users.id,
            # the user seamlessly keeps ownership of their pre-existing devices.
            await app.state.repo.create_device(
                user_id=legacy.id,
                name="Legacy Workstation",
                platform="linux",
                connector_version="3.0.0",
                mode_hint="normal",
                e2e_public_key_hint=None,
                secret_hash="deadbeef" * 8,
            )
            migrated_token = _sign_token(
                ec_key,
                kid="kc-ec-1",
                alg="ES256",
                typ="at+jwt",
                issuer=idp.issuer,
                subject=legacy.id,
                audience="aa-api",
                extra={"email": "bob@corp.example", "email_verified": True, "name": "Bob Migrated"},
            )
            me_migrated = await client.get("/auth/me", headers={"Authorization": f"Bearer {migrated_token}"})
            assert me_migrated.status_code == 200
            assert me_migrated.json()["id"] == legacy.id
            assert me_migrated.json()["display_name"] == "Bob Migrated"
            owned_devices = await app.state.device_service.list_devices(legacy.id)
            assert [d.name for d in owned_devices] == ["Legacy Workstation"]
    finally:
        await idp_http.aclose()


async def test_local_mode_fallback_and_default_entitlements(
    db_engine,
    redis_client,
    router_pool,
    push_provider,
) -> None:
    app = create_app(
        settings=ControlSettings(
            database_url="sqlite+aiosqlite:///:memory:",
            redis_url="redis://localhost:6379/0",
            secret_key="local-secret",
            password_iterations=1_000,
            auth_mode="local",
            default_entitlements={ENTITLEMENT_MAX_DEVICES: 1},
        ),
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        start_push_worker=False,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://aa.example.test") as client:
        cfg = (await client.get("/auth/config")).json()
        assert cfg["auth_mode"] == "local"
        assert cfg["oidc"] is None

        reg = (
            await client.post(
                "/auth/register",
                json={"email": "local@example.com", "password": "password123"},
            )
        ).json()
        headers = {"Authorization": f"Bearer {reg['access_token']}"}
        me = (await client.get("/auth/me", headers=headers)).json()
        assert me["entitlements"] == {ENTITLEMENT_MAX_DEVICES: 1}

        first = await client.post(
            "/devices/register",
            headers=headers,
            json={"name": "Dev 1", "platform": "macos"},
        )
        second = await client.post(
            "/devices/register",
            headers=headers,
            json={"name": "Dev 2", "platform": "linux"},
        )
        assert first.status_code == 200
        assert second.status_code == 403
        assert second.json()["code"] == "device_limit_reached"
