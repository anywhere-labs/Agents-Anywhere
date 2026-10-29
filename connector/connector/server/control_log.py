"""Bounded, payload-free diagnostics for Connector control transport."""

from __future__ import annotations

import json
import math
import os
import traceback
from pathlib import PurePath
from typing import Any

from connector.logging import CONTROL_LOG_FIELDS as _FIELDS
from connector.logging import logger

_IDS = ("sessionId", "messageId", "runtimeId", "terminalId", "taskId")
SLOW_CONTROL_LOG_MS = 100.0


def completion_log_level(outcome: str, elapsed_ms: float, fields: dict[str, Any]) -> str:
    """Keep fast calls quiet while preserving slow work and business refusals."""
    if outcome not in {"returned", "not_dispatched"}:
        return "ERROR" if fields.get("errorStack") else "WARNING"
    if (elapsed_ms >= SLOW_CONTROL_LOG_MS or fields.get("businessOutcome") == "rejected"
            or fields.get("callerDetached")):
        return "INFO"
    return "DEBUG"


def business_fields(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    fields = {key: value[key] for key in _IDS if isinstance(value.get(key), (str, int))}
    item = value.get("item")
    if isinstance(item, dict):
        fields.update(
            {
                target: item[key]
                for key, target in (
                    ("id", "itemId"),
                    ("revision", "revision"),
                    ("updatedSeq", "updatedSeq"),
                )
                if isinstance(item.get(key), (str, int))
            }
        )
    return fields


def result_fields(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    outcome = (
        "rejected"
        if value.get("ok") is False or value.get("accepted") is False
        else ("accepted" if value.get("accepted") is True else "unspecified")
    )
    return {
        **business_fields(value),
        "businessOutcome": outcome,
        "businessCode": value.get("code") if outcome == "rejected" else None,
    }


def error_fields(error: BaseException, *, stack: bool = True) -> dict[str, Any]:
    # Exception messages/locals can contain credentials or business payloads.
    fields = {
        "errorType": type(error).__name__,
        "errorCode": getattr(error, "code", None),
    }
    if stack and error.__traceback__ is not None:
        fields["errorStack"] = " > ".join(
            f"{PurePath(frame.filename).name}:{frame.name}:{frame.lineno}"
            for frame in traceback.extract_tb(error.__traceback__)[-8:]
        )
    return fields


def control_log(event: str, *, level: str = "INFO", **fields: Any) -> None:
    try:
        values = {"event": event, "processId": os.getpid()}
        for key, value in fields.items():
            if key not in _FIELDS or value is None:
                continue
            if isinstance(value, str):
                values[key] = value[: 1500 if key == "errorStack" else 160]
            elif isinstance(value, (bool, int)):
                values[key] = value
            elif isinstance(value, float) and math.isfinite(value):
                values[key] = round(value, 2)
        logger.bind(control=values).opt(depth=1, lazy=True).log(
            level,
            "connector.control {}",
            lambda: json.dumps(values, ensure_ascii=False, separators=(",", ":")),
        )
    except Exception:  # noqa: BLE001 - diagnostics must not change the business result
        return
