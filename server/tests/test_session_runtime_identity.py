from __future__ import annotations

import pytest
from pydantic import ValidationError

from agent_server.core.models import (
    SessionCreateAndStartRequest,
    SessionCreateRequest,
    SessionRuntimeState,
    SessionView,
)
from agent_server.core.runtime_identity import (
    SessionRuntimeBindingError,
    resolve_session_runtime_binding,
)


def test_session_requests_default_to_the_compatibility_instance() -> None:
    create = SessionCreateRequest(connectorId="conn_1", runtime="codex")
    start = SessionCreateAndStartRequest(
        connectorId="conn_1",
        runtime="dsh",
        content="hello",
    )

    assert create.runtimeId == "codex"
    assert start.runtimeId == "dsh"


def test_session_requests_keep_named_runtime_identity() -> None:
    request = SessionCreateAndStartRequest(
        connectorId="conn_1",
        runtime="codex",
        runtimeId="rti_work",
        content="hello",
    )

    assert request.runtime == "codex"
    assert request.runtimeId == "rti_work"


def test_session_requests_accept_normalized_discovered_runtime_types() -> None:
    request = SessionCreateRequest(
        connectorId="conn_1",
        runtime="example-runtime",
        runtimeId="rti_example",
    )

    assert request.runtime == "example-runtime"
    assert request.runtimeId == "rti_example"


def test_session_requests_reject_noncanonical_runtime_types() -> None:
    with pytest.raises(ValidationError, match="runtime type"):
        SessionCreateRequest(
            connectorId="conn_1",
            runtime="Example Runtime",
            runtimeId="rti_example",
        )


def test_session_requests_reject_mismatched_legacy_identity() -> None:
    with pytest.raises(ValidationError, match="runtime instance ID"):
        SessionCreateRequest(
            connectorId="conn_1",
            runtime="codex",
            runtimeId="claude",
        )


def test_session_views_and_states_emit_dual_identity() -> None:
    session = SessionView(
        id="sess_1",
        connectorId="conn_1",
        connectorStatus="online",
        runtime="codex",
        runtimeId="rti_work",
        status="idle",
        takeover=True,
        updatedSeq=1,
    )
    state = SessionRuntimeState(
        sessionId="sess_1",
        runtime="codex",
        runtimeId="rti_work",
        updatedSeq=1,
        createdAt="2026-08-25T00:00:00Z",
        updatedAt="2026-08-25T00:00:00Z",
    )

    assert session.runtime == "codex"
    assert session.runtimeId == "rti_work"
    assert session.runtimeType == "codex"
    assert state.runtime == "codex"
    assert state.runtimeId == "rti_work"
    assert state.runtimeType == "codex"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("sessionId", "sess_other"),
        ("runtime", "claude"),
        ("runtimeId", "rti_other"),
    ],
)
def test_connector_runtime_binding_rejects_explicit_mismatch(
    field: str,
    value: str,
) -> None:
    with pytest.raises(SessionRuntimeBindingError, match=field):
        resolve_session_runtime_binding(
            {field: value},
            session_id="sess_1",
            runtime_type="codex",
            runtime_id="rti_work",
        )


def test_connector_runtime_binding_fills_only_missing_identity() -> None:
    assert resolve_session_runtime_binding(
        {},
        session_id="sess_1",
        runtime_type="codex",
        runtime_id="rti_work",
    ) == ("sess_1", "codex", "rti_work")

    assert resolve_session_runtime_binding(
        {
            "sessionId": "sess_1",
            "runtime": "codex",
            "runtimeId": "rti_work",
        },
        session_id="sess_1",
        runtime_type="codex",
        runtime_id="rti_work",
    ) == ("sess_1", "codex", "rti_work")
