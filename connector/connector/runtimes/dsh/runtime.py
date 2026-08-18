from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass, field, replace
from typing import Any

from connector.runtime_protocol import (
    AgentRuntime,
    PreparedSessionTimelineSync,
    RuntimeAttachment,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeConflictError,
    RuntimeIdentity,
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    RuntimeUnavailableError,
    RuntimeUnsupportedError,
    RuntimeUpstreamError,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.dsh import discovery
from connector.runtimes.dsh.bridge import BridgeClient, BridgeRpcError
from connector.runtimes.dsh.bridge import models as bridge_models
from connector.runtimes.session_identity import stable_runtime_session_id

DSH_SESSION_INVENTORY_LIMIT = 10_000


@dataclass(slots=True)
class DshRuntime(AgentRuntime):
    config: RuntimeConfig
    host: RuntimeHostClient
    client_version: str = "0.1.7.2"
    _client: BridgeClient | None = field(default=None, init=False)
    _identity: RuntimeIdentity = field(
        default_factory=lambda: RuntimeIdentity(
            runtime="dsh",
            runtime_version="unknown",
            display_name="DeepSeek Harness",
            protocol_version="1.0",
        ),
        init=False,
    )
    _stopping: bool = field(default=False, init=False)
    _restart_attempts: int = field(default=0, init=False)
    _restart_task: asyncio.Task[None] | None = field(default=None, init=False)
    _connect_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False)
    _notification_locks: dict[str, asyncio.Lock] = field(
        default_factory=dict, init=False
    )
    _known_sessions: dict[str, str | None] = field(default_factory=dict, init=False)
    _concurrent_writer_sessions: set[str] = field(default_factory=set, init=False)
    _client_message_ids: dict[tuple[str, str], str] = field(
        default_factory=dict,
        init=False,
    )

    @property
    def identity(self) -> RuntimeIdentity:
        return self._identity

    async def start(self) -> None:
        self._stopping = False
        await self._ensure_client()

    async def stop(self) -> None:
        self._stopping = True
        if self._restart_task is not None:
            self._restart_task.cancel()
            await asyncio.gather(self._restart_task, return_exceptions=True)
            self._restart_task = None
        client = self._client
        self._client = None
        if client is not None:
            await client.close()

    async def get_config(self) -> RuntimeConfig:
        result = await self._request("runtime.getConfig")
        metadata = dict(self.config.metadata)
        if isinstance(result, Mapping):
            metadata.update(_safe_metadata(result.get("metadata")))
        return replace(self.config, metadata=metadata)

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        return bridge_models.capability_set(
            await self._request("runtime.getCapabilities"),
            connector_id=self.host.connector_id,
        )

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        return bridge_models.model_catalog(
            await self._request("catalog.listModels", _query_params(query, limit))
        )

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        return bridge_models.permission_catalog(
            await self._request("catalog.listPermissions", _query_params(query, limit))
        )

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        sessions, _next_cursor = await self._list_session_page(
            limit=limit,
            cursor=cursor,
            force=force,
        )
        return sessions

    async def list_complete_session_inventory(
        self,
        page_size: int = 100,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        sessions: list[SessionMeta] = []
        session_ids: set[str] = set()
        external_session_ids: set[str] = set()
        seen_cursors: set[str] = set()
        cursor: str | None = None
        while True:
            page, next_cursor = await self._list_session_page(
                limit=page_size,
                cursor=cursor,
                force=force,
            )
            for session in page:
                external_session_id = session.external_session_id
                if session.session_id in session_ids or (
                    external_session_id is not None
                    and external_session_id in external_session_ids
                ):
                    raise RuntimeUpstreamError(
                        "DSH session.list returned a duplicate Session"
                    )
                session_ids.add(session.session_id)
                if external_session_id is not None:
                    external_session_ids.add(external_session_id)
                sessions.append(session)
                if len(sessions) > DSH_SESSION_INVENTORY_LIMIT:
                    raise RuntimeUpstreamError(
                        f"DSH session inventory exceeds {DSH_SESSION_INVENTORY_LIMIT} entries"
                    )
            if next_cursor is None:
                return tuple(sessions)
            if not page:
                raise RuntimeUpstreamError(
                    "DSH session.list returned an empty page with nextCursor"
                )
            if next_cursor in seen_cursors:
                raise RuntimeUpstreamError(
                    "DSH session.list returned a repeated nextCursor"
                )
            seen_cursors.add(next_cursor)
            cursor = next_cursor

    async def _list_session_page(
        self,
        *,
        limit: int,
        cursor: str | None,
        force: bool,
    ) -> tuple[tuple[SessionMeta, ...], str | None]:
        params: dict[str, Any] = {"limit": limit, "force": force}
        if cursor is not None:
            params["cursor"] = cursor
        result = await self._request("session.list", params)
        raw_sessions = result.get("sessions") if isinstance(result, Mapping) else result
        next_cursor = result.get("nextCursor") if isinstance(result, Mapping) else None
        if not isinstance(raw_sessions, list):
            raise RuntimeUpstreamError("DSH session.list result is invalid")
        if next_cursor is not None and (
            not isinstance(next_cursor, str) or not next_cursor
        ):
            raise RuntimeUpstreamError("DSH session.list nextCursor is invalid")
        sessions: list[SessionMeta] = []
        for raw in raw_sessions:
            if not isinstance(raw, Mapping):
                raise RuntimeUpstreamError("DSH session.list entry is invalid")
            external_id = raw.get("externalSessionId")
            if not isinstance(external_id, str) or not external_id:
                raise RuntimeUpstreamError(
                    "DSH session.list entry has no externalSessionId"
                )
            platform_id = raw.get("sessionId")
            if not isinstance(platform_id, str) or not platform_id:
                platform_id = stable_runtime_session_id(
                    self.host.connector_id,
                    "dsh",
                    external_id,
                )
            data = dict(raw)
            data["sessionId"] = platform_id
            metadata = _safe_metadata(data.get("metadata"))
            for key in (
                "hidden",
                "localArchived",
                "local_archived",
                "localDeleted",
                "local_deleted",
                "resumeSupported",
                "resumable",
                "localState",
                "local_state",
            ):
                if key in data:
                    metadata[key] = data[key]
            revision = data.get("revision")
            if isinstance(revision, str) and revision:
                metadata["revision"] = revision
                sync_key = _history_cursor_key(external_id)
                previous = await self.host.sync_state_read(sync_key)
                previous_revision = (
                    previous.get("revision") if isinstance(previous, Mapping) else None
                )
                changed = (
                    force
                    or platform_id not in self._known_sessions
                    or previous_revision != revision
                )
                metadata["sync"] = {
                    "key": sync_key,
                    "revision": revision,
                    "previous_revision": previous_revision,
                    "changed": changed,
                    "requires_timeline_sync": changed,
                    "history_cursor_missing": previous is None,
                }
            data["metadata"] = metadata
            session = bridge_models.session_meta(data)
            self._known_sessions[session.session_id] = session.external_session_id
            sessions.append(session)
        return tuple(sessions), next_cursor

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        params = _session_params(session_id, external_session_id)
        if limit is not None:
            params["limit"] = limit
        result = await self._request("session.getSnapshot", params)
        if not isinstance(result, Mapping):
            raise RuntimeUpstreamError("DSH snapshot result is invalid")
        raw_items = result.get("items")
        if not isinstance(raw_items, list):
            raise RuntimeUpstreamError("DSH snapshot items are invalid")
        items = tuple(
            [
                await self._with_client_message_id(
                    bridge_models.timeline_item(item, default_session_id=session_id)
                )
                for item in raw_items
            ]
        )
        resolved_external_id = (
            _optional_string(result.get("externalSessionId")) or external_session_id
        )
        self._known_sessions[session_id] = resolved_external_id
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=resolved_external_id,
            runtime="dsh",
            items=items,
            complete=result.get("complete") is True,
            metadata=_snapshot_metadata(result),
        )

    async def prepare_session_timeline_sync(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> PreparedSessionTimelineSync | None:
        snapshot = await self.get_session_snapshot(session_id, external_session_id)
        if snapshot.external_session_id is None:
            return PreparedSessionTimelineSync(snapshot=snapshot)
        revision = snapshot.metadata.get("revision")
        if not isinstance(revision, str) or not revision:
            return PreparedSessionTimelineSync(snapshot=snapshot)
        key = _history_cursor_key(snapshot.external_session_id)

        async def commit() -> None:
            await self.host.sync_state_write(
                key,
                {
                    "revision": revision,
                    "externalSessionIdHash": _sha256(snapshot.external_session_id),
                },
            )

        return PreparedSessionTimelineSync(snapshot=snapshot, commit=commit)

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        result = await self._request(
            "session.getState",
            _session_params(session_id, external_session_id),
        )
        if result is None:
            return None
        state = bridge_models.session_state(result)
        if not _is_concurrent_writer_state(state):
            self._concurrent_writer_sessions.discard(session_id)
        return state

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        result = await self._request(
            "session.getNotices",
            _session_params(session_id, external_session_id),
        )
        raw_notices = result.get("notices") if isinstance(result, Mapping) else result
        if not isinstance(raw_notices, list):
            raise RuntimeUpstreamError("DSH notices result is invalid")
        return tuple(bridge_models.notice(item) for item in raw_notices)

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        capabilities = bridge_models.capability_set(
            await self._request(
                "session.getCapabilities",
                _session_params(session_id, external_session_id),
            ),
            connector_id=self.host.connector_id,
        )
        return self._disable_writes_for_conflict(capabilities, session_id)

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        _reject_attachments(attachments)
        if client_message_id is not None:
            await self._remember_client_message_id(session_id, client_message_id)
        params: dict[str, Any] = {
            "sessionId": session_id,
            "content": content,
            "selections": dict(selections or {}),
            "attachments": [],
        }
        _set_optional(params, "title", title)
        _set_optional(params, "cwd", cwd)
        _set_optional(params, "clientMessageId", client_message_id)
        operation = _operation_result(
            await self._request("session.createAndStart", params)
        )
        external_id = _optional_string(operation.result.get("externalSessionId"))
        if operation.ok and external_id is None:
            raise RuntimeUpstreamError("DSH create result has no externalSessionId")
        self._known_sessions[session_id] = external_id
        if external_id is not None:
            await self.host.sync_state_write(
                _binding_key(external_id),
                {
                    "sessionId": session_id,
                    "externalSessionIdHash": _sha256(external_id),
                },
            )
        return operation

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        self._assert_session_writable(session_id)
        _reject_attachments(attachments)
        if client_message_id is not None:
            await self._remember_client_message_id(session_id, client_message_id)
        params = _session_params(session_id, external_session_id, require_external=True)
        params.update(
            {
                "content": content,
                "selections": dict(selections or {}),
                "attachments": [],
            }
        )
        _set_optional(params, "clientMessageId", client_message_id)
        _set_optional(params, "cwd", cwd)
        return _operation_result(await self._request("session.startTurn", params))

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        self._assert_session_writable(session_id)
        _reject_attachments(attachments)
        if client_message_id is not None:
            await self._remember_client_message_id(session_id, client_message_id)
        params = _session_params(session_id, external_session_id, require_external=True)
        params.update({"content": content, "attachments": []})
        _set_optional(params, "clientMessageId", client_message_id)
        return _operation_result(await self._request("session.steer", params))

    async def interrupt_session(
        self,
        session_id: str,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        params = {"sessionId": session_id}
        _set_optional(params, "reason", reason)
        return _operation_result(await self._request("session.interrupt", params))

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        self._assert_session_writable(session_id)
        params = _session_params(session_id, external_session_id, require_external=True)
        params["selections"] = dict(selections)
        return _operation_result(
            await self._request("session.updateSelections", params)
        )

    async def list_commands(
        self,
        session_id: str,
        external_session_id: str | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RuntimeCommand, ...]:
        params = _session_params(session_id, external_session_id, require_external=True)
        params.update(_query_params(query, limit))
        return bridge_models.commands(
            await self._request("session.listCommands", params)
        )

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        self._assert_session_writable(session_id)
        params = _session_params(session_id, external_session_id, require_external=True)
        params.update({"command": command, "args": list(args)})
        _set_optional(params, "raw", raw)
        return bridge_models.command_result(
            await self._request("session.executeCommand", params),
            command,
        )

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        params: dict[str, Any] = {
            "sessionId": session_id,
            "noticeId": notice_id,
            "actionId": action_id,
        }
        if input_data is not None:
            params["inputData"] = dict(input_data)
        return _operation_result(
            await self._request("session.respondInteraction", params)
        )

    async def _start_client(self) -> None:
        values = dict(self.config.values)
        try:
            endpoint = discovery.load_endpoint(values)
        except (OSError, ValueError) as exc:
            raise RuntimeUnavailableError(
                "DSH Desktop bridge endpoint is unavailable; start DSH Desktop"
            ) from exc
        client = BridgeClient(
            endpoint=endpoint,
            connector_id=self.host.connector_id,
            client_version=self.client_version,
            startup_timeout=int(values["startupTimeoutMs"]) / 1000,
            request_timeout=int(values["requestTimeoutMs"]) / 1000,
            notification_handler=self._handle_notification,
            exit_handler=self._handle_exit,
        )
        self._client = client
        try:
            result = await client.start()
        except BaseException:
            if self._client is client:
                self._client = None
            await client.close()
            raise
        identity = result["identity"]
        metadata = dict(self.config.metadata)
        bridge_version = identity.get("bridgeVersion")
        if isinstance(bridge_version, str) and bridge_version:
            metadata["bridgeVersion"] = bridge_version
        self.config = replace(self.config, metadata=metadata)
        discovered_version = metadata.get("dshVersion")
        self._identity = RuntimeIdentity(
            runtime="dsh",
            runtime_version=(
                discovered_version
                if isinstance(discovered_version, str) and discovered_version
                else str(identity.get("runtimeVersion") or "unknown")
            ),
            display_name="DeepSeek Harness",
            protocol_version=str(identity.get("protocolVersion") or "1.0"),
        )
        try:
            await self._publish_bootstrap()
        except BaseException:
            if self._client is client:
                self._client = None
            await client.close()
            raise
        self._restart_attempts = 0

    async def _ensure_client(self) -> None:
        if self._client is not None:
            return
        async with self._connect_lock:
            if self._client is not None:
                return
            if self._stopping:
                raise RuntimeUnavailableError("DSH bridge is stopping")
            await self._start_client()

    async def _publish_bootstrap(self) -> None:
        await self.host.runtime_capabilities_update(
            await self.get_runtime_capabilities()
        )
        await self.host.model_catalog_update(await self.list_model_catalog(limit=500))
        await self.host.permission_catalog_update(
            await self.list_permission_catalog(limit=500)
        )

    async def _request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> Any:
        try:
            await self._ensure_client()
            client = self._client
            if client is None:
                raise RuntimeUnavailableError("DSH bridge is not running")
            return await client.request(method, params)
        except BridgeRpcError as exc:
            if exc.bridge_code == "DSH_CONCURRENT_WRITER_DETECTED":
                session_id = _optional_string((params or {}).get("sessionId"))
                if session_id is not None:
                    self._concurrent_writer_sessions.add(session_id)
                    with suppress(Exception):
                        await self._publish_concurrent_writer_error(
                            session_id, params or {}
                        )
            raise _runtime_error(method, exc) from exc
        except TimeoutError as exc:
            raise RuntimeUnavailableError(str(exc)) from exc
        except (ConnectionError, RuntimeError) as exc:
            raise RuntimeUnavailableError("DSH bridge is unavailable") from exc
        except ValueError as exc:
            raise RuntimeUpstreamError(str(exc)) from exc

    def _assert_session_writable(self, session_id: str) -> None:
        if session_id in self._concurrent_writer_sessions:
            raise RuntimeConflictError(
                "another DeepSeek Harness process is writing this session; "
                "stop it and force-refresh the session before retrying"
            )

    def _disable_writes_for_conflict(
        self,
        capability_set: RuntimeCapabilitySet,
        session_id: str,
    ) -> RuntimeCapabilitySet:
        if session_id not in self._concurrent_writer_sessions:
            return capability_set
        blocked = {
            "session.send_message",
            "session.steer",
            "session.commands",
            "catalog.model",
            "catalog.permission",
        }
        return replace(
            capability_set,
            revision=capability_set.revision + 1,
            capabilities=tuple(
                replace(
                    capability,
                    available=False,
                    allowed=False,
                    unavailable_reason="another DSH process is writing this native session",
                )
                if capability.capability_id in blocked
                else capability
                for capability in capability_set.capabilities
            ),
        )

    async def _publish_concurrent_writer_error(
        self,
        session_id: str,
        params: Mapping[str, Any],
    ) -> None:
        external_session_id = _optional_string(params.get("externalSessionId"))
        await self.host.runtime_error(
            "dsh",
            "DSH_CONCURRENT_WRITER_DETECTED",
            "Another DeepSeek Harness process is writing this native session",
            session_id=session_id,
            external_session_id=external_session_id,
            details={"retryable": True},
        )
        await self.host.session_state_update(
            session_id,
            "dsh",
            status="error",
            external_session_id=external_session_id,
            status_reason="concurrent_writer",
            error={
                "code": "DSH_CONCURRENT_WRITER_DETECTED",
                "message": "Stop the other DSH process, then refresh and retry",
            },
        )
        client = self._client
        if client is None:
            return
        raw = await client.request(
            "session.getCapabilities",
            _session_params(session_id, external_session_id),
        )
        capabilities = bridge_models.capability_set(
            raw,
            connector_id=self.host.connector_id,
        )
        await self.host.session_capabilities_update(
            self._disable_writes_for_conflict(capabilities, session_id)
        )

    async def _handle_notification(
        self,
        method: str,
        params: Mapping[str, Any],
    ) -> None:
        session_key = _optional_string(params.get("sessionId")) or "runtime"
        lock = self._notification_locks.setdefault(session_key, asyncio.Lock())
        async with lock:
            await self._publish_notification(method, params)

    async def _remember_client_message_id(
        self,
        session_id: str,
        client_message_id: str,
    ) -> None:
        native_message_id = _dsh_message_id(session_id, client_message_id)
        self._client_message_ids[(session_id, native_message_id)] = client_message_id
        await self.host.sync_state_write(
            _client_message_key(session_id, native_message_id),
            {"clientMessageId": client_message_id},
        )

    async def _with_client_message_id(
        self,
        item: RuntimeTimelineItem,
    ) -> RuntimeTimelineItem:
        if item.type != "message" or item.role != "user":
            return item
        source = dict(item.source)
        if _optional_string(source.get("clientMessageId")) is not None:
            return item
        native_message_id = _optional_string(source.get("itemId"))
        if native_message_id is None or not native_message_id.startswith("aa-"):
            return item
        cache_key = (item.session_id, native_message_id)
        client_message_id = self._client_message_ids.get(cache_key)
        if client_message_id is None:
            stored = await self.host.sync_state_read(
                _client_message_key(item.session_id, native_message_id)
            )
            client_message_id = (
                _optional_string(stored.get("clientMessageId"))
                if isinstance(stored, Mapping)
                else None
            )
            if client_message_id is None:
                return item
            self._client_message_ids[cache_key] = client_message_id
        source["clientMessageId"] = client_message_id
        return replace(item, source=source)

    async def _publish_notification(
        self,
        method: str,
        params: Mapping[str, Any],
    ) -> None:
        if method == "runtime.capabilities.update":
            await self.host.runtime_capabilities_update(
                bridge_models.capability_set(
                    params, connector_id=self.host.connector_id
                )
            )
            return
        if method == "session.capabilities.update":
            await self.host.session_capabilities_update(
                bridge_models.capability_set(
                    params, connector_id=self.host.connector_id
                )
            )
            return
        if method == "catalog.model.update":
            await self.host.model_catalog_update(bridge_models.model_catalog(params))
            return
        if method == "catalog.permission.update":
            await self.host.permission_catalog_update(
                bridge_models.permission_catalog(params)
            )
            return
        if method == "session.meta.upsert":
            session = bridge_models.session_meta(params)
            self._known_sessions[session.session_id] = session.external_session_id
            await self.host.session_meta_upsert(
                session.session_id,
                "dsh",
                external_session_id=session.external_session_id,
                title=session.title,
                cwd=session.cwd,
                ordering_time=session.ordering_time,
                metadata=session.metadata,
            )
            return
        if method == "session.state.update":
            state = bridge_models.session_state(params)
            self._known_sessions[state.session_id] = state.external_session_id
            await self.host.session_state_update(
                state.session_id,
                "dsh",
                status=state.status,
                selections=state.selections,
                external_session_id=state.external_session_id,
                status_reason=state.status_reason,
                error=state.error,
                metadata=state.metadata,
            )
            return
        if method == "timeline.item.upsert":
            raw_item = params.get("item")
            if isinstance(raw_item, Mapping):
                item = await self._with_client_message_id(
                    bridge_models.timeline_item(
                        raw_item,
                        default_session_id=_required_string(
                            params.get("sessionId"), "sessionId"
                        ),
                    )
                )
            else:
                # Keep accepting the early bridge-v1 draft shape where the
                # timeline item itself was used as the notification params.
                item = await self._with_client_message_id(
                    bridge_models.timeline_item(params)
                )
            await self.host.timeline_item_upsert(item)
            return
        if method == "timeline.sync":
            session_id = _required_string(params.get("sessionId"), "sessionId")
            raw_items = params.get("items")
            if not isinstance(raw_items, list):
                raise ValueError("DSH timeline.sync items must be an array")
            items = tuple(
                [
                    await self._with_client_message_id(
                        bridge_models.timeline_item(
                            item,
                            default_session_id=session_id,
                        )
                    )
                    for item in raw_items
                ]
            )
            await self.host.timeline_sync(
                session_id,
                "dsh",
                items,
                external_session_id=_optional_string(params.get("externalSessionId")),
                complete=params.get("complete") is True,
                metadata=_safe_metadata(params.get("metadata")),
            )
            return
        if method == "notice.upsert":
            await self.host.notice_upsert(bridge_models.notice(params))
            return
        if method == "runtime.error":
            details = _safe_error_details(params.get("details"))
            await self.host.runtime_error(
                "dsh",
                _required_string(params.get("code"), "runtime error code"),
                _required_string(params.get("message"), "runtime error message"),
                session_id=_optional_string(params.get("sessionId")),
                external_session_id=_optional_string(params.get("externalSessionId")),
                details=details,
            )
            return
        # Protocol 1.x permits additive notifications.

    async def _handle_exit(self, return_code: int | None) -> None:
        if self._stopping:
            return
        self._client = None
        await self.host.runtime_error(
            "dsh",
            "DSH_BRIDGE_EXITED",
            "DeepSeek Harness bridge exited unexpectedly",
            details={"exitCode": return_code, "retryable": True},
        )
        for session_id, external_id in tuple(self._known_sessions.items()):
            await self.host.session_state_update(
                session_id,
                "dsh",
                status="disconnected",
                external_session_id=external_id,
                status_reason="bridge_exited",
            )
        if self._restart_task is None or self._restart_task.done():
            self._restart_task = asyncio.create_task(self._restart_loop())

    async def _restart_loop(self) -> None:
        max_attempts = int(self.config.values.get("maxRestartAttempts", 3))
        base_delay = int(self.config.values.get("restartBackoffMs", 1000)) / 1000
        while not self._stopping and self._restart_attempts < max_attempts:
            delay = base_delay * (2**self._restart_attempts)
            self._restart_attempts += 1
            await asyncio.sleep(delay)
            try:
                await self._ensure_client()
                await self.list_sessions(limit=500, force=True)
                return
            except Exception as exc:  # noqa: BLE001
                await self.host.runtime_error(
                    "dsh",
                    "DSH_BRIDGE_RESTART_FAILED",
                    "DeepSeek Harness bridge restart failed",
                    details={
                        "attempt": self._restart_attempts,
                        "errorType": exc.__class__.__name__,
                        "retryable": self._restart_attempts < max_attempts,
                    },
                )


def _operation_result(value: Any) -> RuntimeOperationResult:
    if not isinstance(value, Mapping):
        raise RuntimeUpstreamError("DSH operation result is invalid")
    nested = value.get("result")
    result = (
        dict(nested)
        if isinstance(nested, Mapping)
        else {
            str(key): item
            for key, item in value.items()
            if key not in {"ok", "code", "message"}
        }
    )
    return RuntimeOperationResult(
        ok=value.get("ok") is not False,
        code=_optional_string(value.get("code")),
        message=_optional_string(value.get("message")),
        result=result,
    )


def _runtime_error(method: str, error: BridgeRpcError) -> Exception:
    code = error.bridge_code or "BRIDGE_ERROR"
    message = str(error)
    if code == "UNSUPPORTED_OPERATION":
        return RuntimeUnsupportedError(method)
    if code in {
        "SESSION_CONFLICT",
        "SESSION_BINDING_CONFLICT",
        "IDEMPOTENCY_CONFLICT",
        "INTERACTION_ALREADY_CLOSED",
        "INTERACTION_NOT_PENDING",
        "DSH_CONCURRENT_WRITER_DETECTED",
        "SESSION_RUNNING",
    }:
        return RuntimeConflictError(message)
    if code in {
        "INVALID_SELECTION",
        "SESSION_NOT_FOUND",
        "COMMAND_NOT_FOUND",
        "INVALID_INTERACTION_RESPONSE",
    } or error.rpc_code in {-32600, -32601, -32602}:
        return RuntimeInvalidRequestError(message)
    if code in {
        "DSH_SERVICE_UNAVAILABLE",
        "NOT_INITIALIZED",
        "SHUTTING_DOWN",
        "REQUEST_TIMEOUT",
    }:
        return RuntimeUnavailableError(message)
    return RuntimeUpstreamError(message)


def _session_params(
    session_id: str,
    external_session_id: str | None,
    *,
    require_external: bool = False,
) -> dict[str, Any]:
    if not session_id:
        raise RuntimeInvalidRequestError("session_id must not be empty")
    if require_external and not external_session_id:
        raise RuntimeInvalidRequestError(
            "DSH write operations require external_session_id"
        )
    params: dict[str, Any] = {"sessionId": session_id}
    _set_optional(params, "externalSessionId", external_session_id)
    return params


def _query_params(query: str | None, limit: int) -> dict[str, Any]:
    params: dict[str, Any] = {"limit": limit}
    _set_optional(params, "query", query)
    return params


def _reject_attachments(attachments: tuple[RuntimeAttachment, ...]) -> None:
    if attachments:
        raise RuntimeUnsupportedError("attachments")


def _set_optional(target: dict[str, Any], key: str, value: Any) -> None:
    if value is not None:
        target[key] = value


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _required_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"DSH {label} must be a non-empty string")
    return value


def _safe_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    blocked = {
        "environment",
        "credentials",
        "apiKey",
        "settings",
        "prompt",
        "stderr",
        "executablePath",
        "dshHome",
    }
    return {
        str(key): item
        for key, item in value.items()
        if isinstance(key, str) and key not in blocked
    }


def _snapshot_metadata(result: Mapping[str, Any]) -> dict[str, Any]:
    metadata = _safe_metadata(result.get("metadata"))
    watermark = result.get("watermark")
    if not isinstance(watermark, Mapping):
        return metadata
    revision = _optional_string(watermark.get("revision"))
    if revision is not None:
        metadata["revision"] = revision
    sequence = watermark.get("seq")
    if isinstance(sequence, int) and not isinstance(sequence, bool) and sequence >= 0:
        metadata["watermarkSeq"] = sequence
    return metadata


def _safe_error_details(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    allowed = {"method", "bridgeCode", "retryable", "exitCode", "attempt", "errorType"}
    return {str(key): item for key, item in value.items() if key in allowed}


def _is_concurrent_writer_state(state: SessionState) -> bool:
    return (
        state.status == "error"
        and isinstance(state.error, Mapping)
        and state.error.get("code") == "DSH_CONCURRENT_WRITER_DETECTED"
    )


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _binding_key(external_session_id: str) -> str:
    return f"dsh/bindings/{_sha256(external_session_id)}"


def _history_cursor_key(external_session_id: str) -> str:
    return f"dsh/history/cursor/{_sha256(external_session_id)}"


def _dsh_message_id(session_id: str, client_message_id: str) -> str:
    return f"aa-{_sha256(f'{session_id}\0{client_message_id}')}"


def _client_message_key(session_id: str, native_message_id: str) -> str:
    return f"dsh/client-messages/{_sha256(f'{session_id}\0{native_message_id}')}"
