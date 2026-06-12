from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
import hashlib
import json
import time
from typing import Any

from loguru import logger

from connector.attachments import attachment_target
from connector.codex.reducer import CODEX_APPROVAL_METHODS, ReductionResult, TimelineReducer
from connector.codex.rpc import JsonRpcStdioClient
from connector.sync_state import SyncStateStore
from connector.time import utc_now


AttachmentDownloader = Callable[[str, str], Awaitable[tuple[bytes, str, str]]]
"""(session_id, file_id) -> (data, original_name, media_type)"""

EXISTING_SYNC_SCAN_TIMEOUT_SECONDS = 1200.0
EXISTING_SYNC_CHANGED_THREAD_TIMEOUT_SECONDS = 1200.0


def _thread_id_from_result(value: dict[str, Any]) -> str | None:
    thread = value.get("thread") if isinstance(value.get("thread"), dict) else value
    if not isinstance(thread, dict):
        return None
    for key in ("id", "thread_id", "threadId"):
        if isinstance(thread.get(key), str):
            return thread[key]
    nested = thread.get("thread")
    if isinstance(nested, dict) and isinstance(nested.get("id"), str):
        return nested["id"]
    return None


def _timeline_attachments(params: dict[str, Any]) -> list[dict[str, Any]]:
    raw = params.get("timelineAttachments")
    if not isinstance(raw, list):
        raw = params.get("attachments")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        file_id = entry.get("fileId") or entry.get("id")
        if not isinstance(file_id, str) or not file_id:
            continue
        item: dict[str, Any] = {"fileId": file_id}
        for key in ("name", "mediaType", "size", "sha256"):
            value = entry.get(key)
            if value is not None:
                item[key] = value
        out.append(item)
    return out


def _turn_id_from_result(value: dict[str, Any]) -> str | None:
    turn = value.get("turn") if isinstance(value.get("turn"), dict) else value
    if not isinstance(turn, dict):
        return None
    for key in ("id", "turn_id", "turnId"):
        if isinstance(turn.get(key), str):
            return turn[key]
    nested = turn.get("turn")
    if isinstance(nested, dict) and isinstance(nested.get("id"), str):
        return nested["id"]
    return None


