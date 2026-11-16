"""E-1 (docs/v3/11-e2ee-noise.md §13) on the Server side, against a real MeshCall Router.

``AGENT_SERVER_E2EE=required``. Random canaries go into everything a user can produce (messages, replies, files,
terminal output, titles, attachments and their names, shares, paths, the client name) and travel the way the
clients send them: content as ciphertext through ``WS /api/v3/tunnel`` -> ``Secure/channel`` -> device, encrypted
attachments as ``x-aa-sealed`` uploads, commands registered by keyed digest. A careless client that still sends
plaintext is refused. Afterwards every place the Server side keeps or sends bytes must have zero hits:

- PostgreSQL: every table;
- Redis: every key (only when ``AGENT_SERVER_TEST_REDIS_URL`` points at an empty logical database);
- object storage: the Server's file root;
- logs: the Server (loguru and stdlib logging) and the Router's stdout/stderr;
- traffic: both directions of Server <-> Router and Router <-> device, recorded by a TCP proxy in front of the
  Router and decoded as WebSocket (masked and deflated frames included); the tunnel frames sent to the client.

Positive controls make sure each scan can see something: plaintext metadata the Server is allowed to keep
(the device name) is found in PostgreSQL, the channel id is found in the Router traffic, and so on.

What this test cannot cover yet: the real device (A's link and the connector-ts channel; the fake device here
echoes ciphertext), the real tunnel WebSocket endpoint and the uvicorn access log (frames are handed to
``TunnelSession`` directly), S3 (``scripts/e2ee_canary_scan.py --files-root`` on a mirrored bucket).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import secrets
import subprocess
import tempfile
import threading
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from device_link_helpers import eventually, server, summary
from loguru import logger
from mesh_fixtures import RouterProcess

from agent_server.core.auth import create_user_access_token
from agent_server.core.e2ee import (
    SEALED_UPLOAD_HEADER,
    SEALED_UPLOAD_VALUE,
    input_digest,
)
from agent_server.services.device_tunnel import TunnelSession
from scripts.e2ee_canary_scan import (
    Hit,
    new_canary,
    scan_bytes,
    scan_postgres,
    scan_redis,
    scan_tree,
    scan_websocket,
)
from scripts.v3_fake_device import connect_device

CLIENT = "cli_" + "c" * 26


# ---------------------------------------------------------------------------
# Router with its logs kept, and a recording proxy in front of it
# ---------------------------------------------------------------------------


class LoggedRouter(RouterProcess):
    """``RouterProcess`` whose stdout/stderr go to a file the test scans."""

    def __init__(self) -> None:
        super().__init__()
        self.log_path = self.dir / "router.log"

    def start(self) -> None:
        log = self.log_path.open("ab")
        self.proc = subprocess.Popen(
            [
                self.binary,
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
                "--auth-file",
                str(self.auth_file),
                "--max-frame-size",
                str(4 * 1024 * 1024),
                "--max-calls-per-connection",
                "0",
            ],
            stdout=log,
            stderr=log,
        )
        log.close()
        deadline = time.monotonic() + 10
        import socket

        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.port), 0.2):
                    return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("MeshCall Router did not start")


class RecordingProxy:
    """TCP proxy on its own thread; keeps every byte per connection and direction."""

    def __init__(self, target_port: int) -> None:
        self.target_port = target_port
        self.port = 0
        self.streams: dict[tuple[int, str], bytearray] = defaultdict(bytearray)
        self._lock = threading.Lock()
        self._loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._server: asyncio.base_events.Server | None = None
        self._next = 0

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    def start(self) -> None:
        self._thread.start()
        if not self._ready.wait(10):
            raise RuntimeError("recording proxy did not start")

    def stop(self) -> None:
        async def close() -> None:
            if self._server is not None:
                self._server.close()

        asyncio.run_coroutine_threadsafe(close(), self._loop).result(5)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(5)

    def captures(self) -> dict[str, bytes]:
        with self._lock:
            return {f"conn{conn}:{direction}": bytes(data) for (conn, direction), data in self.streams.items()}

    def _run(self) -> None:
        asyncio.set_event_loop(self._loop)

        async def serve() -> None:
            self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
            self.port = self._server.sockets[0].getsockname()[1]
            self._ready.set()

        self._loop.run_until_complete(serve())
        self._loop.run_forever()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._next += 1
        conn = self._next
        try:
            up_reader, up_writer = await asyncio.open_connection("127.0.0.1", self.target_port)
        except OSError:
            writer.close()
            return

        async def pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter, direction: str) -> None:
            try:
                while chunk := await src.read(65536):
                    with self._lock:
                        self.streams[(conn, direction)] += chunk
                    dst.write(chunk)
                    await dst.drain()
            except (ConnectionError, OSError):
                pass
            finally:
                dst.close()

        await asyncio.gather(pipe(reader, up_writer, "to-router"), pipe(up_reader, writer, "from-router"))


# ---------------------------------------------------------------------------
# Log capture
# ---------------------------------------------------------------------------


class _ListHandler(logging.Handler):
    def __init__(self, sink: list[str]) -> None:
        super().__init__(logging.DEBUG)
        self.sink = sink

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.sink.append(f"{record.name} {record.getMessage()} {record.args!r}")
        except Exception:  # noqa: BLE001 - a broken record is still scanned by its pieces
            self.sink.append(f"{record.name} {record.msg!r} {record.args!r}")


class LogCapture:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self._handler = _ListHandler(self.lines)
        self._sink_id: int | None = None
        self._previous_level = logging.getLogger().level

    def __enter__(self) -> LogCapture:  # noqa: PYI034
        root = logging.getLogger()
        root.addHandler(self._handler)
        root.setLevel(logging.DEBUG)
        self._sink_id = logger.add(lambda message: self.lines.append(str(message.record)), level="TRACE")
        return self

    def __exit__(self, *exc: object) -> None:
        root = logging.getLogger()
        root.removeHandler(self._handler)
        root.setLevel(self._previous_level)
        if self._sink_id is not None:
            logger.remove(self._sink_id)

    def text(self) -> bytes:
        return "\n".join(self.lines).encode()


# ---------------------------------------------------------------------------
# The client side of the encryption (opaque to the Server, like the real channel)
# ---------------------------------------------------------------------------


class Sealer:
    def __init__(self) -> None:
        self.key = AESGCM.generate_key(bit_length=256)

    def seal(self, value: Any) -> str:
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        nonce = secrets.token_bytes(12)
        return base64.urlsafe_b64encode(nonce + AESGCM(self.key).encrypt(nonce, data, None)).decode().rstrip("=")


def _redis_url() -> str | None:
    return os.environ.get("AGENT_SERVER_TEST_REDIS_URL", "").strip() or None


@pytest.fixture
def canary_env(monkeypatch, tmp_path):
    router = LoggedRouter()
    router.start()
    proxy = RecordingProxy(router.port)
    proxy.start()
    files_root = tmp_path / "files"
    files_root.mkdir()
    monkeypatch.setenv("AGENT_SERVER_E2EE", "required")
    monkeypatch.setenv("AGENT_SERVER_FILES_LOCAL_ROOT", str(files_root))
    redis_url = _redis_url()
    if redis_url:
        from redis import Redis

        sync = Redis.from_url(redis_url)
        if sync.dbsize():
            pytest.fail(f"AGENT_SERVER_TEST_REDIS_URL must point at an empty database ({redis_url})")
        monkeypatch.setenv("AGENT_SERVER_REDIS_URL", redis_url)
    try:
        yield router, proxy, files_root, redis_url
    finally:
        proxy.stop()
        router.stop()
        if redis_url:
            sync.flushdb()
            sync.close()


def _report(hits: list[Hit]) -> str:
    return "\n".join(str(hit) for hit in hits)


def test_required_mode_keeps_every_canary_off_the_server_side(canary_env, monkeypatch) -> None:
    router, proxy, files_root, redis_url = canary_env
    canaries = {
        name: new_canary(name)
        for name in (
            "message",
            "reply",
            "file",
            "terminal",
            "title",
            "attachment",
            "attachmentname",
            "share",
            "path",
            "clientname",
            "plan",
        )
    }
    secret = list(canaries.values())
    control_device = new_canary("controldevice")
    control_channel = new_canary("ctl").lower()[:40]
    sealer = Sealer()
    client_frames: list[dict[str, Any]] = []
    seen: dict[str, str] = {}

    # The Router URL the device is told to use is the proxy, so both Router legs are recorded.
    monkeypatch.setattr(router, "port", proxy.port)

    async def scenario() -> None:
        async with server(router, monkeypatch) as (app, client):
            store = app.state.store
            user = await store.create_user(user_id="user_e1", password="password-e1")
            headers = {"Authorization": f"Bearer {create_user_access_token(user.userId)}"}
            created = await client.post("/api/v2/connectors", headers=headers, json={"name": control_device})
            created.raise_for_status()
            device_id = created.json()["connector"]["id"]
            seen["device_id"] = device_id
            token = created.json()["connectorToken"]
            project = await client.post(
                "/api/v2/projects",
                headers=headers,
                json={"connectorId": device_id, "name": "repo", "workspacePath": "/repo"},
            )
            project.raise_for_status()
            project_id = project.json()["project"]["id"]

            device, welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            assert welcome["e2eeMode"] == "required"
            try:
                # A correct device: the directory entry is sealed; the session is placed by projectId.
                head = summary("sess_e1", 3)
                head["summary"]["projectId"] = project_id
                head["summary"]["displayDevice"] = {
                    "mode": "sealed",
                    "keyId": "dk1",
                    "payload": sealer.seal({"title": canaries["title"], "cwd": "/repo/" + canaries["path"]}),
                }
                item = device.state.push_outbox("session.summary", head)
                await eventually(lambda: _acked(device, item.oid))
                session = await store.get_session("sess_e1")
                assert session.title is None

                # Content through the tunnel: ciphertext only.
                tunnel = TunnelSession(
                    user_id=user.userId,
                    store=store,
                    mesh=app.state.device_mesh,
                    hub=app.state.device_link_hub,
                    send=_collect(client_frames),
                )
                route = {"deviceId": device_id, "clientId": CLIENT, "ch": control_channel}
                payloads = [
                    {"method": "POST", "path": "/api/v2/sessions/sess_e1/runtime/messages",
                     "body": {"content": canaries["message"], "clientMessageId": "m1",
                              "sealedAttachmentKeys": [{"fileId": "f1", "key": "k", "size": 1, "sha256": "0" * 64,
                                                        "name": canaries["attachmentname"]}]}},
                    {"event": "timeline.appended", "text": canaries["reply"]},
                    {"chunk": {"encoding": "base64", "data": base64.b64encode(canaries["file"].encode()).decode()}},
                    {"stream": "terminal", "data": canaries["terminal"]},
                    {"method": "POST", "path": "/api/v2/sessions/sess_e1/shares", "body": {"note": canaries["share"]}},
                    {"method": "PUT", "path": "/api/v2/sessions/sess_e1/plan", "body": {"text": canaries["plan"]}},
                    {"hello": {"clientName": canaries["clientname"]}},
                ]
                try:
                    for n, payload in enumerate(payloads):
                        await tunnel.handle({"t": "tun", "route": route, "n": n, "ct": sealer.seal(payload)})
                    await eventually(lambda: _count(client_frames, len(payloads)))
                    assert all(frame["t"] == "tun" for frame in client_frames)
                finally:
                    await tunnel.close()

                # The command is registered by keyed digest before it goes through the channel.
                digest = input_digest(sealer.key, json.dumps({"content": canaries["message"]}).encode())
                registered = await client.post(
                    "/api/v3/e2ee/commands",
                    headers=headers,
                    json={"commandId": "m1", "deviceId": device_id, "inputDigest": digest},
                )
                assert registered.status_code == 200, registered.text

                # An encrypted attachment: generic name and type, ciphertext body.
                uploaded = await client.post(
                    "/api/v2/sessions/sess_e1/attachments",
                    headers={**headers, SEALED_UPLOAD_HEADER: SEALED_UPLOAD_VALUE},
                    files={"files": ("attachment.bin", sealer.seal(canaries["attachment"].encode() * 64).encode(),
                                     "application/octet-stream")},
                )
                assert uploaded.status_code == 200, uploaded.text

                # The device reports the outcome without content.
                done = device.state.push_outbox(
                    "command.result", {"commandId": "m1", "outcome": "accepted", "r": None, "e": None}
                )
                await eventually(lambda: _acked(device, done.oid))

                # A careless client sending plaintext is refused, and nothing of it is kept.
                refused = [
                    await client.patch("/api/v2/sessions/sess_e1/meta", headers=headers,
                                       json={"title": canaries["title"]}),
                    await client.post("/api/v2/sessions/create-and-start", headers=headers,
                                      json={"connectorId": device_id, "message": canaries["message"]}),
                    await client.post("/api/v2/sessions/sess_e1/runtime/messages", headers=headers,
                                      json={"content": canaries["message"], "clientMessageId": "m2"}),
                    await client.get(f"/api/v2/connectors/{device_id}/fs/read", headers=headers,
                                     params={"root": "/repo", "path": canaries["path"]}),
                    await client.post("/api/v2/runtime-workflows/creations", headers=headers,
                                      json={"connectorId": device_id, "message": canaries["plan"]}),
                ]
                assert [r.status_code for r in refused] == [409] * len(refused)
                assert {r.json()["detail"]["code"] for r in refused} == {"e2ee_required"}
            finally:
                await device.stop()

    with LogCapture() as logs:
        asyncio.run(scenario())

    hits: list[Hit] = []
    db_url = os.environ["AGENT_SERVER_DB_URL"]
    hits += asyncio.run(scan_postgres(db_url, secret))
    stored, scanned_files = scan_tree("files", files_root, secret)
    hits += stored
    hits += scan_bytes("server logs", logs.text(), secret)
    hits += scan_bytes("router log", router.log_path.read_bytes(), secret)
    captures = proxy.captures()
    for name, stream in captures.items():
        hits += scan_websocket(f"router traffic {name}", stream, secret)
    hits += scan_bytes("tunnel frames to the client", json.dumps(client_frames).encode(), secret)
    if redis_url:
        hits += asyncio.run(scan_redis(redis_url, secret))
    assert not hits, "canaries reached the Server side:\n" + _report(hits)

    # Positive controls: each scan sees what it should.
    assert asyncio.run(scan_postgres(db_url, [control_device])), "PostgreSQL scan saw nothing"
    assert scanned_files >= 1, "no attachment reached object storage"
    assert len(captures) >= 4, f"expected both Router legs in both directions, got {sorted(captures)}"
    assert any(
        scan_websocket(name, stream, [control_channel]) for name, stream in captures.items()
    ), "the Router traffic scan did not see the channel id"
    assert logs.lines, "no Server log line was captured"
    if redis_url:
        assert asyncio.run(scan_redis(redis_url, [seen["device_id"]])), "Redis scan saw nothing"


def test_required_mode_places_sessions_without_reading_cwd(canary_env, monkeypatch) -> None:
    """contracts/e2ee/1.0 (会话归属项目): the cwd is sealed, so ``SessionSummary.projectId`` places a new session
    once; a session the device found on its own starts without a project and a client assigns it."""

    router, proxy, _files_root, _redis_url = canary_env
    monkeypatch.setattr(router, "port", proxy.port)
    sealer = Sealer()

    def head(session_id: str, project_id: str | None) -> dict[str, Any]:
        out = summary(session_id, 1)
        out["summary"]["displayDevice"] = {
            "mode": "sealed", "keyId": "dk1", "payload": sealer.seal({"title": "t", "cwd": "/repo"})
        }
        if project_id is not None:
            out["summary"]["projectId"] = project_id
        return out

    async def scenario() -> None:
        async with server(router, monkeypatch) as (app, client):
            store = app.state.store
            user = await store.create_user(user_id="user_e1c", password="password-e1c")
            headers = {"Authorization": f"Bearer {create_user_access_token(user.userId)}"}
            created = await client.post("/api/v2/connectors", headers=headers, json={"name": "laptop"})
            device_id = created.json()["connector"]["id"]
            project = await client.post(
                "/api/v2/projects",
                headers=headers,
                json={"connectorId": device_id, "name": "repo", "workspacePath": "/repo"},
            )
            project.raise_for_status()
            project_id = project.json()["project"]["id"]
            device, _welcome, _access = await connect_device(
                client, connector_id=device_id, connector_token=created.json()["connectorToken"]
            )
            try:
                placed = device.state.push_outbox("session.summary", head("sess_e1c", project_id))
                found = device.state.push_outbox("session.summary", head("sess_e1d", None))
                await eventually(lambda: _acked(device, found.oid))
                assert placed.oid < found.oid
                assert (await store.get_session("sess_e1c")).projectId == project_id
                unplaced = await store.get_session("sess_e1d")
                assert unplaced.projectId is None and unplaced.cwd is None

                # A client that decrypted the cwd assigns the project.
                patched = await client.patch(
                    "/api/v2/sessions/sess_e1d/meta", headers=headers, json={"projectId": project_id}
                )
                assert patched.status_code == 200, patched.text
                assert (await store.get_session("sess_e1d")).projectId == project_id
                # A later summary never moves a session to another project.
                again = device.state.push_outbox("session.summary", head("sess_e1d", "proj_other"))
                await eventually(lambda: _acked(device, again.oid))
                assert (await store.get_session("sess_e1d")).projectId == project_id
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_required_mode_drops_plaintext_a_device_sends(canary_env, monkeypatch) -> None:
    """Defence in depth (§11): a buggy or v2-era device that still sends plaintext must not get it stored."""

    router, proxy, _files_root, _redis_url = canary_env
    title = new_canary("devicetitle")
    result = new_canary("deviceresult")
    monkeypatch.setattr(router, "port", proxy.port)

    async def scenario() -> None:
        async with server(router, monkeypatch) as (app, client):
            store = app.state.store
            user = await store.create_user(user_id="user_e1b", password="password-e1b")
            headers = {"Authorization": f"Bearer {create_user_access_token(user.userId)}"}
            created = await client.post("/api/v2/connectors", headers=headers, json={"name": "laptop"})
            device_id = created.json()["connector"]["id"]
            (await client.post(
                "/api/v2/projects",
                headers=headers,
                json={"connectorId": device_id, "name": "repo", "workspacePath": "/repo"},
            )).raise_for_status()
            device, _welcome, _access = await connect_device(
                client, connector_id=device_id, connector_token=created.json()["connectorToken"]
            )
            try:
                item = device.state.push_outbox("session.summary", summary("sess_e1b", 2, title=title))
                await eventually(lambda: _acked(device, item.oid))
                done = device.state.push_outbox(
                    "command.result",
                    {"commandId": "c1", "outcome": "accepted", "r": {"text": result}, "e": None},
                )
                await eventually(lambda: _acked(device, done.oid))
            finally:
                await device.stop()

    asyncio.run(scenario())
    hits = asyncio.run(scan_postgres(os.environ["AGENT_SERVER_DB_URL"], [title, result]))
    assert not hits, _report(hits)


def _collect(frames: list[dict[str, Any]]):
    async def send(frame: dict[str, Any]) -> None:
        frames.append(frame)

    return send


async def _count(frames: list[dict[str, Any]], n: int) -> bool:
    return len(frames) >= n


async def _acked(device: Any, oid: int) -> bool:
    return device.state.acked_oid >= oid


def test_scan_finds_every_encoding_and_decodes_websocket_frames() -> None:
    import zlib

    canary = new_canary("unit")
    for prefix in (b"", b"x", b"xy"):
        for encode in (base64.b64encode, base64.urlsafe_b64encode):
            blob = b"head " + encode(prefix + canary.encode() + b"tail") + b" end"
            assert scan_bytes("b64", blob, [canary]), (prefix, encode)
    assert scan_bytes("hex", canary.encode().hex().encode(), [canary])
    assert scan_bytes("utf16", canary.encode("utf-16le"), [canary])
    assert not scan_bytes("other", new_canary("unit").encode(), [canary])

    # A masked, deflated client frame split in two fragments.
    deflater = zlib.compressobj(wbits=-15)
    body = deflater.compress(json.dumps({"text": canary}).encode()) + deflater.flush(zlib.Z_SYNC_FLUSH)
    body = body[:-4]
    mask = b"\x01\x02\x03\x04"

    def frame(first: bool, fin: bool, chunk: bytes) -> bytes:
        b0 = (0x80 if fin else 0) | ((0x40 | 0x2) if first else 0x0)
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(chunk))
        return bytes([b0, 0x80 | len(chunk)]) + mask + masked

    half = len(body) // 2
    stream = b"GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n" + frame(True, False, body[:half]) + frame(
        False, True, body[half:]
    )
    assert not scan_bytes("raw", stream, [canary])
    assert scan_websocket("ws", stream, [canary])

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "a").mkdir()
        (root / "a" / canary).write_bytes(b"x")
        hits, count = scan_tree("files", root, [canary])
        assert count == 1 and hits
