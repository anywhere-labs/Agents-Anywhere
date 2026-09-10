from __future__ import annotations

import asyncio
from collections.abc import Mapping
from contextlib import suppress
from typing import Any

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeCapabilitySet,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeAttachment,
    RuntimeOperationResult,
    RuntimeModelCatalog,
    RuntimePermissionCatalog,
    RuntimeInvalidRequestError,
    RuntimeTimelineSnapshot,
    RuntimeUnavailableError,
    RuntimeUnsupportedError,
    RuntimeUpstreamError,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.logging import logger
from connector.runtimes.dsh import discovery, provider_config
from connector.runtimes.dsh.attachments import staged_attachments
from connector.runtimes.dsh.bridge import models
from connector.runtimes.dsh.bridge.client import BridgeClient, BridgeRpcError
from connector.runtimes.dsh.bridge.sync import SyncRelay


BRIDGE_POLL_INTERVAL_SECONDS = 5.0


class DshRuntime(AgentRuntime):
    """Protocol adapter; all DSH reads and timeline projection belong to the plugin."""

    def __init__(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
        client_version: str = "1.0",
    ) -> None:
        self.config = config
        self.host = host
        self.client_version = client_version
        self._identity = RuntimeIdentity("dsh", "unknown", "DeepSeek Harness")
        self._client: BridgeClient | None = None
        self._connect_lock = asyncio.Lock()
        # Each connection owns one inventory and one history capture.
        self._read_lock = asyncio.Lock()
        self._stopping = False
        self._restart_task: asyncio.Task[None] | None = None
        self._sync: SyncRelay | None = None
        self._sync_mode = "events"

    @property
    def sync_mode(self) -> str:
        return self._sync_mode

    async def resynchronize(self, session_id: str | None = None, external_session_id: str | None = None) -> None:
        if session_id:
            await self._request("runtime.sync.refresh", _session_params(session_id, external_session_id))
            return
        await self._ensure_client()
        async with self._connect_lock:
            if self._sync is not None:
                await self._sync.close()
            if not self._stopping and self._client is not None and self.sync_mode == "events":
                self._sync = SyncRelay(self._client, self.host)
                self._sync.start()

    @property
    def identity(self) -> RuntimeIdentity:
        return self._identity

    async def start(self) -> None:
        self._stopping = False
        await self.host.runtime_health_update("starting", {
            "code": "runtime_initializing", "message": "正在连接 DSH 并同步会话…", "retryable": True,
        })
        try:
            await self._ensure_client()
        except (OSError, RuntimeError, ValueError):
            with suppress(Exception):
                await self.host.runtime_health_update(
                    "starting",
                    {
                        "code": "runtime_unavailable",
                        "message": "正在等待本地 DSH Bridge；请启动 DSH 并启用手机连接插件。",
                        "retryable": True,
                    },
                )
            self._schedule_restart()

    async def stop(self) -> None:
        self._stopping = True
        if self._sync is not None:
            await self._sync.close()
            self._sync = None
        if self._restart_task is not None:
            self._restart_task.cancel()
            await asyncio.gather(self._restart_task, return_exceptions=True)
            self._restart_task = None
        async with self._connect_lock:
            client, self._client = self._client, None
            if client is not None:
                await client.close()

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        return models.capability_set(
            await self._request("runtime.getCapabilities"),
            connector_id=self.host.connector_id,
        )

    async def list_model_catalog(self, query: str | None = None, limit: int = 100) -> RuntimeModelCatalog:
        return models.model_catalog(await self._request("catalog.listModels", {"query": query, "limit": limit}))

    async def list_permission_catalog(self, query: str | None = None, limit: int = 100) -> RuntimePermissionCatalog:
        return models.permission_catalog(await self._request("catalog.listPermissions", {"query": query, "limit": limit}))

    async def update_session_selections(
        self, session_id: str, external_session_id: str | None, selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        result = _object(await self._request("session.updateSelections", {
            **_session_params(session_id, external_session_id), "selections": dict(selections),
        }))
        return RuntimeOperationResult(
            ok=result.get("ok") is not False, code=result.get("code"), message=result.get("message"),
            result=_object(result.get("result") or {}),
        )

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        async with self._read_lock:
            result = await self._request(
                "session.list", {"limit": limit, "cursor": cursor, "force": force}
            )
            return tuple(
                models.session_meta(item) for item in _array(result, "sessions")
            )

    async def list_complete_session_inventory(
        self,
        page_size: int = 100,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        async with self._read_lock:
            output: list[SessionMeta] = []
            cursors: set[str] = set()
            identities: set[str] = set()
            cursor: str | None = None
            while True:
                result = await self._request(
                    "session.list",
                    {"limit": page_size, "cursor": cursor, "force": force},
                )
                for item in _array(result, "sessions"):
                    meta = models.session_meta(item)
                    if meta.session_id in identities:
                        raise RuntimeUpstreamError("DSH inventory repeated a session")
                    identities.add(meta.session_id)
                    output.append(meta)
                cursor = _next_cursor(result, cursors)
                if cursor is None:
                    return tuple(output)

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        params = _session_params(session_id, external_session_id)
        if limit is not None:
            params["limit"] = limit
        async with self._read_lock:
            items = []
            ids: set[str] = set()
            cursors: set[str] = set()
            first: dict[str, Any] | None = None
            while True:
                result = _object(await self._request("session.getSnapshot", params))
                if result.get("sessionId") != session_id:
                    raise RuntimeUpstreamError(
                        "DSH snapshot returned a different session"
                    )
                native_id = result.get("externalSessionId")
                if not isinstance(native_id, str) or not native_id:
                    raise RuntimeUpstreamError(
                        "DSH snapshot has no native session identity"
                    )
                if external_session_id and external_session_id != native_id:
                    raise RuntimeUpstreamError(
                        "DSH snapshot returned a different native session"
                    )
                if first is None:
                    first = result
                elif result.get("watermark") != first.get(
                    "watermark"
                ) or native_id != first.get("externalSessionId"):
                    raise RuntimeUpstreamError("DSH snapshot changed during pagination")
                for value in _array(result, "items"):
                    item = models.timeline_item(value)
                    if item.session_id != session_id or item.id in ids:
                        raise RuntimeUpstreamError(
                            "DSH snapshot has duplicate or foreign items"
                        )
                    ids.add(item.id)
                    items.append(item)
                cursor = _next_cursor(result, cursors)
                if cursor is None:
                    complete = (
                        first.get("snapshotComplete", first.get("complete")) is True
                    )
                    metadata = dict(first.get("metadata") or {})
                    total = metadata.get("totalItems")
                    if total is not None and total != len(items):
                        raise RuntimeUpstreamError("DSH snapshot is missing a page")
                    return RuntimeTimelineSnapshot(
                        session_id=session_id,
                        external_session_id=native_id,
                        runtime="dsh",
                        items=tuple(items),
                        complete=complete,
                        metadata=metadata,
                    )
                params["cursor"] = cursor

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState:
        payload = _object(await self._request(
            "session.getState", _session_params(session_id, external_session_id)
        ))
        state = models.session_state(payload)
        source = payload.get("sourceState")
        if isinstance(source, dict):
            if payload.get("sessionId") != session_id or (
                external_session_id and payload.get("externalSessionId") != external_session_id
            ):
                raise RuntimeUpstreamError("DSH source observation returned a different session")
            # Wait for ingestion before returning session.state. The server's
            # detail snapshot then reads the fresh source fact from its database.
            await self.host.publish_runtime_notifications("dsh", [{
                "method": "session.source.updated", "params": {
                    "sessionId": session_id, "externalSessionId": payload.get("externalSessionId"),
                    **source, "observationOrigin": "operation",
                },
            }])
        return state

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        return models.capability_set(
            await self._request(
                "session.getCapabilities",
                _session_params(session_id, external_session_id),
            ),
            connector_id=self.host.connector_id,
        )

    async def get_session_notices(
        self, session_id: str, external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        result = await self._request(
            "session.getNotices", _session_params(session_id, external_session_id)
        )
        return tuple(models.notice(item) for item in _array(result, "notices"))

    async def respond_interaction(
        self, session_id: str, notice_id: str, action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        result = _object(await self._request("session.respondInteraction", {
            "sessionId": session_id, "noticeId": notice_id,
            "actionId": action_id, "inputData": dict(input_data or {}),
        }))
        return RuntimeOperationResult(
            ok=result.get("ok") is True,
            code=result.get("code"), message=result.get("message"),
            result=_object(result.get("result") or {}),
        )

    async def create_and_start_session(
        self, session_id: str, content: str, title: str | None = None,
        cwd: str | None = None, selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (), client_message_id: str | None = None,
        *, runtime_options: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        options = dict(runtime_options or {})
        if set(options) - {"agentPreset"}:
            raise RuntimeInvalidRequestError("Unsupported DSH creation option")
        preset = options.get("agentPreset", self.config.values.get("defaultAgentPreset"))
        return await self._send_text("session.createAndStart", session_id, None, content, cwd, attachments, client_message_id,
                                     selections=selections, agent_preset=preset)

    async def start_turn(
        self, session_id: str, external_session_id: str | None, content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (), client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        return await self._send_text("session.startTurn", session_id, external_session_id, content, cwd, attachments, client_message_id,
                                     selections=selections)

    async def _send_text(
        self, method: str, session_id: str, external_id: str | None, content: str,
        cwd: str | None, attachments: tuple[RuntimeAttachment, ...], client_message_id: str | None,
        *, selections: Mapping[str, str | None] | None = None, agent_preset: str | None = None,
    ) -> RuntimeOperationResult:
        if (not content.strip() and not attachments) or not client_message_id:
            raise RuntimeInvalidRequestError("A message and a stable clientMessageId are required")
        params = {**_session_params(session_id, external_id), "content": content,
                  "clientMessageId": client_message_id, "cwd": cwd,
                  "selections": dict(selections or {})}
        if method == "session.createAndStart":
            params["agentPreset"] = agent_preset
        if attachments:
            capability_set = _object(await self._request("runtime.getCapabilities"))
            if not provider_config.dsh_capabilities(capability_set)["attachments"]:
                raise RuntimeUnsupportedError("This DSH Bridge does not support attachments")
        directory = provider_config.endpoint_path(dict(self.config.values)).parent
        async with staged_attachments(self.host, session_id, attachments, directory) as images:
            if images:
                params["attachments"] = images
            payload = _object(await self._request(method, params))
        if payload.get("ok") is False:
            return RuntimeOperationResult(ok=False, code=payload.get("code"), message=payload.get("message"),
                                          result=_object(payload.get("result") or {}))
        return RuntimeOperationResult(result=payload)

    async def interrupt_session(self, session_id: str, reason: str | None = None) -> RuntimeOperationResult:
        return RuntimeOperationResult(result=_object(await self._request("session.interrupt", {"sessionId": session_id})))

    async def _start_client(self) -> None:
        values = provider_config.normalized_config_values(dict(self.config.values))
        try:
            endpoint = discovery.load_endpoint(values)
        except (OSError, ValueError) as exc:
            raise RuntimeUnavailableError(
                "请启动 DSH，并启用手机连接插件。"
            ) from exc
        client = BridgeClient(
            endpoint=endpoint,
            connector_id=self.host.connector_id,
            session_namespace=getattr(
                self.host, "session_namespace", self.host.connector_id
            ),
            client_version=self.client_version,
            startup_timeout=int(values["startupTimeoutMs"]) / 1000,
            request_timeout=int(values["requestTimeoutMs"]) / 1000,
            notification_handler=self._handle_notification,
            exit_handler=self._handle_exit,
        )
        try:
            result = await client.start()
            identity = result["identity"]
            self._identity = RuntimeIdentity(
                runtime="dsh",
                runtime_version=identity.get("runtimeVersion", "unknown"),
                display_name="DeepSeek Harness",
                protocol_version=identity["protocolVersion"],
            )
            # Bootstrap only declared capabilities; read-only startup needs no model catalog.
            capabilities = models.capability_set(
                await client.request("runtime.getCapabilities"),
                connector_id=self.host.connector_id,
            )
            await self.host.runtime_capabilities_update(capabilities)
            supported = {item.capability_id for item in capabilities.capabilities if item.available and item.supported}
            for capability, method, decode, publish in (
                ("catalog.model", "catalog.listModels", models.model_catalog, "model_catalog_update"),
                ("catalog.permission", "catalog.listPermissions", models.permission_catalog, "permission_catalog_update"),
            ):
                if capability not in supported:
                    continue
                try:
                    await getattr(self.host, publish)(decode(await client.request(method, {"limit": 10000})))
                except Exception as error:
                    logger.warning("DSH initial catalog unavailable method={} error_type={}; other runtime operations remain available", method, type(error).__name__)
            if self._stopping or not client.connected:
                raise RuntimeUnavailableError("DSH bridge is stopping")
            self._client = client
            self._sync_mode = "events" if result.get("features", {}).get("syncMode") == "events" else "polling"
            if self._sync_mode == "events":
                await self.host.runtime_health_update("starting", {
                    "code": "runtime_initializing", "message": "正在同步 DSH 会话…", "retryable": True,
                })
                self._sync = SyncRelay(client, self.host)
                self._sync.start()
            else:
                with suppress(Exception):
                    await self.host.runtime_health_update("running")
        except BaseException:
            await client.close()
            raise

    async def _ensure_client(self) -> None:
        if self._client is not None and self._client.connected:
            return
        async with self._connect_lock:
            if self._stopping:
                raise RuntimeUnavailableError("DSH bridge is stopping")
            if self._client is not None and not self._client.connected:
                client, self._client = self._client, None
                await client.close()
            if self._client is None:
                await self._start_client()

    async def _request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> Any:
        try:
            await self._ensure_client()
            if self._client is None:
                raise RuntimeUnavailableError("DSH bridge is not running")
            return await self._client.request(method, params)
        except BridgeRpcError as exc:
            if exc.bridge_code in {"UNSUPPORTED_OPERATION", "METHOD_NOT_FOUND"}:
                raise RuntimeUnsupportedError(method) from exc
            if exc.bridge_code in {
                "INVALID_REQUEST",
                "INVALID_PARAMS",
                "SESSION_NOT_FOUND",
            }:
                raise RuntimeInvalidRequestError(str(exc)) from exc
            if exc.retryable:
                raise RuntimeUnavailableError(str(exc)) from exc
            raise RuntimeUpstreamError(str(exc)) from exc
        except (OSError, TimeoutError, ConnectionError, RuntimeError) as exc:
            logger.warning("DSH bridge request unavailable method={} error_type={}; check the plugin Bridge logs page", method, type(exc).__name__)
            raise RuntimeUnavailableError("DSH bridge is unavailable") from exc
        except ValueError as exc:
            raise RuntimeUpstreamError(str(exc)) from exc

    async def _handle_notification(
        self, method: str, params: Mapping[str, Any]
    ) -> None:
        # Additive 1.x notification support stays mechanical; never interpret native DSH events here.
        if method == "runtime.capabilities.update":
            await self.host.runtime_capabilities_update(
                models.capability_set(params, connector_id=self.host.connector_id)
            )
        elif method == "timeline.item.upsert" and self.sync_mode != "events":
            await self.host.timeline_item_upsert(
                models.timeline_item(params.get("item", params))
            )
        elif method == "runtime.sync.batch" and self._sync is not None:
            self._sync.accept(params)
        elif method == "runtime.error" and self._sync is not None:
            data = params.get("data")
            stream_id = data.get("streamId") if isinstance(data, dict) else None
            self._sync.restart(stream_id if isinstance(stream_id, str) else None)

    async def _handle_exit(self, return_code: int | None) -> None:
        self._client = None
        if self._sync is not None:
            await self._sync.close()
            self._sync = None
        if self._stopping:
            return
        with suppress(Exception):
            await self.host.runtime_error(
                "dsh",
                "DSH_BRIDGE_EXITED",
                "DeepSeek Harness bridge disconnected",
                details={"retryable": True},
            )
        # The instance is still the user's active runtime, but it is no longer
        # usable: surface that instead of leaving the platform showing "running".
        with suppress(Exception):
            await self.host.runtime_health_update(
                "error",
                {
                    "code": "runtime_unavailable",
                    "message": "DSH 已断开，正在等待本地 Bridge 恢复；请确认 DSH 和手机连接插件已启动。",
                    "retryable": True,
                },
            )
        self._schedule_restart()

    def _schedule_restart(self) -> None:
        if not self._stopping and (self._restart_task is None or self._restart_task.done()):
            self._restart_task = asyncio.create_task(self._restart_loop())

    async def _restart_loop(self) -> None:
        values = provider_config.normalized_config_values(dict(self.config.values))
        fast_attempts = int(values["maxRestartAttempts"])
        attempt = 0
        while not self._stopping:
            if self._client is not None and self._client.connected:
                return
            delay = BRIDGE_POLL_INTERVAL_SECONDS
            if attempt < fast_attempts:
                delay = min(int(values["restartBackoffMs"]) / 1000 * 2**attempt, delay)
            await asyncio.sleep(delay)
            if self._stopping:
                return
            try:
                # Re-read endpoint.json on every attempt: DSH can restart on a new port.
                await self._ensure_client()
                return
            except Exception:
                attempt = min(attempt + 1, fast_attempts)
                # Stay quiet while offline; the exit handler already published health.
                continue


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeUpstreamError("DSH response must be an object")
    return value


def _array(value: Any, key: str) -> list[Any]:
    field = _object(value).get(key)
    if not isinstance(field, list):
        raise RuntimeUpstreamError(f"DSH response {key} must be an array")
    return field


def _next_cursor(value: Any, seen: set[str]) -> str | None:
    cursor = _object(value).get("nextCursor")
    if cursor is None:
        return None
    if not isinstance(cursor, str) or not cursor or cursor in seen:
        raise RuntimeUpstreamError("DSH returned an invalid or repeated cursor")
    seen.add(cursor)
    return cursor


def _session_params(session_id: str, external_session_id: str | None) -> dict[str, Any]:
    params: dict[str, Any] = {"sessionId": session_id}
    if external_session_id is not None:
        params["externalSessionId"] = external_session_id
    return params
