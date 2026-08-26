from __future__ import annotations

import threading
from typing import Any

from connector.logging import logger


class DeferredServerRequestReader:
    """Keep Codex responses flowing while a server request waits for user input."""

    def __init__(self, sync_client: Any) -> None:
        self._client = sync_client

    def run(self) -> None:
        try:
            while True:
                message = self._client._read_message()
                if "method" in message and "id" in message:
                    threading.Thread(
                        target=self._respond_to_server_request,
                        args=(message,),
                        daemon=True,
                    ).start()
                    continue
                if "method" in message:
                    method = message["method"]
                    if isinstance(method, str):
                        self._client._router.route_notification(
                            self._client._coerce_notification(
                                method,
                                message.get("params"),
                            )
                        )
                    continue
                self._client._router.route_response(message)
        except BaseException as exc:
            self._client._router.fail_all(exc)

    def _respond_to_server_request(self, message: dict[str, Any]) -> None:
        request_id = message["id"]
        method = message.get("method")
        try:
            result = self._client._handle_server_request(message)
            self._client._write_message({"id": request_id, "result": result})
        except BaseException as exc:
            logger.exception(
                "codex sdk server request failed method={} request_id={}",
                method,
                request_id,
            )
            try:
                self._client._write_message(
                    {
                        "id": request_id,
                        "error": {
                            "code": -32603,
                            "message": str(exc) or exc.__class__.__name__,
                        },
                    }
                )
            except BaseException:
                logger.debug(
                    "codex sdk server request error response was not delivered "
                    "method={} request_id={}",
                    method,
                    request_id,
                )


def install_deferred_server_request_reader(client: Any) -> bool:
    nested_client = getattr(client, "_client", None)
    sync_client = getattr(nested_client, "_sync", None)
    if sync_client is None:
        return False
    required = (
        "_read_message",
        "_handle_server_request",
        "_write_message",
        "_router",
        "_coerce_notification",
    )
    if any(not hasattr(sync_client, name) for name in required):
        return False
    sync_client._reader_loop = DeferredServerRequestReader(sync_client).run
    return True
