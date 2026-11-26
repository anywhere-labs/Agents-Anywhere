from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from typing import Any

from loguru import logger

from aa_control.core.auth import generate_opaque_token, hash_secret_digest
from aa_control.core.entitlements import EntitlementSet
from aa_control.core.errors import (
    DeviceOfflineError,
    ForbiddenError,
    NotFoundError,
    ValidationError,
)
from aa_control.core.models import (
    DeviceAdminPingResponse,
    DeviceRecord,
    PresenceReport,
    RegisterClientPushRequest,
    RegisterDeviceRequest,
    RegisterDeviceResponse,
    WatchDevicesEvent,
)
from aa_control.core.utc import utc_now_iso
from aa_control.infra.db.repositories import ControlRepository, DeviceRow
from aa_control.infra.redis_store import PresenceSnapshot, RedisControlStore
from aa_control.infra.router_pool import RouterPoolPort


def _merge_device(row: DeviceRow, presence: PresenceSnapshot | None) -> DeviceRecord:
    mode_hint = presence.mode_hint if presence is not None else row.mode_hint
    # Hard invariant: encrypted devices NEVER expose runtime/session summaries.
    summary = presence.summary if (presence is not None and mode_hint == "normal") else None
    e2e_hint = (
        (presence.e2e_public_key_hint if presence is not None else None) or row.e2e_public_key_hint
        if mode_hint == "encrypted"
        else None
    )
    return DeviceRecord(
        id=row.id,
        name=row.name,
        platform=(presence.platform if presence is not None else row.platform),  # type: ignore[arg-type]
        connector_version=presence.connector_version if presence is not None else row.connector_version,
        mode_hint=mode_hint,  # type: ignore[arg-type]
        presence="online" if presence is not None else "offline",
        created_at=row.created_at,
        last_seen_at=presence.last_seen_at if presence is not None else row.last_seen_at,
        summary=summary,
        e2e_public_key_hint=e2e_hint,
    )


