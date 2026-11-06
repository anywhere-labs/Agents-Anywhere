"""Connection-local receive budgets for authenticated Connector control sockets."""

from typing import Any

from meshcall.transport import DEFAULT_MAX_FRAME_SIZE
from uvicorn._types import ASGISendEvent
from uvicorn.protocols.websockets.websockets_sansio_impl import WebSocketsSansIOProtocol

CLIENT_WS_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
CONTROL_WS_MAX_MESSAGE_BYTES = DEFAULT_MAX_FRAME_SIZE
_CONTROL_BUDGET = "_aa_control_message_budget"


def allow_large_control_messages(scope: dict[str, Any]) -> None:
    """Call only after device authentication and capability checks, before accept."""
    scope.setdefault("state", {})[_CONTROL_BUDGET] = True


class ControlWebSocketProtocol(WebSocketsSansIOProtocol):
    """Keep the default budget until the application accepts a control socket."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        # Never change the shared Config, even when a custom launcher passes 64 MiB.
        self.conn.max_message_size = CLIENT_WS_MAX_MESSAGE_BYTES

    async def send(self, message: ASGISendEvent) -> None:
        if message["type"] == "websocket.accept" and not self.handshake_complete:
            control = self.scope.get("state", {}).get(_CONTROL_BUDGET) is True
            self.conn.max_message_size = (
                CONTROL_WS_MAX_MESSAGE_BYTES if control else CLIENT_WS_MAX_MESSAGE_BYTES
            )
        await super().send(message)
