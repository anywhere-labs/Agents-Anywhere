from __future__ import annotations

import time
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import AgentRuntime, RuntimeHostClient
from connector.server.runtime_rpc_params import (
    SessionCapabilityParams,
    SessionDiscoverParams,
    SessionReadParams,
)
from connector.server.runtime_rpc_payloads import (
    capability_set_payload,
    session_meta_payload,
    session_notice_payload,
    session_state_payload,
)


async def discover_sessions(
    runtime: AgentRuntime,
    host: RuntimeHostClient,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = SessionDiscoverParams.parse(params)
    started_at = time.monotonic()
    sessions = await runtime.list_sessions(
        limit=parsed.limit,
        cursor=parsed.cursor,
        force=parsed.force,
    )
    for session in sessions:
        await host.session_meta_upsert(
            session_id=session.session_id,
            runtime=session.runtime,
            external_session_id=session.external_session_id,
            title=session.title,
            cwd=session.cwd,
            ordering_time=session.ordering_time,
            metadata=session.metadata,
        )
    logger.info(
        "runtime rpc session discover completed runtime={} limit={} force={} sessions={} elapsed_ms={:.1f}",
        sessions[0].runtime if sessions else "unknown",
        parsed.limit,
        parsed.force,
        len(sessions),
        (time.monotonic() - started_at) * 1000,
    )
    return {
        "sessions": [session_meta_payload(session) for session in sessions],
        "nextCursor": None,
    }


async def sync_session_snapshot(
    runtime: AgentRuntime,
    host: RuntimeHostClient,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = SessionReadParams.parse(params)
    started_at = time.monotonic()
    snapshot = await runtime.get_session_snapshot(
        parsed.session_id,
        parsed.external_session_id,
        parsed.limit,
    )
    read_elapsed_ms = (time.monotonic() - started_at) * 1000
    publish_started_at = time.monotonic()
    await host.timeline_sync(
        session_id=snapshot.session_id,
        runtime=snapshot.runtime,
        external_session_id=snapshot.external_session_id,
        items=snapshot.items,
        complete=snapshot.complete,
        metadata=snapshot.metadata,
    )
    publish_elapsed_ms = (time.monotonic() - publish_started_at) * 1000
    state = await runtime.get_session_state(
        parsed.session_id, parsed.external_session_id
    )
    if state is not None:
        await host.session_state_update(
            session_id=state.session_id,
            runtime=state.runtime,
            external_session_id=state.external_session_id,
            status=state.status,
            selections=state.selections,
            status_reason=state.status_reason,
            error=state.error,
            metadata=state.metadata,
        )
    for notice in await runtime.get_session_notices(
        parsed.session_id, parsed.external_session_id
    ):
        await host.notice_upsert(notice)
    logger.info(
        "runtime rpc session snapshot synced runtime={} session_id={} external_session_id={} limit={} items={} read_elapsed_ms={:.1f} publish_elapsed_ms={:.1f}",
        snapshot.runtime,
        snapshot.session_id,
        snapshot.external_session_id,
        parsed.limit,
        len(snapshot.items),
        read_elapsed_ms,
        publish_elapsed_ms,
    )
    return {
        "sessionId": snapshot.session_id,
        "externalSessionId": snapshot.external_session_id,
        "items": len(snapshot.items),
        "complete": snapshot.complete,
    }


async def read_session_state(
    runtime: AgentRuntime,
    host: RuntimeHostClient,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = SessionReadParams.parse(params)
    state = await runtime.get_session_state(
        parsed.session_id, parsed.external_session_id
    )
    if state is None:
        return {"state": None}
    await host.session_state_update(
        session_id=state.session_id,
        runtime=state.runtime,
        external_session_id=state.external_session_id,
        status=state.status,
        selections=state.selections,
        status_reason=state.status_reason,
        error=state.error,
        metadata=state.metadata,
    )
    return {"state": session_state_payload(state)}


async def read_session_capabilities(
    runtime: AgentRuntime,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = SessionCapabilityParams.parse(params)
    capabilities = await runtime.get_session_capabilities(
        parsed.session_id,
        parsed.external_session_id,
    )
    return {"capabilitySet": capability_set_payload(capabilities)}


async def read_session_notices(
    runtime: AgentRuntime,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = SessionReadParams.parse(params)
    notices = await runtime.get_session_notices(
        parsed.session_id,
        parsed.external_session_id,
    )
    return {"notices": [session_notice_payload(notice) for notice in notices]}
