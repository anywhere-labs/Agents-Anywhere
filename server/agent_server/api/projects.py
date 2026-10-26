from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from agent_server.core.models import (
    ArchiveAllRequest,
    ArchiveAllResponse,
    ProjectCreateRequest,
    ProjectCreateResponse,
    ProjectDeleteResponse,
    ProjectListResponse,
    ProjectOperationListResponse,
    ProjectPatchRequest,
    ProjectPendingOperation,
    ProjectResponse,
    ProjectSessionListResponse,
)
from agent_server.core.operations import OperationRequest
from agent_server.core.utc import utc_now
from agent_server.deps import (
    current_user_id,
    get_device_runtime_service,
    get_rpc,
    get_session_runtime_state_cache,
    get_store,
    get_timeline_broker,
)
from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.connector_presence import (
    with_effective_session_connector_statuses,
)
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_runtimes import (
    DeviceRuntimeError,
    DeviceRuntimeService,
)
from agent_server.services.session_meta_projection import (
    project_session_meta_for_dashboard,
)
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=ProjectListResponse)
async def list_projects(
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
) -> ProjectListResponse:
    return ProjectListResponse(
        projects=await store.list_projects(user_id=user_id),
        serverTime=utc_now(),
    )


async def _operation_response(store: Store, operation: dict, user_id: str) -> ProjectCreateResponse:
    result = json.loads(operation["result_json"] or "{}")
    native_id = result.get("nativeProjectId")
    project = await store.find_native_project(user_id=user_id, connector_id=operation["connector_id"],
        runtime_id=operation["runtime_id"], native_project_id=native_id) if native_id else None
    return ProjectCreateResponse(operationId=operation["id"], status=operation["status"],
        project=project, nativeProjectId=native_id, roots=result.get("roots", []),
        syncState="synced" if project else "pending", message=result.get("message"), serverTime=utc_now())


@router.post("", response_model=ProjectCreateResponse)
async def create_project(
    request: Request,
    payload: ProjectCreateRequest,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    runtimes: DeviceRuntimeService = Depends(get_device_runtime_service),
) -> ProjectCreateResponse:
    if not payload.runtime or not payload.runtimeId or not payload.requestId:
        raise HTTPException(426, detail={"code": "upgrade_required", "message": "runtime, runtimeId and requestId are required"})
    try:
        prior = await store.recover_project_operation(user_id=user_id, request=payload.model_dump())
    except ValueError as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    if prior is not None:
        return await _operation_response(store, prior, user_id)
    if payload.runtime == "claude":
        raise HTTPException(422, detail={"code": "first_session_required", "message": "Choose a directory and send the first Claude message to create this project"})
    try:
        bound = await runtimes.get_runtime(payload.connectorId, payload.runtimeId, user_id=user_id)
        if bound.runtimeType != payload.runtime:
            raise HTTPException(422, detail="project Runtime instance type mismatch")
        routed = await runtimes.ensure_session_routable(payload.connectorId, runtime_type=payload.runtime,
            runtime_id=payload.runtimeId, user_id=user_id, ensure_running=True)
        if routed is not None and not routed.capabilities.get("projectCreate", False):
            raise HTTPException(422, detail={"code": "project_capability_unavailable",
                "message": routed.metadata.get("projectSupportMessage") or "此 Runtime 实例尚未确认项目创建能力，请核对状态或升级支持项目协议的版本"})
    except DeviceRuntimeError as exc:
        raise HTTPException(exc.status_code, detail=exc.detail) from exc
    if not await manager.is_online(payload.connectorId):
        raise HTTPException(409, detail={"code": "connector_offline", "message": "工作设备离线，无法创建项目"})
    try:
        connection, _ = await manager.request_bound(payload.connectorId, "workspace.connection", {}, timeout=5)
        if connection.get("operationsProtocol") != "1.0":
            raise HTTPException(426, detail={"code": "upgrade_required", "message": "请升级 Connector 以使用 MeshCall 创建链路"})
        client, _ = await request.app.state.mesh_operations.client(payload.connectorId)
        await client.ping()
        config = await manager.request(payload.connectorId, "runtime.config", {
            "runtime": payload.runtime, "runtimeId": payload.runtimeId}, timeout=5)
        envelope = OperationRequest(operationId="pending",
            server=await store.operation_server_identity(), userId=user_id,
            connectorId=payload.connectorId, runtimeId=payload.runtimeId, runtime=payload.runtime,
            configRevision=config["config"]["revision"], name=payload.name, path=payload.workspacePath)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, detail="MeshCall 创建通道暂不可用，请确认配套组件已启动") from exc
    try:
        operation, _ = await store.begin_project_operation(user_id=user_id,
            connector_id=payload.connectorId, runtime=payload.runtime, runtime_id=payload.runtimeId,
            request_id=payload.requestId, request=payload.model_dump(), execution=envelope.model_dump())
    except ValueError as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    return await _operation_response(store, operation, user_id)


