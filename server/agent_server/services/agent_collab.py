"""Agent collaboration on the Server (``core.agent_collab``).

* Account settings: stored on the user, handed to every device of the account in its desired device settings
  (``agentCollaboration``), delivered at once to the devices that are online.
* Delegation tokens: issued to a device for an Agent that reaches other devices through the Server; a request with
  one authenticates as ``AgentPrincipal``. Only a hash is stored; expiry and revocation are checked on every use.
* Outbox messages of the supervisor's device: ``collab.supervision.changed`` (supervision edges, refused when they
  would close a cycle) and ``collab.grant.changed`` (a revoked grant revokes its delegations).
* Target signals: when a supervised session's scheduling fields change, or its device goes on or off line, the
  supervisor's device gets ``collab.signal``. Lossy and best effort: no receipt, no retry, sent off the hot path.
"""

from __future__ import annotations

import asyncio
import secrets
from collections import defaultdict
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from typing import Any, get_args

from loguru import logger

from agent_server.core.agent_collab import (
    DELEGATION_TOKEN_KIND,
    DELEGATION_TTL_SECONDS,
    MAX_ORIGIN_DEPTH,
    AgentCollaborationSettings,
    AgentDelegationRequest,
    AgentDelegationResponse,
    AgentPrincipal,
    ReviewAdmission,
    ReviewAdmissionRequest,
    ReviewProject,
    collaboration_settings_from_stored,
    delegation_token_hash,
    scope_devices,
)
from agent_server.core.auth import create_signed_token, verify_signed_token
from agent_server.core.device_meshcall import (
    CollabGrantOut,
    CollabSignalCommand,
    CollabSupervisionOut,
    CollabTargetSignal,
    SessionOrigin,
    SessionStatusValue,
)
from agent_server.core.device_settings import (
    device_settings_from_stored,
    device_settings_payload,
)
from agent_server.core.utc import utc_now
from agent_server.services.dashboard_events import publish_dashboard_changed

SIGNAL_COMMAND = "collab.signal"
#: ``CollabSignalCommand.signals`` holds at most this many signals.
MAX_SIGNALS_PER_COMMAND = 100
SIGNAL_TIMEOUT_SECONDS = 5.0
#: The fields whose change is signalled (with the device's presence).
SIGNAL_FIELDS = ("status", "headSeq", "resetSeq", "latestTurnEndSeq", "planState", "goalState")
_STATUSES = frozenset(get_args(SessionStatusValue))


class CollabError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


def _unavailable(message: str) -> CollabError:
    return CollabError(403, "agent_delegation_unavailable", message)


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _expired(expires_at: str) -> bool:
    try:
        moment = datetime.fromisoformat(expires_at)
    except ValueError:
        return True
    return moment <= datetime.now(UTC)


