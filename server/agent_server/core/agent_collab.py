"""Agent collaboration: account settings, delegation tokens and supervision edges (API-neutral).

An Agent working in one session may create, drive and supervise sessions on the same or another device of the
same account. The Server owns three facts about it:

* the account's collaboration settings (``AgentCollaborationSettings``), handed to every device of the account in
  its desired device settings under ``agentCollaboration``;
* delegation tokens a device asks for when its Agent reaches another device through the Server
  (``AgentPrincipal`` is what such a request authenticates as);
* the supervision edges devices report (``collab.supervision.changed``), shown on session views and used to
  forward target signals (``collab.signal``) to the supervisor's device.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from agent_server.core.client_routes import (
    API,
    CONNECTOR,
    ClientRoute,
    match_route,
    template_regex,
)

#: ``core.auth.create_signed_token`` kind of a delegation token.
DELEGATION_TOKEN_KIND = "agent_delegation"
DELEGATION_TTL_SECONDS = 60 * 60
#: Deepest chain of sessions created by Agents (a person's session is depth 0).
MAX_ORIGIN_DEPTH = 8
#: ASGI ``scope["state"]`` key holding the ``AgentPrincipal`` of a request with a delegation token.
AGENT_PRINCIPAL_STATE = "agent_principal"
#: Key of the collaboration settings in a device's desired settings (``LinkWelcome.desired.deviceSettings``).
DEVICE_SETTINGS_KEY = "agentCollaboration"

SupervisionState = Literal["active", "paused", "ended"]
SupervisionCreator = Literal["human", "agent"]
#: Edges that still count: views list them, cycles are checked among them, signals follow them.
LIVE_EDGE_STATES: tuple[str, ...] = ("active", "paused")


class _Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AgentAuthority(_Settings):
    """What a supervisor may do to a session on a person's behalf; steering and closing by default."""

    steer: bool = True
    interrupt: bool = False
    respondApproval: bool = False
    reviewPlan: bool = False
    close: bool = True


class AgentCollaborationInstance(_Settings):
    """One runtime instance's switches (keyed by its ``runtimeId``)."""

    enabled: bool = False
    crossDevice: bool = False
    authority: AgentAuthority = Field(default_factory=AgentAuthority)


class AgentCollaborationSettings(_Settings):
    """``GET/PUT /api/v2/agent-collaboration/settings``; also the device settings key ``agentCollaboration``.

    An instance is on only when the account and the instance are enabled; it may reach other devices only when
    both ``crossDevice`` flags are on as well.
    """

    enabled: bool = False
    crossDevice: bool = False
    instances: dict[str, AgentCollaborationInstance] = Field(default_factory=dict)

    def instance(self, runtime_id: str | None) -> AgentCollaborationInstance:
        if runtime_id is None:
            return AgentCollaborationInstance()
        return self.instances.get(runtime_id) or AgentCollaborationInstance()

    def instance_enabled(self, runtime_id: str | None) -> bool:
        return self.enabled and self.instance(runtime_id).enabled

    def instance_cross_device(self, runtime_id: str | None) -> bool:
        instance = self.instance(runtime_id)
        return self.instance_enabled(runtime_id) and self.crossDevice and instance.crossDevice


