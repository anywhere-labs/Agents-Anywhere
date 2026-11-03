from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncConnection

from agent_server.infra.db.schema import tokens_link_states, tokens_links
from agent_server.infra.repositories.store_support import _json_dumps, _json_loads


class LockedTokensLink:
    """A link row held with ``SELECT … FOR UPDATE`` until the block ends."""

    def __init__(self, conn: AsyncConnection, row: dict[str, Any] | None) -> None:
        self._conn = conn
        self.row = row

    async def save_refresh_token(self, ciphertext: str, *, refreshed_at: str) -> None:
        assert self.row is not None
        await self._conn.execute(
            update(tokens_links)
            .where(tokens_links.c.user_id == self.row["userId"])
            .values(refresh_token_ciphertext=ciphertext, refreshed_at=refreshed_at)
        )
        self.row = {**self.row, "refreshTokenCiphertext": ciphertext, "refreshedAt": refreshed_at}

    async def require_reauth(self) -> None:
        assert self.row is not None
        await self._conn.execute(
            update(tokens_links)
            .where(tokens_links.c.user_id == self.row["userId"])
            .values(status="reauth_required", refresh_token_ciphertext=None)
        )
        self.row = {**self.row, "status": "reauth_required", "refreshTokenCiphertext": None}


class TokensLinkRepositoryMixin:
    # Links in progress.

    async def create_tokens_link_state(self, row: dict[str, Any]) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(tokens_link_states.insert().values(**row))

    async def open_tokens_link_ticket(
        self, *, ticket_hash: str, browser_hash: str, now: str, expires_at: str
    ) -> dict[str, Any] | None:
        """Bind a start ticket to the browser that opened it; works once."""
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    update(tokens_link_states)
                    .where(
                        tokens_link_states.c.ticket_hash == ticket_hash,
                        tokens_link_states.c.browser_hash.is_(None),
                        tokens_link_states.c.consumed_at.is_(None),
                        tokens_link_states.c.expires_at > now,
                    )
                    .values(browser_hash=browser_hash, expires_at=expires_at)
                    .returning(*tokens_link_states.c)
                )
            ).mappings().first()
        return _state_row(row) if row is not None else None

    async def consume_tokens_link_state(
        self, *, state_hash: str, browser_hash: str, now: str
    ) -> dict[str, Any] | None:
        """Use a state once, from the browser the link started in."""
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    update(tokens_link_states)
                    .where(
                        tokens_link_states.c.state_hash == state_hash,
                        tokens_link_states.c.browser_hash == browser_hash,
                        tokens_link_states.c.consumed_at.is_(None),
                        tokens_link_states.c.expires_at > now,
                    )
                    .values(consumed_at=now)
                    .returning(*tokens_link_states.c)
                )
            ).mappings().first()
        return _state_row(row) if row is not None else None

    async def prune_tokens_link_states(self, *, before: str) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(delete(tokens_link_states).where(tokens_link_states.c.expires_at < before))

    # Links.

    async def save_tokens_link(self, row: dict[str, Any]) -> None:
        values = {key: value for key, value in row.items() if key not in {"account", "quick_setup"}}
        values["account_json"] = _json_dumps(row["account"])
        values["quick_setup_json"] = _json_dumps(row["quick_setup"]) if row.get("quick_setup") else None
        async with self._engine.begin() as conn:
            statement = pg_insert(tokens_links).values(**values)
            await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=["user_id"],
                    set_={key: statement.excluded[key] for key in values if key != "user_id"},
                )
            )

    async def get_tokens_link(self, user_id: str) -> dict[str, Any] | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(select(tokens_links).where(tokens_links.c.user_id == user_id))
            ).mappings().first()
        return _link_row(row) if row is not None else None

    async def set_tokens_link_quick_setup(self, user_id: str, value: dict[str, Any] | None) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(tokens_links)
                .where(tokens_links.c.user_id == user_id)
                .values(quick_setup_json=_json_dumps(value) if value else None)
            )

    async def delete_tokens_link(self, user_id: str) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(delete(tokens_links).where(tokens_links.c.user_id == user_id))

    async def count_tokens_links(self) -> int:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(select(tokens_links.c.user_id))).all()
        return len(rows)

    async def list_tokens_links_to_refresh(self, *, refreshed_before: str) -> list[str]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(tokens_links.c.user_id).where(
                        tokens_links.c.status == "linked",
                        tokens_links.c.refreshed_at < refreshed_before,
                    )
                )
            ).all()
        return [row.user_id for row in rows]

    @asynccontextmanager
    async def locked_tokens_link(self, user_id: str) -> AsyncIterator[LockedTokensLink]:
        """Serialize refreshes of one link across workers and processes."""
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(tokens_links).where(tokens_links.c.user_id == user_id).with_for_update()
                )
            ).mappings().first()
            yield LockedTokensLink(conn, _link_row(row) if row is not None else None)


def _state_row(row: Any) -> dict[str, Any]:
    return {
        "stateHash": row["state_hash"],
        "userId": row["user_id"],
        "codeVerifierCiphertext": row["code_verifier_ciphertext"],
        "issuer": row["issuer"],
        "redirectUri": row["redirect_uri"],
        "expiresAt": row["expires_at"],
        "quickSetup": _json_loads(row["quick_setup_json"]),
    }


def _link_row(row: Any) -> dict[str, Any]:
    return {
        "userId": row["user_id"],
        "issuer": row["issuer"],
        "account": _json_loads(row["account_json"]) or {},
        "status": row["status"],
        "refreshTokenCiphertext": row["refresh_token_ciphertext"],
        "linkedAt": row["linked_at"],
        "refreshedAt": row["refreshed_at"],
        "issuedAt": row["issued_at"],
        "quickSetup": _json_loads(row["quick_setup_json"]),
    }
