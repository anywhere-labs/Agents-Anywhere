from __future__ import annotations

import hmac
import secrets
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

from aa_control.core.assistant import is_first_party_oidc_session
from aa_control.core.auth import (
    create_access_token,
    format_client_principal,
    format_device_principal,
    generate_opaque_token,
    hash_password,
    hash_secret_digest,
    verify_access_token,
    verify_password,
    verify_secret_digest,
)
from aa_control.core.config import ControlSettings
from aa_control.core.entitlements import merge_entitlements
from aa_control.core.errors import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    RateLimitError,
    UnauthenticatedError,
    UpstreamUnavailableError,
    ValidationError,
)
from aa_control.core.models import (
    AuthConfigResponse,
    AuthTokenResponse,
    ClientPlatform,
    ClientRouterTokenResponse,
    DeviceRouterTokenResponse,
    LoginRequest,
    RegisterRequest,
    UserView,
)
from aa_control.core.utc import utc_now_iso
from aa_control.infra.db.repositories import ControlRepository, DeviceRow, UserRow
from aa_control.infra.oidc import OidcVerifierPort
from aa_control.infra.redis_store import RedisControlStore
from aa_control.infra.router_pool import RouterPoolPort


@dataclass(frozen=True)
class AuthenticatedUserSession:
    user: UserView
    is_first_party_session: bool
    client_id: str | None = None


def _user_view(
    row: UserRow,
    *,
    email_override: str | None = None,
    display_name_override: str | None = None,
    role_override: str | None = None,
    plan: str | None = None,
    entitlements: Mapping[str, Any] | None = None,
    active_context: dict[str, Any] | None = None,
) -> UserView:
    return UserView(
        id=row.id,
        email=email_override if email_override is not None else row.email,
        display_name=display_name_override if display_name_override is not None else row.display_name,
        role=role_override if role_override is not None else row.role,
        created_at=row.created_at,
        plan=plan,
        entitlements=merge_entitlements(None, entitlements),
        active_context=active_context,
    )


