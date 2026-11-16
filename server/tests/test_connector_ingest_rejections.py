from __future__ import annotations

import pytest
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as DatabasePoolTimeoutError

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


class _DriverError(Exception):
    def __init__(self, sqlstate: str) -> None:
        super().__init__(f"driver error {sqlstate}")
        self.sqlstate = sqlstate


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


def test_exhausted_connection_pool_is_retryable() -> None:
    error = DatabasePoolTimeoutError("QueuePool limit of size 5 overflow 10 reached")

    assert ingest_error_is_retryable(error) is True


@pytest.mark.parametrize(
    ("sqlstate", "retryable"),
    [
        ("55P03", True),  # lock_not_available
        ("40P01", True),  # deadlock_detected
        ("40001", True),  # serialization_failure
        ("23505", False),  # unique_violation
        ("22P02", False),  # invalid_text_representation
    ],
)
def test_wrapped_database_errors_follow_their_sqlstate(
    sqlstate: str, retryable: bool
) -> None:
    driver = _DriverError(sqlstate)
    wrapped = OperationalError("SELECT 1", {}, driver)

    assert ingest_error_is_retryable(wrapped) is retryable


def test_retryable_cause_is_found_through_the_chain() -> None:
    try:
        try:
            raise TimeoutError("lock wait")
        except TimeoutError as cause:
            raise RuntimeError("timeline write failed") from cause
    except RuntimeError as error:
        assert ingest_error_is_retryable(error) is True


