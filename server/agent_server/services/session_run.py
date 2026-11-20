"""What the Server still does for session commands (D1): directory rows, admission and staged attachments.

The device runs every session command through ``Client/call``; this service creates directory rows
(``POST /sessions``), admits commands like the model channel requires (``admitted``) and, for create-and-start,
keeps the row, the session id and the staged attachments while the device creates the session.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager, nullcontext
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from agent_server.core.models import (
    InlineAttachmentRef,
    SessionCreateAndStartRequest,
    SessionCreateRequest,
    SessionView,
)
from agent_server.infra.repositories.projects import _clean_workspace_path
from agent_server.services.client_forward import (
    ClientAnswer,
    ClientForwarder,
    ClientForwardError,
    client_input_digest,
)
from agent_server.services.device_runtimes import (
    DeviceRuntimeError,
    DeviceRuntimeService,
)
from agent_server.services.repository_ports import SessionRunRepository
from agent_server.services.usage_events import (
    NullUsageRecorder,
    UsageRecorder,
    message_sent_event,
    session_created_event,
)

#: Route whose receipts a forwarded create-and-start leaves (``core.client_routes``).
FORWARDED_CREATION_ROUTE = "session.createAndStart"
#: The reserved command receipt and whether this request owns the allocation.
ForwardedCreation = Callable[[SessionView, list[dict[str, Any]], tuple[dict[str, Any], bool]], Awaitable[ClientAnswer]]


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


class SessionRunTimeoutError(SessionRunError):
    status_code = 504


class SessionRunInvalidConfigError(SessionRunError):
    status_code = 422


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
        device_runtimes: DeviceRuntimeService,
        *,
        usage_recorder: UsageRecorder | NullUsageRecorder | None = None,
        prepare_model_channel: Callable[..., Awaitable[str]] | None = None,
        admit_runtime: Callable[..., AbstractAsyncContextManager[None]] | None = None,
    ) -> None:
        self._store = store
        self._device_runtimes = device_runtimes
        self._usage = usage_recorder or NullUsageRecorder()
        self._prepare_model_channel = prepare_model_channel
        self._admit_runtime = admit_runtime

    def _admitted(self, connector_id: str, runtime_id: str, *, user_id: str) -> AbstractAsyncContextManager[None]:
        """Keep a model channel switch from restarting the runtime under this request."""
        if self._admit_runtime is None:
            return nullcontext()
        return self._admit_runtime(connector_id, runtime_id, user_id=user_id)

    def admitted(self, session: SessionView, *, user_id: str) -> AbstractAsyncContextManager[None]:
        """Admission of a forwarded command on ``session`` (``Client/call``): the same as the Server's own sends."""
        return self._admitted(session.connectorId, _session_runtime_id(session), user_id=user_id)

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
        forwarder: ClientForwarder,
        deliver: ForwardedCreation,
        actor: str = "user",
    ) -> dict[str, Any]:
        """``deliver`` forwards the creation with ``Client/call``; the result is ``{session, attachments, answer}``
        with the device's ``ClientAnswer``."""

        from agent_server.core.goal.models import GoalCreationIntent

        if (
            re.match(r"^/goal(?:\s|$)", payload.content.lstrip())
            and payload.goalIntent is None
        ):
            payload.content = payload.content.lstrip()[5:].strip()
            payload.goalIntent = GoalCreationIntent(
                operationId=payload.clientMessageId or str(uuid4())
            )
        if payload.goalIntent is not None:
            payload.content = payload.content.strip()
            if not payload.content:
                raise SessionRunInvalidConfigError("goal_objective_required")
        from agent_server.core.planning.commands import parse_plan_command
        from agent_server.core.planning.models import PlanningCreationIntent

        if payload.planningIntent is None and payload.goalIntent is None:
            intent = parse_plan_command(payload.content)
            if intent:
                if intent["command"] != "submit_task":
                    raise SessionRunInvalidConfigError("新会话的裸 /plan 只设置客户端意图，请填写规划任务后再发送。")
                payload.content = intent["content"]
                payload.planningIntent = PlanningCreationIntent(mode="plan", operationId=payload.clientMessageId or str(uuid4()))
        try:
            connector = await self._store.get_connector(payload.connectorId)
            if connector.userId != user_id:
                raise KeyError(payload.connectorId)
        except KeyError:
            raise SessionRunNotFoundError("connector not found") from None
        selected_project = payload.projectId
        if selected_project is None and actor != "user" and payload.cwd:
            try:
                _, requested_key = _clean_workspace_path(payload.cwd, None)
            except ValueError as exc:
                raise SessionRunInvalidConfigError(
                    {"code": "project_workspace_mismatch", "message": "Invalid project workspace."}
                ) from exc
            selected_project = next(
                (
                    project.id
                    for project in await self._store.list_projects(user_id=user_id)
                    if project.connectorId == payload.connectorId
                    and _clean_workspace_path(project.workspacePath, None)[1] == requested_key
                ),
                None,
            )
        project_id, project_cwd = await self._validate_project_binding(
            selected_project,
            connector_id=payload.connectorId,
            cwd=payload.cwd,
            user_id=user_id,
        )
        payload.projectId = project_id
        payload.cwd = project_cwd
        runtime_id = _request_runtime_id(payload)
        if self._prepare_model_channel is not None:
            runtime_id = await self._prepare_model_channel(payload.connectorId, runtime_id, user_id=user_id)
            payload.runtimeId = runtime_id
        async with self._admitted(payload.connectorId, runtime_id, user_id=user_id):
            return await self._create_and_start_forwarded(
                payload, user_id=user_id, runtime_id=runtime_id, project_id=project_id, forwarder=forwarder, deliver=deliver, actor=actor
            )

    async def _create_and_start_forwarded(
        self,
        payload: SessionCreateAndStartRequest,
        *,
        user_id: str,
        runtime_id: str,
        project_id: str | None,
        forwarder: ClientForwarder,
        deliver: ForwardedCreation,
        actor: str,
    ) -> dict[str, Any]:
        """create-and-start through ``Client/call``: the Server keeps the directory row, the staged attachments and
        the session id (``ClientServerFacts.sessionId``); the device creates the session and runs its first turn.

        A retry with the same ``clientMessageId`` reuses the first attempt's row; ``ClientForwarder`` replays the
        receipt (the device's inbox answers again, nothing runs twice). The row is dropped when the device never
        got the creation or refused it.
        """

        command_id = payload.clientMessageId or f"create_{uuid4().hex}"
        payload.clientMessageId = command_id
        body = payload.model_dump(mode="json", exclude_none=True, exclude={"attachments"})
        if payload.attachments:
            # The device receives server-generated file ids. Bind the receipt to the client's content instead.
            body["attachments"] = [
                {
                    "fileId": item.fileId,
                    "name": item.name,
                    "mediaType": item.mediaType,
                    "sha256": hashlib.sha256(_decode_inline_attachment(item)).hexdigest(),
                }
                for item in payload.attachments
            ]
        reservation = await forwarder.reserve_creation(
            user_id=user_id, device_id=payload.connectorId, command_id=command_id,
            digest=client_input_digest(FORWARDED_CREATION_ROUTE, body), actor=actor,
        )
        receipt, created = reservation
        session_id = receipt["sessionId"]
        attachments: list[dict[str, Any]] = []
        if created:
            try:
                session = await self._store.create_session(
                    session_id=session_id,
                    connector_id=payload.connectorId,
                    project_id=project_id,
                    user_id=user_id,
                    runtime=payload.runtime,
                    runtime_id=runtime_id,
                    external_session_id=None,
                    title=payload.title,
                    cwd=payload.cwd,
                    selections=_selections_from_mapping(payload.selections),
                    takeover=True,
                )
                attachments = [
                    {
                        "fileId": item.file_id,
                        "name": item.name,
                        "mediaType": item.media_type,
                        "size": item.size,
                        "sha256": item.sha256,
                    }
                    for item in await self._persist_inline_attachments(
                        session_id=session.id, user_id=user_id, attachments=payload.attachments
                    )
                ]
            except BaseException:
                await self._discard_device_session(session_id)
                await self._store.delete_device_command(user_id, command_id, only_state="pending")
                raise
        else:
            try:
                session = await self._store.get_session(session_id, user_id=user_id)
            except KeyError as exc:
                raise SessionRunNotFoundError("session no longer exists") from exc
        try:
            answer = await deliver(session, attachments, reservation)
        except ClientForwardError as exc:
            if created and exc.code in ("connector_offline", "device_busy", "request_too_large"):
                await self._discard_device_session(session.id)
                if exc.code == "request_too_large":
                    await self._store.delete_device_command(user_id, command_id, only_state="pending")
            raise
        refused = not answer.ok and (answer.command is None or answer.command.outcome == "rejected")
        if created and refused:
            await self._discard_device_session(session.id)
        if answer.ok and created:
            await self._usage.record(session_created_event(session, user_id=user_id))
            await self._usage.record(message_sent_event(session, user_id=user_id, client_message_id=command_id))
        return {"session": session, "attachments": attachments, "answer": answer}

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

    @staticmethod
    def _raise_device_runtime_error(exc: DeviceRuntimeError) -> None:
        if exc.status_code == 404:
            raise SessionRunNotFoundError(exc.message) from exc
        if exc.status_code == 422:
            raise SessionRunInvalidConfigError(exc.detail) from exc
        if exc.status_code == 502:
            raise SessionRunUpstreamError(exc.detail) from exc
        raise SessionRunConflictError(exc.detail) from exc

    async def _discard_device_session(self, session_id: str) -> None:
        """The device never took the creation: drop our row and staged files."""

        if await self._store.discard_unstarted_session(session_id):
            await self._store.delete_runtime_session_files([session_id])

    async def _persist_inline_attachments(
        self,
        *,
        session_id: str,
        user_id: str,
        attachments: list[InlineAttachmentRef],
    ) -> list[PersistedInlineAttachment]:
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


def _selections_from_mapping(value: dict[str, str | None]) -> dict[str, str]:
    return {key: item for key, item in value.items() if isinstance(item, str) and item}


def _request_runtime_id(
    payload: SessionCreateRequest | SessionCreateAndStartRequest,
) -> str:
    return payload.runtimeId or payload.runtime


def _session_runtime_id(session: SessionView) -> str:
    return session.runtimeId or session.runtime


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
