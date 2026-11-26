from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import socket
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import jwt
import pytest
import uvicorn
from alembic import command as alembic_command
from alembic.config import Config as AlembicConfig
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import create_engine as create_sync_engine
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import text, update

from aa_control.app import create_app
from aa_control.core.assistant import hash_tokens_key
from aa_control.core.auth import create_access_token
from aa_control.core.config import (
    AssistantConfig,
    ControlSettings,
    OidcAuthConfig,
    TokensAnywhereConfig,
)
from aa_control.core.models import PresignedHttpTarget
from aa_control.core.oidc import VerifiedOidcIdentity
from aa_control.infra.db import schema
from aa_control.infra.db.engine import create_engine
from aa_control.infra.object_store import StoredObjectMeta
from aa_control.infra.tokens_client import HttpTokensAnywhereClient, TokensRefreshResult
from tests.conftest import FakeRouterPool, RecordingPushProvider

SAMPLE_MESSAGES = [
    {
        "role": "user",
        "content": [
            {"type": "image", "data": "iVBORw0K", "mimeType": "image/png"},
            {"type": "text", "text": "帮我看一下这张图"},
        ],
        "timestamp": 1001,
    },
    {
        "role": "assistant",
        "content": [{"type": "text", "text": "这是一张测试图片。"}],
        "timestamp": 1002,
    },
]


@dataclass
class FakeTokensClient:
    calls: list[tuple[str, str]] = field(default_factory=list)
    next_refresh_result: TokensRefreshResult = field(
        default_factory=lambda: TokensRefreshResult(
            status="refreshed",
            refresh_token="ta_rt_rotated",
            access_token="ta_at_new",
        )
    )
    refresh_delay_seconds: float = 0.0

    async def refresh_token(self, *, refresh_token: str) -> TokensRefreshResult:
        self.calls.append(("refresh", refresh_token))
        if self.refresh_delay_seconds > 0:
            await asyncio.sleep(self.refresh_delay_seconds)
        return self.next_refresh_result

    async def revoke_token(self, *, token: str) -> bool:
        self.calls.append(("revoke", token))
        return True

    async def close(self) -> None:
        return None


class FakeObjectStore:
    def __init__(self) -> None:
        self.deleted_keys: list[str] = []

    def build_object_key(self, *, user_id: str, purpose: str, file_id: str) -> str:
        return f"aa-drive/{user_id}/{purpose}/{file_id}"

    async def presign_upload(
        self,
        *,
        object_key: str,
        size_bytes: int,
        content_type: str | None,
        expires_seconds: int,
    ) -> PresignedHttpTarget:
        return PresignedHttpTarget(
            method="PUT",
            url=f"https://s3.example.test/{object_key}",
            headers={"Content-Length": str(size_bytes)},
            expires_at="2099-01-01T00:00:00Z",
        )

    async def presign_download(
        self,
        *,
        object_key: str,
        filename: str | None,
        content_type: str | None,
        expires_seconds: int,
    ) -> PresignedHttpTarget:
        return PresignedHttpTarget(
            method="GET",
            url=f"https://s3.example.test/{object_key}",
            headers={},
            expires_at="2099-01-01T00:00:00Z",
        )

    async def head_object(self, object_key: str) -> StoredObjectMeta | None:
        return StoredObjectMeta(size_bytes=128, etag='"etag1"')

    async def delete_object(self, object_key: str) -> bool:
        self.deleted_keys.append(object_key)
        return True

    async def close(self) -> None:
        return None


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _unb64(val: str) -> bytes:
    padding = "=" * (-len(val) % 4)
    return base64.urlsafe_b64decode(val + padding)


def _derive_kek_pbkdf2(password: str, salt_b64: str, iterations: int = 10_000) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), _unb64(salt_b64), iterations, dklen=32)


def _wrap_dek(password: str, dek: bytes, *, iterations: int = 10_000) -> dict[str, Any]:
    salt_b64 = _b64(os.urandom(16))
    kek = _derive_kek_pbkdf2(password, salt_b64, iterations=iterations)
    nonce = os.urandom(12)
    wrapped = AESGCM(kek).encrypt(nonce, dek, None)
    return {
        "kdf": "pbkdf2-sha256",
        "kdf_params": {"iterations": iterations, "hash": "SHA-256"},
        "salt": salt_b64,
        "wrap_alg": "AES-256-GCM",
        "wrap_nonce": _b64(nonce),
        "wrapped_dek": _b64(wrapped),
    }


def _unwrap_dek(password: str, envelope: dict[str, Any]) -> bytes:
    kek = _derive_kek_pbkdf2(
        password,
        envelope["salt"],
        iterations=int(envelope["kdf_params"]["iterations"]),
    )
    return AESGCM(kek).decrypt(_unb64(envelope["wrap_nonce"]), _unb64(envelope["wrapped_dek"]), None)


