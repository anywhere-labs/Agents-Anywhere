from __future__ import annotations

import json
import secrets
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, delete, func, insert, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from aa_control.core.utc import utc_now_iso
from aa_control.infra.db import schema


@dataclass(frozen=True)
class UserRow:
    id: str
    password_hash: str
    role: str
    disabled: bool
    email: str | None
    display_name: str
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class DeviceRow:
    id: str
    user_id: str
    name: str
    platform: str
    connector_version: str
    mode_hint: str
    e2e_public_key_hint: str | None
    created_at: str
    last_seen_at: str


@dataclass(frozen=True)
class ClientRow:
    id: str
    user_id: str
    platform: str
    label: str
    push_token: str | None
    created_at: str
    last_seen_at: str


@dataclass(frozen=True)
class RefreshTokenRow:
    id: str
    user_id: str
    client_id: str
    token_hash: str
    expires_at: int
    revoked_at: str | None
    created_at: str


@dataclass(frozen=True)
class McpClientRow:
    client_id: str
    client_name: str
    redirect_uris: list[str]
    client_secret_hash: str | None
    created_at: str


@dataclass(frozen=True)
class McpAuthCodeRow:
    code_hash: str
    client_id: str
    user_id: str
    redirect_uri: str
    code_challenge: str
    scopes: list[str]
    device_ids: list[str]
    expires_at: int
    consumed_at: str | None
    created_at: str


@dataclass(frozen=True)
class McpGrantRow:
    id: str
    user_id: str
    client_id: str
    client_name: str
    scopes: list[str]
    device_ids: list[str]
    access_token_hash: str
    expires_at: int
    revoked_at: str | None
    created_at: str


@dataclass(frozen=True)
class DrivePolicyRow:
    user_id: str
    quota_bytes: int | None
    max_file_bytes: int | None
    default_ttl_seconds: int | None
    max_ttl_seconds: int | None
    updated_by: str | None
    updated_at: str


@dataclass(frozen=True)
class DriveFileRow:
    id: str
    user_id: str
    purpose: str
    status: str
    object_key: str
    size_bytes: int
    sha256: str
    etag: str | None
    filename: str | None
    mime_type: str | None
    vfs_path: str | None
    encryption_mode: str
    encryption_nonce: str | None
    encryption_key_version: int | None
    encrypted_meta: str | None
    source_device_id: str | None
    ttl_seconds: int
    upload_expires_at: int
    expires_at: int
    created_at: str
    completed_at: str | None
    updated_at: str


@dataclass(frozen=True)
class DriveUsageSnapshot:
    used_bytes: int
    reserved_bytes: int
    file_count: int


@dataclass(frozen=True)
class AssistantConversationMetaRow:
    user_id: str
    conversation_id: str
    encrypted: bool
    title: str | None
    updated_at: int
    content_hash: str
    device: str
    size_bytes: int
    key_version: int | None
    dek_epoch: int | None
    encrypted_meta: str | None
    meta_nonce: str | None
    server_updated_at: str


@dataclass(frozen=True)
class AssistantConversationRow(AssistantConversationMetaRow):
    messages_json: str | None
    settings_json: str | None
    nonce: str | None
    ciphertext: str | None


@dataclass(frozen=True)
class AssistantKeyEnvelopeRow:
    user_id: str
    kdf: str
    kdf_params: dict[str, Any]
    salt: str
    wrap_alg: str
    wrap_nonce: str | None
    wrapped_dek: str
    key_version: int
    dek_epoch: int
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class AssistantTokensConnectionRow:
    user_id: str
    key_enc: str
    key_hash: str
    key_prefix: str
    refresh_enc: str | None
    refreshed_at: int
    created_at: str
    updated_at: str


