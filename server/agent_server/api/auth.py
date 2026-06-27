from __future__ import annotations

import os
import re
import secrets
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse

from agent_server.core.auth import (
    create_signed_token,
    create_user_access_token,
    hash_password_verifier,
    verify_signed_token,
)
from agent_server.deps import current_user, get_store
from agent_server.core.models import (
    AuthConfigResponse,
    AuthMeResponse,
    AuthPasswordSaltRequest,
    AuthPasswordSaltResponse,
    AuthRequest,
    AuthResponse,
    ChangePasswordRequest,
    MobileLoginConfirmRequest,
    MobileLoginExchangeRequest,
    MobileLoginExchangeResponse,
    MobileLoginQrCreateResponse,
    MobileLoginRequestRequest,
    MobileLoginStatusRequest,
    MobileLoginStatusResponse,
    OAuthFinalizeRequest,
    OAuthFinalizeResponse,
    OAuthStartResponse,
    UpdateAvatarRequest,
    UserView,
)
from agent_server.core.setup_token import SetupToken
from agent_server.infra.repositories.facade import Store
from agent_server.core.utc import utc_now
from agent_server.services.oauth import (
    OAuthConfigError,
    build_authorize_url,
    create_pending_token,
    exchange_code_for_identity,
    oauth_enabled,
    return_to_from_state,
    unique_user_id,
    verify_pending_token,
)


def _setup_token(request: Request) -> SetupToken:
    return request.app.state.setup_token


router = APIRouter(tags=["auth"])
MOBILE_LOGIN_TOKEN_KIND = "mobile_login"
MOBILE_REFRESH_TOKEN_KIND = "mobile_refresh"
MOBILE_LOGIN_EXPIRES_IN = 120
MOBILE_REFRESH_EXPIRES_IN = 60 * 60 * 24 * 30


@router.get("/auth/config", response_model=AuthConfigResponse)
async def auth_config(
    request: Request, db: Store = Depends(get_store)
) -> AuthConfigResponse:
    """Public endpoint so the login page can decide what to render.

    needsBootstrap=true  → no users yet; show "create first admin".
    registrationOpen=true → show the "register" link; otherwise hide it.
    setupTokenExpiresAt    → countdown source for the bootstrap form (UTC ISO);
                             never exposes the token value itself.
    """
    needs_bootstrap = await db.count_users() == 0
    expires_at: str | None = None
    if needs_bootstrap:
        # Touching the token here is intentional — if it expired since last
        # check, the operator should already see the freshly-generated one in
        # the server log by the time they hit refresh.
        expires_at = _setup_token(request).current_expires_at_iso()
    oauth_config = await db.get_oauth_provider_config()
    return AuthConfigResponse(
        needsBootstrap=needs_bootstrap,
        registrationOpen=await db.is_registration_open(),
        oauthRegistrationOpen=await db.is_oauth_registration_open(),
        oauthEnabled=oauth_enabled(oauth_config),
        oauthProviderLabel=str(oauth_config.get("label") or "OAuth") if oauth_enabled(oauth_config) else None,
        setupTokenExpiresAt=expires_at,
        serverTime=utc_now(),
    )


@router.post("/auth/password-salt", response_model=AuthPasswordSaltResponse)
async def auth_password_salt(
    payload: AuthPasswordSaltRequest,
    db: Store = Depends(get_store),
) -> AuthPasswordSaltResponse:
    salt = await db.password_salt_for_user(payload.userId)
    return AuthPasswordSaltResponse(salt=salt or secrets.token_urlsafe(16), serverTime=utc_now())


