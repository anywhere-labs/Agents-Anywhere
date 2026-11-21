from __future__ import annotations

import json
import secrets
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, func, insert, select, update
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