class ControlRepository:
    """Async PostgreSQL repository for the AA v3 lightweight control plane."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    # ------------------------------------------------------------------
    # Users & OAuth accounts
    # ------------------------------------------------------------------

    async def count_users(self) -> int:
        async with self._engine.connect() as conn:
            res = await conn.execute(select(func.count()).select_from(schema.users))
            return int(res.scalar_one())

    async def get_user_by_id(self, user_id: str) -> UserRow | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(select(schema.users).where(schema.users.c.id == user_id))).mappings().first()
            return _to_user(row) if row else None

    async def get_user_by_email(self, email: str) -> UserRow | None:
        normalized = email.strip().lower()
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(select(schema.users).where(func.lower(schema.users.c.email) == normalized))
            ).mappings().first()
            return _to_user(row) if row else None

    async def create_user(
        self,
        *,
        email: str | None,
        password_hash: str,
        display_name: str,
        role: str = "member",
    ) -> UserRow:
        now = utc_now_iso()
        user_id = f"usr_{secrets.token_hex(12)}"
        normalized_email = email.strip().lower() if email else None
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(schema.users).values(
                    id=user_id,
                    password_hash=password_hash,
                    role=role,
                    disabled=0,
                    email=normalized_email,
                    email_verified_at=None,
                    display_name=display_name or (normalized_email.split("@")[0] if normalized_email else user_id),
                    avatar=None,
                    created_at=now,
                    updated_at=now,
                )
            )
        return UserRow(
            id=user_id,
            password_hash=password_hash,
            role=role,
            disabled=False,
            email=normalized_email,
            display_name=display_name or (normalized_email.split("@")[0] if normalized_email else user_id),
            created_at=now,
            updated_at=now,
        )

    async def get_or_create_oauth_user(
        self,
        *,
        provider: str,
        subject: str,
        email: str | None,
        display_name: str,
        allow_create: bool,
    ) -> UserRow | None:
        now = utc_now_iso()
        normalized_email = email.strip().lower() if email else None
        async with self._engine.begin() as conn:
            acct = (
                await conn.execute(
                    select(schema.oauth_accounts).where(
                        schema.oauth_accounts.c.provider == provider,
                        schema.oauth_accounts.c.subject == subject,
                    )
                )
            ).mappings().first()
            if acct is not None:
                user_row = (
                    await conn.execute(select(schema.users).where(schema.users.c.id == acct["user_id"]))
                ).mappings().first()
                return _to_user(user_row) if user_row else None

            user_row = None
            if normalized_email:
                user_row = (
                    await conn.execute(select(schema.users).where(func.lower(schema.users.c.email) == normalized_email))
                ).mappings().first()

            if user_row is None:
                if not allow_create:
                    return None
                count = int((await conn.execute(select(func.count()).select_from(schema.users))).scalar_one())
                role = "admin" if count == 0 else "member"
                user_id = f"usr_{secrets.token_hex(12)}"
                await conn.execute(
                    insert(schema.users).values(
                        id=user_id,
                        password_hash="",
                        role=role,
                        disabled=0,
                        email=normalized_email,
                        email_verified_at=now if normalized_email else None,
                        display_name=display_name or (normalized_email.split("@")[0] if normalized_email else subject),
                        avatar=None,
                        created_at=now,
                        updated_at=now,
                    )
                )
                user_row = (
                    await conn.execute(select(schema.users).where(schema.users.c.id == user_id))
                ).mappings().one()

            await conn.execute(
                insert(schema.oauth_accounts).values(
                    provider=provider,
                    subject=subject,
                    user_id=user_row["id"],
                    email=normalized_email,
                    display_name=display_name,
                    created_at=now,
                    updated_at=now,
                )
            )
            return _to_user(user_row)

    async def upsert_oidc_user(
        self,
        *,
        issuer: str,
        subject: str,
        email: str | None,
        email_verified: bool,
        display_name: str,
        role: str,
    ) -> UserRow:
        """Resolve or JIT-provision the local shadow user for a verified OIDC subject.

        Uses the verified global ``sub`` as ``users.id`` so migrated AA 2.x accounts
        and ``anywhere-auth`` accounts share the exact same primary key, while keeping
        steady-state authenticated requests read-only (zero DB writes when unchanged).
        """
        normalized_email = email.strip().lower() if email and email.strip() else None
        cleaned_name = display_name.strip() or (
            normalized_email.split("@", 1)[0] if normalized_email and "@" in normalized_email else subject
        )
        cleaned_role = "admin" if role == "admin" else "member"

        # Fast read-only lookup (hot path).
        existing = await self._find_oidc_user(issuer=issuer, subject=subject)
        if existing is not None:
            if existing.disabled:
                return existing
            needs_name = existing.display_name != cleaned_name
            needs_role = existing.role != cleaned_role
            needs_email = normalized_email is not None and existing.email != normalized_email
            if not (needs_name or needs_role or needs_email):
                return existing

            now = utc_now_iso()
            async with self._engine.begin() as conn:
                values: dict[str, Any] = {
                    "display_name": cleaned_name,
                    "role": cleaned_role,
                    "updated_at": now,
                }
                if needs_email and normalized_email is not None:
                    owner = (
                        await conn.execute(
                            select(schema.users.c.id).where(func.lower(schema.users.c.email) == normalized_email)
                        )
                    ).scalar_one_or_none()
                    if owner is None or str(owner) == existing.id:
                        values["email"] = normalized_email
                        if email_verified:
                            values["email_verified_at"] = now
                await conn.execute(update(schema.users).where(schema.users.c.id == existing.id).values(**values))
                row = (await conn.execute(select(schema.users).where(schema.users.c.id == existing.id))).mappings().one()
                return _to_user(row)

        now = utc_now_iso()
        try:
            async with self._engine.begin() as conn:
                stored_email = normalized_email
                if stored_email is not None:
                    owner = (
                        await conn.execute(
                            select(schema.users.c.id).where(func.lower(schema.users.c.email) == stored_email)
                        )
                    ).scalar_one_or_none()
                    if owner is not None:
                        # Never crash on unique email index or silently hijack an existing local account.
                        stored_email = None
                await conn.execute(
                    insert(schema.users).values(
                        id=subject,
                        password_hash="",
                        role=cleaned_role,
                        disabled=0,
                        email=stored_email,
                        email_verified_at=now if (stored_email and email_verified) else None,
                        display_name=cleaned_name,
                        avatar=None,
                        created_at=now,
                        updated_at=now,
                    )
                )
                await conn.execute(
                    insert(schema.oauth_accounts).values(
                        provider=issuer,
                        subject=subject,
                        user_id=subject,
                        email=normalized_email,
                        display_name=cleaned_name,
                        created_at=now,
                        updated_at=now,
                    )
                )
                row = (await conn.execute(select(schema.users).where(schema.users.c.id == subject))).mappings().one()
                return _to_user(row)
        except IntegrityError:
            # Concurrent first-login race for the same subject: re-read winning row.
            raced = await self._find_oidc_user(issuer=issuer, subject=subject)
            if raced is not None:
                return raced
            raise

    async def _find_oidc_user(self, *, issuer: str, subject: str) -> UserRow | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(select(schema.users).where(schema.users.c.id == subject))).mappings().first()
            if row is not None:
                return _to_user(row)
            acct = (
                await conn.execute(
                    select(schema.oauth_accounts).where(
                        schema.oauth_accounts.c.provider == issuer,
                        schema.oauth_accounts.c.subject == subject,
                    )
                )
            ).mappings().first()
            if acct is None:
                return None
            linked = (
                await conn.execute(select(schema.users).where(schema.users.c.id == acct["user_id"]))
            ).mappings().first()
            return _to_user(linked) if linked is not None else None

    # ------------------------------------------------------------------
    # Refresh tokens (account sessions)
    # ------------------------------------------------------------------

    async def create_refresh_token(
        self,
        *,
        user_id: str,
        client_id: str,
        token_hash: str,
        expires_at: int,
    ) -> RefreshTokenRow:
        now = utc_now_iso()
        token_id = f"rt_{secrets.token_hex(12)}"
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(schema.refresh_tokens).values(
                    id=token_id,
                    user_id=user_id,
                    client_id=client_id,
                    token_hash=token_hash,
                    expires_at=expires_at,
                    revoked_at=None,
                    created_at=now,
                )
            )
        return RefreshTokenRow(
            id=token_id,
            user_id=user_id,
            client_id=client_id,
            token_hash=token_hash,
            expires_at=expires_at,
            revoked_at=None,
            created_at=now,
        )

    async def get_refresh_token_by_hash(self, token_hash: str) -> RefreshTokenRow | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(schema.refresh_tokens).where(schema.refresh_tokens.c.token_hash == token_hash)
                )
            ).mappings().first()
            return _to_refresh(row) if row else None

    async def revoke_refresh_token(self, token_hash: str) -> bool:
        now = utc_now_iso()
        async with self._engine.begin() as conn:
            res = await conn.execute(
                update(schema.refresh_tokens)
                .where(
                    schema.refresh_tokens.c.token_hash == token_hash,
                    schema.refresh_tokens.c.revoked_at.is_(None),
                )
                .values(revoked_at=now)
            )
            return res.rowcount > 0

    # ------------------------------------------------------------------
    # Devices & credentials
    # ------------------------------------------------------------------

    async def create_device(
        self,
        *,
        user_id: str,
        name: str,
        platform: str,
        connector_version: str,
        mode_hint: str,
        e2e_public_key_hint: str | None,
        secret_hash: str,
    ) -> DeviceRow:
        now = utc_now_iso()
        device_id = f"dev_{secrets.token_hex(12)}"
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(schema.devices).values(
                    id=device_id,
                    user_id=user_id,
                    name=name,
                    platform=platform,
                    connector_version=connector_version,
                    mode_hint=mode_hint,
                    e2e_public_key_hint=e2e_public_key_hint,
                    created_at=now,
                    last_seen_at=now,
                )
            )
            await conn.execute(
                insert(schema.device_credentials).values(
                    device_id=device_id,
                    secret_hash=secret_hash,
                    rotated_at=now,
                    revoked_at=None,
                )
            )
        return DeviceRow(
            id=device_id,
            user_id=user_id,
            name=name,
            platform=platform,
            connector_version=connector_version,
            mode_hint=mode_hint,
            e2e_public_key_hint=e2e_public_key_hint,
            created_at=now,
            last_seen_at=now,
        )

    async def list_devices_for_user(self, user_id: str) -> list[DeviceRow]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(schema.devices)
                    .where(schema.devices.c.user_id == user_id)
                    .order_by(schema.devices.c.created_at.asc())
                )
            ).mappings().all()
            return [_to_device(r) for r in rows]

    async def count_devices_for_user(self, user_id: str) -> int:
        async with self._engine.connect() as conn:
            res = await conn.execute(
                select(func.count()).select_from(schema.devices).where(schema.devices.c.user_id == user_id)
            )
            return int(res.scalar_one())

    async def get_device(self, device_id: str) -> DeviceRow | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(select(schema.devices).where(schema.devices.c.id == device_id))).mappings().first()
            return _to_device(row) if row else None

    async def get_device_secret_hash(self, device_id: str) -> str | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(schema.device_credentials).where(
                        schema.device_credentials.c.device_id == device_id,
                        schema.device_credentials.c.revoked_at.is_(None),
                    )
                )
            ).mappings().first()
            return str(row["secret_hash"]) if row else None

    async def update_device_heartbeat_meta(
        self,
        *,
        device_id: str,
        platform: str,
        connector_version: str,
        mode_hint: str,
        e2e_public_key_hint: str | None,
        last_seen_at: str,
    ) -> DeviceRow | None:
        async with self._engine.begin() as conn:
            values: dict[str, Any] = {
                "platform": platform,
                "connector_version": connector_version,
                "mode_hint": mode_hint,
                "last_seen_at": last_seen_at,
            }
            if mode_hint == "encrypted" and e2e_public_key_hint is not None:
                values["e2e_public_key_hint"] = e2e_public_key_hint
            elif mode_hint == "normal":
                values["e2e_public_key_hint"] = None
            await conn.execute(update(schema.devices).where(schema.devices.c.id == device_id).values(**values))
            row = (await conn.execute(select(schema.devices).where(schema.devices.c.id == device_id))).mappings().first()
            return _to_device(row) if row else None

    async def rename_device(self, *, device_id: str, name: str) -> DeviceRow | None:
        async with self._engine.begin() as conn:
            await conn.execute(update(schema.devices).where(schema.devices.c.id == device_id).values(name=name))
            row = (await conn.execute(select(schema.devices).where(schema.devices.c.id == device_id))).mappings().first()
            return _to_device(row) if row else None

    async def delete_device(self, device_id: str) -> bool:
        async with self._engine.begin() as conn:
            await conn.execute(delete(schema.device_credentials).where(schema.device_credentials.c.device_id == device_id))
            res = await conn.execute(delete(schema.devices).where(schema.devices.c.id == device_id))
            return res.rowcount > 0

    # ------------------------------------------------------------------
    # Clients (installations + push tokens)
    # ------------------------------------------------------------------

    async def upsert_client(
        self,
        *,
        client_id: str,
        user_id: str,
        platform: str,
        label: str = "",
        push_token: str | None = None,
        update_push_token: bool = False,
    ) -> ClientRow:
        now = utc_now_iso()
        async with self._engine.begin() as conn:
            existing = (
                await conn.execute(select(schema.clients).where(schema.clients.c.id == client_id))
            ).mappings().first()
            if existing is None:
                await conn.execute(
                    insert(schema.clients).values(
                        id=client_id,
                        user_id=user_id,
                        platform=platform,
                        label=label,
                        push_token=push_token if update_push_token else None,
                        created_at=now,
                        last_seen_at=now,
                    )
                )
            else:
                values: dict[str, Any] = {
                    "user_id": user_id,
                    "platform": platform,
                    "last_seen_at": now,
                }
                if label:
                    values["label"] = label
                if update_push_token:
                    values["push_token"] = push_token
                await conn.execute(update(schema.clients).where(schema.clients.c.id == client_id).values(**values))
            row = (await conn.execute(select(schema.clients).where(schema.clients.c.id == client_id))).mappings().one()
            return _to_client(row)

    async def list_push_clients_for_user(self, user_id: str) -> list[ClientRow]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(schema.clients).where(
                        schema.clients.c.user_id == user_id,
                        schema.clients.c.push_token.is_not(None),
                    )
                )
            ).mappings().all()
            return [_to_client(r) for r in rows if r["push_token"]]

    # ------------------------------------------------------------------
    # MCP OAuth 2.1 clients, codes, and grants
    # ------------------------------------------------------------------

    async def create_mcp_oauth_client(
        self,
        *,
        client_name: str,
        redirect_uris: list[str],
        client_secret_hash: str | None = None,
    ) -> McpClientRow:
        now = utc_now_iso()
        client_id = f"mcpc_{secrets.token_hex(12)}"
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(schema.mcp_oauth_clients).values(
                    client_id=client_id,
                    client_name=client_name,
                    redirect_uris_json=json.dumps(redirect_uris),
                    client_secret_hash=client_secret_hash,
                    created_at=now,
                )
            )
        return McpClientRow(
            client_id=client_id,
            client_name=client_name,
            redirect_uris=list(redirect_uris),
            client_secret_hash=client_secret_hash,
            created_at=now,
        )

    async def get_mcp_oauth_client(self, client_id: str) -> McpClientRow | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(schema.mcp_oauth_clients).where(schema.mcp_oauth_clients.c.client_id == client_id)
                )
            ).mappings().first()
            return _to_mcp_client(row) if row else None

    async def create_mcp_auth_code(
        self,
        *,
        code_hash: str,
        client_id: str,
        user_id: str,
        redirect_uri: str,
        code_challenge: str,
        scopes: list[str],
        device_ids: list[str],
        expires_at: int,
    ) -> None:
        now = utc_now_iso()
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(schema.mcp_auth_codes).values(
                    code_hash=code_hash,
                    client_id=client_id,
                    user_id=user_id,
                    redirect_uri=redirect_uri,
                    code_challenge=code_challenge,
                    scopes_json=json.dumps(scopes),
                    device_ids_json=json.dumps(device_ids),
                    expires_at=expires_at,
                    consumed_at=None,
                    created_at=now,
                )
            )

    async def consume_mcp_auth_code(self, code_hash: str) -> McpAuthCodeRow | None:
        now = utc_now_iso()
        now_ts = int(time.time())
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(schema.mcp_auth_codes).where(schema.mcp_auth_codes.c.code_hash == code_hash)
                )
            ).mappings().first()
            if row is None or row["consumed_at"] is not None or int(row["expires_at"]) < now_ts:
                return None
            res = await conn.execute(
                update(schema.mcp_auth_codes)
                .where(
                    schema.mcp_auth_codes.c.code_hash == code_hash,
                    schema.mcp_auth_codes.c.consumed_at.is_(None),
                )
                .values(consumed_at=now)
            )
            if res.rowcount != 1:
                return None
            return McpAuthCodeRow(
                code_hash=str(row["code_hash"]),
                client_id=str(row["client_id"]),
                user_id=str(row["user_id"]),
                redirect_uri=str(row["redirect_uri"]),
                code_challenge=str(row["code_challenge"]),
                scopes=list(json.loads(row["scopes_json"])),
                device_ids=list(json.loads(row["device_ids_json"])),
                expires_at=int(row["expires_at"]),
                consumed_at=now,
                created_at=str(row["created_at"]),
            )

    async def create_mcp_grant(
        self,
        *,
        user_id: str,
        client_id: str,
        client_name: str,
        scopes: list[str],
        device_ids: list[str],
        access_token_hash: str,
        expires_at: int,
    ) -> McpGrantRow:
        now = utc_now_iso()
        grant_id = f"mcpg_{secrets.token_hex(12)}"
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(schema.mcp_grants).values(
                    id=grant_id,
                    user_id=user_id,
                    client_id=client_id,
                    client_name=client_name,
                    scopes_json=json.dumps(scopes),
                    device_ids_json=json.dumps(device_ids),
                    access_token_hash=access_token_hash,
                    expires_at=expires_at,
                    revoked_at=None,
                    created_at=now,
                )
            )
        return McpGrantRow(
            id=grant_id,
            user_id=user_id,
            client_id=client_id,
            client_name=client_name,
            scopes=list(scopes),
            device_ids=list(device_ids),
            access_token_hash=access_token_hash,
            expires_at=expires_at,
            revoked_at=None,
            created_at=now,
        )

    async def get_active_mcp_grant_by_token_hash(self, token_hash: str) -> McpGrantRow | None:
        now_ts = int(time.time())
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(schema.mcp_grants).where(
                        schema.mcp_grants.c.access_token_hash == token_hash,
                        schema.mcp_grants.c.revoked_at.is_(None),
                        schema.mcp_grants.c.expires_at >= now_ts,
                    )
                )
            ).mappings().first()
            return _to_mcp_grant(row) if row else None

    async def list_mcp_grants_for_user(self, user_id: str) -> list[McpGrantRow]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(schema.mcp_grants)
                    .where(schema.mcp_grants.c.user_id == user_id)
                    .order_by(schema.mcp_grants.c.created_at.desc())
                )
            ).mappings().all()
            return [_to_mcp_grant(r) for r in rows]

    async def revoke_mcp_grant(self, *, user_id: str, grant_id: str) -> bool:
        now = utc_now_iso()
        async with self._engine.begin() as conn:
            res = await conn.execute(
                update(schema.mcp_grants)
                .where(
                    schema.mcp_grants.c.id == grant_id,
                    schema.mcp_grants.c.user_id == user_id,
                    schema.mcp_grants.c.revoked_at.is_(None),
                )
                .values(revoked_at=now)
            )
            return res.rowcount > 0

    # ------------------------------------------------------------------
    # Metadata-only audit log
    # ------------------------------------------------------------------

    async def record_audit(
        self,
        *,
        user_id: str,
        actor: str,
        action: str,
        device_id: str | None = None,
        session_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(schema.audit_logs).values(
                    id=f"aud_{secrets.token_hex(12)}",
                    user_id=user_id,
                    actor=actor,
                    action=action,
                    device_id=device_id,
                    session_id=session_id,
                    metadata_json=json.dumps(metadata or {}),
                    created_at=utc_now_iso(),
                )
            )

    async def list_audit_logs(self, user_id: str, limit: int = 50) -> list[dict[str, Any]]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(schema.audit_logs)
                    .where(schema.audit_logs.c.user_id == user_id)
                    .order_by(schema.audit_logs.c.created_at.desc())
                    .limit(limit)
                )
            ).mappings().all()
            return [
                {
                    "id": str(r["id"]),
                    "user_id": str(r["user_id"]),
                    "actor": str(r["actor"]),
                    "action": str(r["action"]),
                    "device_id": r["device_id"],
                    "session_id": r["session_id"],
                    "metadata": json.loads(r["metadata_json"]),
                    "created_at": str(r["created_at"]),
                }
                for r in rows
            ]

    # ------------------------------------------------------------------
    # Quota-limited cloud drive policies & file metadata (T517)
    # ------------------------------------------------------------------

    async def get_drive_policy(self, user_id: str) -> DrivePolicyRow | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(schema.drive_user_policies).where(schema.drive_user_policies.c.user_id == user_id)
                )
            ).mappings().first()
            return _to_drive_policy(row) if row else None

    async def upsert_drive_policy(
        self,
        *,
        user_id: str,
        quota_bytes: int | None,
        max_file_bytes: int | None,
        default_ttl_seconds: int | None,
        max_ttl_seconds: int | None,
        updated_by: str | None,
    ) -> DrivePolicyRow:
        now = utc_now_iso()
        async with self._engine.begin() as conn:
            existing = (
                await conn.execute(
                    select(schema.drive_user_policies.c.user_id).where(schema.drive_user_policies.c.user_id == user_id)
                )
            ).scalar_one_or_none()
            values = {
                "quota_bytes": quota_bytes,
                "max_file_bytes": max_file_bytes,
                "default_ttl_seconds": default_ttl_seconds,
                "max_ttl_seconds": max_ttl_seconds,
                "updated_by": updated_by,
                "updated_at": now,
            }
            if existing is None:
                await conn.execute(insert(schema.drive_user_policies).values(user_id=user_id, **values))
            else:
                await conn.execute(
                    update(schema.drive_user_policies)
                    .where(schema.drive_user_policies.c.user_id == user_id)
                    .values(**values)
                )
            row = (
                await conn.execute(
                    select(schema.drive_user_policies).where(schema.drive_user_policies.c.user_id == user_id)
                )
            ).mappings().one()
            return _to_drive_policy(row)

    async def delete_drive_policy(self, user_id: str) -> bool:
        async with self._engine.begin() as conn:
            res = await conn.execute(
                delete(schema.drive_user_policies).where(schema.drive_user_policies.c.user_id == user_id)
            )
            return res.rowcount > 0

    async def get_drive_usage(self, user_id: str, *, now_ts: int) -> DriveUsageSnapshot:
        async with self._engine.connect() as conn:
            ready_row = (
                await conn.execute(
                    select(
                        func.coalesce(func.sum(schema.drive_files.c.size_bytes), 0),
                        func.count(),
                    ).where(
                        schema.drive_files.c.user_id == user_id,
                        schema.drive_files.c.status == "ready",
                        schema.drive_files.c.expires_at > now_ts,
                    )
                )
            ).one()
            pending_bytes = (
                await conn.execute(
                    select(func.coalesce(func.sum(schema.drive_files.c.size_bytes), 0)).where(
                        schema.drive_files.c.user_id == user_id,
                        schema.drive_files.c.status == "pending",
                        schema.drive_files.c.upload_expires_at > now_ts,
                    )
                )
            ).scalar_one()
            return DriveUsageSnapshot(
                used_bytes=int(ready_row[0]),
                reserved_bytes=int(pending_bytes),
                file_count=int(ready_row[1]),
            )

    async def create_drive_file(
        self,
        *,
        file_id: str,
        user_id: str,
        purpose: str,
        object_key: str,
        size_bytes: int,
        sha256: str,
        filename: str | None,
        mime_type: str | None,
        vfs_path: str | None,
        encryption_mode: str,
        encryption_nonce: str | None,
        encryption_key_version: int | None,
        encrypted_meta: str | None,
        source_device_id: str | None,
        ttl_seconds: int,
        upload_expires_at: int,
        expires_at: int,
    ) -> DriveFileRow:
        now = utc_now_iso()
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(schema.drive_files).values(
                    id=file_id,
                    user_id=user_id,
                    purpose=purpose,
                    status="pending",
                    object_key=object_key,
                    size_bytes=size_bytes,
                    sha256=sha256,
                    etag=None,
                    filename=filename,
                    mime_type=mime_type,
                    vfs_path=vfs_path,
                    encryption_mode=encryption_mode,
                    encryption_nonce=encryption_nonce,
                    encryption_key_version=encryption_key_version,
                    encrypted_meta=encrypted_meta,
                    source_device_id=source_device_id,
                    ttl_seconds=ttl_seconds,
                    upload_expires_at=upload_expires_at,
                    expires_at=expires_at,
                    created_at=now,
                    completed_at=None,
                    updated_at=now,
                )
            )
            row = (
                await conn.execute(select(schema.drive_files).where(schema.drive_files.c.id == file_id))
            ).mappings().one()
            return _to_drive_file(row)

    async def get_drive_file(self, file_id: str) -> DriveFileRow | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(select(schema.drive_files).where(schema.drive_files.c.id == file_id))
            ).mappings().first()
            return _to_drive_file(row) if row else None

    async def mark_drive_file_ready(
        self,
        *,
        file_id: str,
        etag: str | None,
        expires_at: int,
    ) -> DriveFileRow | None:
        now = utc_now_iso()
        async with self._engine.begin() as conn:
            await conn.execute(
                update(schema.drive_files)
                .where(schema.drive_files.c.id == file_id)
                .values(
                    status="ready",
                    etag=etag,
                    expires_at=expires_at,
                    completed_at=now,
                    updated_at=now,
                )
            )
            row = (
                await conn.execute(select(schema.drive_files).where(schema.drive_files.c.id == file_id))
            ).mappings().first()
            return _to_drive_file(row) if row else None

    async def list_superseded_vfs_files(
        self,
        *,
        user_id: str,
        vfs_path: str,
        exclude_file_id: str,
    ) -> list[DriveFileRow]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(schema.drive_files).where(
                        schema.drive_files.c.user_id == user_id,
                        schema.drive_files.c.purpose == "assistant_vfs",
                        schema.drive_files.c.vfs_path == vfs_path,
                        schema.drive_files.c.status == "ready",
                        schema.drive_files.c.id != exclude_file_id,
                    )
                )
            ).mappings().all()
            return [_to_drive_file(r) for r in rows]

    async def list_drive_files(
        self,
        user_id: str,
        *,
        now_ts: int,
        purpose: str | None = None,
        vfs_prefix: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[DriveFileRow]:
        stmt = select(schema.drive_files).where(
            schema.drive_files.c.user_id == user_id,
            schema.drive_files.c.status == "ready",
            schema.drive_files.c.expires_at > now_ts,
        )
        if purpose is not None:
            stmt = stmt.where(schema.drive_files.c.purpose == purpose)
        if vfs_prefix is not None:
            stmt = stmt.where(schema.drive_files.c.vfs_path.startswith(vfs_prefix))
        stmt = stmt.order_by(schema.drive_files.c.created_at.desc()).limit(limit).offset(offset)
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
            return [_to_drive_file(r) for r in rows]

    async def delete_drive_file(self, file_id: str) -> bool:
        async with self._engine.begin() as conn:
            res = await conn.execute(delete(schema.drive_files).where(schema.drive_files.c.id == file_id))
            return res.rowcount > 0

    async def list_expired_drive_files(self, *, now_ts: int, limit: int = 100) -> list[DriveFileRow]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(schema.drive_files)
                    .where(
                        or_(
                            and_(
                                schema.drive_files.c.status == "ready",
                                schema.drive_files.c.expires_at <= now_ts,
                            ),
                            and_(
                                schema.drive_files.c.status == "pending",
                                schema.drive_files.c.upload_expires_at <= now_ts,
                            ),
                        )
                    )
                    .order_by(schema.drive_files.c.expires_at.asc())
                    .limit(limit)
                )
            ).mappings().all()
            return [_to_drive_file(r) for r in rows]

    async def list_account_dek_drive_files(self, user_id: str) -> list[DriveFileRow]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(schema.drive_files).where(
                        schema.drive_files.c.user_id == user_id,
                        schema.drive_files.c.encryption_mode == "account_dek",
                    )
                )
            ).mappings().all()
            return [_to_drive_file(r) for r in rows]

    # ------------------------------------------------------------------
    # Portable assistant conversation sync (T516)
    # ------------------------------------------------------------------

    async def list_assistant_conversations(self, user_id: str) -> list[AssistantConversationMetaRow]:
        tbl = schema.assistant_conversations
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        tbl.c.user_id,
                        tbl.c.conversation_id,
                        tbl.c.encrypted,
                        tbl.c.title,
                        tbl.c.updated_at,
                        tbl.c.content_hash,
                        tbl.c.device,
                        tbl.c.size_bytes,
                        tbl.c.key_version,
                        tbl.c.dek_epoch,
                        tbl.c.encrypted_meta,
                        tbl.c.meta_nonce,
                        tbl.c.server_updated_at,
                    )
                    .where(tbl.c.user_id == user_id)
                    .order_by(tbl.c.updated_at.desc(), tbl.c.conversation_id.desc())
                )
            ).mappings().all()
            return [_to_assistant_conversation_meta(r) for r in rows]

    async def get_assistant_conversation(
        self,
        *,
        user_id: str,
        conversation_id: str,
    ) -> AssistantConversationRow | None:
        tbl = schema.assistant_conversations
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(tbl).where(
                        tbl.c.user_id == user_id,
                        tbl.c.conversation_id == conversation_id,
                    )
                )
            ).mappings().first()
            return _to_assistant_conversation(row) if row else None

    async def upsert_assistant_conversation_and_trim(
        self,
        *,
        user_id: str,
        conversation_id: str,
        encrypted: bool,
        title: str | None,
        updated_at: int,
        content_hash: str,
        device: str,
        size_bytes: int,
        messages_json: str | None,
        settings_json: str | None,
        key_version: int | None,
        dek_epoch: int | None,
        nonce: str | None,
        ciphertext: str | None,
        encrypted_meta: str | None,
        meta_nonce: str | None,
        max_conversations: int,
    ) -> AssistantConversationMetaRow:
        tbl = schema.assistant_conversations
        now = utc_now_iso()
        values = {
            "encrypted": 1 if encrypted else 0,
            "title": title,
            "updated_at": updated_at,
            "content_hash": content_hash,
            "device": device,
            "size_bytes": size_bytes,
            "messages_json": messages_json,
            "settings_json": settings_json,
            "key_version": key_version,
            "dek_epoch": dek_epoch,
            "nonce": nonce,
            "ciphertext": ciphertext,
            "encrypted_meta": encrypted_meta,
            "meta_nonce": meta_nonce,
            "server_updated_at": now,
        }
        async with self._engine.begin() as conn:
            res = await conn.execute(
                update(tbl)
                .where(tbl.c.user_id == user_id, tbl.c.conversation_id == conversation_id)
                .values(**values)
            )
            if res.rowcount == 0:
                try:
                    async with conn.begin_nested():
                        await conn.execute(
                            insert(tbl).values(
                                user_id=user_id,
                                conversation_id=conversation_id,
                                **values,
                            )
                        )
                except IntegrityError:
                    await conn.execute(
                        update(tbl)
                        .where(tbl.c.user_id == user_id, tbl.c.conversation_id == conversation_id)
                        .values(**values)
                    )

            stale_ids = list(
                (
                    await conn.execute(
                        select(tbl.c.conversation_id)
                        .where(tbl.c.user_id == user_id)
                        .order_by(tbl.c.updated_at.desc(), tbl.c.conversation_id.desc())
                        .offset(max_conversations)
                    )
                ).scalars().all()
            )
            if stale_ids:
                await conn.execute(
                    delete(tbl).where(
                        tbl.c.user_id == user_id,
                        tbl.c.conversation_id.in_(stale_ids),
                    )
                )

        return AssistantConversationMetaRow(
            user_id=user_id,
            conversation_id=conversation_id,
            encrypted=encrypted,
            title=title,
            updated_at=updated_at,
            content_hash=content_hash,
            device=device,
            size_bytes=size_bytes,
            key_version=key_version,
            dek_epoch=dek_epoch,
            encrypted_meta=encrypted_meta,
            meta_nonce=meta_nonce,
            server_updated_at=now,
        )

    async def delete_assistant_conversation(self, *, user_id: str, conversation_id: str) -> bool:
        tbl = schema.assistant_conversations
        async with self._engine.begin() as conn:
            res = await conn.execute(
                delete(tbl).where(
                    tbl.c.user_id == user_id,
                    tbl.c.conversation_id == conversation_id,
                )
            )
            return res.rowcount > 0

    async def count_encrypted_assistant_conversations(self, user_id: str) -> int:
        tbl = schema.assistant_conversations
        async with self._engine.connect() as conn:
            res = await conn.execute(
                select(func.count()).select_from(tbl).where(
                    tbl.c.user_id == user_id,
                    tbl.c.encrypted == 1,
                )
            )
            return int(res.scalar_one())

    async def delete_encrypted_assistant_conversations(self, user_id: str) -> int:
        tbl = schema.assistant_conversations
        async with self._engine.begin() as conn:
            res = await conn.execute(
                delete(tbl).where(
                    tbl.c.user_id == user_id,
                    tbl.c.encrypted == 1,
                )
            )
            return int(res.rowcount or 0)

    # ------------------------------------------------------------------
    # Account-level KEK/DEK key envelope (T516)
    # ------------------------------------------------------------------

    async def get_assistant_key_envelope(self, user_id: str) -> AssistantKeyEnvelopeRow | None:
        tbl = schema.assistant_key_envelopes
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(select(tbl).where(tbl.c.user_id == user_id))
            ).mappings().first()
            return _to_assistant_key_envelope(row) if row else None

    async def create_assistant_key_envelope_if_absent(
        self,
        *,
        user_id: str,
        kdf: str,
        kdf_params: dict[str, Any],
        salt: str,
        wrap_alg: str,
        wrap_nonce: str | None,
        wrapped_dek: str,
    ) -> tuple[AssistantKeyEnvelopeRow, bool]:
        tbl = schema.assistant_key_envelopes
        now = utc_now_iso()
        async with self._engine.begin() as conn:
            try:
                async with conn.begin_nested():
                    await conn.execute(
                        insert(tbl).values(
                            user_id=user_id,
                            kdf=kdf,
                            kdf_params_json=json.dumps(kdf_params, separators=(",", ":"), sort_keys=True),
                            salt=salt,
                            wrap_alg=wrap_alg,
                            wrap_nonce=wrap_nonce,
                            wrapped_dek=wrapped_dek,
                            key_version=1,
                            dek_epoch=1,
                            created_at=now,
                            updated_at=now,
                        )
                    )
                    created = True
            except IntegrityError:
                created = False
            row = (
                await conn.execute(select(tbl).where(tbl.c.user_id == user_id))
            ).mappings().one()
            return _to_assistant_key_envelope(row), created

    async def rotate_assistant_key_envelope(
        self,
        *,
        user_id: str,
        expected_version: int,
        kdf: str,
        kdf_params: dict[str, Any],
        salt: str,
        wrap_alg: str,
        wrap_nonce: str | None,
        wrapped_dek: str,
    ) -> AssistantKeyEnvelopeRow | None:
        """Optimistically update envelope for password change (increments key_version, keeps dek_epoch)."""
        tbl = schema.assistant_key_envelopes
        now = utc_now_iso()
        async with self._engine.begin() as conn:
            res = await conn.execute(
                update(tbl)
                .where(
                    tbl.c.user_id == user_id,
                    tbl.c.key_version == expected_version,
                )
                .values(
                    kdf=kdf,
                    kdf_params_json=json.dumps(kdf_params, separators=(",", ":"), sort_keys=True),
                    salt=salt,
                    wrap_alg=wrap_alg,
                    wrap_nonce=wrap_nonce,
                    wrapped_dek=wrapped_dek,
                    key_version=expected_version + 1,
                    updated_at=now,
                )
            )
            if res.rowcount == 0:
                return None
            row = (
                await conn.execute(select(tbl).where(tbl.c.user_id == user_id))
            ).mappings().one()
            return _to_assistant_key_envelope(row)

    async def reset_assistant_encryption(
        self,
        *,
        user_id: str,
        new_envelope: dict[str, Any] | None,
    ) -> tuple[AssistantKeyEnvelopeRow | None, int]:
        """Destructively wipe encrypted conversations and either install a fresh DEK envelope or disable encryption."""
        conv_tbl = schema.assistant_conversations
        env_tbl = schema.assistant_key_envelopes
        now = utc_now_iso()
        async with self._engine.begin() as conn:
            del_res = await conn.execute(
                delete(conv_tbl).where(
                    conv_tbl.c.user_id == user_id,
                    conv_tbl.c.encrypted == 1,
                )
            )
            wiped = int(del_res.rowcount or 0)
            existing = (
                await conn.execute(select(env_tbl).where(env_tbl.c.user_id == user_id))
            ).mappings().first()

            if new_envelope is None:
                if existing is not None:
                    await conn.execute(delete(env_tbl).where(env_tbl.c.user_id == user_id))
                return None, wiped

            next_version = int(existing["key_version"]) + 1 if existing is not None else 1
            next_epoch = int(existing["dek_epoch"]) + 1 if existing is not None else 1
            params_json = json.dumps(new_envelope["kdf_params"], separators=(",", ":"), sort_keys=True)
            if existing is None:
                await conn.execute(
                    insert(env_tbl).values(
                        user_id=user_id,
                        kdf=new_envelope["kdf"],
                        kdf_params_json=params_json,
                        salt=new_envelope["salt"],
                        wrap_alg=new_envelope["wrap_alg"],
                        wrap_nonce=new_envelope["wrap_nonce"],
                        wrapped_dek=new_envelope["wrapped_dek"],
                        key_version=next_version,
                        dek_epoch=next_epoch,
                        created_at=now,
                        updated_at=now,
                    )
                )
            else:
                await conn.execute(
                    update(env_tbl)
                    .where(env_tbl.c.user_id == user_id)
                    .values(
                        kdf=new_envelope["kdf"],
                        kdf_params_json=params_json,
                        salt=new_envelope["salt"],
                        wrap_alg=new_envelope["wrap_alg"],
                        wrap_nonce=new_envelope["wrap_nonce"],
                        wrapped_dek=new_envelope["wrapped_dek"],
                        key_version=next_version,
                        dek_epoch=next_epoch,
                        updated_at=now,
                    )
                )
            row = (
                await conn.execute(select(env_tbl).where(env_tbl.c.user_id == user_id))
            ).mappings().one()
            return _to_assistant_key_envelope(row), wiped

    async def delete_assistant_key_envelope(self, user_id: str) -> bool:
        tbl = schema.assistant_key_envelopes
        async with self._engine.begin() as conn:
            res = await conn.execute(delete(tbl).where(tbl.c.user_id == user_id))
            return res.rowcount > 0

    # ------------------------------------------------------------------
    # Tokens Anywhere managed key connections (T516)
    # ------------------------------------------------------------------

    async def get_assistant_tokens(self, user_id: str) -> AssistantTokensConnectionRow | None:
        tbl = schema.assistant_tokens_connections
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(select(tbl).where(tbl.c.user_id == user_id))
            ).mappings().first()
            return _to_assistant_tokens(row) if row else None

    async def insert_assistant_tokens_if_absent(
        self,
        *,
        user_id: str,
        key_enc: str,
        key_hash: str,
        key_prefix: str,
        refresh_enc: str | None,
        refreshed_at: int,
    ) -> tuple[AssistantTokensConnectionRow, bool]:
        tbl = schema.assistant_tokens_connections
        now = utc_now_iso()
        async with self._engine.begin() as conn:
            try:
                async with conn.begin_nested():
                    await conn.execute(
                        insert(tbl).values(
                            user_id=user_id,
                            key_enc=key_enc,
                            key_hash=key_hash,
                            key_prefix=key_prefix,
                            refresh_enc=refresh_enc,
                            refreshed_at=refreshed_at,
                            created_at=now,
                            updated_at=now,
                        )
                    )
                    created = True
            except IntegrityError:
                created = False
            row = (
                await conn.execute(select(tbl).where(tbl.c.user_id == user_id))
            ).mappings().one()
            return _to_assistant_tokens(row), created

    async def replace_assistant_tokens(
        self,
        *,
        user_id: str,
        key_enc: str,
        key_hash: str,
        key_prefix: str,
        refresh_enc: str | None,
        refreshed_at: int,
    ) -> AssistantTokensConnectionRow:
        tbl = schema.assistant_tokens_connections
        now = utc_now_iso()
        async with self._engine.begin() as conn:
            res = await conn.execute(
                update(tbl)
                .where(tbl.c.user_id == user_id)
                .values(
                    key_enc=key_enc,
                    key_hash=key_hash,
                    key_prefix=key_prefix,
                    refresh_enc=refresh_enc,
                    refreshed_at=refreshed_at,
                    created_at=now,
                    updated_at=now,
                )
            )
            if res.rowcount == 0:
                await conn.execute(
                    insert(tbl).values(
                        user_id=user_id,
                        key_enc=key_enc,
                        key_hash=key_hash,
                        key_prefix=key_prefix,
                        refresh_enc=refresh_enc,
                        refreshed_at=refreshed_at,
                        created_at=now,
                        updated_at=now,
                    )
                )
            row = (
                await conn.execute(select(tbl).where(tbl.c.user_id == user_id))
            ).mappings().one()
            return _to_assistant_tokens(row)

    async def update_assistant_tokens_refresh(
        self,
        *,
        user_id: str,
        refresh_enc: str | None,
        refreshed_at: int | None = None,
    ) -> bool:
        tbl = schema.assistant_tokens_connections
        values: dict[str, Any] = {
            "refresh_enc": refresh_enc,
            "updated_at": utc_now_iso(),
        }
        if refreshed_at is not None:
            values["refreshed_at"] = refreshed_at
        async with self._engine.begin() as conn:
            res = await conn.execute(
                update(tbl).where(tbl.c.user_id == user_id).values(**values)
            )
            return res.rowcount > 0

    async def delete_assistant_tokens(
        self,
        *,
        user_id: str,
        expected_key_hash: str | None = None,
    ) -> tuple[AssistantTokensConnectionRow | None, bool]:
        tbl = schema.assistant_tokens_connections
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(select(tbl).where(tbl.c.user_id == user_id))
            ).mappings().first()
            if row is None:
                return None, False
            current = _to_assistant_tokens(row)
            if expected_key_hash is not None and current.key_hash != expected_key_hash:
                return current, False
            res = await conn.execute(
                delete(tbl).where(
                    tbl.c.user_id == user_id,
                    tbl.c.key_hash == current.key_hash,
                )
            )
            return current, res.rowcount > 0


def _to_user(row: Any) -> UserRow:
    return UserRow(
        id=str(row["id"]),
        password_hash=str(row["password_hash"]),
        role=str(row["role"]),
        disabled=bool(row["disabled"]),
        email=row["email"],
        display_name=str(row["display_name"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _to_device(row: Any) -> DeviceRow:
    return DeviceRow(
        id=str(row["id"]),
        user_id=str(row["user_id"]),
        name=str(row["name"]),
        platform=str(row["platform"]),
        connector_version=str(row["connector_version"]),
        mode_hint=str(row["mode_hint"]),
        e2e_public_key_hint=row["e2e_public_key_hint"],
        created_at=str(row["created_at"]),
        last_seen_at=str(row["last_seen_at"]),
    )


def _to_client(row: Any) -> ClientRow:
    return ClientRow(
        id=str(row["id"]),
        user_id=str(row["user_id"]),
        platform=str(row["platform"]),
        label=str(row["label"]),
        push_token=row["push_token"],
        created_at=str(row["created_at"]),
        last_seen_at=str(row["last_seen_at"]),
    )


def _to_refresh(row: Any) -> RefreshTokenRow:
    return RefreshTokenRow(
        id=str(row["id"]),
        user_id=str(row["user_id"]),
        client_id=str(row["client_id"]),
        token_hash=str(row["token_hash"]),
        expires_at=int(row["expires_at"]),
        revoked_at=row["revoked_at"],
        created_at=str(row["created_at"]),
    )


def _to_mcp_client(row: Any) -> McpClientRow:
    return McpClientRow(
        client_id=str(row["client_id"]),
        client_name=str(row["client_name"]),
        redirect_uris=list(json.loads(row["redirect_uris_json"])),
        client_secret_hash=row["client_secret_hash"],
        created_at=str(row["created_at"]),
    )


def _to_mcp_grant(row: Any) -> McpGrantRow:
    return McpGrantRow(
        id=str(row["id"]),
        user_id=str(row["user_id"]),
        client_id=str(row["client_id"]),
        client_name=str(row["client_name"]),
        scopes=list(json.loads(row["scopes_json"])),
        device_ids=list(json.loads(row["device_ids_json"])),
        access_token_hash=str(row["access_token_hash"]),
        expires_at=int(row["expires_at"]),
        revoked_at=row["revoked_at"],
        created_at=str(row["created_at"]),
    )


def _to_drive_policy(row: Any) -> DrivePolicyRow:
    return DrivePolicyRow(
        user_id=str(row["user_id"]),
        quota_bytes=int(row["quota_bytes"]) if row["quota_bytes"] is not None else None,
        max_file_bytes=int(row["max_file_bytes"]) if row["max_file_bytes"] is not None else None,
        default_ttl_seconds=int(row["default_ttl_seconds"]) if row["default_ttl_seconds"] is not None else None,
        max_ttl_seconds=int(row["max_ttl_seconds"]) if row["max_ttl_seconds"] is not None else None,
        updated_by=row["updated_by"],
        updated_at=str(row["updated_at"]),
    )


def _to_drive_file(row: Any) -> DriveFileRow:
    return DriveFileRow(
        id=str(row["id"]),
        user_id=str(row["user_id"]),
        purpose=str(row["purpose"]),
        status=str(row["status"]),
        object_key=str(row["object_key"]),
        size_bytes=int(row["size_bytes"]),
        sha256=str(row["sha256"]),
        etag=row["etag"],
        filename=row["filename"],
        mime_type=row["mime_type"],
        vfs_path=row["vfs_path"],
        encryption_mode=str(row["encryption_mode"]),
        encryption_nonce=row["encryption_nonce"],
        encryption_key_version=(
            int(row["encryption_key_version"]) if row["encryption_key_version"] is not None else None
        ),
        encrypted_meta=row["encrypted_meta"],
        source_device_id=row["source_device_id"],
        ttl_seconds=int(row["ttl_seconds"]),
        upload_expires_at=int(row["upload_expires_at"]),
        expires_at=int(row["expires_at"]),
        created_at=str(row["created_at"]),
        completed_at=row["completed_at"],
        updated_at=str(row["updated_at"]),
    )


def _to_assistant_conversation_meta(row: Any) -> AssistantConversationMetaRow:
    return AssistantConversationMetaRow(
        user_id=str(row["user_id"]),
        conversation_id=str(row["conversation_id"]),
        encrypted=bool(row["encrypted"]),
        title=row["title"],
        updated_at=int(row["updated_at"]),
        content_hash=str(row["content_hash"]),
        device=str(row["device"]),
        size_bytes=int(row["size_bytes"]),
        key_version=int(row["key_version"]) if row["key_version"] is not None else None,
        dek_epoch=int(row["dek_epoch"]) if row["dek_epoch"] is not None else None,
        encrypted_meta=row["encrypted_meta"],
        meta_nonce=row["meta_nonce"],
        server_updated_at=str(row["server_updated_at"]),
    )


def _to_assistant_conversation(row: Any) -> AssistantConversationRow:
    return AssistantConversationRow(
        user_id=str(row["user_id"]),
        conversation_id=str(row["conversation_id"]),
        encrypted=bool(row["encrypted"]),
        title=row["title"],
        updated_at=int(row["updated_at"]),
        content_hash=str(row["content_hash"]),
        device=str(row["device"]),
        size_bytes=int(row["size_bytes"]),
        key_version=int(row["key_version"]) if row["key_version"] is not None else None,
        dek_epoch=int(row["dek_epoch"]) if row["dek_epoch"] is not None else None,
        encrypted_meta=row["encrypted_meta"],
        meta_nonce=row["meta_nonce"],
        server_updated_at=str(row["server_updated_at"]),
        messages_json=row["messages_json"],
        settings_json=row["settings_json"],
        nonce=row["nonce"],
        ciphertext=row["ciphertext"],
    )


def _to_assistant_key_envelope(row: Any) -> AssistantKeyEnvelopeRow:
    return AssistantKeyEnvelopeRow(
        user_id=str(row["user_id"]),
        kdf=str(row["kdf"]),
        kdf_params=dict(json.loads(row["kdf_params_json"])),
        salt=str(row["salt"]),
        wrap_alg=str(row["wrap_alg"]),
        wrap_nonce=row["wrap_nonce"],
        wrapped_dek=str(row["wrapped_dek"]),
        key_version=int(row["key_version"]),
        dek_epoch=int(row["dek_epoch"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _to_assistant_tokens(row: Any) -> AssistantTokensConnectionRow:
    return AssistantTokensConnectionRow(
        user_id=str(row["user_id"]),
        key_enc=str(row["key_enc"]),
        key_hash=str(row["key_hash"]),
        key_prefix=str(row["key_prefix"]),
        refresh_enc=row["refresh_enc"],
        refreshed_at=int(row["refreshed_at"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )
