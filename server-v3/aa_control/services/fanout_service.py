from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Literal

from aa_control.core.config import ControlSettings
from aa_control.core.models import (
    DeviceError,
    DeviceSessionResult,
    ListSessionsOnceResponse,
    ListSessionsRequest,
    SessionListPayload,
)
from aa_control.infra.db.repositories import ControlRepository, DeviceRow
from aa_control.infra.redis_store import RedisControlStore
from aa_control.infra.router_pool import RouterPoolPort


class FanoutService:
    """Stateless pass-through fan-out for normal-mode devices (never persists or caches sessions)."""

    def __init__(
        self,
        *,
        settings: ControlSettings,
        repo: ControlRepository,
        redis_store: RedisControlStore,
        router_pool: RouterPoolPort,
    ) -> None:
        self._settings = settings
        self._repo = repo
        self._redis = redis_store
        self._routers = router_pool

    async def list_sessions_stream(
        self,
        *,
        user_id: str,
        req: ListSessionsRequest,
        via: Literal["client", "mcp"] = "client",
        mcp_client: str | None = None,
        allowed_device_ids: set[str] | None = None,
    ) -> AsyncIterator[DeviceSessionResult]:
        all_devices = await self._repo.list_devices_for_user(user_id)
        requested_ids = set(req.device_ids) if req.device_ids is not None else None
        selected: list[DeviceRow] = []
        for dev in all_devices:
            if requested_ids is not None and dev.id not in requested_ids:
                continue
            if allowed_device_ids is not None and dev.id not in allowed_device_ids:
                continue
            selected.append(dev)

        presences = await self._redis.get_presences([d.id for d in selected])
        online_normal: list[DeviceRow] = []

        for dev in selected:
            presence = presences.get(dev.id)
            effective_mode = presence.mode_hint if presence is not None else dev.mode_hint
            if effective_mode == "encrypted":
                # MCP must never see encrypted devices; client receives placeholder to fan out locally.
                if via == "client":
                    yield DeviceSessionResult(device_id=dev.id, status="encrypted")
                continue
            if presence is None:
                yield DeviceSessionResult(device_id=dev.id, status="offline")
                continue
            online_normal.append(dev)

        if not online_normal:
            return

        payload: dict = {}
        if req.limit_per_device is not None:
            payload["limit"] = req.limit_per_device

        tasks = [
            asyncio.create_task(
                self._fetch_one(
                    device_id=dev.id,
                    user_id=user_id,
                    payload=payload,
                    via=via,
                    mcp_client=mcp_client,
                )
            )
            for dev in online_normal
        ]
        try:
            for fut in asyncio.as_completed(tasks):
                yield await fut
        finally:
            for t in tasks:
                if not t.done():
                    t.cancel()

    async def list_sessions_once(
        self,
        *,
        user_id: str,
        req: ListSessionsRequest,
        via: Literal["client", "mcp"] = "client",
        mcp_client: str | None = None,
        allowed_device_ids: set[str] | None = None,
    ) -> ListSessionsOnceResponse:
        results: list[DeviceSessionResult] = []
        async for item in self.list_sessions_stream(
            user_id=user_id,
            req=req,
            via=via,
            mcp_client=mcp_client,
            allowed_device_ids=allowed_device_ids,
        ):
            results.append(item)
        return ListSessionsOnceResponse(results=results)

    async def _fetch_one(
        self,
        *,
        device_id: str,
        user_id: str,
        payload: dict,
        via: str,
        mcp_client: str | None,
    ) -> DeviceSessionResult:
        try:
            raw = await asyncio.wait_for(
                self._routers.call_device_sessions(
                    device_id=device_id,
                    method="list",
                    payload=payload,
                    on_behalf_of=f"user:{user_id}",
                    via=via,
                    mcp_client=mcp_client,
                    timeout=self._settings.fanout_timeout_seconds,
                ),
                timeout=self._settings.fanout_timeout_seconds + 0.5,
            )
            parsed = SessionListPayload.model_validate(raw)
            return DeviceSessionResult(device_id=device_id, status="ok", value=parsed)
        except TimeoutError:
            return DeviceSessionResult(
                device_id=device_id,
                status="timeout",
                error=DeviceError(code="timeout", message=f"device {device_id} timed out"),
            )
        except Exception as exc:  # noqa: BLE001
            code = getattr(exc, "code", "error")
            return DeviceSessionResult(
                device_id=device_id,
                status="error",
                error=DeviceError(code=str(code), message=str(exc)),
            )
