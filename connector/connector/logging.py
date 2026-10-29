from __future__ import annotations

import json
import math
import sys
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger

from connector.core.logging_queue import QueuedLogWriter

CONTROL_LOG_FIELDS = frozenset({
    'event', 'callId', 'meshCallId', 'routeRequestId', 'connectorId', 'connectionId',
    'linkId', 'routerId', 'workerId', 'sourceWorkerId', 'targetWorkerId', 'generation',
    'method', 'phase', 'outcome', 'businessOutcome', 'businessCode', 'deliveryState',
    'reason', 'errorType', 'errorCode', 'errorStack', 'elapsedMs', 'queueWaitMs',
    'runMs', 'queueDepth', 'activeCount', 'lane', 'callerDetached', 'lookupCount',
    'routeRetries', 'registrationWaits', 'subscriberCount', 'sessionId', 'messageId', 'runtimeId',
    'terminalId', 'taskId', 'itemId', 'revision', 'updatedSeq', 'processId',
    'leaseSeconds', 'itemCount', 'transport', 'mode', 'remainingMs', 'rpcRequestId',
})

# Producers only enqueue. The writer calls synchronous notifiers off-loop and
# marshals coroutine notifiers back to the loop captured when installed.
RpcLogNotifier = Callable[[str, Any], Awaitable[None] | None]
DEFAULT_LOG_FORMAT = (
    "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
    "<level>{level: <8}</level> | "
    "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - "
    "<level>{message}</level>"
)


def configure_connector_logging(*, debug: bool = False) -> None:
    level = "DEBUG" if debug else "INFO"
    logger.remove()
    logger.add(sys.stderr, level=level, format=DEFAULT_LOG_FORMAT)


class RpcLogSink:
    def __init__(self, notifier: RpcLogNotifier, **writer_options: Any) -> None:
        self.notifier = notifier
        self._writer_options = writer_options
        self._writer: QueuedLogWriter | None = None
        self._sink_id: int | None = None

    def install(
        self,
        *,
        level: str = "INFO",
        remove_default_sink: bool = False,
    ) -> RpcLogSink:
        if remove_default_sink:
            logger.remove()
        self._writer = QueuedLogWriter(self.notifier, **self._writer_options)
        self._sink_id = logger.add(self._write, level=level, format="{message}",
                                   filter=lambda record: record["extra"].get("meshcall_service") != "aa.local.v2.Logs"
                                   and not record["message"].startswith("RPC call aa.local.v2.Logs."))
        return self

    @property
    def statistics(self) -> dict[str, int]:
        return self._writer.statistics if self._writer is not None else {}

    async def close(self) -> bool:
        if self._sink_id is not None:
            logger.remove(self._sink_id)
            self._sink_id = None
        return await self._writer.close() if self._writer is not None else True

    def _write(self, message: Any) -> None:
        record = message.record
        payload = {
            "time": _clip(record["time"].isoformat(), 80),
            "level": _clip(record["level"].name, 20),
            "name": _clip(record["name"] or "", 200),
            "message": _clip(record["message"], 16000),
        }
        extra = {key.removeprefix("meshcall_"): value for key, value in record["extra"].items()
                 if key in {"meshcall_service", "meshcall_method", "meshcall_call_id"}}
        control = record["extra"].get("control")
        if isinstance(control, dict):
            # The control logger constructs a bounded, payload-free field map.
            # Keep it in the existing details string so readers/contracts stay compatible.
            extra["control"] = {
                key: value[:1500 if key == "errorStack" else 160] if isinstance(value, str) else value
                for key, value in control.items() if key in CONTROL_LOG_FIELDS
                and (isinstance(value, (str, bool, int)) or isinstance(value, float) and math.isfinite(value))
            }
        if extra:
            payload["details"] = _clip(json.dumps(extra, default=str), 16000)
        exception = record.get("exception")
        if exception is not None:
            payload["exception"] = _clip(exception, 16000)

        if self._writer is not None:
            self._writer.write(payload)


def install_rpc_log_sink(
    notifier: RpcLogNotifier,
    *,
    level: str = "INFO",
    remove_default_sink: bool = False,
    **writer_options: Any,
) -> RpcLogSink:
    return RpcLogSink(notifier, **writer_options).install(
        level=level,
        remove_default_sink=remove_default_sink,
    )


def _clip(value: Any, limit: int) -> str:
    """Keep records inside the log service's field limits instead of dropping them."""
    text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"
