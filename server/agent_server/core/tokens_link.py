"""Linking a local account to Tokens Anywhere.

Tokens Anywhere is the OAuth authorization server; every AA instance is the
public PKCE client ``agents-anywhere``, told apart by its origin (#510). The
link gives the instance a managed key, and the models that key can reach
become a ``source=tokens`` model profile. See
docs/model-config-management-proposal.md §3 and §4.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import timedelta
from typing import Any, Literal
from urllib.parse import urlencode, urlsplit

from agent_server.core.model_config import ModelSpec, Offer

CLIENT_ID = "agents-anywhere"
MANAGED_KEY_APP = "agents-anywhere"
PROFILE_NAME = "Tokens Anywhere"
# A start ticket is opened right after it is issued; the browser then has
# time to sign in to Tokens Anywhere before it comes back.
TICKET_TTL = timedelta(seconds=60)
BROWSER_TTL = timedelta(minutes=10)
ACCESS_TOKEN_MARGIN = timedelta(seconds=60)
# Refresh tokens expire after 90 idle days; refresh those unused for 30.
KEEP_ALIVE_AFTER = timedelta(days=30)
RELINK_AFTER = timedelta(days=335)

LinkStatus = Literal["linked", "reauth_required"]


def normalize_tokens_url(value: str) -> str:
    """The Tokens Anywhere origin, or ValueError when it is not one."""
    value = value.strip().rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("the Tokens Anywhere address must be an HTTP or HTTPS origin")
    if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("the Tokens Anywhere address must be an origin without a path")
    return f"{parsed.scheme}://{parsed.netloc.lower()}"


def new_secret() -> str:
    return secrets.token_urlsafe(32)


def new_code_verifier() -> str:
    # RFC 7636: 43 to 128 characters.
    return secrets.token_urlsafe(48)


def code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def secret_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def authorize_url(issuer: str, *, redirect_uri: str, state: str, challenge: str) -> str:
    query = urlencode(
        {
            "response_type": "code",
            "client_id": CLIENT_ID,
            "redirect_uri": redirect_uri,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
    )
    return f"{issuer}/oauth/authorize/?{query}"


def public_account(me: dict[str, Any]) -> dict[str, Any]:
    """What of the Tokens account clients may show."""
    return {
        "id": str(me.get("id") or ""),
        "displayName": me.get("displayName") or me.get("loginName") or None,
        "email": me.get("email") or None,
    }


def key_ref(key: dict[str, Any]) -> dict[str, Any]:
    """The managed key's identity, never its secret."""
    strategy = key.get("strategy") if isinstance(key.get("strategy"), dict) else {}
    return {
        "id": str(key.get("id") or ""),
        "prefix": key.get("prefix") or None,
        "strategy": strategy.get("name") or None,
    }


def _spec(model_id: str, profiles: dict[str, Any], prices: dict[str, Any], vendor: str | None) -> ModelSpec:
    profile = profiles.get(model_id) if isinstance(profiles.get(model_id), dict) else {}
    price = prices.get(model_id) if isinstance(prices.get(model_id), dict) else {}
    capabilities = profile.get("capabilities") or []
    name = profile.get("displayName")
    context = profile.get("contextWindow")
    output = price.get("maxOutputTokens")
    maker = price.get("provider") or vendor
    return ModelSpec(
        id=model_id,
        name=name[:128] if isinstance(name, str) and name else None,
        input=["text", "image"] if "vision" in capabilities else ["text"],
        vendor=str(maker)[:32] if maker else None,
        contextWindow=context if isinstance(context, int) and context > 0 else None,
        maxOutputTokens=output if isinstance(output, int) and output > 0 else None,
    )


def price_index(pricing: dict[str, Any]) -> dict[str, Any]:
    """Each model's provider and output cap from ``/api/v1/pricing`` groups."""
    index: dict[str, Any] = {}
    for group in pricing.get("groups") or []:
        for model in (group.get("models") or []) if isinstance(group, dict) else []:
            if isinstance(model, dict) and isinstance(model.get("model"), str):
                index.setdefault(model["model"], model)
    return index


def _ids(models: list[dict[str, Any]], *, owner: str | None = None) -> list[str]:
    seen: list[str] = []
    for model in models:
        model_id = model.get("id")
        if not isinstance(model_id, str) or not model_id or model_id in seen:
            continue
        if owner is not None and model.get("owned_by") != owner:
            continue
        seen.append(model_id)
    return seen


def catalog_offers(
    issuer: str,
    *,
    openai_models: list[dict[str, Any]],
    anthropic_models: list[dict[str, Any]],
    profiles: dict[str, Any],
    prices: dict[str, Any] | None = None,
) -> list[Offer]:
    """Offers per protocol from what the key's ``/v1/models`` lists.

    Until Tokens Anywhere confirms other vendors work over the Responses API,
    ``openai_responses`` only carries OpenAI's own models (§3.5).
    """
    prices = prices or {}
    owners = {model.get("id"): model.get("owned_by") for model in openai_models if isinstance(model, dict)}
    groups = [
        ("openai_responses", f"{issuer}/v1", _ids(openai_models, owner="openai")),
        ("openai_chat", f"{issuer}/v1", _ids(openai_models)),
        ("anthropic", issuer, _ids(anthropic_models)),
    ]
    return [
        Offer(
            format=protocol,
            baseUrl=base,
            models=[
                _spec(model_id, profiles, prices, owners.get(model_id) or ("anthropic" if protocol == "anthropic" else None))
                for model_id in ids[:256]
            ],
        )
        for protocol, base, ids in groups
        if ids
    ]
