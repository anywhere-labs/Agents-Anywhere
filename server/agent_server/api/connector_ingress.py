from __future__ import annotations

from dataclasses import dataclass
import base64
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from loguru import logger
from starlette.requests import HTTPConnection

from agent_server.core.auth import (
    DEFAULT_EXPIRES_IN,
    create_connector_access_token,
    verify_connector_access_token,
)
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.deps import (
    get_attachment_service,
    get_connector_ingest_service,
    get_fs_downloads,
    get_rpc,
    get_shell_tasks,
    get_store,
    get_timeline_broker,
)
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.core.models import (
    ApprovalIn,
    ConnectorAuthResponse,
    ConnectorIngestRequest,
    ConnectorIngestResponse,
    TimelineItemIn,
)
from agent_server.services.attachments import AttachmentService
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.connector_ingest import ConnectorIngestService
from agent_server.services.timeline_effects import close_waiting_approval_items_for_finished_turn
from agent_server.services.shell_tasks import ShellTaskManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.infra.timeline_broker import TimelineBroker


router = APIRouter(tags=["connector-ingress"])


@dataclass
class IngestEffect:
    """What one applied notification wants pushed to SSE subscribers.

    Event-Carried State Transfer: the high-frequency path (timeline.itemUpsert
    during streaming) carries the item payload itself, so the browser applies
    it directly and never calls GET /state. Only bulk/ambiguous changes
    (timeline.sync) set `needs_refetch`, which is rare (turn-end + ~30s sync).
    """

    session_id: str | None = None
    item: dict[str, Any] | None = None
    session_changed: bool = False
    approvals_changed: bool = False
    needs_refetch: bool = False


async def _publish_effects(
    db: Store, timeline_broker: TimelineBroker, effects: list[IngestEffect]
) -> None:
    # Aggregate per session so a batch of N notifications fans out as one
    # envelope per session, carrying every item committed in the batch.
    by_session: dict[str, dict[str, Any]] = {}
    for eff in effects:
        if eff.session_id is None:
            continue
        bucket = by_session.setdefault(
            eff.session_id,
            {"items": [], "session": False, "approvals": False, "refetch": False},
        )
        if eff.item is not None:
            bucket["items"].append(eff.item)
        bucket["session"] = bucket["session"] or eff.session_changed
        bucket["approvals"] = bucket["approvals"] or eff.approvals_changed
        bucket["refetch"] = bucket["refetch"] or eff.needs_refetch

    for session_id, bucket in by_session.items():
        try:
            next_seq = await db.get_session_seq(session_id)
        except KeyError:
            continue
        envelope: dict[str, Any] = {"sessionId": session_id, "nextSeq": next_seq}
        if bucket["refetch"]:
            envelope["refetch"] = True
        if bucket["items"]:
            envelope["items"] = bucket["items"]
        if bucket["session"]:
            try:
                envelope["session"] = (await db.get_session(session_id)).model_dump(mode="json")
            except KeyError:
                pass
        if bucket["approvals"]:
            envelope["approvals"] = [
                a.model_dump(mode="json") for a in await db.list_pending_approvals(session_id)
            ]
        await timeline_broker.publish(session_id, envelope)
        await publish_dashboard_changed(
            db,
            timeline_broker,
            session_id=session_id,
            reason="session.changed",
        )


@router.post("/connector/auth", response_model=ConnectorAuthResponse)
async def connector_auth(
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
) -> ConnectorAuthResponse:
    connector_id, token = _parse_connector_authorization(authorization)
    if not await db.verify_connector_token(connector_id, token):
        raise HTTPException(status_code=401, detail="invalid connector credential")
    return ConnectorAuthResponse(
        accessToken=create_connector_access_token(connector_id),
        expiresIn=DEFAULT_EXPIRES_IN,
    )


def get_terminal_broker(conn: HTTPConnection) -> TerminalBroker:
    return conn.app.state.terminal_broker


