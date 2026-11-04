from __future__ import annotations

from agent_server.core.models import ConnectorNotification
from agent_server.services.connector_ingest import (
    ingest_error_is_retryable,
    ingest_rejection_from_exception,
)


def _notification() -> ConnectorNotification:
    return ConnectorNotification(
        method="timeline.itemUpsert",
        params={"sessionId": "sess_1"},
    )


def test_lock_timeout_rejection_is_retryable() -> None:
    error = TimeoutError(
        "timed out acquiring distributed lock: session-revision:sess_1"
    )

    assert ingest_error_is_retryable(error) is True
    rejection = ingest_rejection_from_exception(0, _notification(), error)
    assert rejection.code == "notification_failed"
    assert rejection.errorType == "TimeoutError"
    assert rejection.retryable is True


def test_validation_rejection_is_not_retryable() -> None:
    error = ValueError("invalid timeline item")

    assert ingest_error_is_retryable(error) is False
    rejection = ingest_rejection_from_exception(0, _notification(), error)
    assert rejection.code == "notification_failed"
    assert rejection.errorType == "ValueError"
    assert rejection.retryable is False
