"""Email account identity and durable verification state.

User IDs remain stable storage keys. Email addresses are independent, unique
login identifiers; old rows are intentionally left without an email.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import time
from typing import Any

from sqlalchemy import case, delete, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from agent_server.core.auth import (
    hash_password,
    password_salt,
    verify_password,
    verify_password_verifier,
)
from agent_server.core.models import UserView
from agent_server.core.utc import utc_now
from agent_server.infra.db.schema import email_verification_codes as codes_t
from agent_server.infra.db.schema import email_verification_limits as limits_t
from agent_server.infra.db.schema import oauth_accounts as oauth_accounts_t
from agent_server.infra.db.schema import users as users_t
from agent_server.infra.repositories.store_support import _user_from_row

CODE_TTL = 600
CODE_COOLDOWN = 60
CODE_ATTEMPTS = 5
RATE_WINDOW = 3600


class EmailVerificationError(ValueError):
    pass


class EmailRateLimitError(ValueError):
    pass


def normalize_email(value: str) -> str:
    email = (value or "").strip().lower()
    if len(email) > 254 or email.count("@") != 1:
        raise ValueError("a valid email address is required")
    local, domain = email.split("@")
    if (
        not local
        or len(local) > 64
        or local.startswith(".")
        or local.endswith(".")
        or ".." in local
        or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+", local)
    ):
        raise ValueError("a valid email address is required")
    try:
        domain = domain.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise ValueError("a valid email address is required") from exc
    labels = domain.split(".")
    if len(labels) < 2 or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in labels
    ):
        raise ValueError("a valid email address is required")
    email = f"{local}@{domain}"
    if len(email) > 254:
        raise ValueError("a valid email address is required")
    return email


def normalize_display_name(value: str | None) -> str:
    display_name = (value or "").strip()
    if (
        not display_name
        or len(display_name) > 64
        or any(ord(char) < 32 for char in display_name)
    ):
        raise ValueError("display name must be 1-64 characters")
    return display_name


def _scope(email: str, purpose: str, user_id: str) -> str:
    return hashlib.sha256(f"{email}\0{purpose}\0{user_id}".encode()).hexdigest()


def _code_hash(nonce: str, code: str) -> str:
    secret = os.environ.get("AGENT_SERVER_SECRET", "agent-server-dev-secret").encode()
    return hmac.new(
        secret, f"email-code:{nonce}:{code}".encode(), hashlib.sha256
    ).hexdigest()


class EmailAccountRepositoryMixin:
    async def user_for_email(self, email: str) -> UserView | None:
        normalized = normalize_email(email)
        async with self._engine.connect() as conn:
            row = (
                (
                    await conn.execute(
                        select(users_t).where(users_t.c.email == normalized)
                    )
                )
                .mappings()
                .first()
            )
        return _user_from_row(row) if row is not None else None

    async def _email_login_row(self, email: str) -> Any:
        normalized = normalize_email(email)
        async with self._engine.connect() as conn:
            return (
                (
                    await conn.execute(
                        select(users_t).where(
                            users_t.c.email == normalized,
                            users_t.c.disabled == 0,
                            users_t.c.email_verified_at.is_not(None),
                        )
                    )
                )
                .mappings()
                .first()
            )

    async def password_salt_for_email(self, email: str) -> str | None:
        row = await self._email_login_row(email)
        return password_salt(row["password_hash"]) if row is not None else None

    async def verify_email_user(
        self,
        *,
        email: str,
        password: str | None = None,
        verifier: str | None = None,
    ) -> UserView | None:
        row = await self._email_login_row(email)
        if row is None:
            return None
        valid = (
            verify_password_verifier(verifier, row["password_hash"])
            if verifier is not None
            else bool(
                password is not None and verify_password(password, row["password_hash"])
            )
        )
        return _user_from_row(row) if valid else None

    async def issue_email_code(
        self, *, email: str, purpose: str, user_id: str = "", ip: str
    ) -> str:
        email = normalize_email(email)
        if purpose not in {"register", "bind"} or (purpose == "bind" and not user_id):
            raise ValueError("invalid email verification purpose")
        now = int(time.time())
        scope = _scope(email, purpose, user_id)
        code = f"{secrets.randbelow(1_000_000):06d}"
        nonce = secrets.token_urlsafe(24)
        async with self._engine.begin() as conn:
            await conn.execute(delete(codes_t).where(codes_t.c.sent_at < now - 86400))
            await conn.execute(
                delete(limits_t).where(limits_t.c.window_start < now - 86400)
            )
            # Atomic database counters protect across workers, devices, and restarts.
            for kind, value, maximum in (("email", email, 10), ("ip", ip, 30)):
                key = f"{kind}:{hashlib.sha256(value.encode()).hexdigest()}"
                upsert = (
                    pg_insert if conn.dialect.name == "postgresql" else sqlite_insert
                )
                await conn.execute(
                    upsert(limits_t)
                    .values(key=key, window_start=now, count=0)
                    .on_conflict_do_nothing()
                )
                reset = limits_t.c.window_start <= now - RATE_WINDOW
                row = (
                    await conn.execute(
                        update(limits_t)
                        .where(limits_t.c.key == key)
                        .values(
                            count=case((reset, 1), else_=limits_t.c.count + 1),
                            window_start=case(
                                (reset, now), else_=limits_t.c.window_start
                            ),
                        )
                        .returning(limits_t.c.count)
                    )
                ).first()
                if row[0] > maximum:
                    raise EmailRateLimitError(
                        "too many verification emails; try again later"
                    )
            upsert = pg_insert if conn.dialect.name == "postgresql" else sqlite_insert
            await conn.execute(
                upsert(codes_t)
                .values(
                    scope=scope,
                    email=email,
                    purpose=purpose,
                    user_id=user_id,
                    code_hash="",
                    nonce="",
                    sent_at=0,
                    expires_at=0,
                    failed_attempts=0,
                    attempt_window=now,
                )
                .on_conflict_do_nothing()
            )
            row = (
                (
                    await conn.execute(
                        select(codes_t)
                        .where(codes_t.c.scope == scope)
                        .with_for_update()
                    )
                )
                .mappings()
                .one()
            )
            if row["sent_at"] > now - CODE_COOLDOWN:
                raise EmailRateLimitError(
                    "wait 60 seconds before requesting another code"
                )
            reset_attempts = row["attempt_window"] <= now - RATE_WINDOW
            if row["failed_attempts"] >= CODE_ATTEMPTS and not reset_attempts:
                raise EmailRateLimitError("too many incorrect codes; try again later")
            await conn.execute(
                update(codes_t)
                .where(codes_t.c.scope == scope)
                .values(
                    code_hash=_code_hash(nonce, code),
                    nonce=nonce,
                    sent_at=now,
                    expires_at=now + CODE_TTL,
                    consumed_at=None,
                    failed_attempts=0 if reset_attempts else row["failed_attempts"],
                    attempt_window=now if reset_attempts else row["attempt_window"],
                )
            )
        return code

    async def invalidate_email_code(
        self, *, email: str, purpose: str, user_id: str = "", code: str
    ) -> None:
        """A failed delivery cannot leave its unsent code usable."""
        scope = _scope(normalize_email(email), purpose, user_id)
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        select(codes_t)
                        .where(codes_t.c.scope == scope)
                        .with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            if row and hmac.compare_digest(
                row["code_hash"], _code_hash(row["nonce"], code)
            ):
                await conn.execute(
                    update(codes_t)
                    .where(codes_t.c.scope == scope)
                    .values(consumed_at=int(time.time()))
                )

    async def _consume_email_code(
        self,
        conn: AsyncConnection,
        *,
        email: str,
        purpose: str,
        user_id: str,
        code: str | None,
    ) -> bool:
        scope = _scope(email, purpose, user_id)
        row = (
            (
                await conn.execute(
                    select(codes_t).where(codes_t.c.scope == scope).with_for_update()
                )
            )
            .mappings()
            .first()
        )
        now = int(time.time())
        if (
            row is None
            or row["consumed_at"] is not None
            or row["expires_at"] <= now
            or row["failed_attempts"] >= CODE_ATTEMPTS
        ):
            return False
        if not code or not hmac.compare_digest(
            row["code_hash"], _code_hash(row["nonce"], code)
        ):
            await conn.execute(
                update(codes_t)
                .where(codes_t.c.scope == scope)
                .values(failed_attempts=codes_t.c.failed_attempts + 1)
            )
            return False
        # The conditional write also gives SQLite atomic one-use consumption.
        consumed = await conn.execute(
            update(codes_t)
            .where(
                codes_t.c.scope == scope,
                codes_t.c.consumed_at.is_(None),
                codes_t.c.failed_attempts < CODE_ATTEMPTS,
                codes_t.c.code_hash == row["code_hash"],
            )
            .values(consumed_at=now)
        )
        return consumed.rowcount == 1

    async def create_email_user(
        self,
        *,
        email: str,
        display_name: str,
        password: str | None = None,
        password_hash: str | None = None,
        role: str = "member",
        verification_code: str | None = None,
        require_verification: bool = False,
        _bootstrap: bool = False,
        oauth_account: dict[str, str | None] | None = None,
    ) -> UserView | None:
        email = normalize_email(email)
        display_name = normalize_display_name(display_name)
        stored_password = password_hash or (
            hash_password(password) if password else None
        )
        if not stored_password:
            raise ValueError("password is required")
        if role not in {"admin", "member"}:
            raise ValueError("invalid role")
        user_id = f"usr_{secrets.token_hex(12)}"
        now = utc_now()
        valid_code = True
        try:
            async with self._engine.begin() as conn:
                if _bootstrap:
                    # Serialize first-account creation for PostgreSQL, also covering
                    # concurrent attempts with different email addresses.
                    if conn.dialect.name == "postgresql":
                        from sqlalchemy import text

                        await conn.execute(
                            text("SELECT pg_advisory_xact_lock(4141454)")
                        )
                    if (
                        await conn.execute(select(func.count()).select_from(users_t))
                    ).scalar_one():
                        return None
                if require_verification:
                    valid_code = await self._consume_email_code(
                        conn,
                        email=email,
                        purpose="register",
                        user_id="",
                        code=verification_code,
                    )
                if valid_code:
                    await conn.execute(
                        insert(users_t).values(
                            id=user_id,
                            email=email,
                            email_verified_at=now,
                            display_name=display_name,
                            password_hash=stored_password,
                            role=role,
                            disabled=0,
                            created_at=now,
                            updated_at=now,
                        )
                    )
                    if oauth_account is not None:
                        await conn.execute(
                            insert(oauth_accounts_t).values(
                                **oauth_account,
                                user_id=user_id,
                                created_at=now,
                                updated_at=now,
                            )
                        )
                    if _bootstrap:
                        await self.instance_settings.upsert_on_connection(
                            conn, "registration_open", "false", now
                        )
        except IntegrityError as exc:
            raise ValueError("email is already in use") from exc
        if not valid_code:
            raise EmailVerificationError("invalid or expired verification code")
        return await self.get_user(user_id)

    async def bootstrap_email_admin(self, **kwargs: Any) -> UserView | None:
        return await self.create_email_user(**kwargs, role="admin", _bootstrap=True)

    async def bind_user_email(
        self,
        user_id: str,
        *,
        email: str,
        verification_code: str | None = None,
        require_verification: bool = False,
    ) -> UserView:
        email = normalize_email(email)
        valid_code = True
        try:
            async with self._engine.begin() as conn:
                if require_verification:
                    valid_code = await self._consume_email_code(
                        conn,
                        email=email,
                        purpose="bind",
                        user_id=user_id,
                        code=verification_code,
                    )
                if valid_code:
                    result = await conn.execute(
                        update(users_t)
                        .where(users_t.c.id == user_id, users_t.c.disabled == 0)
                        .values(
                            email=email,
                            email_verified_at=utc_now(),
                            updated_at=utc_now(),
                        )
                    )
                    if result.rowcount != 1:
                        raise ValueError("user is unavailable")
        except IntegrityError as exc:
            raise ValueError("email is already in use") from exc
        if not valid_code:
            raise EmailVerificationError("invalid or expired verification code")
        return await self.get_user(user_id)

    async def update_user_display_name(
        self, user_id: str, display_name: str
    ) -> UserView:
        display_name = normalize_display_name(display_name)
        async with self._engine.begin() as conn:
            await conn.execute(
                update(users_t)
                .where(users_t.c.id == user_id)
                .values(display_name=display_name, updated_at=utc_now())
            )
        return await self.get_user(user_id)
