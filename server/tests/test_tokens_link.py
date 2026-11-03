from __future__ import annotations

import base64
import hashlib
import json
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from test_model_config import (
    CODEX_LIKE,
    _applied,
    _client,
    _overview,
    _runtimes,
    _target,
)

from agent_server.infra.tokens_client import TokensClient

ISSUER = "https://tokens.test"
SETTINGS = "#/settings/model-configs"


class FakeTokens:
    """Tokens Anywhere as far as an AA instance sees it."""

    def __init__(self) -> None:
        self.challenge: str | None = None
        self.redirect_uri: str | None = None
        self.refresh_count = 0
        self.refresh = "rt-0"
        self.access = "at-0"
        self.secret = "sk-aa-secret-0001"
        self.revoked: list[str] = []
        self.refresh_error: str | None = None

    def _pair(self) -> httpx.Response:
        self.refresh_count += 1
        self.refresh = f"rt-{self.refresh_count}"
        self.access = f"at-{self.refresh_count}"
        return httpx.Response(
            200,
            json={
                "access_token": self.access,
                "token_type": "Bearer",
                "expires_in": 3600,
                "refresh_token": self.refresh,
                "scope": "",
            },
        )

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/v1/oauth/token":
            form = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
            assert form["client_id"] == "agents-anywhere"
            if form["grant_type"] == "authorization_code":
                digest = hashlib.sha256(form["code_verifier"].encode()).digest()
                challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
                if form["code"] != "good-code" or challenge != self.challenge:
                    return httpx.Response(400, json={"error": "invalid_grant"})
                assert form["redirect_uri"] == self.redirect_uri
                return self._pair()
            if self.refresh_error or form["refresh_token"] != self.refresh:
                return httpx.Response(400, json={"error": self.refresh_error or "invalid_grant"})
            return self._pair()
        if path == "/api/v1/oauth/revoke":
            self.revoked.append(parse_qs(request.content.decode())["token"][0])
            return httpx.Response(200, json={})
        if path == "/api/v1/pricing":
            return httpx.Response(
                200, json={"groups": [], "profiles": {"gpt-5": {"displayName": "GPT-5", "capabilities": ["vision"]}}}
            )
        if path == "/v1/models":
            assert request.headers["authorization"] == f"Bearer {self.secret}"
            if request.headers.get("anthropic-version"):
                return httpx.Response(200, json={"data": [{"type": "model", "id": "claude-x"}]})
            return httpx.Response(
                200,
                json={
                    "object": "list",
                    "data": [
                        {"id": "gpt-5", "owned_by": "openai"},
                        {"id": "deepseek-v3", "owned_by": "deepseek"},
                    ],
                },
            )
        if request.headers.get("authorization") != f"Bearer {self.access}":
            return httpx.Response(401, json={"code": "unauthenticated"})
        if path == "/api/v1/me":
            return httpx.Response(200, json={"id": "42", "displayName": "Ada", "email": "ada@example.com"})
        key = {"id": "7", "prefix": self.secret[:8], "strategy": {"id": "1", "name": "Default"}}
        if path == "/api/v1/keys/managed":
            return httpx.Response(200, json={"key": key, "secret": self.secret})
        if path == "/api/v1/keys/7/rotate":
            self.secret = "sk-aa-secret-0002"
            return httpx.Response(200, json={"key": {**key, "prefix": self.secret[:8]}, "secret": self.secret})
        return httpx.Response(404, json={"code": "not_found"})


