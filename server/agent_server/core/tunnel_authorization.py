"""Authorization of AA management calls carried by MeshCall encrypted tunnels."""

import json
from dataclasses import dataclass
from typing import Literal

from agent_server.core.device_content import (
    MOBILE_CONTENT_GRANT_METHOD,
    MOBILE_CONTROL_SERVICE,
    MOBILE_DIRECTORY_METHOD,
)
from agent_server.core.device_meshcall import MESH_SERVICE_PREFIX


@dataclass(frozen=True)
class TunnelAuthorization:
    target: Literal["mobile_server_instance", "current_device_connection"]
    principal: str
    principal_format: Literal["literal", "prefix+json[user_id,family_id,public_router_url]"]
    scopes: dict[str, tuple[str, ...]]
    ttl_seconds: int | None = None  # None uses the pinned SDK's default.
    require_e2e: Literal[True] = True
    max_connections: int = 1

    def allows(self, service: str, method: str) -> bool:
        return method in self.scopes.get(service, ())


MOBILE_CONTROL = TunnelAuthorization(
    target="mobile_server_instance",
    principal="aa-mobile-control/",
    principal_format="prefix+json[user_id,family_id,public_router_url]",
    scopes={MOBILE_CONTROL_SERVICE: (MOBILE_CONTENT_GRANT_METHOD, MOBILE_DIRECTORY_METHOD)},
    ttl_seconds=300,
)
DEVICE_CONTROL = TunnelAuthorization(
    target="current_device_connection",
    principal="aa-server-control",
    principal_format="literal",
    scopes={
        f"{MESH_SERVICE_PREFIX}.Link": ("attach", "outbox", "ackOutbox"),
        f"{MESH_SERVICE_PREFIX}.Commands": (
            "status", "runtimeApply", "deviceSettingsApply", "channelSwitch", "previewOpen", "previewClose",
        ),
    },
)


def mobile_control_principal(user_id: str, family_id: str, public_router_url: str) -> str:
    return MOBILE_CONTROL.principal + json.dumps(
        [user_id, family_id, public_router_url], separators=(",", ":")
    )


def mobile_control_identity(principal: str) -> tuple[str, str, str] | None:
    if not principal.startswith(MOBILE_CONTROL.principal):
        return None
    try:
        values = json.loads(principal[len(MOBILE_CONTROL.principal):])
    except ValueError:
        return None
    if not isinstance(values, list) or len(values) != 3 or not all(
        isinstance(value, str) and value for value in values
    ):
        return None
    return values[0], values[1], values[2]
