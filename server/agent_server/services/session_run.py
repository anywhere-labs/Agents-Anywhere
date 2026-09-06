from __future__ import annotations

import base64
import binascii
import hashlib
from dataclasses import dataclass
from typing import Any

from agent_server.core.api_namespace import api_v2_path
from agent_server.core.capabilities import (
    CATALOG_MODEL,
    CATALOG_PERMISSION,
    RUNTIME_ATTACHMENT,
    SESSION_INTERRUPT,
    SESSION_SEND_MESSAGE,
    SESSION_STEER,
)
from agent_server.core.models import (
    InlineAttachmentRef,
    MessageCreateRequest,
    RpcResponsePayload,
    SessionCreateAndStartRequest,
    SessionCreateRequest,
    SessionRuntimeState,
    SessionSelectionPatchRequest,
    SessionStatus,
    SessionSteerRequest,
    SessionView,
)
from agent_server.core.protocol import ProtocolCapabilitySet
from agent_server.core.runtime_identity import (
    SessionRuntimeBindingError,
    resolve_session_runtime_binding,
)
from agent_server.core.utc import utc_now
from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.infra.repositories.projects import _clean_workspace_path
from agent_server.services.device_runtimes import (
    DeviceRuntimeError,
    DeviceRuntimeService,
)
from agent_server.services.effective_capabilities import (
    derive_session_effective_capabilities,
)
from agent_server.services.repository_ports import SessionRunRepository


class SessionRunError(RuntimeError):
    status_code = 500

    def __init__(self, detail: Any) -> None:
        super().__init__(detail)
        self.detail = detail


class SessionRunNotFoundError(SessionRunError):
    status_code = 404


class SessionRunConflictError(SessionRunError):
    status_code = 409


class SessionRunUpstreamError(SessionRunError):
    status_code = 502


class SessionRunInvalidConfigError(SessionRunError):
    status_code = 422


class SessionRunInstancesUnsupportedError(SessionRunConflictError):
    def __init__(self) -> None:
        super().__init__(
            {
                "code": "runtime_instances_unsupported",
                "message": "connector does not support named runtime instances",
            }
        )


SESSION_SOURCE_ERROR_CODES = {
    "archived": "session_archived",
    "unavailable": "session_unavailable",
    "deleted": "session_deleted",
    "missing": "session_missing",
}


@dataclass(frozen=True, slots=True)
class PersistedInlineAttachment:
    file_id: str
    name: str
    media_type: str
    size: int
    sha256: str


