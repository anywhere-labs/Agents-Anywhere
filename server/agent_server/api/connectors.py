from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from loguru import logger

from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.deps import (
    current_user_id,
    get_device_agent_settings_service,
    get_rpc,
    get_store,
    get_timeline_broker,
)
from agent_server.core.models import (
    ArchiveAllRequest,
    ArchiveAllResponse,
    ConnectorCreateRequest,
    ConnectorCreateResponse,
    ConnectorListResponse,
    ConnectorPreferencesResponse,
    ConnectorRevokeResponse,
    ConnectorResponse,
    ConnectorRuntimeCapabilitiesResponse,
    ConnectorFsListRequest,
    ConnectorRuntimeScanRequest,
    ConnectorRuntimeScanResponse,
    ConnectorUpdateRequest,
    ConnectorView,
    DeviceAgentsState,
    RpcResponsePayload,
    RuntimeName,
)
from agent_server.core.runtime_config import RuntimeSettingsPatchRequest, RuntimeSettingsResponse
from agent_server.services.runtime_activation import send_active_runtimes
from agent_server.services.connector_presence import with_effective_connector_status, with_effective_session_connector_status
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_agent_settings import DeviceAgentSettingsService
from agent_server.infra.repositories.facade import Store, report_is_attachable
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/connectors", tags=["connectors"])


def _connector_for_response(manager: ConnectorRpcManager, connector: ConnectorView) -> ConnectorView:
    return with_effective_connector_status(manager, connector)


async def _send_invalidate_runtime(
    manager: ConnectorRpcManager, connector_id: str, runtime: str
) -> None:
    """Best-effort fire-and-forget invalidate. Used after the user Deletes
    a runtime so the live daemon stops syncing it immediately. Exceptions
    get logged, never bubble back to the HTTP handler that scheduled this
    task — the daemon will reconverge on next discovery push anyway."""
    try:
        await manager.request(
            connector_id,
            "capabilities.invalidateRuntime",
            {"runtime": runtime},
            timeout=15,
        )
    except (ConnectorOfflineError, ConnectorRpcError, TimeoutError) as exc:
        logger.warning(
            "capabilities.invalidateRuntime failed connector_id={} runtime={} error={}",
            connector_id,
            runtime,
            exc,
        )
    except Exception:
        logger.exception(
            "capabilities.invalidateRuntime crashed connector_id={} runtime={}",
            connector_id,
            runtime,
        )


async def _send_force_resync_runtime(
    manager: ConnectorRpcManager, connector_id: str, runtime: str
) -> None:
    """Best-effort fire-and-forget force-resync. Fired after a successful
    Add scan so the daemon ingests the runtime's local sessions / threads
    against a backend that has already committed the attach (no filter
    drops). Generous timeout because codex sync of a long thread list can
    take ~10s; we don't block the HTTP response on it either way."""
    try:
        await manager.request(
            connector_id,
            "capabilities.forceResyncRuntime",
            {"runtime": runtime},
            timeout=90,
        )
    except (ConnectorOfflineError, ConnectorRpcError, TimeoutError) as exc:
        logger.warning(
            "capabilities.forceResyncRuntime failed connector_id={} runtime={} error={}",
            connector_id,
            runtime,
            exc,
        )
    except Exception:
        logger.exception(
            "capabilities.forceResyncRuntime crashed connector_id={} runtime={}",
            connector_id,
            runtime,
        )


