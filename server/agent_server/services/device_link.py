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
from datetime import UTC, datetime
from typing import Any

from loguru import logger
from pydantic import ValidationError

from agent_server.core.device_meshcall import (
    DEVICE_MESHCALL_VERSION,
    MESH_MAX_FRAME_BYTES,
    AttachmentConsumedOut,
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
)
from agent_server.infra.device_link import DeviceLinkHub
from agent_server.infra.device_mesh import (
    DEVICE_SERVICES,
    E2EE_DEVICE_SERVICES,
    DeviceCallError,
    DeviceMesh,
    MeshNotConfigured,
)
from agent_server.services.dashboard_events import publish_dashboard_changed

LINK_CONTRACT = f"device-meshcall/{DEVICE_MESHCALL_VERSION}"
REQUIRED_SERVICES = frozenset({"aa.device.v1.Link", "aa.device.v1.Commands"})
DEFERRABLE_COMMANDS = frozenset({"device.settings.apply", "runtime.apply", "channel.switch"})
_SERVER_VERSION = "3.0.0-dev"


class DeviceLinkError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def e2ee_mode() -> str:
    import os

    return "required" if os.environ.get("AGENT_SERVER_E2EE", "off").strip().lower() == "required" else "off"


def _iso_from_ms(value: int) -> str:
    return datetime.fromtimestamp(value / 1000, UTC).isoformat()


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
    ) -> None:
        self._store = store
        self._mesh = mesh
        self._hub = hub
        self._coordinator = coordinator
        self._broker = broker
        self._capability_refresh = capability_refresh
        self._usage_recorder = usage_recorder
        self._local_records: dict[str, dict[str, Any]] = {}
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
        mode = e2ee_mode()
        services = E2EE_DEVICE_SERVICES if mode == "required" else DEVICE_SERVICES
        try:
            token = await self._mesh.issue_device_token(device_id, services)
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
        floors = await self._store.device_seq_floors(
            device_id, {head.sessionId: head.headSeq for head in hello.sessionsHead}
        )
        pending = [
            PendingCommand(
                commandId=row["commandId"],
                deadline=row["expiresAt"],
                inputDigest=row["inputDigest"],
                p=row["payload"] or {},
                m=row["kind"],
            )
            for row in await self._store.unsettled_device_commands(device_id)
            # Only commands that may be delivered late (03-architecture §3.10); a user message
            # whose outcome is unknown is never re-sent, it converges through Commands/status.
            if row["kind"] in DEFERRABLE_COMMANDS
        ]
        desired = DesiredState(
            runtimes=await self._desired_runtimes(device_id),
            deviceSettings=await self._store.get_connector_device_settings(device_id),
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
        return [
            {key: row.get(key) for key in ("runtimeId", "runtimeType", "name", "active", "config") if key in row}
            for row in rows
        ]

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
        """Credentials revoked or device deleted: revoke its Router token and drop the link."""

        record = await self.link_record(device_id)
        if record and record.get("tokenId"):
            await self._mesh.revoke_token(str(record["tokenId"]))
        await self._hub.drop(device_id, reason)

    # -- outbox -----------------------------------------------------------------

    async def handle_outbox(self, device_id: str, item: OutboxItem) -> None:
        """Process one outbox message idempotently (by natural key); raising makes the device resend."""

        try:
            if item.m == "session.summary":
                await self._apply_summary(device_id, SessionSummaryOut.model_validate(item.p).summary)
            elif item.m == "session.inventory":
                inventory = SessionInventoryOut.model_validate(item.p)
                for summary in inventory.sessions:
                    await self._apply_summary(device_id, summary)
            elif item.m == "command.result":
                result = CommandResultOut.model_validate(item.p)
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
                UsageReportOut.model_validate(item.p)
                # Usage counters are platform statistics; recorded by the usage service when wired.
            else:
                logger.warning("unknown outbox message device_id={} m={} oid={}", device_id, item.m, item.oid)
        except ValidationError as exc:
            # A malformed message would be resent forever; acknowledge it and log loudly.
            logger.error("dropping invalid outbox message device_id={} m={} error={}", device_id, item.m, exc)

    async def _apply_summary(self, device_id: str, summary: SessionSummary) -> None:
        display = summary.displayDevice.payload if summary.displayDevice.mode == "plain" else {}
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
            )
        except Exception as exc:  # noqa: BLE001 - e.g. no project for this workspace yet
            logger.info(
                "device session not placed device_id={} session_id={} reason={!r}",
                device_id,
                summary.sessionId,
                exc,
            )
            return
        changed = await self._store.apply_device_session_summary(session.id, summary)
        if summary.sourceAvailability != "available":
            await self._store.update_session_source_state(
                session.id,
                availability=summary.sourceAvailability,
                reason=None,
                observed_at=None,
                observation_origin="device",
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
            message = {"sessionId": session_id, "notices": [notice], "nextSeq": int(notice.get("updatedSeq") or 0)}
        elif method == "runtime.status":
            # A's #674: v2 planning/goal state events ride in runtime.status as {event: <v2 name>}.
            event = payload.get("event")
            if event == "planning.state.updated" and isinstance(payload.get("state"), dict):
                message = {"sessionId": session_id, "planningState": payload["state"]}
            elif event == "goal.state.updated" and isinstance(payload.get("state"), dict):
                message = {"sessionId": session_id, "goalState": payload["state"]}
        if message is not None:
            await self._broker.publish(session_id, message)

    # -- presence ---------------------------------------------------------------

    async def handle_presence(self, device_id: str, online: bool) -> None:
        if online:
            await self._store.record_connector_activity(device_id)
            if self._usage_recorder is not None:
                from agent_server.services.usage_events import connector_online_event

                await self._usage_recorder.record(
                    connector_online_event(connector_id=device_id, user_id=None, device_os=None)
                )
        else:
            self.runtime_status.pop(device_id, None)
        for listener in list(self.presence_listeners):
            try:
                await listener(device_id, online)
            except Exception:  # noqa: BLE001 - listeners never break the link
                logger.exception("device presence listener failed device_id={}", device_id)
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
