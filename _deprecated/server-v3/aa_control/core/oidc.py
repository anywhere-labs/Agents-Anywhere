from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

import jwt

from aa_control.core.entitlements import EntitlementMap, merge_entitlements
from aa_control.core.errors import UnauthenticatedError

# Asymmetric JWS algorithms only: never allow HS* or "none" in OIDC JWKS verification
# to prevent algorithm-confusion attacks.
ALLOWED_OIDC_ALGORITHMS: frozenset[str] = frozenset(
    {"RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512", "EdDSA"}
)
DEFAULT_OIDC_ALGORITHMS: tuple[str, ...] = (
    "RS256",
    "RS384",
    "RS512",
    "ES256",
    "ES384",
    "ES512",
    "EdDSA",
)
ALLOWED_TOKEN_TYPES: frozenset[str] = frozenset({"jwt", "at+jwt", "application/at+jwt"})


@dataclass(frozen=True)
class OidcDiscoveryDocument:
    issuer: str
    jwks_uri: str | None = None
    authorization_endpoint: str | None = None
    token_endpoint: str | None = None
    userinfo_endpoint: str | None = None
    end_session_endpoint: str | None = None


@dataclass(frozen=True)
class VerifiedOidcIdentity:
    """Normalized identity and entitlement claims extracted from a verified OIDC JWT."""

    issuer: str
    subject: str
    email: str | None
    email_verified: bool
    display_name: str
    role: Literal["admin", "member"]
    plan: str | None
    entitlements: EntitlementMap
    active_context: dict[str, Any] | None
    raw_claims: dict[str, Any]