def _flag(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def collaboration_settings_from_stored(value: Any) -> AgentCollaborationSettings:
    """Stored settings, keeping valid known fields and defaulting the rest (a missing or older value)."""

    if not isinstance(value, dict):
        return AgentCollaborationSettings()
    instances: dict[str, AgentCollaborationInstance] = {}
    raw_instances = value.get("instances")
    for runtime_id, raw in (raw_instances.items() if isinstance(raw_instances, dict) else ()):
        if not isinstance(runtime_id, str) or not runtime_id or not isinstance(raw, dict):
            continue
        defaults = AgentAuthority()
        raw_authority = raw.get("authority") if isinstance(raw.get("authority"), dict) else {}
        authority = AgentAuthority(
            **{name: _flag(raw_authority.get(name), getattr(defaults, name)) for name in AgentAuthority.model_fields}
        )
        instances[runtime_id] = AgentCollaborationInstance(
            enabled=_flag(raw.get("enabled"), False),
            crossDevice=_flag(raw.get("crossDevice"), False),
            authority=authority,
        )
    return AgentCollaborationSettings(
        enabled=_flag(value.get("enabled"), False),
        crossDevice=_flag(value.get("crossDevice"), False),
        instances=instances,
    )


# ---------------------------------------------------------------------------
# Delegations
# ---------------------------------------------------------------------------


class DelegationScope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: ``account``: any device of the account; otherwise the devices the Agent may reach.
    devices: Literal["account"] | list[str] = "account"


class AgentDelegationRequest(BaseModel):
    """``POST /api/v3/device/agent-delegations``."""

    model_config = ConfigDict(extra="forbid")

    grantId: str = Field(min_length=1, max_length=200)
    supervisorSessionId: str = Field(min_length=1, max_length=200)
    scope: DelegationScope = Field(default_factory=DelegationScope)


class AgentDelegationResponse(BaseModel):
    delegationId: str
    token: str
    expiresAt: str


class ReviewAdmissionRequest(_Settings):
    """Metadata only. Review requests, commit IDs, and results stay in the review data plane."""

    deviceId: str = Field(min_length=1, max_length=200)
    sessionId: str = Field(min_length=1, max_length=200)
    grantId: str = Field(min_length=1, max_length=200)
    delegation: str | None = Field(default=None, max_length=8192)
    projectId: str | None = Field(default=None, max_length=200)
    cwd: str | None = Field(default=None, max_length=4096)


class ReviewProject(_Settings):
    id: str
    cwd: str


class ReviewAdmission(_Settings):
    depth: int
    interrupt: bool
    project: ReviewProject | None = None


class AgentDelegationRevokeResponse(BaseModel):
    grantId: str
    revoked: int


def delegation_token_hash(token: str) -> str:
    return "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class AgentPrincipal:
    """Who a request with a delegation token is: an Agent acting for ``supervisor_session_id`` on ``device_id``."""

    user_id: str
    device_id: str
    supervisor_session_id: str
    grant_id: str
    delegation_id: str
    #: None: every device of the account.
    devices: frozenset[str] | None

    def may_reach(self, device_id: str) -> bool:
        return self.devices is None or device_id in self.devices

    @property
    def actor(self) -> str:
        return agent_actor(self.device_id, self.supervisor_session_id)


def agent_actor(device_id: str, session_id: str) -> str:
    """The ``device_commands.actor`` of a command an Agent sent (``user`` for a person)."""

    return f"agent:{device_id}/{session_id}"


def scope_devices(scope: dict[str, Any] | DelegationScope | None) -> frozenset[str] | None:
    raw = scope.devices if isinstance(scope, DelegationScope) else (scope or {}).get("devices", "account")
    if raw == "account" or not isinstance(raw, list):
        return None
    return frozenset(item for item in raw if isinstance(item, str) and item)


# ---------------------------------------------------------------------------
# Routes a delegated Agent may call
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AgentServerRoute:
    """A Server-owned route the collaboration tools need besides the client table's ``agent=True`` routes."""

    method: str
    path: str


AGENT_SERVER_ROUTES: tuple[AgentServerRoute, ...] = (
    # The account's devices (id, name, online, E2EE mode only) and one device's runtime instances.
    AgentServerRoute("GET", f"{API}/connectors"),
    AgentServerRoute("GET", f"{CONNECTOR}/runtimes"),
    # The session directory.
    AgentServerRoute("GET", f"{API}/sessions"),
    AgentServerRoute("GET", f"{API}/sessions/list"),
    # The client side of E2EE channels.
    AgentServerRoute("WS", "/api/v3/tunnel"),
)


@dataclass(frozen=True, slots=True)
class AgentRouteMatch:
    path: str
    #: The table entry, or None for an ``AGENT_SERVER_ROUTES`` entry.
    route: ClientRoute | None
    params: dict[str, str]


def _params(template: str, path: str) -> dict[str, str]:
    names = re.findall(r"\{([a-z_]+)\}", template)
    pattern = re.compile("".join(
        f"(?P<{part[1:-1]}>[^/]+)" if part.startswith("{") else re.escape(part)
        for part in re.split(r"(\{[a-z_]+\})", template)
    ))
    found = pattern.fullmatch(path)
    return {name: found.group(name) for name in names} if found else {}


def agent_route(method: str, path: str) -> AgentRouteMatch | None:
    """The route a delegated Agent may call for ``method path`` (``WS`` for a WebSocket), or None."""

    method = method.upper()
    route = match_route(method, path)
    if route is not None:
        return AgentRouteMatch(route.path, route, _params(route.path, path)) if route.agent else None
    for entry in AGENT_SERVER_ROUTES:
        if entry.method == method and re.fullmatch(template_regex(entry.path), path):
            return AgentRouteMatch(entry.path, None, _params(entry.path, path))
    return None


# ---------------------------------------------------------------------------
# Supervision graph
# ---------------------------------------------------------------------------


def creates_cycle(edges: Iterable[tuple[str, str]], supervisor: str, target: str) -> bool:
    """Whether adding ``supervisor -> target`` to ``edges`` (supervisor, target pairs) closes a cycle."""

    if supervisor == target:
        return True
    children: dict[str, set[str]] = {}
    for parent, child in edges:
        children.setdefault(parent, set()).add(child)
    stack, seen = [target], set()
    while stack:
        node = stack.pop()
        if node == supervisor:
            return True
        if node in seen:
            continue
        seen.add(node)
        stack.extend(children.get(node, ()))
    return False
