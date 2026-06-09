from __future__ import annotations

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
        client = await self.get_oauth_client(client_id)
        redirect_uri = _normalize_redirect_uri(redirect_uri)
        if redirect_uri not in client.redirectUris:
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
            await conn.execute(
                update(oauth_authorization_codes_t)
                .where(oauth_authorization_codes_t.c.code_hash == code_hash)
                .values(consumed_at=now)
            )
            user_id = row["user_id"]
            scope = row["scope"]
        return await self.get_user(user_id), scope


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