class SessionRunService:
    def __init__(
        self,
        store: SessionRunRepository,
        manager: ConnectorRpcManager,
        device_runtimes: DeviceRuntimeService,
    ) -> None:
        self._store = store
        self._manager = manager
        self._device_runtimes = device_runtimes

    async def create_session(
        self,
        payload: SessionCreateRequest,
        *,
        user_id: str,
    ) -> dict[str, Any]:
        try:
            connector = await self._store.get_connector(payload.connectorId)
            if connector.userId != user_id:
                raise KeyError(payload.connectorId)
        except KeyError:
            raise SessionRunNotFoundError("connector not found") from None
        project_id, project_cwd = await self._validate_project_binding(
            payload.projectId,
            connector_id=payload.connectorId,
            cwd=payload.cwd,
            user_id=user_id,
        )
        payload.cwd = project_cwd
        runtime_id = _request_runtime_id(payload)
        await self._require_runtime_instance(
            payload.connectorId,
            payload.runtime,
            runtime_id,
            user_id=user_id,
            require_running=False,
        )

        connector_result = None
        if payload.externalSessionId is not None:
            session = await self._store.create_session(
                connector_id=payload.connectorId,
                project_id=project_id,
                user_id=user_id,
                runtime=payload.runtime,
                runtime_id=runtime_id,
                external_session_id=payload.externalSessionId,
                title=payload.title,
                cwd=payload.cwd,
            )
            return {"session": session, "connectorResult": connector_result}

        raise SessionRunInvalidConfigError(
            "new sessions must use /sessions/create-and-start"
        )

    async def create_and_start_session(
        self,
        payload: SessionCreateAndStartRequest,
        *,
        user_id: str,
    ) -> dict[str, Any]:
        try:
            connector = await self._store.get_connector(payload.connectorId)
            if connector.userId != user_id:
                raise KeyError(payload.connectorId)
        except KeyError:
            raise SessionRunNotFoundError("connector not found") from None
        project_id, project_cwd = await self._validate_project_binding(
            payload.projectId,
            connector_id=payload.connectorId,
            cwd=payload.cwd,
            user_id=user_id,
        )
        payload.cwd = project_cwd
        runtime_id = _request_runtime_id(payload)
        await self._require_runtime_instance(
            payload.connectorId,
            payload.runtime,
            runtime_id,
            user_id=user_id,
            require_running=True,
        )
        if not await self._manager.is_online(payload.connectorId):
            raise SessionRunConflictError("connector is offline")
        if payload.attachments:
            await self._require_runtime_capability(
                payload.connectorId,
                payload.runtime,
                runtime_id,
                RUNTIME_ATTACHMENT,
                user_id=user_id,
            )

        selections = _selections_from_mapping(payload.selections)
        session = await self._store.create_session(
            connector_id=payload.connectorId,
            project_id=project_id,
            user_id=user_id,
            runtime=payload.runtime,
            runtime_id=runtime_id,
            external_session_id=None,
            title=payload.title,
            cwd=payload.cwd,
            selections=selections,
            takeover=True,
        )
        params: dict[str, Any] = {
            "runtime": payload.runtime,
            "runtimeId": runtime_id,
            "sessionId": session.id,
            "content": payload.content,
        }
        if payload.title is not None:
            params["title"] = payload.title
        if payload.cwd is not None:
            params["cwd"] = payload.cwd
        if selections:
            params["selections"] = selections
        if payload.clientMessageId:
            params["clientMessageId"] = payload.clientMessageId
        persisted_attachment_refs: list[dict[str, Any]] = []
        if payload.attachments:
            persisted_attachments = await self._persist_inline_attachments(
                session_id=session.id,
                user_id=user_id,
                attachments=payload.attachments,
            )
            persisted_attachment_refs = [
                _timeline_payload_from_persisted_inline_attachment(attachment)
                for attachment in persisted_attachments
            ]
            params["attachments"] = [
                _connector_attachment_reference_payload(attachment)
                for attachment in persisted_attachments
            ]
            params["timelineAttachments"] = persisted_attachment_refs

        await self._store.start_active_run(
            session_id=session.id,
            runtime=payload.runtime,
            runtime_id=runtime_id,
            params=params,
        )
        try:
            connector_result = await self._manager.request(
                payload.connectorId,
                "session.create",
                params,
                timeout=60,
            )
        except ConnectorOfflineError as exc:
            await self._store.clear_active_run(session.id)
            raise SessionRunConflictError(str(exc)) from exc
        except ConnectorRpcError as exc:
            await self._store.clear_active_run(session.id)
            raise SessionRunUpstreamError(exc.message or exc.code) from exc

        if not isinstance(connector_result, dict):
            await self._mark_create_and_start_failed(
                session.id,
                runtime=payload.runtime,
                code="invalid_connector_result",
                message="connector did not return a session result",
            )
            raise SessionRunUpstreamError("connector did not return a session result")
        try:
            resolve_session_runtime_binding(
                connector_result,
                session_id=session.id,
                runtime_type=payload.runtime,
                runtime_id=runtime_id,
            )
        except SessionRuntimeBindingError as exc:
            await self._mark_create_and_start_failed(
                session.id,
                runtime=payload.runtime,
                code="invalid_runtime_binding",
                message=str(exc),
            )
            raise SessionRunUpstreamError(str(exc)) from exc
        external_session_id = connector_result.get("externalSessionId")
        if external_session_id is not None and (
            not isinstance(external_session_id, str) or not external_session_id
        ):
            await self._mark_create_and_start_failed(
                session.id,
                runtime=payload.runtime,
                code="missing_external_session_id",
                message="connector returned an invalid external session id",
            )
            raise SessionRunUpstreamError("connector returned an invalid external session id")
        await self._store.start_active_run(
            session_id=session.id,
            runtime=payload.runtime,
            runtime_id=runtime_id,
            external_session_id=external_session_id if isinstance(external_session_id, str) else None,
            params=params,
        )
        session = await self._store.upsert_connector_session(
            connector_id=payload.connectorId,
            session_id=session.id,
            runtime=payload.runtime,
            runtime_id=runtime_id,
            external_session_id=external_session_id if isinstance(external_session_id, str) else None,
            title=payload.title,
            cwd=payload.cwd,
            last_synced_at=utc_now(),
            origin="platform",
        )
        return {
            "session": session,
            "connectorResult": connector_result,
            "attachments": persisted_attachment_refs,
        }

    async def _validate_project_binding(
        self,
        project_id: str | None,
        *,
        connector_id: str,
        cwd: str | None,
        user_id: str,
    ) -> tuple[str, str]:
        if not project_id:
            raise SessionRunInvalidConfigError(
                {
                    "code": "project_required",
                    "message": "a project must be selected for every session",
                }
            )
        try:
            project = await self._store.get_project(project_id, user_id=user_id)
        except KeyError:
            raise SessionRunNotFoundError("project not found") from None
        if project.connectorId != connector_id:
            raise SessionRunInvalidConfigError(
                {
                    "code": "project_workspace_mismatch",
                    "message": (
                        "project connector and workspace must match the session"
                    ),
                }
            )
        if cwd is None:
            # Keep the connector request and the persisted session on the
            # project's canonical workspace path.
            cwd = project.workspacePath
        else:
            try:
                _cleaned_cwd, cwd_key = _clean_workspace_path(cwd, None)
                _project_path, project_key = _clean_workspace_path(
                    project.workspacePath,
                    None,
                )
            except ValueError:
                cwd_key = ""
                project_key = "__invalid__"
            if cwd_key != project_key:
                raise SessionRunInvalidConfigError(
                    {
                        "code": "project_workspace_mismatch",
                        "message": (
                            "project connector and workspace must match the session"
                        ),
                    }
                )
        return project.id, project.workspacePath

    async def _mark_create_and_start_failed(
        self,
        session_id: str,
        *,
        runtime: str,
        code: str,
        message: str,
    ) -> None:
        await self._store.clear_active_run(session_id)

    async def send_message(
        self,
        session_id: str,
        payload: MessageCreateRequest,
        *,
        user_id: str,
    ) -> RpcResponsePayload:
        try:
            session = await self._store.get_session(session_id, user_id=user_id)
        except KeyError:
            raise SessionRunNotFoundError("session not found") from None

        if session.archived:
            raise SessionRunConflictError(_session_source_error_detail(session))
        if not session.takeover:
            raise SessionRunConflictError("session is read-only until takeover is enabled")
        if not await self._manager.is_online(session.connectorId):
            raise SessionRunConflictError("connector is offline")
        await self._require_session_capability(
            session,
            SESSION_SEND_MESSAGE,
            user_id=user_id,
        )
        await self._ensure_session_runtime_running(session, user_id=user_id)
        runtime_status = await self._read_runtime_status(session)
        if runtime_status not in {"idle", "error"}:
            raise SessionRunConflictError(f"session is {runtime_status}")
        params: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": session.runtime,
            "runtimeId": _session_runtime_id(session),
            "content": payload.content,
        }
        if session.cwd:
            params["cwd"] = session.cwd
        if session.externalSessionId:
            params["externalSessionId"] = session.externalSessionId
        if payload.clientMessageId:
            params["clientMessageId"] = payload.clientMessageId
        if payload.attachments:
            await self._require_session_capability(
                session,
                RUNTIME_ATTACHMENT,
                user_id=user_id,
            )
            attachment_payloads = await self._attachment_payloads(
                session_id=session_id,
                user_id=user_id,
                file_ids=[a.fileId for a in payload.attachments],
            )
            params["attachments"] = attachment_payloads
            params["timelineAttachments"] = [_timeline_attachment_payload(item) for item in attachment_payloads]

        await self._store.start_active_run(
            session_id=session_id,
            runtime=session.runtime,
            runtime_id=_session_runtime_id(session),
            external_session_id=session.externalSessionId,
            params=params,
        )
        try:
            result = await self._manager.request(
                session.connectorId,
                "session.send_message",
                params,
            )
        except ConnectorOfflineError as exc:
            await self._store.clear_active_run(session_id)
            raise SessionRunConflictError(str(exc)) from exc
        except ConnectorRpcError as exc:
            await self._store.clear_active_run(session_id)
            raise SessionRunUpstreamError(exc.message or exc.code) from exc
        if isinstance(result, dict) and result.get("ok") is False:
            await self._store.clear_active_run(session_id)
            await self._persist_operation_source_state(session, result)
            code = result.get("code")
            message = result.get("message")
            raise SessionRunConflictError(
                {
                    "code": code if isinstance(code, str) else "runtime_operation_failed",
                    "message": (
                        message
                        if isinstance(message, str)
                        else "runtime operation failed"
                    ),
                }
            )
        return RpcResponsePayload(ok=True, result=result)

    async def _persist_operation_source_state(
        self,
        session: SessionView,
        result: dict[str, Any],
    ) -> None:
        source_state = result.get("sourceState")
        if not isinstance(source_state, dict):
            return
        availability = source_state.get("availability")
        observation_origin = source_state.get("observationOrigin")
        if availability not in SESSION_SOURCE_ERROR_CODES:
            return
        if observation_origin not in {"event", "inventory", "operation"}:
            return
        if source_state.get("sessionId") not in {None, session.id}:
            return
        if source_state.get("runtime") not in {None, session.runtime}:
            return
        reason = source_state.get("reason")
        observed_at = source_state.get("observedAt")
        await self._store.update_session_source_state(
            session.id,
            availability=availability,
            reason=reason if isinstance(reason, str) else None,
            observed_at=observed_at if isinstance(observed_at, str) else None,
            observation_origin=observation_origin,
        )

    async def _read_runtime_status(self, session: SessionView) -> SessionStatus:
        params: dict[str, Any] = {
            "sessionId": session.id,
            "runtime": session.runtime,
            "runtimeId": _session_runtime_id(session),
        }
        if session.externalSessionId:
            params["externalSessionId"] = session.externalSessionId
        try:
            result = await self._manager.request(
                session.connectorId,
                "session.state",
                params,
                timeout=10,
            )
        except ConnectorOfflineError as exc:
            raise SessionRunConflictError(str(exc)) from exc
        except ConnectorRpcError as exc:
            raise SessionRunUpstreamError(exc.message or exc.code) from exc
        if not isinstance(result, dict):
            return "idle"
        state = result.get("state")
        if not isinstance(state, dict):
            return "idle"
        try:
            resolve_session_runtime_binding(
                state,
                session_id=session.id,
                runtime_type=session.runtime,
                runtime_id=_session_runtime_id(session),
            )
        except SessionRuntimeBindingError as exc:
            raise SessionRunUpstreamError(str(exc)) from exc
        status = state.get("status")
        if status in {
            "idle",
            "waiting",
            "pending",
            "running",
            "stopping",
            "waiting_approval",
            "error",
            "blocked",
        }:
            return status
        return "idle"

    async def update_session_selections(
        self,
        session_id: str,
        payload: SessionSelectionPatchRequest,
        *,
        user_id: str,
    ) -> tuple[SessionRuntimeState, dict[str, Any] | None]:
        try:
            session = await self._store.get_session(session_id, user_id=user_id)
        except KeyError:
            raise SessionRunNotFoundError("session not found") from None
        if not session.takeover:
            raise SessionRunConflictError("session is read-only until takeover is enabled")
        if not await self._manager.is_online(session.connectorId):
            raise SessionRunConflictError("connector is offline")
        for selection_type, capability_id in (
            ("model", CATALOG_MODEL),
            ("permission", CATALOG_PERMISSION),
        ):
            if selection_type in payload.selections:
                await self._require_session_capability(
                    session,
                    capability_id,
                    user_id=user_id,
                )
        await self._ensure_session_runtime_running(session, user_id=user_id)
        params: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": session.runtime,
            "runtimeId": _session_runtime_id(session),
            "selections": payload.selections,
        }
        if session.externalSessionId:
            params["externalSessionId"] = session.externalSessionId
        try:
            result = await self._manager.request(
                session.connectorId,
                "session.selections.update",
                params,
                timeout=30,
            )
        except ConnectorOfflineError as exc:
            raise SessionRunConflictError(str(exc)) from exc
        except ConnectorRpcError as exc:
            raise SessionRunUpstreamError(exc.message or exc.code) from exc
        if isinstance(result, dict) and result.get("ok") is False:
            code = result.get("code")
            message = result.get("message")
            raise SessionRunUpstreamError(
                str(message or code or "runtime rejected selection update")
            )
        try:
            state = _runtime_state_from_selection_result(
                session,
                payload.selections,
                result,
            )
        except SessionRuntimeBindingError as exc:
            raise SessionRunUpstreamError(str(exc)) from exc
        return state, result if isinstance(result, dict) else None

    async def steer_session(
        self,
        session_id: str,
        payload: SessionSteerRequest,
        *,
        user_id: str,
    ) -> RpcResponsePayload:
        try:
            session = await self._store.get_session(session_id, user_id=user_id)
        except KeyError:
            raise SessionRunNotFoundError("session not found") from None
        if not session.takeover:
            raise SessionRunConflictError(
                "session is read-only until takeover is enabled"
            )
        if not await self._manager.is_online(session.connectorId):
            raise SessionRunConflictError("connector is offline")
        await self._require_session_capability(
            session,
            SESSION_STEER,
            user_id=user_id,
        )
        await self._ensure_session_runtime_running(session, user_id=user_id)
        runtime_status = await self._read_runtime_status(session)
        if runtime_status != "running":
            raise SessionRunConflictError("session is not running")

        params: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": session.runtime,
            "runtimeId": _session_runtime_id(session),
            "content": payload.content,
        }
        external_session_id = session.externalSessionId
        if external_session_id:
            params["externalSessionId"] = external_session_id
        if session.cwd:
            params["cwd"] = session.cwd
        if payload.clientMessageId:
            params["clientMessageId"] = payload.clientMessageId
        if payload.attachments:
            await self._require_session_capability(
                session,
                RUNTIME_ATTACHMENT,
                user_id=user_id,
            )
            attachment_payloads = await self._attachment_payloads(
                session_id=session_id,
                user_id=user_id,
                file_ids=[attachment.fileId for attachment in payload.attachments],
            )
            params["attachments"] = attachment_payloads
            params["timelineAttachments"] = [
                _timeline_attachment_payload(item) for item in attachment_payloads
            ]

        try:
            result = await self._manager.request(
                session.connectorId,
                "session.steer",
                params,
            )
        except ConnectorOfflineError as exc:
            raise SessionRunConflictError(str(exc)) from exc
        except ConnectorRpcError as exc:
            raise SessionRunUpstreamError(exc.message or exc.code) from exc
        return RpcResponsePayload(ok=True, result=result)

    async def _require_runtime_capability(
        self,
        connector_id: str,
        runtime: str,
        runtime_id: str,
        capability_id: str,
        *,
        user_id: str,
    ) -> None:
        capability_set = ProtocolCapabilitySet.model_validate(
            await self._store.get_protocol_capabilities(
                connector_id,
                user_id=user_id,
            )
        )
        capability = next(
            (
                item
                for item in capability_set.capabilities
                if item.runtime == runtime
                and item.scope == "runtime"
                and item.capabilityId == capability_id
                and _capability_runtime_id(item) == runtime_id
            ),
            None,
        )
        if capability is None:
            capability = next(
                (
                    item
                    for item in capability_set.capabilities
                    if item.runtime == runtime
                    and item.scope == "runtime"
                    and item.capabilityId == capability_id
                    and _capability_runtime_id(item) is None
                ),
                None,
            )
        if capability is None or not (
            capability.supported and capability.available and capability.allowed
        ):
            raise SessionRunConflictError(
                f"runtime capability is unavailable: {capability_id}"
            )

    async def _require_session_capability(
        self,
        session: SessionView,
        capability_id: str,
        *,
        user_id: str,
    ) -> None:
        capability_set = ProtocolCapabilitySet.model_validate(
            await self._store.get_protocol_capabilities(
                session.connectorId,
                user_id=user_id,
            )
        )
        online_session = session.model_copy(update={"connectorStatus": "online"})
        effective = derive_session_effective_capabilities(
            session=online_session,
            runtime_capabilities=capability_set,
        )
        capability = next(
            (
                item
                for item in effective.capabilities
                if item.capabilityId == capability_id
            ),
            None,
        )
        if capability is None or not (
            capability.supported and capability.available and capability.allowed
        ):
            raise SessionRunConflictError(
                f"session capability is unavailable: {capability_id}"
            )

    async def _require_runtime_instance(
        self,
        connector_id: str,
        runtime: str,
        runtime_id: str,
        *,
        user_id: str,
        require_running: bool,
    ) -> None:
        try:
            await self._device_runtimes.ensure_session_routable(
                connector_id,
                runtime_type=runtime,
                runtime_id=runtime_id,
                user_id=user_id,
                ensure_running=require_running,
            )
        except DeviceRuntimeError as exc:
            self._raise_device_runtime_error(exc)

    async def _ensure_session_runtime_running(
        self,
        session: SessionView,
        *,
        user_id: str,
    ) -> None:
        await self._require_runtime_instance(
            session.connectorId,
            session.runtime,
            _session_runtime_id(session),
            user_id=user_id,
            require_running=True,
        )

    @staticmethod
    def _raise_device_runtime_error(exc: DeviceRuntimeError) -> None:
        if exc.code == "runtime_instances_unsupported":
            raise SessionRunInstancesUnsupportedError() from exc
        if exc.status_code == 404:
            raise SessionRunNotFoundError(exc.message) from exc
        if exc.status_code == 422:
            raise SessionRunInvalidConfigError(exc.detail) from exc
        if exc.status_code == 502:
            raise SessionRunUpstreamError(exc.detail) from exc
        raise SessionRunConflictError(exc.detail) from exc

    async def _attachment_payloads(
        self,
        *,
        session_id: str,
        user_id: str,
        file_ids: list[str],
    ) -> list[PersistedInlineAttachment]:
        payloads: list[dict[str, Any]] = []
        for file_id in file_ids:
            try:
                metadata = await self._store.read_uploaded_file(
                    session_id=session_id,
                    file_id=file_id,
                    user_id=user_id,
                )
            except KeyError:
                raise SessionRunNotFoundError(f"attachment not found: {file_id}") from None
            except ValueError as exc:
                raise SessionRunInvalidConfigError(str(exc)) from exc
            payloads.append(
                {
                    "fileId": metadata.get("fileId") or file_id,
                    "name": metadata.get("name") or file_id,
                    "mediaType": metadata.get("mediaType") or "",
                    "size": metadata.get("size"),
                    "sha256": metadata.get("sha256"),
                    "downloadUrl": api_v2_path(f"/connector/sessions/{session_id}/attachments/{file_id}/content"),
                    "platformOpenUrl": api_v2_path(f"/sessions/{session_id}/attachments/{file_id}/open"),
                }
            )
        return payloads

    async def _persist_inline_attachments(
        self,
        *,
        session_id: str,
        user_id: str,
        attachments: list[InlineAttachmentRef],
    ) -> list[dict[str, Any]]:
        """Persist create-and-start inline attachments into session file storage.

        Side effects:
        - decodes request base64
        - writes each attachment into the server session-scoped file store
        """

        persisted: list[PersistedInlineAttachment] = []
        for attachment in attachments:
            data = _decode_inline_attachment(attachment)
            saved = await self._store.save_user_uploaded_file(
                session_id=session_id,
                user_id=user_id,
                name=attachment.name,
                data=data,
                media_type=attachment.mediaType,
            )
            persisted.append(
                PersistedInlineAttachment(
                    file_id=str(saved["fileId"]),
                    name=str(saved["name"]),
                    media_type=str(saved.get("mediaType") or ""),
                    size=int(saved["size"]),
                    sha256=str(saved["sha256"]),
                )
            )
        return persisted

    async def interrupt_session(
        self,
        session_id: str,
        *,
        user_id: str,
    ) -> RpcResponsePayload:
        return await self._interrupt_session(session_id, user_id=user_id, require_takeover=True)

    async def interrupt_session_internal(
        self,
        session_id: str,
        *,
        user_id: str,
    ) -> RpcResponsePayload:
        return await self._interrupt_session(session_id, user_id=user_id, require_takeover=False)

    async def _interrupt_session(
        self,
        session_id: str,
        *,
        user_id: str,
        require_takeover: bool,
    ) -> RpcResponsePayload:
        try:
            session = await self._store.get_session(session_id, user_id=user_id)
        except KeyError:
            raise SessionRunNotFoundError("session not found") from None
        if require_takeover and not session.takeover:
            raise SessionRunConflictError("session is read-only until takeover is enabled")
        if require_takeover:
            await self._require_session_capability(
                session,
                SESSION_INTERRUPT,
                user_id=user_id,
            )
        await self._ensure_session_runtime_running(session, user_id=user_id)
        params: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": session.runtime,
            "runtimeId": _session_runtime_id(session),
        }
        try:
            result = await self._manager.request(
                session.connectorId,
                "session.interrupt",
                params,
            )
        except ConnectorOfflineError as exc:
            raise SessionRunConflictError(str(exc)) from exc
        except ConnectorRpcError as exc:
            raise SessionRunUpstreamError(exc.message or exc.code) from exc
        await self._store.clear_active_run(session_id)
        return RpcResponsePayload(ok=True, result=result)


