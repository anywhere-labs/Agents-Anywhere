from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from aa_control.app import create_app
from aa_control.core.config import ControlSettings, DriveConfig, OidcAuthConfig, S3ObjectStoreConfig
from aa_control.core.drive import (
    DAY_SECONDS,
    MIB,
    DrivePolicyDefaults,
    DrivePolicyOverride,
    normalize_vfs_path,
    presign_s3_url,
    resolve_drive_policy,
)
from aa_control.core.errors import ValidationError
from aa_control.infra.object_store import S3ObjectStore
from aa_control.infra.oidc import OidcJwksVerifier
from tests.test_oidc_auth import FakeOidcIdp, _generate_rsa_jwk, _sign_token

ALEMBIC_INI = Path(__file__).parents[1] / "alembic.ini"


class FakeS3Server:
    """In-process S3 HTTP mock storing blobs by path, checking SigV4 query/auth & Content-Length."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str | None, str]] = {}
        self.fail_delete = False
        self.requests: list[tuple[str, str]] = []

    def transport(self) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            self.requests.append((request.method, path))
            if request.method == "PUT":
                qs = parse_qs(urlsplit(str(request.url)).query)
                assert qs.get("X-Amz-Algorithm") == ["AWS4-HMAC-SHA256"]
                assert "X-Amz-Signature" in qs
                body = request.content
                etag = hashlib.md5(body).hexdigest()  # noqa: S324
                self.objects[path] = (body, request.headers.get("content-type"), etag)
                return httpx.Response(200, headers={"ETag": f'"{etag}"'})
            if request.method == "HEAD":
                assert request.headers.get("authorization", "").startswith("AWS4-HMAC-SHA256 ")
                item = self.objects.get(path)
                if item is None:
                    return httpx.Response(404)
                body, ctype, etag = item
                headers = {"Content-Length": str(len(body)), "ETag": f'"{etag}"'}
                if ctype:
                    headers["Content-Type"] = ctype
                return httpx.Response(200, headers=headers)
            if request.method == "GET":
                qs = parse_qs(urlsplit(str(request.url)).query)
                assert qs.get("X-Amz-Algorithm") == ["AWS4-HMAC-SHA256"]
                assert "X-Amz-Signature" in qs
                item = self.objects.get(path)
                if item is None:
                    return httpx.Response(404)
                body, ctype, etag = item
                headers = {"Content-Length": str(len(body)), "ETag": f'"{etag}"'}
                if ctype:
                    headers["Content-Type"] = ctype
                return httpx.Response(200, content=body, headers=headers)
            if request.method == "DELETE":
                assert request.headers.get("authorization", "").startswith("AWS4-HMAC-SHA256 ")
                if self.fail_delete:
                    return httpx.Response(503)
                self.objects.pop(path, None)
                return httpx.Response(204)
            return httpx.Response(405)

        return httpx.MockTransport(handler)


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Pure unit tests: SigV4 presigning, VFS path safety, policy precedence
# ---------------------------------------------------------------------------


def test_sigv4_presign_url_path_and_virtual_hosted_styles() -> None:
    ts = datetime(2026, 11, 22, 4, 0, 0, tzinfo=UTC)
    url, headers = presign_s3_url(
        method="PUT",
        endpoint="https://files.anywhere.dev",
        bucket="aa-blobs",
        object_key="aa-drive/u/usr_1/transfer/drv_abc",
        access_key_id="AKIAEXAMPLE",
        secret_access_key="secret-example-key",
        region="auto",
        expires_seconds=900,
        path_style=True,
        signed_headers={"Content-Length": "4096", "Content-Type": "application/octet-stream"},
        now=ts,
    )
    parts = urlsplit(url)
    qs = parse_qs(parts.query)
    assert parts.scheme == "https"
    assert parts.netloc == "files.anywhere.dev"
    assert parts.path == "/aa-blobs/aa-drive/u/usr_1/transfer/drv_abc"
    assert qs["X-Amz-Algorithm"] == ["AWS4-HMAC-SHA256"]
    assert qs["X-Amz-Credential"] == ["AKIAEXAMPLE/20261122/auto/s3/aws4_request"]
    assert qs["X-Amz-SignedHeaders"] == ["content-length;content-type;host"]
    assert len(qs["X-Amz-Signature"][0]) == 64
    assert headers == {"Content-Length": "4096", "Content-Type": "application/octet-stream"}

    vh_url, _ = presign_s3_url(
        method="GET",
        endpoint="https://s3.us-east-1.amazonaws.com",
        bucket="aa-blobs",
        object_key="u/usr_1/test.bin",
        access_key_id="AKIAEXAMPLE",
        secret_access_key="secret-example-key",
        region="us-east-1",
        path_style=False,
        now=ts,
    )
    vh_parts = urlsplit(vh_url)
    assert vh_parts.netloc == "aa-blobs.s3.us-east-1.amazonaws.com"
    assert vh_parts.path == "/u/usr_1/test.bin"


def test_policy_resolution_precedence_and_vfs_path_validation() -> None:
    defaults = DrivePolicyDefaults(
        quota_bytes=512 * MIB,
        max_file_bytes=100 * MIB,
        default_ttl_seconds=7 * DAY_SECONDS,
        max_ttl_seconds=30 * DAY_SECONDS,
        rpc_direct_max_bytes=8 * MIB,
    )
    # 1. Server defaults
    p_def = resolve_drive_policy(defaults=defaults)
    assert p_def.quota_bytes == 512 * MIB
    assert p_def.default_ttl_seconds == 7 * DAY_SECONDS
    assert p_def.source == "default"

    # 2. Entitlements override defaults (including -1 unlimited)
    p_ent = resolve_drive_policy(
        defaults=defaults,
        entitlements={"aa.drive_quota_mb": 2048, "aa.drive_ttl_days": 14, "aa.drive_max_file_mb": -1},
    )
    assert p_ent.quota_bytes == 2048 * MIB
    assert p_ent.default_ttl_seconds == 14 * DAY_SECONDS
    assert p_ent.max_file_bytes is None
    assert p_ent.source == "entitlements"

    # 3. Admin per-account override beats entitlements
    p_ovr = resolve_drive_policy(
        defaults=defaults,
        entitlements={"aa.drive_quota_mb": 512, "aa.drive_ttl_days": 7},
        override=DrivePolicyOverride(quota_bytes=-1, default_ttl_seconds=45 * DAY_SECONDS),
    )
    assert p_ovr.quota_bytes is None
    assert p_ovr.default_ttl_seconds == 45 * DAY_SECONDS
    assert p_ovr.max_ttl_seconds == 45 * DAY_SECONDS  # max_ttl never smaller than default_ttl
    assert p_ovr.source == "account_override"

    # VFS path normalization & traversal defense
    assert normalize_vfs_path("/notes//2026/plan.md") == "notes/2026/plan.md"
    for bad in ("", "/", "../etc/passwd", "a/../b", "a/./b", "bad\x00name"):
        with pytest.raises(ValidationError):
            normalize_vfs_path(bad)


# ---------------------------------------------------------------------------
# Full Cloud Drive API lifecycle, encryption, dual-auth, admin policy & cleanup
# ---------------------------------------------------------------------------


async def test_drive_full_lifecycle_encryption_vfs_dual_auth_and_cleanup(
    db_engine,
    redis_client,
    router_pool,
    push_provider,
) -> None:
    fake_s3 = FakeS3Server()
    s3_http = httpx.AsyncClient(transport=fake_s3.transport())
    s3_cfg = S3ObjectStoreConfig(
        endpoint="http://minio.internal:9000",
        public_endpoint="https://files.example.test",
        bucket="aa-drive-bucket",
        access_key_id="minioadmin",
        secret_access_key="miniosecret",
        region="us-east-1",
        path_style=True,
    )
    store = S3ObjectStore(s3_cfg, http_client=s3_http)
    now_ts = [1_800_000_000]

    app = create_app(
        settings=ControlSettings(
            database_url="sqlite+aiosqlite:///:memory:",
            redis_url="redis://localhost:6379/0",
            secret_key="drive-test-secret",
            password_iterations=1_000,
            drive=DriveConfig(
                default_quota_bytes=20_000,
                default_max_file_bytes=10_000,
                default_ttl_seconds=7 * DAY_SECONDS,
                max_ttl_seconds=30 * DAY_SECONDS,
                rpc_direct_max_bytes=8 * MIB,
                upload_url_ttl_seconds=900,
                download_url_ttl_seconds=300,
                s3=s3_cfg,
            ),
        ),
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        object_store=store,
        start_push_worker=False,
        start_drive_cleanup_worker=False,
    )
    app.state.drive_service._now = lambda: now_ts[0]

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="https://aa.example.test",
        ) as client:
            # Register admin (Alice) and member (Bob)
            alice = (
                await client.post(
                    "/auth/register",
                    json={"email": "alice@example.com", "password": "password123", "display_name": "Alice"},
                )
            ).json()
            bob = (
                await client.post(
                    "/auth/register",
                    json={"email": "bob@example.com", "password": "password123", "display_name": "Bob"},
                )
            ).json()
            alice_h = {"Authorization": f"Bearer {alice['access_token']}"}
            bob_h = {"Authorization": f"Bearer {bob['access_token']}"}

            # Register a device for Alice (for Connector dual-auth transfer test)
            dev = (
                await client.post(
                    "/devices/register",
                    headers=alice_h,
                    json={"name": "Alice Mac", "platform": "macos"},
                )
            ).json()
            dev_headers = {
                "X-AA-Device-Id": dev["device"]["id"],
                "X-AA-Device-Secret": dev["device_secret"],
            }

            # 1. Quota check shows enabled=True, 8 MiB RPC threshold, 7-day default TTL
            q0 = (await client.get("/drive/quota", headers=alice_h)).json()
            assert q0["enabled"] is True
            assert q0["rpc_direct_max_bytes"] == 8 * MIB
            assert q0["quota_bytes"] == 20_000
            assert q0["max_file_bytes"] == 10_000
            assert q0["default_ttl_seconds"] == 7 * DAY_SECONDS
            assert q0["used_bytes"] == 0
            assert q0["reserved_bytes"] == 0

            # 2. Connector uploads a 6000-byte artifact using device credentials -> User downloads it
            blob1 = b"A" * 6_000
            up1 = await client.post(
                "/drive/uploads",
                headers=dev_headers,
                json={
                    "purpose": "transfer",
                    "size_bytes": len(blob1),
                    "sha256": _sha256_hex(blob1),
                    "filename": "build.tar.gz",
                    "mime_type": "application/gzip",
                },
            )
            assert up1.status_code == 201
            up1_data = up1.json()
            file1_id = up1_data["file"]["id"]
            assert up1_data["file"]["status"] == "pending"
            assert up1_data["file"]["source_device_id"] == dev["device"]["id"]
            assert up1_data["upload"]["url"].startswith("https://files.example.test/aa-drive-bucket/")

            # Quota now reflects 6000 reserved bytes
            q_pending = (await client.get("/drive/quota", headers=alice_h)).json()
            assert q_pending["used_bytes"] == 0
            assert q_pending["reserved_bytes"] == 6_000
            assert q_pending["remaining_bytes"] == 14_000

            # Completing before uploading to S3 fails cleanly
            early = await client.post(f"/drive/files/{file1_id}/complete", headers=dev_headers)
            assert early.status_code == 422
            assert early.json()["code"] == "upload_not_found"

            # Direct S3 PUT using presigned URL & headers (traffic bypasses control plane!)
            put_res = await s3_http.put(
                up1_data["upload"]["url"],
                content=blob1,
                headers=up1_data["upload"]["headers"],
            )
            assert put_res.status_code == 200

            comp1 = await client.post(f"/drive/files/{file1_id}/complete", headers=dev_headers)
            assert comp1.status_code == 200
            assert comp1.json()["status"] == "ready"
            assert comp1.json()["etag"] is not None

            # User downloads via presigned GET URL
            dl1 = await client.get(f"/drive/files/{file1_id}/download-url", headers=alice_h)
            assert dl1.status_code == 200
            dl_bytes = (await s3_http.get(dl1.json()["download"]["url"])).content
            assert dl_bytes == blob1

            # Cross-account isolation: Bob cannot read/download/delete Alice's file
            assert (await client.get(f"/drive/files/{file1_id}", headers=bob_h)).status_code == 403
            assert (await client.get(f"/drive/files/{file1_id}/download-url", headers=bob_h)).status_code == 403
            assert (await client.delete(f"/drive/files/{file1_id}", headers=bob_h)).status_code == 403

            # 3. Size-tampering defense: declaring 5000 bytes but uploading 7000 bytes is rejected & deleted
            tamper_up = (
                await client.post(
                    "/drive/uploads",
                    headers=alice_h,
                    json={"purpose": "transfer", "size_bytes": 5_000, "sha256": _sha256_hex(b"X" * 5_000)},
                )
            ).json()
            await s3_http.put(tamper_up["upload"]["url"], content=b"X" * 7_000, headers=tamper_up["upload"]["headers"])
            tamper_comp = await client.post(f"/drive/files/{tamper_up['file']['id']}/complete", headers=alice_h)
            assert tamper_comp.status_code == 422
            assert tamper_comp.json()["code"] == "upload_size_mismatch"
            assert urlsplit(tamper_up["upload"]["url"]).path not in fake_s3.objects

            # 4. Single-file cap (413) and TTL cap (422)
            too_big = await client.post(
                "/drive/uploads",
                headers=alice_h,
                json={"purpose": "transfer", "size_bytes": 10_001, "sha256": _sha256_hex(b"Z")},
            )
            assert too_big.status_code == 413
            assert too_big.json()["code"] == "file_too_large"

            bad_ttl = await client.post(
                "/drive/uploads",
                headers=alice_h,
                json={
                    "purpose": "transfer",
                    "size_bytes": 100,
                    "sha256": _sha256_hex(b"Z"),
                    "ttl_seconds": 31 * DAY_SECONDS,
                },
            )
            assert bad_ttl.status_code == 422

            # 5. Encrypted Assistant VFS (account_dek) strips plaintext metadata & supersedes older path version
            vfs_v1 = b"E" * 4_000
            vfs_up1 = await client.post(
                "/drive/uploads",
                headers=alice_h,
                json={
                    "purpose": "assistant_vfs",
                    "size_bytes": len(vfs_v1),
                    "sha256": _sha256_hex(vfs_v1),
                    "vfs_path": "/workspace/notes.md",
                    "filename": "should-be-stripped.md",
                    "mime_type": "text/markdown",
                    "encryption_mode": "account_dek",
                    "encryption_nonce": "YWJjZGVmZ2hpamts",
                    "encryption_key_version": 2,
                    "encrypted_meta": "opaque-ciphertext-meta-v1",
                },
            )
            assert vfs_up1.status_code == 201
            vfs1_data = vfs_up1.json()
            assert vfs1_data["file"]["filename"] is None  # Stripped!
            assert vfs1_data["file"]["mime_type"] is None  # Stripped!
            assert vfs1_data["file"]["vfs_path"] == "workspace/notes.md"
            assert vfs1_data["upload"]["headers"]["Content-Type"] == "application/octet-stream"
            await s3_http.put(vfs1_data["upload"]["url"], content=vfs_v1, headers=vfs1_data["upload"]["headers"])
            assert (await client.post(f"/drive/files/{vfs1_data['file']['id']}/complete", headers=alice_h)).status_code == 200

            # Overwrite same VFS path -> old blob deleted and quota reclaimed!
            vfs_v2 = b"F" * 4_500
            vfs_up2 = (
                await client.post(
                    "/drive/uploads",
                    headers=alice_h,
                    json={
                        "purpose": "assistant_vfs",
                        "size_bytes": len(vfs_v2),
                        "sha256": _sha256_hex(vfs_v2),
                        "vfs_path": "workspace/notes.md",
                        "encryption_mode": "account_dek",
                        "encryption_nonce": "MTIzNDU2Nzg5MDEy",
                        "encryption_key_version": 2,
                        "encrypted_meta": "opaque-ciphertext-meta-v2",
                    },
                )
            ).json()
            await s3_http.put(vfs_up2["upload"]["url"], content=vfs_v2, headers=vfs_up2["upload"]["headers"])
            assert (await client.post(f"/drive/files/{vfs_up2['file']['id']}/complete", headers=alice_h)).status_code == 200
            assert urlsplit(vfs1_data["upload"]["url"]).path not in fake_s3.objects

            vfs_list = (await client.get("/drive/files?purpose=assistant_vfs&vfs_prefix=workspace", headers=alice_h)).json()
            assert [f["id"] for f in vfs_list["files"]] == [vfs_up2["file"]["id"]]
            assert vfs_list["quota"]["used_bytes"] == 6_000 + 4_500

            # 6. Encrypted device transfer (ephemeral_key) rejects unknown file_key field & strips filename
            bad_ephem = await client.post(
                "/drive/uploads",
                headers=dev_headers,
                json={
                    "purpose": "transfer",
                    "size_bytes": 1_000,
                    "sha256": _sha256_hex(b"K" * 1_000),
                    "encryption_mode": "ephemeral_key",
                    "encryption_nonce": "MTIzNDU2Nzg5MDEy",
                    "file_key": "must-never-be-accepted",
                },
            )
            assert bad_ephem.status_code == 422

            ephem_up = (
                await client.post(
                    "/drive/uploads",
                    headers=dev_headers,
                    json={
                        "purpose": "transfer",
                        "size_bytes": 8_000,
                        "sha256": _sha256_hex(b"K" * 8_000),
                        "filename": "secret-plan.pdf",
                        "encryption_mode": "ephemeral_key",
                        "encryption_nonce": "MTIzNDU2Nzg5MDEy",
                    },
                )
            ).json()
            assert ephem_up["file"]["filename"] is None
            # Used (10_500) + pending (8_000) = 18_500 <= 20_000; another 2_000 exceeds quota!
            over_quota = await client.post(
                "/drive/uploads",
                headers=alice_h,
                json={"purpose": "transfer", "size_bytes": 2_000, "sha256": _sha256_hex(b"Q" * 2_000)},
            )
            assert over_quota.status_code == 403
            assert over_quota.json()["code"] == "drive_quota_exceeded"

            # 7. Admin per-account policy override increases quota & TTL; non-admin gets 403
            assert (
                await client.put(
                    f"/admin/drive/policies/{alice['user']['id']}",
                    headers=bob_h,
                    json={"quota_bytes": 100_000},
                )
            ).status_code == 403

            pol_up = await client.put(
                f"/admin/drive/policies/{alice['user']['id']}",
                headers=alice_h,
                json={
                    "quota_bytes": 100_000,
                    "max_file_bytes": 50_000,
                    "default_ttl_seconds": 14 * DAY_SECONDS,
                    "max_ttl_seconds": 60 * DAY_SECONDS,
                },
            )
            assert pol_up.status_code == 200
            assert pol_up.json()["effective"]["policy_source"] == "account_override"
            assert pol_up.json()["effective"]["quota_bytes"] == 100_000
            assert pol_up.json()["effective"]["default_ttl_seconds"] == 14 * DAY_SECONDS

            # Now the 2_000-byte upload succeeds!
            ok_after_override = await client.post(
                "/drive/uploads",
                headers=alice_h,
                json={"purpose": "transfer", "size_bytes": 2_000, "sha256": _sha256_hex(b"Q" * 2_000)},
            )
            assert ok_after_override.status_code == 201

            # Reset policy override
            pol_reset = await client.delete(f"/admin/drive/policies/{alice['user']['id']}", headers=alice_h)
            assert pol_reset.status_code == 200
            assert pol_reset.json()["override"] is None
            assert pol_reset.json()["effective"]["policy_source"] == "default"

            # 8. Abandon pending upload expiration + 7-day file expiration + transient S3 delete retry
            now_ts[0] += 1_000  # Past 900s upload_expires_at for pending uploads
            removed_pending = await app.state.drive_service.cleanup_expired()
            assert removed_pending == 2  # ephem_up + ok_after_override

            # Advance past 7 days: ready files expire and become invisible/undownloadable
            now_ts[0] += 7 * DAY_SECONDS + 10
            assert (await client.get(f"/drive/files/{file1_id}/download-url", headers=alice_h)).status_code == 404
            assert (await client.get("/drive/files", headers=alice_h)).json()["files"] == []

            # Transient S3 delete failure keeps DB rows for safe retry
            fake_s3.fail_delete = True
            assert await app.state.drive_service.cleanup_expired() == 0

            # Once S3 recovers, cleanup removes both blobs and DB rows completely
            fake_s3.fail_delete = False
            assert await app.state.drive_service.cleanup_expired() == 2
            assert fake_s3.objects == {}
    finally:
        await s3_http.aclose()


async def test_drive_disabled_without_s3_and_oidc_entitlements_for_connector(
    db_engine,
    redis_client,
    router_pool,
    push_provider,
) -> None:
    # 1. Without S3 configured, quota reports enabled=False and uploads return 503
    app_no_s3 = create_app(
        settings=ControlSettings(
            database_url="sqlite+aiosqlite:///:memory:",
            redis_url="redis://localhost:6379/0",
            secret_key="no-s3-secret",
            password_iterations=1_000,
        ),
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        start_push_worker=False,
        start_drive_cleanup_worker=False,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_no_s3),
        base_url="https://aa.example.test",
    ) as client:
        reg = (
            await client.post("/auth/register", json={"email": "u@example.com", "password": "password123"})
        ).json()
        hdrs = {"Authorization": f"Bearer {reg['access_token']}"}
        q = (await client.get("/drive/quota", headers=hdrs)).json()
        assert q["enabled"] is False
        up = await client.post(
            "/drive/uploads",
            headers=hdrs,
            json={"purpose": "transfer", "size_bytes": 128, "sha256": _sha256_hex(b"a")},
        )
        assert up.status_code == 503
        assert up.json()["code"] == "drive_not_configured"

    # 2. OIDC entitlements (aa.drive_quota_mb / aa.drive_ttl_days) propagate to Connector calls via Redis cache
    idp = FakeOidcIdp()
    rsa_key, rsa_jwk = _generate_rsa_jwk("drv-kid-1")
    idp.add_key(rsa_jwk)
    idp_http = httpx.AsyncClient(transport=idp.transport())
    fake_s3 = FakeS3Server()
    s3_http = httpx.AsyncClient(transport=fake_s3.transport())
    s3_cfg = S3ObjectStoreConfig(
        endpoint="http://minio.internal:9000",
        bucket="aa-blobs",
        access_key_id="k",
        secret_access_key="s",
    )
    oidc_cfg = OidcAuthConfig(issuer=idp.issuer, client_id="aa-v3")
    app_oidc = create_app(
        settings=ControlSettings(
            database_url="sqlite+aiosqlite:///:memory:",
            redis_url="redis://localhost:6379/0",
            secret_key="unused",
            auth_mode="oidc",
            oidc_auth=oidc_cfg,
            drive=DriveConfig(s3=s3_cfg),
        ),
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        oidc_verifier=OidcJwksVerifier(config=oidc_cfg, http_client=idp_http),
        object_store=S3ObjectStore(s3_cfg, http_client=s3_http),
        start_push_worker=False,
        start_drive_cleanup_worker=False,
    )
    try:
        tok = _sign_token(
            rsa_key,
            kid="drv-kid-1",
            subject="usr_pro_drive",
            extra={
                "email": "pro@anywhere.dev",
                "name": "Pro User",
                "plan": "pro",
                "entitlements": {"aa.drive_quota_mb": 4096, "aa.drive_ttl_days": 14},
            },
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app_oidc),
            base_url="https://aa.example.test",
        ) as client:
            dev = (
                await client.post(
                    "/devices/register",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"name": "Pro Box", "platform": "linux"},
                )
            ).json()
            # Connector queries /drive/quota using ONLY device credentials -> inherits 4096 MB & 14d from OIDC cache!
            dev_quota = (
                await client.get(
                    "/drive/quota",
                    headers={
                        "X-AA-Device-Id": dev["device"]["id"],
                        "X-AA-Device-Secret": dev["device_secret"],
                    },
                )
            ).json()
            assert dev_quota["policy_source"] == "entitlements"
            assert dev_quota["quota_bytes"] == 4096 * MIB
            assert dev_quota["default_ttl_seconds"] == 14 * DAY_SECONDS
    finally:
        await idp_http.aclose()
        await s3_http.aclose()


def test_v3_1_alembic_upgrade_and_downgrade(tmp_path: Path) -> None:
    db_file = tmp_path / "v3_1_test.sqlite"
    engine = sa.create_engine(f"sqlite:///{db_file}")
    cfg = Config(str(ALEMBIC_INI))
    cfg.set_main_option("script_location", str(ALEMBIC_INI.parent / "migrations"))
    try:
        with engine.begin() as conn:
            cfg.attributes["connection"] = conn
            command.upgrade(cfg, "head")
        tables_up = set(sa.inspect(engine).get_table_names())
        assert "drive_files" in tables_up
        assert "drive_user_policies" in tables_up

        with engine.begin() as conn:
            cfg.attributes["connection"] = conn
            command.downgrade(cfg, "v3_0")
        tables_down = set(sa.inspect(engine).get_table_names())
        assert "drive_files" not in tables_down
        assert "drive_user_policies" not in tables_down
        assert "users" in tables_down

        with engine.begin() as conn:
            cfg.attributes["connection"] = conn
            command.upgrade(cfg, "head")
        assert "drive_files" in set(sa.inspect(engine).get_table_names())
    finally:
        engine.dispose()