@pytest.fixture
def tokens(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    fake = FakeTokens()
    client.app.state.tokens_client_factory = lambda base: TokensClient(
        base, transport=httpx.MockTransport(fake.handle)
    )
    configured = client.put("/admin/integrations/tokens", headers=headers, json={"tokensUrl": ISSUER + "/"})
    assert configured.status_code == 200, configured.text
    assert configured.json()["tokensUrl"] == ISSUER
    return client, fake, connector_id, headers


def _start(client, headers, fake: FakeTokens) -> tuple[str, str]:
    started = client.post("/integrations/tokens/link", headers=headers)
    assert started.status_code == 200, started.text
    start_url = urlsplit(started.json()["startUrl"])
    assert start_url.path == "/api/v2/integrations/tokens/start"
    opened = client.get(f"{start_url.path}?{start_url.query}", follow_redirects=False)
    assert opened.status_code == 302, opened.text
    authorize = urlsplit(opened.headers["location"])
    query = {key: values[0] for key, values in parse_qs(authorize.query).items()}
    assert f"{authorize.scheme}://{authorize.netloc}{authorize.path}" == f"{ISSUER}/oauth/authorize/"
    assert query["client_id"] == "agents-anywhere"
    assert query["code_challenge_method"] == "S256"
    assert query["redirect_uri"] == "http://testserver/api/v2/integrations/tokens/callback"
    fake.challenge = query["code_challenge"]
    fake.redirect_uri = query["redirect_uri"]
    return query["state"], start_url.query


def _callback(client, **params) -> httpx.Response:
    return client.get("/api/v2/integrations/tokens/callback", params=params, follow_redirects=False)


def _link(client, headers, fake) -> None:
    state, _ = _start(client, headers, fake)
    done = _callback(client, code="good-code", state=state, iss=ISSUER)
    assert done.status_code == 302, done.text
    assert done.headers["location"] == f"{ISSUER}/oauth/done/"


def _tokens_profile(client, headers) -> dict[str, Any]:
    return next(item for item in _overview(client, headers)["profiles"] if item["source"] == "tokens")


def test_link_apply_rotate_and_unlink(tokens):
    client, fake, connector_id, headers = tokens

    _link(client, headers, fake)

    status = client.get("/integrations/tokens", headers=headers).json()
    assert status["available"] is True
    assert status["link"]["status"] == "linked"
    assert status["link"]["account"] == {"id": "42", "displayName": "Ada", "email": "ada@example.com"}
    profile = _tokens_profile(client, headers)
    offers = {offer["format"]: offer for offer in profile["offers"]}
    assert [model["id"] for model in offers["openai_responses"]["models"]] == ["gpt-5"]
    assert [model["id"] for model in offers["openai_chat"]["models"]] == ["gpt-5", "deepseek-v3"]
    assert offers["anthropic"]["baseUrl"] == ISSUER
    assert offers["openai_responses"]["baseUrl"] == f"{ISSUER}/v1"
    assert offers["openai_responses"]["models"][0] == {
        "id": "gpt-5",
        "name": "GPT-5",
        "efforts": [],
        "input": ["text", "image"],
    }
    assert profile["keyHint"] == "sk-aa-se"

    _applied(client, headers, profile["id"], [_target(connector_id)])
    runtime = _runtimes(client, connector_id, headers)["codex"]
    assert runtime["config"]["modelGateway"] == {"baseUrl": f"{ISSUER}/v1"}
    assert runtime["secretFields"]["modelGateway.apiKey"]["hint"] == "sk-aa-s…0001"

    # Without a cached access token the next call refreshes, rotating the refresh token.
    client.app.state.tokens_access_cache._memory.clear()
    rotated = client.post(
        f"/model-profiles/{profile['id']}/rotate-key",
        headers={**headers, "Idempotency-Key": "rotate-1"},
        json={"allowInterrupt": True},
    )
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["results"][0]["result"] == "applied"
    assert fake.refresh == "rt-2"
    runtime = _runtimes(client, connector_id, headers)["codex"]
    assert runtime["secretFields"]["modelGateway.apiKey"]["hint"] == "sk-aa-s…0002"

    unlinked = client.delete("/integrations/tokens/link", headers=headers, params={"allow_interrupt": "true"})
    assert unlinked.status_code == 200, unlinked.text
    assert unlinked.json() == {
        "revoked": True,
        "results": [{"connectorId": connector_id, "runtimeId": "codex", "result": "restored"}],
    }
    assert fake.revoked == ["rt-2"]
    assert "modelGateway" not in _runtimes(client, connector_id, headers)["codex"]["config"]
    overview = _overview(client, headers)
    assert overview["profiles"] == []
    assert overview["assignments"] == []
    assert client.get("/integrations/tokens", headers=headers).json()["link"] is None


def test_callback_needs_the_browser_and_issuer_that_started_it(tokens):
    client, fake, _connector_id, headers = tokens

    state, start_query = _start(client, headers, fake)
    reopened = client.get(f"/api/v2/integrations/tokens/start?{start_query}", follow_redirects=False)
    wrong_issuer = _callback(client, code="good-code", state=state, iss="https://evil.test")
    replayed = _callback(client, code="good-code", state=state, iss=ISSUER)

    assert reopened.headers["location"] == f"http://testserver/?tokensLink=link_expired{SETTINGS}"
    assert wrong_issuer.headers["location"] == f"http://testserver/?tokensLink=invalid_issuer{SETTINGS}"
    # A state works once, even after a failed attempt.
    assert replayed.headers["location"] == f"http://testserver/?tokensLink=invalid_state{SETTINGS}"

    state, _ = _start(client, headers, fake)
    client.cookies.clear()
    other_browser = _callback(client, code="good-code", state=state, iss=ISSUER)
    assert other_browser.headers["location"] == f"http://testserver/?tokensLink=invalid_state{SETTINGS}"
    assert client.get("/integrations/tokens", headers=headers).json()["link"] is None


def test_denied_authorization_links_nothing(tokens):
    client, fake, _connector_id, headers = tokens
    state, _ = _start(client, headers, fake)

    denied = _callback(client, error="access_denied", state=state, iss=ISSUER)

    assert denied.headers["location"] == f"http://testserver/?tokensLink=access_denied{SETTINGS}"
    assert client.get("/integrations/tokens", headers=headers).json()["link"] is None


def test_revoked_refresh_token_asks_to_link_again(tokens):
    client, fake, connector_id, headers = tokens
    _link(client, headers, fake)
    profile = _tokens_profile(client, headers)
    client.app.state.tokens_access_cache._memory.clear()
    fake.refresh_error = "invalid_grant"

    applied = _applied(client, headers, profile["id"], [_target(connector_id)])

    assert applied["results"][0]["reason"] == "reauth_required"
    preview = client.post(
        "/model-config/assignments/preview", headers=headers, json={"profileId": profile["id"]}
    ).json()
    assert preview["targets"][0]["decision"] == "apply"
    status = client.get("/integrations/tokens", headers=headers).json()
    assert status["link"]["status"] == "reauth_required"
    assert "rt-" not in json.dumps(status)


def test_tokens_address_is_an_instance_setting(tmp_path, server_secret):
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)

    unset = client.get("/integrations/tokens", headers=headers).json()
    refused = client.post("/integrations/tokens/link", headers=headers)
    invalid = client.put("/admin/integrations/tokens", headers=headers, json={"tokensUrl": "https://x.test/path"})

    assert unset["available"] is False
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == "tokens_unconfigured"
    assert invalid.status_code == 422, invalid.text


