"""Route the host service's event frames onto Connector actions.

The frame envelope is measured, not assumed (2.0.18):

    {"id": "evt_…", "created": 1790508700755, "type": "session.created",
     "location": {"directory": "D:\\…"},
     "data": {"sessionID": "ses_…", …},
     "durable": {"aggregateID": "ses_…", "seq": 0, "version": 1}}

Three properties shape this module:

* the discriminator is **`type`**, not `event`, and `location`/`durable` are
  optional -- lifecycle frames like `server.connected` and `project.updated`
  carry neither, so they cannot be attributed to a location and are only useful
  as "something changed, re-read".
* `durable.seq` is a per-session sequence (`session.created` is seq 0, the next
  durable frame seq 1), and `GET /api/event` accepts no parameters
  (`Last-Event-ID` is ignored, measured), so a gap or a reconnect can only be
  repaired by re-reading -- which is what :func:`needs_resync` is for.
* session deletions **are** announced (`session.deleted` was observed after a
  `DELETE /api/session/{id}`), but not immediately: a probe that closed the
  stream right away saw nothing. So the pump treats events as a latency
  optimisation and leaves the Connector's polling scanner as the backstop.

This module is deliberately pure: it decides *what kind* of work an event
implies, and the runtime executes it. Keeping the table here means the mapping is
testable without a live service and without a fake host.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

#: Re-read the session's stored messages (debounced; a turn emits dozens).
REFRESH_TIMELINE = "timeline"
#: Re-read the session's pending permission requests into notices.
REFRESH_NOTICES = "notices"
#: Re-read the session row itself (title, selections, parentage).
REFRESH_SESSION = "session"
#: Re-publish the model/agent/command catalogs.
REFRESH_CATALOGS = "catalogs"
#: Report the session as running.
STATE_RUNNING = "running"
#: Report the session as finished, with the outcome carried through.
STATE_IDLE = "idle"
#: Report the session as waiting for a human answer.
STATE_WAITING = "waiting_approval"
#: Report the session as errored.
STATE_ERROR = "error"

_TIMELINE = {
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.delta",
    "message.part.removed",
    "session.step.started",
    "session.step.ended",
    "session.step.failed",
    "session.text.started",
    "session.text.delta",
    "session.text.ended",
    "session.reasoning.started",
    "session.reasoning.delta",
    "session.reasoning.ended",
    "session.tool.input.started",
    "session.tool.input.ended",
    "session.tool.called",
    "session.tool.progress",
    "session.tool.success",
    "session.tool.failed",
    "session.compaction.started",
    "session.compaction.delta",
    "session.compaction.ended",
    "session.compaction.failed",
    "session.inbox.delivered",
}
_SESSION = {
    "session.created",
    "session.updated",
    "session.deleted",
    "session.moved",
    "session.fork",
    "session.agent.selected",
    "session.model.selected",
    "session.title.updated",
}
_CATALOGS = {
    "model.updated",
    "agent.updated",
    "command.updated",
    "skill.updated",
    "mcp.status.changed",
    "mcp.tools.changed",
    "mcp.resources.changed",
    "mcp.prompts.changed",
    "integration.updated",
}


def frame_type(frame: Mapping[str, Any]) -> str:
    value = frame.get("type")
    return value if isinstance(value, str) else ""


def frame_location(frame: Mapping[str, Any]) -> str | None:
    """The location the frame is attributed to, when the host says so.

    Absent means "machine-wide" (`project.updated`, `server.connected`), which is
    deliberately *not* the same as "some other location's" -- those frames are
    still worth acting on, they just cannot be scoped.
    """
    location = frame.get("location")
    if isinstance(location, Mapping):
        directory = location.get("directory")
        if isinstance(directory, str) and directory:
            return directory
    return None


def frame_session_id(frame: Mapping[str, Any]) -> str | None:
    data = frame.get("data")
    if not isinstance(data, Mapping):
        return None
    for key in ("sessionID", "id", "aggregateID"):
        value = data.get(key)
        if isinstance(value, str) and value.startswith("ses"):
            return value
    return None


def durable_sequence(frame: Mapping[str, Any]) -> tuple[str, int] | None:
    """`(aggregate, seq)` for a durable frame, or None when it is not durable."""
    durable = frame.get("durable")
    if not isinstance(durable, Mapping):
        return None
    aggregate = durable.get("aggregateID")
    seq = durable.get("seq")
    if not isinstance(aggregate, str) or not isinstance(seq, int) or isinstance(seq, bool):
        return None
    return aggregate, seq


def needs_resync(previous: int | None, current: int) -> bool:
    """True when the per-session sequence skipped or restarted.

    The stream cannot be resumed, so a gap means we missed frames and must re-read
    the whole session rather than trust what we have.
    """
    if previous is None:
        return False
    return current <= previous or current > previous + 1


def actions_for(event_type: str) -> frozenset[str]:
    if not event_type:
        return frozenset()
    if event_type == "session.execution.started":
        return frozenset({STATE_RUNNING, REFRESH_TIMELINE})
    if event_type in {"session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"}:
        return frozenset({STATE_IDLE, REFRESH_TIMELINE, REFRESH_SESSION})
    if event_type == "session.idle":
        return frozenset({STATE_IDLE, REFRESH_TIMELINE})
    if event_type == "session.error":
        return frozenset({STATE_ERROR, REFRESH_TIMELINE})
    if event_type == "permission.asked":
        return frozenset({STATE_WAITING, REFRESH_NOTICES})
    if event_type in {"permission.replied", "permission.rejected"}:
        return frozenset({REFRESH_NOTICES, REFRESH_TIMELINE})
    if event_type in {"form.created", "form.replied", "form.cancelled"}:
        return frozenset({REFRESH_NOTICES})
    if event_type in _TIMELINE:
        return frozenset({REFRESH_TIMELINE})
    if event_type in _SESSION:
        return frozenset({REFRESH_SESSION})
    if event_type in _CATALOGS:
        return frozenset({REFRESH_CATALOGS})
    return frozenset()
