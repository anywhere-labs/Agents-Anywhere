from __future__ import annotations

from connector.planning.application.service import PlanningService
from connector.planning.infrastructure.store import PlanningStore


def bind_planning(runtime, host, port):
    """Composition root used by Runtime providers; no provider branching in the domain."""
    kv = getattr(host, "runtime_kv", None)
    publisher = getattr(host, "publish_planning", None)
    if kv is None or not callable(publisher):
        return runtime  # Legacy hosts cannot promise durable plans.
    store = PlanningStore(kv.path.parent / "planning.sqlite3")
    service = PlanningService(
        runtime.identity.runtime, port, store, host.publish_planning
    )
    runtime.__dict__["_planning"] = service
    host.__dict__["_planning_observer"] = service.observe
    host.__dict__["_planning_prepare"] = service.prepare_turn
    host.__dict__["_planning_port"] = port
    host.__dict__["_planning_validate"] = service.validate_document
    return runtime