@dataclass(slots=True)
class CodexAdapter:
    """Adapter around Codex app-server.

    The adapter does not talk to the backend directly. It returns normalized
    notification payloads so the connector runtime can forward them over its
    backend WebSocket.
    """

    rpc: JsonRpcStdioClient | None = None
    reducer: TimelineReducer | None = None
    notification_sink: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None
    attachment_downloader: AttachmentDownloader | None = None
    sync_state_store: SyncStateStore | None = None
    _started: bool = False
    _loaded_thread_ids: set[str] = field(default_factory=set)
    _history_sync_tasks: dict[str, asyncio.Task[None]] = field(default_factory=dict)
    _existing_thread_sync_markers: dict[str, str] = field(default_factory=dict)
    _existing_thread_names: dict[str, str | None] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.rpc is None:
            self.rpc = JsonRpcStdioClient()
        if self.reducer is None:
            self.reducer = TimelineReducer()

    def forget_sync_state(self) -> None:
        """Drop the in-memory "I already told the backend about thread X"
        markers so the next `sync_existing_sessions` re-ingests everything.

        Called when the server-side runtime entry has been removed
        (DELETE /runtime-capabilities/{runtime}). Without this, the
        adapter would keep skipping threads it had already pushed in a
        previous lifetime, even though the backend SQL no longer has them.
        """
        self._existing_thread_sync_markers.clear()
        self._existing_thread_names.clear()

    def forget_persisted_sync_state(self, connector_id: str) -> None:
        self.forget_sync_state()
        if self.sync_state_store is not None:
            self.sync_state_store.delete_runtime("codex", connector_id)

    async def start(self) -> None:
        assert self.rpc is not None
        await self.rpc.start(self.handle_notification)
        if self._started:
            return
        await self._best_effort_bootstrap_reads()
        self._started = True

    async def create_session(self, params: dict[str, Any]) -> dict[str, Any]:
        await self.start()
        assert self.rpc is not None
        assert self.reducer is not None
        result = await self.rpc.request(
            "thread/start",
            {
                "cwd": params.get("cwd"),
                "model": params.get("model"),
                "approvalPolicy": params.get("approvalPolicy"),
                "sandbox": _sandbox_mode(params.get("sandbox")),
                "ephemeral": params.get("ephemeral", False),
            },
        )
        thread_id = _thread_id_from_result(result)
        if thread_id is None:
            raise RuntimeError(f"Codex thread/start did not return a thread id: {json.dumps(result, ensure_ascii=False)}")
        self._loaded_thread_ids.add(thread_id)
        session_id = params.get("sessionId")
        connector_id = params.get("connectorId")
        if not isinstance(session_id, str) and isinstance(connector_id, str):
            session_id = stable_session_id(connector_id, thread_id)
        if isinstance(session_id, str):
            self.reducer.bind_session(session_id, thread_id)
        return {
            "sessionId": session_id,
            "externalSessionId": thread_id,
            "thread": result.get("thread") or result,
            "backendNotifications": [
                {
                    "method": "session.updated",
                    "params": {
                        "sessionId": session_id,
                        "runtime": "codex",
                        "externalSessionId": thread_id,
                        "status": "idle",
                        "cwd": params.get("cwd"),
                    },
                }
            ]
            if isinstance(session_id, str)
            else [],
        }

    async def sync_session(self, params: dict[str, Any]) -> dict[str, Any]:
        await self.start()
        assert self.rpc is not None
        assert self.reducer is not None
        session_id = _required_string(params, "sessionId")
        thread_id = _required_string(params, "externalSessionId")
        self.reducer.bind_session(session_id, thread_id)
        started = time.perf_counter()
        logger.info("codex session sync started session_id={} thread_id={}", session_id, thread_id)
        await self._ensure_thread_loaded(thread_id, force=True)
        reduced, thread = await self._reduce_current_timeline(session_id, thread_id)
        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.info(
            "codex session sync completed session_id={} thread_id={} timeline_items={} approvals={} elapsed_ms={:.1f}",
            session_id,
            thread_id,
            len(reduced.timeline_items),
            len(reduced.approvals),
            elapsed_ms,
        )
        return {
            "thread": thread,
            "backendNotifications": _backend_notifications_from_reduction(reduced, timeline_method="timeline.sync"),
        }

    async def sync_existing_sessions(
        self,
        connector_id: str,
        *,
        limit: int = 100,
        force: bool = False,
        notification_sink: Callable[[list[dict[str, Any]]], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        await self.start()
        assert self.rpc is not None
        assert self.reducer is not None

        list_result = await asyncio.wait_for(
            self.rpc.request("thread/list", {"limit": limit, "sortKey": "updated_at"}),
            timeout=EXISTING_SYNC_SCAN_TIMEOUT_SECONDS,
        )
        thread_refs = _thread_refs_from_list_result(list_result)
        notifications: list[dict[str, Any]] = []
        synced_threads: list[str] = []
        skipped_threads: list[str] = []
        notification_count = 0
        started = time.perf_counter()
        logger.info(
            "codex existing thread sync started connector_id={} threads={} force={}",
            connector_id,
            len(thread_refs),
            force,
        )
        for thread_ref in thread_refs:
            thread_id = _thread_id_from_result(thread_ref)
            if not thread_id:
                continue
            local_state = _local_thread_state(thread_ref)
            if local_state in {"archived", "deleted", "unresumable"}:
                logger.info(
                    "codex skipping local {} thread thread_id={}",
                    local_state,
                    thread_id,
                )
                skipped_threads.append(thread_id)
                continue
            sync_marker = _thread_sync_marker(thread_ref)
            current_name = _optional_string(thread_ref.get("name"))
            persisted_state = (
                self.sync_state_store.get("codex", connector_id, thread_id)
                if self.sync_state_store is not None
                else None
            )
            previous_marker = self._existing_thread_sync_markers.get(thread_id)
            if previous_marker is None and persisted_state is not None:
                previous_marker = _optional_string((persisted_state.fingerprint or {}).get("marker"))
                if previous_marker is not None:
                    self._existing_thread_sync_markers[thread_id] = previous_marker
                previous_name = _optional_string((persisted_state.metadata or {}).get("name"))
                if previous_name is not None:
                    self._existing_thread_names[thread_id] = previous_name
            if not force and sync_marker is not None and previous_marker == sync_marker:
                # Codex may rename a thread without bumping updatedAt — diff
                # the name independently and push a title-only update.
                if self._existing_thread_names.get(thread_id) != current_name:
                    session_id = stable_session_id(connector_id, thread_id)
                    rename_notification = {
                        "method": "session.updated",
                        "params": {
                            "sessionId": session_id,
                            "title": current_name,
                            "sourceObservedAt": utc_now(),
                        },
                    }
                    notification_count += 1
                    if notification_sink is not None:
                        await notification_sink([rename_notification])
                    else:
                        notifications.append(rename_notification)
                    self._existing_thread_names[thread_id] = current_name
                    self._persist_sync_state(connector_id, thread_id, sync_marker, current_name)
                skipped_threads.append(thread_id)
                continue
            session_id = stable_session_id(connector_id, thread_id)
            self.reducer.bind_session(session_id, thread_id)
            try:
                reduced, _thread = await asyncio.wait_for(
                    self._sync_changed_existing_thread(
                        session_id,
                        thread_id,
                        thread_ref=thread_ref,
                    ),
                    timeout=EXISTING_SYNC_CHANGED_THREAD_TIMEOUT_SECONDS,
                )
            except TimeoutError:
                logger.warning(
                    "codex existing thread sync timed out thread_id={} timeout_s={}",
                    thread_id,
                    EXISTING_SYNC_CHANGED_THREAD_TIMEOUT_SECONDS,
                )
                continue
            except Exception as exc:
                reason = _unresumable_thread_failure_reason(str(exc))
                if reason is not None:
                    logger.info(
                        "codex skipping {} thread thread_id={} error={}",
                        reason,
                        thread_id,
                        exc,
                    )
                    skipped_threads.append(thread_id)
                    if sync_marker is not None:
                        self._existing_thread_sync_markers[thread_id] = sync_marker
                    continue
                logger.warning("codex existing thread sync failed thread_id={} error={}", thread_id, exc)
                continue
            if _is_imported_external_thread(reduced.timeline_items):
                logger.info(
                    "codex skipping imported external thread thread_id={} items={}",
                    thread_id,
                    len(reduced.timeline_items),
                )
                skipped_threads.append(thread_id)
                if sync_marker is not None:
                    self._existing_thread_sync_markers[thread_id] = sync_marker
                    self._persist_sync_state(connector_id, thread_id, sync_marker, current_name)
                continue
            if reduced.session_update is not None:
                reduced.session_update["runtime"] = "codex"
                last_activity_at = _codex_time(thread_ref.get("updatedAt") or thread_ref.get("updated_at"))
                if last_activity_at is not None:
                    reduced.session_update["lastActivityAt"] = last_activity_at
            thread_notifications = _backend_notifications_from_reduction(reduced, timeline_method="timeline.sync")
            notification_count += len(thread_notifications)
            if notification_sink is not None:
                await notification_sink(thread_notifications)
            else:
                notifications.extend(thread_notifications)
            if sync_marker is not None:
                self._existing_thread_sync_markers[thread_id] = sync_marker
            self._existing_thread_names[thread_id] = current_name
            self._persist_sync_state(connector_id, thread_id, sync_marker, current_name)
            synced_threads.append(thread_id)

        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.info(
            "codex existing thread sync completed connector_id={} synced_threads={} skipped_threads={} notifications={} elapsed_ms={:.1f}",
            connector_id,
            len(synced_threads),
            len(skipped_threads),
            notification_count,
            elapsed_ms,
        )
        return {
            "threads": synced_threads,
            "skippedThreads": skipped_threads,
            "backendNotifications": notifications,
        }

    def _persist_sync_state(
        self,
        connector_id: str,
        thread_id: str,
        sync_marker: str | None,
        current_name: str | None,
    ) -> None:
        if self.sync_state_store is None or sync_marker is None:
            return
        self.sync_state_store.set(
            "codex",
            connector_id,
            thread_id,
            fingerprint={"marker": sync_marker},
            metadata={"name": current_name},
        )

    async def _sync_changed_existing_thread(
        self,
        session_id: str,
        thread_id: str,
        *,
        thread_ref: dict[str, Any],
    ) -> tuple[ReductionResult, dict[str, Any] | None]:
        await self._ensure_thread_loaded(thread_id)
        return await self._reduce_current_timeline(
            session_id,
            thread_id,
            thread_ref=thread_ref,
        )

    async def start_turn(self, params: dict[str, Any]) -> dict[str, Any]:
        await self.start()
        assert self.rpc is not None
        assert self.reducer is not None
        session_id = _required_string(params, "sessionId")
        thread_id = _optional_string(params.get("externalSessionId")) or self.reducer.thread_for_session(session_id)
        if thread_id is None:
            raise ValueError("externalSessionId is required before starting a Codex turn")
        content = _required_string(params, "content")
        self.reducer.bind_session(session_id, thread_id)
        backend_notifications: list[dict[str, Any]] = []
        try:
            await self._ensure_thread_loaded(thread_id)
        except RuntimeError as exc:
            if _unresumable_thread_failure_reason(str(exc)) != "deleted":
                raise
            logger.warning(
                "codex thread rollout missing; creating replacement thread session_id={} old_thread_id={} error={}",
                session_id,
                thread_id,
                exc,
            )
            replacement = await self._create_replacement_thread(params)
            thread_id = replacement["externalSessionId"]
            self.reducer.bind_session(session_id, thread_id)
            backend_notifications = replacement["backendNotifications"]
            for notification in backend_notifications:
                if notification.get("method") == "session.updated":
                    notification.get("params", {}).pop("status", None)
            for notification in backend_notifications:
                if self.notification_sink is not None:
                    await self.notification_sink(notification["method"], notification["params"])

        attachments = params.get("attachments") or []
        cwd = _optional_string(params.get("cwd"))
        text_content, extra_inputs = await self._materialize_attachments(
            content, attachments, cwd, session_id
        )

        input_items: list[dict[str, Any]] = [
            {"type": "text", "text": text_content, "text_elements": []},
            *extra_inputs,
        ]
        client_message_id = _optional_string(params.get("clientMessageId"))
        timeline_attachments = _timeline_attachments(params)
        if client_message_id:
            self.reducer.register_client_message(
                session_id=session_id,
                thread_id=thread_id,
                client_message_id=client_message_id,
                text=text_content,
                attachments=timeline_attachments,
            )
        result = await self.rpc.request(
            "turn/start",
            {
                "threadId": thread_id,
                "input": input_items,
                "approvalPolicy": params.get("approvalPolicy"),
                "sandboxPolicy": params.get("sandboxPolicy"),
                "model": params.get("model"),
                "effort": params.get("effort"),
                "approvalsReviewer": params.get("approvalsReviewer"),
            },
        )
        turn_id = _turn_id_from_result(result)
        if client_message_id and turn_id:
            self.reducer.register_client_message(
                session_id=session_id,
                thread_id=thread_id,
                turn_id=turn_id,
                client_message_id=client_message_id,
                text=text_content,
                attachments=timeline_attachments,
            )
        logger.info(
            "codex turn started session_id={} thread_id={} turn_id={} input_chars={} attachments={}",
            session_id,
            thread_id,
            turn_id,
            len(text_content),
            len(attachments),
        )
        return {
            "turnId": turn_id,
            "turn": result.get("turn") or result,
            "externalSessionId": thread_id,
            "backendNotifications": backend_notifications,
        }

    async def _materialize_attachments(
        self,
        content: str,
        attachments: list[Any],
        cwd: str | None,
        session_id: str,
    ) -> tuple[str, list[dict[str, Any]]]:
        """Download each attachment to the connector user attachment dir and translate
        into codex `UserInput` items.

        Codex's `turn/start` `input` array supports text / image / localImage /
        skill / mention — there is no generic file input. So:

          * image/* attachments → `localImage` input item
          * everything else     → mention appended to the leading text item so
            the model can inspect the materialized local path later.
        """
        if not attachments:
            return content, []
        if self.attachment_downloader is None:
            logger.warning("dropping {} attachments — no downloader is wired", len(attachments))
            return content, []

        text = content
        items: list[dict[str, Any]] = []
        for att in attachments:
            file_id = _attachment_file_id(att)
            if file_id is None:
                continue
            try:
                data, original_name, media_type = await self.attachment_downloader(
                    session_id, file_id
                )
            except Exception as exc:
                logger.exception("attachment download failed file_id={}", file_id)
                text += f"\n\n[Failed to load attachment {file_id}: {exc}]"
                continue
            target = attachment_target(session_id, file_id, original_name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            try:
                target.chmod(0o600)
            except OSError:
                pass

            if media_type.startswith("image/"):
                items.append({"type": "localImage", "path": str(target)})
            else:
                # Path-mention fallback: tell the model the file is sitting at
                # this absolute path and let it call fs.readText if curious.
                text += (
                    f"\n\n[Attached file: {original_name} ({media_type or 'unknown type'},"
                    f" {len(data)} bytes) at {target}]"
                )
        return text, items

    async def interrupt_turn(self, params: dict[str, Any]) -> dict[str, Any]:
        await self.start()
        assert self.rpc is not None
        assert self.reducer is not None
        session_id = _optional_string(params.get("sessionId"))
        thread_id = _optional_string(params.get("externalSessionId"))
        if thread_id is None and session_id is not None:
            thread_id = self.reducer.thread_for_session(session_id)
        if thread_id is None:
            raise ValueError("externalSessionId is required before interrupting a Codex turn")
        turn_id = _required_string(params, "turnId")
        try:
            result = await self.rpc.request("turn/interrupt", {"threadId": thread_id, "turnId": turn_id})
        except RuntimeError as exc:
            reason = _soft_interrupt_failure_reason(str(exc))
            if reason is None:
                raise
            logger.info(
                "codex interrupt treated as already finished thread_id={} turn_id={} reason={}",
                thread_id,
                turn_id,
                reason,
            )
            return {"interrupted": False, "reason": reason}
        return {"interrupted": True, **result}

    async def resolve_approval(self, params: dict[str, Any]) -> dict[str, Any]:
        await self.start()
        assert self.rpc is not None
        request_id = params.get("requestId")
        if request_id is None:
            raise ValueError("requestId is required to resolve a Codex approval")
        decision = _approval_decision(params.get("status"))
        await self.rpc.respond(request_id, {"decision": decision})
        logger.info(
            "codex approval resolved request_id={} approval_id={} status={} decision={}",
            request_id,
            params.get("approvalId"),
            params.get("status"),
            decision,
        )
        return {"resolved": True}

    async def handle_notification(self, message: dict[str, Any]) -> None:
        assert self.reducer is not None
        reduced = self.reducer.reduce_notification(message)
        self._schedule_history_sync_after_turn_completion(message)
        if message.get("method") == "turn/completed":
            session_id = _session_id_from_reduction(reduced)
            thread_id = _thread_id_from_turn_message(message)
            logger.info(
                "codex turn completed session_id={} thread_id={} timeline_items={} approvals={}",
                session_id,
                thread_id,
                len(reduced.timeline_items),
                len(reduced.approvals),
            )
        elif message.get("method") == "item/completed":
            completed_item = _completed_item_from_message(message)
            if completed_item is not None and completed_item.get("type") in {"agentMessage", "userMessage"}:
                session_id = _session_id_from_reduction(reduced)
                thread_id = _thread_id_from_turn_message(message)
                logger.info(
                    "codex message completed session_id={} thread_id={} item_id={} item_type={}",
                    session_id,
                    thread_id,
                    completed_item.get("id"),
                    completed_item.get("type"),
                )
        for notification in _backend_notifications_from_reduction(reduced, timeline_method="timeline.itemUpsert"):
            if self.notification_sink is not None:
                await self.notification_sink(notification["method"], notification["params"])

    def reduce_notification_for_test(self, message: dict[str, Any]) -> ReductionResult:
        assert self.reducer is not None
        return self.reducer.reduce_notification(message)

    async def _resume_thread(self, thread_id: str) -> None:
        assert self.rpc is not None
        await self.rpc.request("thread/resume", {"threadId": thread_id})

    async def _ensure_thread_loaded(self, thread_id: str, *, force: bool = False) -> None:
        if not force and thread_id in self._loaded_thread_ids:
            return
        await self._resume_thread(thread_id)
        self._loaded_thread_ids.add(thread_id)

    async def _create_replacement_thread(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.create_session(
            {
                "sessionId": _required_string(params, "sessionId"),
                "cwd": params.get("cwd"),
                "model": params.get("model"),
                "approvalPolicy": params.get("approvalPolicy"),
                "sandbox": params.get("sandboxPolicy"),
                "ephemeral": params.get("ephemeral", False),
            }
        )

    async def _best_effort_bootstrap_reads(self) -> None:
        assert self.rpc is not None
        for method, params in (
            ("account/read", None),
            ("model/list", None),
            ("thread/loaded/list", None),
        ):
            try:
                await self.rpc.request(method, params)
            except Exception as exc:  # pragma: no cover - defensive against version drift
                logger.debug("codex bootstrap read failed method={} error={}", method, exc)

    async def _reduce_current_timeline(
        self,
        session_id: str,
        thread_id: str,
        *,
        thread_ref: dict[str, Any] | None = None,
    ) -> tuple[ReductionResult, dict[str, Any]]:
        assert self.rpc is not None
        assert self.reducer is not None
        snapshot_result = await self.rpc.request("thread/read", {"threadId": thread_id, "includeTurns": True})
        thread = snapshot_result.get("thread") if isinstance(snapshot_result.get("thread"), dict) else snapshot_result
        if not isinstance(thread, dict):
            thread = {}
        return self.reducer.reduce_thread_snapshot(
            session_id,
            thread,
            fallback_thread_id=thread_id,
        ), thread

    def _schedule_history_sync_after_turn_completion(self, message: dict[str, Any]) -> None:
        if message.get("method") != "turn/completed":
            return
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        thread_id = _optional_string(params.get("threadId")) or _nested_string(params, "thread", "id")
        if thread_id is None:
            return
        session_id = _optional_string(params.get("platformSessionId"))
        if session_id is None and self.reducer is not None:
            session_id = self.reducer.session_for_thread(thread_id)
        if session_id is None:
            return
        old_task = self._history_sync_tasks.get(thread_id)
        if old_task is not None and not old_task.done():
            old_task.cancel()
        self._history_sync_tasks[thread_id] = asyncio.create_task(self._delayed_push_thread_snapshot(session_id, thread_id))

    async def _delayed_push_thread_snapshot(self, session_id: str, thread_id: str) -> None:
        try:
            await asyncio.sleep(0.5)
            reduced, _thread = await self._reduce_current_timeline(session_id, thread_id)
            if not reduced.timeline_items:
                return
            notification_count = 0
            for notification in _backend_notifications_from_reduction(reduced, timeline_method="timeline.sync"):
                notification_count += 1
                if self.notification_sink is not None:
                    await self.notification_sink(notification["method"], notification["params"])
            logger.info(
                "codex turn snapshot synced session_id={} thread_id={} timeline_items={} notifications={}",
                session_id,
                thread_id,
                len(reduced.timeline_items),
                notification_count,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("codex delayed thread snapshot sync failed thread_id={}", thread_id)


def _backend_notifications_from_reduction(
    reduced: ReductionResult,
    *,
    timeline_method: str = "timeline.sync",
) -> list[dict[str, Any]]:
    notifications: list[dict[str, Any]] = []
    if reduced.session_update:
        notifications.append({"method": "session.updated", "params": reduced.session_update})
    if reduced.timeline_items:
        session_id = reduced.timeline_items[0]["sessionId"]
        if timeline_method == "timeline.itemUpsert":
            for item in reduced.timeline_items:
                notifications.append({"method": timeline_method, "params": {"sessionId": session_id, "item": item}})
        else:
            notifications.append({"method": timeline_method, "params": {"sessionId": session_id, "items": reduced.timeline_items}})
    for approval in reduced.approvals:
        notifications.append({"method": "approval.requested", "params": approval})
    return notifications


def _session_id_from_reduction(reduced: ReductionResult) -> str | None:
    if reduced.timeline_items:
        value = reduced.timeline_items[0].get("sessionId")
        return value if isinstance(value, str) else None
    if reduced.session_update:
        value = reduced.session_update.get("sessionId")
        return value if isinstance(value, str) else None
    if reduced.approvals:
        value = reduced.approvals[0].get("sessionId")
        return value if isinstance(value, str) else None
    return None


def _thread_id_from_turn_message(message: dict[str, Any]) -> str | None:
    params = message.get("params") if isinstance(message.get("params"), dict) else {}
    return _optional_string(params.get("threadId")) or _nested_string(params, "thread", "id")


def _completed_item_from_message(message: dict[str, Any]) -> dict[str, Any] | None:
    params = message.get("params") if isinstance(message.get("params"), dict) else {}
    item = params.get("item")
    return item if isinstance(item, dict) else None


def stable_session_id(connector_id: str, thread_id: str) -> str:
    digest = hashlib.sha256(f"{connector_id}:codex:{thread_id}".encode("utf-8")).hexdigest()[:24]
    return f"sess_codex_{digest}"


# Token only emitted by Claude Code when its transcript is serialised into a
# Codex thread; never appears in native Codex output.
_EXTERNAL_AGENT_TOOL_CALL_MARKER = "[external_agent_tool_call:"


def _is_imported_external_thread(timeline_items: list[dict[str, Any]]) -> bool:
    for item in timeline_items:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "message":
            continue
        if item.get("role") != "assistant":
            continue
        content = item.get("content")
        if not isinstance(content, dict):
            continue
        text = content.get("text")
        if isinstance(text, str) and _EXTERNAL_AGENT_TOOL_CALL_MARKER in text:
            return True
    return False


def _thread_sync_marker(thread_ref: dict[str, Any]) -> str | None:
    updated_at = thread_ref.get("updatedAt") or thread_ref.get("updated_at")
    if updated_at is not None:
        return f"updated:{_codex_time(updated_at) or str(updated_at)}"
    try:
        encoded = json.dumps(thread_ref, ensure_ascii=False, sort_keys=True, default=str)
    except TypeError:
        return None
    return f"ref:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


def _thread_refs_from_list_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("threads", "data", "items"):
        value = result.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    nested = result.get("thread")
    if isinstance(nested, dict):
        return [nested]
    if _thread_id_from_result(result):
        return [result]
    logger.debug("codex thread/list returned no recognizable thread list: {}", json.dumps(result, ensure_ascii=False))
    return []


def _local_thread_state(thread_ref: dict[str, Any]) -> str:
    """Best-effort local thread state from Codex list metadata.

    Codex app-server is versioned independently, so keep this deliberately
    tolerant: if any common archived/deleted flag is present we treat the
    thread as not resumable and never publish it to the backend.
    """
    for key in ("localState", "local_state", "lifecycleState", "lifecycle_state"):
        value = thread_ref.get(key)
        if isinstance(value, str):
            normalized = value.lower()
            if normalized in {"active", "archived", "deleted", "unresumable", "unknown"}:
                return normalized
    status = thread_ref.get("status")
    if isinstance(status, dict):
        status = status.get("type") or status.get("state")
    if isinstance(status, str):
        normalized_status = status.lower()
        if normalized_status in {"archived", "deleted", "unresumable"}:
            return normalized_status
    for key in ("archived", "isArchived", "is_archived"):
        if thread_ref.get(key) is True:
            return "archived"
    for key in ("deleted", "isDeleted", "is_deleted"):
        if thread_ref.get(key) is True:
            return "deleted"
    for key in ("archivedAt", "archived_at"):
        if thread_ref.get(key):
            return "archived"
    for key in ("deletedAt", "deleted_at", "removedAt", "removed_at"):
        if thread_ref.get(key):
            return "deleted"
    if thread_ref.get("resumeSupported") is False or thread_ref.get("resumable") is False:
        return "unresumable"
    return "active"


def _required_string(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} is required")
    return value


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _sandbox_mode(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        if value in {"read-only", "workspace-write", "danger-full-access"}:
            return value
        return {
            "readOnly": "read-only",
            "workspaceWrite": "workspace-write",
            "dangerFullAccess": "danger-full-access",
        }.get(value)
    if isinstance(value, dict):
        sandbox_type = value.get("type")
        if isinstance(sandbox_type, str):
            return {
                "readOnly": "read-only",
                "workspaceWrite": "workspace-write",
                "dangerFullAccess": "danger-full-access",
                "read-only": "read-only",
                "workspace-write": "workspace-write",
                "danger-full-access": "danger-full-access",
            }.get(sandbox_type)
    return None


def _codex_time(value: Any) -> str | None:
    if isinstance(value, int | float):
        seconds = float(value)
        if seconds > 10_000_000_000:
            seconds = seconds / 1000
        return datetime.fromtimestamp(seconds, UTC).isoformat().replace("+00:00", "Z")
    return _optional_string(value)


def _nested_string(data: dict[str, Any], key: str, nested_key: str) -> str | None:
    nested = data.get(key)
    if isinstance(nested, dict):
        return _optional_string(nested.get(nested_key))
    return None


def _approval_decision(status: Any) -> str:
    if status == "approved_for_session":
        return "acceptForSession"
    if status == "approved":
        return "accept"
    if status == "cancelled":
        return "cancel"
    return "decline"


def _soft_interrupt_failure_reason(error_text: str) -> str | None:
    message = error_text
    try:
        parsed = json.loads(error_text)
        if isinstance(parsed, dict):
            raw = parsed.get("message")
            if isinstance(raw, str):
                message = raw
    except json.JSONDecodeError:
        pass
    normalized = message.lower()
    if "thread not found" in normalized:
        return "thread_not_found"
    if "turn not found" in normalized:
        return "turn_not_found"
    return None


def _unresumable_thread_failure_reason(error_text: str) -> str | None:
    message = error_text
    try:
        parsed = json.loads(error_text)
        if isinstance(parsed, dict):
            raw = parsed.get("message")
            if isinstance(raw, str):
                message = raw
    except json.JSONDecodeError:
        pass
    normalized = message.lower()
    if (
        "thread not found" in normalized
        or "session not found" in normalized
        or "no rollout found" in normalized
    ):
        return "deleted"
    if "archived" in normalized:
        return "archived"
    if "cannot resume" in normalized or "not resumable" in normalized or "unresumable" in normalized:
        return "unresumable"
    return None


def _attachment_file_id(att: Any) -> str | None:
    if isinstance(att, dict):
        candidate = att.get("fileId")
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _attachment_name_from(att: Any) -> str | None:
    if isinstance(att, dict):
        candidate = att.get("name")
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


__all__ = ["CODEX_APPROVAL_METHODS", "CodexAdapter", "JsonRpcStdioClient", "TimelineReducer"]
