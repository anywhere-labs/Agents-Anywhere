from __future__ import annotations

from typing import Any

from connector.runtime_protocol import AgentRuntime, RuntimeHostClient
from connector.server.runtime_rpc_params import (
    int_param,
    optional_string,
    required_session_id,
)
from connector.server.runtime_rpc_payloads import (
    session_meta_payload,
    session_state_payload,
)


async def discover_sessions(
    runtime: AgentRuntime,
    host: RuntimeHostClient,
    params: dict[str, Any],
) -> dict[str, Any]:
    sessions = await runtime.list_sessions(
        limit=int_param(params, "limit", 100),
        cursor=optional_string(params.get("cursor")),
        force=bool(params.get("force", True)),
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
    return {
        "sessions": [session_meta_payload(session) for session in sessions],
        "nextCursor": None,
    }


async def sync_session_snapshot(
    runtime: AgentRuntime,
    host: RuntimeHostClient,
    params: dict[str, Any],
) -> dict[str, Any]:
    session_id = required_session_id(params)
    external_session_id = optional_string(params.get("externalSessionId"))
    snapshot = await runtime.get_session_snapshot(
        session_id,
        external_session_id,
        int_param(params, "limit", 100),
    )
    await host.timeline_sync(
        session_id=snapshot.session_id,
        runtime=snapshot.runtime,
        external_session_id=snapshot.external_session_id,
        items=snapshot.items,
        complete=snapshot.complete,
        metadata=snapshot.metadata,
    )
    state = await runtime.get_session_state(session_id, external_session_id)
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
    for notice in await runtime.get_session_notices(session_id, external_session_id):
        await host.notice_upsert(notice)
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
    session_id = required_session_id(params)
    external_session_id = optional_string(params.get("externalSessionId"))
    state = await runtime.get_session_state(session_id, external_session_id)
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
