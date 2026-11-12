from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from test_model_config import CODEX_LIKE, PROFILE_KEY, _client, _overview

from agent_server.core.model_discovery import (
    ProbeResponse,
    discovered_offers,
    discovery_requests,
    gateway_bases,
    route_outcome,
)
from agent_server.infra.model_gateway_probe import (
    GatewayAddressNotAllowedError,
    GatewayProber,
)

PUBLIC_IP = "93.184.215.14"


def _json(status: int, body: Any = None) -> ProbeResponse:
    return ProbeResponse(status, body if body is not None else {"error": {"message": "bad request"}}, is_json=True)


def _gateway(*, routes: set[str], models: list[dict[str, Any]] | None = None, key: str = PROFILE_KEY, seen=None):
    """A gateway that serves ``routes`` under ``/v1`` and refuses other keys."""

    def handle(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        path = request.url.path
        if request.headers.get("authorization") != f"Bearer {key}":
            return httpx.Response(401, json={"error": {"message": "invalid key"}})
        if path == "/v1/models":
            return httpx.Response(200, json={"object": "list", "data": models or []})
        if path.removeprefix("/v1/") in routes:
            assert json.loads(request.content) == {}
            return httpx.Response(400, json={"error": {"message": "model is required"}})
        # Like many gateways: the web page for unknown paths.
        return httpx.Response(200, text="<html></html>", headers={"content-type": "text/html"})

    return handle


async def _public(host: str, port: int) -> list[str]:
    return [PUBLIC_IP]


def _use_gateway(client, handle, *, resolver=_public, allow_private: bool = False) -> None:
    client.app.state.gateway_prober = GatewayProber(
        allow_private=allow_private, transport=httpx.MockTransport(handle), resolver=resolver
    )


def _create(client, headers, base_url: str, *, key: str = PROFILE_KEY) -> httpx.Response:
    return client.post("/model-profiles", headers=headers, json={"name": "Relay", "apiKey": key, "baseUrl": base_url})


@pytest.mark.parametrize(
    ("address", "openai", "anthropic"),
    [
        ("https://relay.example", ("https://relay.example/v1",), "https://relay.example"),
        ("https://relay.example/v1/", ("https://relay.example/v1",), "https://relay.example"),
        (
            "https://ark.example/api/v3",
            ("https://ark.example/api/v3", "https://ark.example/api/v3/v1"),
            "https://ark.example/api/v3",
        ),
    ],
)
def test_an_address_with_or_without_v1_gives_both_bases(address, openai, anthropic):
    bases = gateway_bases(address)

    assert bases.openai == openai
    assert bases.anthropic == anthropic


def test_a_route_counts_only_when_it_rejects_the_body_in_json():
    assert route_outcome(_json(400)) == "supported"
    assert route_outcome(_json(422)) == "supported"
    assert route_outcome(_json(404)) == "absent"
    assert route_outcome(ProbeResponse(200)) == "absent"
    assert route_outcome(_json(401)) == "unauthorized"
    assert route_outcome(_json(500)) == "unknown"
    assert route_outcome(ProbeResponse(None, error="timeout")) == "unknown"


def test_the_failure_says_why_nothing_was_found():
    bases = gateway_bases("https://relay.example")
    names = ["openai_chat:0", "openai_responses:0", "anthropic"]

    assert discovered_offers(bases, {name: ProbeResponse(None, error="timeout") for name in names}).failure == "gateway_unreachable"
    assert discovered_offers(bases, {name: _json(401) for name in names}).failure == "gateway_key_rejected"
    assert discovered_offers(bases, {name: _json(404) for name in names}).failure == "gateway_protocols_unknown"


def test_a_profile_from_an_address_gets_the_protocols_and_models_the_gateway_has(tmp_path, server_secret):
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)
    seen: list[httpx.Request] = []
    models = [{"id": "gpt-5", "owned_by": "openai"}, {"id": "claude-sonnet", "display_name": "Claude Sonnet"}]
    _use_gateway(client, _gateway(routes={"chat/completions", "responses", "messages"}, models=models, seen=seen))

    response = _create(client, headers, "https://relay.example")

    assert response.status_code == 201, response.text
    offers = {offer["format"]: offer for offer in response.json()["offers"]}
    assert set(offers) == {"openai_responses", "openai_chat", "anthropic"}
    assert offers["openai_chat"]["baseUrl"] == "https://relay.example/v1"
    assert offers["anthropic"]["baseUrl"] == "https://relay.example"
    assert [model["id"] for model in offers["openai_chat"]["models"]] == ["gpt-5", "claude-sonnet"]
    assert offers["anthropic"]["models"][1]["name"] == "Claude Sonnet"
    # Calls go to the checked address, under the gateway's own name.
    assert {request.url.host for request in seen} == {PUBLIC_IP}
    assert {request.headers["host"] for request in seen} == {"relay.example"}
    # Only empty bodies: no model is ever named, so nothing is billed.
    assert all(request.content in {b"", b"{}"} for request in seen)
    assert PROFILE_KEY not in json.dumps(_overview(client, headers))