def test_address_cannot_change_while_accounts_are_linked(tokens):
    client, fake, _connector_id, headers = tokens
    _link(client, headers, fake)

    changed = client.put("/admin/integrations/tokens", headers=headers, json={"tokensUrl": "https://other.test"})
    same = client.put("/admin/integrations/tokens", headers=headers, json={"tokensUrl": ISSUER})

    assert changed.status_code == 409, changed.text
    assert changed.json()["detail"]["code"] == "tokens_links_exist"
    assert same.status_code == 200, same.text
    assert same.json()["linkedAccounts"] == 1


def test_snapshot_carries_the_link(tokens):
    client, fake, _connector_id, headers = tokens
    _link(client, headers, fake)
    ticket = client.post(
        "/ws-ticket", headers=headers, json={"clientId": "web_tokens", "scope": {"dashboard": True}}
    ).json()["ticket"]

    with client.websocket_connect(f"/dashboard/ws?ticket={ticket}") as ws:
        snapshot = ws.receive_json()

    assert snapshot["modelConfig"]["tokens"]["link"]["status"] == "linked"
    assert fake.secret not in json.dumps(snapshot)
    assert fake.refresh not in json.dumps(snapshot)


def test_rotation_with_running_tasks_needs_permission_first(tokens):
    client, fake, connector_id, headers = tokens
    _link(client, headers, fake)
    profile = _tokens_profile(client, headers)
    _applied(client, headers, profile["id"], [_target(connector_id)])

    async def one_running_session(**_kwargs):
        return [{"id": "ses_running"}]

    client.app.state.store.list_running_sessions_for_connector_agent = one_running_session
    refused = client.post(
        f"/model-profiles/{profile['id']}/rotate-key",
        headers={**headers, "Idempotency-Key": "rotate-busy"},
        json={"allowInterrupt": False},
    )

    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == "busy"
    # Nothing was rotated, so the runtime's key still works.
    assert fake.secret == "sk-aa-secret-0001"


def test_runtimes_left_on_the_old_key_are_marked_failed(tokens):
    client, fake, connector_id, headers = tokens
    _link(client, headers, fake)
    profile = _tokens_profile(client, headers)
    _applied(client, headers, profile["id"], [_target(connector_id)])
    client.app.state.rpc.online = False

    rotated = client.post(
        f"/model-profiles/{profile['id']}/rotate-key",
        headers={**headers, "Idempotency-Key": "rotate-offline"},
        json={"allowInterrupt": True},
    )

    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["results"][0]["result"] != "applied"
    [assignment] = _overview(client, headers)["assignments"]
    assert assignment["status"] == "failed"
    assert assignment["error"]["code"] == "key_rotated"