def inspect_jwt_header(
    token: str,
    *,
    allowed_algorithms: Sequence[str] = DEFAULT_OIDC_ALGORITHMS,
) -> tuple[str, str | None]:
    """Validate unverified JWT header (syntax, asymmetric algorithm, token type)."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise UnauthenticatedError("malformed JWT") from exc

    alg = header.get("alg")
    if not isinstance(alg, str) or alg not in ALLOWED_OIDC_ALGORITHMS or alg not in allowed_algorithms:
        raise UnauthenticatedError("unsupported JWT signing algorithm")

    typ = header.get("typ")
    if typ is not None:
        if not isinstance(typ, str) or typ.strip().lower() not in ALLOWED_TOKEN_TYPES:
            raise UnauthenticatedError("unsupported JWT token type")

    raw_kid = header.get("kid")
    kid = str(raw_kid) if isinstance(raw_kid, str) and raw_kid else None
    return alg, kid


def parse_jwk_set(jwks_payload: Mapping[str, Any]) -> tuple[dict[str, Any], tuple[Any, ...]]:
    """Parse a JWKS JSON object into signing public keys indexed by kid."""
    raw_keys = jwks_payload.get("keys")
    if not isinstance(raw_keys, list):
        return {}, ()
    by_kid: dict[str, Any] = {}
    all_keys: list[Any] = []
    for item in raw_keys:
        if not isinstance(item, Mapping):
            continue
        use = item.get("use")
        if use is not None and use != "sig":
            continue
        try:
            key = jwt.PyJWK.from_dict(dict(item)).key
        except Exception:  # noqa: BLE001
            # Skip unknown/unsupported key types in third-party JWKS documents.
            continue
        all_keys.append(key)
        kid = item.get("kid")
        if isinstance(kid, str) and kid:
            by_kid[kid] = key
    return by_kid, tuple(all_keys)


def verify_oidc_jwt_with_keys(
    token: str,
    *,
    alg: str,
    candidate_keys: Sequence[Any],
    issuer: str,
    audiences: Sequence[str] = (),
    verify_audience: bool = True,
    leeway_seconds: int = 30,
    role_claim: str = "role",
    admin_roles: Sequence[str] = ("admin",),
    plan_claim: str = "plan",
    entitlements_claim: str = "entitlements",
    default_entitlements: Mapping[str, Any] | None = None,
) -> VerifiedOidcIdentity:
    """Verify an OIDC JWT locally against parsed JWKS public key(s) and normalize claims."""
    if not candidate_keys:
        raise UnauthenticatedError("unknown signing key")

    if verify_audience and not audiences:
        raise UnauthenticatedError("OIDC audience verification is enabled without configured audiences")

    options: dict[str, Any] = {
        "verify_signature": True,
        "verify_exp": True,
        "verify_nbf": True,
        "verify_iat": True,
        "verify_iss": True,
        "verify_aud": verify_audience,
        "require": ["exp", "iss", "sub"],
    }
    audience_arg: list[str] | str | None = None
    if verify_audience:
        audience_arg = list(audiences) if len(audiences) > 1 else audiences[0]

    claims: dict[str, Any] | None = None
    last_error: Exception | None = None
    for key in candidate_keys:
        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=[alg],
                issuer=issuer,
                audience=audience_arg,
                leeway=leeway_seconds,
                options=options,
            )
            break
        except (jwt.InvalidSignatureError, jwt.InvalidKeyError) as exc:
            last_error = exc
            continue
        except jwt.PyJWTError as exc:
            raise UnauthenticatedError(f"invalid or expired OIDC token: {exc}") from exc

    if claims is None:
        raise UnauthenticatedError(f"invalid OIDC token signature: {last_error}")

    raw_sub = claims.get("sub")
    if not isinstance(raw_sub, str) or not raw_sub.strip():
        raise UnauthenticatedError("OIDC token missing subject")
    subject = raw_sub.strip()

    raw_email = claims.get("email")
    email = raw_email.strip().lower() if isinstance(raw_email, str) and raw_email.strip() else None
    email_verified = bool(claims.get("email_verified") is True)

    display_name = _extract_display_name(claims, email=email, subject=subject)
    role = _extract_role(claims, role_claim=role_claim, admin_roles=admin_roles)

    raw_plan = claims.get(plan_claim)
    plan = raw_plan.strip() if isinstance(raw_plan, str) and raw_plan.strip() else None

    raw_entitlements = claims.get(entitlements_claim)
    entitlements = merge_entitlements(
        default_entitlements,
        raw_entitlements if isinstance(raw_entitlements, Mapping) else None,
    )
    active_context = _extract_active_context(claims.get("active_context"))

    return VerifiedOidcIdentity(
        issuer=str(claims.get("iss") or issuer),
        subject=subject,
        email=email,
        email_verified=email_verified,
        display_name=display_name,
        role=role,
        plan=plan,
        entitlements=entitlements,
        active_context=active_context,
        raw_claims=dict(claims),
    )


def _extract_display_name(claims: Mapping[str, Any], *, email: str | None, subject: str) -> str:
    for key in ("name", "preferred_username", "nickname"):
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    if email and "@" in email:
        return email.split("@", 1)[0]
    return subject


def _extract_role(
    claims: Mapping[str, Any],
    *,
    role_claim: str,
    admin_roles: Sequence[str],
) -> Literal["admin", "member"]:
    admin_set = {r.strip().lower() for r in admin_roles if r.strip()}
    if not admin_set:
        return "member"

    candidates: list[str] = []
    primary = claims.get(role_claim)
    if isinstance(primary, str):
        candidates.append(primary)
    elif isinstance(primary, list):
        candidates.extend(str(item) for item in primary if isinstance(item, str))

    # Standard third-party OIDC patterns: top-level `roles`, `groups`, or Keycloak `realm_access.roles`.
    for fallback_key in ("roles", "groups"):
        if fallback_key == role_claim:
            continue
        extra = claims.get(fallback_key)
        if isinstance(extra, list):
            candidates.extend(item for item in extra if isinstance(item, str))

    realm_access = claims.get("realm_access")
    if isinstance(realm_access, Mapping):
        realm_roles = realm_access.get("roles")
        if isinstance(realm_roles, list):
            candidates.extend(item for item in realm_roles if isinstance(item, str))

    for candidate in candidates:
        if candidate.strip().lower() in admin_set:
            return "admin"
    return "member"


def _extract_active_context(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping):
        return None
    ctx_type = raw.get("type")
    if ctx_type == "personal":
        return {"type": "personal"}
    if ctx_type == "organization":
        ctx: dict[str, Any] = {"type": "organization"}
        for field_name in ("org_id", "org_slug", "org_name", "org_role"):
            value = raw.get(field_name)
            if isinstance(value, str) and value.strip():
                ctx[field_name] = value.strip()
        return ctx
    return None
