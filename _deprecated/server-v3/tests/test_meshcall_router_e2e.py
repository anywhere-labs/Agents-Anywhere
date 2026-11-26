import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path

import fakeredis.aioredis
import httpx
import pytest
from meshcall import (
    E2EIdentity,
    E2EPairing,
    E2EPeer,
    LocalRouter,
    Mesh,
    Router,
    RpcContext,
    generate_e2e_key,
    generate_e2e_psk,
    method,
    service,
)
from meshcall.errors import PermissionDeniedError, UnauthenticatedError
from meshcall.router_install import find_router_binary

from aa_control.app import create_app
from aa_control.core.config import ControlSettings, RouterEndpoint
from aa_control.core.models import (
    DeviceAdminPingResponse,
    EmptyRequest,
    ListDevicesResponse,
    ListSessionsOnceResponse,
    ListSessionsRequest,
    NormalDeviceSummary,
    OpenTunnelRequest,
    OpenTunnelResponse,
    PresenceAck,
    PresenceReport,
    SessionListPayload,
    SessionSummary,
)
from aa_control.core.utc import utc_now_iso
from aa_control.infra.db.engine import create_engine
from aa_control.infra.db.schema import metadata

CONTROL_PASSWORD = "control-e2e-test-password"


def _find_router_bin() -> str | None:
    env = os.environ.get("MESHCALL_ROUTER_BINARY")
    if env and Path(env).is_file():
        return env
    sibling = Path(__file__).parents[3] / "meshcall" / "meshcall-router" / "bin" / "meshcall-router"
    if sibling.is_file():
        return str(sibling)
    try:
        return find_router_binary(None)
    except Exception:  # noqa: BLE001
        return None


def _write_control_auth_file(path: Path) -> Path:
    salt = b"aa-v3-control-01"
    key = hashlib.pbkdf2_hmac("sha256", CONTROL_PASSWORD.encode(), salt, 600000)
    pw_hash = f"pbkdf2-sha256$600000${salt.hex()}${key.hex()}"
    path.write_text(
        json.dumps(
            {
                "users": [
                    {
                        "username": "control",
                        "password_hash": pw_hash,
                        "roles": ["client", "server"],
                        "register": [
                            "aa.v3.Control",
                            "aa.v3.Sessions",
                            "aa.v3.Terminals",
                            "aa.v3.Device",
                            "aa.v3.DeviceAdmin",
                        ],
                        "call": [
                            "aa.v3.Control/*",
                            "aa.v3.Sessions/*",
                            "aa.v3.Terminals/*",
                            "aa.v3.Device/*",
                            "aa.v3.DeviceAdmin/*",
                            "meshcall.router.v1.AuthService/*",
                            "meshcall.router.v1.TunnelService/*",
                            "meshcall.router.v1.Registry/*",
                        ],
                    }
                ]
            }
        )
    )
    return path


@service(name="aa.v3.Sessions", targeted=True)
class MockDeviceSessions:
    """Mock Connector sessions service for real Router E2E testing."""

    def __init__(self, device_id: str, title: str) -> None:
        self._device_id = device_id
        self._title = title
        self.seen_metadata: list[dict[str, str]] = []

    @method(read_only=True)
    async def list(self, ctx: RpcContext, limit: int | None = None) -> SessionListPayload:
        """Return mock sessions on this device."""
        self.seen_metadata.append(dict(ctx.metadata))
        return SessionListPayload(
            sessions=[
                SessionSummary(
                    id=f"sess_{self._device_id}",
                    title=self._title,
                    agent="codex",
                    device_id=self._device_id,
                    cwd="/workspace",
                    state="idle",
                    unread=False,
                    pinned=False,
                    updated_at=utc_now_iso(),
                )
            ],
            projects=["/workspace"],
        )


@service(name="aa.v3.DeviceAdmin", targeted=True)
class MockDeviceAdmin:
    """Mock Connector DeviceAdmin service for real Router E2E testing."""

    @method(read_only=True)
    async def ping(self, ctx: RpcContext) -> DeviceAdminPingResponse:
        """Respond to control-plane ping."""
        return DeviceAdminPingResponse(ok=True, server_time=utc_now_iso())


