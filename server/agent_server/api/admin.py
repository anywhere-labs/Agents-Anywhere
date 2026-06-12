from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from agent_server.core.auth import hash_password_verifier
from agent_server.deps import get_runtime_config_service, get_store, require_admin
from agent_server.core.models import (
    AdminUserCreateRequest,
    AdminUserListResponse,
    AdminUserUpdateRequest,
    InstanceSettingsUpdateRequest,
    InstanceSettingsView,
    UserView,
)
from agent_server.core.models import RuntimeName
from agent_server.core.runtime_config import RuntimeConfigSchema, RuntimeConfigSchemaResponse
from agent_server.services.runtime_config import RuntimeConfigService
from agent_server.infra.repositories.facade import Store
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


# --- instance settings -------------------------------------------------------


@router.get("/settings", response_model=InstanceSettingsView)
async def get_settings(db: Store = Depends(get_store)) -> InstanceSettingsView:
    return InstanceSettingsView(
        registrationOpen=await db.is_registration_open(),
        oauthRegistrationOpen=await db.is_oauth_registration_open(),
        oauth=await db.get_oauth_provider_public_config(),
    )


@router.patch("/settings", response_model=InstanceSettingsView)
async def update_settings(
    payload: InstanceSettingsUpdateRequest,
    db: Store = Depends(get_store),
) -> InstanceSettingsView:
    if payload.registrationOpen is not None:
        await db.set_registration_open(payload.registrationOpen)
    if payload.oauthRegistrationOpen is not None:
        await db.set_oauth_registration_open(payload.oauthRegistrationOpen)
    if payload.oauth is not None:
        await db.set_oauth_provider_config(payload.oauth.model_dump(exclude_none=True))
    return InstanceSettingsView(
        registrationOpen=await db.is_registration_open(),
        oauthRegistrationOpen=await db.is_oauth_registration_open(),
        oauth=await db.get_oauth_provider_public_config(),
    )


# --- runtime config schema ---------------------------------------------------


@router.get("/agents/{runtime}/config-schema", response_model=RuntimeConfigSchemaResponse)
async def get_runtime_config_schema(
    runtime: RuntimeName,
    runtime_config: RuntimeConfigService = Depends(get_runtime_config_service),
) -> RuntimeConfigSchemaResponse:
    try:
        schema = await runtime_config.get_runtime_config_schema(runtime)
    except KeyError:
        raise HTTPException(status_code=500, detail=f"runtime config schema missing: {runtime}") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return RuntimeConfigSchemaResponse(
        runtime=runtime,
        configSchema=schema,
        serverTime=utc_now(),
    )


@router.put("/agents/{runtime}/config-schema", response_model=RuntimeConfigSchemaResponse)
async def put_runtime_config_schema(
    runtime: RuntimeName,
    payload: RuntimeConfigSchema,
    runtime_config: RuntimeConfigService = Depends(get_runtime_config_service),
) -> RuntimeConfigSchemaResponse:
    try:
        schema = await runtime_config.set_runtime_config_schema(
            runtime,
            payload.model_dump(exclude_none=True),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return RuntimeConfigSchemaResponse(
        runtime=runtime,
        configSchema=schema,
        serverTime=utc_now(),
    )


# --- user management ---------------------------------------------------------


@router.get("/users", response_model=AdminUserListResponse)
async def list_users(db: Store = Depends(get_store)) -> AdminUserListResponse:
    return AdminUserListResponse(users=await db.list_users(), serverTime=utc_now())


@router.post("/users", response_model=UserView, status_code=201)
async def create_user(
    payload: AdminUserCreateRequest,
    db: Store = Depends(get_store),
) -> UserView:
    try:
        return await db.create_user(
            user_id=payload.userId,
            password=payload.password,
            password_hash=_password_hash_from_create(payload),
            role=payload.role,
        )
    except ValueError as exc:
        detail = str(exc)
        if detail == "user already exists":
            raise HTTPException(status_code=409, detail=detail) from exc
        raise HTTPException(status_code=422, detail=detail) from exc


@router.patch("/users/{user_id}", response_model=UserView)
async def update_user(
    user_id: str,
    payload: AdminUserUpdateRequest,
    db: Store = Depends(get_store),
    admin: UserView = Depends(require_admin),
) -> UserView:
    target = (user_id or "").strip().lower()
    if not target:
        raise HTTPException(status_code=404, detail="user not found")

    # Self-protection guards on role/disabled changes.
    if target == admin.userId:
        if payload.role is not None and payload.role != admin.role:
            raise HTTPException(status_code=409, detail="cannot change your own role")
        if payload.disabled is True:
            raise HTTPException(status_code=409, detail="cannot disable yourself")

    updated: UserView | None = None
    try:
        if payload.role is not None:
            updated = await db.update_user_role(target, payload.role)
        if payload.disabled is not None:
            updated = await db.set_user_disabled(target, payload.disabled)
        password_hash = _password_hash_from_update(payload)
        if payload.password is not None or password_hash is not None:
            await db.update_user_password(target, payload.password, password_hash=password_hash)
    except KeyError:
        raise HTTPException(status_code=404, detail="user not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return updated or await _safe_get_user(db, target)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(
    user_id: str,
    db: Store = Depends(get_store),
    admin: UserView = Depends(require_admin),
) -> None:
    target = (user_id or "").strip().lower()
    if target == admin.userId:
        raise HTTPException(status_code=409, detail="cannot delete yourself")
    try:
        await db.delete_user(target)
    except KeyError:
        raise HTTPException(status_code=404, detail="user not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


async def _safe_get_user(db: Store, user_id: str) -> UserView:
    try:
        return await db.get_user(user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="user not found") from None


def _password_hash_from_create(payload: AdminUserCreateRequest) -> str | None:
    if payload.passwordVerifier is None:
        return None
    if not payload.passwordSalt:
        raise HTTPException(status_code=422, detail="password salt is required")
    return hash_password_verifier(payload.passwordVerifier, salt=payload.passwordSalt)


def _password_hash_from_update(payload: AdminUserUpdateRequest) -> str | None:
    if payload.passwordVerifier is None:
        return None
    if not payload.passwordSalt:
        raise HTTPException(status_code=422, detail="password salt is required")
    return hash_password_verifier(payload.passwordVerifier, salt=payload.passwordSalt)