@router.post("/auth/register", response_model=AuthResponse)
async def auth_register(
    payload: AuthRequest, request: Request, db: Store = Depends(get_store)
) -> AuthResponse:
    """Self-service registration with gating:

    - If no users exist: the new user becomes admin **and** must present the
      setup token printed to the server log. Registration is then closed.
    - If users exist and registration_open is true: new user is a member.
    - Otherwise: 403.
    """
    # Pre-check rather than relying on bootstrap_first_admin's None return —
    # we want to reject before touching the DB when the setup token is wrong.
    if await db.count_users() == 0:
        if not _setup_token(request).verify(payload.setupToken):
            raise HTTPException(
                status_code=401,
                detail="invalid or expired setup token — find the current token in the server log",
            )

    try:
        password_hash = _password_hash_from_payload(payload)
        bootstrap_user = await db.bootstrap_first_admin(
            user_id=payload.userId,
            password=payload.password,
            password_hash=password_hash,
        )
    except ValueError as exc:
        raise _value_error_to_http(exc)

    if bootstrap_user is not None:
        _setup_token(request).consume()
        return _auth_response(bootstrap_user)

    if not await db.is_registration_open():
        raise HTTPException(status_code=403, detail="registration is closed")

    try:
        password_hash = _password_hash_from_payload(payload)
        user = await db.create_user(
            user_id=payload.userId,
            password=payload.password,
            password_hash=password_hash,
            role="member",
        )
    except ValueError as exc:
        raise _value_error_to_http(exc)
    return _auth_response(user)


@router.post("/auth/login", response_model=AuthResponse)
async def auth_login(payload: AuthRequest, db: Store = Depends(get_store)) -> AuthResponse:
    if payload.passwordVerifier is not None:
        user = await db.verify_user_verifier(user_id=payload.userId, verifier=payload.passwordVerifier)
    elif payload.password is not None:
        user = await db.verify_user(user_id=payload.userId, password=payload.password)
    else:
        user = None
    if user is None:
        raise HTTPException(status_code=401, detail="invalid credentials")
    return _auth_response(user)


@router.get("/auth/oauth/start", response_model=OAuthStartResponse)
async def oauth_start(
    request: Request,
    returnTo: str | None = None,
    db: Store = Depends(get_store),
) -> OAuthStartResponse:
    config = await db.get_oauth_provider_config()
    try:
        authorize_url = build_authorize_url(
            config,
            redirect_uri=_oauth_redirect_uri(request, return_to=returnTo),
            return_to=returnTo,
        )
    except OAuthConfigError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return OAuthStartResponse(authorizeUrl=authorize_url, serverTime=utc_now())


@router.get("/auth/oauth/callback")
async def oauth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Store = Depends(get_store),
) -> RedirectResponse:
    config = await db.get_oauth_provider_config()
    return_to = return_to_from_state(config, state)
    if error:
        return _oauth_frontend_redirect(request, {"oauth_error": error}, return_to=return_to)
    if not code:
        return _oauth_frontend_redirect(
            request,
            {"oauth_error": "missing oauth callback code"},
            return_to=return_to,
        )
    try:
        identity = await exchange_code_for_identity(
            config,
            code=code,
            state=state,
            redirect_uri=_oauth_redirect_uri(request, return_to=return_to),
        )
    except Exception as exc:  # noqa: BLE001 - OAuth provider failures return to the UI.
        return _oauth_frontend_redirect(request, {"oauth_error": str(exc)}, return_to=return_to)

    bound = await db.oauth_user_for_subject(provider=identity.provider, subject=identity.subject)
    if bound is not None:
        return _oauth_frontend_redirect(
            request,
            {
                "oauth_status": "authenticated",
                "oauth_pending": create_pending_token(identity),
                "oauth_user": bound.userId,
            },
            return_to=return_to,
        )

    suggested = identity.suggested_user_id
    if await db.user_exists(suggested):
        status = "needs_password"
    else:
        suggested = await unique_user_id(db, suggested)
        status = "needs_registration"
    return _oauth_frontend_redirect(
        request,
        {
            "oauth_status": status,
            "oauth_pending": create_pending_token(identity),
            "oauth_user": suggested,
        },
        return_to=return_to,
    )