@router.post("/connector/ingest", response_model=ConnectorIngestResponse)
async def connector_ingest(
    payload: ConnectorIngestRequest,
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
    ingest_service: ConnectorIngestService = Depends(get_connector_ingest_service),
) -> ConnectorIngestResponse:
    connector_id = _connector_id_from_bearer(authorization)
    await _require_active_connector(connector_id, db)
    return await ingest_service.ingest(connector_id=connector_id, payload=payload)


@router.get("/connector/sessions/{session_id}/attachments/{file_id}/content")
async def connector_attachment_content(
    session_id: str,
    file_id: str,
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
    attachments: AttachmentService = Depends(get_attachment_service),
) -> Response:
    """Connector-side download of a user-uploaded attachment.

    The blob remains in platform storage after connector consumption. Two
    response headers carry metadata the connector needs without spelunking
    through a JSON envelope:

      X-File-Name      original upload filename
      X-File-Sha256    sha256 hex of the bytes in the body
    """
    connector_id = _connector_id_from_bearer(authorization)
    await _require_active_connector(connector_id, db)
    await db.record_connector_activity(connector_id)
    try:
        data, metadata = await attachments.read_connector_attachment(
            session_id=session_id,
            file_id=file_id,
            connector_id=connector_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="file not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return Response(
        content=data,
        media_type=metadata.get("mediaType") or "application/octet-stream",
        headers={
            "X-File-Name": _safe_header_value(metadata.get("name") or file_id),
            "X-File-Sha256": str(metadata.get("sha256") or ""),
        },
    )


@router.put("/connector/fs/transfers/{transfer_id}")
async def connector_fs_transfer_upload(
    transfer_id: str,
    request: Request,
    token: str,
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
    downloads: FsDownloadRelayManager = Depends(get_fs_downloads),
) -> dict[str, str]:
    connector_id = _connector_id_from_bearer(authorization)
    await _require_active_connector(connector_id, db)
    await db.record_connector_activity(connector_id)
    transfer = downloads.get(transfer_id, token)
    if transfer is None or transfer.connector_id != connector_id:
        raise HTTPException(status_code=404, detail="transfer not found")
    accepted = await downloads.upload(
        transfer_id=transfer_id,
        token=token,
        chunks=request.stream(),
    )
    if not accepted:
        raise HTTPException(status_code=404, detail="transfer not found")
    return {"status": "accepted"}


async def _reconcile_active_run_from_timeline(db: Store, session_id: str) -> None:
    if await db.get_open_turn_id(session_id) is None:
        await db.clear_active_run(session_id)


def _safe_header_value(value: str) -> str:
    # HTTP header values must be latin-1; drop anything fancier. The connector
    # already knows the canonical name from its turn.start request — this is
    # only a debug aid.
    return value.encode("latin-1", errors="replace").decode("latin-1")


@router.websocket("/connector/ws")
async def connector_ws(
    websocket: WebSocket,
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    tasks: ShellTaskManager = Depends(get_shell_tasks),
    broker: TerminalBroker = Depends(get_terminal_broker),
    timeline_broker: TimelineBroker = Depends(get_timeline_broker),
) -> None:
    auth_header = websocket.headers.get("authorization")
    connector_id = _connector_id_from_bearer(auth_header)
    if connector_id is None:
        await websocket.close(code=1008)
        return
    try:
        await db.get_connector(connector_id)
    except KeyError:
        await websocket.close(code=1008, reason="invalid connector access token")
        return

    await websocket.accept()
    connection = manager.register(connector_id, websocket)
    await db.set_connector_status(
        connector_id,
        "online",
        device_os=_connector_device_os(websocket.headers.get("x-device-os")),
    )
    await db.record_connector_activity(connector_id)
    await publish_dashboard_changed(
        db,
        timeline_broker,
        connector_id=connector_id,
        reason="connector.online",
    )
    ingest_service = ConnectorIngestService(db, manager, tasks, broker, timeline_broker)
    logger.info("connector connected: {}", connector_id)
    try:
        while True:
            message = await websocket.receive_json()
            if not manager.touch(connector_id, connection):
                break
            await _handle_connector_message(connector_id, message, manager, ingest_service)
    except WebSocketDisconnect:
        logger.info("connector disconnected: {}", connector_id)
    finally:
        removed_terminals = await broker.remove_ephemeral_for_connector(connector_id)
        if removed_terminals:
            logger.info(
                "removed ephemeral terminals after connector websocket ended "
                "connector_id={} count={}",
                connector_id,
                len(removed_terminals),
            )
        if manager.unregister(connector_id, connection):
            await db.set_connector_status(connector_id, "offline")
            await publish_dashboard_changed(
                db,
                timeline_broker,
                connector_id=connector_id,
                reason="connector.offline",
            )


