from __future__ import annotations

from typing import Any

from agent_server.core.api_namespace import api_v2_path
from agent_server.core.models import (
    MessageCreateRequest,
    RpcResponsePayload,
    SessionCreateRequest,
    SessionRuntimeState,
    SessionSelectionPatchRequest,
    SteerTurnRequest,
)
from agent_server.core.utc import utc_now
from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.services.notices import (
    cancel_session_blocking_interactions,
    upsert_execution_error_interaction,
)
from agent_server.services.repository_ports import SessionRunRepository
from agent_server.services.session_states import SessionStateService


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
    def __init__(self, store: SessionRunRepository, manager: ConnectorRpcManager) -> None:
        self._store = store
        self._manager = manager
        self._session_states = SessionStateService(store)

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
        if payload.externalSessionId is not None:
            session = await self._store.create_session(
                connector_id=payload.connectorId,
                user_id=user_id,
                runtime=payload.runtime,
                external_session_id=payload.externalSessionId,
                title=payload.title,
                cwd=payload.cwd,
            )
            await self._store.upsert_session_runtime_state(
                session_id=session.id,
                runtime=payload.runtime,
                external_session_id=payload.externalSessionId,
                selections=_payload_selections(payload),
            )
            return {"session": session, "connectorResult": connector_result}

        if not await self._manager.is_online(payload.connectorId):
            raise SessionRunConflictError("connector is offline")
        connector_params = {
            "runtime": payload.runtime,
            "title": payload.title,
            "cwd": payload.cwd,
        }
        selections = _payload_selections(payload)
        if selections:
            connector_params["selections"] = selections
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
        external_session_id = connector_result.get("externalSessionId") if isinstance(connector_result, dict) else None
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
        session = await self._store.upsert_connector_session(
            connector_id=payload.connectorId,
            session_id=session_id,
            runtime=payload.runtime,
            external_session_id=external_session_id,
            title=payload.title,
            cwd=payload.cwd,
            status="idle",
            last_synced_at=utc_now(),
            origin="platform",
        )
        await self._store.upsert_session_runtime_state(
            session_id=session.id,
            runtime=payload.runtime,
            external_session_id=external_session_id,
            selections=_payload_selections(payload),
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
        session = await self._session_states.reconcile(session_id)

        if not session.takeover:
            raise SessionRunConflictError("session is read-only until takeover is enabled")
        if not await self._manager.is_online(session.connectorId):
            raise SessionRunConflictError("connector is offline")
        if not (await self._session_states.inspect(session_id)).can_start_turn:
            raise SessionRunConflictError(f"session is {session.status}")
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
        if payload.attachments:
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
            external_session_id=session.externalSessionId,
            params=params,
        )
        await self._session_states.reconcile(session_id)
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
        params: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": session.runtime,
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
        state = await self._store.upsert_session_runtime_state(
            session_id=session_id,
            runtime=session.runtime,
            external_session_id=session.externalSessionId,
            selections=payload.selections,
        )
        return state, result if isinstance(result, dict) else None

    async def steer_session(
        self,
        session_id: str,
        payload: SteerTurnRequest,
        *,
        user_id: str,
    ) -> RpcResponsePayload:
        try:
            session = await self._store.get_session(session_id, user_id=user_id)
        except KeyError:
            raise SessionRunNotFoundError("session not found") from None
        session = await self._session_states.reconcile(session_id)
        if not session.takeover:
            raise SessionRunConflictError(
                "session is read-only until takeover is enabled"
            )
        if session.runtime != "codex":
            raise SessionRunConflictError("session runtime does not support steer")
        if not await self._manager.is_online(session.connectorId):
            raise SessionRunConflictError("connector is offline")

        active_run = await self._store.get_active_run(session_id)
        turn_id = active_run.get("turnId") if active_run else None
        if turn_id is None:
            turn_id = await self._store.get_open_turn_id(session_id)
        decision = await self._session_states.inspect(session_id)
        if turn_id is None or not decision.can_steer_turn:
            raise SessionRunConflictError("no active turn to steer")

        params: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": session.runtime,
            "content": payload.content,
            "turnId": turn_id,
        }
        external_session_id = (
            active_run.get("externalSessionId")
            if active_run
            else session.externalSessionId
        )
        if external_session_id:
            params["externalSessionId"] = external_session_id
        if session.cwd:
            params["cwd"] = session.cwd
        if payload.clientMessageId:
            params["clientMessageId"] = payload.clientMessageId
        if payload.attachments:
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
                "turn.steer",
                params,
            )
        except ConnectorOfflineError as exc:
            raise SessionRunConflictError(str(exc)) from exc
        except ConnectorRpcError as exc:
            raise SessionRunUpstreamError(exc.message or exc.code) from exc
        return RpcResponsePayload(ok=True, result=result)

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
        session = await self._session_states.reconcile(session_id)
        if require_takeover and not session.takeover:
            raise SessionRunConflictError("session is read-only until takeover is enabled")
        active_run = await self._store.get_active_run(session_id)
        turn_id = active_run.get("turnId") if active_run else None
        if turn_id is None:
            turn_id = await self._store.get_open_turn_id(session_id)
        decision = await self._session_states.inspect(session_id)
        if not decision.can_interrupt_turn:
            raise SessionRunConflictError("no active turn to interrupt")

        params: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": session.runtime,
        }
        if turn_id is not None:
            params["turnId"] = turn_id
        external_session_id = active_run.get("externalSessionId") if active_run else session.externalSessionId
        if external_session_id:
            params["externalSessionId"] = external_session_id
        previous_status = session.status
        await self._session_states.transition(session_id, "stopping")
        try:
            result = await self._manager.request(session.connectorId, "turn.interrupt", params)
        except ConnectorOfflineError as exc:
            await self._session_states.transition(session_id, previous_status)
            raise SessionRunConflictError(str(exc)) from exc
        except ConnectorRpcError as exc:
            await self._session_states.transition(session_id, previous_status)
            raise SessionRunUpstreamError(exc.message or exc.code) from exc
        await cancel_session_blocking_interactions(
            self._store,
            session_id=session_id,
            reason="interrupt_requested",
        )
        if _interrupt_target_not_found(result):
            await self._store.clear_active_run(session_id)
        await self._session_states.reconcile(
            session_id,
            settle_stopping=_interrupt_target_not_found(result),
        )
        return RpcResponsePayload(ok=True, result=result)


def _interrupt_target_not_found(result: object) -> bool:
    if not isinstance(result, dict):
        return False
    if result.get("interrupted") is not False:
        return False
    reason = result.get("reason")
    return reason in {"thread_not_found", "turn_not_found"}


def _payload_selections(payload: SessionCreateRequest) -> dict[str, str]:
    selections: dict[str, str] = {}
    if payload.modelSelectionId:
        selections["model"] = payload.modelSelectionId
    if payload.permissionSelectionId:
        selections["permission"] = payload.permissionSelectionId
    return selections


def _timeline_attachment_payload(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "fileId": value.get("fileId"),
        "name": value.get("name"),
        "mediaType": value.get("mediaType"),
        "size": value.get("size"),
        "sha256": value.get("sha256"),
    }
