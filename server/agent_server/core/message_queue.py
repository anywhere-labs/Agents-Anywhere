"""Server-owned session message queue: wire models and limits.

Messages sent while a session is busy wait in a per-session FIFO owned by the
server. Runtimes never see the queue; the server dispatches the head as an
ordinary ``session.send_message`` once the session is idle again.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ProtocolWireModel(BaseModel):
    """Same wire conventions as ``core.protocol`` without importing it.

    ``core.protocol`` embeds the queue in the session snapshot, so this module
    must not import it back.
    """

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

MESSAGE_QUEUE_MAX_ITEMS = 20

QueueItemStatus = Literal["queued", "sending", "failed"]
# How a message sent while the session is busy is delivered:
# ``auto`` queues at the tail, ``interrupt`` queues at the head and stops the
# current turn, ``never`` keeps the busy rejection. Omitted keeps the 2.2
# behaviour (rejected while busy) for scripts and older clients.
QueueMode = Literal["auto", "interrupt", "never"]
MessageDelivery = Literal["sent", "queued"]
# Session states in which a new message waits instead of starting a turn.
QUEUEABLE_SESSION_STATUSES = frozenset(
    {"running", "waiting", "pending", "waiting_approval", "blocked", "stopping"}
)


class SessionQueueError(ProtocolWireModel):
    code: str
    message: str


class SessionQueueAttachment(ProtocolWireModel):
    fileId: str
    name: str | None = None
    mediaType: str | None = None
    size: int | None = None


class SessionQueueItem(ProtocolWireModel):
    messageId: str
    sessionId: str
    clientMessageId: str
    content: str
    attachments: list[SessionQueueAttachment] = Field(default_factory=list)
    status: QueueItemStatus
    # 1-based place in the queue at the time of the snapshot.
    position: int = Field(ge=1)
    interruptRequested: bool = False
    createdBy: str
    createdAt: str
    updatedAt: str
    error: SessionQueueError | None = None


class SessionQueueState(ProtocolWireModel):
    sessionId: str
    # Increases with every change, including the change back to empty, so a
    # client keeps only the newest whole-queue snapshot.
    revision: int = Field(ge=0)
    items: list[SessionQueueItem] = Field(default_factory=list)


class QueueItemAttachmentRef(BaseModel):
    fileId: str = Field(min_length=1, max_length=64)


class QueueItemUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str | None = None
    attachments: list[QueueItemAttachmentRef] | None = Field(default=None, max_length=10)


class QueueOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messageIds: list[str] = Field(min_length=1, max_length=MESSAGE_QUEUE_MAX_ITEMS)


class MessageQueueError(RuntimeError):
    """A queue change was refused; ``code`` is machine readable."""

    code = "queue_error"
    status_code = 409

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.code)
        self.message = message or self.code

    def detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


class QueueFullError(MessageQueueError):
    code = "queue_full"


class QueueItemNotFoundError(MessageQueueError):
    code = "queue_item_not_found"
    status_code = 404


class QueueItemSendingError(MessageQueueError):
    code = "queue_item_sending"


class QueueOrderMismatchError(MessageQueueError):
    code = "queue_order_mismatch"
    status_code = 422
