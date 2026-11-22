from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Mapping
from typing import Any, Protocol

import httpx
from loguru import logger

from aa_control.core.config import OidcAuthConfig
from aa_control.core.errors import UnauthenticatedError, UpstreamUnavailableError
from aa_control.core.models import OidcPublicConfig
from aa_control.core.oidc import (
    OidcDiscoveryDocument,
    VerifiedOidcIdentity,
    inspect_jwt_header,
    parse_jwk_set,
    verify_oidc_jwt_with_keys,
)


class OidcVerifierPort(Protocol):
    async def verify_token(self, token: str) -> VerifiedOidcIdentity: ...

    async def public_config(self) -> OidcPublicConfig: ...

    async def close(self) -> None: ...


class OidcJwksVerifier:
    """Caches OIDC Discovery metadata and JWKS signing keys for local JWT verification."""

    def __init__(
        self,
        *,
        config: OidcAuthConfig,
        default_entitlements: Mapping[str, Any] | None = None,
        http_client: httpx.AsyncClient | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config
        self._default_entitlements = dict(default_entitlements or {})
        self._owns_client = http_client is None
        self._http = http_client or httpx.AsyncClient(timeout=10.0)
        self._clock = clock

        self._discovery_lock = asyncio.Lock()
        self._discovery: OidcDiscoveryDocument | None = None
        self._discovery_fetched_at: float = 0.0

        self._jwks_lock = asyncio.Lock()
        self._keys_by_kid: dict[str, Any] = {}
        self._all_keys: tuple[Any, ...] = ()
        self._jwks_fetched_at: float = 0.0

    async def close(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    async def public_config(self) -> OidcPublicConfig:
        doc: OidcDiscoveryDocument | None = None
        try:
            doc = await self._get_discovery()
        except UpstreamUnavailableError:
            logger.warning("OIDC discovery unavailable while serving /auth/config issuer={}", self._config.issuer)
        return OidcPublicConfig(
            issuer=self._config.issuer,
            client_id=self._config.client_id,
            scopes=self._config.scopes,
            authorization_endpoint=self._config.authorization_endpoint or (doc.authorization_endpoint if doc else None),
            token_endpoint=self._config.token_endpoint or (doc.token_endpoint if doc else None),
            userinfo_endpoint=self._config.userinfo_endpoint or (doc.userinfo_endpoint if doc else None),
            jwks_uri=self._config.jwks_uri or (doc.jwks_uri if doc else None),
            end_session_endpoint=self._config.end_session_endpoint or (doc.end_session_endpoint if doc else None),
        )

    async def verify_token(self, token: str) -> VerifiedOidcIdentity:
        alg, kid = inspect_jwt_header(token, allowed_algorithms=self._config.algorithms)
        by_kid, all_keys = await self._ensure_jwks(force_refresh=False)

        if kid is not None:
            key = by_kid.get(kid)
            if key is None:
                by_kid, all_keys = await self._ensure_jwks(force_refresh=True)
                key = by_kid.get(kid)
            candidates = (key,) if key is not None else ()
            return self._verify_with(token, alg=alg, candidate_keys=candidates)

        try:
            return self._verify_with(token, alg=alg, candidate_keys=all_keys)
        except UnauthenticatedError:
            _, refreshed_keys = await self._ensure_jwks(force_refresh=True)
            if refreshed_keys != all_keys:
                return self._verify_with(token, alg=alg, candidate_keys=refreshed_keys)
            raise

    def _verify_with(
        self,
        token: str,
        *,
        alg: str,
        candidate_keys: tuple[Any, ...],
    ) -> VerifiedOidcIdentity:
        return verify_oidc_jwt_with_keys(
            token,
            alg=alg,
            candidate_keys=candidate_keys,
            issuer=self._config.issuer,
            audiences=self._config.effective_audiences,
            verify_audience=self._config.verify_audience,
            leeway_seconds=self._config.leeway_seconds,
            role_claim=self._config.role_claim,
            admin_roles=self._config.admin_roles,
            plan_claim=self._config.plan_claim,
            entitlements_claim=self._config.entitlements_claim,
            default_entitlements=self._default_entitlements,
        )

    async def _get_discovery(self) -> OidcDiscoveryDocument:
        now = self._clock()
        if self._discovery is not None and (now - self._discovery_fetched_at) < self._config.jwks_cache_ttl_seconds:
            return self._discovery

        async with self._discovery_lock:
            now = self._clock()
            if (
                self._discovery is not None
                and (now - self._discovery_fetched_at) < self._config.jwks_cache_ttl_seconds
            ):
                return self._discovery
            try:
                resp = await self._http.get(self._config.discovery_url, headers={"Accept": "application/json"})
                if resp.status_code >= 400:
                    raise UpstreamUnavailableError(
                        f"OIDC discovery returned HTTP {resp.status_code} from {self._config.discovery_url}"
                    )
                raw = resp.json()
                if not isinstance(raw, dict):
                    raise UpstreamUnavailableError("OIDC discovery document is not a JSON object")
                discovered_issuer = str(raw.get("issuer") or "").strip().rstrip("/")
                if discovered_issuer and discovered_issuer != self._config.issuer:
                    raise UpstreamUnavailableError(
                        f"OIDC discovery issuer mismatch: expected {self._config.issuer}, got {discovered_issuer}"
                    )
                doc = OidcDiscoveryDocument(
                    issuer=self._config.issuer,
                    jwks_uri=_opt_str(raw.get("jwks_uri")),
                    authorization_endpoint=_opt_str(raw.get("authorization_endpoint")),
                    token_endpoint=_opt_str(raw.get("token_endpoint")),
                    userinfo_endpoint=_opt_str(raw.get("userinfo_endpoint")),
                    end_session_endpoint=_opt_str(raw.get("end_session_endpoint")),
                )
                self._discovery = doc
                self._discovery_fetched_at = self._clock()
                return doc
            except UpstreamUnavailableError:
                if self._discovery is not None:
                    logger.warning("Using stale OIDC discovery cache for issuer={}", self._config.issuer)
                    return self._discovery
                raise
            except Exception as exc:  # noqa: BLE001
                if self._discovery is not None:
                    logger.warning("OIDC discovery refresh failed (serving stale cache): {}", exc)
                    return self._discovery
                raise UpstreamUnavailableError(f"failed to fetch OIDC discovery document: {exc}") from exc

    async def _resolve_jwks_uri(self) -> str:
        if self._config.jwks_uri:
            return self._config.jwks_uri
        doc = await self._get_discovery()
        if not doc.jwks_uri:
            raise UpstreamUnavailableError("OIDC discovery document is missing jwks_uri")
        return doc.jwks_uri

    async def _ensure_jwks(self, *, force_refresh: bool) -> tuple[dict[str, Any], tuple[Any, ...]]:
        now = self._clock()
        if (
            not force_refresh
            and self._all_keys
            and (now - self._jwks_fetched_at) < self._config.jwks_cache_ttl_seconds
        ):
            return self._keys_by_kid, self._all_keys

        async with self._jwks_lock:
            now = self._clock()
            if (
                not force_refresh
                and self._all_keys
                and (now - self._jwks_fetched_at) < self._config.jwks_cache_ttl_seconds
            ):
                return self._keys_by_kid, self._all_keys

            # Rate-limit forced refreshes triggered by unknown `kid` values to prevent IdP DoS.
            if (
                force_refresh
                and self._jwks_fetched_at > 0.0
                and (now - self._jwks_fetched_at) < self._config.jwks_min_refresh_interval_seconds
            ):
                return self._keys_by_kid, self._all_keys

            try:
                jwks_uri = await self._resolve_jwks_uri()
                resp = await self._http.get(jwks_uri, headers={"Accept": "application/json"})
                if resp.status_code >= 400:
                    raise UpstreamUnavailableError(f"OIDC JWKS returned HTTP {resp.status_code}")
                raw = resp.json()
                if not isinstance(raw, dict):
                    raise UpstreamUnavailableError("OIDC JWKS response is not a JSON object")
                by_kid, all_keys = parse_jwk_set(raw)
                if not all_keys:
                    raise UpstreamUnavailableError("OIDC JWKS contains no usable signing keys")
                self._keys_by_kid = by_kid
                self._all_keys = all_keys
                self._jwks_fetched_at = self._clock()
                return self._keys_by_kid, self._all_keys
            except UpstreamUnavailableError:
                if self._all_keys:
                    logger.warning("OIDC JWKS refresh failed; continuing with cached keys issuer={}", self._config.issuer)
                    return self._keys_by_kid, self._all_keys
                raise
            except Exception as exc:  # noqa: BLE001
                if self._all_keys:
                    logger.warning("OIDC JWKS refresh error (serving cached keys): {}", exc)
                    return self._keys_by_kid, self._all_keys
                raise UpstreamUnavailableError(f"failed to fetch OIDC JWKS: {exc}") from exc


def _opt_str(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None