async def test_real_meshcall_router_control_plane_fanout_and_e2e_tunnel(tmp_path: Path) -> None:
    router_bin = _find_router_bin()
    if router_bin is None:
        pytest.skip("meshcall-router binary not available")

    auth_file = _write_control_auth_file(tmp_path / "router-auth.json")
    engine = create_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(metadata.create_all)
    redis = fakeredis.aioredis.FakeRedis(server=fakeredis.FakeServer())

    try:
        async with LocalRouter(port=0, auth_file=auth_file, binary_path=router_bin) as router:
            endpoint = RouterEndpoint(
                id="router-local",
                url=router.url,
                public_url=router.url,
                username="control",
                password=CONTROL_PASSWORD,
            )
            cfg = ControlSettings(
                database_url="sqlite+aiosqlite:///:memory:",
                redis_url="redis://localhost:6379/0",
                secret_key="e2e-test-secret",
                public_origin="http://127.0.0.1:8080",
                routers=(endpoint,),
                password_iterations=1_000,
                fanout_timeout_seconds=3.0,
            )
            app = create_app(
                settings=cfg,
                engine=engine,
                redis_client=redis,
                start_push_worker=False,
            )

            async with app.router.lifespan_context(app):
                # Give control service registration a brief moment on Router
                await asyncio.sleep(0.15)
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8080") as api:
                    # 1. Register user + obtain client Router mt_ token
                    reg = (
                        await api.post(
                            "/auth/register",
                            json={"email": "e2e@example.com", "password": "password123", "display_name": "E2E"},
                        )
                    ).json()
                    user_headers = {"Authorization": f"Bearer {reg['access_token']}"}
                    client_tok = (
                        await api.post(
                            "/auth/router-token",
                            headers=user_headers,
                            json={"client_id": "cli_e2e_1", "platform": "desktop"},
                        )
                    ).json()["tokens"][0]["token"]

                    # 2. Register one normal device and one encrypted device
                    norm_reg = (
                        await api.post(
                            "/devices/register",
                            headers=user_headers,
                            json={"name": "NormalMac", "platform": "macos", "mode_hint": "normal"},
                        )
                    ).json()
                    norm_id = norm_reg["device"]["id"]
                    norm_tok = (
                        await api.post(
                            "/devices/router-token",
                            json={"device_id": norm_id, "device_secret": norm_reg["device_secret"]},
                        )
                    ).json()["tokens"][0]["token"]

                    dev_keys = generate_e2e_key()
                    enc_reg = (
                        await api.post(
                            "/devices/register",
                            headers=user_headers,
                            json={
                                "name": "EncryptedWorkstation",
                                "platform": "linux",
                                "mode_hint": "encrypted",
                                "e2e_public_key_hint": dev_keys.public_key,
                            },
                        )
                    ).json()
                    enc_id = enc_reg["device"]["id"]
                    enc_tok = (
                        await api.post(
                            "/devices/router-token",
                            json={"device_id": enc_id, "device_secret": enc_reg["device_secret"]},
                        )
                    ).json()["tokens"][0]["token"]

                    # 3. Verify HTTP mapping to aa.v3.Control with real meshcall-token-principal
                    async with httpx.AsyncClient() as http_router:
                        http_resp = await http_router.post(
                            f"{router.http_url}/v1/call/aa.v3.Control/list_devices",
                            headers={"Authorization": f"Bearer {client_tok}"},
                            json={},
                        )
                    assert http_resp.status_code == 200
                    assert len(http_resp.json()["devices"]) == 2

                    # 4. Bring both mock Connectors online on the real Router
                    norm_sessions = MockDeviceSessions(norm_id, "Normal Session")
                    enc_sessions = MockDeviceSessions(enc_id, "Top Secret Session")
                    paired_keys: set[str] = set()
                    pairings: dict[str, str] = {"pair-01": generate_e2e_psk()}

                    async def authorize_peer(peer: E2EPeer) -> bool:
                        assert peer.peer_key is not None
                        if peer.pairing_id is not None:
                            if pairings.pop(peer.pairing_id, None) is None:
                                return False
                            paired_keys.add(peer.peer_key)
                            return True
                        return peer.peer_key in paired_keys

                    norm_mesh = (
                        Mesh(Router(router.url), token=norm_tok)
                        .mount(norm_sessions, instance_id=norm_id, accept_tunnels=True)
                        .mount(MockDeviceAdmin(), instance_id=norm_id)
                    )
                    enc_mesh = (
                        Mesh(Router(router.url), token=enc_tok)
                        .mount(
                            enc_sessions,
                            instance_id=enc_id,
                            accept_tunnels=True,
                            e2e_private_key=dev_keys.private_key,
                            require_e2e_peer=True,
                            authorize_e2e_peer=authorize_peer,
                            e2e_pairing_psk=lambda pid: pairings.get(pid),
                        )
                        .mount(MockDeviceAdmin(), instance_id=enc_id)
                    )

                    async with contextlib.AsyncExitStack() as stack:
                        await stack.enter_async_context(norm_mesh.serve(access_log=False))
                        await stack.enter_async_context(enc_mesh.serve(access_log=False))
                        norm_presence_client = await stack.enter_async_context(
                            Mesh(Router(router.url), token=norm_tok)
                        )
                        enc_presence_client = await stack.enter_async_context(
                            Mesh(Router(router.url), token=enc_tok)
                        )

                        # Keep live presence client streams open while testing
                        norm_stop = asyncio.Event()
                        enc_stop = asyncio.Event()

                        async def stream_presence(mesh_cli: Mesh, report: PresenceReport, stop: asyncio.Event):
                            async def gen():
                                yield report
                                await stop.wait()

                            return await mesh_cli.call_client_stream(
                                "aa.v3.Control",
                                "presence",
                                EmptyRequest(),
                                gen(),
                                PresenceReport,
                                PresenceAck,
                            )

                        t_norm = asyncio.create_task(
                            stream_presence(
                                norm_presence_client,
                                PresenceReport(
                                    device_id=norm_id,
                                    platform="macos",
                                    connector_version="3.0.0",
                                    mode_hint="normal",
                                    sent_at=utc_now_iso(),
                                    summary=NormalDeviceSummary(runtimes=["codex"], active_sessions=1, pending_approvals=0),
                                ),
                                norm_stop,
                            )
                        )
                        t_enc = asyncio.create_task(
                            stream_presence(
                                enc_presence_client,
                                PresenceReport(
                                    device_id=enc_id,
                                    platform="linux",
                                    connector_version="3.0.0",
                                    mode_hint="encrypted",
                                    sent_at=utc_now_iso(),
                                    e2e_public_key_hint=dev_keys.public_key,
                                ),
                                enc_stop,
                            )
                        )
                        await asyncio.sleep(0.25)

                        # 5. Client calls aa.v3.Control over WebSocket using mt_ token
                        async with Mesh(Router(router.url), token=client_tok) as client_mesh:
                            devs = await client_mesh.call_unary(
                                "aa.v3.Control", "list_devices", EmptyRequest(), ListDevicesResponse
                            )
                            by_id = {d.id: d for d in devs.devices}
                            assert by_id[norm_id].presence == "online"
                            assert by_id[enc_id].presence == "online"
                            assert by_id[enc_id].summary is None

                            # Fanout list_sessions_once hits normal device over Router, marks encrypted as placeholder
                            listed = await client_mesh.call_unary(
                                "aa.v3.Control",
                                "list_sessions_once",
                                ListSessionsRequest(),
                                ListSessionsOnceResponse,
                            )
                            res_map = {r.device_id: r for r in listed.results}
                            assert res_map[norm_id].status == "ok"
                            assert res_map[norm_id].value.sessions[0].title == "Normal Session"
                            assert norm_sessions.seen_metadata[-1]["aa-via"] == "client"
                            assert res_map[enc_id].status == "encrypted"
                            assert len(enc_sessions.seen_metadata) == 0

                            # Control plane direct call to encrypted device is refused by device gate
                            with pytest.raises(PermissionDeniedError):
                                await app.state.router_pool.call_device_sessions(
                                    device_id=enc_id,
                                    method="list",
                                    payload={},
                                    on_behalf_of=f"user:{reg['user']['id']}",
                                    via="mcp",
                                )

                            # Open real E2E tunnel via aa.v3.Control/open_tunnel
                            opened = await client_mesh.call_unary(
                                "aa.v3.Control",
                                "open_tunnel",
                                OpenTunnelRequest(device_id=enc_id, e2e_key=dev_keys.public_key),
                                OpenTunnelResponse,
                            )
                            assert opened.mode == "encrypted"
                            assert opened.credential.startswith("mtun_e2e.")

                            # Unpaired stranger is rejected by device gate during Noise_IK handshake
                            stranger_keys = generate_e2e_key()
                            with pytest.raises(UnauthenticatedError):
                                async with Mesh(
                                    Router(opened.router_url),
                                    tunnel=opened.credential,
                                    e2e_key=dev_keys.public_key,
                                    e2e_identity=E2EIdentity(stranger_keys.private_key, enc_id),
                                ) as stranger_mesh:
                                    await stranger_mesh.call_unary(
                                        "aa.v3.Sessions", "list", EmptyRequest(), SessionListPayload
                                    )

                            # Legitimate client pairs with QR PSK (Noise_IKpsk2), then calls encrypted device!
                            client_keys = generate_e2e_key()
                            pairing_identity = E2EIdentity(
                                client_keys.private_key,
                                enc_id,
                                pairing=E2EPairing(id="pair-01", psk=pairings["pair-01"]),
                            )
                            async with Mesh(
                                Router(opened.router_url),
                                tunnel=opened.credential,
                                e2e_key=dev_keys.public_key,
                                e2e_identity=pairing_identity,
                            ) as paired_mesh:
                                secret_list = await paired_mesh.call_unary(
                                    "aa.v3.Sessions", "list", EmptyRequest(), SessionListPayload
                                )
                                assert secret_list.sessions[0].title == "Top Secret Session"

                            # Subsequent connection uses Noise_IK without PSK
                            async with Mesh(
                                Router(opened.router_url),
                                tunnel=opened.credential,
                                e2e_key=dev_keys.public_key,
                                e2e_identity=E2EIdentity(client_keys.private_key, enc_id),
                            ) as ik_mesh:
                                secret_list2 = await ik_mesh.call_unary(
                                    "aa.v3.Sessions", "list", EmptyRequest(), SessionListPayload
                                )
                                assert secret_list2.sessions[0].title == "Top Secret Session"

                        norm_stop.set()
                        enc_stop.set()
                        await asyncio.gather(t_norm, t_enc)
    finally:
        await redis.aclose()
        await engine.dispose()
