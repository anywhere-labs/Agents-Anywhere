from __future__ import annotations

from typing import Any

from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcError, ConnectorRpcManager
from agent_server.core.api_namespace import api_v2_path
from agent_server.core.models import MessageCreateRequest, RpcResponsePayload, RuntimeName, SessionCreateRequest
from agent_server.infra.runtimes.serializers import serializer_for_runtime
from agent_server.infra.repositories.facade import Store
from agent_server.core.utc import utc_now
from agent_server.services.model_catalog import build_model_catalog, resolve_model_selection
from agent_server.services.notices import upsert_execution_error_interaction
from agent_server.services.permission_catalog import build_permission_catalog, resolve_permission_selection


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
        runtime_settings_patch = await self._runtime_settings_patch_with_model_selection(
            runtime=payload.runtime,
            user_id=user_id,
            patch=payload.runtimeSettings,
            model_selection_id=payload.modelSelectionId,
            permission_selection_id=payload.permissionSelectionId,
        )
        if payload.externalSessionId is not None:
            try:
                runtime_settings_override = await self._store.get_initial_runtime_settings_for_connector_agent(
                    payload.connectorId,
                    payload.runtime,
                    user_id=user_id,
                    patch=runtime_settings_patch,
                )
            except ValueError as exc:
                raise SessionRunInvalidConfigError(str(exc)) from exc
            session = await self._store.create_session(
                connector_id=payload.connectorId,
                user_id=user_id,
                runtime=payload.runtime,
                external_session_id=payload.externalSessionId,
                title=payload.title,
                cwd=payload.cwd,
                runtime_settings_override=runtime_settings_override,
            )
            return {"session": session, "connectorResult": connector_result}

        if not self._manager.is_online(payload.connectorId):
            raise SessionRunConflictError("connector is offline")
        try:
            runtime_settings_override = await self._store.get_initial_runtime_settings_for_connector_agent(
                payload.connectorId,
                payload.runtime,
                user_id=user_id,
                patch=runtime_settings_patch,
            )
            connector_settings = await self._store.serialize_initial_settings_for_connector_agent(
                payload.connectorId,
                payload.runtime,
                user_id=user_id,
                cwd=payload.cwd,
                patch=runtime_settings_patch,
            )
        except ValueError as exc:
            raise SessionRunInvalidConfigError(str(exc)) from exc

        connector_params = {
            "runtime": payload.runtime,
            "title": payload.title,
            "cwd": payload.cwd,
            **connector_settings,
        }
        if payload.runtime == "codex" and "sandboxPolicy" in connector_params:
            connector_params["sandbox"] = connector_params.pop("sandboxPolicy")
        if payload.approvalPolicy is not None:
            connector_params["approvalPolicy"] = payload.approvalPolicy
        if payload.sandbox is not None:
            connector_params["sandbox"] = payload.sandbox

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
        session = await self._store.upsert_connector_session(
            connector_id=payload.connectorId,
            session_id=session_id,
            runtime=payload.runtime,
            external_session_id=external_session_id,
            title=payload.title,
            cwd=payload.cwd,
            status="idle",
            last_synced_at=utc_now(),
            runtime_settings_override=runtime_settings_override,
            origin="platform",
        )
        if session.runtimeSettings != runtime_settings_override:
            session = session.model_copy(
                update={
                    "runtimeSettings": runtime_settings_override,
                    "runtimeSettingsOverride": runtime_settings_override,
                }
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
            effective_settings = await self._store.get_effective_runtime_settings(
                session_id,
                user_id=user_id,
            )
            if payload.permissionSelectionId is not None:
                effective_settings = {
                    **effective_settings,
                    "permissionMode": await self._resolve_permission_selection(
                        runtime=session.runtime,
                        permission_selection_id=payload.permissionSelectionId,
                    ),
                }
            runtime_params = serializer_for_runtime(session.runtime).serialize(
                settings=effective_settings,
                cwd=session.cwd,
            )
        except ValueError as exc:
            raise SessionRunInvalidConfigError(str(exc)) from exc
        selected_model: tuple[str, str | None] | None = None
        if payload.modelSelectionId is not None:
            selected_model = await self._resolve_model_selection(
                runtime=session.runtime,
                user_id=user_id,
                model_selection_id=payload.modelSelectionId,
            )

        params: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": session.runtime,
            "content": payload.content,
            **runtime_params,
        }
        if session.cwd:
            params["cwd"] = session.cwd
        if session.externalSessionId:
            params["externalSessionId"] = session.externalSessionId
        if selected_model is not None:
            model, effort = selected_model
            params["model"] = model
            if effort is None:
                params.pop("effort", None)
            else:
                params["effort"] = effort
        if payload.clientMessageId:
            params["clientMessageId"] = payload.clientMessageId
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

    async def _runtime_settings_patch_with_model_selection(
        self,
        *,
        runtime: RuntimeName,
        user_id: str,
        patch: dict[str, Any] | None,
        model_selection_id: str | None,
        permission_selection_id: str | None,
    ) -> dict[str, Any] | None:
        if patch is not None and ("model" in patch or "effort" in patch or "permissionMode" in patch):
            raise SessionRunInvalidConfigError(
                "runtimeSettings.model, runtimeSettings.effort, and runtimeSettings.permissionMode are not accepted; use selection IDs"
            )
        if model_selection_id is None and permission_selection_id is None:
            return patch
        result = dict(patch or {})
        if model_selection_id is not None:
            model, effort = await self._resolve_model_selection(
                runtime=runtime,
                user_id=user_id,
                model_selection_id=model_selection_id,
            )
            result["model"] = model
            result["effort"] = effort
        if permission_selection_id is not None:
            result["permissionMode"] = await self._resolve_permission_selection(
                runtime=runtime,
                permission_selection_id=permission_selection_id,
            )
        return result

    async def _resolve_model_selection(
        self,
        *,
        runtime: RuntimeName,
        user_id: str,
        model_selection_id: str,
    ) -> tuple[str, str | None]:
        defaults = await self._store.get_user_agent_defaults(user_id)
        runtime_defaults = defaults.get(runtime)
        models = (
            runtime_defaults["models"]
            if runtime_defaults and runtime_defaults.get("models")
            else await self._store.list_agent_models(runtime)
        )
        catalog = build_model_catalog(runtime=runtime, models=models)
        try:
            return resolve_model_selection(catalog, model_selection_id)
        except KeyError:
            raise SessionRunInvalidConfigError("invalid modelSelectionId") from None

    async def _resolve_permission_selection(
        self,
        *,
        runtime: RuntimeName,
        permission_selection_id: str,
    ) -> str:
        permissions = await self._store.list_agent_modes(runtime)
        catalog = build_permission_catalog(runtime=runtime, permissions=permissions)
        try:
            return resolve_permission_selection(catalog, permission_selection_id)
        except KeyError:
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
        if _interrupt_target_not_found(result):
            await self._store.clear_active_run(session_id)
            await self._store.refresh_session_status_from_timeline(session_id)
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
