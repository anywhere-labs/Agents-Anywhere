from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from agent_server.core.models import (
    ArchiveAllRequest,
    ArchiveAllResponse,
    ProjectCreateRequest,
    ProjectCreateResponse,
    ProjectDeleteResponse,
    ProjectListResponse,
    ProjectPatchRequest,
    ProjectResponse,
    ProjectSessionListResponse,
)
from agent_server.core.utc import utc_now
from agent_server.deps import (
    current_user_id,
    get_rpc,
    get_session_runtime_state_cache,
    get_store,
    get_timeline_broker,
)
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.repositories.projects import ProjectNameConflictError
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.connector_presence import (
    with_effective_session_connector_statuses,
)
from agent_server.services.dashboard_events import publish_dashboard_changed
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


@router.post("", response_model=ProjectCreateResponse)
async def create_project(
    payload: ProjectCreateRequest,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ProjectCreateResponse:
    try:
        project = await store.create_project(
            user_id=user_id,
            connector_id=payload.connectorId,
            name=payload.name,
            workspace_path=payload.workspacePath,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    except ProjectNameConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "project_name_conflict",
                "message": str(exc),
            },
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await publish_dashboard_changed(
        store,
        broker,
        user_id=user_id,
        connector_id=project.connectorId,
        reason="project.created",
    )
    return ProjectCreateResponse(
        project=project,
        attachedSessions=0,
        serverTime=utc_now(),
    )


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
    except ProjectNameConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "project_name_conflict",
                "message": str(exc),
            },
        ) from exc
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