@router.get("/operations", response_model=ProjectOperationListResponse)
async def pending_project_operations(user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store)) -> ProjectOperationListResponse:
    values = await store.list_pending_project_operations(user_id=user_id)
    return ProjectOperationListResponse(operations=[ProjectPendingOperation(
        request=ProjectCreateRequest.model_validate(json.loads(value["request_json"])),
        operation=await _operation_response(store, value, user_id),
    ) for value in values], serverTime=utc_now())


@router.post("/operations/{operation_id}/ack")
async def acknowledge_project_operation(operation_id: str, user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store)) -> dict[str, bool]:
    try:
        await store.acknowledge_project_operation(operation_id, user_id=user_id)
    except KeyError:
        raise HTTPException(404, detail="operation not found") from None
    except ValueError as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    return {"acknowledged": True}


@router.get("/operations/{operation_id}", response_model=ProjectCreateResponse)
async def project_operation(operation_id: str, user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store), manager: ConnectorRpcManager = Depends(get_rpc)) -> ProjectCreateResponse:
    try:
        operation = await store.get_project_operation(operation_id, user_id=user_id)
    except KeyError:
        raise HTTPException(404, detail="operation not found") from None
    return await _operation_response(store, operation, user_id)


@router.post("/refresh")
async def refresh_projects(connectorId: str, runtime: str, runtimeId: str,
    user_id: str = Depends(current_user_id), store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    runtimes: DeviceRuntimeService = Depends(get_device_runtime_service)) -> dict:
    try:
        bound = await runtimes.get_runtime(connectorId, runtimeId, user_id=user_id)
        if bound.runtimeType != runtime:
            raise HTTPException(422, detail="project Runtime instance type mismatch")
        await runtimes.ensure_session_routable(connectorId, runtime_type=runtime,
            runtime_id=runtimeId, user_id=user_id, ensure_running=True)
        return await manager.request(connectorId, "workspace.refresh", {"runtime": runtime, "runtimeId": runtimeId})
    except DeviceRuntimeError as exc:
        raise HTTPException(exc.status_code, detail=exc.detail) from exc
    except ConnectorOfflineError:
        raise HTTPException(409, detail="connector is offline") from None


@router.patch("/{project_id}", response_model=ProjectResponse)
async def patch_project(
    project_id: str,
    payload: ProjectPatchRequest,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ProjectResponse:
    try:
        project = await store.update_project(
            project_id,
            user_id=user_id,
            name=payload.name,
            pinned=payload.pinned,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="project not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await publish_dashboard_changed(
        store,
        broker,
        user_id=user_id,
        connector_id=project.connectorId,
        reason="project.updated",
    )
    return ProjectResponse(project=project, serverTime=utc_now())


@router.delete("/{project_id}", response_model=ProjectDeleteResponse)
async def delete_project(
    project_id: str,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ProjectDeleteResponse:
    try:
        detached = await store.delete_project(project_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="project not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await publish_dashboard_changed(
        store,
        broker,
        user_id=user_id,
        reason="project.deleted",
    )
    return ProjectDeleteResponse(
        projectId=project_id,
        detachedSessions=detached,
        serverTime=utc_now(),
    )


@router.get(
    "/{project_id}/sessions",
    response_model=ProjectSessionListResponse,
)
async def list_project_sessions(
    project_id: str,
    archived: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=100),
    cursor: str | None = Query(default=None, min_length=1),
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> ProjectSessionListResponse:
    try:
        sessions, has_more, next_cursor = await store.list_project_sessions_page(
            project_id,
            archived=archived,
            limit=limit,
            cursor=cursor,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="project not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ProjectSessionListResponse(
        sessions=await project_session_meta_for_dashboard(
            manager,
            runtime_state_cache,
            sessions,
        ),
        hasMore=has_more,
        nextCursor=next_cursor,
        serverTime=utc_now(),
    )


@router.post(
    "/{project_id}/sessions/archive-all",
    response_model=ArchiveAllResponse,
)
async def archive_all_project_sessions(
    project_id: str,
    payload: ArchiveAllRequest,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ArchiveAllResponse:
    try:
        sessions = await store.archive_project_sessions(
            project_id,
            payload.archived,
            scope=payload.scope,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="project not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await publish_dashboard_changed(
        store,
        broker,
        user_id=user_id,
        reason=(
            "project.sessions.archived"
            if payload.archived
            else "project.sessions.unarchived"
        ),
    )
    return ArchiveAllResponse(
        sessions=await with_effective_session_connector_statuses(manager, sessions),
        affected=len(sessions),
        serverTime=utc_now(),
    )
