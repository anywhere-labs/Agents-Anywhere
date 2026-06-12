from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class UserRepositoryMixin:
    @staticmethod
    def normalize_user_id(user_id: str) -> str:
        """Trim and lowercase; raise ValueError if format invalid."""
        normalized = (user_id or "").strip().lower()
        if not normalized:
            raise ValueError("user id is required")
        if not USERNAME_RE.match(normalized):
            raise ValueError(
                "user id must be 3-32 chars of lowercase letters, digits, hyphen or underscore"
            )
        return normalized


    async def create_user(
        self,
        *,
        user_id: str,
        password: str | None = None,
        password_hash: str | None = None,
        role: UserRole = MEMBER_ROLE,
    ) -> UserView:
        normalized = self.normalize_user_id(user_id)
        stored_password = password_hash or (hash_password(password) if password else None)
        if not stored_password:
            raise ValueError("password is required")
        if role not in (ADMIN_ROLE, MEMBER_ROLE):
            raise ValueError(f"invalid role: {role}")
        now = utc_now()
        async with self._engine.begin() as conn:
            try:
                await conn.execute(
                    insert(users_t).values(
                        id=normalized,
                        password_hash=stored_password,
                        role=role,
                        disabled=0,
                        created_at=now,
                        updated_at=now,
                    )
                )
            except IntegrityError as exc:
                raise ValueError("user already exists") from exc
        return await self.get_user(normalized)


    async def verify_user(self, *, user_id: str, password: str) -> UserView | None:
        """Return the user if credentials match and account is enabled, else None."""
        normalized = (user_id or "").strip().lower()
        if not normalized:
            return None
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(users_t).where(users_t.c.id == normalized)
                )
            ).mappings().first()
        if row is None or row["disabled"]:
            return None
        if not verify_password(password, row["password_hash"]):
            return None
        return _user_from_row(row)


    async def password_salt_for_user(self, user_id: str) -> str | None:
        normalized = (user_id or "").strip().lower()
        if not normalized:
            return None
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(users_t.c.password_hash, users_t.c.disabled).where(users_t.c.id == normalized)
                )
            ).mappings().first()
        if row is None or row["disabled"]:
            return None
        return password_salt(row["password_hash"])


    async def verify_user_verifier(self, *, user_id: str, verifier: str) -> UserView | None:
        normalized = (user_id or "").strip().lower()
        if not normalized:
            return None
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(users_t).where(users_t.c.id == normalized)
                )
            ).mappings().first()
        if row is None or row["disabled"]:
            return None
        if not verify_password_verifier(verifier, row["password_hash"]):
            return None
        return _user_from_row(row)


    async def oauth_user_for_subject(self, *, provider: str, subject: str) -> UserView | None:
        provider = (provider or "").strip().lower()
        subject = (subject or "").strip()
        if not provider or not subject:
            return None
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(users_t)
                    .select_from(oauth_accounts_t.join(users_t, oauth_accounts_t.c.user_id == users_t.c.id))
                    .where(
                        oauth_accounts_t.c.provider == provider,
                        oauth_accounts_t.c.subject == subject,
                    )
                )
            ).mappings().first()
        if row is None or row["disabled"]:
            return None
        return _user_from_row(row)


    async def bind_oauth_account(
        self,
        *,
        user_id: str,
        provider: str,
        subject: str,
        email: str | None = None,
        display_name: str | None = None,
    ) -> UserView:
        normalized = self.normalize_user_id(user_id)
        provider = (provider or "").strip().lower()
        subject = (subject or "").strip()
        if not provider:
            raise ValueError("oauth provider is required")
        if not subject:
            raise ValueError("oauth subject is required")
        now = utc_now()
        async with self._engine.begin() as conn:
            user = (
                await conn.execute(select(users_t).where(users_t.c.id == normalized))
            ).mappings().first()
            if user is None:
                raise KeyError(user_id)
            if user["disabled"]:
                raise ValueError("user is disabled")
            existing = (
                await conn.execute(
                    select(oauth_accounts_t.c.user_id).where(
                        oauth_accounts_t.c.provider == provider,
                        oauth_accounts_t.c.subject == subject,
                    )
                )
            ).first()
            if existing is not None and existing.user_id != normalized:
                raise ValueError("oauth account is already bound")
            values = {
                "provider": provider,
                "subject": subject,
                "user_id": normalized,
                "email": email,
                "display_name": display_name,
                "updated_at": now,
            }
            if existing is None:
                await conn.execute(
                    insert(oauth_accounts_t).values(**values, created_at=now)
                )
            else:
                await conn.execute(
                    update(oauth_accounts_t)
                    .where(
                        oauth_accounts_t.c.provider == provider,
                        oauth_accounts_t.c.subject == subject,
                    )
                    .values(**values)
                )
        return await self.get_user(normalized)


    async def create_user_with_oauth(
        self,
        *,
        user_id: str,
        provider: str,
        subject: str,
        password: str | None = None,
        password_hash: str | None = None,
        email: str | None = None,
        display_name: str | None = None,
        role: UserRole = MEMBER_ROLE,
    ) -> UserView:
        user = await self.create_user(
            user_id=user_id,
            password=password or secrets.token_urlsafe(24),
            password_hash=password_hash,
            role=role,
        )
        return await self.bind_oauth_account(
            user_id=user.userId,
            provider=provider,
            subject=subject,
            email=email,
            display_name=display_name,
        )


    async def user_exists(self, user_id: str) -> bool:
        normalized = (user_id or "").strip().lower()
        if not normalized:
            return False
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(select(users_t.c.id).where(users_t.c.id == normalized))
            ).first()
        return row is not None


    async def get_user(self, user_id: str) -> UserView:
        normalized = (user_id or "").strip().lower()
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(select(users_t).where(users_t.c.id == normalized))
            ).mappings().first()
        if row is None:
            raise KeyError(user_id)
        return _user_from_row(row)


    async def count_users(self) -> int:
        async with self._engine.connect() as conn:
            row = (await conn.execute(select(func.count()).select_from(users_t))).first()
        return int(row[0]) if row else 0


    async def count_admins(self, *, active_only: bool = True) -> int:
        query = select(func.count()).select_from(users_t).where(users_t.c.role == ADMIN_ROLE)
        if active_only:
            query = query.where(users_t.c.disabled == 0)
        async with self._engine.connect() as conn:
            row = (await conn.execute(query)).first()
        return int(row[0]) if row else 0


    async def list_users(self) -> list[UserView]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(select(users_t).order_by(users_t.c.created_at.asc()))
            ).mappings().all()
        return [_user_from_row(row) for row in rows]


    async def set_user_avatar(self, user_id: str, avatar: str | None) -> UserView:
        normalized = (user_id or "").strip().lower()
        now = utc_now()
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(users_t)
                .where(users_t.c.id == normalized)
                .values(avatar=avatar, updated_at=now)
            )
            if result.rowcount == 0:
                raise KeyError(user_id)
        return await self.get_user(normalized)


    async def update_user_password(
        self,
        user_id: str,
        password: str | None = None,
        *,
        password_hash: str | None = None,
    ) -> None:
        stored_password = password_hash or (hash_password(password) if password else None)
        if not stored_password:
            raise ValueError("password is required")
        normalized = (user_id or "").strip().lower()
        now = utc_now()
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(users_t)
                .where(users_t.c.id == normalized)
                .values(password_hash=stored_password, updated_at=now)
            )
            if result.rowcount == 0:
                raise KeyError(user_id)


    async def record_mobile_login_token(
        self,
        *,
        token: str,
        user_id: str,
        expires_at: str,
    ) -> None:
        normalized = (user_id or "").strip().lower()
        await self.get_user(normalized)
        now = utc_now()
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(mobile_login_tokens_t).values(
                    token_hash=_mobile_login_token_hash(token),
                    user_id=normalized,
                    device_name=None,
                    expires_at=expires_at,
                    created_at=now,
                    requested_at=None,
                    approved_at=None,
                    rejected_at=None,
                    consumed_at=None,
                )
            )


    async def request_mobile_login_token(
        self,
        *,
        token: str,
        user_id: str,
        device_name: str | None = None,
    ) -> dict[str, Any] | None:
        normalized = (user_id or "").strip().lower()
        token_hash = _mobile_login_token_hash(token)
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(mobile_login_tokens_t).where(
                        mobile_login_tokens_t.c.token_hash == token_hash,
                        mobile_login_tokens_t.c.user_id == normalized,
                    )
                )
            ).mappings().first()
            if row is None or row["consumed_at"] is not None or row["expires_at"] < now:
                return None
            if row["rejected_at"] is not None:
                return dict(row)
            await conn.execute(
                update(mobile_login_tokens_t)
                .where(mobile_login_tokens_t.c.token_hash == token_hash)
                .values(
                    device_name=(device_name or "").strip()[:80] or None,
                    requested_at=row["requested_at"] or now,
                )
            )
        return await self.mobile_login_token_status(token=token)


    async def mobile_login_token_status(self, *, token: str) -> dict[str, Any] | None:
        token_hash = _mobile_login_token_hash(token)
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(mobile_login_tokens_t).where(mobile_login_tokens_t.c.token_hash == token_hash)
                )
            ).mappings().first()
        return dict(row) if row is not None else None


    async def resolve_mobile_login_token(self, *, token: str, approved: bool) -> dict[str, Any] | None:
        token_hash = _mobile_login_token_hash(token)
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(mobile_login_tokens_t).where(mobile_login_tokens_t.c.token_hash == token_hash)
                )
            ).mappings().first()
            if row is None or row["consumed_at"] is not None or row["expires_at"] < now:
                return None
            if row["requested_at"] is None:
                return dict(row)
            values = {"approved_at": now, "rejected_at": None} if approved else {"approved_at": None, "rejected_at": now}
            await conn.execute(
                update(mobile_login_tokens_t)
                .where(mobile_login_tokens_t.c.token_hash == token_hash)
                .values(**values)
            )
        return await self.mobile_login_token_status(token=token)


    async def consume_mobile_login_token(self, *, token: str, user_id: str) -> bool:
        normalized = (user_id or "").strip().lower()
        token_hash = _mobile_login_token_hash(token)
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(mobile_login_tokens_t).where(
                        mobile_login_tokens_t.c.token_hash == token_hash,
                        mobile_login_tokens_t.c.user_id == normalized,
                    )
                )
            ).mappings().first()
            if (
                row is None
                or row["consumed_at"] is not None
                or row["expires_at"] < now
                or row["approved_at"] is None
                or row["rejected_at"] is not None
            ):
                return False
            await conn.execute(
                update(mobile_login_tokens_t)
                .where(mobile_login_tokens_t.c.token_hash == token_hash)
                .values(consumed_at=now)
            )
            return True


    async def update_user_role(self, user_id: str, role: UserRole) -> UserView:
        if role not in (ADMIN_ROLE, MEMBER_ROLE):
            raise ValueError(f"invalid role: {role}")
        normalized = (user_id or "").strip().lower()
        now = utc_now()
        async with self._engine.begin() as conn:
            current = (
                await conn.execute(select(users_t).where(users_t.c.id == normalized))
            ).mappings().first()
            if current is None:
                raise KeyError(user_id)
            # Guard: cannot demote the last active admin.
            if (
                current["role"] == ADMIN_ROLE
                and role != ADMIN_ROLE
                and not current["disabled"]
                and await self._count_other_active_admins(conn, normalized) == 0
            ):
                raise ValueError("cannot demote the last admin")
            await conn.execute(
                update(users_t)
                .where(users_t.c.id == normalized)
                .values(role=role, updated_at=now)
            )
        return await self.get_user(normalized)


    async def set_user_disabled(self, user_id: str, disabled: bool) -> UserView:
        normalized = (user_id or "").strip().lower()
        now = utc_now()
        async with self._engine.begin() as conn:
            current = (
                await conn.execute(select(users_t).where(users_t.c.id == normalized))
            ).mappings().first()
            if current is None:
                raise KeyError(user_id)
            # Guard: cannot disable the last active admin.
            if (
                disabled
                and current["role"] == ADMIN_ROLE
                and not current["disabled"]
                and await self._count_other_active_admins(conn, normalized) == 0
            ):
                raise ValueError("cannot disable the last admin")
            await conn.execute(
                update(users_t)
                .where(users_t.c.id == normalized)
                .values(disabled=1 if disabled else 0, updated_at=now)
            )
        return await self.get_user(normalized)


    async def delete_user(self, user_id: str) -> None:
        normalized = (user_id or "").strip().lower()
        async with self._engine.begin() as conn:
            current = (
                await conn.execute(select(users_t).where(users_t.c.id == normalized))
            ).mappings().first()
            if current is None:
                raise KeyError(user_id)
            # Guard: cannot delete the last active admin.
            if (
                current["role"] == ADMIN_ROLE
                and not current["disabled"]
                and await self._count_other_active_admins(conn, normalized) == 0
            ):
                raise ValueError("cannot delete the last admin")
            await conn.execute(delete(users_t).where(users_t.c.id == normalized))


    async def _count_other_active_admins(self, conn: AsyncConnection, excluded_user_id: str) -> int:
        row = (
            await conn.execute(
                select(func.count())
                .select_from(users_t)
                .where(
                    users_t.c.role == ADMIN_ROLE,
                    users_t.c.disabled == 0,
                    users_t.c.id != excluded_user_id,
                )
            )
        ).first()
        return int(row[0]) if row else 0

    # --- instance_settings ----------------------------------------------------