class CollabService:
    """One per worker. ``commands``: ``DeviceCommandService``; ``online``: whether a device is linked now."""

    def __init__(
        self,
        store: Any,
        broker: Any,
        commands: Any,
        online: Callable[[str], Any],
        *,
        signals_enabled: Callable[[], bool] = lambda: True,
    ) -> None:
        self._store = store
        self._broker = broker
        self._commands = commands
        self._online = online
        self._signals_enabled = signals_enabled
        self._tasks: set[asyncio.Task[Any]] = set()

    # -- account settings ---------------------------------------------------------------

    async def get_settings(self, user_id: str) -> AgentCollaborationSettings:
        return collaboration_settings_from_stored(await self._store.get_agent_collaboration(user_id))

    async def update_settings(self, user_id: str, settings: AgentCollaborationSettings) -> AgentCollaborationSettings:
        """Store the settings, then hand them to every v3 device of the account that is online now; the others get
        them in ``LinkWelcome.desired.deviceSettings`` when they link again."""

        await self._store.set_agent_collaboration(user_id, settings.model_dump(mode="json"))
        device_ids = await self._store.list_link_device_ids(user_id)
        if device_ids:
            await asyncio.gather(
                *(self._deliver_settings(device_id, settings) for device_id in device_ids), return_exceptions=True
            )
        return settings

    async def desired_device_settings(self, device_id: str) -> dict[str, Any]:
        """``LinkWelcome.desired.deviceSettings``: the device's own settings and the account's collaboration."""

        own = device_settings_from_stored(await self._store.get_connector_device_settings(device_id))
        collaboration = await self._store.connector_agent_collaboration(device_id)
        return device_settings_payload(own, collaboration).model_dump(mode="json")

    async def _deliver_settings(self, device_id: str, settings: AgentCollaborationSettings) -> bool:
        from agent_server.services.connector_device_settings import (
            deliver_device_settings_v3,
        )

        if not await self._online(device_id):
            return False
        own = device_settings_from_stored(await self._store.get_connector_device_settings(device_id))
        return await deliver_device_settings_v3(self._commands, device_id, device_settings_payload(own, settings))

    # -- delegations ------------------------------------------------------------------------

    async def issue_delegation(self, device_id: str, request: AgentDelegationRequest) -> AgentDelegationResponse:
        """A delegation token for an Agent of ``device_id`` acting for ``request.supervisorSessionId``.

        Refused (403 ``agent_delegation_unavailable``) unless the supervisor session is this device's and the
        account allows its runtime instance to reach other devices.
        """

        connector = await self._store.get_connector(device_id)
        user_id = connector.userId
        try:
            session = await self._store.get_session(request.supervisorSessionId, user_id=user_id)
        except KeyError:
            raise _unavailable("the supervisor session is not this device's") from None
        if session.connectorId != device_id:
            raise _unavailable("the supervisor session is not this device's")
        settings = await self.get_settings(user_id)
        if not settings.instance_cross_device(session.runtimeId):
            raise _unavailable("cross-device collaboration is off for this session's runtime instance")
        devices = scope_devices(request.scope)
        if devices is not None:
            owned = {item.id for item in await self._store.list_connectors(user_id=user_id)}
            if not devices <= owned:
                raise _unavailable("the scope names a device that is not this account's")
        delegation_id = f"dlg_{secrets.token_hex(12)}"
        token = create_signed_token(
            DELEGATION_TOKEN_KIND,
            {"did": delegation_id, "sub": user_id, "dev": device_id},
            DELEGATION_TTL_SECONDS,
        )
        expires_at = _iso(datetime.now(UTC) + timedelta(seconds=DELEGATION_TTL_SECONDS))
        await self._store.create_agent_delegation(
            delegation_id=delegation_id,
            user_id=user_id,
            device_id=device_id,
            supervisor_session_id=session.id,
            grant_id=request.grantId,
            scope=request.scope.model_dump(mode="json"),
            token_hash=delegation_token_hash(token),
            expires_at=expires_at,
        )
        logger.info(
            "agent delegation issued device_id={} session_id={} grant_id={} delegation_id={}",
            device_id, session.id, request.grantId, delegation_id,
        )
        return AgentDelegationResponse(delegationId=delegation_id, token=token, expiresAt=expires_at)

    async def revoke_grant(self, device_id: str, grant_id: str) -> int:
        revoked = await self._store.revoke_agent_delegations(device_id=device_id, grant_id=grant_id)
        if revoked:
            logger.info("agent delegations revoked device_id={} grant_id={} count={}", device_id, grant_id, revoked)
        return revoked

    @staticmethod
    def looks_like_delegation(token: str) -> bool:
        """A signed delegation token (signature, kind and expiry checked; not yet whether it was revoked)."""

        return verify_signed_token(DELEGATION_TOKEN_KIND, token) is not None

    async def authenticate(self, token: str) -> AgentPrincipal:
        """The principal of a delegation token; raises ``CollabError`` (401) when it no longer holds."""

        claims = verify_signed_token(DELEGATION_TOKEN_KIND, token)
        if claims is None:
            raise CollabError(401, "agent_delegation_invalid", "the delegation token is invalid or expired")
        row = await self._store.agent_delegation_by_token(delegation_token_hash(token))
        if row is None or row["delegationId"] != claims.get("did"):
            raise CollabError(401, "agent_delegation_invalid", "the delegation token is unknown")
        if row["revokedAt"] is not None:
            raise CollabError(401, "agent_grant_revoked", "the collaboration grant of this delegation was revoked")
        if _expired(row["expiresAt"]):
            raise CollabError(401, "agent_delegation_invalid", "the delegation token expired")
        if row["userDisabled"] or not row["deviceActive"] or row["supervisorDeviceId"] != row["deviceId"]:
            raise CollabError(401, "agent_grant_revoked", "the supervisor session or its device is gone")
        settings = collaboration_settings_from_stored(row["collaboration"])
        if not settings.instance_cross_device(row["supervisorRuntimeId"]):
            raise CollabError(401, "agent_grant_revoked", "cross-device collaboration was turned off")
        return AgentPrincipal(
            user_id=row["userId"],
            device_id=row["deviceId"],
            supervisor_session_id=row["supervisorSessionId"],
            grant_id=row["grantId"],
            delegation_id=row["delegationId"],
            devices=scope_devices(row["scope"]),
        )

    async def review_admission(self, target_id: str, request: ReviewAdmissionRequest) -> ReviewAdmission:
        """Resolve current collaboration authority and the selected project for a review worker."""

        denied = CollabError(403, "agent_scope_denied", "review is outside the current collaboration scope")
        connector = await self._store.get_connector(target_id)
        user_id = connector.userId
        if request.delegation is not None:
            principal = await self.authenticate(request.delegation)
            if (
                (principal.user_id, principal.device_id, principal.supervisor_session_id, principal.grant_id)
                != (user_id, request.deviceId, request.sessionId, request.grantId)
                or not principal.may_reach(target_id)
            ):
                raise denied
        elif target_id != request.deviceId:
            raise denied
        try:
            session = await self._store.get_session(request.sessionId, user_id=user_id)
        except KeyError:
            raise denied from None
        if session.connectorId != request.deviceId or session.archived:
            raise denied
        settings = await self.get_settings(user_id)
        authority = settings.instance(session.runtimeId).authority
        depth = int((session.origin or {}).get("depth", 0)) + 1
        if not settings.instance_enabled(session.runtimeId) or not authority.steer or depth > MAX_ORIGIN_DEPTH:
            raise denied
        project = None
        if request.projectId is not None:
            try:
                project = await self._store.get_project(request.projectId, user_id=user_id)
            except KeyError:
                raise denied from None
        elif request.cwd is not None:
            project = next(
                (
                    row for row in await self._store.list_projects(user_id=user_id)
                    if row.connectorId == target_id and row.workspacePath == request.cwd
                ),
                None,
            )
        if (request.projectId is not None or request.cwd is not None) and (
            project is None or project.connectorId != target_id or project.workspacePath != request.cwd
        ):
            raise denied
        return ReviewAdmission(
            depth=depth,
            interrupt=authority.interrupt,
            project=ReviewProject(id=project.id, cwd=project.workspacePath) if project is not None else None,
        )

    # -- outbox of the supervisor's device ---------------------------------------------------

    async def supervision_changed(self, device_id: str, message: CollabSupervisionOut) -> None:
        """Store a supervision edge the supervisor's device reported (acknowledged even when refused)."""

        try:
            connector = await self._store.get_connector(device_id)
            supervisor = await self._store.get_session(message.supervisorSessionId, user_id=connector.userId)
            target = await self._store.get_session(message.targetSessionId, user_id=connector.userId)
        except KeyError:
            logger.warning(
                "supervision refused: unknown session device_id={} supervision_id={}", device_id, message.supervisionId
            )
            return
        if supervisor.connectorId != device_id:
            logger.warning(
                "supervision refused: the supervisor session is not the sender's device_id={} supervision_id={}",
                device_id, message.supervisionId,
            )
            return
        if target.connectorId != message.targetDeviceId:
            logger.warning(
                "supervision refused: the target is on another device device_id={} supervision_id={}",
                device_id, message.supervisionId,
            )
            return
        edge, refused = await self._store.upsert_collab_edge(
            supervision_id=message.supervisionId,
            user_id=connector.userId,
            supervisor_session_id=supervisor.id,
            supervisor_device_id=device_id,
            target_session_id=target.id,
            target_device_id=target.connectorId,
            state=message.state,
            created_by=message.createdBy,
            at=message.at,
        )
        if edge is None:
            logger.warning("supervision refused: another account's edge supervision_id={}", message.supervisionId)
            return
        if refused:
            logger.warning(
                "supervision refused: it would close a cycle supervision_id={} supervisor={} target={}",
                message.supervisionId, supervisor.id, target.id,
            )
        await publish_dashboard_changed(
            self._store, self._broker, user_id=connector.userId, reason="collab.supervision"
        )

    async def grant_changed(self, device_id: str, message: CollabGrantOut) -> None:
        if message.state == "revoked":
            await self.revoke_grant(device_id, message.grantId)

    async def summary_origin(self, session_id: str, origin: SessionOrigin) -> None:
        """A device reported who created the session; kept only when no origin is stored yet (immutable)."""

        await self._store.set_session_origin(session_id, origin.model_dump(mode="json", exclude_none=True))

    # -- target signals ------------------------------------------------------------------

    async def before_summary(self, session_id: str) -> dict[str, Any] | None:
        """The session's signalled fields before a summary is applied, or None when nothing supervises it."""

        if not self._signals_enabled():
            return None
        if not await self._store.live_collab_edges_for_targets([session_id]):
            return None
        return (await self._store.session_signal_states([session_id])).get(session_id)

    def after_summary(self, session_id: str, before: dict[str, Any] | None) -> None:
        """Signal the supervisors when a signalled field changed (off the caller's path)."""

        if before is None:
            return
        self._spawn(self._signal_if_changed(session_id, before), f"collab-signal-{session_id}")

    def on_presence(self, device_id: str, online: bool) -> None:
        """The device of supervised sessions went on or off line."""

        if not self._signals_enabled():
            return
        self._spawn(self._signal_device(device_id, online), f"collab-presence-{device_id}")

    async def _signal_if_changed(self, session_id: str, before: dict[str, Any]) -> None:
        after = (await self._store.session_signal_states([session_id])).get(session_id)
        if after is None or all(before.get(name) == after.get(name) for name in SIGNAL_FIELDS):
            return
        edges = await self._store.live_collab_edges_for_targets([session_id])
        await self._fan_out(edges, {session_id: after})

    async def _signal_device(self, device_id: str, online: bool) -> None:
        edges = await self._store.live_collab_edges_for_target_device(device_id)
        if not edges:
            return
        states = await self._store.session_signal_states(edge["targetSessionId"] for edge in edges)
        await self._fan_out(edges, states, online={device_id: online})

    async def _fan_out(
        self,
        edges: Iterable[dict[str, Any]],
        states: dict[str, dict[str, Any]],
        *,
        online: dict[str, bool] | None = None,
    ) -> None:
        """One ``collab.signal`` per supervisor device with a signal per edge."""

        presence = dict(online or {})
        by_device: dict[str, list[CollabTargetSignal]] = defaultdict(list)
        now = utc_now()
        for edge in edges:
            state = states.get(edge["targetSessionId"])
            if state is None:
                continue
            target_device = edge["targetDeviceId"]
            if target_device not in presence:
                presence[target_device] = bool(await self._online(target_device))
            status = state["status"] if state["status"] in _STATUSES else "unknown"
            by_device[edge["supervisorDeviceId"]].append(
                CollabTargetSignal(
                    supervisionId=edge["supervisionId"],
                    supervisorSessionId=edge["supervisorSessionId"],
                    targetSessionId=edge["targetSessionId"],
                    targetDeviceId=target_device,
                    status=status,
                    headSeq=state["headSeq"],
                    resetSeq=state["resetSeq"],
                    latestTurnEndSeq=state["latestTurnEndSeq"],
                    planState=state["planState"],
                    goalState=state["goalState"],
                    deviceOnline=presence[target_device],
                    at=now,
                )
            )
        await asyncio.gather(*(self._send(device_id, signals) for device_id, signals in by_device.items()))

    async def _send(self, device_id: str, signals: list[CollabTargetSignal]) -> None:
        for start in range(0, len(signals), MAX_SIGNALS_PER_COMMAND):
            batch = signals[start:start + MAX_SIGNALS_PER_COMMAND]
            payload = CollabSignalCommand(signals=batch).model_dump(mode="json")
            try:
                await self._commands.send_lossy(
                    device_id=device_id, kind=SIGNAL_COMMAND, payload=payload, timeout=SIGNAL_TIMEOUT_SECONDS
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - lossy: an offline or failing supervisor misses the signal
                logger.info(
                    "collab signal not delivered device_id={} signals={} error={}",
                    device_id, len(batch), getattr(exc, "code", None) or exc.__class__.__name__,
                )
                return

    # -- background work ------------------------------------------------------------------------

    def _spawn(self, work: Any, name: str) -> None:
        task = asyncio.create_task(self._guard(work, name), name=name)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    @staticmethod
    async def _guard(work: Any, name: str) -> None:
        try:
            await work
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - signals never break ingest or presence
            logger.exception("collab signal failed task={}", name)

    async def drain(self) -> None:
        """Wait for the signals in flight (tests, shutdown)."""

        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*list(self._tasks), return_exceptions=True)
