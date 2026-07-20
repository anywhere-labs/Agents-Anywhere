from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class ConnectorRepositoryMixin:
    async def record_fs_preview_token(
        self,
        *,
        token: str,
        user_id: str,
        connector_id: str,
        root: str,
        path: str,
        expires_at: str,
    ) -> None:
        connector = await self.get_connector(connector_id)
        if connector.userId != user_id:
            raise KeyError(connector_id)
        now = utc_now()
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(fs_preview_tokens_t).values(
                    token_hash=_hash_token(token),
                    user_id=user_id,
                    connector_id=connector_id,
                    root=root,
                    path=path,
                    expires_at=expires_at,
                    created_at=now,
                    consumed_at=None,
                )
            )


    async def consume_fs_preview_token(
        self,
        *,
        token: str,
        user_id: str,
        connector_id: str,
        root: str,
        path: str,
    ) -> bool:
        token_hash = _hash_token(token)
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(fs_preview_tokens_t).where(
                        fs_preview_tokens_t.c.token_hash == token_hash,
                        fs_preview_tokens_t.c.user_id == user_id,
                        fs_preview_tokens_t.c.connector_id == connector_id,
                        fs_preview_tokens_t.c.root == root,
                        fs_preview_tokens_t.c.path == path,
                    )
                )
            ).mappings().first()
            if row is None or row["consumed_at"] is not None or row["expires_at"] < now:
                return False
            await conn.execute(
                update(fs_preview_tokens_t)
                .where(fs_preview_tokens_t.c.token_hash == token_hash)
                .values(consumed_at=now)
            )
            return True


    async def record_connector_terminal_root(
        self,
        *,
        connector_id: str,
        terminal_id: str,
        session_id: str,
        root: str,
        cwd: str,
    ) -> None:
        now = utc_now()
        async with self._engine.begin() as conn:
            existing = (
                await conn.execute(
                    select(connector_terminal_roots_t.c.terminal_id).where(
                        connector_terminal_roots_t.c.connector_id == connector_id,
                        connector_terminal_roots_t.c.terminal_id == terminal_id,
                    )
                )
            ).first()
            values = {
                "session_id": session_id,
                "root": root,
                "cwd": cwd,
                "updated_at": now,
            }
            if existing is None:
                await conn.execute(
                    insert(connector_terminal_roots_t).values(
                        connector_id=connector_id,
                        terminal_id=terminal_id,
                        created_at=now,
                        **values,
                    )
                )
                return
            await conn.execute(
                update(connector_terminal_roots_t)
                .where(
                    connector_terminal_roots_t.c.connector_id == connector_id,
                    connector_terminal_roots_t.c.terminal_id == terminal_id,
                )
                .values(**values)
            )


    async def list_connector_terminal_roots(
        self,
        *,
        connector_id: str,
        session_id: str,
    ) -> dict[str, dict[str, str]]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(connector_terminal_roots_t).where(
                        connector_terminal_roots_t.c.connector_id == connector_id,
                        connector_terminal_roots_t.c.session_id == session_id,
                    )
                )
            ).mappings().all()
        return {
            row["terminal_id"]: {
                "root": row["root"],
                "cwd": row["cwd"],
            }
            for row in rows
        }


    async def get_connector_terminal_root(
        self,
        *,
        connector_id: str,
        terminal_id: str,
    ) -> dict[str, str] | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(connector_terminal_roots_t).where(
                        connector_terminal_roots_t.c.connector_id == connector_id,
                        connector_terminal_roots_t.c.terminal_id == terminal_id,
                    )
                )
            ).mappings().first()
        if row is None:
            return None
        return {
            "root": row["root"],
            "cwd": row["cwd"],
        }


    async def prune_connector_terminal_roots(
        self,
        *,
        connector_id: str,
        session_id: str,
        terminal_ids: set[str],
    ) -> None:
        async with self._engine.begin() as conn:
            stmt = delete(connector_terminal_roots_t).where(
                connector_terminal_roots_t.c.connector_id == connector_id,
                connector_terminal_roots_t.c.session_id == session_id,
            )
            if terminal_ids:
                stmt = stmt.where(~connector_terminal_roots_t.c.terminal_id.in_(terminal_ids))
            await conn.execute(stmt)


    async def forget_connector_terminal_root(
        self,
        *,
        connector_id: str,
        terminal_id: str,
    ) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                delete(connector_terminal_roots_t).where(
                    connector_terminal_roots_t.c.connector_id == connector_id,
                    connector_terminal_roots_t.c.terminal_id == terminal_id,
                )
            )


    async def create_connector(self, *, name: str, user_id: str) -> tuple[ConnectorView, str, str]:
        connector_id = f"conn_{secrets.token_urlsafe(10)}"
        token = _new_connector_token()
        prefix = token[:12]
        now = utc_now()
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(connectors_t).values(
                    id=connector_id,
                    user_id=user_id,
                    name=name,
                    status="offline",
                    token_hash=_hash_token(token),
                    token_prefix=prefix,
                    created_at=now,
                    updated_at=now,
                )
            )
        await self.apply_user_agent_defaults_to_connector(
            user_id=user_id,
            connector_id=connector_id,
        )
        return await self.get_connector(connector_id), token, prefix


    async def create_pairing(self, *, server_url: str | None, ttl_seconds: int) -> dict[str, str]:
        pairing_id = f"pair_{secrets.token_urlsafe(10)}"
        code = f"{secrets.randbelow(1_000_000):06d}"
        now = utc_now()
        expires_at = _utc_now_plus(ttl_seconds)
        async with self._engine.begin() as conn:
            while (
                await conn.execute(
                    select(pairing_codes_t.c.code).where(pairing_codes_t.c.code == code)
                )
            ).first() is not None:
                code = f"{secrets.randbelow(1_000_000):06d}"
            await conn.execute(
                insert(pairing_codes_t).values(
                    id=pairing_id,
                    code=code,
                    status="pending",
                    server_url=server_url,
                    expires_at=expires_at,
                    created_at=now,
                )
            )
        return {"pairingId": pairing_id, "code": code, "expiresAt": expires_at}


    async def claim_pairing(
        self,
        *,
        code: str,
        name: str,
        user_id: str,
        server_url: str | None,
        connector_id: str | None = None,
        connector_token: str | None = None,
        owner_user_id: str | None = None,
    ) -> ConnectorView:
        now = utc_now()
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(
                        pairing_codes_t.c.id,
                        pairing_codes_t.c.status,
                        pairing_codes_t.c.expires_at,
                    ).where(pairing_codes_t.c.code == code)
                )
            ).first()
        if row is None:
            raise KeyError(code)
        if row.status != "pending" or row.expires_at <= now:
            raise ValueError("pairing code is not claimable")

        if connector_id or connector_token:
            if not connector_id or not connector_token:
                raise ValueError("connector id and token must be provided together")
            if not await self.verify_connector_token(connector_id, connector_token):
                raise ValueError("invalid connector credential")
            connector = await self.get_connector(connector_id)
            if owner_user_id is not None and connector.userId != owner_user_id:
                raise ValueError("invalid connector credential")
            token = connector_token
        else:
            connector, token, _ = await self.create_connector(name=name, user_id=user_id)

        values: dict[str, Any] = {
            "status": "claimed",
            "connector_id": connector.id,
            "connector_token": token,
            "claimed_at": now,
        }
        if server_url is not None:
            values["server_url"] = server_url
        async with self._engine.begin() as conn:
            await conn.execute(
                update(pairing_codes_t).where(pairing_codes_t.c.id == row.id).values(**values)
            )
        return connector


    async def poll_pairing(self, *, pairing_id: str) -> PairingPollResponse:
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(pairing_codes_t).where(pairing_codes_t.c.id == pairing_id)
                )
            ).mappings().first()
            if row is None:
                raise KeyError(pairing_id)
            if row["status"] == "pending" and row["expires_at"] <= now:
                await conn.execute(
                    update(pairing_codes_t)
                    .where(pairing_codes_t.c.id == pairing_id)
                    .values(status="expired")
                )
                return PairingPollResponse(status="expired", expiresAt=row["expires_at"])
            if row["status"] != "claimed":
                return PairingPollResponse(status=row["status"], expiresAt=row["expires_at"])
            connector_id = row["connector_id"]
            connector_token = row["connector_token"]
            server_url = row["server_url"]
            if not connector_id or not connector_token or not server_url:
                raise ValueError("claimed pairing is missing connector config")
            await conn.execute(
                update(pairing_codes_t)
                .where(pairing_codes_t.c.id == pairing_id)
                .values(status="consumed", consumed_at=now)
            )
        return PairingPollResponse(
            status="claimed",
            config=ConnectorConfigBundle(
                serverUrl=server_url,
                connectorId=connector_id,
                connectorToken=connector_token,
            ),
            expiresAt=row["expires_at"],
        )


    async def verify_connector_token(self, connector_id: str, token: str) -> bool:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(connectors_t.c.token_hash, connectors_t.c.revoked).where(
                        connectors_t.c.id == connector_id
                    )
                )
            ).first()
        if row is None or row.revoked:
            return False
        return secrets.compare_digest(row.token_hash, _hash_token(token))


    async def get_connector(self, connector_id: str) -> ConnectorView:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(connectors_t).where(
                        connectors_t.c.id == connector_id, connectors_t.c.revoked == 0
                    )
                )
            ).mappings().first()
        if row is None:
            raise KeyError(connector_id)
        return self._connector_from_row(row)


    async def list_connectors(self, *, user_id: str | None = None) -> list[ConnectorView]:
        query = select(connectors_t).where(connectors_t.c.revoked == 0)
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        query = query.order_by(connectors_t.c.updated_at.desc(), connectors_t.c.created_at.desc())
        async with self._engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        return [self._connector_from_row(row) for row in rows]


    async def update_connector(
        self,
        connector_id: str,
        *,
        owner_user_id: str | None = None,
        name: str | None = None,
        user_id: str | None = None,
    ) -> ConnectorView:
        values: dict[str, Any] = {}
        if name is not None:
            values["name"] = name
        if user_id is not None:
            values["user_id"] = user_id
        if not values:
            connector = await self.get_connector(connector_id)
            if owner_user_id is not None and connector.userId != owner_user_id:
                raise KeyError(connector_id)
            return connector
        values["updated_at"] = utc_now()
        query = update(connectors_t).where(
            connectors_t.c.id == connector_id, connectors_t.c.revoked == 0
        )
        if owner_user_id is not None:
            query = query.where(connectors_t.c.user_id == owner_user_id)
        async with self._engine.begin() as conn:
            result = await conn.execute(query.values(**values))
            if result.rowcount == 0:
                raise KeyError(connector_id)
        return await self.get_connector(connector_id)


    async def revoke_connector(self, connector_id: str, *, user_id: str | None = None) -> None:
        now = utc_now()
        query = update(connectors_t).where(
            connectors_t.c.id == connector_id, connectors_t.c.revoked == 0
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        query = query.values(revoked=1, status="offline", updated_at=now)
        async with self._engine.begin() as conn:
            result = await conn.execute(query)
            if result.rowcount == 0:
                raise KeyError(connector_id)


    async def rotate_connector_token(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> tuple[ConnectorView, str, str]:
        token = _new_connector_token()
        prefix = token[:12]
        now = utc_now()
        query = update(connectors_t).where(
            connectors_t.c.id == connector_id,
            connectors_t.c.revoked == 0,
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.begin() as conn:
            result = await conn.execute(
                query.values(
                    token_hash=_hash_token(token),
                    token_prefix=prefix,
                    status="offline",
                    updated_at=now,
                )
            )
            if result.rowcount == 0:
                raise KeyError(connector_id)
        return await self.get_connector(connector_id), token, prefix


    async def set_connector_status(self, connector_id: str, status: str, *, device_os: str | None = None) -> None:
        now = utc_now()
        values: dict[str, Any] = {"status": status, "updated_at": now}
        if status == "online":
            values["last_seen_at"] = now
        if device_os is not None:
            values["device_os"] = device_os
        async with self._engine.begin() as conn:
            await conn.execute(
                update(connectors_t).where(connectors_t.c.id == connector_id).values(**values)
            )


    async def set_all_connectors_offline(self) -> None:
        now = utc_now()
        async with self._engine.begin() as conn:
            await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.revoked == 0, connectors_t.c.status != "offline")
                .values(status="offline", updated_at=now)
            )


    async def record_connector_activity(self, connector_id: str) -> None:
        now = utc_now()
        async with self._engine.begin() as conn:
            await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id)
                .values(last_seen_at=now, updated_at=now)
            )


    async def mark_connector_seen(self, connector_id: str) -> None:
        now = utc_now()
        async with self._engine.begin() as conn:
            await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id)
                .values(status="online", last_seen_at=now, updated_at=now)
            )

    async def update_protocol_capabilities(
        self,
        connector_id: str,
        capability_set: dict[str, Any],
    ) -> bool:
        revision = capability_set.get("revision")
        if not isinstance(revision, int) or revision < 0:
            raise ValueError("capability_set.revision must be a non-negative integer")
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(connectors_t.c.runtime_capabilities).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).mappings().first()
            if row is None:
                raise KeyError(connector_id)
            state = _normalize_agents_blob(_json_loads(row["runtime_capabilities"]))
            protocol_state = state.get("protocol")
            if not isinstance(protocol_state, dict):
                protocol_state = {}
            current = protocol_state.get("capabilities")
            current_revision = current.get("revision") if isinstance(current, dict) else None
            if isinstance(current_revision, int) and current_revision > revision:
                return False
            protocol_state["capabilities"] = capability_set
            protocol_state["capabilitiesUpdatedAt"] = now
            state["protocol"] = protocol_state
            await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id, connectors_t.c.revoked == 0)
                .values(runtime_capabilities=_json_dumps(state), updated_at=now)
            )
        return True

    async def get_protocol_capabilities(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        query = select(
            connectors_t.c.runtime_capabilities,
            connectors_t.c.user_id,
        ).where(
            connectors_t.c.id == connector_id,
            connectors_t.c.revoked == 0,
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(query)).mappings().first()
        if row is None:
            raise KeyError(connector_id)
        state = _normalize_agents_blob(_json_loads(row["runtime_capabilities"]))
        protocol_state = state.get("protocol")
        if isinstance(protocol_state, dict):
            capabilities = protocol_state.get("capabilities")
            if isinstance(capabilities, dict):
                return capabilities
        return {"revision": 0, "capabilities": []}


    def _connector_from_row(self, row: Any) -> ConnectorView:
        return ConnectorView(
            id=row["id"],
            userId=row["user_id"],
            name=row["name"],
            deviceOs=row["device_os"],
            status=row["status"],
            lastSeenAt=row["last_seen_at"],
            runtimeCapabilities=_agents_view_from_state(
                _normalize_agents_blob(_json_loads(row["runtime_capabilities"]))
            ),
            createdAt=row["created_at"],
            updatedAt=row["updated_at"],
        )
