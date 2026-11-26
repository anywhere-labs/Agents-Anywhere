from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager
from typing import Any

from aa_control.core.assistant import (
    TokensDecryptError,
    decrypt_tokens_secret,
    encrypt_tokens_secret,
    hash_tokens_key,
    measure_encrypted_conversation_size,
    measure_plaintext_conversation_size,
    serialize_json_compact,
    tokens_key_prefix,
    validate_b64_token,
    validate_conversation_id,
    validate_key_envelope_input,
    validate_tokens_api_key,
)
from aa_control.core.config import ControlSettings
from aa_control.core.errors import (
    ConflictError,
    NotFoundError,
    PayloadTooLargeError,
    ValidationError,
)
from aa_control.core.models import (
    AssistantConversationDetail,
    AssistantConversationMeta,
    AssistantEncryptionStatusResponse,
    AssistantKeyEnvelopeView,
    AssistantStreamEvent,
    AssistantTokensView,
    DeleteAssistantTokensResponse,
    ListAssistantConversationsResponse,
    PutAssistantConversationRequest,
    PutAssistantKeyEnvelopeRequest,
    PutAssistantTokensRequest,
    ResetAssistantEncryptionRequest,
    ResetAssistantEncryptionResponse,
)
from aa_control.core.utc import unix_ms_to_iso
from aa_control.infra.db.repositories import (
    AssistantConversationMetaRow,
    AssistantConversationRow,
    AssistantKeyEnvelopeRow,
    AssistantTokensConnectionRow,
    ControlRepository,
)
from aa_control.infra.redis_store import AssistantEventSubscription, RedisControlStore
from aa_control.infra.tokens_client import TokensAnywhereClientPort
from aa_control.services.drive_service import DriveService


def _meta_view(row: AssistantConversationMetaRow) -> AssistantConversationMeta:
    return AssistantConversationMeta(
        id=row.conversation_id,
        encrypted=row.encrypted,
        title=row.title if not row.encrypted else None,
        encrypted_meta=row.encrypted_meta if row.encrypted else None,
        meta_nonce=row.meta_nonce if row.encrypted else None,
        key_version=row.key_version if row.encrypted else None,
        dek_epoch=row.dek_epoch if row.encrypted else None,
        updated_at=row.updated_at,
        hash=row.content_hash,
        device=row.device,
        size=row.size_bytes,
    )


def _detail_view(row: AssistantConversationRow) -> AssistantConversationDetail:
    if row.encrypted:
        return AssistantConversationDetail(
            id=row.conversation_id,
            encrypted=True,
            title=None,
            encrypted_meta=row.encrypted_meta,
            meta_nonce=row.meta_nonce,
            key_version=row.key_version,
            dek_epoch=row.dek_epoch,
            updated_at=row.updated_at,
            hash=row.content_hash,
            device=row.device,
            size=row.size_bytes,
            nonce=row.nonce,
            ciphertext=row.ciphertext,
        )
    return AssistantConversationDetail(
        id=row.conversation_id,
        encrypted=False,
        title=row.title,
        updated_at=row.updated_at,
        hash=row.content_hash,
        device=row.device,
        size=row.size_bytes,
        settings=json.loads(row.settings_json) if row.settings_json is not None else None,
        messages=json.loads(row.messages_json) if row.messages_json is not None else [],
    )


