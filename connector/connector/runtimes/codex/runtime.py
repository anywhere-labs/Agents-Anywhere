from __future__ import annotations

import asyncio
import hashlib
import json
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from connector.launch import LaunchTarget
from connector.logging import logger
from connector.protocol import protocol_selection_id
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAttachment,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeReasoningItem,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    RuntimeUnsupportedError,
    SessionMeta,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient

NotificationHandler = Callable[[dict[str, Any]], Awaitable[None]]
APP_SERVER_STREAM_LIMIT = 64 * 1024 * 1024


class CodexRuntimeClient(Protocol):
    async def start(self, handler: NotificationHandler) -> None: ...
    async def stop(self) -> None: ...
    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]: ...


@dataclass(slots=True)
class CodexRuntime(AgentRuntime):
    config: RuntimeConfig
    host: RuntimeHostClient
    client: CodexRuntimeClient | None = None
    adapter_version: str = "native-0"

    def __post_init__(self) -> None:
        self._started = False
        self._model_list_result: dict[str, Any] | None = None
        self._session_states: dict[str, SessionState] = {}

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="codex",
            adapter_version=self.adapter_version,
            display_name="Codex",
        )

    async def start(self) -> None:
        if self._started:
            return
        if self.client is not None:
            await self.client.start(self._handle_notification)
            await self._best_effort_bootstrap_reads()
        self._started = True

    async def stop(self) -> None:
        if self.client is not None:
            await self.client.stop()
        self._started = False

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        await self.start()
        catalog = model_catalog_from_codex_items(
            _model_list_items(self._model_list_result),
            revision=self.config.revision,
        )
        if query:
            lowered = query.casefold()
            models = tuple(
                model
                for model in catalog.models
                if lowered in model.id.casefold() or lowered in model.title.casefold()
            )
        else:
            models = catalog.models
        return RuntimeModelCatalog(
            runtime=catalog.runtime,
            revision=catalog.revision,
            models=models[:limit],
        )

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        permissions = permission_catalog_from_codex_items(
            _codex_permission_catalog_items(),
            revision=self.config.revision,
        ).permissions
        if query:
            lowered = query.casefold()
            permissions = tuple(
                item
                for item in permissions
                if lowered in item.id.casefold() or lowered in item.title.casefold()
            )
        return RuntimePermissionCatalog(
            runtime="codex",
            revision=self.config.revision,
            permissions=permissions[:limit],
        )

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        _ = cursor
        _ = force
        if self.client is None:
            return ()
        await self.start()
        result = await self.client.request(
            "thread/list",
            {
                "limit": limit,
                "sortKey": "updated_at",
            },
        )
        sessions: list[SessionMeta] = []
        for thread_ref in _thread_refs_from_list_result(result):
            if _local_thread_state(thread_ref) in {"archived", "deleted", "unresumable"}:
                continue
            thread_id = _thread_id_from_result(thread_ref)
            if thread_id is None:
                continue
            sessions.append(
                SessionMeta(
                    session_id=stable_session_id(self.host.connector_id, thread_id),
                    external_session_id=thread_id,
                    runtime="codex",
                    title=_thread_title(thread_ref),
                    cwd=_thread_cwd(thread_ref),
                    ordering_time=_thread_ordering_time(thread_ref),
                    metadata={
                        "local_state": _local_thread_state(thread_ref),
                        "source": "codex.thread/list",
                    },
                )
            )
        return tuple(sessions[:limit])

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        cached = self._session_states.get(session_id)
        if cached is not None:
            return cached
        if external_session_id is None:
            return None
        return SessionState(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="codex",
            status="idle",
            metadata={"source": "codex.runtime.basic"},
        )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int = 100,
    ) -> RuntimeTimelineSnapshot:
        if self.client is None or external_session_id is None:
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=external_session_id,
                runtime="codex",
                items=(),
                complete=True,
                metadata={"source": "codex.runtime.basic"},
            )
        await self.start()
        result = await self.client.request(
            "thread/read",
            {
                "threadId": external_session_id,
                "includeTurns": True,
            },
        )
        thread = result.get("thread") if isinstance(result.get("thread"), dict) else result
        items = _timeline_items_from_thread(
            session_id=session_id,
            external_session_id=external_session_id,
            thread=thread if isinstance(thread, dict) else {},
            limit=limit,
        )
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="codex",
            items=items,
            complete=True,
            metadata={"source": "codex.thread/read"},
        )

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
        _ensure_text_only_attachments(attachments)
        if self.client is None:
            raise RuntimeUnsupportedError("create_and_start_session")
        await self.start()
        selected_model = await self._model_settings_from_selection(
            (selections or {}).get("model")
        )
        native_permission = await self._permission_settings_from_selection(
            (selections or {}).get("permission")
        )
        result = await self.client.request(
            "thread/start",
            {
                "cwd": cwd,
                "model": selected_model.get("model"),
                "approvalPolicy": native_permission.get("approvalPolicy"),
                "sandbox": native_permission.get("sandbox"),
                "ephemeral": False,
            },
        )
        thread_id = _thread_id_from_result(result)
        if thread_id is None:
            return RuntimeOperationResult(
                ok=False,
                code="codex_thread_start_failed",
                message="Codex thread/start did not return a thread id",
                result={"raw": result},
            )
        await self.host.session_meta_upsert(
            session_id=session_id,
            runtime="codex",
            external_session_id=thread_id,
            title=title,
            cwd=cwd,
            metadata={"source": "codex.thread/start"},
        )
        await self._set_session_state(
            session_id=session_id,
            external_session_id=thread_id,
            status="idle",
            selections=selections,
            metadata={"source": "codex.thread/start"},
        )
        turn_result = await self.start_turn(
            session_id=session_id,
            external_session_id=thread_id,
            content=content,
            attachments=attachments,
            client_message_id=client_message_id,
        )
        return RuntimeOperationResult(
            ok=turn_result.ok,
            code=turn_result.code,
            message=turn_result.message,
            result={
                "sessionId": session_id,
                "externalSessionId": thread_id,
                "thread": result.get("thread") or result,
                **turn_result.result,
            },
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        _ensure_text_only_attachments(attachments)
        if self.client is None or external_session_id is None:
            raise RuntimeUnsupportedError("start_turn")
        await self.start()
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status="waiting",
            metadata={"source": "codex.turn/start.requested"},
        )
        try:
            result = await self.client.request(
                "turn/start",
                {
                    "threadId": external_session_id,
                    "input": [{"type": "text", "text": content, "text_elements": []}],
                    "clientUserMessageId": client_message_id,
                },
            )
        except Exception as exc:
            await self._set_session_state(
                session_id=session_id,
                external_session_id=external_session_id,
                status="error",
                error={
                    "code": getattr(exc, "code", None) or exc.__class__.__name__,
                    "message": str(exc) or exc.__class__.__name__,
                },
                metadata={"source": "codex.turn/start.failed"},
            )
            raise
        turn_id = _turn_id_from_result(result)
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status="running",
            metadata={
                "source": "codex.turn/start",
                **({"turn_id": turn_id} if turn_id else {}),
            },
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "turnId": turn_id,
                "turn": result.get("turn") or result,
                "externalSessionId": external_session_id,
            },
        )

    async def _best_effort_bootstrap_reads(self) -> None:
        if self.client is None:
            return
        for method in ("model/list", "thread/loaded/list"):
            try:
                result = await self.client.request(method)
            except Exception as exc:  # noqa: BLE001
                logger.debug("codex bootstrap read failed method={} error={}", method, exc)
                continue
            if method == "model/list":
                self._model_list_result = result

    async def _handle_notification(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        thread_id = _thread_id_from_result(params)
        session_id = _session_id_from_notification(params)
        if session_id is None and thread_id is not None:
            session_id = stable_session_id(self.host.connector_id, thread_id)
        if session_id is None or thread_id is None:
            return
        if method == "turn/started":
            await self._set_session_state(
                session_id=session_id,
                external_session_id=thread_id,
                status="running",
                metadata={"source": "codex.turn/started"},
            )
        elif method == "turn/completed":
            await self._set_session_state(
                session_id=session_id,
                external_session_id=thread_id,
                status="idle",
                metadata={"source": "codex.turn/completed"},
            )

    async def _set_session_state(
        self,
        session_id: str,
        external_session_id: str | None,
        status: str,
        selections: Mapping[str, str | None] | None = None,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        previous = self._session_states.get(session_id)
        state = SessionState(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="codex",
            status=status,  # type: ignore[arg-type]
            selections={
                **dict(previous.selections if previous is not None else {}),
                **dict(selections or {}),
            },
            error=error,
            metadata={
                **dict(previous.metadata if previous is not None else {}),
                **dict(metadata or {}),
            },
        )
        self._session_states[session_id] = state
        await self.host.session_state_update(
            session_id=session_id,
            runtime="codex",
            external_session_id=external_session_id,
            status=state.status,
            selections=state.selections,
            error=state.error,
            metadata=state.metadata,
        )

    async def _model_settings_from_selection(self, selection_id: str | None) -> dict[str, str]:
        if selection_id is None:
            return {}
        catalog = await self.list_model_catalog()
        for model in catalog.models:
            if model.selection_id == selection_id:
                return {"model": model.id}
            for reasoning in model.reasoning_items:
                if reasoning.selection_id == selection_id:
                    return {"model": model.id, "effort": reasoning.id}
        return {}

    async def _permission_settings_from_selection(self, selection_id: str | None) -> dict[str, Any]:
        if selection_id is None:
            return {}
        catalog = await self.list_permission_catalog()
        for permission in catalog.permissions:
            if permission.selection_id == selection_id:
                native = permission.metadata.get("nativeSettings")
                return dict(native) if isinstance(native, dict) else {}
        return {}


class CodexAppServerClient:
    def __init__(
        self,
        command: list[str],
        environment: Mapping[str, str] | None = None,
    ) -> None:
        self.command = command
        self.environment = dict(environment) if environment is not None else None
        self.process: asyncio.subprocess.Process | None = None
        self._start_lock = asyncio.Lock()
        self._next_id = 1
        self._pending: dict[int | str, asyncio.Future[dict[str, Any]]] = {}
        self._server_request_ids: set[int | str] = set()
        self._notification_handler: NotificationHandler | None = None
        self._initialized = False

    async def start(self, handler: NotificationHandler) -> None:
        async with self._start_lock:
            if self.process is not None and self._initialized:
                self._notification_handler = handler
                return

            self._notification_handler = handler
            if self.process is None:
                logger.info("starting codex app-server command={}", self.command)
                self.process = await asyncio.create_subprocess_exec(
                    *self.command,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    limit=APP_SERVER_STREAM_LIMIT,
                    env=self.environment,
                )
                self._track_reader(asyncio.create_task(self._read_stdout(self.process)), "stdout")
                self._track_reader(asyncio.create_task(self._read_stderr(self.process)), "stderr")

            await self.request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "agents-anywhere-connector",
                        "title": "Agents Anywhere Connector",
                        "version": "0.2.0",
                    },
                    "capabilities": {
                        "experimentalApi": True,
                        "requestAttestation": False,
                    },
                },
            )
            await self.notify("initialized")
            self._initialized = True

    async def stop(self) -> None:
        if self.process is None:
            return
        self.process.terminate()
        try:
            await asyncio.wait_for(self.process.wait(), timeout=5)
        except TimeoutError:
            self.process.kill()
            await self.process.wait()
        finally:
            self.process = None
            self._initialized = False
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(RuntimeError("Codex app-server stopped"))
            self._pending.clear()
            self._server_request_ids.clear()

    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("Codex app-server is not started")

        request_id = self._next_id
        self._next_id += 1
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = future
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": dict(params or {}),
        }
        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()
        return await future

    async def notify(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("Codex app-server is not started")
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "method": method,
            "params": dict(params or {}),
        }
        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()

    async def _read_stdout(self, process: asyncio.subprocess.Process) -> None:
        assert process.stdout
        while line := await process.stdout.readline():
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                logger.warning(
                    "codex app-server emitted non-json stdout: {}",
                    line.decode(errors="replace").strip(),
                )
                continue

            request_id = payload.get("id")
            if request_id in self._pending and ("result" in payload or "error" in payload):
                future = self._pending.pop(request_id)
                self._settle_pending_future(future, payload)
                continue

            if request_id is not None and isinstance(payload.get("method"), str):
                self._server_request_ids.add(request_id)

            if self._notification_handler is not None:
                await self._notification_handler(payload)

    async def _read_stderr(self, process: asyncio.subprocess.Process) -> None:
        assert process.stderr
        while line := await process.stderr.readline():
            logger.trace("codex app-server stderr: {}", line.decode(errors="replace").rstrip())

    def _track_reader(self, task: asyncio.Task[None], name: str) -> None:
        def done(completed: asyncio.Task[None]) -> None:
            try:
                completed.result()
            except asyncio.CancelledError:
                return
            except Exception:  # noqa: BLE001
                logger.exception("codex app-server {} reader stopped unexpectedly", name)

        task.add_done_callback(done)

    @staticmethod
    def _settle_pending_future(
        future: asyncio.Future[dict[str, Any]],
        payload: dict[str, Any],
    ) -> None:
        if future.done():
            return
        if "error" in payload:
            future.set_exception(RuntimeError(json.dumps(payload["error"], ensure_ascii=False)))
            return
        result = payload.get("result")
        future.set_result(result if isinstance(result, dict) else {})


