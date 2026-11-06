"""Best-effort propagation of AA archive state into native runtimes.

Archiving or unarchiving a session in Agents Anywhere should also archive or
restore the session in the runtime that owns it (Codex, DSH, Claude Code), so
the native tool's own history list stays in sync. The Connector owns that
translation; the Server only forwards the requested state through the
``session.archive`` RPC.

This is deliberately best-effort: a Connector that is offline, a Runtime that
does not support native archiving, a timeout, or any other failure must never
change the result of the API call that updated the Server-side archive state.
Every failure is logged and swallowed here.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from typing import Any, Protocol

from loguru import logger

NATIVE_ARCHIVE_RPC_METHOD = "session.archive"
NATIVE_ARCHIVE_RPC_TIMEOUT_SECONDS = 10.0
NATIVE_ARCHIVE_MAX_CONCURRENCY = 8
_NATIVE_ARCHIVE_LARGE_BATCH = 200


class NativeArchiveSession(Protocol):
    """The subset of a serialized session the sync needs."""

    id: str
    connectorId: str
    runtime: str
    runtimeId: str | None
    externalSessionId: str | None


class NativeArchiveRpcPort(Protocol):
    """The subset of ``ConnectorRpcManager`` the sync needs."""

    async def is_online(self, connector_id: str) -> bool: ...

    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any: ...


def _native_archive_params(
    session: NativeArchiveSession,
    archived: bool,
) -> dict[str, Any] | None:
    """Build the ``session.archive`` params, or ``None`` when unsyncable.

    Sessions without a Connector or without a native session id have nothing to
    archive natively; the Runtime decides what to do when it has no native id
    either, but the Server can skip the round trip entirely in that case.
    """
    connector_id = getattr(session, "connectorId", None)
    external_session_id = getattr(session, "externalSessionId", None)
    if not connector_id or not external_session_id:
        return None
    runtime = getattr(session, "runtime", None)
    if not runtime:
        return None
    return {
        "runtime": runtime,
        "runtimeId": getattr(session, "runtimeId", None) or runtime,
        "sessionId": session.id,
        "externalSessionId": external_session_id,
        "archived": archived,
    }


class NativeArchiveStorePort(Protocol):
    """The subset of ``Store`` the one-time backfill needs."""

    async def list_sessions_for_connector(self, connector_id: str) -> Any: ...


# Sessions archived before this feature shipped have no native archive mark yet.
# The backfill re-applies the Server state once per Connector per process so a
# server restart (or first connect after an upgrade) reconciles the history
# without re-issuing RPCs on every reconnect.
_BACKFILLED_CONNECTORS: set[str] = set()


async def backfill_connector_native_archive(
    store: NativeArchiveStorePort,
    rpc: NativeArchiveRpcPort,
    connector_id: str,
    *,
    seen: set[str] | None = None,
) -> int:
    """Archive this Connector's already-archived sessions in their runtimes.

    Best-effort and idempotent: only sessions the Server currently reports as
    archived are forwarded, and only natively syncable ones (a Connector plus a
    native session id) reach the wire. Returns the number of sessions considered.
    Never raises.
    """
    registry = _BACKFILLED_CONNECTORS if seen is None else seen
    if connector_id in registry:
        return 0
    registry.add(connector_id)
    try:
        sessions = await store.list_sessions_for_connector(connector_id)
    except Exception:  # noqa: BLE001 - best-effort backfill must never fail startup
        logger.opt(exception=True).debug(
            "native archive backfill: cannot list sessions for {}", connector_id
        )
        return 0
    archived = [session for session in sessions if getattr(session, "archived", False)]
    if not archived:
        return 0
    try:
        await sync_native_session_archive(rpc, archived, True)
    except Exception:  # noqa: BLE001 - see sync_native_session_archive
        logger.opt(exception=True).debug(
            "native archive backfill failed: connector={}", connector_id
        )
        return len(archived)
    logger.debug(
        "native archive backfill: {} archived sessions on {}",
        len(archived),
        connector_id,
    )
    return len(archived)


async def sync_native_session_archive(
    rpc: NativeArchiveRpcPort,
    sessions: Iterable[NativeArchiveSession],
    archived: bool,
) -> None:
    """Forward ``archived`` to each session's native runtime, best-effort.

    Never raises: Connector/Runtime failures are logged at debug level and do
    not affect the caller. Connector calls are bounded by a semaphore so a
    bulk archive of a large device or project cannot open an unbounded number
    of in-flight RPCs, and each call has its own timeout.
    """
    jobs: list[tuple[str, str, dict[str, Any]]] = []
    for session in sessions:
        params = _native_archive_params(session, archived)
        if params is not None:
            jobs.append((session.id, session.connectorId, params))
    if not jobs:
        return
    if len(jobs) > _NATIVE_ARCHIVE_LARGE_BATCH:
        logger.info(
            "native archive sync: {} sessions, archived={}",
            len(jobs),
            archived,
        )

    semaphore = asyncio.Semaphore(NATIVE_ARCHIVE_MAX_CONCURRENCY)

    async def sync_one(
        session_id: str,
        connector_id: str,
        params: dict[str, Any],
    ) -> None:
        try:
            async with semaphore:
                if not await rpc.is_online(connector_id):
                    return
                await rpc.request(
                    connector_id,
                    NATIVE_ARCHIVE_RPC_METHOD,
                    params,
                    timeout=NATIVE_ARCHIVE_RPC_TIMEOUT_SECONDS,
                )
        except Exception:  # noqa: BLE001 - best-effort sync must never fail the API
            logger.opt(exception=True).debug(
                "native archive sync failed: session={} connector={} archived={}",
                session_id,
                connector_id,
                archived,
            )

    await asyncio.gather(
        *(
            sync_one(session_id, connector_id, params)
            for session_id, connector_id, params in jobs
        ),
        return_exceptions=True,
    )