@router.post("/auth/oauth/finalize", response_model=OAuthFinalizeResponse)
async def oauth_finalize(
    payload: OAuthFinalizeRequest,
    db: Store = Depends(get_store),
) -> OAuthFinalizeResponse:
    identity = verify_pending_token(payload.pendingToken)
    if identity is None:
        raise HTTPException(status_code=401, detail="oauth session expired")
    existing = await db.oauth_user_for_subject(provider=identity.provider, subject=identity.subject)
    if existing is not None:
        return OAuthFinalizeResponse(auth=_auth_response(existing), serverTime=utc_now())
    target_user_id = payload.userId or identity.suggested_user_id
    if await db.user_exists(target_user_id):
        verified = await _verify_oauth_bind_password(db, target_user_id, payload)
        if verified is None:
            raise HTTPException(status_code=401, detail="password is required to link this account")
        user = await db.bind_oauth_account(
            user_id=verified.userId,
            provider=identity.provider,
            subject=identity.subject,
            email=identity.email,
            display_name=identity.display_name,
        )
        return OAuthFinalizeResponse(auth=_auth_response(user), serverTime=utc_now())
    password_hash = _password_hash_from_oauth_finalize(payload)
    if not await db.is_oauth_registration_open():
        raise HTTPException(status_code=403, detail="oauth registration is closed")
    try:
        user = await db.create_user_with_oauth(
            user_id=target_user_id,
            provider=identity.provider,
            subject=identity.subject,
            password=payload.password if payload.setPassword else None,
            password_hash=password_hash,
            email=identity.email,
            display_name=identity.display_name,
            role="member",
        )
    except ValueError as exc:
        raise _value_error_to_http(exc)
    return OAuthFinalizeResponse(auth=_auth_response(user), serverTime=utc_now())


@router.get("/auth/me", response_model=AuthMeResponse)
async def auth_me(user: UserView = Depends(current_user)) -> AuthMeResponse:
    return AuthMeResponse(
        userId=user.userId,
        role=user.role,
        disabled=user.disabled,
        avatar=user.avatar,
        serverTime=utc_now(),
    )


# Cap stored avatar payload at ~256 KB. The data URL prefix + 256 KB of base64
# easily fits any reasonable 256×256 PNG once the frontend has resized it.
AVATAR_MAX_LENGTH = 256 * 1024
AVATAR_DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$")


