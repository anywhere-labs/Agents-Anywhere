from __future__ import annotations

import secrets
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from loguru import logger

from aa_control.core.config import ControlSettings
from aa_control.core.drive import (
    NONCE_B64_RE,
    DrivePolicyOverride,
    normalize_vfs_path,
    resolve_drive_policy,
    sanitize_filename,
)
from aa_control.core.entitlements import merge_entitlements
from aa_control.core.errors import (
    ForbiddenError,
    NotFoundError,
    PayloadTooLargeError,
    UpstreamUnavailableError,
    ValidationError,
)
from aa_control.core.models import (
    AdminDrivePolicyResponse,
    CompleteDriveUploadRequest,
    CreateDriveUploadRequest,
    CreateDriveUploadResponse,
    DriveDownloadUrlResponse,
    DriveFileView,
    DrivePolicyOverrideView,
    DrivePurpose,
    DriveQuotaView,
    ListDriveFilesResponse,
    UpdateDrivePolicyRequest,
)
from aa_control.core.utc import unix_ms_to_iso
from aa_control.infra.db.repositories import ControlRepository, DriveFileRow, DrivePolicyRow
from aa_control.infra.object_store import ObjectStorePort
from aa_control.infra.redis_store import RedisControlStore


@dataclass(frozen=True)
class DriveCaller:
    """Authenticated caller for cloud drive endpoints (end-user Bearer JWT or Connector device)."""

    user_id: str
    actor: str
    device_id: str | None = None
    is_admin: bool = False
    entitlements: Mapping[str, Any] | None = None


def _file_view(row: DriveFileRow) -> DriveFileView:
    return DriveFileView(
        id=row.id,
        purpose=row.purpose,  # type: ignore[arg-type]
        status=row.status,  # type: ignore[arg-type]
        size_bytes=row.size_bytes,
        sha256=row.sha256,
        etag=row.etag,
        filename=row.filename,
        mime_type=row.mime_type,
        vfs_path=row.vfs_path,
        encryption_mode=row.encryption_mode,  # type: ignore[arg-type]
        encryption_nonce=row.encryption_nonce,
        encryption_key_version=row.encryption_key_version,
        encrypted_meta=row.encrypted_meta,
        source_device_id=row.source_device_id,
        ttl_seconds=row.ttl_seconds,
        created_at=row.created_at,
        completed_at=row.completed_at,
        expires_at=unix_ms_to_iso(row.expires_at * 1000),
    )


def _policy_override_view(row: DrivePolicyRow | None) -> DrivePolicyOverrideView | None:
    if row is None:
        return None
    return DrivePolicyOverrideView(
        quota_bytes=row.quota_bytes,
        max_file_bytes=row.max_file_bytes,
        default_ttl_seconds=row.default_ttl_seconds,
        max_ttl_seconds=row.max_ttl_seconds,
        updated_by=row.updated_by,
        updated_at=row.updated_at,
    )


def _to_override(row: DrivePolicyRow | None) -> DrivePolicyOverride | None:
    if row is None:
        return None
    return DrivePolicyOverride(
        quota_bytes=row.quota_bytes,
        max_file_bytes=row.max_file_bytes,
        default_ttl_seconds=row.default_ttl_seconds,
        max_ttl_seconds=row.max_ttl_seconds,
    )