@router.get("", response_model=ConnectorListResponse)
async def list_connectors(
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> ConnectorListResponse:
    connectors = await db.list_connectors(user_id=user_id)
    return ConnectorListResponse(
        connectors=[_connector_for_response(manager, connector) for connector in connectors],
        serverTime=utc_now(),
    )


@router.post("", response_model=ConnectorCreateResponse)
async def create_connector(
    payload: ConnectorCreateRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ConnectorCreateResponse:
    connector, token, prefix = await db.create_connector(name=payload.name, user_id=user_id)
    await publish_dashboard_changed(
        db,
        broker,
        user_id=user_id,
        connector_id=connector.id,
        reason="connector.created",
    )
    return ConnectorCreateResponse(connector=connector, connectorToken=token, tokenPrefix=prefix)


@router.get("/{connector_id}", response_model=ConnectorResponse)
async def get_connector(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> ConnectorResponse:
    try:
        connector = await db.get_connector(connector_id)
        if connector.userId != user_id:
            raise KeyError(connector_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    return ConnectorResponse(connector=_connector_for_response(manager, connector), serverTime=utc_now())


@router.patch("/{connector_id}", response_model=ConnectorResponse)
async def update_connector(
    connector_id: str,
    payload: ConnectorUpdateRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ConnectorResponse:
    try:
        connector = await db.update_connector(connector_id, owner_user_id=user_id, name=payload.name)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    await publish_dashboard_changed(
        db,
        broker,
        user_id=user_id,
        connector_id=connector_id,
        reason="connector.updated",
    )
    return ConnectorResponse(connector=_connector_for_response(manager, connector), serverTime=utc_now())


@router.delete("/{connector_id}", status_code=204)
async def delete_connector(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> None:
    try:
        await db.revoke_connector(connector_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    await manager.disconnect(connector_id, reason="connector deleted")
    await publish_dashboard_changed(
        db,
        broker,
        user_id=user_id,
        connector_id=connector_id,
        reason="connector.deleted",
    )


@router.post("/{connector_id}/revoke", response_model=ConnectorRevokeResponse)
async def revoke_connector_token(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ConnectorRevokeResponse:
    try:
        connector, token, prefix = await db.rotate_connector_token(
            connector_id,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    await manager.disconnect(connector_id, reason="connector token revoked")
    await publish_dashboard_changed(
        db,
        broker,
        user_id=user_id,
        connector_id=connector_id,
        reason="connector.revoked",
    )
    return ConnectorRevokeResponse(
        connector=_connector_for_response(manager, connector),
        connectorToken=token,
        tokenPrefix=prefix,
        serverTime=utc_now(),
    )


@router.get("/{connector_id}/preferences", response_model=ConnectorPreferencesResponse)
async def get_connector_preferences(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> ConnectorPreferencesResponse:
    try:
        connector = await db.get_connector(connector_id)
        if connector.userId != user_id:
            raise KeyError(connector_id)
        preferences = await db.get_connector_preferences(connector_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    return ConnectorPreferencesResponse(
        connectorId=connector_id,
        preferences=preferences,
        serverTime=utc_now(),
    )


@router.post("/{connector_id}/fs/list", response_model=RpcResponsePayload)
async def connector_fs_list(
    connector_id: str,
    payload: ConnectorFsListRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await _require_owned_connector(connector_id, user_id, db)
    if not manager.is_online(connector_id):
        raise HTTPException(status_code=409, detail="connector is offline")
    try:
        result = await manager.request(
            connector_id,
            "fs.readDir",
            {
                "sessionId": f"browse_{connector_id}",
                "root": payload.root,
                "path": payload.path or ".",
            },
            timeout=30,
        )
    except ConnectorOfflineError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ConnectorRpcError as exc:
        raise HTTPException(status_code=502, detail=exc.message or exc.code) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail="fs.readDir timed out") from exc
    return RpcResponsePayload(ok=True, result=result)


# ── Device agents (attach / scan / delete) ─────────────────────────────────
#
# URL path kept as `/runtime-capabilities/...` for backward compatibility
# with already-shipped clients; the response shape is the new
# DeviceAgentsState frontend view. No `/refresh` endpoint exists by design —
# initial pair runs one full discovery, after that everything goes through
# explicit Add (scan) and Delete actions.


async def _require_owned_connector(connector_id: str, user_id: str, db: Store) -> None:
    try:
        connector = await db.get_connector(connector_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    if connector.userId != user_id:
        raise HTTPException(status_code=404, detail="connector not found")


@router.get(
    "/{connector_id}/runtime-capabilities",
    response_model=ConnectorRuntimeCapabilitiesResponse,
)
async def get_connector_runtime_capabilities(
    connector_id: str,
    db: Store = Depends(get_store),
    user_id: str = Depends(current_user_id),
) -> ConnectorRuntimeCapabilitiesResponse:
    await _require_owned_connector(connector_id, user_id, db)
    state = await db.get_device_agents(connector_id)
    return ConnectorRuntimeCapabilitiesResponse(
        connectorId=connector_id,
        runtimeCapabilities=DeviceAgentsState.model_validate(state),
        serverTime=utc_now(),
    )


@router.get(
    "/{connector_id}/agents/{runtime}/settings",
    response_model=RuntimeSettingsResponse,
)
async def get_connector_agent_settings(
    connector_id: str,
    runtime: RuntimeName,
    settings_service: DeviceAgentSettingsService = Depends(get_device_agent_settings_service),
    user_id: str = Depends(current_user_id),
) -> RuntimeSettingsResponse:
    try:
        result = await settings_service.get_settings(
            connector_id,
            runtime,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return RuntimeSettingsResponse(
        connectorId=connector_id,
        runtime=runtime,
        settings=result.settings,
        defaultRunModeConfigured=result.default_run_mode_configured,
        schemaVersion=result.schema.schemaVersion,
        serverTime=utc_now(),
    )


@router.patch(
    "/{connector_id}/agents/{runtime}/settings",
    response_model=RuntimeSettingsResponse,
)
async def patch_connector_agent_settings(
    connector_id: str,
    runtime: RuntimeName,
    payload: RuntimeSettingsPatchRequest,
    settings_service: DeviceAgentSettingsService = Depends(get_device_agent_settings_service),
    user_id: str = Depends(current_user_id),
) -> RuntimeSettingsResponse:
    try:
        result = await settings_service.patch_settings(
            connector_id,
            runtime,
            payload.settings,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return RuntimeSettingsResponse(
        connectorId=connector_id,
        runtime=runtime,
        settings=result.settings,
        defaultRunModeConfigured=result.default_run_mode_configured,
        schemaVersion=result.schema.schemaVersion,
        serverTime=utc_now(),
    )


@router.post(
    "/{connector_id}/runtime-capabilities/scan",
    response_model=ConnectorRuntimeScanResponse,
)
async def scan_connector_runtime(
    connector_id: str,
    payload: ConnectorRuntimeScanRequest,
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    user_id: str = Depends(current_user_id),
) -> ConnectorRuntimeScanResponse:
    """Scan a single runtime, with an optional user-supplied custom path.

    Backs the Add Agent modal. Three outcomes for the user:

      - Daemon found a usable binary → desired intent becomes enabled,
        active runtimes are pushed to the connector, and sessions for the
        runtime get force-resynced from local files.
      - Daemon found something but the check failed → desired intent still
        becomes enabled so the Device page can show a warning row, but the
        runtime is not active until execution becomes available.
      - Nothing on this machine → modal shows the inline "couldn't find"
        chip; we don't enable the runtime. Frontend renders the chip from
        the `scanned.report` we return.

    "Agent not found" and "check failed" are NOT HTTP errors — the modal
    needs to render them inline. We only raise 5xx for real plumbing
    errors (daemon offline, dispatch crash).
    """
    await _require_owned_connector(connector_id, user_id, db)
    if not manager.is_online(connector_id):
        raise HTTPException(
            status_code=503,
            detail={
                "code": "connector_offline",
                "message": "connector is offline; bring it back online to scan",
            },
        )
    # 90s covers per-runtime discovery (~1s) + force-resync of just that
    # runtime's sessions (5-9s codex worst case). The Scan button surfaces
    # this as a spinner, so a longer wait is fine.
    try:
        result = await manager.request(
            connector_id,
            "capabilities.scanRuntime",
            {"runtime": payload.runtime, "path": payload.path},
            timeout=90,
        )
    except ConnectorOfflineError as exc:
        raise HTTPException(
            status_code=503, detail={"code": "connector_offline", "message": str(exc)}
        ) from exc
    except ConnectorRpcError as exc:
        if exc.code == "ValueError":
            raise HTTPException(
                status_code=400,
                detail={"code": "unsupported_runtime", "message": exc.message},
            ) from exc
        raise HTTPException(
            status_code=502, detail={"code": exc.code, "message": exc.message}
        ) from exc
    if not isinstance(result, dict) or not isinstance(result.get("report"), dict):
        raise HTTPException(
            status_code=502,
            detail={"code": "invalid_response", "message": "connector returned malformed scan result"},
        )

    runtime = str(result.get("runtime") or payload.runtime)
    report = dict(result["report"])

    # Only commit desired intent if the scan actually turned up something
    # the user can interact with. All-missing reports are pure "we looked
    # and didn't find it" feedback for the modal; persisting them would
    # clutter the Device → Agents list with greyed-out rows.
    if report_is_attachable(report):
        try:
            state = await db.attach_runtime(connector_id, runtime, report, user_id=user_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="connector not found") from None
        active_runtimes = await send_active_runtimes(manager, db, connector_id)
        if active_runtimes is None or runtime in active_runtimes:
            asyncio.create_task(
                _send_force_resync_runtime(manager, connector_id, runtime)
            )
    else:
        try:
            state = await db.observe_runtime(connector_id, runtime, report, user_id=user_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="connector not found") from None

    return ConnectorRuntimeScanResponse(
        connectorId=connector_id,
        runtimeCapabilities=DeviceAgentsState.model_validate(state),
        scanned={"runtime": runtime, "report": report},
        serverTime=utc_now(),
    )


@router.delete(
    "/{connector_id}/runtime-capabilities/{runtime}",
    response_model=ConnectorRuntimeCapabilitiesResponse,
)
async def delete_connector_runtime_capability(
    connector_id: str,
    runtime: str,
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    user_id: str = Depends(current_user_id),
) -> ConnectorRuntimeCapabilitiesResponse:
    """Delete an agent from this device.

    "Delete" here means: set desired intent to disabled
    (so the daemon's next discovery push doesn't auto-resurrect it),
    cascade-delete every chat session it owns + their timeline/approvals/
    file blobs. The user's local install is untouched — clicking Add later
    is the only path to bring it back.

    We also fire a `capabilities.invalidateRuntime` RPC at the daemon as
    a fast-path optimization: it makes the live daemon stop its periodic
    sync for this runtime within ~1s instead of waiting for the next
    discovery cycle. Best-effort: if the daemon is offline or slow, the
    HTTP response still succeeds — desired intent in the DB will catch it on
    the next reconnect.
    """
    try:
        state = await db.detach_runtime(connector_id, runtime, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    logger.info(
        "detached runtime connector_id={} runtime={} user_id={}",
        connector_id,
        runtime,
        user_id,
    )
    if manager.is_online(connector_id):
        await send_active_runtimes(manager, db, connector_id)
        asyncio.create_task(_send_invalidate_runtime(manager, connector_id, runtime))
    return ConnectorRuntimeCapabilitiesResponse(
        connectorId=connector_id,
        runtimeCapabilities=DeviceAgentsState.model_validate(state),
        serverTime=utc_now(),
    )


@router.post(
    "/{connector_id}/sessions/archive-all",
    response_model=ArchiveAllResponse,
)
async def archive_all_device_sessions(
    connector_id: str,
    payload: ArchiveAllRequest,
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    user_id: str = Depends(current_user_id),
) -> ArchiveAllResponse:
    await _require_owned_connector(connector_id, user_id, db)
    try:
        sessions = await db.archive_device_sessions(
            connector_id,
            payload.archived,
            scope=payload.scope,
            user_id=user_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ArchiveAllResponse(
        sessions=[with_effective_session_connector_status(manager, session) for session in sessions],
        affected=len(sessions),
        serverTime=utc_now(),
    )