def _connector_device_os(value: str | None) -> str | None:
    normalized = (value or "").strip().lower()
    return normalized if normalized in {"macos", "windows", "linux"} else None


@router.websocket("/connector/terminals/{terminal_id}/relay")
async def connector_terminal_relay_ws(
    websocket: WebSocket,
    terminal_id: str,
    broker: TerminalBroker = Depends(get_terminal_broker),
) -> None:
    token = websocket.query_params.get("token")
    if not isinstance(token, str) or not token:
        await websocket.close(code=1008)
        return
    term = broker.get(terminal_id)
    if term is None:
        await websocket.close(code=1008, reason="terminal not found")
        return
    if term.relay_token != token:
        await websocket.close(code=1008, reason="invalid terminal relay token")
        return

    await websocket.accept()
    if await broker.attach_connector(terminal_id, token, websocket) is None:
        await websocket.close(code=1008, reason="invalid terminal relay token")
        return
    await websocket.send_json(
        {
            "type": "start",
            "terminalId": term.id,
            "sessionId": term.session_id,
            "root": term.root,
            "cwd": term.cwd,
            "shell": term.shell or None,
            "command": term.command,
            "args": term.args,
            "profile": term.profile,
            "cols": term.cols,
            "rows": term.rows,
            "env": term.env,
        }
    )
    try:
        while True:
            message = await websocket.receive_json()
            mtype = message.get("type")
            if mtype == "ready":
                pid = message.get("pid")
                await broker.mark_running(terminal_id, pid=pid if isinstance(pid, int) else None)
            elif mtype == "output":
                data_b64 = message.get("data")
                seq = message.get("seq")
                if isinstance(data_b64, str) and isinstance(seq, int):
                    try:
                        data = base64.b64decode(data_b64)
                    except Exception:
                        data = b""
                    if data:
                        await broker.on_output(terminal_id, data=data, seq=seq)
            elif mtype == "exit":
                exit_code = message.get("exitCode")
                reason = message.get("reason") if isinstance(message.get("reason"), str) else None
                await broker.on_exited(
                    terminal_id,
                    exit_code=exit_code if isinstance(exit_code, int) else None,
                    reason=reason,
                )
                break
    except WebSocketDisconnect:
        pass
    finally:
        broker.detach_connector(terminal_id, websocket)


async def _handle_connector_message(
    connector_id: str,
    message: dict[str, Any],
    manager: ConnectorRpcManager,
    ingest_service: ConnectorIngestService,
) -> None:
    message_type = message.get("type")
    if message_type == "response":
        manager.resolve_response(connector_id, message)
        return
    if message_type != "notification":
        return

    method = message.get("method")
    params = message.get("params") or {}
    if isinstance(method, str) and isinstance(params, dict):
        await ingest_service.handle_notification_message(
            connector_id=connector_id,
            method=method,
            params=params,
        )