class EmptyCodexClient:
    async def start(self, handler: NotificationHandler) -> None:
        _ = handler

    async def stop(self) -> None:
        pass

    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        _ = method
        _ = params
        return {}


def app_server_client_from_config(config: RuntimeConfig) -> CodexAppServerClient:
    executable = config.values.get("executablePath")
    if not isinstance(executable, str) or not executable:
        raise RuntimeError("Codex app-server runtime requires executablePath")
    target = LaunchTarget(
        source="configured",
        path=executable,
        launcher=str(config.metadata.get("launchTarget", {}).get("launcher") or "direct"),  # type: ignore[arg-type]
    )
    environment = _runtime_environment(config.values.get("environment"))
    return CodexAppServerClient(
        command=target.command(["app-server", "--listen", "stdio://"]),
        environment=environment,
    )


def model_catalog_from_codex_items(
    items: list[dict[str, Any]],
    revision: int,
) -> RuntimeModelCatalog:
    models = tuple(
        model
        for model in (_model_item(item) for item in items)
        if model is not None
    )
    return RuntimeModelCatalog(runtime="codex", revision=revision, models=models)


def permission_catalog_from_codex_items(
    items: list[dict[str, Any]],
    revision: int,
) -> RuntimePermissionCatalog:
    permissions = tuple(
        permission
        for permission in (_permission_item(item) for item in items)
        if permission is not None
    )
    return RuntimePermissionCatalog(runtime="codex", revision=revision, permissions=permissions)