class DeviceService:
    def __init__(
        self,
        *,
        repo: ControlRepository,
        redis_store: RedisControlStore,
        router_pool: RouterPoolPort,
    ) -> None:
        self._repo = repo
        self._redis = redis_store
        self._routers = router_pool

    async def register_device(
        self,
        *,
        user_id: str,
        req: RegisterDeviceRequest,
        actor: str,
        entitlements: Mapping[str, Any] | None = None,
    ) -> RegisterDeviceResponse:
        max_devices = EntitlementSet.from_mapping(entitlements).max_devices()
        if max_devices is not None:
            existing_count = await self._repo.count_devices_for_user(user_id)
            if existing_count >= max_devices:
                raise ForbiddenError(
                    f"device limit reached ({max_devices} devices allowed)",
                    code="device_limit_reached",
                )
        raw_secret = generate_opaque_token("aadev_")
        row = await self._repo.create_device(
            user_id=user_id,
            name=req.name.strip(),
            platform=req.platform,
            connector_version=req.connector_version,
            mode_hint=req.mode_hint,
            e2e_public_key_hint=req.e2e_public_key_hint if req.mode_hint == "encrypted" else None,
            secret_hash=hash_secret_digest(raw_secret),
        )
        record = _merge_device(row, None)
        await self._redis.publish_device_event(user_id, WatchDevicesEvent(type="upsert", device=record))
        await self._repo.record_audit(
            user_id=user_id,
            actor=actor,
            action="device.register",
            device_id=row.id,
            metadata={"mode_hint": row.mode_hint, "platform": row.platform},
        )
        return RegisterDeviceResponse(device=record, device_secret=raw_secret)

    async def list_devices(self, user_id: str) -> list[DeviceRecord]:
        rows = await self._repo.list_devices_for_user(user_id)
        presences = await self._redis.get_presences([r.id for r in rows])
        return [_merge_device(r, presences.get(r.id)) for r in rows]

    async def get_device(self, *, user_id: str, device_id: str) -> DeviceRecord:
        row = await self._require_owned_device(user_id=user_id, device_id=device_id)
        presence = await self._redis.get_presence(row.id)
        return _merge_device(row, presence)

    async def handle_presence_report(
        self,
        *,
        authenticated_device_id: str,
        report: PresenceReport,
    ) -> DeviceRecord:
        if report.device_id != authenticated_device_id:
            raise ForbiddenError("presence report device_id does not match authenticated device")
        existing = await self._repo.get_device(authenticated_device_id)
        if existing is None:
            raise NotFoundError(f"device {authenticated_device_id} not found")

        # Hard privacy invariant: encrypted devices never persist or expose runtime summary.
        sanitized_summary = report.summary if report.mode_hint == "normal" else None
        sanitized_e2e_hint = report.e2e_public_key_hint if report.mode_hint == "encrypted" else None
        last_seen = report.sent_at or utc_now_iso()

        snapshot = PresenceSnapshot(
            device_id=authenticated_device_id,
            mode_hint=report.mode_hint,
            platform=report.platform,
            connector_version=report.connector_version,
            last_seen_at=last_seen,
            router_ids=self._routers.router_ids,
            summary=sanitized_summary,
            e2e_public_key_hint=sanitized_e2e_hint,
        )
        await self._redis.set_presence(snapshot)
        updated_row = await self._repo.update_device_heartbeat_meta(
            device_id=authenticated_device_id,
            platform=report.platform,
            connector_version=report.connector_version,
            mode_hint=report.mode_hint,
            e2e_public_key_hint=sanitized_e2e_hint,
            last_seen_at=last_seen,
        )
        row = updated_row or existing
        record = _merge_device(row, snapshot)
        await self._redis.publish_device_event(row.user_id, WatchDevicesEvent(type="upsert", device=record))
        return record

    async def mark_device_offline(self, device_id: str) -> None:
        await self._redis.clear_presence(device_id)
        row = await self._repo.get_device(device_id)
        if row is None:
            return
        record = _merge_device(row, None)
        await self._redis.publish_device_event(row.user_id, WatchDevicesEvent(type="upsert", device=record))

    async def watch_devices(self, user_id: str) -> AsyncIterator[WatchDevicesEvent]:
        devices = await self.list_devices(user_id)
        yield WatchDevicesEvent(type="snapshot", devices=devices)
        async for event in self._redis.subscribe_device_events(user_id):
            yield event

    async def rename_device(
        self,
        *,
        user_id: str,
        device_id: str,
        name: str,
        actor: str,
    ) -> DeviceRecord:
        cleaned = name.strip()
        if not cleaned or len(cleaned) > 128:
            raise ValidationError("device name must be 1..128 characters")
        row = await self._require_owned_device(user_id=user_id, device_id=device_id)
        updated = await self._repo.rename_device(device_id=row.id, name=cleaned)
        assert updated is not None
        presence = await self._redis.get_presence(row.id)
        if presence is not None:
            try:
                await self._routers.call_device_admin(
                    device_id=row.id,
                    method="rename",
                    payload={"name": cleaned},
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("DeviceAdmin/rename failed for device={} err={}", row.id, exc)
        record = _merge_device(updated, presence)
        await self._redis.publish_device_event(user_id, WatchDevicesEvent(type="upsert", device=record))
        await self._repo.record_audit(
            user_id=user_id,
            actor=actor,
            action="device.rename",
            device_id=row.id,
        )
        return record

    async def delete_device(
        self,
        *,
        user_id: str,
        device_id: str,
        actor: str,
    ) -> bool:
        row = await self._require_owned_device(user_id=user_id, device_id=device_id)
        await self._redis.clear_presence(row.id)
        deleted = await self._repo.delete_device(row.id)
        if deleted:
            await self._redis.publish_device_event(user_id, WatchDevicesEvent(type="remove", device_id=row.id))
            await self._repo.record_audit(
                user_id=user_id,
                actor=actor,
                action="device.delete",
                device_id=row.id,
            )
        return deleted

    async def ping_device(self, *, user_id: str, device_id: str) -> DeviceAdminPingResponse:
        row = await self._require_owned_device(user_id=user_id, device_id=device_id)
        if await self._redis.get_presence(row.id) is None:
            raise DeviceOfflineError(f"device {row.id} is offline")
        raw = await self._routers.call_device_admin(device_id=row.id, method="ping", payload={})
        return DeviceAdminPingResponse.model_validate(raw)

    async def check_device_update(
        self,
        *,
        user_id: str,
        device_id: str,
        channel: str | None,
        actor: str,
    ) -> bool:
        row = await self._require_owned_device(user_id=user_id, device_id=device_id)
        if await self._redis.get_presence(row.id) is None:
            raise DeviceOfflineError(f"device {row.id} is offline")
        payload = {"channel": channel} if channel is not None else {}
        await self._routers.call_device_admin(device_id=row.id, method="check_update", payload=payload)
        await self._repo.record_audit(
            user_id=user_id,
            actor=actor,
            action="device.check_update",
            device_id=row.id,
            metadata={"channel": channel},
        )
        return True

    async def register_client_push_token(
        self,
        *,
        user_id: str,
        req: RegisterClientPushRequest,
    ) -> None:
        await self._repo.upsert_client(
            client_id=req.client_id,
            user_id=user_id,
            platform=req.platform,
            label=req.label or "",
            push_token=req.push_token,
            update_push_token=True,
        )

    async def _require_owned_device(self, *, user_id: str, device_id: str) -> DeviceRow:
        row = await self._repo.get_device(device_id)
        if row is None:
            raise NotFoundError(f"device {device_id} not found")
        if row.user_id != user_id:
            raise ForbiddenError("device belongs to another account")
        return row