class _IngestFilter:
    """Decides whether an incoming daemon notification should be applied.

    Disabled user intent (= user clicked Delete, agent should stay out)
    ripples through three different notification shapes (capabilities,
    session, timeline/approval). Centralizing the check here keeps each
    ingest handler runtime-agnostic and gives us one place to tweak the rule.

    The cache is per-call: a single ingest pass might process a burst of
    notifications and we don't want to re-hit SQL for each. The filter
    lifetime is intentionally short (one `apply_connector_notification`
    invocation), so we don't have to worry about it going stale.
    """

    def __init__(self, db: Store, connector_id: str) -> None:
        self._db = db
        self._connector_id = connector_id
        self._disabled: set[str] | None = None

    async def _ensure_loaded(self) -> set[str]:
        if self._disabled is None:
            state = await self._db.get_device_agents(self._connector_id)
            self._disabled = set(state.get("disabled") or [])
        return self._disabled

    async def runtime_disabled(self, runtime: str | None) -> bool:
        if not isinstance(runtime, str) or not runtime:
            return False
        return runtime in await self._ensure_loaded()

    async def session_disabled(self, session_id: str) -> bool:
        """Treat a missing session row as 'disabled' for filter purposes.

        Timeline / approval notifications for a session that no longer
        exists in DB can only come from one place — the daemon hadn't
        caught up with our Delete cascade yet and kept pushing items.
        Trying to insert them would hit the FK and 500 the ingest. From
        the user's perspective the session is gone, and that's the same
        outcome they'd see if we explicitly filtered by runtime, so we
        coalesce both cases here.
        """
        runtime = await self._db.get_session_runtime(session_id)
        if runtime is None:
            return True
        return await self.runtime_disabled(runtime)