class AuthService:
    def __init__(
        self,
        *,
        settings: ControlSettings,
        repo: ControlRepository,
        redis_store: RedisControlStore,
        router_pool: RouterPoolPort,
        oidc_verifier: OidcVerifierPort | None = None,
    ) -> None:
        if settings.auth_mode == "oidc" and oidc_verifier is None:
            raise ValueError("oidc_verifier is required when auth_mode='oidc'")
        self._settings = settings
        self._repo = repo
        self._redis = redis_store
        self._routers = router_pool
        self._oidc = oidc_verifier

    def _require_local_mode(self) -> None:
        if self._settings.auth_mode != "local":
            raise ForbiddenError(
                "local password authentication is disabled in oidc auth mode",
                code="local_auth_disabled",
            )

    async def auth_config(self) -> AuthConfigResponse:
        if self._settings.auth_mode == "oidc":
            assert self._settings.oidc_auth is not None
            assert self._oidc is not None
            return AuthConfigResponse(
                auth_mode="oidc",
                needs_bootstrap=False,
                registration_open=False,
                oauth_enabled=True,
                oauth_provider_label=self._settings.oidc_auth.provider_label,
                oidc=await self._oidc.public_config(),
                server_time=utc_now_iso(),
            )
        needs_bootstrap = (await self._repo.count_users()) == 0
        provider = self._settings.oauth_provider
        return AuthConfigResponse(
            auth_mode="local",
            needs_bootstrap=needs_bootstrap,
            registration_open=self._settings.registration_open,
            oauth_enabled=provider is not None,
            oauth_provider_label=provider.label if provider is not None else None,
            oidc=None,
            server_time=utc_now_iso(),
        )

    async def register(self, req: RegisterRequest) -> AuthTokenResponse:
        self._require_local_mode()
        email = req.email.strip().lower()
        if "@" not in email:
            raise ValidationError("valid email is required")

        user_count = await self._repo.count_users()
        if user_count == 0:
            if self._settings.bootstrap_setup_token:
                if not req.setup_token or not hmac.compare_digest(
                    req.setup_token, self._settings.bootstrap_setup_token
                ):
                    raise UnauthenticatedError("invalid or missing setup token")
            role = "admin"
        else:
            if not self._settings.registration_open:
                raise ForbiddenError("registration is closed")
            role = "member"

        existing = await self._repo.get_user_by_email(email)
        if existing is not None:
            raise ConflictError("email is already registered")

        pw_hash = hash_password(req.password, iterations=self._settings.password_iterations)
        user = await self._repo.create_user(
            email=email,
            password_hash=pw_hash,
            display_name=req.display_name.strip(),
            role=role,
        )
        return await self._issue_account_session(
            user=user,
            client_id=req.client_id,
            client_platform=req.client_platform,
        )

    async def login(self, req: LoginRequest) -> AuthTokenResponse:
        self._require_local_mode()
        email = req.email.strip().lower()
        user = await self._repo.get_user_by_email(email)
        if user is None or not user.password_hash:
            raise UnauthenticatedError("invalid email or password")
        if user.disabled:
            raise ForbiddenError("account is disabled")
        if not verify_password(req.password, user.password_hash, iterations=self._settings.password_iterations):
            raise UnauthenticatedError("invalid email or password")
        return await self._issue_account_session(
            user=user,
            client_id=req.client_id,
            client_platform=req.client_platform,
        )

    async def refresh(self, refresh_token: str) -> AuthTokenResponse:
        self._require_local_mode()
        token_hash = hash_secret_digest(refresh_token)
        stored = await self._repo.get_refresh_token_by_hash(token_hash)
        if stored is None or stored.revoked_at is not None or stored.expires_at < int(time.time()):
            raise UnauthenticatedError("refresh token is invalid or expired")
        user = await self._repo.get_user_by_id(stored.user_id)
        if user is None or user.disabled:
            raise UnauthenticatedError("account is unavailable")

        # Rotate refresh token (revoke old before issuing new).
        await self._repo.revoke_refresh_token(token_hash)
        return await self._issue_account_session(
            user=user,
            client_id=stored.client_id,
            client_platform="web",
            touch_client=False,
        )

    async def logout(self, refresh_token: str) -> bool:
        self._require_local_mode()
        return await self._repo.revoke_refresh_token(hash_secret_digest(refresh_token))

    async def authenticate_access_token(self, token: str) -> UserView:
        session = await self.authenticate_access_token_session(token)
        return session.user

    async def authenticate_access_token_session(self, token: str) -> AuthenticatedUserSession:
        if self._settings.auth_mode == "oidc":
            assert self._oidc is not None
            assert self._settings.oidc_auth is not None
            identity = await self._oidc.verify_token(token)
            user = await self._repo.upsert_oidc_user(
                issuer=identity.issuer,
                subject=identity.subject,
                email=identity.email,
                email_verified=identity.email_verified,
                display_name=identity.display_name,
                role=identity.role,
            )
            if user.disabled:
                raise UnauthenticatedError("account is unavailable")
            if identity.entitlements:
                await self._redis.set_user_entitlements(user.id, identity.entitlements)
            allowed_clients = self._settings.assistant.allowed_tokens_client_ids
            if not allowed_clients and self._settings.oidc_auth.client_id:
                allowed_clients = (self._settings.oidc_auth.client_id,)
            first_party = is_first_party_oidc_session(
                identity.raw_claims,
                allowed_client_ids=allowed_clients,
            )
            raw_cid = identity.raw_claims.get("azp") or identity.raw_claims.get("client_id")
            client_id = str(raw_cid).strip() if isinstance(raw_cid, str) and raw_cid.strip() else None
            return AuthenticatedUserSession(
                user=_user_view(
                    user,
                    email_override=identity.email or user.email,
                    display_name_override=identity.display_name or user.display_name,
                    role_override=identity.role,
                    plan=identity.plan,
                    entitlements=identity.entitlements,
                    active_context=identity.active_context,
                ),
                is_first_party_session=first_party,
                client_id=client_id,
            )

        payload = verify_access_token(
            secret_key=self._settings.secret_key,
            token=token,
            expected_type="user",
        )
        if payload is None:
            raise UnauthenticatedError("invalid or expired access token")
        user = await self._repo.get_user_by_id(str(payload["sub"]))
        if user is None or user.disabled:
            raise UnauthenticatedError("account is unavailable")
        kind = str(payload.get("kind") or "").strip().lower()
        first_party = kind not in {"oauth", "mcp", "third_party"} and not bool(payload.get("oauth_client"))
        raw_cid = payload.get("cid")
        client_id = str(raw_cid).strip() if isinstance(raw_cid, str) and raw_cid.strip() else None
        return AuthenticatedUserSession(
            user=_user_view(user, entitlements=self._settings.default_entitlements),
            is_first_party_session=first_party,
            client_id=client_id,
        )

    async def issue_client_router_tokens(
        self,
        *,
        user_id: str,
        client_id: str,
        platform: ClientPlatform,
    ) -> ClientRouterTokenResponse:
        allowed = await self._redis.check_rate_limit(
            bucket=f"client-token:{user_id}",
            limit=self._settings.token_issue_rate_limit_per_min,
            window_seconds=60,
        )
        if not allowed:
            raise RateLimitError("router token issuance rate limit exceeded")

        await self._repo.upsert_client(
            client_id=client_id,
            user_id=user_id,
            platform=platform,
            update_push_token=False,
        )
        principal = format_client_principal(user_id, client_id)
        tokens = await self._routers.issue_client_tokens(
            principal=principal,
            ttl_seconds=self._settings.client_router_token_ttl_seconds,
        )
        return ClientRouterTokenResponse(principal=principal, tokens=tokens)

    async def authenticate_device_credentials(
        self,
        *,
        device_id: str,
        device_secret: str,
    ) -> DeviceRow:
        device = await self._repo.get_device(device_id)
        secret_hash = await self._repo.get_device_secret_hash(device_id)
        if device is None or secret_hash is None:
            raise UnauthenticatedError("unknown or revoked device credentials")
        if not verify_secret_digest(device_secret, secret_hash):
            raise UnauthenticatedError("invalid device credentials")
        owner = await self._repo.get_user_by_id(device.user_id)
        if owner is None or owner.disabled:
            raise UnauthenticatedError("account is unavailable")
        return device

    async def issue_device_router_tokens(
        self,
        *,
        device_id: str,
        device_secret: str,
    ) -> DeviceRouterTokenResponse:
        allowed = await self._redis.check_rate_limit(
            bucket=f"device-token:{device_id}",
            limit=self._settings.token_issue_rate_limit_per_min,
            window_seconds=60,
        )
        if not allowed:
            raise RateLimitError("device router token rate limit exceeded")

        await self.authenticate_device_credentials(device_id=device_id, device_secret=device_secret)

        principal = format_device_principal(device_id)
        tokens = await self._routers.issue_device_tokens(
            device_id=device_id,
            principal=principal,
            ttl_seconds=self._settings.device_router_token_ttl_seconds,
        )
        return DeviceRouterTokenResponse(device_id=device_id, principal=principal, tokens=tokens)

    def oauth_authorize_url(self, *, state: str, redirect_uri: str) -> str:
        self._require_local_mode()
        provider = self._settings.oauth_provider
        if provider is None:
            raise NotFoundError("OAuth login provider is not configured")
        params = urlencode(
            {
                "response_type": "code",
                "client_id": provider.client_id,
                "redirect_uri": redirect_uri,
                "scope": provider.scopes,
                "state": state,
            }
        )
        sep = "&" if "?" in provider.authorize_url else "?"
        return f"{provider.authorize_url}{sep}{params}"

    async def oauth_complete_login(
        self,
        *,
        code: str,
        redirect_uri: str,
        client_id: str | None = None,
        client_platform: ClientPlatform = "web",
        http_client: httpx.AsyncClient | None = None,
    ) -> AuthTokenResponse:
        self._require_local_mode()
        provider = self._settings.oauth_provider
        if provider is None:
            raise NotFoundError("OAuth login provider is not configured")
        own_client = http_client is None
        client = http_client or httpx.AsyncClient(timeout=10.0)
        try:
            token_resp = await client.post(
                provider.token_url,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "client_id": provider.client_id,
                    "client_secret": provider.client_secret,
                },
                headers={"Accept": "application/json"},
            )
            if token_resp.status_code >= 400:
                raise UpstreamUnavailableError("OAuth token exchange failed")
            access_token = token_resp.json().get("access_token")
            if not access_token:
                raise UpstreamUnavailableError("OAuth provider did not return an access_token")
            user_resp = await client.get(
                provider.userinfo_url,
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            )
            if user_resp.status_code >= 400:
                raise UpstreamUnavailableError("OAuth userinfo fetch failed")
            info = user_resp.json()
        finally:
            if own_client:
                await client.aclose()

        subject = str(info.get("sub") or info.get("id") or "").strip()
        if not subject:
            raise UpstreamUnavailableError("OAuth userinfo missing subject")
        email = info.get("email")
        display_name = str(info.get("name") or info.get("preferred_username") or "")
        user = await self._repo.get_or_create_oauth_user(
            provider=provider.name,
            subject=subject,
            email=str(email) if email else None,
            display_name=display_name,
            allow_create=self._settings.registration_open,
        )
        if user is None:
            raise ForbiddenError("OAuth registration is closed")
        if user.disabled:
            raise ForbiddenError("account is disabled")
        return await self._issue_account_session(
            user=user,
            client_id=client_id,
            client_platform=client_platform,
        )

    async def _issue_account_session(
        self,
        *,
        user: UserRow,
        client_id: str | None,
        client_platform: ClientPlatform,
        touch_client: bool = True,
    ) -> AuthTokenResponse:
        resolved_client_id = client_id or f"cli_{secrets.token_hex(12)}"
        if touch_client:
            await self._repo.upsert_client(
                client_id=resolved_client_id,
                user_id=user.id,
                platform=client_platform,
                update_push_token=False,
            )
        raw_refresh = generate_opaque_token("aart_")
        expires_at = int(time.time()) + self._settings.refresh_token_ttl_seconds
        await self._repo.create_refresh_token(
            user_id=user.id,
            client_id=resolved_client_id,
            token_hash=hash_secret_digest(raw_refresh),
            expires_at=expires_at,
        )
        access_token = create_access_token(
            secret_key=self._settings.secret_key,
            user_id=user.id,
            expires_in=self._settings.access_token_ttl_seconds,
            extra={"cid": resolved_client_id},
        )
        return AuthTokenResponse(
            user=_user_view(user, entitlements=self._settings.default_entitlements),
            access_token=access_token,
            refresh_token=raw_refresh,
            expires_in=self._settings.access_token_ttl_seconds,
            client_id=resolved_client_id,
        )