async def _register_user(client: httpx.AsyncClient, email: str, name: str = "User") -> tuple[str, dict[str, str]]:
    resp = await client.post(
        "/auth/register",
        json={"email": email, "password": "password1234", "display_name": name},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    return body["user"]["id"], {"Authorization": f"Bearer {body['access_token']}"}


def _plain_conv_body(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "title": "看看这张图",
        "updated_at": 1000,
        "hash": "h1",
        "device": "tab_a",
        "messages": SAMPLE_MESSAGES,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# 1. Whole-conversation sync, eviction, isolation, and Redis Pub/Sub / SSE
# ---------------------------------------------------------------------------


async def test_conversation_sync_crud_isolation_limits_and_eviction(
    db_engine,
    redis_client,
    router_pool: FakeRouterPool,
    push_provider: RecordingPushProvider,
) -> None:
    cfg = ControlSettings(
        database_url="sqlite+aiosqlite:///:memory:",
        redis_url="redis://localhost:6379/0",
        secret_key="assistant-sync-test-secret",
        public_origin="https://aa.example.test",
        password_iterations=1_000,
        assistant=AssistantConfig(
            max_conversation_bytes=4096,
            max_conversations=3,
            sse_heartbeat_seconds=0.1,
        ),
    )
    fake_tokens = FakeTokensClient()
    app = create_app(
        settings=cfg,
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        tokens_client=fake_tokens,
        start_push_worker=False,
    )

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://aa.example.test") as client:
        _uid_a, hdr_a = await _register_user(client, "alice@example.com", "Alice")
        _uid_b, hdr_b = await _register_user(client, "bob@example.com", "Bob")

        # Empty list
        r = await client.get("/assistant/conversations", headers=hdr_a)
        assert r.status_code == 200
        assert r.json() == {
            "conversations": [],
            "max_conversations": 3,
            "max_conversation_bytes": 4096,
        }

        # PUT + GET list (newest first, no messages) + GET detail (with images & settings)
        r1 = await client.put("/assistant/conversations/c1", json=_plain_conv_body(), headers=hdr_a)
        assert r1.status_code == 200, r1.text
        meta1 = r1.json()
        assert meta1["id"] == "c1" and meta1["hash"] == "h1" and meta1["size"] > 0 and meta1["encrypted"] is False

        r2 = await client.put(
            "/assistant/conversations/c2",
            json=_plain_conv_body(title="第二个", updated_at=2000, hash="h2"),
            headers=hdr_a,
        )
        assert r2.status_code == 200

        listed = (await client.get("/assistant/conversations", headers=hdr_a)).json()["conversations"]
        assert [c["id"] for c in listed] == ["c2", "c1"]
        assert "messages" not in listed[0] and "ciphertext" not in listed[0]

        got = (await client.get("/assistant/conversations/c1", headers=hdr_a)).json()
        assert got["messages"] == SAMPLE_MESSAGES
        assert got["settings"] is None
        assert got["device"] == "tab_a"

        # Upload with settings, then overwrite with an OLDER updated_at: server does NOT judge newer/older
        conv_settings = {"model": "claude-sonnet-4-5", "format": "anthropic-messages", "thinking": "high"}
        await client.put(
            "/assistant/conversations/c1",
            json=_plain_conv_body(settings=conv_settings),
            headers=hdr_a,
        )
        assert (await client.get("/assistant/conversations/c1", headers=hdr_a)).json()["settings"] == conv_settings

        await client.put(
            "/assistant/conversations/c1",
            json=_plain_conv_body(updated_at=500, hash="h0", messages=SAMPLE_MESSAGES[:1], device="tab_b"),
            headers=hdr_a,
        )
        got_after = (await client.get("/assistant/conversations/c1", headers=hdr_a)).json()
        assert got_after["hash"] == "h0" and got_after["updated_at"] == 500
        assert got_after["messages"] == SAMPLE_MESSAGES[:1] and got_after["device"] == "tab_b"

        # Strict per-user isolation: Bob sees nothing and can reuse id 'c1' independently
        assert (await client.get("/assistant/conversations", headers=hdr_b)).json()["conversations"] == []
        assert (await client.get("/assistant/conversations/c1", headers=hdr_b)).status_code == 404
        assert (
            await client.put(
                "/assistant/conversations/c1",
                json=_plain_conv_body(title="Bob's conv"),
                headers=hdr_b,
            )
        ).status_code == 200
        assert (await client.get("/assistant/conversations/c1", headers=hdr_a)).json()["title"] == "看看这张图"
        assert (await client.delete("/assistant/conversations/c1", headers=hdr_b)).status_code == 200
        assert (await client.get("/assistant/conversations/c1", headers=hdr_a)).status_code == 200

        # Invalid conversation_id rejected (422) and oversized conversation rejected (413)
        assert (await client.put("/assistant/conversations/bad.id", json=_plain_conv_body(), headers=hdr_a)).status_code == 422
        oversized = _plain_conv_body(messages=[{"role": "user", "content": "x" * 5000}])
        r_big = await client.put("/assistant/conversations/c_big", json=oversized, headers=hdr_a)
        assert r_big.status_code == 413
        assert r_big.json()["code"] == "payload_too_large"

        # Auto-eviction keeps newest max_conversations (= 3)
        await client.put("/assistant/conversations/c3", json=_plain_conv_body(updated_at=3000, hash="h3"), headers=hdr_a)
        await client.put("/assistant/conversations/c4", json=_plain_conv_body(updated_at=4000, hash="h4"), headers=hdr_a)
        remaining = [c["id"] for c in (await client.get("/assistant/conversations", headers=hdr_a)).json()["conversations"]]
        assert remaining == ["c4", "c3", "c2"]  # c1 (updated_at=500) evicted
        assert (await client.get("/assistant/conversations/c1", headers=hdr_a)).status_code == 404

        # DELETE removes & is idempotent
        assert (await client.delete("/assistant/conversations/c2?device=tab_b", headers=hdr_a)).status_code == 200
        assert (await client.get("/assistant/conversations/c2", headers=hdr_a)).status_code == 404
        assert (await client.delete("/assistant/conversations/c2", headers=hdr_a)).status_code == 200


async def test_redis_pubsub_and_sse_events_isolated_per_user(
    app,
    http_client: httpx.AsyncClient,
) -> None:
    uid_a, hdr_a = await _register_user(http_client, "sse-a@example.com", "Alice")
    uid_b, hdr_b = await _register_user(http_client, "sse-b@example.com", "Bob")

    assistant_svc = app.state.assistant_service

    # Subscribe both users BEFORE publishing (verifies zero missed events & strict isolation)
    async with assistant_svc.open_events(uid_a) as sub_a, assistant_svc.open_events(uid_b) as sub_b:
        await http_client.put(
            "/assistant/conversations/c1",
            json=_plain_conv_body(title="同步测试", hash="h1", device="tab_1"),
            headers=hdr_a,
        )
        await http_client.put(
            "/assistant/conversations/c9",
            json=_plain_conv_body(title="Bob私密", hash="hb", device="tab_b"),
            headers=hdr_b,
        )
        await http_client.delete("/assistant/conversations/c1?device=tab_2", headers=hdr_a)

        ev_a1 = await sub_a.next_event(timeout=1.0)
        ev_a2 = await sub_a.next_event(timeout=1.0)
        ev_b1 = await sub_b.next_event(timeout=1.0)

        assert ev_a1 is not None and ev_a1.event == "assistant"
        assert ev_a1.payload["id"] == "c1"
        assert ev_a1.payload["title"] == "同步测试"
        assert ev_a1.payload["hash"] == "h1"
        assert ev_a1.payload["device"] == "tab_1"
        assert ev_a1.payload["deleted"] is False

        assert ev_a2 is not None and ev_a2.event == "assistant"
        assert ev_a2.payload["id"] == "c1"
        assert ev_a2.payload["hash"] is None
        assert ev_a2.payload["device"] == "tab_2"
        assert ev_a2.payload["deleted"] is True

        # Bob ONLY saw his own conversation, NEVER Alice's
        assert ev_b1 is not None and ev_b1.payload["id"] == "c9" and ev_b1.payload["title"] == "Bob私密"
        assert await sub_b.next_event(timeout=0.05) is None

    # Verify REAL HTTP SSE endpoint framing over a live TCP socket (ASGITransport buffers infinite streams)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    server_task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)

    received_lines: list[str] = []
    connected_ev = asyncio.Event()
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=5.0) as live_client:

            async def _read_sse() -> None:
                async with live_client.stream("GET", "/assistant/events", headers=hdr_a) as resp:
                    assert resp.status_code == 200
                    assert resp.headers["content-type"].startswith("text/event-stream")
                    async for line in resp.aiter_lines():
                        received_lines.append(line)
                        if line == ": connected":
                            connected_ev.set()
                        if line.startswith("data:"):
                            break

            sse_task = asyncio.create_task(_read_sse())
            await asyncio.wait_for(connected_ev.wait(), timeout=2.0)

            await live_client.put(
                "/assistant/conversations/sse_c1",
                json=_plain_conv_body(title="SSE实时", hash="hsse", device="tab_x"),
                headers=hdr_a,
            )
            await asyncio.wait_for(sse_task, timeout=3.0)
    finally:
        server.should_exit = True
        await asyncio.wait_for(server_task, timeout=3.0)

    assert ": connected" in received_lines
    assert "event: assistant" in received_lines
    data_line = next(line for line in received_lines if line.startswith("data:"))
    payload = json.loads(data_line.removeprefix("data:").strip())
    assert payload["id"] == "sse_c1" and payload["hash"] == "hsse" and payload["deleted"] is False


# ---------------------------------------------------------------------------
# 2. Account-level KEK/DEK key envelope & E2EE whole-conversation encryption
# ---------------------------------------------------------------------------


async def test_kek_dek_envelope_multi_device_e2ee_rotate_and_reset(
    db_engine,
    redis_client,
    router_pool: FakeRouterPool,
    push_provider: RecordingPushProvider,
) -> None:
    fake_s3 = FakeObjectStore()
    cfg = ControlSettings(
        database_url="sqlite+aiosqlite:///:memory:",
        redis_url="redis://localhost:6379/0",
        secret_key="e2ee-test-secret",
        public_origin="https://aa.example.test",
        password_iterations=1_000,
    )
    app = create_app(
        settings=cfg,
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        object_store=fake_s3,
        tokens_client=FakeTokensClient(),
        start_push_worker=False,
        start_drive_cleanup_worker=False,
    )

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://aa.example.test") as client:
        uid, hdr = await _register_user(client, "e2ee@example.com", "CryptoUser")

        # Initially encryption disabled; encrypted conversation upload rejected
        status0 = (await client.get("/assistant/encryption", headers=hdr)).json()
        assert status0 == {"enabled": False, "envelope": None}
        r_no_env = await client.put(
            "/assistant/conversations/c_enc",
            json={
                "encrypted": True,
                "updated_at": 1000,
                "hash": "he1",
                "device": "dev1",
                "key_version": 1,
                "nonce": _b64(os.urandom(12)),
                "ciphertext": _b64(b"0" * 32),
            },
            headers=hdr,
        )
        assert r_no_env.status_code == 422 and r_no_env.json()["code"] == "encryption_not_enabled"

        # Guardrail: forbidden secret fields in kdf_params rejected
        bad_env = _wrap_dek("1234", os.urandom(32))
        bad_env["kdf_params"]["password"] = "1234"
        assert (await client.put("/assistant/encryption", json=bad_env, headers=hdr)).status_code == 422

        # Device 1 enables encryption with an arbitrary short password ("1234") & random 256-bit DEK
        dek_v1 = os.urandom(32)
        env_req_1 = _wrap_dek("1234", dek_v1)
        r_enable = await client.put(
            "/assistant/encryption",
            json={**env_req_1, "expected_version": 0, "device": "iphone"},
            headers=hdr,
        )
        assert r_enable.status_code == 200, r_enable.text
        env1 = r_enable.json()["envelope"]
        assert env1["key_version"] == 1 and env1["dek_epoch"] == 1

        # Concurrent second enable without expected_version -> 409 Conflict (never silently overwrite DEK!)
        r_dup = await client.put("/assistant/encryption", json=_wrap_dek("9999", os.urandom(32)), headers=hdr)
        assert r_dup.status_code == 409 and r_dup.json()["code"] == "key_version_conflict"

        # Device 2 fetches envelope, unwraps identical DEK with "1234", fails with wrong password
        fetched_env = (await client.get("/assistant/encryption", headers=hdr)).json()["envelope"]
        assert _unwrap_dek("1234", fetched_env) == dek_v1
        with pytest.raises(InvalidTag):
            _unwrap_dek("wrong-pin", fetched_env)

        # Encrypt entire conversation (title + settings + messages) with AAD = user_id:conversation_id
        secret_title = "机密项目规划"
        conv_plain = {"title": secret_title, "settings": {"model": "claude"}, "messages": SAMPLE_MESSAGES}
        conv_nonce = os.urandom(12)
        aad = f"{uid}:conv_secret_1".encode()
        ciphertext = AESGCM(dek_v1).encrypt(conv_nonce, json.dumps(conv_plain).encode("utf-8"), aad)
        meta_nonce = os.urandom(12)
        meta_cipher = AESGCM(dek_v1).encrypt(meta_nonce, json.dumps({"title": secret_title}).encode("utf-8"), aad)

        # Guardrail 1: plaintext upload rejected once encryption is enabled (409 encryption_required)
        r_plain_blocked = await client.put(
            "/assistant/conversations/conv_plain",
            json=_plain_conv_body(),
            headers=hdr,
        )
        assert r_plain_blocked.status_code == 409 and r_plain_blocked.json()["code"] == "encryption_required"

        # Guardrail 2: encrypted upload carrying plaintext title/messages rejected (422)
        r_mixed = await client.put(
            "/assistant/conversations/conv_secret_1",
            json={
                "encrypted": True,
                "title": secret_title,
                "updated_at": 2000,
                "hash": "he1",
                "device": "iphone",
                "key_version": 1,
                "nonce": _b64(conv_nonce),
                "ciphertext": _b64(ciphertext),
            },
            headers=hdr,
        )
        assert r_mixed.status_code == 422 and r_mixed.json()["code"] == "plaintext_not_allowed"

        # Valid E2EE conversation upload succeeds and leaks ZERO plaintext in list or DB
        r_put_enc = await client.put(
            "/assistant/conversations/conv_secret_1",
            json={
                "encrypted": True,
                "updated_at": 2000,
                "hash": "he1",
                "device": "iphone",
                "key_version": 1,
                "dek_epoch": 1,
                "nonce": _b64(conv_nonce),
                "ciphertext": _b64(ciphertext),
                "encrypted_meta": _b64(meta_cipher),
                "meta_nonce": _b64(meta_nonce),
            },
            headers=hdr,
        )
        assert r_put_enc.status_code == 200, r_put_enc.text
        assert secret_title not in r_put_enc.text

        listed = (await client.get("/assistant/conversations", headers=hdr)).json()["conversations"]
        assert len(listed) == 1 and listed[0]["encrypted"] is True and listed[0]["title"] is None
        assert listed[0]["encrypted_meta"] == _b64(meta_cipher)
        assert secret_title not in json.dumps(listed, ensure_ascii=False)

        # Also create an account_dek encrypted VFS file in Drive so we test reset cleanup integration!
        sha = hashlib.sha256(b"encrypted-vfs-bytes").hexdigest()
        up = await client.post(
            "/drive/uploads",
            json={
                "purpose": "assistant_vfs",
                "size_bytes": 128,
                "sha256": sha,
                "vfs_path": "/workspace/secret.md",
                "encryption_mode": "account_dek",
                "encryption_nonce": _b64(os.urandom(12)),
                "encryption_key_version": 1,
                "encrypted_meta": _b64(b"opaque-meta-blob-123456"),
            },
            headers=hdr,
        )
        assert up.status_code == 201, up.text
        file_id = up.json()["file"]["id"]
        assert (await client.post(f"/drive/files/{file_id}/complete", json={}, headers=hdr)).status_code == 200

        # Change password (re-wrap SAME dek_v1 with new password + Argon2id params!) using optimistic lock
        new_salt = _b64(os.urandom(16))
        new_nonce = os.urandom(12)
        new_kek = _derive_kek_pbkdf2("new-stronger-passphrase", new_salt, iterations=12_000)
        new_wrapped = AESGCM(new_kek).encrypt(new_nonce, dek_v1, None)

        # Wrong expected_version -> 409
        r_stale_rot = await client.put(
            "/assistant/encryption",
            json={
                "kdf": "pbkdf2-sha256",
                "kdf_params": {"iterations": 12_000, "hash": "SHA-256"},
                "salt": new_salt,
                "wrap_alg": "AES-256-GCM",
                "wrap_nonce": _b64(new_nonce),
                "wrapped_dek": _b64(new_wrapped),
                "expected_version": 99,
            },
            headers=hdr,
        )
        assert r_stale_rot.status_code == 409

        # Correct expected_version=1 -> key_version becomes 2, dek_epoch STAYS 1!
        r_rot = await client.put(
            "/assistant/encryption",
            json={
                "kdf": "pbkdf2-sha256",
                "kdf_params": {"iterations": 12_000, "hash": "SHA-256"},
                "salt": new_salt,
                "wrap_alg": "AES-256-GCM",
                "wrap_nonce": _b64(new_nonce),
                "wrapped_dek": _b64(new_wrapped),
                "expected_version": 1,
                "device": "macbook",
            },
            headers=hdr,
        )
        assert r_rot.status_code == 200, r_rot.text
        env2 = r_rot.json()["envelope"]
        assert env2["key_version"] == 2 and env2["dek_epoch"] == 1

        # Device 3 unwraps with NEW password and decrypts the historical conversation without re-encryption!
        unwrapped_after_change = _unwrap_dek("new-stronger-passphrase", env2)
        assert unwrapped_after_change == dek_v1
        detail = (await client.get("/assistant/conversations/conv_secret_1", headers=hdr)).json()
        decrypted = json.loads(
            AESGCM(unwrapped_after_change).decrypt(
                _unb64(detail["nonce"]),
                _unb64(detail["ciphertext"]),
                aad,
            )
        )
        assert decrypted == conv_plain

        # DELETE /assistant/encryption without confirm_wipe refused while encrypted data exists
        r_del_blocked = await client.delete("/assistant/encryption", headers=hdr)
        assert r_del_blocked.status_code == 409 and r_del_blocked.json()["code"] == "encrypted_data_exists"

        # Forgot password reset: requires confirm_wipe=true
        r_reset_no_confirm = await client.post(
            "/assistant/encryption/reset",
            json={"confirm_wipe": False},
            headers=hdr,
        )
        assert r_reset_no_confirm.status_code == 422

        # Destructive reset with new DEK (using argon2id KDF params): wipes encrypted convs + account_dek VFS files!
        dek_v2 = os.urandom(32)
        argon_env = {
            "kdf": "argon2id",
            "kdf_params": {"memory_kib": 65536, "iterations": 3, "parallelism": 1, "dk_len": 32},
            "salt": _b64(os.urandom(16)),
            "wrap_alg": "AES-256-GCM",
            "wrap_nonce": _b64(os.urandom(12)),
            "wrapped_dek": _b64(os.urandom(48)),
        }
        r_reset = await client.post(
            "/assistant/encryption/reset",
            json={"confirm_wipe": True, "new_envelope": argon_env, "wipe_drive_vfs": True},
            headers=hdr,
        )
        assert r_reset.status_code == 200, r_reset.text
        reset_body = r_reset.json()
        assert reset_body["enabled"] is True
        assert reset_body["wiped_conversations"] == 1
        assert reset_body["wiped_drive_files"] == 1
        assert reset_body["envelope"]["key_version"] == 3
        assert reset_body["envelope"]["dek_epoch"] == 2
        assert reset_body["envelope"]["kdf"] == "argon2id"
        assert len(fake_s3.deleted_keys) == 1

        # Stale device still holding old dek_epoch=1 is blocked from uploading garbage!
        r_stale_epoch = await client.put(
            "/assistant/conversations/conv_stale",
            json={
                "encrypted": True,
                "updated_at": 3000,
                "hash": "he_old",
                "device": "old_tab",
                "key_version": 2,
                "dek_epoch": 1,
                "nonce": _b64(os.urandom(12)),
                "ciphertext": _b64(os.urandom(48)),
            },
            headers=hdr,
        )
        assert r_stale_epoch.status_code == 409 and r_stale_epoch.json()["code"] == "dek_epoch_mismatch"

        # Disable encryption cleanly once no encrypted conversations exist (or with confirm_wipe)
        r_disable = await client.delete("/assistant/encryption", headers=hdr)
        assert r_disable.status_code == 200 and r_disable.json()["enabled"] is False
        assert (await client.get("/assistant/encryption", headers=hdr)).json()["enabled"] is False
        assert dek_v2 is not None


# ---------------------------------------------------------------------------
# 3. Tokens Anywhere managed key reuse, auto-refresh & own-session isolation
# ---------------------------------------------------------------------------


async def test_tokens_reuse_first_writer_wins_refresh_lock_and_revoke(
    db_engine,
    redis_client,
    router_pool: FakeRouterPool,
    push_provider: RecordingPushProvider,
) -> None:
    fake_tokens = FakeTokensClient()
    cfg = ControlSettings(
        database_url="sqlite+aiosqlite:///:memory:",
        redis_url="redis://localhost:6379/0",
        secret_key="tokens-test-secret-key",
        public_origin="https://aa.example.test",
        password_iterations=1_000,
        assistant=AssistantConfig(
            tokens=TokensAnywhereConfig(
                base_url="https://tokens.example.test",
                client_id="agents-anywhere",
                refresh_interval_seconds=30 * 86_400,
            ),
        ),
    )
    app = create_app(
        settings=cfg,
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        tokens_client=fake_tokens,
        start_push_worker=False,
    )

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://aa.example.test") as client:
        uid_a, hdr_a = await _register_user(client, "tok-a@example.com", "Alice")
        _uid_b, hdr_b = await _register_user(client, "tok-b@example.com", "Bob")

        # Initially disconnected
        r0 = await client.get("/assistant/tokens", headers=hdr_a)
        assert r0.status_code == 200
        assert r0.headers["cache-control"] == "no-store"
        assert r0.json()["connected"] is False
        assert r0.json()["tokens_url"] == "https://tokens.example.test"
        assert r0.json()["client_id"] == "agents-anywhere"

        # Invalid key prefix rejected
        assert (await client.put("/assistant/tokens", json={"key": "not-a-sk-key"}, headers=hdr_a)).status_code == 422

        # First browser connects -> stored encrypted, kept=False
        r1 = await client.put(
            "/assistant/tokens",
            json={"key": "sk-AAAAaaaa1111", "refresh": "ta_rt_one"},
            headers=hdr_a,
        )
        assert r1.status_code == 200 and r1.headers["cache-control"] == "no-store"
        body1 = r1.json()
        assert body1["connected"] is True and body1["key"] == "sk-AAAAaaaa1111"
        assert body1["prefix"] == "sk-AAAAaaaa" and body1["kept"] is False

        # Verify DB stores ciphertext (NEVER raw key or raw refresh token)
        async with db_engine.connect() as conn:
            row = (
                await conn.execute(
                    text(
                        "SELECT key_enc, refresh_enc FROM assistant_tokens_connections WHERE user_id = :u"
                    ),
                    {"u": uid_a},
                )
            ).mappings().one()
            assert "sk-AAAAaaaa1111" not in row["key_enc"]
            assert "ta_rt_one" not in row["refresh_enc"]

        # Second browser connects concurrently -> existing key wins (kept=True)
        r2 = await client.put(
            "/assistant/tokens",
            json={"key": "sk-BBBBbbbb2222", "refresh": "ta_rt_two"},
            headers=hdr_a,
        )
        assert r2.status_code == 200
        body2 = r2.json()
        assert body2["kept"] is True and body2["key"] == "sk-AAAAaaaa1111"

        # Other user cannot see Alice's key
        assert (await client.get("/assistant/tokens", headers=hdr_b)).json()["connected"] is False

        # Fresh connection does NOT call refresh
        assert (await client.get("/assistant/tokens", headers=hdr_a)).json()["key"] == "sk-AAAAaaaa1111"
        assert fake_tokens.calls == []

        # Age refreshed_at past 30 days & fire 2 concurrent GETs -> Redis lock guarantees refresh happens ONCE!
        old_ts = int(time.time()) - 31 * 86_400
        async with db_engine.begin() as conn:
            await conn.execute(
                update(schema.assistant_tokens_connections)
                .where(schema.assistant_tokens_connections.c.user_id == uid_a)
                .values(refreshed_at=old_ts)
            )

        fake_tokens.refresh_delay_seconds = 0.05
        g1, g2 = await asyncio.gather(
            client.get("/assistant/tokens", headers=hdr_a),
            client.get("/assistant/tokens", headers=hdr_a),
        )
        assert g1.status_code == 200 and g2.status_code == 200
        assert g1.json()["key"] == "sk-AAAAaaaa1111" and g2.json()["key"] == "sk-AAAAaaaa1111"
        assert fake_tokens.calls == [("refresh", "ta_rt_one")]

        # Conditional DELETE with stale key_hash leaves current connection intact
        stale_hash = hash_tokens_key("sk-OLDold9999")
        r_stale_del = await client.delete(f"/assistant/tokens?key_hash={stale_hash}", headers=hdr_a)
        assert r_stale_del.status_code == 200
        assert r_stale_del.json() == {"connected": True, "removed": False}
        assert len(fake_tokens.calls) == 1

        # Unconditional DELETE removes row & revokes the LATEST rotated refresh token
        r_del = await client.delete("/assistant/tokens", headers=hdr_a)
        assert r_del.status_code == 200
        assert r_del.json() == {"connected": False, "removed": True}
        assert fake_tokens.calls[-1] == ("revoke", "ta_rt_rotated")
        assert (await client.get("/assistant/tokens", headers=hdr_a)).json()["connected"] is False

        # invalid_grant clears refresh_enc without deleting the Key itself
        fake_tokens.calls.clear()
        fake_tokens.refresh_delay_seconds = 0.0
        fake_tokens.next_refresh_result = TokensRefreshResult(status="invalid_grant")
        await client.put(
            "/assistant/tokens",
            json={"key": "sk-CCCCcccc3333", "refresh": "ta_rt_dead"},
            headers=hdr_a,
        )
        async with db_engine.begin() as conn:
            await conn.execute(
                update(schema.assistant_tokens_connections)
                .where(schema.assistant_tokens_connections.c.user_id == uid_a)
                .values(refreshed_at=old_ts)
            )
        assert (await client.get("/assistant/tokens", headers=hdr_a)).json()["key"] == "sk-CCCCcccc3333"
        assert fake_tokens.calls == [("refresh", "ta_rt_dead")]
        # Subsequent GET does not hammer Tokens again because refresh_enc was cleared
        assert (await client.get("/assistant/tokens", headers=hdr_a)).json()["key"] == "sk-CCCCcccc3333"
        assert len(fake_tokens.calls) == 1


async def test_tokens_secret_rotation_graceful_recovery(
    db_engine,
    redis_client,
    router_pool: FakeRouterPool,
    push_provider: RecordingPushProvider,
) -> None:
    def _make_app(secret: str):
        return create_app(
            settings=ControlSettings(
                database_url="sqlite+aiosqlite:///:memory:",
                redis_url="redis://localhost:6379/0",
                secret_key=secret,
                public_origin="https://aa.example.test",
                password_iterations=1_000,
            ),
            engine=db_engine,
            redis_client=redis_client,
            router_pool=router_pool,
            push_provider=push_provider,
            tokens_client=FakeTokensClient(),
            start_push_worker=False,
        )

    app1 = _make_app("old-control-secret")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app1), base_url="https://aa.example.test") as c1:
        uid, hdr1 = await _register_user(c1, "rot@example.com", "Rot")
        assert (await c1.put("/assistant/tokens", json={"key": "sk-OLDsecret1111"}, headers=hdr1)).status_code == 200

    # Server restarts with a rotated secret_key: GET degrades gracefully with hint, PUT cleanly replaces
    app2 = _make_app("new-control-secret")
    tok2 = create_access_token(secret_key="new-control-secret", user_id=uid, expires_in=3600)
    hdr2 = {"Authorization": f"Bearer {tok2}"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app2), base_url="https://aa.example.test") as c2:
        r_get = await c2.get("/assistant/tokens", headers=hdr2)
        assert r_get.status_code == 200
        assert r_get.json()["connected"] is False and r_get.json()["hint"]

        r_put = await c2.put("/assistant/tokens", json={"key": "sk-NEWsecret2222"}, headers=hdr2)
        assert r_put.status_code == 200
        assert r_put.json()["connected"] is True and r_put.json()["key"] == "sk-NEWsecret2222" and r_put.json()["kept"] is False


