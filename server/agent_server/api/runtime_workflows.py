from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from agent_server.core.runtime_workflows import (
    BeginCreationRequest,
    AgentOperationRequest,
    RecoverRuntimeSessionRequest,
    CloseRuntimeSessionRequest,
    PositionSelectionRequest,
    PrepareWorkspaceRequest,
    UpdateAgentConfigurationRequest,
    WorkflowInteractionResponse,
    WorkflowView,
)
from agent_server.deps import current_user_id, get_runtime_workflow_service
from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcError
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
        raise HTTPException(
            getattr(error, "status", 409),
            {
                "code": getattr(error, "code", "operation_conflict"),
                "message": str(error),
            },
        ) from error
    except DeviceRuntimeError as error:
        raise HTTPException(error.status_code, error.detail) from error
    except (ConnectorOfflineError, ConnectorRpcError, TimeoutError) as error:
        raise HTTPException(
            503,
            {
                "code": getattr(error, "code", "outcome_unknown"),
                "message": str(error),
                "queryBeforeRetry": True,
            },
        ) from error


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


@router.get("/sessions/{session_id}/configuration")
async def get_configuration(
    session_id: str,
    service: Annotated[RuntimeWorkflowService, Depends(get_runtime_workflow_service)],
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await invoke(
        service.session_action(
            session_id, "session.configuration.get", {}, user_id=user_id
        )
    )


@router.post("/sessions/{session_id}/configuration")
async def update_configuration(
    session_id: str,
    payload: UpdateAgentConfigurationRequest,
    service: Annotated[RuntimeWorkflowService, Depends(get_runtime_workflow_service)],
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await invoke(
        service.session_action(
            session_id,
            "session.configuration.update",
            payload.model_dump(),
            user_id=user_id,
        )
    )


@router.get("/sessions/{session_id}/tree")
async def session_tree(
    session_id: str,
    service: Annotated[RuntimeWorkflowService, Depends(get_runtime_workflow_service)],
    user_id: Annotated[str, Depends(current_user_id)],
    cursor: str | None = None,
):
    return await invoke(
        service.session_action(
            session_id,
            "session.tree",
            {"limit": 500, **({"cursor": cursor} if cursor else {})},
            user_id=user_id,
        )
    )


@router.post("/sessions/{session_id}/position")
async def select_position(
    session_id: str,
    payload: PositionSelectionRequest,
    service: Annotated[RuntimeWorkflowService, Depends(get_runtime_workflow_service)],
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await invoke(
        service.session_action(
            session_id, "session.position.select", payload.model_dump(), user_id=user_id
        )
    )


@router.post("/sessions/{session_id}/close")
async def close_session(
    session_id: str,
    payload: CloseRuntimeSessionRequest,
    service: Annotated[RuntimeWorkflowService, Depends(get_runtime_workflow_service)],
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await invoke(
        service.session_action(
            session_id, "session.close", payload.model_dump(), user_id=user_id
        )
    )


@router.post("/sessions/{session_id}/operations", status_code=202)
async def agent_operation(
    session_id: str,
    payload: AgentOperationRequest,
    service: Annotated[RuntimeWorkflowService, Depends(get_runtime_workflow_service)],
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await invoke(service.session_action(
        session_id, "session.agent.operate", payload.model_dump(), user_id=user_id,
    ))


@router.post("/sessions/{session_id}/recover", status_code=202)
async def recover_session(
    session_id: str,
    payload: RecoverRuntimeSessionRequest,
    service: Annotated[RuntimeWorkflowService, Depends(get_runtime_workflow_service)],
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await invoke(service.session_action(
        session_id, "session.recover", payload.model_dump(), user_id=user_id,
    ))
