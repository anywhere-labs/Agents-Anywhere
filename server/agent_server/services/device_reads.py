"""Read-through to v3 devices: snapshot, timeline pages and events (D1).

The Server keeps no session content. Reads for a session on a v3 device go to
the device over MeshCall and the client-shaped body is passed through.

- Device offline (not delivered): ``None``; the API answers 200 with
  ``deviceOffline: true`` and empty lists.
- Opened and then failed or timed out (outcome unknown): ``DeviceReadTimeout``,
  reported as ``device_read_timeout``; never as offline.
- Concurrent identical snapshot reads in one worker share one device call
  (single flight; normal mode only, E2EE content never reaches here).
"""

from __future__ import annotations

import asyncio
import base64
import json
import zlib
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from agent_server.core.device_meshcall import (
    DEFAULT_BYTE_BUDGET,
    REQUEST_METHODS,
    ChangesSinceRequest,
    ChangesSinceResponse,
    ClientSnapshotRequest,
    MethodPayload,
    StoreReadRequest,
    StoreReadResponse,
    StreamChunk,
)
from agent_server.infra.device_link import DeviceLinkHub
from agent_server.infra.device_mesh import DeviceCallError, DeviceMesh

T = TypeVar("T")


class DeviceReadTimeout(Exception):
    """The device is online but the read did not complete (``device_read_timeout``)."""

    code = "device_read_timeout"

    def __init__(self, message: str = "the device did not answer in time") -> None:
        super().__init__(message)
        self.message = message


class DeviceReadError(Exception):
    """The device answered with an application error."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def merge_snapshot_chunks(chunks: list[StreamChunk]) -> dict[str, Any]:
    """Join ``Sessions/snapshot`` chunks into one client-shaped body.

    A chunk is a JSON object, or a base64 deflate string of one (``encoding: deflate``).
    Timeline items are concatenated in chunk order; other keys take the last value.
    """

    body: dict[str, Any] = {}
    items: list[Any] = []
    for chunk in sorted(chunks, key=lambda value: value.seq):
        part = chunk.chunk
        if isinstance(part, str):
            part = json.loads(zlib.decompress(base64.b64decode(part)))
        if not isinstance(part, dict):
            continue
        timeline = part.get("timeline")
        if isinstance(timeline, dict) and isinstance(timeline.get("items"), list):
            items.extend(timeline["items"])
        for key, value in part.items():
            if key == "timeline" and isinstance(value, dict):
                merged = dict(body.get("timeline") or {})
                merged.update({k: v for k, v in value.items() if k != "items"})
                body["timeline"] = merged
            else:
                body[key] = value
    if "timeline" in body or items:
        body.setdefault("timeline", {})["items"] = items
    return body


class DeviceReadService:
    def __init__(self, store: Any, mesh: DeviceMesh, hub: DeviceLinkHub) -> None:
        self._store = store
        self._mesh = mesh
        self._hub = hub
        self._flights: dict[tuple[Any, ...], asyncio.Future[Any]] = {}

    async def is_v3_device(self, connector_id: str) -> bool:
        return bool(await self._store.connector_link_contract(connector_id))

    async def _single_flight(self, key: tuple[Any, ...], work: Callable[[], Awaitable[T]]) -> T:
        flight = self._flights.get(key)
        if flight is not None:
            return await asyncio.shield(flight)
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._flights[key] = future
        try:
            result = await work()
        except BaseException as exc:
            if not future.done():
                future.set_exception(exc)
                future.exception()  # observed: waiters re-raise it
            raise
        else:
            future.set_result(result)
            return result
        finally:
            self._flights.pop(key, None)

    def _fail(self, exc: DeviceCallError) -> Exception | None:
        if exc.not_delivered:
            return None
        if exc.outcome_unknown:
            return DeviceReadTimeout(exc.message or "the device did not answer in time")
        # The device's own error code (``details.aaCode``) wins over the MeshCall status.
        aa_code = exc.details.get("aaCode") if isinstance(exc.details, dict) else None
        code = aa_code if isinstance(aa_code, str) and aa_code else exc.code
        return DeviceReadError(code, exc.message or code)

    async def _connection(self, device_id: str) -> str | None:
        return await self._hub.current_connection(device_id)

    async def snapshot(
        self, device_id: str, session_id: str, *, limit: int = 100, byte_budget: int = DEFAULT_BYTE_BUDGET
    ) -> dict[str, Any] | None:
        """The client-shaped snapshot body, or None when the device is offline."""

        connection_id = await self._connection(device_id)
        if connection_id is None:
            return None

        async def read() -> dict[str, Any] | None:
            try:
                chunks = [
                    chunk
                    async for chunk in self._mesh.stream(
                        device_id,
                        REQUEST_METHODS["client.snapshot"],
                        ClientSnapshotRequest(sessionId=session_id, limit=limit, byteBudget=byte_budget),
                        StreamChunk,
                        connection_id=connection_id,
                        timeout=self._mesh.settings.read_timeout_seconds,
                    )
                ]
            except DeviceCallError as exc:
                failure = self._fail(exc)
                if failure is None:
                    return None
                raise failure from exc
            return merge_snapshot_chunks(chunks)

        return await self._single_flight(("snapshot", device_id, session_id, limit, byte_budget), read)

    async def read_page(
        self,
        device_id: str,
        session_id: str,
        *,
        mode: str,
        cursor: int | None = None,
        limit: int = 100,
    ) -> StoreReadResponse | None:
        connection_id = await self._connection(device_id)
        if connection_id is None:
            return None
        try:
            return await self._mesh.unary(
                device_id,
                REQUEST_METHODS["store.read"],
                StoreReadRequest(sessionId=session_id, mode=mode, cursor=cursor, limit=limit),
                StoreReadResponse,
                connection_id=connection_id,
            )
        except DeviceCallError as exc:
            failure = self._fail(exc)
            if failure is None:
                return None
            raise failure from exc

    async def changes_since(
        self, device_id: str, session_id: str, *, after_seq: int, limit: int = 500
    ) -> ChangesSinceResponse | None:
        connection_id = await self._connection(device_id)
        if connection_id is None:
            return None
        try:
            return await self._mesh.unary(
                device_id,
                REQUEST_METHODS["store.changesSince"],
                ChangesSinceRequest(sessionId=session_id, afterSeq=after_seq, limit=limit),
                ChangesSinceResponse,
                connection_id=connection_id,
            )
        except DeviceCallError as exc:
            failure = self._fail(exc)
            if failure is None:
                return None
            raise failure from exc

    async def read_method(self, device_id: str, method: str, params: dict[str, Any]) -> dict[str, Any] | None:
        """A small read (``session.queue``, ``session.notices``...): the device's body, None when offline."""

        connection_id = await self._connection(device_id)
        if connection_id is None:
            return None
        try:
            result = await self._mesh.unary(
                device_id,
                REQUEST_METHODS[method],
                MethodPayload(**params),
                MethodPayload,
                connection_id=connection_id,
            )
        except DeviceCallError as exc:
            failure = self._fail(exc)
            if failure is None:
                return None
            raise failure from exc
        return result.model_dump(mode="json")