def test_a_chat_only_gateway_gets_only_chat(tmp_path, server_secret):
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _use_gateway(client, _gateway(routes={"chat/completions"}, models=[{"id": "deepseek-chat"}]))

    response = _create(client, headers, "https://relay.example/v1")

    assert response.status_code == 201, response.text
    assert [offer["format"] for offer in response.json()["offers"]] == ["openai_chat"]


@pytest.mark.parametrize(
    ("handle", "code"),
    [
        (_gateway(routes={"chat/completions"}, key="sk-other"), "gateway_key_rejected"),
        (_gateway(routes=set()), "gateway_protocols_unknown"),
    ],
)
def test_a_gateway_that_shows_nothing_is_refused_with_a_reason(tmp_path, server_secret, handle, code):
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _use_gateway(client, handle)

    response = _create(client, headers, "https://relay.example")

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == code
    assert PROFILE_KEY not in response.text
    assert _overview(client, headers)["profiles"] == []


@pytest.mark.parametrize("address", ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1"])
def test_private_addresses_are_not_called(tmp_path, server_secret, address):
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)
    seen: list[httpx.Request] = []

    async def private(host: str, port: int) -> list[str]:
        return [address]

    _use_gateway(client, _gateway(routes={"chat/completions"}, seen=seen), resolver=private)

    response = _create(client, headers, "https://relay.example")

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "gateway_address_not_allowed"
    assert seen == []


def test_a_private_address_written_as_ip_is_not_called_either():
    prober = GatewayProber(transport=httpx.MockTransport(_gateway(routes=set())))
    bases = gateway_bases("http://192.168.1.20:11434")

    with pytest.raises(GatewayAddressNotAllowedError):
        asyncio.run(prober.run(discovery_requests(bases, PROFILE_KEY)))


def test_deployments_can_allow_private_gateways(tmp_path, server_secret):
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)

    async def lan(host: str, port: int) -> list[str]:
        return ["192.168.1.20"]

    _use_gateway(client, _gateway(routes={"chat/completions"}), resolver=lan, allow_private=True)

    response = _create(client, headers, "http://gateway.lan:8080")

    assert response.status_code == 201, response.text


def test_redirects_are_not_followed(tmp_path, server_secret):
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest"})

    _use_gateway(client, handle)

    response = _create(client, headers, "https://relay.example")

    assert response.status_code == 422, response.text
    assert all(request.url.host == PUBLIC_IP for request in seen)


def test_an_address_and_offers_do_not_go_together(tmp_path, server_secret):
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)

    response = client.post(
        "/model-profiles",
        headers=headers,
        json={
            "name": "Relay",
            "apiKey": PROFILE_KEY,
            "baseUrl": "https://relay.example",
            "offers": [{"format": "openai_chat", "baseUrl": "https://relay.example/v1"}],
        },
    )

    assert response.status_code == 422