async def apply_connector_notification(
    connector_id: str,
    method: str,
    params: dict[str, Any],
    db: Store,
    tasks: ShellTaskManager | None = None,
    broker: TerminalBroker | None = None,
) -> IngestEffect:
    """Apply one connector notification, returning what to push to SSE.

    The high-frequency path (timeline.itemUpsert) carries the committed item
    so SSE subscribers apply it directly — no GET /state refetch. Errors
    propagate.

    A `_IngestFilter` runs first on the runtime-scoped handlers so any
    notification for a Deleted runtime (or a session that belongs to one)
    gets dropped silently. That guarantees the daemon can never resurrect
    something the user told us to forget, regardless of how its local
    discovery state drifts.
    """
    filter_ = _IngestFilter(db, connector_id)

    if method == "connector.heartbeat":
        await db.record_connector_activity(connector_id)
        return IngestEffect()
    elif method == "connector.preferencesUpdated":
        # Daemon mirror of ~/.claude/settings.json (and any future per-runtime
        # local config). Whatever the daemon sends is stored verbatim; the
        # frontend reads it to pre-select dropdowns. Empty payload clears it.
        try:
            await db.update_connector_preferences(connector_id, dict(params))
        except KeyError:
            logger.warning("preferences update for unknown connector connector_id={}", connector_id)
        return IngestEffect()
    elif method == "connector.capabilitiesUpdated":
        # Daemon-published discovery report. `apply_discovery` stores observed
        # facts and only default-enables runtimes on the first discovery.
        try:
            await db.apply_discovery(connector_id, dict(params))
        except KeyError:
            logger.warning("capabilities update for unknown connector connector_id={}", connector_id)
        return IngestEffect()
    elif method == "session.updated":
        if await filter_.runtime_disabled(params.get("runtime")):
            return IngestEffect()
        local_state = _local_session_state(params)
        session_id = params["sessionId"]
        external_session_id = params.get("externalSessionId")
        try:
            if isinstance(external_session_id, str):
                session_id = await db.resolve_connector_session_id(
                    connector_id=connector_id,
                    session_id=session_id,
                    external_session_id=external_session_id,
                )
            await db.update_session_snapshot(
                session_id=session_id,
                status=params.get("status"),
                title=params.get("title"),
                cwd=params.get("cwd"),
                external_session_id=external_session_id,
                last_synced_at=params.get("lastSyncedAt"),
                source_observed_at=params.get("sourceObservedAt"),
                last_activity_at=params.get("lastActivityAt"),
            )
            await db.refresh_session_status_from_timeline(session_id)
            return IngestEffect(session_id=session_id, session_changed=True)
        except KeyError:
            if local_state in {"archived", "deleted", "unresumable"}:
                logger.info(
                    "ignored local {} session discovery connector_id={} session_id={} external_session_id={}",
                    local_state,
                    connector_id,
                    session_id,
                    external_session_id,
                )
                return IngestEffect()
            session = await db.upsert_connector_session(
                connector_id=connector_id,
                session_id=session_id,
                runtime=params.get("runtime") or "codex",
                external_session_id=external_session_id if isinstance(external_session_id, str) else None,
                title=params.get("title"),
                cwd=params.get("cwd"),
                status=params.get("status"),
                last_synced_at=params.get("lastSyncedAt"),
                source_observed_at=params.get("sourceObservedAt"),
                last_activity_at=params.get("lastActivityAt"),
            )
            await db.refresh_session_status_from_timeline(session.id)
            return IngestEffect(session_id=session.id, session_changed=True)
    elif method == "timeline.sync":
        items = [TimelineItemIn.model_validate(item) for item in params.get("items", [])]
        session_id = await _resolve_timeline_session_id(connector_id, params["sessionId"], items, db)
        if await filter_.session_disabled(session_id):
            return IngestEffect()
        items = [_timeline_item_for_session(item, session_id) for item in items]
        items = await _tag_active_run_user_messages(db, session_id, items)
        if await _should_replace_timeline_snapshot(db, session_id, items):
            await db.replace_timeline_snapshot(
                session_id=session_id,
                source_observed_at=params.get("sourceObservedAt"),
                items=items,
            )
        else:
            await db.replace_timeline(
                session_id=session_id,
                source_observed_at=params.get("sourceObservedAt"),
                items=items,
            )
        if any(item.type == "turn.end" for item in items):
            await _reconcile_active_run_from_timeline(db, session_id)
        # Bulk replace can also remove items — let the client do one /state to
        # reconcile rather than trying to diff a removal over SSE. Low frequency
        # (turn-end snapshot + ~30s periodic sync), so no refetch storm.
        return IngestEffect(session_id=session_id, needs_refetch=True, session_changed=True)
    elif method == "timeline.itemUpsert":
        item = TimelineItemIn.model_validate(params["item"])
        session_id = await _resolve_timeline_session_id(connector_id, params["sessionId"], [item], db)
        if await filter_.session_disabled(session_id):
            return IngestEffect()
        item = _timeline_item_for_session(item, session_id)
        item = (await _tag_active_run_user_messages(db, session_id, [item]))[0]
        stored = await db.upsert_timeline_item(
            session_id=session_id,
            source_observed_at=params.get("sourceObservedAt"),
            item=item,
        )
        if item.type == "turn.start" and item.turnId:
            await db.update_active_run_turn_id(session_id, item.turnId)
        if item.type == "turn.end":
            await close_waiting_approval_items_for_finished_turn(db, session_id, item)
            await db.clear_active_run(session_id)
        # Carry the committed item so the browser appends it directly. turn
        # boundaries also flip session.status, so refresh the session view then.
        return IngestEffect(
            session_id=session_id,
            item=stored.model_dump(mode="json"),
            session_changed=item.type in ("turn.start", "turn.end"),
        )
    elif method == "approval.requested":
        approval = ApprovalIn.model_validate(params)
        session_id = await _resolve_approval_session_id(connector_id, approval, db)
        if await filter_.session_disabled(session_id):
            return IngestEffect()
        approval = _approval_for_session(approval, session_id)
        await db.upsert_approval(approval)
        await db.refresh_session_status_from_timeline(session_id)
        return IngestEffect(
            session_id=session_id, approvals_changed=True, session_changed=True
        )
    elif method == "runtime.error":
        session_id = params.get("sessionId")
        if isinstance(session_id, str):
            await db.set_session_status(session_id, "error")
            return IngestEffect(session_id=session_id, session_changed=True)
        return IngestEffect()
    elif method == "shell.task.started" and tasks is not None:
        task_id = params.get("taskId")
        session_id = params.get("sessionId")
        if isinstance(task_id, str) and isinstance(session_id, str):
            try:
                tasks.mark_running(task_id, session_id=session_id, connector_id=connector_id)
            except KeyError:
                logger.warning(
                    "ignored shell task started from mismatched connector task_id={} connector_id={}",
                    task_id,
                    connector_id,
                )
    elif method == "shell.task.completed" and tasks is not None:
        task_id = params.get("taskId")
        session_id = params.get("sessionId")
        status = params.get("status")
        if isinstance(task_id, str) and isinstance(session_id, str):
            tasks.complete(
                task_id,
                session_id=session_id,
                connector_id=connector_id,
                status=status if status in {"completed", "failed", "cancelled"} else "failed",
                result=params.get("result") if isinstance(params.get("result"), dict) else None,
                error=params.get("error") if isinstance(params.get("error"), dict) else None,
            )
    elif method == "terminal.output" and broker is not None:
        terminal_id = params.get("terminalId")
        data_b64 = params.get("dataBase64")
        seq = params.get("seq")
        if isinstance(terminal_id, str) and isinstance(data_b64, str) and isinstance(seq, int):
            import base64
            try:
                data = base64.b64decode(data_b64)
            except Exception:
                data = b""
            if data:
                await broker.on_output(terminal_id, data=data, seq=seq)
    elif method == "terminal.exited" and broker is not None:
        terminal_id = params.get("terminalId")
        exit_code = params.get("exitCode")
        reason = params.get("reason") if isinstance(params.get("reason"), str) else None
        if isinstance(terminal_id, str):
            await broker.on_exited(
                terminal_id,
                exit_code=exit_code if isinstance(exit_code, int) else None,
                reason=reason,
            )
    # shell.* / terminal.* have their own brokers / task manager; nothing to
    # push down the timeline SSE channel.
    return IngestEffect()