def _session_source_error_detail(session: SessionView) -> dict[str, str]:
    availability = session.sourceAvailability
    code = SESSION_SOURCE_ERROR_CODES.get(availability, "session_archived")
    if session.userArchived and session.archiveSource == "user":
        message = "session is archived in Agents Anywhere"
    else:
        message = f"session is {availability} in the local runtime"
    return {"code": code, "message": message}


def _selections_from_mapping(value: dict[str, str | None]) -> dict[str, str]:
    return {key: item for key, item in value.items() if isinstance(item, str) and item}


def _request_runtime_id(
    payload: SessionCreateRequest | SessionCreateAndStartRequest,
) -> str:
    return payload.runtimeId or payload.runtime


def _session_runtime_id(session: SessionView) -> str:
    return session.runtimeId or session.runtime


def _capability_runtime_id(capability: Any) -> str | None:
    value = getattr(capability, "runtimeId", None)
    return value if isinstance(value, str) and value else None


def _runtime_state_from_selection_result(
    session: SessionView,
    selections: dict[str, str | None],
    result: object,
) -> SessionRuntimeState:
    now = utc_now()
    raw_state = result.get("state") if isinstance(result, dict) else None
    if isinstance(raw_state, dict):
        session_id, runtime, runtime_id = resolve_session_runtime_binding(
            raw_state,
            session_id=session.id,
            runtime_type=session.runtime,
            runtime_id=_session_runtime_id(session),
        )
        return SessionRuntimeState.model_validate(
            {
                "sessionId": session_id,
                "runtime": runtime,
                "runtimeId": runtime_id,
                "externalSessionId": raw_state.get("externalSessionId")
                or session.externalSessionId,
                "status": raw_state.get("status") or "idle",
                "selections": raw_state.get("selections")
                if isinstance(raw_state.get("selections"), dict)
                else selections,
                "statusReason": raw_state.get("statusReason"),
                "error": raw_state.get("error")
                if isinstance(raw_state.get("error"), dict)
                else None,
                "metadata": raw_state.get("metadata")
                if isinstance(raw_state.get("metadata"), dict)
                else {},
                "updatedSeq": session.updatedSeq,
                "createdAt": now,
                "updatedAt": now,
            }
        )
    return SessionRuntimeState(
        sessionId=session.id,
        runtime=session.runtime,
        runtimeId=_session_runtime_id(session),
        externalSessionId=session.externalSessionId,
        status="idle",
        selections=selections,
        updatedSeq=session.updatedSeq,
        createdAt=now,
        updatedAt=now,
    )