async def test_tokens_strictly_blocks_mcp_oauth_apps_and_third_party_oidc_clients(
    db_engine,
    redis_client,
    router_pool: FakeRouterPool,
    push_provider: RecordingPushProvider,
) -> None:
    # Part A: local mode — MCP OAuth token (aamcp_...) & oauth-kind JWT are blocked with 403
    local_cfg = ControlSettings(
        database_url="sqlite+aiosqlite:///:memory:",
        redis_url="redis://localhost:6379/0",
        secret_key="own-session-secret",
        public_origin="https://aa.example.test",
        password_iterations=1_000,
    )
    app_local = create_app(
        settings=local_cfg,
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        tokens_client=FakeTokensClient(),
        start_push_worker=False,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app_local), base_url="https://aa.example.test") as client:
        uid, hdr = await _register_user(client, "own@example.com", "Own")
        await client.put("/assistant/tokens", json={"key": "sk-SUPERsecret9999"}, headers=hdr)

        # Complete real MCP OAuth PKCE S256 flow to obtain a valid MCP access token
        reg = (
            await client.post(
                "/oauth/register",
                json={"client_name": "External MCP App", "redirect_uris": ["https://mcp-app.example.test/cb"]},
            )
        ).json()
        verifier = secrets.token_urlsafe(32)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode("ascii").rstrip("=")
        authz = (
            await client.post(
                "/oauth/authorize",
                json={
                    "client_id": reg["client_id"],
                    "redirect_uri": "https://mcp-app.example.test/cb",
                    "code_challenge": challenge,
                    "code_challenge_method": "S256",
                    "scopes": ["devices:read"],
                    "device_ids": [],
                },
                headers=hdr,
            )
        ).json()
        tok_resp = (
            await client.post(
                "/oauth/token",
                data={
                    "grant_type": "authorization_code",
                    "client_id": reg["client_id"],
                    "code": authz["code"],
                    "redirect_uri": "https://mcp-app.example.test/cb",
                    "code_verifier": verifier,
                },
            )
        ).json()
        mcp_hdr = {"Authorization": f"Bearer {tok_resp['access_token']}"}

        # MCP OAuth app MUST get 403 and NEVER see the key!
        for method in ("GET", "PUT", "DELETE"):
            kwargs = {"json": {"key": "sk-EVILevil1234"}} if method == "PUT" else {}
            resp = await client.request(method, "/assistant/tokens", headers=mcp_hdr, **kwargs)
            assert resp.status_code == 403, f"{method} expected 403, got {resp.status_code}"
            assert "sk-" not in resp.text

        # MCP token also cannot access conversations or encryption
        assert (await client.get("/assistant/conversations", headers=mcp_hdr)).status_code == 401
        assert (await client.get("/assistant/encryption", headers=mcp_hdr)).status_code == 401

        # OAuth-tagged local JWT also gets 403 on /assistant/tokens
        oauth_jwt = create_access_token(
            secret_key="own-session-secret",
            user_id=uid,
            expires_in=3600,
            extra={"kind": "oauth"},
        )
        r_oauth_jwt = await client.get("/assistant/tokens", headers={"Authorization": f"Bearer {oauth_jwt}"})
        assert r_oauth_jwt.status_code == 403 and "sk-" not in r_oauth_jwt.text

        # Device credentials cannot access /assistant/*
        dev = (
            await client.post(
                "/devices/register",
                json={"name": "Mac", "platform": "macos", "mode_hint": "normal"},
                headers=hdr,
            )
        ).json()
        dev_hdr = {"X-AA-Device-Id": dev["device"]["id"], "X-AA-Device-Secret": dev["device_secret"]}
        assert (await client.get("/assistant/tokens", headers=dev_hdr)).status_code == 401
        assert (await client.get("/assistant/conversations", headers=dev_hdr)).status_code == 401

    # Part B: OIDC mode — first-party azp allowed, third-party azp / client_credentials / delegated act blocked (403)
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    class StubOidcVerifier:
        async def public_config(self):
            raise NotImplementedError

        async def verify_token(self, token: str) -> VerifiedOidcIdentity:
            claims = jwt.decode(token, private_key.public_key(), algorithms=["RS256"], options={"verify_aud": False})
            return VerifiedOidcIdentity(
                issuer="https://auth.example.test",
                subject=str(claims["sub"]),
                email="oidc@example.com",
                email_verified=True,
                display_name="OIDC User",
                role="member",
                plan="pro",
                entitlements={},
                active_context={"type": "personal"},
                raw_claims=claims,
            )

        async def close(self) -> None:
            return None

    oidc_cfg = ControlSettings(
        database_url="sqlite+aiosqlite:///:memory:",
        redis_url="redis://localhost:6379/0",
        secret_key="oidc-tokens-secret",
        public_origin="https://aa.example.test",
        auth_mode="oidc",
        oidc_auth=OidcAuthConfig(
            issuer="https://auth.example.test",
            client_id="aa-v3",
            audiences=("aa-v3", "third-party-app"),
        ),
    )
    app_oidc = create_app(
        settings=oidc_cfg,
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        oidc_verifier=StubOidcVerifier(),
        tokens_client=FakeTokensClient(),
        start_push_worker=False,
    )

    def _mint(extra: dict[str, Any]) -> dict[str, str]:
        tok = jwt.encode(
            {"iss": "https://auth.example.test", "sub": "oidc_sub_1", "exp": int(time.time()) + 3600, **extra},
            private_key,
            algorithm="RS256",
        )
        return {"Authorization": f"Bearer {tok}"}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app_oidc), base_url="https://aa.example.test") as c_oidc:
        first_party_hdr = _mint({"aud": "aa-v3", "azp": "aa-v3"})
        third_party_hdr = _mint({"aud": "aa-v3", "azp": "third-party-app"})
        m2m_hdr = _mint({"aud": "aa-v3", "azp": "aa-v3", "gty": "client-credentials"})
        delegated_hdr = _mint({"aud": "aa-v3", "azp": "aa-v3", "act": {"sub": "agent-app"}})

        assert (await c_oidc.put("/assistant/tokens", json={"key": "sk-OIDCown11111"}, headers=first_party_hdr)).status_code == 200
        assert (await c_oidc.get("/assistant/tokens", headers=first_party_hdr)).json()["key"] == "sk-OIDCown11111"

        for blocked_hdr in (third_party_hdr, m2m_hdr, delegated_hdr):
            resp = await c_oidc.get("/assistant/tokens", headers=blocked_hdr)
            assert resp.status_code == 403 and resp.json()["code"] == "own_session_required"
            assert "sk-" not in resp.text