async def _resolve_timeline_session_id(
    connector_id: str,
    session_id: str,
    items: list[TimelineItemIn],
    db: Store,
) -> str:
    external_session_id = next(
        (item.source.sessionId for item in items if item.source.sessionId),
        None,
    )
    try:
        return await db.resolve_connector_session_id(
            connector_id=connector_id,
            session_id=session_id,
            external_session_id=external_session_id,
        )
    except KeyError:
        return session_id


async def _resolve_approval_session_id(
    connector_id: str,
    approval: ApprovalIn,
    db: Store,
) -> str:
    try:
        return await db.resolve_connector_session_id(
            connector_id=connector_id,
            session_id=approval.sessionId,
            external_session_id=approval.source.sessionId,
        )
    except KeyError:
        return approval.sessionId


def _local_session_state(params: dict[str, Any]) -> str:
    value = params.get("localState") or params.get("local_state")
    if isinstance(value, str):
        normalized = value.lower()
        if normalized in {"active", "archived", "deleted", "unresumable", "unknown"}:
            return normalized
    if params.get("localArchived") is True or params.get("local_archived") is True:
        return "archived"
    if params.get("localDeleted") is True or params.get("local_deleted") is True:
        return "deleted"
    if params.get("resumeSupported") is False or params.get("resumable") is False:
        return "unresumable"
    return "active"


def _timeline_item_for_session(item: TimelineItemIn, session_id: str) -> TimelineItemIn:
    if item.sessionId == session_id:
        return item
    return TimelineItemIn.model_validate({**item.model_dump(), "sessionId": session_id})


async def _should_replace_timeline_snapshot(
    db: Store,
    session_id: str,
    items: list[TimelineItemIn],
) -> bool:
    if items:
        return all(item.source.runtime == "claude" for item in items)
    try:
        session = await db.get_session(session_id)
    except KeyError:
        return False
    return session.runtime == "claude"