def stable_session_id(connector_id: str, thread_id: str) -> str:
    digest = hashlib.sha256(f"{connector_id}:codex:{thread_id}".encode()).hexdigest()[:24]
    return f"sess_codex_{digest}"


def _model_item(item: dict[str, Any]) -> RuntimeModelItem | None:
    model_id = _first_string(item, "id", "model", "modelId", "model_id", "name")
    if model_id is None:
        return None
    reasoning_items = _reasoning_items(
        model_id,
        _first_list(
            item,
            "reasoningItems",
            "reasoning_items",
            "reasoningEfforts",
            "reasoning_efforts",
            "supportedReasoningEfforts",
            "supported_reasoning_efforts",
            "efforts",
        ),
    )
    return RuntimeModelItem(
        id=model_id,
        title=_first_string(item, "displayName", "display_name", "label", "name") or model_id,
        selection_id=None
        if reasoning_items
        else protocol_selection_id("codex", "model", {"model_id": model_id, "reasoning_id": None}),
        description=_first_string(item, "description"),
        reasoning_items=reasoning_items,
        metadata={"source": "codex.model/list", "raw": item},
    )


def _reasoning_items(
    model_id: str,
    raw_items: list[Any],
) -> tuple[RuntimeReasoningItem, ...]:
    result: list[RuntimeReasoningItem] = []
    for raw in raw_items:
        item = raw if isinstance(raw, dict) else {"id": raw}
        reasoning_id = _first_string(
            item,
            "id",
            "reasoningEffort",
            "reasoning_effort",
            "effort",
            "reasoning",
            "value",
            "name",
        )
        if reasoning_id is None:
            continue
        result.append(
            RuntimeReasoningItem(
                id=reasoning_id,
                title=_first_string(item, "displayName", "display_name", "label", "name")
                or _reasoning_label(reasoning_id),
                selection_id=protocol_selection_id(
                    "codex",
                    "model",
                    {"model_id": model_id, "reasoning_id": reasoning_id},
                ),
                description=_first_string(item, "description"),
                metadata={"source": "codex.model/list", "raw": item},
            )
        )
    return tuple(result)


