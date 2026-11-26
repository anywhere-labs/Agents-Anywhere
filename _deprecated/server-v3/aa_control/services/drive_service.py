from __future__ import annotations

import secrets
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from loguru import logger

from aa_control.core.config import ControlSettings
from aa_control.core.drive import (
    DRIVE_ROOT,
    NONCE_B64_RE,
    ORCHES_FOLDER,
    DrivePolicyOverride,
    default_transfer_path,
    drive_basename,
    format_drive_ref,
    is_orches_path,
    is_within_drive_path,
    join_drive_path,
    normalize_drive_path,
    normalize_vfs_path,
    orches_drive_path,
    parse_drive_ref,
    resolve_drive_policy,
    safe_drive_name,
    sanitize_filename,
    system_folder_kind,
)
from aa_control.core.entitlements import merge_entitlements
from aa_control.core.errors import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    PayloadTooLargeError,
    UpstreamUnavailableError,
    ValidationError,
)
from aa_control.core.models import (
    AdminDrivePolicyResponse,
    CompleteDriveUploadRequest,
    CreateDriveFolderRequest,
    CreateDriveUploadRequest,
    CreateDriveUploadResponse,
    DriveConflictPolicy,
    DriveDownloadUrlResponse,
    DriveEntriesResponse,
    DriveFileView,
    DriveFolderDeleteResponse,
    DriveFolderMoveResponse,
    DriveFolderView,
    DrivePolicyOverrideView,
    DrivePurpose,
    DriveQuotaView,
    DriveResolveResponse,
    ListDriveFilesResponse,
    MoveDriveEntryRequest,
    UpdateDrivePolicyRequest,
)
from aa_control.core.utc import unix_ms_to_iso
from aa_control.infra.db.repositories import (
    ControlRepository,
    DriveFileRow,
    DriveFolderRow,
    DrivePolicyRow,
)
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
        path=row.path,
        name=drive_basename(row.path),
        parent_path=row.parent_path,
        ref=format_drive_ref(row.path),
        managed=is_orches_path(row.path),
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


