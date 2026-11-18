"""v3 device link: hello/ready handshake, outbox processing, lossy events, presence.

``contracts/device-meshcall/1.0``. The device authenticates with its v2
Connector credentials, says hello over HTTP, registers ``aa.device.v1.*`` on the
MeshCall Router with the token from ``LinkWelcome.mesh``, then calls ready; the
worker that takes ready holds ``Link/attach`` and ``Link/outbox``.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from loguru import logger
from pydantic import ValidationError

from agent_server.core.device_meshcall import (
    DEFERRABLE_COMMANDS,
    DEVICE_MESHCALL_VERSION,
    MESH_MAX_FRAME_BYTES,
    AttachmentConsumedOut,
    CollabGrantOut,
    CollabSupervisionOut,
    CommandResultOut,
    DesiredState,
    LinkHello,
    LinkWelcome,
    MeshCredentials,
    OutboxItem,
    PendingCommand,
    SessionInventoryOut,
    SessionSummary,
    SessionSummaryOut,
    UsageReportOut,
    registered_services,
    replay_payload,
    scrub_for_e2ee,
)
from agent_server.core.device_runtime import DeviceRuntimeView
from agent_server.core.e2ee_settings import E2eeSettings, accept_display_envelope
from agent_server.infra.device_link import DeviceLinkHub
from agent_server.infra.device_mesh import (
    DeviceCallError,
    DeviceMesh,
    MeshNotConfigured,
)
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_commands import (
    DeviceCommandError,
    DeviceCommandRejected,
)
from agent_server.services.device_runtimes import device_runtime_entry

LINK_CONTRACT = f"device-meshcall/{DEVICE_MESHCALL_VERSION}"
REQUIRED_SERVICES = frozenset({"aa.device.v1.Link", "aa.device.v1.Commands"})
_SERVER_VERSION = "3.0.0-dev"
# A takeover change waits this long for the device before it is left for the next time the device links.
TAKEOVER_SYNC_TIMEOUT_SECONDS = 15.0


class DeviceLinkError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _iso_from_ms(value: int) -> str:
    return datetime.fromtimestamp(value / 1000, UTC).isoformat()


# ``LinkHello.os`` (Node's ``process.platform``) as the connector's ``deviceOs``.
_DEVICE_OS = {"darwin": "macos", "macos": "macos", "win32": "windows", "windows": "windows", "linux": "linux"}


def _device_os(value: str) -> str | None:
    return _DEVICE_OS.get(value.strip().lower())


class DeviceLinkService:
    """One per worker; also the outbox, event and presence handler of the hub."""

    def __init__(
        self,
        store: Any,
        mesh: DeviceMesh,
        hub: DeviceLinkHub,
        coordinator: Any,
        broker: Any,
        *,
        capability_refresh: Any | None = None,
        usage_recorder: Any | None = None,
        e2ee_settings: Callable[[], E2eeSettings] = E2eeSettings,
    ) -> None:
        self._store = store
        # ``app.state.e2ee_settings``, read on every use.
        self._e2ee_settings = e2ee_settings
        self._mesh = mesh
        self._hub = hub
        self._coordinator = coordinator
        self._broker = broker
        self._capability_refresh = capability_refresh
        self._usage_recorder = usage_recorder
        self._local_records: dict[str, dict[str, Any]] = {}
        # deviceId -> {sessionId: token}: takeover changes the device has not confirmed (single-worker mode).
        self._local_takeover: dict[str, dict[str, str]] = {}
        # Lossy runtime/port state per device, for clients that ask later (no content).
        self.runtime_status: dict[str, dict[str, Any]] = {}
        self.event_listeners: list[Any] = []
        # ``(device_id, online)`` callbacks (port previews close after a grace period offline).
        self.presence_listeners: list[Any] = []
        # ``SessionWatchHub``: opens/stops ``Sessions/watch`` streams as the link comes and goes.
        self.session_watch: Any | None = None
        # ``DeviceCommandService``: settles ``unknown`` receipts after ``ready``.
        self.commands: Any | None = None
        # ``DeviceBlobService.consumed``: drops the staged copy of a file the device stored.
        self.attachment_consumed: Any | None = None
        # ``services.agent_collab.CollabService``: supervision edges, grants, session origin and target signals.
        self.collab: Any | None = None
        self._reconcile_tasks: set[asyncio.Task[Any]] = set()
        hub.on_outbox = self.handle_outbox
        hub.on_event = self.handle_event
        hub.on_presence = self.handle_presence

    # -- link records (connection generation + current Router token) -----------

    def _record_key(self, device_id: str) -> str:
        return self._coordinator.key("device-link", device_id)

    async def _swap_record(self, device_id: str, record: dict[str, Any]) -> dict[str, Any] | None:
        encoded = json.dumps(record, separators=(",", ":"), sort_keys=True)
        if not self._coordinator.distributed:
            previous = self._local_records.get(device_id)
            self._local_records[device_id] = record
            return previous
        raw = await self._coordinator.client.getset(self._record_key(device_id), encoded)
        try:
            return json.loads(raw) if raw else None
        except (TypeError, ValueError):
            return None

    async def _take_record(self, device_id: str) -> dict[str, Any] | None:
        """Remove and return the record, so a later ``ready`` with its connectionId is refused."""

        if not self._coordinator.distributed:
            return self._local_records.pop(device_id, None)
        raw = await self._coordinator.client.getdel(self._record_key(device_id))
        try:
            return json.loads(raw) if raw else None
        except (TypeError, ValueError):
            return None

    async def link_record(self, device_id: str) -> dict[str, Any] | None:
        if not self._coordinator.distributed:
            return self._local_records.get(device_id)
        raw = await self._coordinator.client.get(self._record_key(device_id))
        try:
            return json.loads(raw) if raw else None
        except (TypeError, ValueError):
            return None

    # -- handshake ----------------------------------------------------------------

    async def hello(self, device_id: str, hello: LinkHello, *, router_url: str) -> LinkWelcome:
        if hello.deviceId != device_id:
            raise DeviceLinkError(403, "device_mismatch", "deviceId does not match the credentials")
        if DEVICE_MESHCALL_VERSION not in hello.contractVersions:
            raise DeviceLinkError(
                409, "contract_unsupported", f"this Server speaks device-meshcall {DEVICE_MESHCALL_VERSION}"
            )
        if not self._mesh.configured:
            raise DeviceLinkError(503, "mesh_unavailable", "this Server has no MeshCall Router configured")
        mode = self._e2ee_settings().mode
        try:
            # The token may register exactly the contract's table for this mode (``e2ee-registration.json``).
            token = await self._mesh.issue_device_token(device_id, registered_services(mode))
        except (DeviceCallError, MeshNotConfigured) as exc:
            raise DeviceLinkError(503, "mesh_unavailable", f"MeshCall Router unavailable: {exc}") from exc
        connection_id = f"lc_{secrets.token_urlsafe(16)}"
        previous = await self._swap_record(
            device_id, {"connectionId": connection_id, "tokenId": token.token_id}
        )
        if previous and previous.get("tokenId"):
            # Kicks a half-dead previous link at once (4401) so it frees the instance id.
            await self._mesh.revoke_token(str(previous["tokenId"]))
        await self._store.set_connector_link_contract(device_id, LINK_CONTRACT)
        device_os = _device_os(hello.os)
        if device_os is not None:
            await self._store.record_connector_connection(device_id, device_os=device_os)
        floors = await self._store.device_seq_floors(
            device_id, {head.sessionId: head.headSeq for head in hello.sessionsHead}
        )
        desired = DesiredState(
            runtimes=await self._desired_runtimes(device_id),
            # The device's own settings and the account's agent collaboration settings (``agentCollaboration``).
            deviceSettings=(
                await self.collab.desired_device_settings(device_id)
                if self.collab is not None
                else await self._store.get_connector_device_settings(device_id)
            ),
        )
        pending: list[PendingCommand] = []
        for row in await self._store.unsettled_device_commands(device_id):
            # Only commands that may be delivered late (03-architecture §3.10); a user message
            # whose outcome is unknown is never re-sent, it converges through Commands/status.
            if row["kind"] not in DEFERRABLE_COMMANDS:
                continue
            # The receipt keeps no config or credentials: rebuild the payload from desired state.
            payload = replay_payload(
                row["kind"],
                row["payload"],
                runtimes=[runtime.model_dump(mode="json") for runtime in desired.runtimes],
                device_settings=desired.deviceSettings,
            )
            if payload is None:
                continue
            pending.append(
                PendingCommand(
                    commandId=row["commandId"],
                    deadline=row["expiresAt"],
                    inputDigest=row["inputDigest"],
                    p=payload,
                    m=row["kind"],
                )
            )
        logger.info(
            "device hello device_id={} connection_id={} floors={} pending={} host={}",
            device_id,
            connection_id,
            len(floors),
            len(pending),
            hello.host,
        )
        return LinkWelcome(
            contractVersion=DEVICE_MESHCALL_VERSION,
            serverVersion=_SERVER_VERSION,
            connectionId=connection_id,
            seqFloors=floors,
            e2eeMode=mode,
            desired=desired,
            pendingCommands=pending,
            mesh=MeshCredentials(
                routerUrl=router_url,
                token=token.token,
                tokenId=token.token_id,
                expiresAt=_iso_from_ms(token.expires_at_ms),
                instanceId=device_id,
                services=list(token.services),
                maxFrameBytes=MESH_MAX_FRAME_BYTES,
            ),
        )

    async def _desired_runtimes(self, device_id: str) -> list[dict[str, Any]]:
        try:
            rows = await self._store.list_device_runtimes(device_id)
        except KeyError:
            return []
        # Same shape as the ``runtime.apply`` payload, including ``revision`` so a late replayed command
        # never undoes the state delivered here.
        return [device_runtime_entry(DeviceRuntimeView.model_validate(row)) for row in rows]

    async def ready(self, device_id: str, connection_id: str) -> None:
        record = await self.link_record(device_id)
        if record is None or record.get("connectionId") != connection_id:
            raise DeviceLinkError(409, "connection_replaced", "this connectionId is not the current one; say hello again")
        try:
            registered = await self._mesh.registered_services(device_id)
        except DeviceCallError as exc:
            raise DeviceLinkError(503, "mesh_unavailable", f"MeshCall Router unavailable: {exc}") from exc
        missing = REQUIRED_SERVICES - registered
        if missing:
            raise DeviceLinkError(409, "services_not_registered", f"register {sorted(missing)} on the Router first")
        try:
            await self._hub.hold(device_id, connection_id)
        except DeviceCallError as exc:
            raise DeviceLinkError(409, "attach_failed", f"Link/attach did not answer: {exc}") from exc
        if self.commands is not None:
            # Receipts still ``unknown`` converge through read-only ``Commands/status``.
            task = asyncio.create_task(self.commands.reconcile_device(device_id), name=f"device-reconcile-{device_id}")
            self._reconcile_tasks.add(task)
            task.add_done_callback(self._reconcile_tasks.discard)

    async def revoke(self, device_id: str, reason: str) -> None:
        """Credentials revoked or reset, or the device deleted: end its v3 link from any worker.

        Callers hold ``connector_lifecycle(device_id)``, the same lock ``hello`` and ``ready`` take, and
        have already made the old credentials invalid, so the device cannot link again with them.

        - The link record is removed: a ``ready`` with its connectionId is refused.
        - The Router token is revoked: the Router closes the device connection (4401) whichever
          worker holds the link, so that worker's streams end.
        - This worker stops holding the link if it is the holder; the presence lease is deleted
          whoever holds it, so every worker sees the device offline at once and the holder, whose
          next renewal fails, closes its streams and reports the device offline.

        Harmless for a v2 device or one that never linked.
        """

        record = await self._take_record(device_id)
        if record and record.get("tokenId"):
            await self._mesh.revoke_token(str(record["tokenId"]))
        await self._hub.drop(device_id, reason)
        evicted = await self._hub.evict(device_id)
        self.runtime_status.pop(device_id, None)
        if record or evicted:
            logger.info(
                "device link revoked device_id={} reason={} lease_evicted={}", device_id, reason, evicted
            )

    # -- outbox -----------------------------------------------------------------

    async def handle_outbox(self, device_id: str, item: OutboxItem) -> None:
        """Process one outbox message idempotently (by natural key); raising makes the device resend."""

        required = self._e2ee_settings().required
        if required:
            # Defence in depth: a correct device sends no content here; drop it before storing or logging.
            item = item.model_copy(update={"p": scrub_for_e2ee(item.m, item.p)})
        try:
            if item.m == "session.summary":
                await self._apply_summary(device_id, SessionSummaryOut.model_validate(item.p).summary)
            elif item.m == "session.inventory":
                inventory = SessionInventoryOut.model_validate(item.p)
                for summary in inventory.sessions:
                    await self._apply_summary(device_id, summary)
            elif item.m == "command.result":
                result = CommandResultOut.model_validate(item.p)
                # One receipt table for every origin: this settles Server, forwarded client and sealed
                # (E2EE) commands alike; the first outcome wins.
                await self._store.settle_device_command(
                    device_id=device_id,
                    command_id=result.commandId,
                    state=result.outcome,
                    result={"r": result.r, "e": result.e.model_dump() if result.e else None},
                )
            elif item.m == "attachment.consumed":
                consumed = AttachmentConsumedOut.model_validate(item.p)
                await self._attachment_consumed(device_id, consumed)
            elif item.m == "usage.report":
                await self._record_usage(device_id, UsageReportOut.model_validate(item.p))
            elif item.m == "collab.supervision.changed":
                message = CollabSupervisionOut.model_validate(item.p)
                if self.collab is not None:
                    await self.collab.supervision_changed(device_id, message)
            elif item.m == "collab.grant.changed":
                grant = CollabGrantOut.model_validate(item.p)
                if self.collab is not None:
                    await self.collab.grant_changed(device_id, grant)
            else:
                logger.warning("unknown outbox message device_id={} m={} oid={}", device_id, item.m, item.oid)
        except ValidationError as exc:
            # A malformed message would be resent forever; acknowledge it and log loudly.
            logger.error("dropping invalid outbox message device_id={} m={} error={}", device_id, item.m, exc)

    async def _record_usage(self, device_id: str, report: UsageReportOut) -> None:
        """Platform statistics from the device's counters; idempotent by ``reportId``."""

        if self._usage_recorder is None:
            return
        from agent_server.services.usage_events import device_report_events

        owner = await self._connector_or_none(device_id)
        events = device_report_events(
            report,
            device_id=device_id,
            user_id=owner.userId if owner is not None else None,
            # Plain mode: the Server already counted messages and new sessions at the request.
            include_intents=self._e2ee_settings().required,
        )
        for event in events:
            await self._usage_recorder.record(event)

    async def _connector_or_none(self, device_id: str) -> Any | None:
        try:
            return await self._store.get_connector(device_id)
        except KeyError:
            return None

    async def _apply_summary(self, device_id: str, summary: SessionSummary) -> None:
        # Required mode drops a plaintext envelope (the list shows "encrypting until the device is online"):
        # neither the envelope nor its title or working directory is stored.
        required = self._e2ee_settings().required
        accepted = accept_display_envelope(
            self._e2ee_settings().mode, summary.displayDevice.model_dump(mode="json")
        ) is not None
        display = summary.displayDevice.payload if accepted and summary.displayDevice.mode == "plain" else {}
        display = display if isinstance(display, dict) else {}
        try:
            session = await self._store.upsert_connector_session(
                connector_id=device_id,
                session_id=summary.sessionId,
                runtime=summary.runtimeType,
                runtime_id=summary.runtimeId,
                external_session_id=summary.externalSessionId,
                title=display.get("title") if isinstance(display.get("title"), str) else None,
                cwd=display.get("cwd") if isinstance(display.get("cwd"), str) else None,
                last_activity_at=summary.lastActivityAt,
                # Required mode: the working directory is sealed, so a new session is placed by the
                # reported ``projectId`` or stays unplaced until a client assigns it (contracts/e2ee/1.0).
                project_id=summary.projectId if required else None,
                allow_unplaced=required,
            )
        except (KeyError, ValueError) as exc:
            # A summary that resending cannot fix: the device is gone or revoked (``KeyError``), no
            # working directory to place a new session, or a session bound to another device or
            # runtime (``ValueError``). Acknowledged and skipped. Anything else (database, Redis,
            # connection) propagates: the outbox pump closes and the device resends the summary.
            logger.info(
                "device session not placed device_id={} session_id={} reason={!r}",
                device_id,
                summary.sessionId,
                exc,
            )
            return
        # Supervised sessions: the signalled fields before the summary, to signal only a change.
        before = await self.collab.before_summary(session.id) if self.collab is not None else None
        changed = await self._store.apply_device_session_summary(session.id, summary, accept_display=accepted)
        if self.collab is not None:
            if summary.origin is not None:
                await self.collab.summary_origin(session.id, summary.origin)
            self.collab.after_summary(session.id, before)
        # The device is the only observer of its native records: what it reports is the state, including a
        # record that is ``available`` again after it was missing (the client's warning then goes away).
        if summary.sourceAvailability != session.sourceAvailability:
            await self._store.update_session_source_state(
                session.id,
                availability=summary.sourceAvailability,
                reason=None,
                observed_at=None,
                # The session summary is the device's inventory of its native records.
                observation_origin="inventory",
            )
            changed = True
        if changed:
            await publish_dashboard_changed(
                self._store, self._broker, connector_id=device_id, session_id=session.id, reason="session.summary"
            )

    async def _attachment_consumed(self, device_id: str, consumed: AttachmentConsumedOut) -> None:
        if self.attachment_consumed is not None:
            await self.attachment_consumed(device_id, consumed.fileId, consumed.sha256)

    # -- lossy events -------------------------------------------------------------

    async def handle_event(self, device_id: str, method: str, payload: dict[str, Any]) -> None:
        if method == "runtime.status":
            runtime_id = payload.get("runtimeId")
            if isinstance(runtime_id, str):
                self.runtime_status.setdefault(device_id, {})[runtime_id] = payload
        # ``port.listening`` / ``port.closed`` are the preview service's (an event listener):
        # it keeps the device's ports where every worker can read them.
        await self._forward_session_event(method, payload)
        for listener in list(self.event_listeners):
            try:
                result = listener(device_id, method, payload)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:  # noqa: BLE001 - listeners never break the link
                logger.exception("device event listener failed device_id={} m={}", device_id, method)

    async def _forward_session_event(self, method: str, payload: dict[str, Any]) -> None:
        """Session-level live state from the device goes to the session's subscribers (not stored)."""

        session_id = payload.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            return
        message: dict[str, Any] | None = None
        if method == "runtime.queue.updated" and isinstance(payload.get("queue"), dict):
            message = {"sessionId": session_id, "queueState": payload["queue"]}
        elif method == "runtime.notice.updated" and isinstance(payload.get("notice"), dict):
            notice = payload["notice"]
            sequence = int(notice.get("updatedSeq") or 0)
            # A v3 device's notice is live state without a session sequence: forwarded as such
            # instead of being dropped for its missing sequence.
            message = (
                {"sessionId": session_id, "notices": [notice], "nextSeq": sequence}
                if sequence > 0
                else {"sessionId": session_id, "liveNotices": [notice]}
            )
        elif method == "runtime.status":
            # v2 planning/goal state events ride in ``RuntimeStatusEvent.status`` as
            # ``{event: <v2 name>, revision, state: <client-shaped state>}``.
            status = payload.get("status")
            status = status if isinstance(status, dict) else {}
            event = status.get("event")
            state = status.get("state")
            if event == "planning.state.updated" and isinstance(state, dict):
                message = {"sessionId": session_id, "planningState": state}
            elif event == "goal.state.updated" and isinstance(state, dict):
                message = {"sessionId": session_id, "goalState": state}
        if message is not None:
            await self._broker.publish(session_id, message)

    # -- takeover -------------------------------------------------------------------
    #
    # Takeover is a Server field the device also needs: its queue only dispatches, and only accepts queue
    # operations, for sessions taken over. A change goes to the device as ``session.sync {sessionId,
    # takeover}``. Until the device confirms it, the session is kept in a pending set (Redis hash
    # ``device-takeover:{deviceId}``, sessionId -> token); when the device links again every pending session
    # is sent again with the takeover the Server holds *then*, so the last change wins.

    def _takeover_key(self, device_id: str) -> str:
        return self._coordinator.key("device-takeover", device_id)

    async def _mark_takeover(self, device_id: str, session_id: str, token: str) -> None:
        if not self._coordinator.distributed:
            self._local_takeover.setdefault(device_id, {})[session_id] = token
            return
        await self._coordinator.client.hset(self._takeover_key(device_id), session_id, token)

    async def _clear_takeover(self, device_id: str, session_id: str, token: str) -> None:
        """Forget a pending change unless a newer one replaced it meanwhile."""

        if not self._coordinator.distributed:
            pending = self._local_takeover.get(device_id, {})
            if pending.get(session_id) == token:
                del pending[session_id]
            return
        key = self._takeover_key(device_id)
        if await self._coordinator.client.hget(key, session_id) == token:
            await self._coordinator.client.hdel(key, session_id)

    async def pending_takeover(self, device_id: str) -> dict[str, str]:
        if not self._coordinator.distributed:
            return dict(self._local_takeover.get(device_id, {}))
        return dict(await self._coordinator.client.hgetall(self._takeover_key(device_id)) or {})

    async def push_takeover(self, device_id: str, session_id: str) -> bool:
        """Send the session's takeover to its v3 device now; True once the device confirmed it.

        Offline or unconfirmed, the change stays pending and goes out when the device links again. Encrypted
        mode registers no ``Commands/sessionSync`` for the Server: clients change it through their channel.
        """

        if self.commands is None or self._e2ee_settings().required:
            return False
        if await self._store.connector_link_contract(device_id) != LINK_CONTRACT:
            return False
        token = secrets.token_urlsafe(8)
        await self._mark_takeover(device_id, session_id, token)
        return await self._send_takeover(device_id, session_id, token)

    async def _send_takeover(self, device_id: str, session_id: str, token: str) -> bool:
        try:
            session = await self._store.get_session(session_id)
        except KeyError:
            session = None
        if session is None or session.connectorId != device_id:
            await self._clear_takeover(device_id, session_id, token)
            return False
        try:
            await self.commands.send(
                user_id=None,
                device_id=device_id,
                kind="session.sync",
                command_id=f"takeover_{secrets.token_urlsafe(12)}",
                payload={"sessionId": session_id, "takeover": bool(session.takeover)},
                session_id=session_id,
                timeout=TAKEOVER_SYNC_TIMEOUT_SECONDS,
            )
        except DeviceCommandRejected as exc:
            # The device refused it (it no longer has the session): nothing left to keep in step.
            logger.info("takeover not applied device_id={} session_id={} code={}", device_id, session_id, exc.code)
            await self._clear_takeover(device_id, session_id, token)
            return False
        except DeviceCommandError:
            return False
        await self._clear_takeover(device_id, session_id, token)
        return True

    async def flush_takeover(self, device_id: str) -> None:
        """The device linked again: send every takeover change it has not confirmed."""

        for session_id, token in (await self.pending_takeover(device_id)).items():
            try:
                await self._send_takeover(device_id, session_id, token)
            except Exception:  # noqa: BLE001 - the rest still go; this one stays pending
                logger.exception("takeover sync failed device_id={} session_id={}", device_id, session_id)

    # -- presence ---------------------------------------------------------------

    async def handle_presence(self, device_id: str, online: bool) -> None:
        if online:
            await self._store.record_connector_activity(device_id)
            if self.commands is not None and not self._e2ee_settings().required:
                task = asyncio.create_task(self.flush_takeover(device_id), name=f"device-takeover-{device_id}")
                self._reconcile_tasks.add(task)
                task.add_done_callback(self._reconcile_tasks.discard)
            if self._usage_recorder is not None:
                from agent_server.services.usage_events import connector_online_event

                connector = await self._connector_or_none(device_id)
                await self._usage_recorder.record(
                    connector_online_event(
                        connector_id=device_id,
                        user_id=None,
                        device_os=connector.deviceOs if connector is not None else None,
                    )
                )
        else:
            self.runtime_status.pop(device_id, None)
        for listener in list(self.presence_listeners):
            try:
                await listener(device_id, online)
            except Exception:  # noqa: BLE001 - listeners never break the link
                logger.exception("device presence listener failed device_id={}", device_id)
        if self.collab is not None:
            self.collab.on_presence(device_id, online)
        if self.session_watch is not None:
            try:
                await self.session_watch.on_presence(device_id, online)
            except Exception:  # noqa: BLE001 - subscriptions recover on the next sweep
                logger.exception("session watch presence update failed device_id={}", device_id)
        if self._capability_refresh is not None:
            self._capability_refresh.request(device_id)
        await publish_dashboard_changed(
            self._store,
            self._broker,
            connector_id=device_id,
            reason="connector.online" if online else "connector.presence",
        )
