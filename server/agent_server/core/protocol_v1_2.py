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
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from agent_server.core.device_meshcall import (
    DisplayEnvelope,
    GoalStateValue,
    PlanStateValue,
)
from agent_server.core.message_queue import SessionQueueState
from agent_server.core.protocol import (
    ProtocolEventRecoveryResponse,
    ProtocolSessionSnapshotResponse,
    ProtocolTimelineResponse,
    ProtocolWireModel,
    SessionView,
)

PROTOCOL_VERSION_1_2 = "1.2"

HistorySource = Literal["live", "unavailable"]

CATCHUP_REQUIRED_EVENT = "session.catchup_required"


class SessionViewV12(SessionView):
    displayDevice: DisplayEnvelope | None = None
    displayUser: DisplayEnvelope | None = None
    planState: PlanStateValue = "none"
    goalState: GoalStateValue = "none"


class ProtocolSessionSnapshotResponseV12(ProtocolSessionSnapshotResponse):
    session: SessionViewV12
    historySource: HistorySource = "live"
    deviceOffline: bool = False


class ProtocolTimelineResponseV12(ProtocolTimelineResponse):
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
