from __future__ import annotations

from agent_server.infra.repositories.store_support import *
from agent_server.infra.db.engine import read_connection


class ConnectorRepositoryMixin:
    async def get_connector_preferences(self, connector_id: str) -> dict[str, Any]:
        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(
                    select(connectors_t.c.user_preferences).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
        if row is None:
            raise KeyError(connector_id)
        value = _json_loads(row.user_preferences)
        return value if isinstance(value, dict) else {}

    async def update_connector_preferences(
        self,
        connector_id: str,
        preferences: dict[str, Any],
    ) -> dict[str, Any]:
        now = utc_now()
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id, connectors_t.c.revoked == 0)
                .values(user_preferences=_json_dumps(preferences), updated_at=now)
            )
            if result.rowcount == 0:
                raise KeyError(connector_id)
        return preferences

    async def get_connector_device_settings(self, connector_id: str) -> dict[str, Any]:
        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(
                    select(connectors_t.c.device_settings).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
        if row is None:
            raise KeyError(connector_id)
        value = _json_loads(row.device_settings)
        return value if isinstance(value, dict) else {}

    async def update_connector_device_settings(
        self,
        connector_id: str,
        settings: dict[str, Any],
    ) -> dict[str, Any]:
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id, connectors_t.c.revoked == 0)
                .values(device_settings=_json_dumps(settings), updated_at=utc_now())
            )
            if result.rowcount == 0:
                raise KeyError(connector_id)
        return settings

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


    async def create_connector(
        self,
        *,
        name: str,
        user_id: str,
        connector_kind: ConnectorKind = "cli",
        installation_id: str | None = None,
    ) -> tuple[ConnectorView, str, str]:
        # An installation key is scoped to its authenticated owner. A lost
        # registration response can be retried without creating another device.
        connector_id = (
            "conn_" + hashlib.sha256(f"{user_id}:{installation_id}".encode()).hexdigest()[:24]
            if installation_id else f"conn_{secrets.token_urlsafe(10)}"
        )
        token = _new_connector_token()
        prefix = token[:12]
        now = utc_now()
        try:
            async with self._engine.begin() as conn:
                await conn.execute(
                    insert(connectors_t).values(
                        id=connector_id,
                        user_id=user_id,
                        name=name,
                        connector_kind=connector_kind,
                        status="offline",
                        token_hash=_hash_token(token),
                        token_prefix=prefix,
                        created_at=now,
                        updated_at=now,
                    )
                )
        except IntegrityError:
            if not installation_id:
                raise
            # Credentials are deliberately reissued only on an explicit
            # registration retry. Normal starts reuse the locally saved token.
            return await self.rotate_connector_token(connector_id, user_id=user_id)
        return await self.get_connector(connector_id), token, prefix


    async def verify_connector_token(self, connector_id: str, token: str) -> bool:
        async with read_connection(self._engine) as conn:
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


    async def authenticate_connector_access(self, token: str) -> str | None:
        from agent_server.core.auth import (
            connector_access_token_id,
            verify_connector_access_token,
        )

        connector_id = connector_access_token_id(token)
        if connector_id is None:
            return None
        async with read_connection(self._engine) as conn:
            credential_hash = (
                await conn.execute(
                    select(connectors_t.c.token_hash).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).scalar_one_or_none()
        if credential_hash is None:
            return None
        return verify_connector_access_token(token, credential_hash=credential_hash)

    async def get_connector(self, connector_id: str) -> ConnectorView:
        async with read_connection(self._engine) as conn:
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
        async with read_connection(self._engine) as conn:
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


    async def list_user_connector_ids(self, user_id: str) -> list[str]:
        """Every connector the user owns, including revoked and pending ones."""
        async with self._engine.connect() as conn:
            return list((await conn.execute(
                select(connectors_t.c.id).where(connectors_t.c.user_id == user_id)
            )).scalars())

    async def pending_connector_deletions(self) -> list[tuple[str, str]]:
        async with read_connection(self._engine) as conn:
            rows = (await conn.execute(select(connectors_t.c.id, connectors_t.c.user_id)
                .where(connectors_t.c.revoked == 2)
                .order_by(connectors_t.c.updated_at).limit(50))).all()
        return [(str(row.id), str(row.user_id)) for row in rows]

    async def begin_connector_deletion(
        self, connector_id: str, *, user_id: str
    ) -> list[str]:
        """Revoke admission first and retain IDs until external cleanup succeeds."""
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(connectors_t).where(
                    connectors_t.c.id == connector_id,
                    connectors_t.c.user_id == user_id,
                ).values(revoked=2, updated_at=utc_now())
            )
            if result.rowcount == 0:
                raise KeyError(connector_id)
            return list((await conn.execute(
                select(sessions_t.c.id).where(sessions_t.c.connector_id == connector_id)
            )).scalars())

    async def delete_connector(
        self, connector_id: str, *, user_id: str | None = None
    ) -> list[str]:
        query = select(connectors_t.c.id).where(connectors_t.c.id == connector_id)
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.begin() as conn:
            # Serialize against project creation and connector-owned FK writes.
            # Include legacy revoked rows so their owners can also purge them.
            if (await conn.execute(query.with_for_update())).first() is None:
                raise KeyError(connector_id)
            session_ids = list(
                (await conn.execute(
                    select(sessions_t.c.id).where(sessions_t.c.connector_id == connector_id)
                )).scalars()
            )
            # Session children (timeline, shares, active runs) cascade. Sessions
            # must go before projects because project references use RESTRICT.
            await conn.execute(
                delete(sessions_t).where(sessions_t.c.connector_id == connector_id)
            )
            await conn.execute(
                delete(projects_t).where(projects_t.c.connector_id == connector_id)
            )
            # Runtime configuration, catalogs and preview tokens all reference
            # the connector with ON DELETE CASCADE.
            await conn.execute(delete(connectors_t).where(connectors_t.c.id == connector_id))
            # Terminal roots live in Redis. Clear them before the commit so a
            # failure keeps the deletion pending for a retry.
            await self.terminal_roots.forget_connector_terminal_roots(connector_id)
            # Keep the rows discoverable for a retry if storage cleanup fails.
            # Files cannot be rolled back, so run this after all SQL deletions.
            for session_id in session_ids:
                await self.files.delete_session(session_id)
        return session_ids


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
                    presence_instance_id=None,
                    presence_connection_id=None,
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
        else:
            values["presence_instance_id"] = None
            values["presence_connection_id"] = None
        if device_os is not None:
            values["device_os"] = device_os
        async with self._engine.begin() as conn:
            await conn.execute(
                update(connectors_t).where(connectors_t.c.id == connector_id).values(**values)
            )


    async def record_connector_connection(
        self,
        connector_id: str,
        *,
        device_os: str | None = None,
    ) -> bool:
        now = utc_now()
        values: dict[str, Any] = {
            "last_seen_at": now,
            "updated_at": now,
        }
        if device_os is not None:
            values["device_os"] = device_os
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id, connectors_t.c.revoked == 0)
                .values(**values)
            )
        return result.rowcount > 0


    async def record_connector_activity(self, connector_id: str) -> None:
        now = utc_now()
        async with self._engine.begin() as conn:
            await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id)
                .values(last_seen_at=now, updated_at=now)
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
            connector = (
                await conn.execute(
                    select(connectors_t.c.id).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
            if connector is None:
                raise KeyError(connector_id)
            current = (
                await conn.execute(
                    select(connector_protocol_capabilities_t.c.revision).where(
                        connector_protocol_capabilities_t.c.connector_id == connector_id
                    )
                )
            ).first()
            if current is not None and int(current.revision) > revision:
                return False
            values = {
                "revision": revision,
                "capabilities_json": _json_dumps(capability_set),
                "updated_at": now,
            }
            if current is None:
                await conn.execute(
                    insert(connector_protocol_capabilities_t).values(
                        connector_id=connector_id,
                        **values,
                    )
                )
            else:
                await conn.execute(
                    update(connector_protocol_capabilities_t)
                    .where(connector_protocol_capabilities_t.c.connector_id == connector_id)
                    .values(**values)
                )
        return True

    async def get_protocol_capabilities_stamp(
        self, connector_id: str,
    ) -> tuple[int, str] | None:
        """Check one stored snapshot without loading its capability body.

        Include the write timestamp because equal protocol revisions may be
        replaced. This stamp is only reused within one publication batch.
        """
        query = (
            select(
                connector_protocol_capabilities_t.c.revision,
                connector_protocol_capabilities_t.c.updated_at,
            )
            .select_from(connectors_t.outerjoin(
                connector_protocol_capabilities_t,
                connector_protocol_capabilities_t.c.connector_id == connectors_t.c.id,
            ))
            .where(connectors_t.c.id == connector_id, connectors_t.c.revoked == 0)
        )
        async with read_connection(self._engine) as conn:
            row = (await conn.execute(query)).first()
        if row is None:
            raise KeyError(connector_id)
        if row.revision is None:
            return None
        return int(row.revision), row.updated_at

    async def get_protocol_capabilities(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        connector_query = select(connectors_t.c.id).where(
            connectors_t.c.id == connector_id,
            connectors_t.c.revoked == 0,
        )
        if user_id is not None:
            connector_query = connector_query.where(connectors_t.c.user_id == user_id)
        async with read_connection(self._engine) as conn:
            if (await conn.execute(connector_query)).first() is None:
                raise KeyError(connector_id)
            row = (
                await conn.execute(
                    select(connector_protocol_capabilities_t.c.capabilities_json).where(
                        connector_protocol_capabilities_t.c.connector_id == connector_id
                    )
                )
            ).first()
        if row is not None:
            capabilities = _json_loads(row.capabilities_json)
            if isinstance(capabilities, dict):
                return capabilities
        return {"revision": 0, "capabilities": []}


    def _connector_from_row(self, row: Any) -> ConnectorView:
        return ConnectorView(
            id=row["id"],
            userId=row["user_id"],
            name=row["name"],
            connectorKind=row["connector_kind"],
            deviceOs=row["device_os"],
            status=row["status"],
            lastSeenAt=row["last_seen_at"],
            createdAt=row["created_at"],
            updatedAt=row["updated_at"],
        )