# ---------------------------------------------------------------------------
# 4. HttpTokensAnywhereClient wire protocol test
# ---------------------------------------------------------------------------


async def test_http_tokens_anywhere_client_protocol() -> None:
    recorded: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        recorded.append((request.url.path, request.content.decode("utf-8")))
        if request.url.path == "/api/v1/oauth/token":
            if "ta_rt_bad" in request.content.decode("utf-8"):
                return httpx.Response(400, json={"error": "invalid_grant"})
            if "ta_rt_500" in request.content.decode("utf-8"):
                return httpx.Response(503, text="upstream down")
            return httpx.Response(200, json={"access_token": "ta_at_2", "refresh_token": "ta_rt_2"})
        if request.url.path == "/api/v1/oauth/revoke":
            return httpx.Response(200, json={})
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as mock_http:
        tc = HttpTokensAnywhereClient(
            TokensAnywhereConfig(base_url="https://tokens-anywhere.com", client_id="agents-anywhere"),
            http_client=mock_http,
        )
        ok = await tc.refresh_token(refresh_token="ta_rt_1")
        assert ok.status == "refreshed" and ok.refresh_token == "ta_rt_2" and ok.access_token == "ta_at_2"
        assert recorded[-1][0] == "/api/v1/oauth/token"
        assert "grant_type=refresh_token" in recorded[-1][1]
        assert "client_id=agents-anywhere" in recorded[-1][1]
        assert "refresh_token=ta_rt_1" in recorded[-1][1]

        bad = await tc.refresh_token(refresh_token="ta_rt_bad")
        assert bad.status == "invalid_grant"

        err = await tc.refresh_token(refresh_token="ta_rt_500")
        assert err.status == "transient_error"

        revoked = await tc.revoke_token(token="ta_rt_2")
        assert revoked is True
        assert recorded[-1][0] == "/api/v1/oauth/revoke"
        assert "token=ta_rt_2" in recorded[-1][1]
        assert "client_id=agents-anywhere" in recorded[-1][1]