def _timeline_attachment_payload(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "fileId": value.get("fileId"),
        "name": value.get("name"),
        "mediaType": value.get("mediaType"),
        "size": value.get("size"),
        "sha256": value.get("sha256"),
    }


def _connector_attachment_reference_payload(attachment: PersistedInlineAttachment) -> dict[str, Any]:
    return {
        "fileId": attachment.file_id,
        "name": attachment.name,
        "mediaType": attachment.media_type,
        "size": attachment.size,
        "sha256": attachment.sha256,
    }


def _timeline_payload_from_persisted_inline_attachment(
    attachment: PersistedInlineAttachment,
) -> dict[str, Any]:
    return {
        "fileId": attachment.file_id,
        "name": attachment.name,
        "mediaType": attachment.media_type,
        "size": attachment.size,
        "sha256": attachment.sha256,
    }


def _decode_inline_attachment(attachment: InlineAttachmentRef) -> bytes:
    try:
        data = base64.b64decode(attachment.contentBase64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SessionRunInvalidConfigError(
            f"attachment {attachment.fileId} contentBase64 is invalid"
        ) from exc
    if attachment.size is not None and attachment.size != len(data):
        raise SessionRunInvalidConfigError(
            f"attachment {attachment.fileId} size does not match content"
        )
    if attachment.sha256 is not None:
        actual_sha256 = hashlib.sha256(data).hexdigest()
        if attachment.sha256 != actual_sha256:
            raise SessionRunInvalidConfigError(
                f"attachment {attachment.fileId} sha256 does not match content"
            )
    return data
