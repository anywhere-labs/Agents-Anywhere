from __future__ import annotations

from loguru import logger

from aa_control.core.auth import format_client_principal
from aa_control.core.config import ControlSettings
from aa_control.core.errors import (
    DeviceOfflineError,
    ForbiddenError,
    NotFoundError,
    RateLimitError,
    ValidationError,
)
from aa_control.core.models import OpenTunnelRequest, OpenTunnelResponse, RevokeTunnelResponse
from aa_control.infra.db.repositories import ControlRepository
from aa_control.infra.redis_store import RedisControlStore
from aa_control.infra.router_pool import RouterPoolPort


class TunnelService:
    """Server-gate tunnel admission for both normal and encrypted devices."""

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

    async def open_tunnel(
        self,
        *,
        user_id: str,
        client_id: str,
        req: OpenTunnelRequest,
    ) -> OpenTunnelResponse:
        allowed = await self._redis.check_rate_limit(
            bucket=f"open-tunnel:{user_id}",
            limit=self._settings.tunnel_open_rate_limit_per_min,
            window_seconds=60,
        )
        if not allowed:
            raise RateLimitError("tunnel open rate limit exceeded")

        device = await self._repo.get_device(req.device_id)
        if device is None:
            raise NotFoundError(f"device {req.device_id} not found")
        if device.user_id != user_id:
            raise ForbiddenError("device belongs to another account")

        presence = await self._redis.get_presence(device.id)
        if presence is None:
            raise DeviceOfflineError(f"device {device.id} is offline")

        mode = presence.mode_hint or device.mode_hint
        e2e_key: str | None = None
        if mode == "encrypted":
            e2e_key = req.e2e_key or presence.e2e_public_key_hint or device.e2e_public_key_hint
            if not e2e_key:
                raise ValidationError(
                    "encrypted device requires client-pinned e2e_key (from device QR) or device e2e_public_key_hint"
                )
        elif req.e2e_key:
            # Never downgrade a client that explicitly requests an encrypted tunnel.
            mode = "encrypted"
            e2e_key = req.e2e_key

        effective_client_id = req.client_id or client_id
        principal = format_client_principal(user_id, effective_client_id)
        opened = await self._routers.open_tunnel(
            device_id=device.id,
            principal=principal,
            ttl_seconds=self._settings.tunnel_ttl_seconds,
            e2e_key=e2e_key,
            preferred_router_ids=presence.router_ids,
        )
        await self._repo.record_audit(
            user_id=user_id,
            actor=principal,
            action="tunnel.open",
            device_id=device.id,
            metadata={"tunnel_id": opened.tunnel_id, "mode": mode, "router_id": opened.router_id},
        )
        return OpenTunnelResponse(
            router_url=opened.router_url,
            credential=opened.credential,
            tunnel_id=opened.tunnel_id,
            expires_at=opened.expires_at,
            mode=mode,  # type: ignore[arg-type]
        )

    async def revoke_tunnel(
        self,
        *,
        user_id: str,
        device_id: str,
        tunnel_id: str,
        actor: str,
    ) -> RevokeTunnelResponse:
        device = await self._repo.get_device(device_id)
        if device is None:
            raise NotFoundError(f"device {device_id} not found")
        if device.user_id != user_id:
            raise ForbiddenError("device belongs to another account")

        revoked = await self._routers.revoke_tunnel(tunnel_id)
        notified = False
        if await self._redis.get_presence(device.id) is not None:
            try:
                await self._routers.call_device_admin(
                    device_id=device.id,
                    method="close_tunnel_sessions",
                    payload={"tunnel_id": tunnel_id},
                )
                notified = True
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "DeviceAdmin/close_tunnel_sessions failed device={} tunnel={} err={}",
                    device.id,
                    tunnel_id,
                    exc,
                )
        await self._repo.record_audit(
            user_id=user_id,
            actor=actor,
            action="tunnel.revoke",
            device_id=device.id,
            metadata={"tunnel_id": tunnel_id, "revoked": revoked, "device_notified": notified},
        )
        return RevokeTunnelResponse(revoked=revoked, device_notified=notified)
