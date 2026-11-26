from __future__ import annotations

import asyncio

import pytest

from aa_control.core.errors import DeviceOfflineError, ForbiddenError
from aa_control.core.models import (
    NormalDeviceSummary,
    PresenceReport,
    RegisterDeviceRequest,
)
from aa_control.core.utc import utc_now_iso


async def test_presence_strips_encrypted_summary_and_broadcasts_watch_devices(app, router_pool) -> None:
    user = await app.state.repo.create_user(
        email="devowner@example.com",
        password_hash="x",
        display_name="Owner",
    )
    normal = await app.state.device_service.register_device(
        user_id=user.id,
        req=RegisterDeviceRequest(name="MacBook", platform="macos", mode_hint="normal"),
        actor=f"user:{user.id}",
    )
    enc_key = "B" * 43
    encrypted = await app.state.device_service.register_device(
        user_id=user.id,
        req=RegisterDeviceRequest(
            name="SecretBox",
            platform="linux",
            mode_hint="encrypted",
            e2e_public_key_hint=enc_key,
        ),
        actor=f"user:{user.id}",
    )

    # Start watch_devices stream before presence updates arrive
    received = []

    async def consume_watch() -> None:
        async for ev in app.state.device_service.watch_devices(user.id):
            received.append(ev)
            if len(received) >= 4:
                break

    watch_task = asyncio.create_task(consume_watch())
    await asyncio.sleep(0.05)

    # Normal device reports summary -> preserved
    await app.state.device_service.handle_presence_report(
        authenticated_device_id=normal.device.id,
        report=PresenceReport(
            device_id=normal.device.id,
            platform="macos",
            connector_version="3.0.1",
            mode_hint="normal",
            sent_at=utc_now_iso(),
            summary=NormalDeviceSummary(runtimes=["codex"], active_sessions=3, pending_approvals=1),
        ),
    )

    # Encrypted device accidentally sends summary -> MUST be stripped
    await app.state.device_service.handle_presence_report(
        authenticated_device_id=encrypted.device.id,
        report=PresenceReport(
            device_id=encrypted.device.id,
            platform="linux",
            connector_version="3.0.1",
            mode_hint="encrypted",
            sent_at=utc_now_iso(),
            summary=NormalDeviceSummary(runtimes=["claude"], active_sessions=9, pending_approvals=2),
            e2e_public_key_hint=enc_key,
        ),
    )

    # Rename calls DeviceAdmin/rename and broadcasts upsert
    renamed = await app.state.device_service.rename_device(
        user_id=user.id,
        device_id=normal.device.id,
        name="MacBook Pro",
        actor=f"user:{user.id}",
    )
    assert renamed.name == "MacBook Pro"
    assert any(c.service == "aa.v3.DeviceAdmin" and c.method == "rename" for c in router_pool.calls)

    await asyncio.wait_for(watch_task, timeout=2.0)
    assert received[0].type == "snapshot"
    assert len(received[0].devices or []) == 2
    assert received[1].type == "upsert" and received[1].device.summary is not None
    assert received[2].type == "upsert" and received[2].device.summary is None
    assert received[2].device.e2e_public_key_hint == enc_key
    assert received[3].type == "upsert" and received[3].device.name == "MacBook Pro"

    # Spoofed device_id in presence report is rejected
    with pytest.raises(ForbiddenError):
        await app.state.device_service.handle_presence_report(
            authenticated_device_id=normal.device.id,
            report=PresenceReport(
                device_id=encrypted.device.id,
                platform="linux",
                connector_version="3.0.1",
                mode_hint="encrypted",
                sent_at=utc_now_iso(),
            ),
        )

    # DeviceAdmin ping & check_update work when online, fail when offline
    pong = await app.state.device_service.ping_device(user_id=user.id, device_id=normal.device.id)
    assert pong.ok is True
    assert await app.state.device_service.check_device_update(
        user_id=user.id, device_id=normal.device.id, channel="stable", actor=f"user:{user.id}"
    )

    await app.state.device_service.mark_device_offline(normal.device.id)
    with pytest.raises(DeviceOfflineError):
        await app.state.device_service.ping_device(user_id=user.id, device_id=normal.device.id)