async def _tag_active_run_user_messages(
    db: Store,
    session_id: str,
    items: list[TimelineItemIn],
) -> list[TimelineItemIn]:
    active = await db.get_active_run(session_id)
    if active is None:
        return items
    params = active.get("params")
    if not isinstance(params, dict):
        return items
    client_message_id = params.get("clientMessageId")
    expected_text = params.get("content")
    attachments = _timeline_attachments_from_active_run(params)
    if not isinstance(client_message_id, str) or not client_message_id:
        return items
    if not isinstance(expected_text, str):
        return items

    tagged: list[TimelineItemIn] = []
    did_tag = False
    for item in items:
        if did_tag or not _active_run_user_message_matches(item, expected_text):
            tagged.append(item)
            continue
        source = item.source.model_dump()
        content = item.content if isinstance(item.content, dict) else {}
        next_source = source
        next_content = content
        changed = False
        if not source.get("clientMessageId"):
            next_source = {**next_source, "clientMessageId": client_message_id}
            changed = True
        if attachments and not _content_has_attachments(content):
            next_content = {**next_content, "attachments": attachments}
            changed = True
        if not changed:
            did_tag = True
            tagged.append(item)
            continue
        tagged.append(
            TimelineItemIn.model_validate(
                {
                    **item.model_dump(),
                    "source": next_source,
                    "content": next_content,
                }
            )
        )
        did_tag = True
    return tagged


def _active_run_user_message_matches(item: TimelineItemIn, expected_text: str) -> bool:
    if item.type != "message" or item.role != "user":
        return False
    content = item.content if isinstance(item.content, dict) else {}
    actual_text = content.get("text")
    if not isinstance(actual_text, str):
        return False
    return _client_message_text_matches(actual_text, expected_text)


def _timeline_attachments_from_active_run(params: dict[str, Any]) -> list[dict[str, Any]]:
    raw = params.get("timelineAttachments")
    if not isinstance(raw, list):
        raw = params.get("attachments")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        file_id = entry.get("fileId")
        if not isinstance(file_id, str) or not file_id:
            continue
        att: dict[str, Any] = {"fileId": file_id}
        for source, target in (
            ("name", "name"),
            ("mediaType", "mediaType"),
            ("size", "size"),
            ("sha256", "sha256"),
        ):
            value = entry.get(source)
            if value is not None and target not in att:
                att[target] = value
        out.append(att)
    return out


def _content_has_attachments(content: dict[str, Any]) -> bool:
    attachments = content.get("attachments")
    return isinstance(attachments, list) and len(attachments) > 0


def _client_message_text_matches(actual: str, expected: str) -> bool:
    if actual == expected:
        return True
    return actual.startswith(expected) and actual[len(expected) :].startswith("\n\n[")


def _approval_for_session(approval: ApprovalIn, session_id: str) -> ApprovalIn:
    if approval.sessionId == session_id:
        return approval
    return ApprovalIn.model_validate({**approval.model_dump(), "sessionId": session_id})


def _parse_connector_authorization(authorization: str) -> tuple[str, str]:
    prefix = "Connector "
    if not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="expected Connector authorization")
    credential = authorization[len(prefix) :]
    if ":" not in credential:
        raise HTTPException(status_code=401, detail="invalid connector credential format")
    connector_id, token = credential.split(":", 1)
    return connector_id, token


def _connector_id_from_bearer(authorization: str | None) -> str | None:
    prefix = "Bearer "
    if authorization is None or not authorization.startswith(prefix):
        return None
    return verify_connector_access_token(authorization[len(prefix) :])


async def _require_active_connector(connector_id: str | None, db: Store) -> str:
    if connector_id is None:
        raise HTTPException(status_code=401, detail="invalid connector access token")
    try:
        await db.get_connector(connector_id)
    except KeyError:
        raise HTTPException(status_code=401, detail="invalid connector access token") from None
    return connector_id
