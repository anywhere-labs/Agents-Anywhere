from __future__ import annotations

from typing import Any

from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcError, ConnectorRpcManager
from agent_server.core.api_namespace import api_v2_path
from agent_server.core.models import MessageCreateRequest, RpcResponsePayload, RuntimeName, SessionCreateRequest
from agent_server.infra.repositories.facade import Store
from agent_server.core.utc import utc_now
from agent_server.core.protocol import ProtocolModelCatalog, ProtocolPermissionCatalog
from agent_server.services.notices import cancel_session_blocking_interactions, upsert_execution_error_interaction


class SessionRunError(RuntimeError):
    status_code = 500

    def __init__(self, detail: str) -> None:
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


class SessionRunService:
    def __init__(self, store: Store, manager: ConnectorRpcManager) -> None:
        self._store = store
        self._manager = manager

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

        connector_result = None
        await self._validate_selections(
            connector_id=payload.connectorId,
            runtime=payload.runtime,
            model_selection_id=payload.modelSelectionId,
            permission_selection_id=payload.permissionSelectionId,
        )
        if payload.externalSessionId is not None:
            session = await self._store.create_session(
                connector_id=payload.connectorId,
                user_id=user_id,
                runtime=payload.runtime,
                external_session_id=payload.externalSessionId,
                title=payload.title,
                cwd=payload.cwd,
                model_selection_id=payload.modelSelectionId,
                permission_selection_id=payload.permissionSelectionId,
            )
            return {"session": session, "connectorResult": connector_result}

        if not self._manager.is_online(payload.connectorId):
            raise SessionRunConflictError("connector is offline")
        connector_params = {
            "runtime": payload.runtime,
            "title": payload.title,
            "cwd": payload.cwd,
        }
        if payload.modelSelectionId is not None:
            connector_params["modelSelectionId"] = payload.modelSelectionId
        if payload.permissionSelectionId is not None:
            connector_params["permissionSelectionId"] = payload.permissionSelectionId
        try:
            connector_result = await self._manager.request(
                payload.connectorId,
                "session.create",
                connector_params,
                timeout=60,
            )
        except ConnectorOfflineError as exc:
            raise SessionRunConflictError(str(exc)) from exc
        except ConnectorRpcError as exc:
            raise SessionRunUpstreamError(exc.message or exc.code) from exc

        session_id = connector_result.get("sessionId") if isinstance(connector_result, dict) else None
        external_session_id = (
            connector_result.get("externalSessionId") if isinstance(connector_result, dict) else None
        )
        if not isinstance(session_id, str):
            raise SessionRunUpstreamError("connector did not return a session id")
        if payload.runtime != "claude" and not isinstance(external_session_id, str):
            raise SessionRunUpstreamError("connector did not return an external session id")
        if isinstance(external_session_id, str):
            try:
                session_id = await self._store.resolve_connector_session_id(
                    connector_id=payload.connectorId,
                    session_id=session_id,
                    external_session_id=external_session_id,
                )
            except KeyError:
                pass
        connector_model_selection_id = (
            connector_result.get("modelSelectionId") if isinstance(connector_result, dict) else None
        )
        connector_permission_selection_id = (
            connector_result.get("permissionSelectionId") if isinstance(connector_result, dict) else None
        )
        session = await self._store.upsert_connector_session(
            connector_id=payload.connectorId,
            session_id=session_id,
            runtime=payload.runtime,
            external_session_id=external_session_id,
            title=payload.title,
            cwd=payload.cwd,
            status="idle",
            last_synced_at=utc_now(),
            model_selection_id=connector_model_selection_id
            if isinstance(connector_model_selection_id, str)
            else payload.modelSelectionId,
            permission_selection_id=connector_permission_selection_id
            if isinstance(connector_permission_selection_id, str)
            else payload.permissionSelectionId,
            origin="platform",
        )
        return {"session": session, "connectorResult": connector_result}

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

        if not session.takeover:
            raise SessionRunConflictError("session is read-only until takeover is enabled")
        if not self._manager.is_online(session.connectorId):
            raise SessionRunConflictError("connector is offline")
        if session.status != "idle":
            raise SessionRunConflictError(f"session is {session.status}")
        try:
            if payload.permissionSelectionId is not None:
                await self._validate_permission_selection(
                    connector_id=session.connectorId,
                    runtime=session.runtime,
                    permission_selection_id=payload.permissionSelectionId,
                )
            if payload.modelSelectionId is not None:
                await self._validate_model_selection(
                    connector_id=session.connectorId,
                    runtime=session.runtime,
                    model_selection_id=payload.modelSelectionId,
                )
            if payload.modelSelectionId is not None or payload.permissionSelectionId is not None:
                await self._store.update_session_snapshot(
                    session_id=session_id,
                    model_selection_id=payload.modelSelectionId,
                    permission_selection_id=payload.permissionSelectionId,
                )
        except ValueError as exc:
            raise SessionRunInvalidConfigError(str(exc)) from exc

        params: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": session.runtime,
            "content": payload.content,
        }
        if session.cwd:
            params["cwd"] = session.cwd
        if session.externalSessionId:
            params["externalSessionId"] = session.externalSessionId
        if payload.clientMessageId:
            params["clientMessageId"] = payload.clientMessageId
        if payload.modelSelectionId is not None:
            params["modelSelectionId"] = payload.modelSelectionId
        if payload.permissionSelectionId is not None:
            params["permissionSelectionId"] = payload.permissionSelectionId
        if payload.attachments:
            attachment_payloads = await self._attachment_payloads(
                session_id=session_id,
                user_id=user_id,
                file_ids=[a.fileId for a in payload.attachments],
            )
            params["attachments"] = attachment_payloads
            params["timelineAttachments"] = [
                _timeline_attachment_payload(item) for item in attachment_payloads
            ]

        await self._store.set_session_status(session_id, "pending")
        await self._store.start_active_run(
            session_id=session_id,
            runtime=session.runtime,
            external_session_id=session.externalSessionId,
            params=params,
        )
        try:
            result = await self._manager.request(
                session.connectorId,
                "turn.start",
                params,
            )
        except ConnectorOfflineError as exc:
            await self._store.clear_active_run(session_id)
            await upsert_execution_error_interaction(
                self._store,
                session_id=session_id,
                title="Dispatch failed",
                message=str(exc),
                error={"code": "connector_offline", "message": str(exc)},
                reason="dispatch_failed",
            )
            raise SessionRunConflictError(str(exc)) from exc
        except ConnectorRpcError as exc:
            await self._store.clear_active_run(session_id)
            await upsert_execution_error_interaction(
                self._store,
                session_id=session_id,
                title="Dispatch failed",
                message=exc.message or exc.code,
                error={"code": exc.code, "message": exc.message or exc.code},
                reason="dispatch_failed",
            )
            raise SessionRunUpstreamError(exc.message or exc.code) from exc
        return RpcResponsePayload(ok=True, result=result)

    async def _validate_selections(
        self,
        *,
        connector_id: str,
        runtime: RuntimeName,
        model_selection_id: str | None,
        permission_selection_id: str | None,
    ) -> None:
        if model_selection_id is not None:
            await self._validate_model_selection(
                connector_id=connector_id,
                runtime=runtime,
                model_selection_id=model_selection_id,
            )
        if permission_selection_id is not None:
            await self._validate_permission_selection(
                connector_id=connector_id,
                runtime=runtime,
                permission_selection_id=permission_selection_id,
            )

    async def _validate_model_selection(
        self,
        *,
        connector_id: str,
        runtime: RuntimeName,
        model_selection_id: str,
    ) -> tuple[str, str | None]:
        raw = await self._store.get_protocol_catalog(
            connector_id,
            runtime=runtime,
            catalog_type="model",
        )
        if raw is None:
            raise SessionRunInvalidConfigError("model catalog is unavailable")
        catalog = ProtocolModelCatalog.model_validate(raw)
        if not any(
            model.selectionId == model_selection_id
            or any(reasoning.selectionId == model_selection_id for reasoning in model.reasoningItems)
            for model in catalog.models
        ):
            raise SessionRunInvalidConfigError("invalid modelSelectionId") from None

    async def _validate_permission_selection(
        self,
        *,
        connector_id: str,
        runtime: RuntimeName,
        permission_selection_id: str,
    ) -> dict[str, object]:
        raw = await self._store.get_protocol_catalog(
            connector_id,
            runtime=runtime,
            catalog_type="permission",
        )
        if raw is None:
            raise SessionRunInvalidConfigError("permission catalog is unavailable")
        catalog = ProtocolPermissionCatalog.model_validate(raw)
        if not any(permission.selectionId == permission_selection_id for permission in catalog.permissions):
            raise SessionRunInvalidConfigError("invalid permissionSelectionId") from None

    async def _attachment_payloads(
        self,
        *,
        session_id: str,
        user_id: str,
        file_ids: list[str],
    ) -> list[dict[str, Any]]:
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
        active_run = await self._store.get_active_run(session_id)
        turn_id = active_run.get("turnId") if active_run else None
        if turn_id is None:
            turn_id = await self._store.get_open_turn_id(session_id)
        if turn_id is None and session.status not in {"pending", "running", "blocked"}:
            raise SessionRunConflictError("no active turn to interrupt")

        params: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": session.runtime,
        }
        if turn_id is not None:
            params["turnId"] = turn_id
        external_session_id = (
            active_run.get("externalSessionId") if active_run else session.externalSessionId
        )
        if external_session_id:
            params["externalSessionId"] = external_session_id
        previous_status = session.status
        await self._store.set_session_status(session_id, "stopping")
        try:
            result = await self._manager.request(session.connectorId, "turn.interrupt", params)
        except ConnectorOfflineError as exc:
            await self._store.set_session_status(session_id, previous_status)
            raise SessionRunConflictError(str(exc)) from exc
        except ConnectorRpcError as exc:
            await self._store.set_session_status(session_id, previous_status)
            raise SessionRunUpstreamError(exc.message or exc.code) from exc
        await cancel_session_blocking_interactions(
            self._store,
            session_id=session_id,
            reason="interrupt_requested",
        )
        for approval in await self._store.list_pending_approvals(session_id):
            await self._store.resolve_approval(approval.id, "cancelled")
        if _interrupt_target_not_found(result):
            await self._store.clear_active_run(session_id)
            await self._store.refresh_session_status_from_timeline(session_id)
        else:
            await self._store.set_session_status(session_id, "stopping")
        return RpcResponsePayload(ok=True, result=result)


def _interrupt_target_not_found(result: object) -> bool:
    if not isinstance(result, dict):
        return False
    if result.get("interrupted") is not False:
        return False
    reason = result.get("reason")
    return reason in {"thread_not_found", "turn_not_found"}


def _timeline_attachment_payload(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "fileId": value.get("fileId"),
        "name": value.get("name"),
        "mediaType": value.get("mediaType"),
        "size": value.get("size"),
        "sha256": value.get("sha256"),
    }
