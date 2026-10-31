"""Usage statistics domain values.

Usage facts are appended to ``usage_events`` the moment platform activity
happens. Each event carries a UTC timestamp plus its UTC hour bucket so the
report service can aggregate in SQL and then map hours onto local days for any
requested timezone. Event rows never reference connectors or sessions through
foreign keys: a device or session may be deleted later while usage history
must survive.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

EVENT_USER_ACTIVE = "user.active"
EVENT_SESSION_CREATED = "session.created"
EVENT_SESSION_VIEWED = "session.viewed"
EVENT_MESSAGE_SENT = "message.sent"
EVENT_TURN_ENDED = "turn.ended"
EVENT_APPROVAL_REQUESTED = "approval.requested"
EVENT_APPROVAL_RESOLVED = "approval.resolved"
EVENT_RUNTIME_ERROR = "runtime.error"
EVENT_CONNECTOR_ONLINE = "connector.online"

USAGE_EVENT_TYPES = frozenset(
    {
        EVENT_USER_ACTIVE,
        EVENT_SESSION_CREATED,
        EVENT_SESSION_VIEWED,
        EVENT_MESSAGE_SENT,
        EVENT_TURN_ENDED,
        EVENT_APPROVAL_REQUESTED,
        EVENT_APPROVAL_RESOLVED,
        EVENT_RUNTIME_ERROR,
        EVENT_CONNECTOR_ONLINE,
    }
)

TURN_OUTCOME_COMPLETED = "completed"
TURN_OUTCOME_FAILED = "failed"

# Notice statuses that end an approval request. The runtime reports the notice
# through ``notice.upsert``; the first "open" upsert is the request itself.
APPROVAL_RESOLVED_STATUSES = frozenset(
    {"resolved", "closed", "expired", "cancelled", "failed"}
)

# Stock metric keys captured by the daily inventory snapshot and computed live
# for the current day. Dimensioned keys carry the dimension value separately.
INVENTORY_USERS_TOTAL = "users.total"
INVENTORY_USERS_ADMINS = "users.admins"
INVENTORY_CONNECTORS_TOTAL = "connectors.total"
INVENTORY_CONNECTORS_BY_OS = "connectors.by_os"
INVENTORY_CONNECTORS_SEEN_7D = "connectors.seen_7d"
INVENTORY_CONNECTORS_SEEN_30D = "connectors.seen_30d"
INVENTORY_RUNTIMES_CONFIGURED = "runtimes.configured_connectors"
INVENTORY_RUNTIMES_DISCOVERED = "runtimes.discovered_connectors"


def hour_bucket(occurred_at: str) -> str:
    """Return the UTC hour bucket (``YYYY-MM-DDTHH``) of an ISO UTC timestamp."""

    return occurred_at[:13]


@dataclass(frozen=True, slots=True)
class UsageEvent:
    event_type: str
    occurred_at: str
    user_id: str | None = None
    connector_id: str | None = None
    session_id: str | None = None
    runtime_type: str | None = None
    runtime_id: str | None = None
    device_os: str | None = None
    outcome: str | None = None
    duration_ms: int | None = None
    # Idempotency key; ``None`` means every occurrence is stored.
    dedupe_key: str | None = None

    def row(self) -> dict[str, str | int | None]:
        return {
            "id": f"ue_{uuid.uuid4().hex}",
            "occurred_at": self.occurred_at,
            "hour_bucket": hour_bucket(self.occurred_at),
            "event_type": self.event_type,
            "user_id": self.user_id,
            "connector_id": self.connector_id,
            "session_id": self.session_id,
            "runtime_type": self.runtime_type,
            "runtime_id": self.runtime_id,
            "device_os": self.device_os,
            "outcome": self.outcome,
            "duration_ms": self.duration_ms,
            "dedupe_key": self.dedupe_key,
        }


# --- aggregated rows returned by the usage repository -----------------------


@dataclass(frozen=True, slots=True)
class UsageCountRow:
    local_date: str
    local_hour: int
    event_type: str
    runtime_type: str | None
    outcome: str | None
    count: int
    duration_sum: int


@dataclass(frozen=True, slots=True)
class UsageUserDayRow:
    """One user active on one local day."""

    local_date: str
    user_id: str
    messages: int


@dataclass(frozen=True, slots=True)
class UsageUserActivity:
    days: list[UsageUserDayRow]
    hour_of_day: dict[int, int]
    """Distinct users per local hour of day (0-23) inside the report range."""


@dataclass(frozen=True, slots=True)
class UsageSessionTotalsRow:
    """Distinct session counts for one local day, or the whole range (``None``)."""

    local_date: str | None
    sessions: int
    sessions_viewed: int
    sessions_read_only: int
    session_views: int


@dataclass(frozen=True, slots=True)
class UsageRuntimeReachRow:
    runtime_type: str
    sessions: int
    users: int


@dataclass(frozen=True, slots=True)
class UsageConnectorTotalsRow:
    """Distinct online connectors per local day, per OS, or for the whole range.

    Exactly one of ``local_date`` / ``device_os`` is set for the per-day and
    per-OS rows; both are ``None`` on the range total.
    """

    local_date: str | None
    device_os: str | None
    connectors: int


@dataclass(frozen=True, slots=True)
class UsageDurationStatsRow:
    """Nearest-rank duration percentiles for one local day, one runtime type, or
    the whole range (both keys ``None``)."""

    local_date: str | None
    runtime_type: str | None
    p50: int
    p90: int
    p99: int
    samples: int


@dataclass(frozen=True, slots=True)
class InventoryRow:
    metric_key: str
    dimension: str
    value: float


@dataclass(frozen=True, slots=True)
class InventorySnapshotRow:
    snapshot_date: str
    metric_key: str
    dimension: str
    value: float
