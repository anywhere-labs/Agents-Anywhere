"""Platform protocol 1.2: additive changes on top of the frozen 1.1 for v3.

Only additions. Old clients ignore the new fields:

* ``SessionView.displayDevice`` / ``displayUser``: display envelopes. In E2EE
  mode the legacy ``title`` / ``cwd`` fields are null and clients decrypt the
  envelopes with the device's directory key.
* ``SessionView.planState`` / ``goalState``: status-only enums that remain
  visible while the device is offline (the Server stores no plan/goal content).
* Snapshot ``historySource`` and ``deviceOffline``.
* Timeline page ``deviceOffline``.
* Event type ``session.catchup_required``.
* Queue state ``deviceOffline``.
* ``TimelineItem.blobRefs``: fields the device moved to its local blob store; clients read them with
  ``GET /sessions/{id}/blobs/{blobRef}`` (``SessionBlobChunk``).
* Agent collaboration: ``SessionView.origin`` (an Agent created the session), ``supervisors`` /
  ``supervised`` (supervision edges, ids and state only), and ``content.author`` on user messages an
  Agent or a supervision wake sent (``MessageAuthor``).
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from agent_server.core.device_meshcall import (
    DisplayEnvelope,
    GoalStateValue,
    PlanStateValue,
    SessionOrigin,
    SupervisionState,
)
from agent_server.core.message_queue import SessionQueueState
from agent_server.core.models import TimelineItem
from agent_server.core.protocol import (
    ProtocolEventRecoveryResponse,
    ProtocolSessionSnapshotResponse,
    ProtocolTimelineResponse,
    ProtocolTimelineSnapshot,
    ProtocolWireModel,
    SessionView,
)

PROTOCOL_VERSION_1_2 = "1.2"

HistorySource = Literal["live", "unavailable"]

CATCHUP_REQUIRED_EVENT = "session.catchup_required"


class SupervisionEdge(ProtocolWireModel):
    """One supervision edge as the session directory keeps it: who watches whom, and its state."""

    supervisionId: str = Field(min_length=1)
    supervisorSessionId: str = Field(min_length=1)
    targetSessionId: str = Field(min_length=1)
    state: SupervisionState
    createdBy: Literal["human", "agent"]


class MessageAuthor(ProtocolWireModel):
    """``content.author`` of a user message that a person did not type: an Agent acting through the
    collaboration tools, or a supervision wake (a digest the device sent to the supervisor)."""

    kind: Literal["agent", "supervision"]
    sessionId: str | None = Field(default=None, description="the supervisor session the Agent acts for")
    deviceId: str | None = None
    supervisionId: str | None = None


class SessionViewV12(SessionView):
    displayDevice: DisplayEnvelope | None = None
    displayUser: DisplayEnvelope | None = None
    planState: PlanStateValue = "none"
    goalState: GoalStateValue = "none"
    origin: SessionOrigin | None = None
    supervisors: list[SupervisionEdge] = Field(default_factory=list, description="edges where this session is the target")
    supervised: list[SupervisionEdge] = Field(default_factory=list, description="edges where this session is the supervisor")


class TimelineBlobRef(ProtocolWireModel):
    """A field of a timeline item the device moved to its local blob store; the item keeps a preview at ``path``.

    A ``text/*`` blob is the full UTF-8 text of the string previewed at ``path``. Any other blob is media whose
    ``data`` (or ``blob``) key was removed from the block at ``path``'s parent, or a ``data:`` URL string replaced
    by a short description.
    """

    path: str = Field(description="RFC 6901 JSON pointer into the item's content")
    blobId: str = Field(min_length=1)
    bytes: int = Field(ge=0)
    mediaType: str | None = None


class TimelineItemV12(TimelineItem):
    blobRefs: list[TimelineBlobRef] | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
        description="present only when fields were moved to the device's blob store",
    )


class ProtocolTimelineSnapshotV12(ProtocolTimelineSnapshot):
    items: list[TimelineItemV12] = Field(default_factory=list)


class ProtocolSessionSnapshotResponseV12(ProtocolSessionSnapshotResponse):
    session: SessionViewV12
    timeline: ProtocolTimelineSnapshotV12
    historySource: HistorySource = "live"
    deviceOffline: bool = False


class ProtocolTimelineResponseV12(ProtocolTimelineResponse):
    items: list[TimelineItemV12] = Field(default_factory=list)
    historySource: HistorySource = "live"
    deviceOffline: bool = False


class ProtocolEventRecoveryResponseV12(ProtocolEventRecoveryResponse):
    deviceOffline: bool = False


class SessionQueueStateV12(SessionQueueState):
    """``GET /sessions/{id}/runtime/queue``: the device's queue; empty with ``deviceOffline`` when it is offline."""

    deviceOffline: bool = False


class SessionCatchupRequiredPayload(ProtocolWireModel):
    """Payload of ``session.catchup_required``: refetch ``/events`` with your own cursor."""

    sessionId: str = Field(min_length=1)
    reason: Literal["device_reconnected", "subscription_restored"]


class DisplayUserUpdateRequest(ProtocolWireModel):
    """``PATCH /sessions/{id}`` body for renaming: the client writes ``displayUser``."""

    displayUser: DisplayEnvelope


#: Largest slice one ``GET /sessions/{id}/blobs/{blobRef}`` returns (its ``length`` query parameter).
SESSION_BLOB_CHUNK_MAX_BYTES = 4 * 1024 * 1024


class SessionBlobChunk(ProtocolWireModel):
    """``GET /sessions/{id}/blobs/{blobRef}?offset=…&length=…``: a slice of a blob the device keeps for the session.

    ``blobRef`` is a ``blobRefs[].blobId`` of one of the session's items, or the ``fileId`` of an attachment of the
    session the device holds; anything else is 404 ``blob_not_found``. ``length`` is at most
    ``SESSION_BLOB_CHUNK_MAX_BYTES`` and the device may return less; clients read on from ``offset + len`` until
    ``eof``. The device serves it, so it works the same through the Server and through a secure channel.
    """

    blobRef: str = Field(min_length=1)
    name: str
    mediaType: str
    encoding: Literal["base64"] = "base64"
    data: str = Field(description="base64 (standard alphabet) of the bytes at [offset, offset + len)")
    offset: int = Field(ge=0)
    size: int = Field(ge=0, description="total size of the blob")
    eof: bool
