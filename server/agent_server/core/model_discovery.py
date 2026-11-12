"""What a model gateway speaks, found from its address and key.

A manual profile can be entered as just an address and a key. The protocols
come from calling each protocol's route with an empty request body: a route
that exists rejects the body with a JSON error (400 or 422), one that does not
answers 404 or 405. No call names a model, so nothing is generated and nothing
is billed. The models come from the gateway's ``/models`` lists.

This module only plans the calls and reads their answers; infra makes them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlsplit

from agent_server.core.model_config import (
    MAX_OFFER_MODELS,
    ModelSpec,
    Offer,
    gateway_url,
)
from agent_server.core.model_connection import ModelProtocol

ANTHROPIC_VERSION = "2023-06-01"

RouteOutcome = Literal["supported", "absent", "unauthorized", "unknown"]
DiscoveryFailure = Literal["gateway_unreachable", "gateway_key_rejected", "gateway_protocols_unknown"]


@dataclass(frozen=True, slots=True)
class ProbeRequest:
    name: str
    method: Literal["GET", "POST"]
    url: str
    headers: dict[str, str]


@dataclass(frozen=True, slots=True)
class ProbeResponse:
    """An answer, or ``status=None`` with ``error`` when none came back."""

    status: int | None
    body: Any = None
    is_json: bool = False
    error: str | None = None


@dataclass(frozen=True, slots=True)
class GatewayBases:
    # Where the OpenAI routes may live, most likely first: ``…/v1`` usually,
    # but gateways such as ``…/api/v3`` serve them at the address as given.
    openai: tuple[str, ...]
    # Anthropic clients add ``/v1/messages`` themselves (ANTHROPIC_BASE_URL).
    anthropic: str


@dataclass(frozen=True, slots=True)
class Discovery:
    offers: list[Offer]
    failure: DiscoveryFailure | None = None


def gateway_bases(address: str) -> GatewayBases:
    """The base URLs to try for an address entered either with or without ``/v1``."""
    url = gateway_url(address)
    path = urlsplit(url).path
    if path.endswith("/v1"):
        return GatewayBases(openai=(url,), anthropic=url[: -len("/v1")])
    if not path:
        return GatewayBases(openai=(f"{url}/v1",), anthropic=url)
    return GatewayBases(openai=(url, f"{url}/v1"), anthropic=url)


def discovery_requests(bases: GatewayBases, api_key: str) -> list[ProbeRequest]:
    bearer = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
    anthropic = {**bearer, "x-api-key": api_key, "anthropic-version": ANTHROPIC_VERSION}
    requests: list[ProbeRequest] = []
    for index, base in enumerate(bases.openai):
        requests += [
            ProbeRequest(f"openai_models:{index}", "GET", f"{base}/models", bearer),
            ProbeRequest(f"openai_chat:{index}", "POST", f"{base}/chat/completions", bearer),
            ProbeRequest(f"openai_responses:{index}", "POST", f"{base}/responses", bearer),
        ]
    requests += [
        ProbeRequest("anthropic_models", "GET", f"{bases.anthropic}/v1/models", anthropic),
        ProbeRequest("anthropic", "POST", f"{bases.anthropic}/v1/messages", anthropic),
    ]
    return requests


def route_outcome(response: ProbeResponse) -> RouteOutcome:
    """What an empty-body call says about the route it was sent to."""
    status = response.status
    if status is None:
        return "unknown"
    if status in {401, 403}:
        return "unauthorized"
    if not response.is_json or status in {404, 405, 501}:
        # Many gateways answer unknown paths with their web page.
        return "absent"
    if 200 <= status < 300 or status in {400, 422, 429}:
        return "supported"
    return "unknown"


def listed_models(response: ProbeResponse | None) -> list[ModelSpec]:
    """Models from an OpenAI or Anthropic ``/models`` answer, in its order."""
    if response is None or response.status is None or not 200 <= response.status < 300:
        return []
    data = response.body.get("data") if isinstance(response.body, dict) else None
    specs: dict[str, ModelSpec] = {}
    for item in data if isinstance(data, list) else []:
        model_id = item.get("id") if isinstance(item, dict) else None
        if not isinstance(model_id, str) or not model_id.strip() or len(model_id) > 256 or model_id in specs:
            continue
        if "\r" in model_id or "\n" in model_id or "\x00" in model_id:
            continue
        name = item.get("display_name")
        specs[model_id] = ModelSpec(id=model_id, name=name[:128] if isinstance(name, str) and name.strip() else None)
        if len(specs) == MAX_OFFER_MODELS:
            break
    return list(specs.values())


def discovered_offers(bases: GatewayBases, responses: dict[str, ProbeResponse]) -> Discovery:
    """The offers the answers show, or why there are none."""
    offers: list[Offer] = []
    openai_models: list[ModelSpec] = []
    for index, base in enumerate(bases.openai):
        speaks: list[ModelProtocol] = [
            protocol
            for protocol in ("openai_responses", "openai_chat")
            if route_outcome(responses.get(f"{protocol}:{index}", ProbeResponse(None))) == "supported"
        ]
        if speaks:
            openai_models = listed_models(responses.get(f"openai_models:{index}"))
            offers += [Offer(format=protocol, baseUrl=base, models=openai_models) for protocol in speaks]
            break
    if route_outcome(responses.get("anthropic", ProbeResponse(None))) == "supported":
        # Gateways that list models only the OpenAI way serve the same ones here.
        models = listed_models(responses.get("anthropic_models")) or openai_models
        offers.append(Offer(format="anthropic", baseUrl=bases.anthropic, models=models))
    if offers:
        return Discovery(offers)
    routes = [response for name, response in responses.items() if "models" not in name]
    if all(response.status is None for response in routes):
        return Discovery([], "gateway_unreachable")
    if any(route_outcome(response) == "unauthorized" for response in routes):
        return Discovery([], "gateway_key_rejected")
    return Discovery([], "gateway_protocols_unknown")
