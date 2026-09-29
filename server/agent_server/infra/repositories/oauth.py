from __future__ import annotations

from agent_server.core.oauth_clients import (
    FirstPartyOAuthClient,
    device_grant_oauth_client,
    first_party_oauth_client,
)
from agent_server.core.oauth_device import (
    DEVICE_APPROVAL_CONFLICT,
    DEVICE_APPROVAL_CONFLICT_DESCRIPTION,
    DEVICE_CODE_TTL_SECONDS,
    DEVICE_POLL_INTERVAL_SECONDS,
    MAX_USER_CODE_ATTEMPTS,
    SLOW_DOWN_INCREMENT_SECONDS,
    USER_CODE_ATTEMPT_WINDOW_SECONDS,
    OAuthDeviceFlowError,
    generate_device_code,
    generate_user_code,
    hash_secret,
    normalize_user_code,
)
from agent_server.infra.repositories.store_support import *


class OAuthRepositoryMixin:
    async def list_oauth_clients(self) -> list[OAuthClientView]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(select(oauth_clients_t).order_by(oauth_clients_t.c.created_at.asc()))
            ).mappings().all()
        return [_oauth_client_from_row(row) for row in rows]


    async def create_oauth_client(self, *, name: str, redirect_uris: list[str]) -> OAuthClientView:
        clean_name = (name or "").strip()
        if not clean_name:
            raise ValueError("client name is required")
        clean_redirects = [_normalize_redirect_uri(uri) for uri in redirect_uris if uri.strip()]
        if not clean_redirects:
            raise ValueError("at least one redirect uri is required")
        client_id = f"client_{secrets.token_urlsafe(18)}"
        now = utc_now()
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(oauth_clients_t).values(
                    id=client_id,
                    name=clean_name,
                    redirect_uris_json=_json_dumps(clean_redirects),
                    created_at=now,
                    updated_at=now,
                )
            )
        return await self.get_oauth_client(client_id)


    async def get_oauth_client(self, client_id: str) -> OAuthClientView:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(select(oauth_clients_t).where(oauth_clients_t.c.id == client_id))
            ).mappings().first()
        if row is None:
            raise KeyError(client_id)
        return _oauth_client_from_row(row)


    async def delete_oauth_client(self, client_id: str) -> None:
        async with self._engine.begin() as conn:
            result = await conn.execute(delete(oauth_clients_t).where(oauth_clients_t.c.id == client_id))
            if result.rowcount == 0:
                raise KeyError(client_id)


    async def create_oauth_authorization_code(
        self,
        *,
        client_id: str,
        user_id: str,
        redirect_uri: str,
        scope: str,
        code_challenge: str,
        code_challenge_method: str,
    ) -> str:
        redirect_uri = _normalize_redirect_uri(redirect_uri)
        first_party_client = first_party_oauth_client(client_id)
        if first_party_client is not None:
            allowed = first_party_client.allows_redirect(redirect_uri)
        else:
            client = await self.get_oauth_client(client_id)
            allowed = redirect_uri in client.redirectUris
        if not allowed:
            raise ValueError("redirect uri is not registered")
        if code_challenge_method != "S256":
            raise ValueError("code challenge method must be S256")
        if not code_challenge:
            raise ValueError("code challenge is required")
        await self.get_user(user_id)
        code = secrets.token_urlsafe(32)
        now_dt = datetime.now(UTC)
        now = now_dt.isoformat().replace("+00:00", "Z")
        expires_at = (now_dt + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        async with self._engine.begin() as conn:
            if first_party_client is not None:
                await self._ensure_first_party_client_row(conn, first_party_client, now)
            await conn.execute(
                insert(oauth_authorization_codes_t).values(
                    code_hash=_oauth_code_hash(code),
                    client_id=client_id,
                    user_id=user_id,
                    redirect_uri=redirect_uri,
                    scope=scope or "",
                    code_challenge=code_challenge,
                    code_challenge_method=code_challenge_method,
                    expires_at=expires_at,
                    consumed_at=None,
                    created_at=now,
                )
            )
        return code


    async def consume_oauth_authorization_code(
        self,
        *,
        code: str,
        client_id: str,
        redirect_uri: str,
        code_verifier: str,
    ) -> tuple[UserView, str]:
        code_hash = _oauth_code_hash(code)
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(oauth_authorization_codes_t).where(
                        oauth_authorization_codes_t.c.code_hash == code_hash,
                        oauth_authorization_codes_t.c.client_id == client_id,
                    )
                )
            ).mappings().first()
            if row is None or row["consumed_at"] is not None:
                raise ValueError("invalid authorization code")
            if row["redirect_uri"] != _normalize_redirect_uri(redirect_uri):
                raise ValueError("redirect uri mismatch")
            if row["expires_at"] < now:
                raise ValueError("authorization code expired")
            if row["code_challenge_method"] != "S256":
                raise ValueError("unsupported code challenge method")
            if _pkce_challenge(code_verifier) != row["code_challenge"]:
                raise ValueError("invalid code verifier")
            consumed = await conn.execute(
                update(oauth_authorization_codes_t)
                .where(
                    oauth_authorization_codes_t.c.code_hash == code_hash,
                    oauth_authorization_codes_t.c.consumed_at.is_(None),
                )
                .values(consumed_at=now)
            )
            if consumed.rowcount != 1:
                raise ValueError("invalid authorization code")
            user_id = row["user_id"]
            scope = row["scope"]
        return await self.get_user(user_id), scope


    async def create_oauth_device_code(
        self,
        *,
        client_id: str,
        scope: str = "",
    ) -> tuple[str, str, int]:
        """Start a device authorization request.

        Returns ``(device_code, user_code, interval)``.  The device code is the
        high-entropy polling secret; the user code is the readable value the
        user types at the web device page.  Only their hashes are stored.

        The grant is scoped to the plug-in client: any other client id raises
        ``KeyError`` so the endpoint answers 404 exactly as it does for an
        unknown client.
        """

        client = device_grant_oauth_client(client_id)
        if client is None:
            raise KeyError(client_id)
        now_dt = datetime.now(UTC)
        now = now_dt.isoformat().replace("+00:00", "Z")
        expires_at = (
            now_dt + timedelta(seconds=DEVICE_CODE_TTL_SECONDS)
        ).isoformat().replace("+00:00", "Z")
        device_code = generate_device_code()
        interval = DEVICE_POLL_INTERVAL_SECONDS
        async with self._engine.begin() as conn:
            await self._ensure_first_party_client_row(conn, client, now)
            # Opportunistically drop requests that can no longer be used.
            await conn.execute(
                delete(oauth_device_codes_t).where(
                    oauth_device_codes_t.c.expires_at < now
                )
            )
            for _ in range(5):
                user_code = generate_user_code()
                user_code_hash = hash_secret(normalize_user_code(user_code))
                live = (
                    await conn.execute(
                        select(oauth_device_codes_t.c.device_code_hash).where(
                            oauth_device_codes_t.c.user_code_hash == user_code_hash,
                            oauth_device_codes_t.c.consumed_at.is_(None),
                            oauth_device_codes_t.c.expires_at > now,
                        )
                    )
                ).first()
                if live is None:
                    break
            else:
                raise ValueError("could not allocate a unique user code")
            await conn.execute(
                insert(oauth_device_codes_t).values(
                    device_code_hash=hash_secret(device_code),
                    user_code_hash=user_code_hash,
                    client_id=client_id,
                    scope=scope or "",
                    status="pending",
                    user_id=None,
                    interval_seconds=interval,
                    expires_at=expires_at,
                    last_polled_at=None,
                    approved_at=None,
                    consumed_at=None,
                    created_at=now,
                )
            )
        return device_code, user_code, interval


    async def lookup_oauth_device_code(
        self,
        *,
        user_code: str,
        user_id: str,
    ) -> dict[str, Any] | None:
        """Return the live request a user code names, or ``None``.

        Requires an authenticated caller (enforced by the API layer).  A miss is
        counted against the caller so a signed-in account cannot scan the short
        code space.
        """

        now_dt = datetime.now(UTC)
        now = now_dt.isoformat().replace("+00:00", "Z")
        async with self._engine.begin() as conn:
            if not await self._device_code_attempt_allowed(conn, user_id=user_id, now=now_dt):
                raise OAuthDeviceFlowError(
                    "too_many_requests", "too many incorrect codes; try again later"
                )
            row = await self._find_live_device_code(conn, user_code=user_code, now=now)
            if row is None:
                await self._device_code_record_failure(conn, user_id=user_id, now=now_dt)
                return None
            await self._device_code_clear_attempts(conn, user_id=user_id)
            client = first_party_oauth_client(row["client_id"])
        return self._device_code_view(row, status=row["status"], client=client, server_time=now)


    async def approve_oauth_device_code(
        self,
        *,
        user_code: str,
        user_id: str,
        approved: bool,
    ) -> dict[str, Any]:
        """Approve or deny the request a signed-in user typed the code for."""

        now_dt = datetime.now(UTC)
        now = now_dt.isoformat().replace("+00:00", "Z")
        view: dict[str, Any] | None = None
        failure: str | None = None
        async with self._engine.begin() as conn:
            if not await self._device_code_attempt_allowed(conn, user_id=user_id, now=now_dt):
                failure = "too_many_requests"
            else:
                row = await self._find_live_device_code(conn, user_code=user_code, now=now)
                if row is None:
                    await self._device_code_record_failure(conn, user_id=user_id, now=now_dt)
                    failure = "invalid_user_code"
                else:
                    await self._device_code_clear_attempts(conn, user_id=user_id)
                    status = row["status"]
                    if status == "pending":
                        status = "approved" if approved else "denied"
                        await conn.execute(
                            update(oauth_device_codes_t)
                            .where(
                                oauth_device_codes_t.c.device_code_hash
                                == row["device_code_hash"],
                                oauth_device_codes_t.c.status == "pending",
                            )
                            .values(
                                status=status,
                                user_id=user_id if approved else None,
                                approved_at=now if approved else None,
                            )
                        )
                        client = first_party_oauth_client(row["client_id"])
                        view = self._device_code_view(
                            row, status=status, client=client, server_time=now
                        )
                    else:
                        # Already approved or denied: re-approving would silently
                        # keep the old state, so the page is told to reload.
                        failure = DEVICE_APPROVAL_CONFLICT
        if failure is None:
            assert view is not None
            return view
        if failure == DEVICE_APPROVAL_CONFLICT:
            raise OAuthDeviceFlowError(failure, DEVICE_APPROVAL_CONFLICT_DESCRIPTION)
        raise OAuthDeviceFlowError(failure)


    async def poll_oauth_device_code(
        self,
        *,
        device_code: str,
        client_id: str,
    ) -> dict[str, Any]:
        """Check one device authorization request.

        Returns ``{"status", "user", "scope"}``.  ``status`` is one of the RFC
        8628 states plus ``invalid_grant``; only ``approved`` carries a user.
        The poll timestamp and the slow-down penalty are committed even on a
        non-approved result, so they are updated outside any raising path.
        """

        now_dt = datetime.now(UTC)
        now = now_dt.isoformat().replace("+00:00", "Z")
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(oauth_device_codes_t).where(
                        oauth_device_codes_t.c.device_code_hash == hash_secret(device_code)
                    )
                )
            ).mappings().first()
            if row is None or row["client_id"] != client_id or row["consumed_at"] is not None:
                return {"status": "invalid_grant", "user": None, "scope": ""}
            if row["expires_at"] <= now:
                return {"status": "expired_token", "user": None, "scope": ""}
            if row["status"] == "denied":
                return {"status": "access_denied", "user": None, "scope": ""}
            if row["status"] == "approved":
                # Read the account inside this transaction: if it is gone the
                # whole poll rolls back, so the code stays unconsumed instead of
                # being burned for a token that cannot be issued.
                user = await self._device_grant_user(conn, row["user_id"])
                consumed = await conn.execute(
                    update(oauth_device_codes_t)
                    .where(
                        oauth_device_codes_t.c.device_code_hash == row["device_code_hash"],
                        oauth_device_codes_t.c.consumed_at.is_(None),
                    )
                    .values(consumed_at=now)
                )
                if consumed.rowcount != 1:
                    return {"status": "invalid_grant", "user": None, "scope": ""}
                return {
                    "status": "approved",
                    "user": user,
                    "scope": str(row["scope"] or ""),
                }
            interval = int(row["interval_seconds"] or DEVICE_POLL_INTERVAL_SECONDS)
            last_polled_at = row["last_polled_at"]
            if last_polled_at is not None and _elapsed_seconds(last_polled_at, now_dt) < interval:
                # Increment in SQL: concurrent slow-downs must add up (5 -> 15)
                # rather than each writing back the value it read.
                await conn.execute(
                    update(oauth_device_codes_t)
                    .where(oauth_device_codes_t.c.device_code_hash == row["device_code_hash"])
                    .values(
                        last_polled_at=now,
                        interval_seconds=oauth_device_codes_t.c.interval_seconds
                        + SLOW_DOWN_INCREMENT_SECONDS,
                    )
                )
                return {"status": "slow_down", "user": None, "scope": ""}
            await conn.execute(
                update(oauth_device_codes_t)
                .where(oauth_device_codes_t.c.device_code_hash == row["device_code_hash"])
                .values(last_polled_at=now)
            )
            return {"status": "authorization_pending", "user": None, "scope": ""}


    async def _device_grant_user(self, conn: Any, user_id: str | None) -> UserView:
        """Load the user an approved request belongs to, on the poll's connection.

        Kept on the caller's connection so the consumption update and the user
        lookup share one transaction: a missing account raises and rolls both
        back.
        """

        row = (
            await conn.execute(
                select(users_t).where(users_t.c.id == (user_id or "").strip().lower())
            )
        ).mappings().first()
        if row is None:
            raise KeyError(user_id)
        return _user_from_row(row)



    async def _ensure_first_party_client_row(
        self,
        conn: Any,
        client: FirstPartyOAuthClient,
        now: str,
    ) -> None:
        existing_client = (
            await conn.execute(
                select(oauth_clients_t.c.id).where(
                    oauth_clients_t.c.id == client.client_id
                )
            )
        ).first()
        if existing_client is None:
            await conn.execute(
                insert(oauth_clients_t).values(
                    id=client.client_id,
                    name=client.name,
                    redirect_uris_json=_json_dumps([client.redirect_uri]),
                    created_at=now,
                    updated_at=now,
                )
            )


    async def _find_live_device_code(self, conn: Any, *, user_code: str, now: str) -> Any:
        canonical = normalize_user_code(user_code)
        if not canonical:
            return None
        return (
            await conn.execute(
                select(oauth_device_codes_t).where(
                    oauth_device_codes_t.c.user_code_hash == hash_secret(canonical),
                    oauth_device_codes_t.c.consumed_at.is_(None),
                    oauth_device_codes_t.c.expires_at > now,
                )
            )
        ).mappings().first()


    async def _device_code_attempt_allowed(
        self,
        conn: Any,
        *,
        user_id: str,
        now: datetime,
    ) -> bool:
        row = (
            await conn.execute(
                select(oauth_device_code_attempts_t).where(
                    oauth_device_code_attempts_t.c.user_id == user_id
                )
            )
        ).mappings().first()
        if row is None:
            return True
        if row["window_start"] <= int(now.timestamp()) - USER_CODE_ATTEMPT_WINDOW_SECONDS:
            return True
        return row["failed_attempts"] < MAX_USER_CODE_ATTEMPTS


    async def _device_code_record_failure(
        self,
        conn: Any,
        *,
        user_id: str,
        now: datetime,
    ) -> None:
        stamp = int(now.timestamp())
        row = (
            await conn.execute(
                select(oauth_device_code_attempts_t).where(
                    oauth_device_code_attempts_t.c.user_id == user_id
                )
            )
        ).mappings().first()
        if row is None:
            await conn.execute(
                insert(oauth_device_code_attempts_t).values(
                    user_id=user_id,
                    failed_attempts=1,
                    window_start=stamp,
                )
            )
            return
        reset = row["window_start"] <= stamp - USER_CODE_ATTEMPT_WINDOW_SECONDS
        await conn.execute(
            update(oauth_device_code_attempts_t)
            .where(oauth_device_code_attempts_t.c.user_id == user_id)
            .values(
                failed_attempts=1 if reset else row["failed_attempts"] + 1,
                window_start=stamp if reset else row["window_start"],
            )
        )


    async def _device_code_clear_attempts(self, conn: Any, *, user_id: str) -> None:
        await conn.execute(
            delete(oauth_device_code_attempts_t).where(
                oauth_device_code_attempts_t.c.user_id == user_id
            )
        )


    def _device_code_view(
        self,
        row: Any,
        *,
        status: str,
        client: FirstPartyOAuthClient | None,
        server_time: str,
    ) -> dict[str, Any]:
        return {
            "status": status,
            "clientName": client.name if client is not None else row["client_id"],
            "expiresAt": row["expires_at"],
            "serverTime": server_time,
        }


def _oauth_client_from_row(row: Any) -> OAuthClientView:
    return OAuthClientView(
        clientId=row["id"],
        name=row["name"],
        redirectUris=list(_json_loads(row["redirect_uris_json"]) or []),
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def _normalize_redirect_uri(value: str) -> str:
    uri = (value or "").strip()
    if not uri:
        raise ValueError("redirect uri is required")
    if "://" not in uri:
        raise ValueError("redirect uri must be absolute")
    return uri


def _oauth_code_hash(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _elapsed_seconds(value: str, now: datetime) -> float:
    """Seconds between an ISO-8601 timestamp and ``now`` (``inf`` if unparsable)."""

    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    return (now - parsed).total_seconds()