# ---------------------------------------------------------------------------
# 5. Alembic v3_2 migration upgrade / downgrade round-trip
# ---------------------------------------------------------------------------


def test_alembic_v3_2_migration_round_trip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_file = tmp_path / "v3_2_migration.db"
    async_db_url = f"sqlite+aiosqlite:///{db_file}"
    sync_db_url = f"sqlite:///{db_file}"
    monkeypatch.setenv("AA_CONTROL_DB_URL", async_db_url)

    server_root = Path(__file__).parents[1]
    alembic_cfg = AlembicConfig(str(server_root / "alembic.ini"))
    alembic_cfg.set_main_option("script_location", str(server_root / "migrations"))

    alembic_command.upgrade(alembic_cfg, "v3_1")
    sync_eng = create_sync_engine(sync_db_url)
    try:
        before = set(sa_inspect(sync_eng).get_table_names())
        assert "drive_files" in before
        assert "assistant_conversations" not in before
        assert "assistant_key_envelopes" not in before
        assert "assistant_tokens_connections" not in before

        alembic_command.upgrade(alembic_cfg, "head")
        after_up = set(sa_inspect(sync_eng).get_table_names())
        assert {"assistant_conversations", "assistant_key_envelopes", "assistant_tokens_connections"} <= after_up

        alembic_command.downgrade(alembic_cfg, "v3_1")
        after_down = set(sa_inspect(sync_eng).get_table_names())
        assert "assistant_conversations" not in after_down
        assert "assistant_key_envelopes" not in after_down
        assert "assistant_tokens_connections" not in after_down
        assert "drive_files" in after_down

        alembic_command.upgrade(alembic_cfg, "head")
        after_reup = set(sa_inspect(sync_eng).get_table_names())
        assert {"assistant_conversations", "assistant_key_envelopes", "assistant_tokens_connections"} <= after_reup
    finally:
        sync_eng.dispose()
        # Verify create_engine helper doesn't break anything either
        _ = create_engine(f"sqlite+aiosqlite:///{db_file}")