def _permission_item(item: dict[str, Any]) -> RuntimePermissionItem | None:
    permission_id = _first_string(item, "id")
    title = _first_string(item, "label", "displayName", "display_name", "name")
    if permission_id is None or title is None:
        return None
    identity = item.get("identity") if isinstance(item.get("identity"), dict) else {"permission_id": permission_id}
    metadata = {"source": "codex.static-permissions"}
    if isinstance(item.get("runtimeSettings"), dict):
        metadata["runtimeSettings"] = item["runtimeSettings"]
    if isinstance(item.get("nativeSettings"), dict):
        metadata["nativeSettings"] = item["nativeSettings"]
    return RuntimePermissionItem(
        id=permission_id,
        title=title,
        selection_id=protocol_selection_id("codex", "permission", identity),
        description=_first_string(item, "description"),
        metadata=metadata,
    )


def _model_list_items(result: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(result, dict):
        return []
    for key in ("models", "items", "data"):
        value = result.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    nested = result.get("modelCatalog") or result.get("catalog")
    if isinstance(nested, dict):
        return _model_list_items(nested)
    return []


def _thread_refs_from_list_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("threads", "data", "items"):
        value = result.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    nested = result.get("thread")
    if isinstance(nested, dict):
        return [nested]
    if _thread_id_from_result(result):
        return [result]
    return []


def _timeline_items_from_thread(
    session_id: str,
    external_session_id: str,
    thread: dict[str, Any],
    limit: int,
) -> tuple[RuntimeTimelineItem, ...]:
    raw_items = _raw_timeline_items(thread)
    items: list[RuntimeTimelineItem] = []
    for index, raw in enumerate(raw_items[:limit]):
        item_id = _timeline_item_id(raw, external_session_id, index)
        content = _timeline_item_content(raw)
        source = {
            "runtime": "codex",
            "event": "thread/read",
            "threadId": external_session_id,
            "rawType": raw.get("type"),
        }
        items.append(
            RuntimeTimelineItem(
                id=item_id,
                session_id=session_id,
                type=_timeline_item_type(raw),
                status=_timeline_item_status(raw),
                order_seq=index,
                content_hash=_content_hash(
                    {
                        "type": _timeline_item_type(raw),
                        "status": _timeline_item_status(raw),
                        "role": _timeline_item_role(raw),
                        "content": content,
                    }
                ),
                role=_timeline_item_role(raw),
                turn_id=_timeline_item_turn_id(raw),
                content=content,
                source=source,
                revision=_timeline_item_revision(raw),
                metadata={"raw": raw},
            )
        )
    return tuple(items)


def _raw_timeline_items(thread: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("items", "timeline", "timelineItems", "timeline_items"):
        value = thread.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    turns = thread.get("turns")
    if isinstance(turns, list):
        result: list[dict[str, Any]] = []
        for turn in turns:
            if not isinstance(turn, dict):
                continue
            for key in ("items", "timeline", "timelineItems", "messages"):
                value = turn.get(key)
                if isinstance(value, list):
                    result.extend(item for item in value if isinstance(item, dict))
        return result
    messages = thread.get("messages")
    if isinstance(messages, list):
        return [item for item in messages if isinstance(item, dict)]
    return []


def _timeline_item_id(raw: dict[str, Any], external_session_id: str, index: int) -> str:
    for key in ("id", "itemId", "item_id"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return f"codex_{external_session_id}_{index}_{_content_hash(raw)[:16]}"


def _timeline_item_type(raw: dict[str, Any]) -> str:
    value = raw.get("type") or raw.get("kind")
    return value if isinstance(value, str) and value else "message"


def _timeline_item_status(raw: dict[str, Any]) -> str:
    value = raw.get("status")
    return value if isinstance(value, str) and value else "done"


def _timeline_item_role(raw: dict[str, Any]) -> str | None:
    value = raw.get("role")
    return value if isinstance(value, str) and value else None


def _timeline_item_turn_id(raw: dict[str, Any]) -> str | None:
    for key in ("turnId", "turn_id"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _turn_id_from_result(value: dict[str, Any]) -> str | None:
    turn = value.get("turn") if isinstance(value.get("turn"), dict) else value
    if not isinstance(turn, dict):
        return None
    for key in ("id", "turn_id", "turnId"):
        value = turn.get(key)
        if isinstance(value, str) and value:
            return value
    nested = turn.get("turn")
    if isinstance(nested, dict) and isinstance(nested.get("id"), str):
        return nested["id"]
    return None


def _session_id_from_notification(params: Mapping[str, Any]) -> str | None:
    for key in ("platformSessionId", "sessionId", "session_id"):
        value = params.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _ensure_text_only_attachments(attachments: tuple[RuntimeAttachment, ...]) -> None:
    if attachments:
        raise RuntimeUnsupportedError("codex.attachments")


def _timeline_item_revision(raw: dict[str, Any]) -> int:
    value = raw.get("revision")
    return value if isinstance(value, int) and value > 0 else 1


def _timeline_item_content(raw: dict[str, Any]) -> Mapping[str, Any]:
    content = raw.get("content")
    if isinstance(content, dict):
        return content
    text = raw.get("text")
    if isinstance(text, str):
        return {"text": text, "format": "markdown"}
    if isinstance(content, str):
        return {"text": content, "format": "markdown"}
    return {}


def _thread_id_from_result(value: dict[str, Any]) -> str | None:
    thread = value.get("thread") if isinstance(value.get("thread"), dict) else value
    if not isinstance(thread, dict):
        return None
    for key in ("id", "thread_id", "threadId"):
        value = thread.get(key)
        if isinstance(value, str) and value:
            return value
    nested = thread.get("thread")
    if isinstance(nested, dict) and isinstance(nested.get("id"), str):
        return nested["id"]
    return None


def _local_thread_state(thread_ref: dict[str, Any]) -> str:
    for key in ("localState", "local_state", "lifecycleState", "lifecycle_state"):
        value = thread_ref.get(key)
        if isinstance(value, str):
            normalized = value.lower()
            if normalized in {"active", "archived", "deleted", "unresumable", "unknown"}:
                return normalized
    status = thread_ref.get("status")
    if isinstance(status, dict):
        status = status.get("type") or status.get("state")
    if isinstance(status, str):
        normalized_status = status.lower()
        if normalized_status in {"archived", "deleted", "unresumable"}:
            return normalized_status
    for key in ("archived", "isArchived", "is_archived"):
        if thread_ref.get(key) is True:
            return "archived"
    for key in ("deleted", "isDeleted", "is_deleted"):
        if thread_ref.get(key) is True:
            return "deleted"
    if thread_ref.get("resumeSupported") is False or thread_ref.get("resumable") is False:
        return "unresumable"
    return "active"


def _thread_title(thread_ref: dict[str, Any]) -> str | None:
    return _first_string(thread_ref, "name", "title", "summary")


def _thread_cwd(thread_ref: dict[str, Any]) -> str | None:
    value = thread_ref.get("cwd") or thread_ref.get("workingDirectory") or thread_ref.get("working_directory")
    return value if isinstance(value, str) and value else None


def _thread_ordering_time(thread_ref: dict[str, Any]) -> str | None:
    value = (
        thread_ref.get("updatedAt")
        or thread_ref.get("updated_at")
        or thread_ref.get("createdAt")
        or thread_ref.get("created_at")
    )
    return str(value) if value is not None else None


def _runtime_environment(raw: Any) -> dict[str, str]:
    environment = dict(os.environ)
    if isinstance(raw, dict):
        for key, value in raw.items():
            if value is None:
                environment.pop(str(key), None)
            elif isinstance(value, str):
                environment[str(key)] = value
    return environment


def _codex_permission_catalog_items() -> list[dict[str, Any]]:
    return [
        {
            "id": "untrusted_workspace_write",
            "label": "Ask for untrusted commands",
            "description": "Run trusted commands automatically in workspace-write sandbox; ask before untrusted commands.",
            "identity": {
                "approval_policy": "untrusted",
                "sandbox": "workspace-write",
            },
            "runtimeSettings": {"permissionMode": "untrusted_workspace_write"},
            "nativeSettings": {
                "approvalPolicy": "untrusted",
                "sandbox": "workspace-write",
                "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            },
        },
        {
            "id": "on_request_workspace_write",
            "label": "Ask when requested",
            "description": "Use workspace-write sandbox and let the model decide when to ask for approval.",
            "identity": {
                "approval_policy": "on-request",
                "sandbox": "workspace-write",
            },
            "runtimeSettings": {"permissionMode": "on_request_workspace_write"},
            "nativeSettings": {
                "approvalPolicy": "on-request",
                "sandbox": "workspace-write",
                "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            },
        },
        {
            "id": "on_request_read_only",
            "label": "Read only",
            "description": "Run commands in read-only sandbox; ask before work that needs writes.",
            "identity": {
                "approval_policy": "on-request",
                "sandbox": "read-only",
            },
            "runtimeSettings": {"permissionMode": "on_request_read_only"},
            "nativeSettings": {
                "approvalPolicy": "on-request",
                "sandbox": "read-only",
                "sandboxPolicy": {"type": "readOnly", "networkAccess": False},
            },
        },
        {
            "id": "never_workspace_write",
            "label": "Never ask, workspace write",
            "description": "Do not prompt for approvals; failures are returned to the model. Commands stay sandboxed to workspace writes.",
            "identity": {
                "approval_policy": "never",
                "sandbox": "workspace-write",
            },
            "runtimeSettings": {"permissionMode": "never_workspace_write"},
            "nativeSettings": {
                "approvalPolicy": "never",
                "sandbox": "workspace-write",
                "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            },
        },
        {
            "id": "never_danger_full_access",
            "label": "Full access ⚠️",
            "description": "Never ask and run without sandboxing. Use only in externally sandboxed environments.",
            "identity": {
                "approval_policy": "never",
                "sandbox": "danger-full-access",
            },
            "runtimeSettings": {"permissionMode": "never_danger_full_access"},
            "nativeSettings": {
                "approvalPolicy": "never",
                "sandbox": "danger-full-access",
                "sandboxPolicy": {"type": "dangerFullAccess"},
            },
        },
    ]


def _first_string(item: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _first_list(item: dict[str, Any], *keys: str) -> list[Any]:
    for key in keys:
        value = item.get(key)
        if isinstance(value, list):
            return value
    return []


def _reasoning_label(reasoning_id: str) -> str:
    return {
        "low": "Low",
        "medium": "Medium",
        "high": "High",
        "xhigh": "Extra high",
        "max": "Max",
        "ultra": "Ultra",
    }.get(reasoning_id, reasoning_id)


def _content_hash(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(encoded.encode()).hexdigest()
