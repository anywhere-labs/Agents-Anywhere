from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ConnectorLease:
    instance_id: str
    connection_id: str
    ready: bool = True
    # "mesh": a v3 device held over MeshCall (device-meshcall 1.0); any worker calls it directly.
    transport: str = "ws"
