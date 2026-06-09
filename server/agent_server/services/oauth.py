from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

from agent_server.core.auth import create_signed_token, verify_signed_token
from agent_server.infra.repositories.facade import Store
from agent_server.infra.repositories.store_support import USERNAME_RE


OAUTH_STATE_TOKEN_KIND = "oauth_state"
OAUTH_PENDING_TOKEN_KIND = "oauth_pending"
OAUTH_TOKEN_EXPIRES_IN = 10 * 60


@dataclass(frozen=True)
class OAuthIdentity:
    provider: str
    provider_label: str
    subject: str
    suggested_user_id: str
    email: str | None
    display_name: str | None


class OAuthConfigError(ValueError):
    pass


def public_oauth_config(config: dict[str, Any] | None) -> dict[str, Any] | None:
    if not config:
        return None
    return {key: value for key, value in config.items() if key != "clientSecret"}


def oauth_enabled(config: dict[str, Any] | None) -> bool:
    return bool(config and config.get("enabled") and config.get("authorizeUrl") and config.get("clientId"))


def build_authorize_url(config: dict[str, Any], *, redirect_uri: str, return_to: str | None = None) -> str:
    _require_enabled_config(config)
    state = None
    if return_to:
        state = create_signed_token(
            OAUTH_STATE_TOKEN_KIND,
            {"provider": _provider(config), "returnTo": return_to},
            OAUTH_TOKEN_EXPIRES_IN,
        )
    params = {
        "client_id": str(config["clientId"]),
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": str(config.get("scopes") or "openid profile email"),
        **({"state": state} if state else {}),
    }
    return f"{config['authorizeUrl']}?{urlencode(params)}"


async def exchange_code_for_identity(
    config: dict[str, Any],
    *,
    code: str,
    state: str | None,
    redirect_uri: str,
) -> OAuthIdentity:
    _require_enabled_config(config)
    provider = _provider(config)
    if state:
        state_payload = verify_signed_token(OAUTH_STATE_TOKEN_KIND, state)
        if not state_payload or state_payload.get("provider") != provider:
            raise OAuthConfigError("invalid oauth state")
    missing = [key for key in ("tokenUrl", "userInfoUrl", "clientSecret") if not config.get(key)]
    if missing:
        raise OAuthConfigError(f"oauth config missing: {', '.join(missing)}")
    async with httpx.AsyncClient(timeout=10) as client:
        token_response = await client.post(
            str(config["tokenUrl"]),
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": str(config["clientId"]),
                "client_secret": str(config["clientSecret"]),
            },
            headers={"Accept": "application/json"},
        )
        token_response.raise_for_status()
        token_payload = token_response.json()
        access_token = token_payload.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise OAuthConfigError("oauth token response did not include access_token")
        userinfo_response = await client.get(
            str(config["userInfoUrl"]),
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        )
        userinfo_response.raise_for_status()
        claims = userinfo_response.json()
    return identity_from_claims(config, claims)


def return_to_from_state(config: dict[str, Any], state: str | None) -> str | None:
    if not state:
        return None
    payload = verify_signed_token(OAUTH_STATE_TOKEN_KIND, state)
    if not payload:
        return None
    provider = payload.get("provider")
    if provider is not None and provider != _provider(config):
        return None
    return_to = payload.get("returnTo")
    return return_to if isinstance(return_to, str) and return_to else None


def identity_from_claims(config: dict[str, Any], claims: dict[str, Any]) -> OAuthIdentity:
    provider = _provider(config)
    subject_claim = str(config.get("subjectClaim") or "sub")
    username_claim = str(config.get("usernameClaim") or "preferred_username")
    email_claim = str(config.get("emailClaim") or "email")
    name_claim = str(config.get("nameClaim") or "name")
    subject = _claim_text(claims, subject_claim)
    if not subject:
        raise OAuthConfigError(f"oauth userinfo missing subject claim: {subject_claim}")
    email = _claim_text(claims, email_claim)
    display_name = _claim_text(claims, name_claim)
    suggested = _claim_text(claims, username_claim) or _email_user(email) or display_name or subject
    return OAuthIdentity(
        provider=provider,
        provider_label=str(config.get("label") or "OAuth"),
        subject=subject,
        suggested_user_id=normalize_suggested_user_id(suggested),
        email=email,
        display_name=display_name,
    )


def create_pending_token(identity: OAuthIdentity) -> str:
    return create_signed_token(
        OAUTH_PENDING_TOKEN_KIND,
        {
            "provider": identity.provider,
            "providerLabel": identity.provider_label,
            "subject": identity.subject,
            "suggestedUserId": identity.suggested_user_id,
            "email": identity.email,
            "displayName": identity.display_name,
        },
        OAUTH_TOKEN_EXPIRES_IN,
    )


def verify_pending_token(token: str) -> OAuthIdentity | None:
    payload = verify_signed_token(OAUTH_PENDING_TOKEN_KIND, token)
    if not payload:
        return None
    provider = payload.get("provider")
    subject = payload.get("subject")
    suggested = payload.get("suggestedUserId")
    if not isinstance(provider, str) or not isinstance(subject, str) or not isinstance(suggested, str):
        return None
    return OAuthIdentity(
        provider=provider,
        provider_label=str(payload.get("providerLabel") or "OAuth"),
        subject=subject,
        suggested_user_id=suggested,
        email=payload.get("email") if isinstance(payload.get("email"), str) else None,
        display_name=payload.get("displayName") if isinstance(payload.get("displayName"), str) else None,
    )


async def unique_user_id(store: Store, preferred: str) -> str:
    base = normalize_suggested_user_id(preferred)
    if not await store.user_exists(base):
        return base
    for suffix in range(2, 1000):
        trimmed = base[: max(3, 32 - len(str(suffix)) - 1)]
        candidate = f"{trimmed}-{suffix}"
        if not await store.user_exists(candidate):
            return candidate
    raise OAuthConfigError("could not allocate user id")


def normalize_suggested_user_id(value: str | None) -> str:
    text = (value or "").strip().lower()
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in text)
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    if len(cleaned) < 3:
        cleaned = f"user-{cleaned}" if cleaned else "user"
    cleaned = cleaned[:32].strip("-_") or "user"
    if len(cleaned) < 3:
        cleaned = (cleaned + "-user")[:32]
    if USERNAME_RE.match(cleaned):
        return cleaned
    return "user"


def _required_config(config: dict[str, Any]) -> bool:
    return bool(config.get("authorizeUrl") and config.get("clientId"))


def _require_enabled_config(config: dict[str, Any]) -> None:
    if not oauth_enabled(config):
        raise OAuthConfigError("oauth is not configured")


def _provider(config: dict[str, Any]) -> str:
    return str(config.get("provider") or "oidc").strip().lower()


def _claim_text(claims: dict[str, Any], key: str) -> str | None:
    value = claims.get(key)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _email_user(email: str | None) -> str | None:
    if not email or "@" not in email:
        return None
    return email.split("@", 1)[0]
