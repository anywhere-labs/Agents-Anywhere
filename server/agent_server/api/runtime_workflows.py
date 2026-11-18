from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from agent_server.api.client_forward import forward_session, session_facts
from agent_server.core.device_meshcall import (
    AgentConfigurationView,
    AgentOperationResult,
    ClientServerFacts,
    SessionCloseResult,
    SessionConfigureResult,
    SessionRecoverResult,
)
from agent_server.core.models import SessionView
from agent_server.core.runtime_workflows import (
    AgentOperationRequest,
    BeginCreationRequest,
    CloseRuntimeSessionRequest,
    PositionSelectionRequest,
    PrepareWorkspaceRequest,
    RecoverRuntimeSessionRequest,
    UpdateAgentConfigurationRequest,
    WorkflowInteractionResponse,
    WorkflowView,
)
from agent_server.deps import current_user_id, get_runtime_workflow_service
from agent_server.services.device_runtimes import DeviceRuntimeError
from agent_server.services.runtime_workflows import (
    RuntimeWorkflowService,
    WorkflowError,
)

router = APIRouter(prefix="/runtime-workflows", tags=["runtime-workflows"])
Kind = Literal["preparation", "creation"]


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operationId: str = Field(min_length=1, max_length=160)


async def invoke(awaitable):
    try:
        return await awaitable
    except KeyError:
        raise HTTPException(404, "操作不存在。") from None
    except (ValueError, WorkflowError) as error:
        detail = {
            "code": getattr(error, "code", "operation_conflict"),
            "message": str(error),
        }
        if getattr(error, "query_before_retry", False):
            # Offline, an unknown outcome or the device's own failure: read the workflow before retrying.
            detail["queryBeforeRetry"] = True
        raise HTTPException(getattr(error, "status", 409), detail) from error
    except DeviceRuntimeError as error:
        raise HTTPException(error.status_code, error.detail) from error


@router.post("/preparations", response_model=WorkflowView, status_code=202)
async def prepare(
    payload: PrepareWorkspaceRequest,
    service: Annotated[RuntimeWorkflowService, Depends(get_runtime_workflow_service)],
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await invoke(service.prepare(payload, user_id=user_id))


@router.post("/creations", response_model=WorkflowView, status_code=202)
async def begin(
    payload: BeginCreationRequest,
    service: Annotated[RuntimeWorkflowService, Depends(get_runtime_workflow_service)],
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await invoke(service.begin(payload, user_id=user_id))


@router.get("/{kind}/{identifier}", response_model=WorkflowView)
async def get(
    kind: Kind,
    identifier: str,
    service: Annotated[RuntimeWorkflowService, Depends(get_runtime_workflow_service)],
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await invoke(service.get(identifier, kind, user_id=user_id))


@router.post("/{kind}/{identifier}/responses")
async def respond(
    kind: Kind,
    identifier: str,
    payload: WorkflowInteractionResponse,
    service: Annotated[RuntimeWorkflowService, Depends(get_runtime_workflow_service)],
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await invoke(service.respond(identifier, kind, payload, user_id=user_id))


@router.post("/{kind}/{identifier}/cancel", response_model=WorkflowView)
async def cancel(
    kind: Kind,
    identifier: str,
    payload: CancelRequest,
    service: Annotated[RuntimeWorkflowService, Depends(get_runtime_workflow_service)],
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await invoke(
        service.cancel(identifier, kind, payload.operationId, user_id=user_id)
    )


# The Agent session behind a session lives on the device: these routes go to it with ``Client/call`` (in E2EE mode
# clients send them through the secure channel instead). Sessions on v2 Connectors answer 409
# ``device_upgrade_required``.


async def _facts(session: SessionView) -> ClientServerFacts:
    return session_facts(session)


@router.get("/sessions/{session_id}/configuration", response_model=AgentConfigurationView)
async def get_configuration(
    request: Request,
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await forward_session(
        request, "workflow.session.configuration.get", user_id=user_id, session_id=session_id,
        response_model=AgentConfigurationView, server=_facts,
    )


@router.post("/sessions/{session_id}/configuration", response_model=SessionConfigureResult)
async def update_configuration(
    request: Request,
    session_id: str,
    payload: UpdateAgentConfigurationRequest,
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await forward_session(
        request, "workflow.session.configuration.update", user_id=user_id, session_id=session_id,
        response_model=SessionConfigureResult, server=_facts,
    )


@router.get("/sessions/{session_id}/tree")
async def session_tree(
    request: Request,
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    cursor: str | None = None,
):
    return await forward_session(
        request, "workflow.session.tree", user_id=user_id, session_id=session_id, server=_facts,
    )


@router.post("/sessions/{session_id}/position", response_model=AgentOperationResult)
async def select_position(
    request: Request,
    session_id: str,
    payload: PositionSelectionRequest,
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await forward_session(
        request, "workflow.session.position", user_id=user_id, session_id=session_id,
        response_model=AgentOperationResult, server=_facts,
    )


@router.post("/sessions/{session_id}/close", response_model=SessionCloseResult)
async def close_session(
    request: Request,
    session_id: str,
    payload: CloseRuntimeSessionRequest,
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await forward_session(
        request, "workflow.session.close", user_id=user_id, session_id=session_id,
        response_model=SessionCloseResult, server=_facts,
    )


@router.post("/sessions/{session_id}/operations", status_code=202, response_model=AgentOperationResult)
async def agent_operation(
    request: Request,
    session_id: str,
    payload: AgentOperationRequest,
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await forward_session(
        request, "workflow.session.operations", user_id=user_id, session_id=session_id,
        response_model=AgentOperationResult, server=_facts,
    )


@router.post("/sessions/{session_id}/recover", status_code=202, response_model=SessionRecoverResult)
async def recover_session(
    request: Request,
    session_id: str,
    payload: RecoverRuntimeSessionRequest,
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await forward_session(
        request, "workflow.session.recover", user_id=user_id, session_id=session_id,
        response_model=SessionRecoverResult, server=_facts,
    )
