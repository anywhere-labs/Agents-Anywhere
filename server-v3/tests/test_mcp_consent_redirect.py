from __future__ import annotations

import base64
import dataclasses
import hashlib
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from aa_control.core.config import ControlSettings
from aa_control.core.models import RegisterDeviceRequest

WEB_ORIGIN = "https://app.aa.example.test"
REDIRECT_URI = "http://127.0.0.1:4321/callback"


@pytest.fixture
def settings(settings: ControlSettings) -> ControlSettings:
    # Trailing slash on purpose: the setting is normalised.
    return dataclasses.replace(settings, web_origin=f"{WEB_ORIGIN}/")


def _challenge() -> str:
    verifier = "w" * 64
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode("ascii").rstrip("=")


async def _register_user(http_client: httpx.AsyncClient) -> tuple[dict[str, str], str]:
    reg = (
        await http_client.post("/auth/register", json={"email": "consent@example.com", "password": "password123"})
    ).json()
    return {"Authorization": f"Bearer {reg['access_token']}"}, reg["user"]["id"]


async def _register_client(http_client: httpx.AsyncClient) -> str:
    dcr = await http_client.post(
        "/oauth/register",
        json={"client_name": "Cursor", "redirect_uris": [REDIRECT_URI]},
    )
    assert dcr.status_code == 201
    return dcr.json()["client_id"]


async def test_metadata_points_authorization_endpoint_at_web_origin(http_client: httpx.AsyncClient) -> None:
    asm = (await http_client.get("/.well-known/oauth-authorization-server")).json()
    assert asm["authorization_endpoint"] == f"{WEB_ORIGIN}/oauth/authorize"
    # Everything else stays on the control plane.
    assert asm["issuer"] == "https://aa.example.test"
    assert asm["token_endpoint"] == "https://aa.example.test/oauth/token"
    assert asm["registration_endpoint"] == "https://aa.example.test/oauth/register"


async def test_browser_navigation_redirects_to_web_consent_with_same_query(http_client: httpx.AsyncClient) -> None:
    client_id = await _register_client(http_client)
    query = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "scope": "devices:read sessions:read",
        "state": "st&te=1",
        "code_challenge": _challenge(),
        "code_challenge_method": "S256",
        "resource": "https://aa.example.test/mcp",
    }
    res = await http_client.get("/oauth/authorize", params=query, follow_redirects=False)
    assert res.status_code == 302
    assert res.headers["cache-control"] == "no-store"
    location = urlsplit(res.headers["location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == f"{WEB_ORIGIN}/oauth/authorize"
    forwarded = {k: v[0] for k, v in parse_qs(location.query).items()}
    assert forwarded == query


async def test_browser_navigation_without_query_still_redirects(http_client: httpx.AsyncClient) -> None:
    res = await http_client.get("/oauth/authorize", follow_redirects=False)
    assert res.status_code == 302
    assert res.headers["location"] == f"{WEB_ORIGIN}/oauth/authorize"


async def test_bearer_callers_keep_json_preview(app, http_client: httpx.AsyncClient) -> None:
    headers, user_id = await _register_user(http_client)
    await app.state.device_service.register_device(
        user_id=user_id,
        req=RegisterDeviceRequest(name="Mac", platform="macos", mode_hint="normal"),
        actor=f"user:{user_id}",
    )
    client_id = await _register_client(http_client)
    res = await http_client.get(
        "/oauth/authorize",
        headers=headers,
        params={"client_id": client_id, "redirect_uri": REDIRECT_URI, "scope": "devices:read"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["client_name"] == "Cursor"
    assert [d["name"] for d in body["eligible_devices"]] == ["Mac"]

    # Bearer present but invalid: 401 JSON, never a redirect.
    bad = await http_client.get(
        "/oauth/authorize",
        headers={"Authorization": "Bearer nope"},
        params={"client_id": client_id, "redirect_uri": REDIRECT_URI},
        follow_redirects=False,
    )
    assert bad.status_code == 401

    # Bearer present but parameters missing: validation error instead of a 422 from FastAPI parsing.
    missing = await http_client.get("/oauth/authorize", headers=headers)
    assert missing.status_code == 422


async def test_preview_rejects_unregistered_redirect_uri(http_client: httpx.AsyncClient) -> None:
    headers, _ = await _register_user(http_client)
    client_id = await _register_client(http_client)
    res = await http_client.get(
        "/oauth/authorize",
        headers=headers,
        params={"client_id": client_id, "redirect_uri": "https://evil.example/callback"},
    )
    assert res.status_code == 422


async def test_approve_validates_redirect_uri_and_passes_state(http_client: httpx.AsyncClient) -> None:
    headers, _ = await _register_user(http_client)
    client_id = await _register_client(http_client)
    base = {
        "client_id": client_id,
        "code_challenge": _challenge(),
        "code_challenge_method": "S256",
        "scopes": ["devices:read"],
        "device_ids": [],
    }

    rejected = await http_client.post(
        "/oauth/authorize",
        headers=headers,
        json={**base, "redirect_uri": "https://evil.example/callback", "state": "abc"},
    )
    assert rejected.status_code == 422

    approved = await http_client.post(
        "/oauth/authorize",
        headers=headers,
        json={**base, "redirect_uri": REDIRECT_URI, "state": "a b&c"},
    )
    assert approved.status_code == 200
    body = approved.json()
    target = urlsplit(body["redirect_url"])
    assert f"{target.scheme}://{target.netloc}{target.path}" == REDIRECT_URI
    params = {k: v[0] for k, v in parse_qs(target.query).items()}
    assert params == {"code": body["code"], "state": "a b&c"}

    # Approving still requires the user's Bearer token.
    anonymous = await http_client.post("/oauth/authorize", json={**base, "redirect_uri": REDIRECT_URI})
    assert anonymous.status_code == 401
