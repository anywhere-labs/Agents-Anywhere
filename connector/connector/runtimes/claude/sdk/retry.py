"""Safe, user-facing progress from Claude CLI's non-terminal API errors."""

from collections.abc import Mapping
from typing import Any


def api_retry_details(message: Any) -> dict[str, Any] | None:
    data = message if isinstance(message, Mapping) else getattr(message, "data", None)
    if not isinstance(data, Mapping) or data.get("subtype") not in {"api_error", "api_retry"}:
        return None
    attempt = data.get("attempt", data.get("retryAttempt", data.get("retry_attempt")))
    if type(attempt) is not int or attempt < 1:
        return None
    error = data.get("error")
    error = error if isinstance(error, Mapping) else {}
    rate_limited = (
        data.get("error_status") == 429 or error.get("status") == 429
        or error.get("type") == "rate_limit_error" or data.get("error") == "rate_limit"
    )
    details: dict[str, Any] = {
        "code": "model_request_retry",
        "state": "retrying",
        "reason": "rate_limit" if rate_limited else "unavailable",
        "attempt": attempt,
    }
    maximum = data.get("max_retries", data.get("maxRetries"))
    if type(maximum) is int and maximum >= attempt:
        details["maxAttempts"] = maximum
    delay = data.get("retry_delay_ms", data.get("retryInMs", data.get("retry_in_ms")))
    if type(delay) in {int, float} and 0 <= delay <= 86_400_000:
        details["retryInMs"] = int(delay)
    # Never forward raw errors, URLs, headers, or credentials into the timeline.
    return details