def _folder_view(row: DriveFolderRow) -> DriveFolderView:
    return DriveFolderView(
        id=row.id,
        path=row.path,
        name=drive_basename(row.path),
        parent_path=row.parent_path,
        ref=format_drive_ref(row.path),
        system=system_folder_kind(row.path),  # type: ignore[arg-type]
        managed=is_orches_path(row.path),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _managed_error(path: str) -> ConflictError:
    return ConflictError(
        f"{ORCHES_FOLDER} is Orches' workspace and only Orches' own sync writes there ({path})",
        code="drive_managed_path",
    )


# Objects removed right away after a delete; anything beyond waits for the cleanup worker.
_IMMEDIATE_PURGE_LIMIT = 100


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

        # 2b. Decide where the file lands in the drive filesystem (settled again on completion).
        file_id = f"drv_{secrets.token_hex(12)}"
        target_path, on_conflict = await self._upload_target(
            caller=caller,
            req=req,
            file_id=file_id,
            filename=filename,
            vfs_path=vfs_path,
            now=now,
        )
        if req.purpose == "transfer" and req.encryption_mode == "none" and (filename is not None or req.path):
            # A plaintext transfer file is downloaded under the name it has in the drive.
            filename = drive_basename(target_path)

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
            path=target_path,
            on_conflict=on_conflict,
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

        orches = row.purpose == "assistant_vfs"
        if orches and req.on_conflict is not None:
            raise ValidationError(
                "assistant_vfs uploads settle their path by vfs_path; on_conflict is not accepted",
                code="drive_invalid_path",
            )
        policy = req.on_conflict or row.on_conflict or ("replace" if orches and row.vfs_path else "rename")
        placement = await self._repo.place_drive_file(
            file_id=row.id,
            user_id=caller.user_id,
            target_path=row.path,
            on_conflict=policy,
            # An Orches file whose mirrored path is blocked (a folder there, a file above it) still syncs.
            fallback_path=join_drive_path(ORCHES_FOLDER, row.id) if orches else None,
            now_ts=now,
            etag=head.etag or req.etag,
            expires_at=now + row.ttl_seconds,
            rename_filename=(row.purpose == "transfer" and row.encryption_mode == "none" and row.filename is not None),
            # Overwriting an Orches vfs_path supersedes its older versions; their objects are reclaimed now.
            supersede_vfs_path=row.vfs_path if orches else None,
        )
        if placement is None:
            raise NotFoundError(f"file {file_id} not found")
        updated = placement.file
        await self._purge_objects(placement.superseded)

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
        """Delete one file (or abandon a pending upload). It disappears at once; its object is removed right away
        when storage answers, otherwise by the cleanup worker."""
        row = await self._require_owned_file(user_id=caller.user_id, file_id=file_id)
        deleted = await self._repo.mark_drive_files_deleted([row.id]) > 0
        if deleted:
            await self._purge_objects([row])
            await self._repo.record_audit(
                user_id=caller.user_id,
                actor=caller.actor,
                action="drive.delete",
                device_id=caller.device_id,
                metadata={"file_id": row.id, "purpose": row.purpose, "size_bytes": row.size_bytes},
            )
        return deleted

    async def cleanup_expired(self, *, limit: int = 100, max_batches: int = 10) -> int:
        """Remove objects and rows of soft-deleted files, expired files and abandoned upload reservations."""
        removed = 0
        for _ in range(max_batches):
            batch = await self._repo.list_expired_drive_files(now_ts=self._now(), limit=limit)
            batch_removed = 0
            for row in batch:
                if self._objects is not None:
                    if not await self._safe_delete_object(self._objects, row.object_key):
                        continue
                if await self._repo.delete_drive_file(row.id):
                    batch_removed += 1
            removed += batch_removed
            if batch_removed == 0 or len(batch) < limit:
                break
        return removed

    async def purge_account_dek_files(self, *, user_id: str, actor: str) -> int:
        """Delete all drive files encrypted under the account's assistant DEK (used during encryption reset)."""
        files = await self._repo.list_account_dek_drive_files(user_id)
        if not files:
            return 0
        purged = await self._repo.mark_drive_files_deleted([item.id for item in files])
        await self._purge_objects(files)
        if purged:
            await self._repo.record_audit(
                user_id=user_id,
                actor=actor,
                action="drive.purge_account_dek",
                metadata={"purged_files": purged},
            )
        return purged

    # ------------------------------------------------------------------
    # Drive filesystem: placement, listing, folders, moves, references
    # ------------------------------------------------------------------

    async def _upload_target(
        self,
        *,
        caller: DriveCaller,
        req: CreateDriveUploadRequest,
        file_id: str,
        filename: str | None,
        vfs_path: str | None,
        now: int,
    ) -> tuple[str, DriveConflictPolicy]:
        """Target path and conflict policy of a new upload (see CreateDriveUploadRequest)."""
        if req.purpose == "assistant_vfs":
            if req.path is not None or req.folder is not None:
                raise ValidationError(
                    "assistant_vfs uploads land at /Orches/<vfs_path>; path and folder are not accepted",
                    code="drive_invalid_path",
                )
            if req.on_conflict is not None:
                raise ValidationError(
                    "assistant_vfs uploads always replace the previous version of their vfs_path",
                    code="drive_invalid_path",
                )
            return orches_drive_path(vfs_path, file_id), ("replace" if vfs_path else "rename")

        if req.path is not None and req.folder is not None:
            raise ValidationError("give either path or folder, not both", code="drive_invalid_path")
        if req.path is not None:
            if req.encryption_mode != "none":
                raise ValidationError(
                    "an encrypted upload cannot name its file on the server; give folder instead of path",
                    code="drive_encrypted_name",
                )
            target = normalize_drive_path(req.path)
            if target == DRIVE_ROOT:
                raise ValidationError("path must name a file, not the root folder", code="drive_invalid_path")
        elif req.folder is not None:
            target = join_drive_path(normalize_drive_path(req.folder), safe_drive_name(filename, file_id))
        else:
            target = default_transfer_path(filename, file_id)
        if is_orches_path(target):
            raise _managed_error(target)
        policy: DriveConflictPolicy = req.on_conflict or "rename"
        await self._check_target(caller.user_id, target, policy, now)
        return target, policy

    async def _check_target(self, user_id: str, path: str, policy: DriveConflictPolicy, now: int) -> None:
        """Early 409s for an upload whose target is already blocked (completion checks again)."""
        probe = await self._repo.probe_drive_path(user_id, path, now_ts=now)
        if probe.blocking_file is not None:
            raise ConflictError(
                f"{probe.blocking_file} is a file, so nothing can be placed inside it",
                code="drive_parent_is_file",
            )
        if probe.kind == "folder" and policy != "rename":
            raise ConflictError(f"a folder already exists at {path}", code="drive_path_conflict")
        if probe.kind == "file" and policy == "fail":
            raise ConflictError(f"a file already exists at {path}", code="drive_path_conflict")

    async def list_entries(
        self,
        *,
        caller: DriveCaller,
        path: str = DRIVE_ROOT,
        limit: int = 200,
        offset: int = 0,
    ) -> DriveEntriesResponse:
        """Direct children of one folder: all subfolders, then live files (paged, each with its expiry)."""
        now = self._now()
        folder_path = normalize_drive_path(path)
        folder_row: DriveFolderRow | None = None
        if folder_path != DRIVE_ROOT:
            folder_row = await self._repo.get_drive_folder_by_path(caller.user_id, folder_path)
            if folder_row is None:
                if await self._repo.get_live_drive_file_by_path(caller.user_id, folder_path, now_ts=now):
                    raise ValidationError(f"{folder_path} is a file, not a folder", code="drive_not_a_folder")
                raise NotFoundError(f"no folder at {folder_path}", code="drive_path_not_found")
        folders, files, total = await self._repo.list_drive_children(
            caller.user_id,
            parent_path=folder_path,
            now_ts=now,
            limit=max(1, min(1000, limit)),
            offset=max(0, offset),
        )
        quota = await self.get_quota(user_id=caller.user_id, entitlements=caller.entitlements)
        return DriveEntriesResponse(
            path=folder_path,
            ref=format_drive_ref(folder_path),
            folder=_folder_view(folder_row) if folder_row is not None else None,
            folders=[_folder_view(r) for r in folders],
            files=[_file_view(r) for r in files],
            total_files=total,
            quota=quota,
        )

    async def create_folder(
        self,
        *,
        caller: DriveCaller,
        req: CreateDriveFolderRequest,
    ) -> tuple[DriveFolderView, bool]:
        """Create a folder and any missing parents; returns the folder and whether it is new."""
        self._require_store()
        path = normalize_drive_path(req.path)
        if path == DRIVE_ROOT:
            raise ValidationError("the root folder always exists", code="drive_invalid_path")
        if is_orches_path(path):
            raise _managed_error(path)
        row, created = await self._repo.create_drive_folder(
            user_id=caller.user_id,
            path=path,
            exist_ok=req.exist_ok,
            now_ts=self._now(),
        )
        if created:
            await self._repo.record_audit(
                user_id=caller.user_id,
                actor=caller.actor,
                action="drive.folder_create",
                device_id=caller.device_id,
                metadata={"folder_id": row.id},
            )
        return _folder_view(row), created

    async def move_file(
        self,
        *,
        caller: DriveCaller,
        file_id: str,
        req: MoveDriveEntryRequest,
    ) -> DriveFileView:
        """Rename and/or move a ready file. Its TTL, content and id stay the same."""
        now = self._now()
        row = await self._require_owned_file(user_id=caller.user_id, file_id=file_id)
        if row.status != "ready" or row.expires_at <= now:
            raise NotFoundError(f"file {file_id} is unavailable or expired")
        new_path = normalize_drive_path(req.path)
        if new_path == DRIVE_ROOT:
            raise ValidationError("path must name the file, not the root folder", code="drive_invalid_path")
        if is_orches_path(row.path):
            raise _managed_error(row.path)
        if is_orches_path(new_path):
            raise _managed_error(new_path)
        if row.encryption_mode != "none" and drive_basename(new_path) != drive_basename(row.path):
            raise ValidationError(
                "an encrypted file keeps its server-side name; it can move to another folder but not be renamed",
                code="drive_encrypted_name",
            )
        moved = await self._repo.move_drive_file(
            file_id=row.id,
            user_id=caller.user_id,
            new_path=new_path,
            now_ts=now,
            rename_filename=row.purpose == "transfer" and row.encryption_mode == "none",
        )
        if moved is None:
            raise NotFoundError(f"file {file_id} is unavailable or expired")
        if moved.path != row.path:
            await self._repo.record_audit(
                user_id=caller.user_id,
                actor=caller.actor,
                action="drive.move",
                device_id=caller.device_id,
                metadata={"file_id": row.id},
            )
        return _file_view(moved)

    async def move_folder(
        self,
        *,
        caller: DriveCaller,
        folder_id: str,
        req: MoveDriveEntryRequest,
    ) -> DriveFolderMoveResponse:
        """Rename and/or move a folder; its whole subtree follows."""
        folder = await self._require_owned_folder(user_id=caller.user_id, folder_id=folder_id)
        new_path = normalize_drive_path(req.path)
        if new_path == DRIVE_ROOT:
            raise ValidationError("a folder cannot become the root folder", code="drive_invalid_path")
        if system_folder_kind(folder.path) is not None:
            raise ConflictError(
                f"{folder.path} is created by the server and cannot be renamed or moved",
                code="drive_system_folder",
            )
        if is_orches_path(folder.path):
            raise _managed_error(folder.path)
        if is_orches_path(new_path):
            raise _managed_error(new_path)
        if new_path != folder.path and is_within_drive_path(new_path, folder.path):
            raise ValidationError(f"cannot move {folder.path} into itself", code="drive_move_into_self")
        result = await self._repo.move_drive_folder(
            folder_id=folder.id,
            user_id=caller.user_id,
            new_path=new_path,
            now_ts=self._now(),
        )
        if result is None:
            raise NotFoundError(f"folder {folder_id} not found", code="drive_folder_not_found")
        if result.moved_folders:
            await self._repo.record_audit(
                user_id=caller.user_id,
                actor=caller.actor,
                action="drive.folder_move",
                device_id=caller.device_id,
                metadata={
                    "folder_id": folder.id,
                    "moved_folders": result.moved_folders,
                    "moved_files": result.moved_files,
                },
            )
        return DriveFolderMoveResponse(
            folder=_folder_view(result.folder),
            moved_folders=result.moved_folders,
            moved_files=result.moved_files,
        )

    async def delete_folder(self, *, caller: DriveCaller, folder_id: str) -> DriveFolderDeleteResponse:
        """Delete a folder with everything in it (pending uploads into it are cancelled)."""
        await self._require_owned_folder(user_id=caller.user_id, folder_id=folder_id)
        now = self._now()
        result = await self._repo.soft_delete_drive_folder(folder_id=folder_id, user_id=caller.user_id, now_ts=now)
        if result is None:
            raise NotFoundError(f"folder {folder_id} not found", code="drive_folder_not_found")
        await self._purge_objects(result.deleted_files)
        live_files = sum(1 for r in result.deleted_files if r.status == "ready" and r.expires_at > now)
        await self._repo.record_audit(
            user_id=caller.user_id,
            actor=caller.actor,
            action="drive.folder_delete",
            device_id=caller.device_id,
            metadata={
                "folder_id": folder_id,
                "deleted_folders": result.deleted_folders,
                "deleted_files": len(result.deleted_files),
            },
        )
        return DriveFolderDeleteResponse(
            ok=True,
            deleted_folders=result.deleted_folders,
            deleted_files=live_files,
        )

    async def resolve(
        self,
        *,
        caller: DriveCaller,
        path: str | None = None,
        ref: str | None = None,
    ) -> DriveResolveResponse:
        """Resolve a path or a `drive:/…` reference to the folder or live file it names."""
        if (path is None) == (ref is None):
            raise ValidationError("give exactly one of path or ref", code="drive_invalid_path")
        target = parse_drive_ref(ref) if ref is not None else normalize_drive_path(path or "")
        target_ref = format_drive_ref(target)
        if target == DRIVE_ROOT:
            return DriveResolveResponse(kind="folder", path=target, ref=target_ref)
        folder = await self._repo.get_drive_folder_by_path(caller.user_id, target)
        if folder is not None:
            return DriveResolveResponse(kind="folder", path=target, ref=target_ref, folder=_folder_view(folder))
        found = await self._repo.get_live_drive_file_by_path(caller.user_id, target, now_ts=self._now())
        if found is not None:
            return DriveResolveResponse(kind="file", path=target, ref=target_ref, file=_file_view(found))
        raise NotFoundError(f"nothing at {target}", code="drive_path_not_found")

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
        if row is None or row.status == "deleted":
            raise NotFoundError(f"file {file_id} not found")
        if row.user_id != user_id:
            raise ForbiddenError("file belongs to another account")
        return row

    async def _require_owned_folder(self, *, user_id: str, folder_id: str) -> DriveFolderRow:
        row = await self._repo.get_drive_folder(folder_id)
        if row is None:
            raise NotFoundError(f"folder {folder_id} not found", code="drive_folder_not_found")
        if row.user_id != user_id:
            raise ForbiddenError("folder belongs to another account")
        return row

    async def _purge_objects(self, rows: Sequence[DriveFileRow]) -> int:
        """Remove the objects of soft-deleted files now, then their rows. Best effort and bounded: whatever is
        left (storage errors, very large deletes) stays soft-deleted for the cleanup worker."""
        purged = 0
        for row in rows[:_IMMEDIATE_PURGE_LIMIT]:
            if self._objects is not None and not await self._safe_delete_object(self._objects, row.object_key):
                continue
            if await self._repo.delete_drive_file(row.id):
                purged += 1
        return purged

    @staticmethod
    async def _safe_delete_object(store: ObjectStorePort, object_key: str) -> bool:
        try:
            return await store.delete_object(object_key)
        except UpstreamUnavailableError as exc:
            logger.warning("object store delete failed for key={} err={}", object_key, exc)
            return False