def _envelope_view(row: AssistantKeyEnvelopeRow) -> AssistantKeyEnvelopeView:
    return AssistantKeyEnvelopeView(
        kdf=row.kdf,  # type: ignore[arg-type]
        kdf_params=dict(row.kdf_params),
        salt=row.salt,
        wrap_alg=row.wrap_alg,  # type: ignore[arg-type]
        wrap_nonce=row.wrap_nonce,
        wrapped_dek=row.wrapped_dek,
        key_version=row.key_version,
        dek_epoch=row.dek_epoch,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class AssistantService:
    """Whole-conversation sync, account KEK/DEK key envelope, and Tokens Anywhere key reuse."""

    def __init__(
        self,
        *,
        settings: ControlSettings,
        repo: ControlRepository,
        redis_store: RedisControlStore,
        tokens_client: TokensAnywhereClientPort,
        drive_service: DriveService | None = None,
    ) -> None:
        self._settings = settings
        self._cfg = settings.assistant
        self._repo = repo
        self._redis = redis_store
        self._tokens_client = tokens_client
        self._drive = drive_service

    @property
    def sse_heartbeat_seconds(self) -> float:
        return self._cfg.sse_heartbeat_seconds

    def open_events(self, user_id: str) -> AbstractAsyncContextManager[AssistantEventSubscription]:
        return self._redis.open_assistant_events(user_id)

    async def subscribe_events(self, user_id: str) -> AsyncIterator[AssistantStreamEvent]:
        async for ev in self._redis.subscribe_assistant_events(user_id):
            yield ev

    # ------------------------------------------------------------------
    # 1. Whole-conversation sync (GET list / GET one / PUT / DELETE)
    # ------------------------------------------------------------------

    async def list_conversations(self, user_id: str) -> ListAssistantConversationsResponse:
        rows = await self._repo.list_assistant_conversations(user_id)
        return ListAssistantConversationsResponse(
            conversations=[_meta_view(r) for r in rows],
            max_conversations=self._cfg.max_conversations,
            max_conversation_bytes=self._cfg.max_conversation_bytes,
        )

    async def get_conversation(
        self,
        *,
        user_id: str,
        conversation_id: str,
    ) -> AssistantConversationDetail:
        cid = validate_conversation_id(conversation_id)
        row = await self._repo.get_assistant_conversation(user_id=user_id, conversation_id=cid)
        if row is None:
            raise NotFoundError("assistant conversation not found")
        return _detail_view(row)

    async def put_conversation(
        self,
        *,
        user_id: str,
        conversation_id: str,
        req: PutAssistantConversationRequest,
    ) -> AssistantConversationMeta:
        cid = validate_conversation_id(conversation_id)
        envelope = await self._repo.get_assistant_key_envelope(user_id)

        messages_json: str | None = None
        settings_json: str | None = None
        title: str | None = None
        key_version: int | None = None
        dek_epoch: int | None = None
        nonce: str | None = None
        ciphertext: str | None = None
        encrypted_meta: str | None = None
        meta_nonce: str | None = None

        if req.encrypted:
            if envelope is None:
                raise ValidationError(
                    "assistant encryption is not enabled for this account",
                    code="encryption_not_enabled",
                )
            if (req.title is not None and req.title != "") or req.messages is not None or req.settings is not None:
                raise ValidationError(
                    "encrypted conversations must not include plaintext title, messages, or settings",
                    code="plaintext_not_allowed",
                )
            if not req.nonce or not req.ciphertext:
                raise ValidationError("encrypted conversations require nonce and ciphertext")
            if req.key_version is None:
                raise ValidationError("encrypted conversations require key_version")
            if req.key_version > envelope.key_version:
                raise ValidationError(
                    f"key_version {req.key_version} exceeds active envelope key_version {envelope.key_version}"
                )
            resolved_epoch = req.dek_epoch if req.dek_epoch is not None else envelope.dek_epoch
            if resolved_epoch != envelope.dek_epoch:
                raise ConflictError(
                    f"dek_epoch mismatch (got {resolved_epoch}, active {envelope.dek_epoch}); refresh key envelope",
                    code="dek_epoch_mismatch",
                )
            nonce = validate_b64_token(req.nonce, field_name="nonce", min_len=12, max_len=64)
            ciphertext = validate_b64_token(
                req.ciphertext,
                field_name="ciphertext",
                min_len=16,
                max_len=self._cfg.max_conversation_bytes + 4096,
            )
            if req.encrypted_meta is not None:
                if len(req.encrypted_meta.encode("utf-8")) > self._cfg.max_encrypted_meta_bytes:
                    raise PayloadTooLargeError(
                        f"encrypted_meta exceeds {self._cfg.max_encrypted_meta_bytes} bytes"
                    )
                encrypted_meta = validate_b64_token(
                    req.encrypted_meta,
                    field_name="encrypted_meta",
                    min_len=16,
                    max_len=self._cfg.max_encrypted_meta_bytes,
                )
            if req.meta_nonce is not None:
                meta_nonce = validate_b64_token(req.meta_nonce, field_name="meta_nonce", min_len=12, max_len=64)

            size_bytes = measure_encrypted_conversation_size(
                ciphertext=ciphertext,
                encrypted_meta=encrypted_meta,
            )
            if size_bytes > self._cfg.max_conversation_bytes:
                raise PayloadTooLargeError(
                    f"conversation exceeds maximum size of {self._cfg.max_conversation_bytes} bytes"
                )
            key_version = req.key_version
            dek_epoch = resolved_epoch
        else:
            if envelope is not None:
                raise ConflictError(
                    "account encryption is enabled; plaintext conversation uploads are rejected",
                    code="encryption_required",
                )
            if any(
                field is not None
                for field in (
                    req.ciphertext,
                    req.nonce,
                    req.encrypted_meta,
                    req.meta_nonce,
                    req.key_version,
                    req.dek_epoch,
                )
            ):
                raise ValidationError("plaintext conversations must not include encryption fields")
            if req.title is None or req.messages is None:
                raise ValidationError("plaintext conversations require title and messages")
            title = req.title
            messages_json = serialize_json_compact(req.messages)
            settings_json = serialize_json_compact(req.settings) if req.settings is not None else None
            size_bytes = measure_plaintext_conversation_size(
                messages_json=messages_json,
                settings_json=settings_json,
            )
            if size_bytes > self._cfg.max_conversation_bytes:
                raise PayloadTooLargeError(
                    f"conversation exceeds maximum size of {self._cfg.max_conversation_bytes} bytes"
                )

        row = await self._repo.upsert_assistant_conversation_and_trim(
            user_id=user_id,
            conversation_id=cid,
            encrypted=req.encrypted,
            title=title,
            updated_at=req.updated_at,
            content_hash=req.hash,
            device=req.device,
            size_bytes=size_bytes,
            messages_json=messages_json,
            settings_json=settings_json,
            key_version=key_version,
            dek_epoch=dek_epoch,
            nonce=nonce,
            ciphertext=ciphertext,
            encrypted_meta=encrypted_meta,
            meta_nonce=meta_nonce,
            max_conversations=self._cfg.max_conversations,
        )

        event_payload: dict[str, Any] = {
            "id": cid,
            "encrypted": row.encrypted,
            "hash": row.content_hash,
            "title": row.title if not row.encrypted else None,
            "updated_at": row.updated_at,
            "device": row.device,
            "size": row.size_bytes,
            "deleted": False,
        }
        if row.encrypted:
            event_payload["encrypted_meta"] = row.encrypted_meta
            event_payload["meta_nonce"] = row.meta_nonce
            event_payload["key_version"] = row.key_version
            event_payload["dek_epoch"] = row.dek_epoch

        await self._redis.publish_assistant_event(
            user_id,
            AssistantStreamEvent(event="assistant", payload=event_payload),
        )
        return _meta_view(row)

    async def delete_conversation(
        self,
        *,
        user_id: str,
        conversation_id: str,
        device: str = "",
    ) -> None:
        cid = validate_conversation_id(conversation_id)
        await self._repo.delete_assistant_conversation(user_id=user_id, conversation_id=cid)
        await self._redis.publish_assistant_event(
            user_id,
            AssistantStreamEvent(
                event="assistant",
                payload={
                    "id": cid,
                    "hash": None,
                    "title": None,
                    "device": device[:64],
                    "deleted": True,
                },
            ),
        )

    # ------------------------------------------------------------------
    # 2. Account-level KEK/DEK key envelope (any-password multi-device E2EE)
    # ------------------------------------------------------------------

    async def get_encryption_status(self, user_id: str) -> AssistantEncryptionStatusResponse:
        row = await self._repo.get_assistant_key_envelope(user_id)
        if row is None:
            return AssistantEncryptionStatusResponse(enabled=False, envelope=None)
        return AssistantEncryptionStatusResponse(enabled=True, envelope=_envelope_view(row))

    async def put_key_envelope(
        self,
        *,
        user_id: str,
        req: PutAssistantKeyEnvelopeRequest,
    ) -> AssistantEncryptionStatusResponse:
        validated = validate_key_envelope_input(
            kdf=req.kdf,
            kdf_params=req.kdf_params,
            salt=req.salt,
            wrap_alg=req.wrap_alg,
            wrap_nonce=req.wrap_nonce,
            wrapped_dek=req.wrapped_dek,
        )
        if req.expected_version is None or req.expected_version == 0:
            row, created = await self._repo.create_assistant_key_envelope_if_absent(
                user_id=user_id,
                kdf=validated.kdf,
                kdf_params=validated.kdf_params,
                salt=validated.salt,
                wrap_alg=validated.wrap_alg,
                wrap_nonce=validated.wrap_nonce,
                wrapped_dek=validated.wrapped_dek,
            )
            if not created:
                raise ConflictError(
                    f"key envelope already exists at key_version={row.key_version}; pass expected_version to rotate",
                    code="key_version_conflict",
                )
            action = "assistant.encryption_enable"
        else:
            updated = await self._repo.rotate_assistant_key_envelope(
                user_id=user_id,
                expected_version=req.expected_version,
                kdf=validated.kdf,
                kdf_params=validated.kdf_params,
                salt=validated.salt,
                wrap_alg=validated.wrap_alg,
                wrap_nonce=validated.wrap_nonce,
                wrapped_dek=validated.wrapped_dek,
            )
            if updated is None:
                current = await self._repo.get_assistant_key_envelope(user_id)
                if current is None:
                    raise ConflictError(
                        "key envelope is not initialized; omit expected_version or pass 0 to create",
                        code="key_version_conflict",
                    )
                raise ConflictError(
                    f"key_version conflict: expected {req.expected_version}, current is {current.key_version}",
                    code="key_version_conflict",
                )
            row = updated
            action = "assistant.encryption_password_change"

        await self._repo.record_audit(
            user_id=user_id,
            actor=f"user:{user_id}",
            action=action,
            metadata={"kdf": row.kdf, "key_version": row.key_version, "dek_epoch": row.dek_epoch},
        )
        await self._redis.publish_assistant_event(
            user_id,
            AssistantStreamEvent(
                event="assistant_encryption",
                payload={
                    "enabled": True,
                    "key_version": row.key_version,
                    "dek_epoch": row.dek_epoch,
                    "reset": False,
                    "device": (req.device or "")[:64],
                },
            ),
        )
        return AssistantEncryptionStatusResponse(enabled=True, envelope=_envelope_view(row))

    async def reset_encryption(
        self,
        *,
        user_id: str,
        req: ResetAssistantEncryptionRequest,
    ) -> ResetAssistantEncryptionResponse:
        if not req.confirm_wipe:
            raise ValidationError(
                "confirm_wipe=true is required to discard old ciphertexts and reset encryption",
                code="confirm_wipe_required",
            )
        new_env_dict: dict[str, Any] | None = None
        if req.new_envelope is not None:
            validated = validate_key_envelope_input(
                kdf=req.new_envelope.kdf,
                kdf_params=req.new_envelope.kdf_params,
                salt=req.new_envelope.salt,
                wrap_alg=req.new_envelope.wrap_alg,
                wrap_nonce=req.new_envelope.wrap_nonce,
                wrapped_dek=req.new_envelope.wrapped_dek,
            )
            new_env_dict = {
                "kdf": validated.kdf,
                "kdf_params": validated.kdf_params,
                "salt": validated.salt,
                "wrap_alg": validated.wrap_alg,
                "wrap_nonce": validated.wrap_nonce,
                "wrapped_dek": validated.wrapped_dek,
            }

        row, wiped_conversations = await self._repo.reset_assistant_encryption(
            user_id=user_id,
            new_envelope=new_env_dict,
        )
        wiped_drive_files = 0
        if req.wipe_drive_vfs and self._drive is not None:
            wiped_drive_files = await self._drive.purge_account_dek_files(
                user_id=user_id,
                actor=f"user:{user_id}",
            )

        await self._repo.record_audit(
            user_id=user_id,
            actor=f"user:{user_id}",
            action="assistant.encryption_reset",
            metadata={
                "enabled": row is not None,
                "key_version": row.key_version if row is not None else None,
                "dek_epoch": row.dek_epoch if row is not None else None,
                "wiped_conversations": wiped_conversations,
                "wiped_drive_files": wiped_drive_files,
            },
        )
        await self._redis.publish_assistant_event(
            user_id,
            AssistantStreamEvent(
                event="assistant_encryption",
                payload={
                    "enabled": row is not None,
                    "key_version": row.key_version if row is not None else None,
                    "dek_epoch": row.dek_epoch if row is not None else None,
                    "reset": True,
                    "device": (req.device or "")[:64],
                },
            ),
        )
        return ResetAssistantEncryptionResponse(
            enabled=row is not None,
            envelope=_envelope_view(row) if row is not None else None,
            wiped_conversations=wiped_conversations,
            wiped_drive_files=wiped_drive_files,
        )

    async def delete_encryption(
        self,
        *,
        user_id: str,
        confirm_wipe: bool = False,
        wipe_drive_vfs: bool = True,
        device: str = "",
    ) -> ResetAssistantEncryptionResponse:
        if not confirm_wipe:
            enc_convs = await self._repo.count_encrypted_assistant_conversations(user_id)
            enc_files = (
                len(await self._repo.list_account_dek_drive_files(user_id))
                if wipe_drive_vfs and self._drive is not None
                else 0
            )
            if enc_convs > 0 or enc_files > 0:
                raise ConflictError(
                    "encrypted conversations or cloud VFS files still exist; pass confirm_wipe=true to remove them",
                    code="encrypted_data_exists",
                )
        return await self.reset_encryption(
            user_id=user_id,
            req=ResetAssistantEncryptionRequest(
                confirm_wipe=True,
                new_envelope=None,
                wipe_drive_vfs=wipe_drive_vfs,
                device=device or None,
            ),
        )

    # ------------------------------------------------------------------
    # 3. Tokens Anywhere managed key reuse & auto-refresh
    # ------------------------------------------------------------------

    def _tokens_secret(self) -> str:
        return self._cfg.tokens.encryption_secret or self._settings.secret_key

    def _tokens_view(
        self,
        row: AssistantTokensConnectionRow | None,
        *,
        key: str | None = None,
        kept: bool | None = None,
        hint: str | None = None,
    ) -> AssistantTokensView:
        if row is None:
            return AssistantTokensView(
                connected=False,
                hint=hint,
                tokens_url=self._cfg.tokens.base_url,
                client_id=self._cfg.tokens.client_id,
            )
        return AssistantTokensView(
            connected=True,
            key=key,
            prefix=row.key_prefix,
            connected_at=row.created_at,
            refreshed_at=unix_ms_to_iso(row.refreshed_at * 1000),
            kept=kept,
            hint=hint,
            tokens_url=self._cfg.tokens.base_url,
            client_id=self._cfg.tokens.client_id,
        )

    async def get_tokens(self, user_id: str) -> AssistantTokensView:
        row = await self._repo.get_assistant_tokens(user_id)
        if row is None:
            return self._tokens_view(None)
        try:
            key = decrypt_tokens_secret(self._tokens_secret(), row.key_enc)
        except TokensDecryptError:
            return self._tokens_view(
                None,
                hint="Tokens connection could not be decrypted (server secret rotated); please reconnect",
            )
        row = await self._keep_alive_tokens(row)
        return self._tokens_view(row, key=key)

    async def put_tokens(
        self,
        *,
        user_id: str,
        req: PutAssistantTokensRequest,
    ) -> AssistantTokensView:
        key = validate_tokens_api_key(req.key)
        secret = self._tokens_secret()
        kh = hash_tokens_key(key)
        prefix = tokens_key_prefix(key)
        key_enc = encrypt_tokens_secret(secret, key)
        raw_refresh = req.refresh.strip() if req.refresh and req.refresh.strip() else None
        refresh_enc = encrypt_tokens_secret(secret, raw_refresh) if raw_refresh else None
        now_ts = int(time.time())

        row, created = await self._repo.insert_assistant_tokens_if_absent(
            user_id=user_id,
            key_enc=key_enc,
            key_hash=kh,
            key_prefix=prefix,
            refresh_enc=refresh_enc,
            refreshed_at=now_ts,
        )
        if created:
            await self._repo.record_audit(
                user_id=user_id,
                actor=f"user:{user_id}",
                action="assistant.tokens_connect",
                metadata={"prefix": prefix},
            )
            await self._redis.publish_assistant_event(
                user_id,
                AssistantStreamEvent(
                    event="assistant_tokens",
                    payload={"connected": True, "prefix": prefix},
                ),
            )
            return self._tokens_view(row, key=key, kept=False)

        if row.key_hash == kh:
            if refresh_enc is not None and row.refresh_enc is None:
                await self._repo.update_assistant_tokens_refresh(
                    user_id=user_id,
                    refresh_enc=refresh_enc,
                    refreshed_at=now_ts,
                )
                refreshed = await self._repo.get_assistant_tokens(user_id)
                if refreshed is not None:
                    row = refreshed
            return self._tokens_view(row, key=key, kept=False)

        # Another browser connected first: reuse its Key so the caller revokes the extra grant.
        try:
            existing_key = decrypt_tokens_secret(secret, row.key_enc)
        except TokensDecryptError:
            # Stored ciphertext is undecryptable after secret rotation; replace with the new valid Key.
            replaced = await self._repo.replace_assistant_tokens(
                user_id=user_id,
                key_enc=key_enc,
                key_hash=kh,
                key_prefix=prefix,
                refresh_enc=refresh_enc,
                refreshed_at=now_ts,
            )
            await self._redis.publish_assistant_event(
                user_id,
                AssistantStreamEvent(
                    event="assistant_tokens",
                    payload={"connected": True, "prefix": prefix},
                ),
            )
            return self._tokens_view(replaced, key=key, kept=False)

        return self._tokens_view(row, key=existing_key, kept=True)

    async def delete_tokens(
        self,
        *,
        user_id: str,
        expected_key_hash: str | None = None,
    ) -> DeleteAssistantTokensResponse:
        cleaned_hash = expected_key_hash.strip() if expected_key_hash and expected_key_hash.strip() else None
        row, removed = await self._repo.delete_assistant_tokens(
            user_id=user_id,
            expected_key_hash=cleaned_hash,
        )
        if not removed:
            return DeleteAssistantTokensResponse(connected=row is not None, removed=False)

        if row is not None and row.refresh_enc:
            try:
                refresh_token = decrypt_tokens_secret(self._tokens_secret(), row.refresh_enc)
            except TokensDecryptError:
                refresh_token = None
            if refresh_token:
                await self._tokens_client.revoke_token(token=refresh_token)

        await self._repo.record_audit(
            user_id=user_id,
            actor=f"user:{user_id}",
            action="assistant.tokens_disconnect",
            metadata={"conditional": cleaned_hash is not None},
        )
        await self._redis.publish_assistant_event(
            user_id,
            AssistantStreamEvent(
                event="assistant_tokens",
                payload={"connected": False},
            ),
        )
        return DeleteAssistantTokensResponse(connected=False, removed=True)

    async def _keep_alive_tokens(
        self,
        row: AssistantTokensConnectionRow,
    ) -> AssistantTokensConnectionRow:
        """Rotate Tokens Anywhere refresh token periodically under a per-user Redis lock."""
        interval = self._cfg.tokens.refresh_interval_seconds
        now_ts = int(time.time())
        if not row.refresh_enc or now_ts - row.refreshed_at < interval:
            return row

        lock_name = f"tokens-refresh:{row.user_id}"
        lock_token = await self._redis.acquire_lock(
            lock_name,
            ttl_seconds=self._cfg.tokens.refresh_lock_ttl_seconds,
        )
        if lock_token is None:
            # Another request/instance is currently rotating this user's refresh token.
            return row

        try:
            fresh = await self._repo.get_assistant_tokens(row.user_id)
            if fresh is None or not fresh.refresh_enc:
                return fresh or row
            now_ts = int(time.time())
            if now_ts - fresh.refreshed_at < interval:
                return fresh

            secret = self._tokens_secret()
            try:
                raw_refresh = decrypt_tokens_secret(secret, fresh.refresh_enc)
            except TokensDecryptError:
                await self._repo.update_assistant_tokens_refresh(
                    user_id=row.user_id,
                    refresh_enc=None,
                )
                return fresh

            result = await self._tokens_client.refresh_token(refresh_token=raw_refresh)
            if result.status == "refreshed" and result.refresh_token:
                new_refresh_enc = encrypt_tokens_secret(secret, result.refresh_token)
                await self._repo.update_assistant_tokens_refresh(
                    user_id=row.user_id,
                    refresh_enc=new_refresh_enc,
                    refreshed_at=now_ts,
                )
                updated = await self._repo.get_assistant_tokens(row.user_id)
                return updated or fresh
            if result.status == "invalid_grant":
                await self._repo.update_assistant_tokens_refresh(
                    user_id=row.user_id,
                    refresh_enc=None,
                )
                updated = await self._repo.get_assistant_tokens(row.user_id)
                return updated or fresh
            return fresh
        finally:
            await self._redis.release_lock(lock_name, lock_token)