class DriveService:
    """Quota-limited cloud drive & large-file S3 presigned transfer orchestration."""

    def __init__(
        self,
        *,
        settings: ControlSettings,
        repo: ControlRepository,
        redis_store: RedisControlStore,
        object_store: ObjectStorePort | None = None,
        clock: Callable[[], int] | None = None,
    ) -> None:
        self._settings = settings
        self._repo = repo
        self._redis = redis_store
        self._objects = object_store
        self._now = clock or (lambda: int(time.time()))

    @property
    def enabled(self) -> bool:
        return self._objects is not None

    def _require_store(self) -> ObjectStorePort:
        if self._objects is None:
            raise UpstreamUnavailableError(
                "cloud drive object storage is not configured",
                code="drive_not_configured",
            )
        return self._objects

    async def _effective_entitlements(
        self,
        user_id: str,
        direct_entitlements: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        if direct_entitlements is not None:
            return merge_entitlements(self._settings.default_entitlements, direct_entitlements)
        cached = await self._redis.get_user_entitlements(user_id)
        return merge_entitlements(self._settings.default_entitlements, cached)

    async def get_quota(
        self,
        *,
        user_id: str,
        entitlements: Mapping[str, Any] | None = None,
    ) -> DriveQuotaView:
        now = self._now()
        override_row = await self._repo.get_drive_policy(user_id)
        merged_ent = await self._effective_entitlements(user_id, entitlements)
        policy = resolve_drive_policy(
            defaults=self._settings.drive.policy_defaults(),
            entitlements=merged_ent,
            override=_to_override(override_row),
        )
        usage = await self._repo.get_drive_usage(user_id, now_ts=now)
        remaining: int | None = None
        if policy.quota_bytes is not None:
            remaining = max(0, policy.quota_bytes - usage.used_bytes - usage.reserved_bytes)
        return DriveQuotaView(
            enabled=self.enabled,
            rpc_direct_max_bytes=policy.rpc_direct_max_bytes,
            quota_bytes=policy.quota_bytes,
            used_bytes=usage.used_bytes,
            reserved_bytes=usage.reserved_bytes,
            remaining_bytes=remaining,
            max_file_bytes=policy.max_file_bytes,
            default_ttl_seconds=policy.default_ttl_seconds,
            max_ttl_seconds=policy.max_ttl_seconds,
            file_count=usage.file_count,
            policy_source=policy.source,
        )

    async def create_upload(
        self,
        *,
        caller: DriveCaller,
        req: CreateDriveUploadRequest,
    ) -> CreateDriveUploadResponse:
        store = self._require_store()
        now = self._now()

        # 1. Validate encryption metadata & enforce zero-plaintext-metadata invariant for encrypted modes.
        filename: str | None = None
        mime_type: str | None = None
        encryption_nonce: str | None = None
        encryption_key_version: int | None = None
        encrypted_meta: str | None = None

        if req.encryption_mode == "account_dek":
            if not req.encryption_nonce or not NONCE_B64_RE.match(req.encryption_nonce):
                raise ValidationError("account_dek encryption requires a valid encryption_nonce")
            if req.encryption_key_version is None or req.encryption_key_version < 1:
                raise ValidationError("account_dek encryption requires encryption_key_version >= 1")
            if not req.encrypted_meta or not req.encrypted_meta.strip():
                raise ValidationError("account_dek encryption requires encrypted_meta")
            encryption_nonce = req.encryption_nonce
            encryption_key_version = req.encryption_key_version
            encrypted_meta = req.encrypted_meta.strip()
        elif req.encryption_mode == "ephemeral_key":
            if not req.encryption_nonce or not NONCE_B64_RE.match(req.encryption_nonce):
                raise ValidationError("ephemeral_key encryption requires a valid encryption_nonce")
            encryption_nonce = req.encryption_nonce
            encrypted_meta = req.encrypted_meta.strip() if req.encrypted_meta and req.encrypted_meta.strip() else None
        else:
            filename = sanitize_filename(req.filename)
            mime_type = req.mime_type.strip()[:128] if req.mime_type and req.mime_type.strip() else None

        # 2. Validate VFS path rules.
        vfs_path: str | None = None
        if req.purpose == "assistant_vfs":
            if req.vfs_path is not None:
                vfs_path = normalize_vfs_path(req.vfs_path)
            elif req.encryption_mode == "none":
                raise ValidationError("vfs_path is required for unencrypted assistant_vfs uploads")

        # 3. Resolve effective policy and enforce single-file limit, total quota, and TTL cap.
        override_row = await self._repo.get_drive_policy(caller.user_id)
        merged_ent = await self._effective_entitlements(caller.user_id, caller.entitlements)
        policy = resolve_drive_policy(
            defaults=self._settings.drive.policy_defaults(),
            entitlements=merged_ent,
            override=_to_override(override_row),
        )

        if policy.max_file_bytes is not None and req.size_bytes > policy.max_file_bytes:
            raise PayloadTooLargeError(
                f"file size {req.size_bytes} exceeds maximum allowed ({policy.max_file_bytes} bytes)",
                code="file_too_large",
            )

        ttl_seconds = policy.default_ttl_seconds if req.ttl_seconds is None else req.ttl_seconds
        if ttl_seconds > policy.max_ttl_seconds:
            raise ValidationError(
                f"ttl_seconds {ttl_seconds} exceeds maximum allowed ({policy.max_ttl_seconds} seconds)"
            )

        usage = await self._repo.get_drive_usage(caller.user_id, now_ts=now)
        if policy.quota_bytes is not None and (usage.used_bytes + usage.reserved_bytes + req.size_bytes) > policy.quota_bytes:
            raise ForbiddenError(
                f"cloud drive quota exceeded ({policy.quota_bytes} bytes allowed)",
                code="drive_quota_exceeded",
            )

        # 4. Reserve pending metadata row and issue SigV4 presigned PUT URL (signed Content-Length).
        file_id = f"drv_{secrets.token_hex(12)}"
        object_key = store.build_object_key(user_id=caller.user_id, purpose=req.purpose, file_id=file_id)
        upload_ttl = self._settings.drive.upload_url_ttl_seconds
        upload_content_type = mime_type if req.encryption_mode == "none" else "application/octet-stream"
        upload_target = await store.presign_upload(
            object_key=object_key,
            size_bytes=req.size_bytes,
            content_type=upload_content_type,
            expires_seconds=upload_ttl,
        )
        row = await self._repo.create_drive_file(
            file_id=file_id,
            user_id=caller.user_id,
            purpose=req.purpose,
            object_key=object_key,
            size_bytes=req.size_bytes,
            sha256=req.sha256,
            filename=filename,
            mime_type=mime_type,
            vfs_path=vfs_path,
            encryption_mode=req.encryption_mode,
            encryption_nonce=encryption_nonce,
            encryption_key_version=encryption_key_version,
            encrypted_meta=encrypted_meta,
            source_device_id=caller.device_id,
            ttl_seconds=ttl_seconds,
            upload_expires_at=now + upload_ttl,
            expires_at=now + ttl_seconds,
        )
        return CreateDriveUploadResponse(file=_file_view(row), upload=upload_target)

    async def complete_upload(
        self,
        *,
        caller: DriveCaller,
        file_id: str,
        req: CompleteDriveUploadRequest,
    ) -> DriveFileView:
        store = self._require_store()
        now = self._now()
        row = await self._require_owned_file(user_id=caller.user_id, file_id=file_id)

        if row.status == "ready":
            if row.expires_at <= now:
                raise NotFoundError("file has expired")
            return _file_view(row)

        if row.upload_expires_at <= now:
            await self._safe_delete_object(store, row.object_key)
            await self._repo.delete_drive_file(row.id)
            raise ValidationError("upload reservation has expired", code="upload_expired")

        head = await store.head_object(row.object_key)
        if head is None:
            raise ValidationError("uploaded object not found in storage", code="upload_not_found")
        if head.size_bytes != row.size_bytes:
            await self._safe_delete_object(store, row.object_key)
            await self._repo.delete_drive_file(row.id)
            raise ValidationError(
                f"uploaded object size mismatch (expected {row.size_bytes}, got {head.size_bytes})",
                code="upload_size_mismatch",
            )

        updated = await self._repo.mark_drive_file_ready(
            file_id=row.id,
            etag=head.etag or req.etag,
            expires_at=now + row.ttl_seconds,
        )
        assert updated is not None

        # When overwriting an assistant_vfs path, reclaim older versions promptly.
        if updated.purpose == "assistant_vfs" and updated.vfs_path is not None:
            superseded = await self._repo.list_superseded_vfs_files(
                user_id=caller.user_id,
                vfs_path=updated.vfs_path,
                exclude_file_id=updated.id,
            )
            for old in superseded:
                if await self._safe_delete_object(store, old.object_key):
                    await self._repo.delete_drive_file(old.id)

        await self._repo.record_audit(
            user_id=caller.user_id,
            actor=caller.actor,
            action="drive.upload_complete",
            device_id=caller.device_id,
            metadata={
                "file_id": updated.id,
                "purpose": updated.purpose,
                "size_bytes": updated.size_bytes,
                "encryption_mode": updated.encryption_mode,
            },
        )
        return _file_view(updated)

    async def list_files(
        self,
        *,
        caller: DriveCaller,
        purpose: DrivePurpose | None = None,
        vfs_prefix: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> ListDriveFilesResponse:
        now = self._now()
        cleaned_prefix: str | None = None
        if vfs_prefix is not None and vfs_prefix.strip():
            cleaned_prefix = normalize_vfs_path(vfs_prefix)
        rows = await self._repo.list_drive_files(
            caller.user_id,
            now_ts=now,
            purpose=purpose,
            vfs_prefix=cleaned_prefix,
            limit=max(1, min(200, limit)),
            offset=max(0, offset),
        )
        quota = await self.get_quota(user_id=caller.user_id, entitlements=caller.entitlements)
        return ListDriveFilesResponse(files=[_file_view(r) for r in rows], quota=quota)

    async def get_file(self, *, caller: DriveCaller, file_id: str) -> DriveFileView:
        now = self._now()
        row = await self._require_owned_file(user_id=caller.user_id, file_id=file_id)
        if row.status != "ready" or row.expires_at <= now:
            raise NotFoundError(f"file {file_id} is unavailable or expired")
        return _file_view(row)

    async def create_download_url(
        self,
        *,
        caller: DriveCaller,
        file_id: str,
    ) -> DriveDownloadUrlResponse:
        store = self._require_store()
        now = self._now()
        row = await self._require_owned_file(user_id=caller.user_id, file_id=file_id)
        if row.status != "ready" or row.expires_at <= now:
            raise NotFoundError(f"file {file_id} is unavailable or expired")
        is_plain = row.encryption_mode == "none"
        target = await store.presign_download(
            object_key=row.object_key,
            filename=row.filename if is_plain else None,
            content_type=(row.mime_type if is_plain else "application/octet-stream"),
            expires_seconds=self._settings.drive.download_url_ttl_seconds,
        )
        return DriveDownloadUrlResponse(file=_file_view(row), download=target)

    async def delete_file(self, *, caller: DriveCaller, file_id: str) -> bool:
        row = await self._require_owned_file(user_id=caller.user_id, file_id=file_id)
        if self._objects is not None:
            await self._objects.delete_object(row.object_key)
        deleted = await self._repo.delete_drive_file(row.id)
        if deleted:
            await self._repo.record_audit(
                user_id=caller.user_id,
                actor=caller.actor,
                action="drive.delete",
                device_id=caller.device_id,
                metadata={"file_id": row.id, "purpose": row.purpose, "size_bytes": row.size_bytes},
            )
        return deleted

    async def cleanup_expired(self, *, limit: int = 100) -> int:
        now = self._now()
        expired = await self._repo.list_expired_drive_files(now_ts=now, limit=limit)
        removed = 0
        for row in expired:
            if self._objects is not None:
                if not await self._safe_delete_object(self._objects, row.object_key):
                    continue
            if await self._repo.delete_drive_file(row.id):
                removed += 1
        return removed

    # ------------------------------------------------------------------
    # Admin per-account policy overrides
    # ------------------------------------------------------------------

    async def get_admin_policy(self, *, target_user_id: str) -> AdminDrivePolicyResponse:
        user = await self._repo.get_user_by_id(target_user_id)
        if user is None:
            raise NotFoundError(f"user {target_user_id} not found")
        override = await self._repo.get_drive_policy(target_user_id)
        effective = await self.get_quota(user_id=target_user_id)
        return AdminDrivePolicyResponse(
            user_id=target_user_id,
            override=_policy_override_view(override),
            effective=effective,
        )

    async def update_admin_policy(
        self,
        *,
        target_user_id: str,
        req: UpdateDrivePolicyRequest,
        admin_user_id: str,
    ) -> AdminDrivePolicyResponse:
        user = await self._repo.get_user_by_id(target_user_id)
        if user is None:
            raise NotFoundError(f"user {target_user_id} not found")
        if (
            req.default_ttl_seconds is not None
            and req.max_ttl_seconds is not None
            and req.max_ttl_seconds < req.default_ttl_seconds
        ):
            raise ValidationError("max_ttl_seconds must be >= default_ttl_seconds")
        override = await self._repo.upsert_drive_policy(
            user_id=target_user_id,
            quota_bytes=req.quota_bytes,
            max_file_bytes=req.max_file_bytes,
            default_ttl_seconds=req.default_ttl_seconds,
            max_ttl_seconds=req.max_ttl_seconds,
            updated_by=admin_user_id,
        )
        await self._repo.record_audit(
            user_id=target_user_id,
            actor=f"user:{admin_user_id}",
            action="admin.drive_policy_update",
            metadata={
                "quota_bytes": req.quota_bytes,
                "max_file_bytes": req.max_file_bytes,
                "default_ttl_seconds": req.default_ttl_seconds,
                "max_ttl_seconds": req.max_ttl_seconds,
            },
        )
        effective = await self.get_quota(user_id=target_user_id)
        return AdminDrivePolicyResponse(
            user_id=target_user_id,
            override=_policy_override_view(override),
            effective=effective,
        )

    async def delete_admin_policy(
        self,
        *,
        target_user_id: str,
        admin_user_id: str,
    ) -> AdminDrivePolicyResponse:
        user = await self._repo.get_user_by_id(target_user_id)
        if user is None:
            raise NotFoundError(f"user {target_user_id} not found")
        await self._repo.delete_drive_policy(target_user_id)
        await self._repo.record_audit(
            user_id=target_user_id,
            actor=f"user:{admin_user_id}",
            action="admin.drive_policy_reset",
        )
        effective = await self.get_quota(user_id=target_user_id)
        return AdminDrivePolicyResponse(user_id=target_user_id, override=None, effective=effective)

    async def _require_owned_file(self, *, user_id: str, file_id: str) -> DriveFileRow:
        row = await self._repo.get_drive_file(file_id)
        if row is None:
            raise NotFoundError(f"file {file_id} not found")
        if row.user_id != user_id:
            raise ForbiddenError("file belongs to another account")
        return row

    @staticmethod
    async def _safe_delete_object(store: ObjectStorePort, object_key: str) -> bool:
        try:
            return await store.delete_object(object_key)
        except UpstreamUnavailableError as exc:
            logger.warning("object store delete failed for key={} err={}", object_key, exc)
            return False
