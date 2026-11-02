from __future__ import annotations

import hashlib
import json
import secrets
from typing import Any, Protocol

from pydantic import ValidationError

from agent_server.core.runtime_workflows import (
    BeginCreationRequest,
    PrepareWorkspaceRequest,
    WorkflowInteractionResponse,
    WorkflowState,
    WorkflowView,
    is_reservation_rejection,
    reservation_rejection,
)
from agent_server.services.device_runtimes import DeviceRuntimeService
from agent_server.services.runtime_workflow_ports import WorkflowRepository


class WorkflowError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.code, self.status = code, status


class WorkflowRpc(Protocol):
    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float = 30,
    ) -> Any: ...


def fingerprint(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
    ).hexdigest()


class RuntimeWorkflowService:
    def __init__(
        self,
        store: WorkflowRepository,
        rpc: WorkflowRpc,
        runtimes: DeviceRuntimeService,
    ) -> None:
        self.store, self.rpc, self.runtimes = store, rpc, runtimes

    async def prepare(
        self, payload: PrepareWorkspaceRequest, *, user_id: str
    ) -> WorkflowView:
        runtime = await self.runtimes.get_runtime(
            payload.connectorId, payload.runtimeId, user_id=user_id
        )
        if runtime.status != "running":
            raise WorkflowError("runtime_not_running", "请先启动 Runtime。")
        capabilities = await self.rpc.request(
            payload.connectorId,
            "runtime.capabilities",
            {"runtime": runtime.runtimeType, "runtimeId": runtime.runtimeId},
        )
        if not any(
            item.get("capabilityId") == "runtime.workspace.prepare"
            and item.get("supported")
            and item.get("available")
            and item.get("allowed")
            for item in capabilities.get("capabilitySet", {}).get("capabilities", [])
        ):
            raise WorkflowError(
                "workflow_unsupported", "该 Runtime 不支持工作区准备。", 422
            )
        project = await self.store.get_project(payload.projectId, user_id=user_id)
        if project.connectorId != payload.connectorId:
            raise WorkflowError(
                "project_workspace_mismatch", "项目不属于所选设备。", 422
            )
        identifier = "prep_" + fingerprint([user_id, payload.clientPreparationId])[:40]
        request = {
            "preparationId": identifier,
            "clientPreparationId": payload.clientPreparationId,
            "cwd": project.workspacePath,
            "projectId": project.id,
        }
        row = await self.store.put_runtime_workflow(
            {
                "id": identifier,
                "kind": "preparation",
                "user_id": user_id,
                "connector_id": payload.connectorId,
                "runtime_id": payload.runtimeId,
                "runtime_type": runtime.runtimeType,
                "project_id": project.id,
                "session_id": None,
                "request": request,
                "input_digest": fingerprint([payload.model_dump(), request]),
                "consumed_by": None,
            }
        )
        return await self._refresh(row, user_id=user_id, begin=True)

    async def begin(
        self, payload: BeginCreationRequest, *, user_id: str
    ) -> WorkflowView:
        # Reuse ordinary session creation's validation before reserving a workflow.
        from agent_server.services.session_run import (
            SessionRunInvalidConfigError,
            _decode_inline_attachment,
        )
        try:
            total = sum(len(_decode_inline_attachment(item)) for item in payload.attachments)
        except SessionRunInvalidConfigError as error:
            raise WorkflowError("invalid_attachment", str(error), 422) from error
        if total > 32 * 1024 * 1024:
            raise WorkflowError("attachments_too_large", "附件总大小不能超过 32 MiB。", 422)
        prep = await self.store.get_runtime_workflow(
            payload.preparationId, user_id=user_id, kind="preparation"
        )
        request = payload.model_dump(exclude_none=True)
        if not payload.attachments:
            request.pop("attachments", None)
        row = await self.store.put_runtime_workflow(
            {
                "id": payload.createOperationId,
                "kind": "creation",
                "user_id": user_id,
                "connector_id": prep["connector_id"],
                "runtime_id": prep["runtime_id"],
                "runtime_type": prep["runtime_type"],
                "project_id": prep["project_id"],
                "session_id": "sess_" + secrets.token_urlsafe(16),
                "request": request,
                "input_digest": fingerprint(request),
                "consumed_by": None,
            }
        )
        return await self._refresh(row, user_id=user_id, begin=True)

    async def get(self, identifier: str, kind: str, *, user_id: str) -> WorkflowView:
        row = await self.store.get_runtime_workflow(
            identifier, user_id=user_id, kind=kind
        )
        return await self._refresh(row, user_id=user_id, begin=not row["result"])

    async def respond(
        self,
        identifier: str,
        kind: str,
        payload: WorkflowInteractionResponse,
        *,
        user_id: str,
    ) -> dict[str, Any]:
        row = await self.store.get_runtime_workflow(
            identifier, user_id=user_id, kind=kind
        )
        # This request never holds a creation transition lock while awaiting the engine.
        if is_reservation_rejection(row["result"]):
            raise WorkflowError("not_pending", "该创建已明确拒绝，没有待回答请求。")
        return await self._call(
            row,
            "workspace.preparation.respond"
            if kind == "preparation"
            else "session.creation.respond",
            {
                "preparationId"
                if kind == "preparation"
                else "createOperationId": identifier,
                **payload.model_dump(exclude_none=True),
            },
        )

    async def cancel(
        self, identifier: str, kind: str, operation_id: str, *, user_id: str
    ) -> WorkflowView:
        row = await self.store.get_runtime_workflow(
            identifier, user_id=user_id, kind=kind
        )
        if is_reservation_rejection(row["result"]):
            return self._view(row, row["result"])
        params = (
            {"preparationId": identifier}
            if kind == "preparation"
            else {"createOperationId": identifier, "cancelOperationId": operation_id}
        )
        result = await self._call(
            row,
            "workspace.preparation.cancel"
            if kind == "preparation"
            else "session.creation.cancel",
            params,
        )
        await self.store.set_runtime_workflow_result(
            identifier, user_id=user_id, kind=kind, result=result
        )
        return self._view(row, result)

    async def session_action(
        self, session_id: str, method: str, values: dict[str, Any], *, user_id: str
    ) -> dict[str, Any]:
        session = await self.store.get_session(session_id, user_id=user_id)
        if (
            method not in {"session.tree", "session.configuration.get"}
            and not (method == "session.agent.operate" and values.get("operation") in {"authentication.status", "resources.get", "queue.get"})
            and not session.takeover
        ):
            raise WorkflowError("takeover_required", "请先授权工作台控制此会话。")
        row = {
            "user_id": user_id,
            "connector_id": session.connectorId,
            "runtime_id": session.runtimeId or session.runtime,
            "runtime_type": session.runtime,
        }
        capabilities = await self._call(
            row, "session.capabilities", {"sessionId": session_id}
        )
        required = {
            "session.tree": "session.execution_position.read",
            "session.position.select": "session.execution_position.select",
            "session.close": "session.close",
            "session.configuration.get": "session.configuration.read",
            "session.configuration.update": "session.configuration.update",
            "session.recover": "session.recover",
            "session.agent.operate": {
                "authentication.status": "session.authentication.read", "resources.get": "session.resources.read",
                "resources.reload": "session.resources.update", "queue.get": "session.queue.read",
                "queue.clear": "session.queue.update", "message.follow_up": "session.follow_up",
                "session.rename": "session.rename", "session.fork": "session.fork",
                "directories.add": "session.directories.update", "tools.set": "session.tools.update",
            }.get(values.get("operation"), "unsupported"),
        }[method]
        if not any(
            cap.get("capabilityId") == required
            and cap.get("supported")
            and (cap.get("available") or method in {"session.close", "session.recover"})
            and cap.get("allowed")
            for cap in capabilities.get("capabilitySet", {}).get("capabilities", [])
        ):
            raise WorkflowError("capability_unavailable", "该会话当前不能执行此操作。")
        return await self._call(row, method, {"sessionId": session_id, **values})

    async def _call(
        self, row: dict[str, Any], method: str, values: dict[str, Any]
    ) -> dict[str, Any]:
        await self.runtimes.get_runtime(
            row["connector_id"], row["runtime_id"], user_id=row["user_id"]
        )
        result = await self.rpc.request(
            row["connector_id"],
            method,
            {"runtime": row["runtime_type"], "runtimeId": row["runtime_id"], **values},
            timeout=20,
        )
        if not isinstance(result, dict):
            raise WorkflowError(
                "invalid_runtime_response", "Runtime 返回的操作结果无效。", 502
            )
        if "catalog" in result:
            try:
                WorkflowState.model_validate(result)
            except ValidationError as error:
                raise WorkflowError(
                    "invalid_runtime_response", "Runtime 返回的模型目录不符合协议，请更新 Connector。", 502
                ) from error
        return result

    async def _refresh(
        self, row: dict[str, Any], *, user_id: str, begin: bool
    ) -> WorkflowView:
        if is_reservation_rejection(row["result"]):
            return self._view(row, row["result"])
        if row["kind"] == "preparation":
            method = "workspace.prepare" if begin else "workspace.preparation.get"
            params = row["request"] if begin else {"preparationId": row["id"]}
        else:
            request = row["request"]
            if begin:
                prep = await self.store.get_runtime_workflow(
                    request["preparationId"], user_id=user_id, kind="preparation"
                )
                reservation = await self._call(
                    row,
                    "workspace.preparation.reserve",
                    {
                        "preparationId": prep["id"],
                        "createOperationId": row["id"],
                        "platformSessionId": row["session_id"],
                        "expectedRevision": request["expectedRevision"],
                        "catalogRevision": request["catalogRevision"],
                        "selections": request["selections"],
                        **(
                            {"configuration": request["configuration"]}
                            if "configuration" in request
                            else {}
                        ),
                    },
                )
                if reservation.get("reserved") is False:
                    failure = reservation.get("failure")
                    if not isinstance(failure, dict) or not all(
                        isinstance(failure.get(key), str) for key in ("code", "message")
                    ):
                        raise WorkflowError(
                            "invalid_runtime_response",
                            "Runtime 未预留但缺少明确拒绝事实。",
                            502,
                        )
                    rejected = await self.store.reject_unreserved_creation(
                        row["id"],
                        user_id=user_id,
                        result=reservation_rejection(failure),
                    )
                    return self._view(row, rejected)
                if reservation.get("reserved") is not True:
                    raise WorkflowError(
                        "invalid_runtime_response", "Runtime 未确认准备预留。", 502
                    )
                await self.store.create_session(
                    session_id=row["session_id"],
                    connector_id=row["connector_id"],
                    project_id=row["project_id"],
                    user_id=user_id,
                    runtime=row["runtime_type"],
                    runtime_id=row["runtime_id"],
                    external_session_id=None,
                    title=request.get("title"),
                    cwd=prep["request"]["cwd"],
                    selections=request["selections"],
                    model_selection_id=request["selections"].get("model"),
                    permission_selection_id=request["selections"].get("permission"),
                    takeover=True,
                )
                method = "session.creation.begin"
                params = {
                    key: value
                    for key, value in request.items()
                    if key not in {"expectedRevision", "catalogRevision", "attachments"}
                }
                params["sessionId"] = row["session_id"]
                if request.get("attachments"):
                    from agent_server.core.models import InlineAttachmentRef
                    from agent_server.services.session_run import (
                        _decode_inline_attachment,
                    )
                    refs = []
                    for raw in request["attachments"]:
                        item = InlineAttachmentRef.model_validate(raw)
                        data = _decode_inline_attachment(item)
                        # A retried creation uploads to the same ID and sends identical
                        # references to the Runtime, including after a lost response.
                        file_id = "file_" + fingerprint([row["id"], item.fileId, hashlib.sha256(data).hexdigest(), item.name, item.mediaType])[:40]
                        saved = await self.store.save_user_uploaded_file(
                            session_id=row["session_id"], user_id=user_id,
                            name=item.name, data=data, media_type=item.mediaType, file_id=file_id,
                        )
                        refs.append({key: saved[key] for key in ("fileId", "name", "mediaType", "size", "sha256")})
                    params["attachments"] = refs
                    params["timelineAttachments"] = refs
            else:
                method, params = (
                    "session.creation.get",
                    {"createOperationId": row["id"]},
                )
        result = await self._call(row, method, params)
        await self.store.set_runtime_workflow_result(
            row["id"], user_id=user_id, kind=row["kind"], result=result
        )
        return self._view(row, result)

    @staticmethod
    def _view(row: dict[str, Any], state: dict[str, Any]) -> WorkflowView:
        return WorkflowView(
            protocolVersion="1.2"
            if "configuration" in state or "configuration" in row["request"]
            else "1.1",
            id=row["id"],
            kind=row["kind"],
            connectorId=row["connector_id"],
            runtimeId=row["runtime_id"],
            projectId=row["project_id"],
            sessionId=None
            if state.get("platformSessionCreated") is False
            else row["session_id"],
            state=state,
        )
