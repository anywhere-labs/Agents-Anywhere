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
    RuntimeInvalidRequestError,
    RuntimeTimelineSnapshot,
    RuntimeUnavailableError,
    RuntimeUnsupportedError,
    RuntimeUpstreamError,
    SessionMeta,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.dsh import discovery, provider_config
from connector.runtimes.dsh.bridge import models
from connector.runtimes.dsh.bridge.client import BridgeClient, BridgeRpcError


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
        return models.session_state(
            await self._request(
                "session.getState", _session_params(session_id, external_session_id)
            )
        )

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

    # Mutation and catalog methods deliberately inherit RuntimeUnsupportedError.
    # Historical approval/tool records are timeline entries, not actionable notices.

    async def _start_client(self) -> None:
        values = provider_config.normalized_config_values(dict(self.config.values))
        try:
            endpoint = discovery.load_endpoint(values)
        except (OSError, ValueError) as exc:
            raise RuntimeUnavailableError(
                "Start DSH with the phone connection plugin"
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
            if self._stopping or not client.connected:
                raise RuntimeUnavailableError("DSH bridge is stopping")
            self._client = client
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
        elif method == "timeline.item.upsert":
            await self.host.timeline_item_upsert(
                models.timeline_item(params.get("item", params))
            )

    async def _handle_exit(self, return_code: int | None) -> None:
        self._client = None
        if self._stopping:
            return
        with suppress(Exception):
            await self.host.runtime_error(
                "dsh",
                "DSH_BRIDGE_EXITED",
                "DeepSeek Harness bridge disconnected",
                details={"retryable": True},
            )
        if self._restart_task is None or self._restart_task.done():
            self._restart_task = asyncio.create_task(self._restart_loop())

    async def _restart_loop(self) -> None:
        values = provider_config.normalized_config_values(dict(self.config.values))
        for attempt in range(int(values["maxRestartAttempts"])):
            if self._stopping:
                return
            await asyncio.sleep(int(values["restartBackoffMs"]) / 1000 * 2**attempt)
            try:
                await self._ensure_client()
                return
            except (
                Exception
            ):  # A later user request can retry after this bounded recovery loop.
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
