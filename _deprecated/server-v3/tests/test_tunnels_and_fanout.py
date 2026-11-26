from __future__ import annotations

import asyncio

import pytest

from aa_control.core.errors import DeviceOfflineError, ForbiddenError, ValidationError
from aa_control.core.models import (
    ListSessionsRequest,
    OpenTunnelRequest,
    PresenceReport,
    RegisterDeviceRequest,
)
from aa_control.core.utc import utc_now_iso


async def test_open_and_revoke_tunnel_for_normal_and_encrypted_devices(app, router_pool) -> None:
    alice = await app.state.repo.create_user(email="a@example.com", password_hash="x", display_name="A")
    bob = await app.state.repo.create_user(email="b@example.com", password_hash="x", display_name="B")

    norm = await app.state.device_service.register_device(
        user_id=alice.id,
        req=RegisterDeviceRequest(name="Normal", platform="macos", mode_hint="normal"),
        actor=f"user:{alice.id}",
    )
    enc = await app.state.device_service.register_device(
        user_id=alice.id,
        req=RegisterDeviceRequest(name="Encrypted", platform="linux", mode_hint="encrypted"),
        actor=f"user:{alice.id}",
    )

    # Offline device cannot open tunnel
    with pytest.raises(DeviceOfflineError):
        await app.state.tunnel_service.open_tunnel(
            user_id=alice.id,
            client_id="cli_1",
            req=OpenTunnelRequest(device_id=norm.device.id),
        )

    # Bring both online
    for dev_id, mode in ((norm.device.id, "normal"), (enc.device.id, "encrypted")):
        await app.state.device_service.handle_presence_report(
            authenticated_device_id=dev_id,
            report=PresenceReport(
                device_id=dev_id,
                platform="linux",
                connector_version="3.0.0",
                mode_hint=mode,  # type: ignore[arg-type]
                sent_at=utc_now_iso(),
            ),
        )

    # Cross-user open_tunnel rejected
    with pytest.raises(ForbiddenError):
        await app.state.tunnel_service.open_tunnel(
            user_id=bob.id,
            client_id="cli_bob",
            req=OpenTunnelRequest(device_id=norm.device.id),
        )

    # Normal device gets plain tunnel
    plain_resp = await app.state.tunnel_service.open_tunnel(
        user_id=alice.id,
        client_id="cli_1",
        req=OpenTunnelRequest(device_id=norm.device.id),
    )
    assert plain_resp.mode == "normal"
    assert plain_resp.credential.startswith("mtun_")
    assert not plain_resp.credential.startswith("mtun_e2e.")

    # Encrypted device WITHOUT e2e_key or hint refuses downgrade to plain tunnel
    with pytest.raises(ValidationError):
        await app.state.tunnel_service.open_tunnel(
            user_id=alice.id,
            client_id="cli_1",
            req=OpenTunnelRequest(device_id=enc.device.id),
        )

    # Encrypted device WITH client-pinned e2e_key gets mtun_e2e. tunnel
    pinned = "C" * 43
    e2e_resp = await app.state.tunnel_service.open_tunnel(
        user_id=alice.id,
        client_id="cli_1",
        req=OpenTunnelRequest(device_id=enc.device.id, e2e_key=pinned),
    )
    assert e2e_resp.mode == "encrypted"
    assert e2e_resp.credential.startswith("mtun_e2e.")
    assert router_pool.opened_tunnels[-1]["e2e_key"] == pinned

    # Revoke tunnel revokes on Router AND calls DeviceAdmin/close_tunnel_sessions
    rev = await app.state.tunnel_service.revoke_tunnel(
        user_id=alice.id,
        device_id=enc.device.id,
        tunnel_id=e2e_resp.tunnel_id,
        actor=f"user:{alice.id}",
    )
    assert rev.revoked is True
    assert rev.device_notified is True
    assert e2e_resp.tunnel_id in router_pool.revoked_tunnels
    assert any(
        c.service == "aa.v3.DeviceAdmin"
        and c.method == "close_tunnel_sessions"
        and c.payload == {"tunnel_id": e2e_resp.tunnel_id}
        for c in router_pool.calls
    )


async def test_fanout_list_sessions_streams_fast_before_slow_and_marks_encrypted_offline_timeout(
    app,
    router_pool,
) -> None:
    user = await app.state.repo.create_user(email="fan@example.com", password_hash="x", display_name="Fan")

    d_fast = (
        await app.state.device_service.register_device(
            user_id=user.id,
            req=RegisterDeviceRequest(name="Fast", platform="macos", mode_hint="normal"),
            actor=f"user:{user.id}",
        )
    ).device
    d_slow = (
        await app.state.device_service.register_device(
            user_id=user.id,
            req=RegisterDeviceRequest(name="Slow", platform="linux", mode_hint="normal"),
            actor=f"user:{user.id}",
        )
    ).device
    d_offline = (
        await app.state.device_service.register_device(
            user_id=user.id,
            req=RegisterDeviceRequest(name="Offline", platform="linux", mode_hint="normal"),
            actor=f"user:{user.id}",
        )
    ).device
    d_enc = (
        await app.state.device_service.register_device(
            user_id=user.id,
            req=RegisterDeviceRequest(name="Encrypted", platform="macos", mode_hint="encrypted"),
            actor=f"user:{user.id}",
        )
    ).device

    for dev in (d_fast, d_slow, d_enc):
        await app.state.device_service.handle_presence_report(
            authenticated_device_id=dev.id,
            report=PresenceReport(
                device_id=dev.id,
                platform=dev.platform,
                connector_version="3.0.0",
                mode_hint=dev.mode_hint,
                sent_at=utc_now_iso(),
            ),
        )

    async def fast_handler(_method, _payload, meta):
        assert meta["aa-on-behalf-of"] == f"user:{user.id}"
        assert meta["aa-via"] == "client"
        return {
            "sessions": [
                {
                    "id": "s1",
                    "title": "Quick",
                    "agent": "codex",
                    "device_id": d_fast.id,
                    "cwd": "/tmp",
                    "state": "idle",
                    "unread": False,
                    "pinned": False,
                    "updated_at": utc_now_iso(),
                }
            ],
            "projects": ["/tmp"],
        }

    async def slow_handler(_method, _payload, _meta):
        await asyncio.sleep(2.0)  # Exceeds 0.5s test timeout
        return {"sessions": [], "projects": []}

    router_pool.session_handlers[d_fast.id] = fast_handler
    router_pool.session_handlers[d_slow.id] = slow_handler

    streamed = []
    async for item in app.state.fanout_service.list_sessions_stream(
        user_id=user.id,
        req=ListSessionsRequest(),
        via="client",
    ):
        streamed.append(item)

    by_id = {r.device_id: r for r in streamed}
    assert by_id[d_offline.id].status == "offline"
    assert by_id[d_enc.id].status == "encrypted"
    assert by_id[d_fast.id].status == "ok"
    assert len(by_id[d_fast.id].value.sessions) == 1
    assert by_id[d_slow.id].status == "timeout"
    # Fast device must arrive before the slow timed-out device
    order = [r.device_id for r in streamed]
    assert order.index(d_fast.id) < order.index(d_slow.id)
    # Control plane never invoked Sessions/list on encrypted device
    assert all(c.device_id != d_enc.id for c in router_pool.calls)