@router.put("/auth/me/avatar", response_model=AuthMeResponse)
async def update_avatar(
    payload: UpdateAvatarRequest,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> AuthMeResponse:
    avatar = payload.avatar.strip()
    if len(avatar) > AVATAR_MAX_LENGTH:
        raise HTTPException(status_code=413, detail="avatar exceeds 256KB limit")
    if not AVATAR_DATA_URL_RE.match(avatar):
        raise HTTPException(
            status_code=422,
            detail="avatar must be a data:image/{png,jpeg,webp,gif};base64,... URL",
        )
    updated = await db.set_user_avatar(user.userId, avatar)
    return AuthMeResponse(
        userId=updated.userId,
        role=updated.role,
        disabled=updated.disabled,
        avatar=updated.avatar,
        serverTime=utc_now(),
    )


@router.delete("/auth/me/avatar", response_model=AuthMeResponse)
async def clear_avatar(
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> AuthMeResponse:
    updated = await db.set_user_avatar(user.userId, None)
    return AuthMeResponse(
        userId=updated.userId,
        role=updated.role,
        disabled=updated.disabled,
        avatar=updated.avatar,
        serverTime=utc_now(),
    )


@router.post("/auth/change-password", status_code=204)
async def change_password(
    payload: ChangePasswordRequest,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> None:
    """Caller changes their own password.

    The bearer token is the authentication factor here. Until 2FA exists, do
    not require users to re-enter the current password just to set a new one.
    """
    if not payload.newPassword and not payload.newPasswordVerifier:
        raise HTTPException(status_code=422, detail="new password is required")
    await db.update_user_password(
        user.userId,
        payload.newPassword,
        password_hash=_password_hash_from_change(payload),
    )


@router.post("/auth/mobile-login/qr", response_model=MobileLoginQrCreateResponse)
async def create_mobile_login_qr(
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> MobileLoginQrCreateResponse:
    expires_at_ts = int(time.time()) + MOBILE_LOGIN_EXPIRES_IN
    expires_at = _iso_from_epoch(expires_at_ts)
    login_token = create_signed_token(
        MOBILE_LOGIN_TOKEN_KIND,
        {
            "sub": user.userId,
            "aud": "agents-anywhere-mobile",
            "nonce": secrets.token_urlsafe(12),
        },
        MOBILE_LOGIN_EXPIRES_IN,
    )
    await db.record_mobile_login_token(
        token=login_token,
        user_id=user.userId,
        expires_at=expires_at,
    )
    return MobileLoginQrCreateResponse(
        userId=user.userId,
        loginToken=login_token,
        expiresAt=expires_at,
        serverTime=utc_now(),
    )


@router.post("/auth/mobile-login/exchange", response_model=MobileLoginExchangeResponse)
async def exchange_mobile_login(
    payload: MobileLoginExchangeRequest,
    db: Store = Depends(get_store),
) -> MobileLoginExchangeResponse:
    token_payload = verify_signed_token(MOBILE_LOGIN_TOKEN_KIND, payload.loginToken)
    if token_payload is None or token_payload.get("sub") != payload.userId:
        raise HTTPException(status_code=401, detail="invalid or expired mobile login token")
    if not await db.consume_mobile_login_token(token=payload.loginToken, user_id=payload.userId):
        raise HTTPException(status_code=401, detail="invalid or expired mobile login token")
    try:
        user = await db.get_user(payload.userId)
    except KeyError:
        raise HTTPException(status_code=401, detail="user no longer exists") from None
    if user.disabled:
        raise HTTPException(status_code=403, detail="account disabled")
    refresh_token = create_signed_token(
        MOBILE_REFRESH_TOKEN_KIND,
        {
            "sub": user.userId,
            "aud": "agents-anywhere-mobile",
            "nonce": secrets.token_urlsafe(16),
        },
        MOBILE_REFRESH_EXPIRES_IN,
    )
    return MobileLoginExchangeResponse(
        auth=_auth_response(user),
        refreshToken=refresh_token,
        expiresAt=_iso_from_epoch(int(time.time()) + MOBILE_REFRESH_EXPIRES_IN),
        serverTime=utc_now(),
    )


@router.post("/auth/mobile-login/request", response_model=MobileLoginStatusResponse)
async def request_mobile_login(
    payload: MobileLoginRequestRequest,
    db: Store = Depends(get_store),
) -> MobileLoginStatusResponse:
    token_payload = verify_signed_token(MOBILE_LOGIN_TOKEN_KIND, payload.loginToken)
    if token_payload is None or token_payload.get("sub") != payload.userId:
        raise HTTPException(status_code=401, detail="invalid or expired mobile login token")
    row = await db.request_mobile_login_token(
        token=payload.loginToken,
        user_id=payload.userId,
        device_name=payload.deviceName,
    )
    if row is None:
        raise HTTPException(status_code=401, detail="invalid or expired mobile login token")
    return _mobile_login_status_response(row)


@router.post("/auth/mobile-login/status", response_model=MobileLoginStatusResponse)
async def mobile_login_status(
    payload: MobileLoginStatusRequest,
    db: Store = Depends(get_store),
) -> MobileLoginStatusResponse:
    row = await db.mobile_login_token_status(token=payload.loginToken)
    if row is None:
        raise HTTPException(status_code=404, detail="mobile login token not found")
    return _mobile_login_status_response(row)


@router.post("/auth/mobile-login/confirm", response_model=MobileLoginStatusResponse)
async def confirm_mobile_login(
    payload: MobileLoginConfirmRequest,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> MobileLoginStatusResponse:
    token_payload = verify_signed_token(MOBILE_LOGIN_TOKEN_KIND, payload.loginToken)
    if token_payload is None or token_payload.get("sub") != user.userId:
        raise HTTPException(status_code=401, detail="invalid or expired mobile login token")
    row = await db.resolve_mobile_login_token(token=payload.loginToken, approved=payload.approved)
    if row is None:
        raise HTTPException(status_code=401, detail="invalid or expired mobile login token")
    return _mobile_login_status_response(row)


def _auth_response(user: UserView) -> AuthResponse:
    return AuthResponse(
        userId=user.userId,
        role=user.role,
        accessToken=create_user_access_token(user.userId),
        serverTime=utc_now(),
    )


def _iso_from_epoch(value: int) -> str:
    from datetime import UTC, datetime

    return datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")


def _mobile_login_status_response(row: dict[str, object]) -> MobileLoginStatusResponse:
    now = utc_now()
    if row.get("consumed_at"):
        status = "consumed"
    elif str(row.get("expires_at") or "") < now:
        status = "expired"
    elif row.get("rejected_at"):
        status = "rejected"
    elif row.get("approved_at"):
        status = "approved"
    elif row.get("requested_at"):
        status = "pending_web_confirm"
    else:
        status = "pending_scan"
    return MobileLoginStatusResponse(
        status=status,
        userId=str(row.get("user_id") or "") or None,
        deviceName=str(row.get("device_name") or "") or None,
        expiresAt=str(row.get("expires_at") or "") or None,
        requestedAt=str(row.get("requested_at") or "") or None,
        approvedAt=str(row.get("approved_at") or "") or None,
        serverTime=now,
    )


def _value_error_to_http(exc: ValueError) -> HTTPException:
    detail = str(exc)
    if detail == "user already exists":
        return HTTPException(status_code=409, detail=detail)
    return HTTPException(status_code=422, detail=detail)


def _password_hash_from_payload(payload: AuthRequest) -> str | None:
    if payload.passwordVerifier is None:
        return None
    if not payload.passwordSalt:
        raise ValueError("password salt is required")
    return hash_password_verifier(payload.passwordVerifier, salt=payload.passwordSalt)


def _password_hash_from_change(payload: ChangePasswordRequest) -> str | None:
    if payload.newPasswordVerifier is None:
        return None
    if not payload.newPasswordSalt:
        raise HTTPException(status_code=422, detail="new password salt is required")
    return hash_password_verifier(payload.newPasswordVerifier, salt=payload.newPasswordSalt)


async def _verify_oauth_bind_password(
    db: Store,
    user_id: str,
    payload: OAuthFinalizeRequest,
) -> UserView | None:
    if payload.passwordVerifier is not None:
        return await db.verify_user_verifier(user_id=user_id, verifier=payload.passwordVerifier)
    if payload.password is not None:
        return await db.verify_user(user_id=user_id, password=payload.password)
    return None


def _password_hash_from_oauth_finalize(payload: OAuthFinalizeRequest) -> str | None:
    if not payload.setPassword:
        return None
    if payload.passwordVerifier is None:
        return None
    if not payload.passwordSalt:
        raise HTTPException(status_code=422, detail="password salt is required")
    return hash_password_verifier(payload.passwordVerifier, salt=payload.passwordSalt)


def _oauth_redirect_uri(request: Request, *, return_to: str | None = None) -> str:
    return f"{_oauth_public_origin(request, return_to=return_to)}/auth/oauth/callback"


def _oauth_public_origin(request: Request, *, return_to: str | None = None) -> str:
    if return_to:
        try:
            parts = urlsplit(return_to)
            if parts.scheme in {"http", "https"} and parts.netloc:
                return f"{parts.scheme}://{parts.netloc}"
        except ValueError:
            pass
    configured_origin = os.environ.get("AGENT_SERVER_PUBLIC_ORIGIN")
    if configured_origin:
        return configured_origin.rstrip("/")
    return _public_origin(request)


def _public_origin(request: Request) -> str:
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    scheme = forwarded_proto or request.url.scheme
    host = forwarded_host or request.url.netloc
    return f"{scheme}://{host}"


def _oauth_frontend_redirect(
    request: Request,
    params: dict[str, str],
    *,
    return_to: str | None = None,
) -> RedirectResponse:
    base = return_to or f"{_public_origin(request)}/"
    try:
        parts = urlsplit(base)
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        query.update(params)
        target = urlunsplit((parts.scheme, parts.netloc, parts.path or "/", urlencode(query), parts.fragment))
    except ValueError:
        target = f"{_public_origin(request)}/?{urlencode(params)}"
    return RedirectResponse(target)
