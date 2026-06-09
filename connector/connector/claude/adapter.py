from __future__ import annotations

import asyncio
import os
import shutil
import time
import uuid as uuid_lib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger

from connector.adapter import NotificationSink
from connector.claude.path_utils import (
    claude_uuid_from_jsonl,
    encode_cwd,
    projects_root,
    stable_claude_session_id,
)
from connector.claude.pty_runner import PtyDimensions, PtyRunner
from connector.claude.reducer import ClaudeJsonlReducer, ReductionResult
from connector.claude.approval_parser import (
    ApprovalMonitor,
    DetectedApproval,
)
from connector.claude.trust import ensure_trust
from connector.claude.watcher import (
    FileCursor,
    commit_event_batch,
    iter_jsonl_events,
    list_session_jsonls,
    peek_new_event_batch,
    read_new_events,
)
from connector.launch import LaunchTarget, launch_target
from connector.time import utc_now


# How long to wait for the JSONL file to first appear after spawn — cold
# starts (MCP server loading + auth checks) can take 60-180s per research
# doc §2.2. We give it a generous window.
_JSONL_APPEAR_TIMEOUT_S = 180.0

# How long to wait after spawn before pressing Enter. Research doc says
# 2-3s but cold first-run can need closer to 6-8s for the TUI input box
# to render. We err on the safe side.
_PRE_ENTER_DELAY_S = 8.0

# How long a turn is allowed to run. End-of-turn is detected by the JSONL
# tail seeing an assistant event with stop_reason ∈ {end_turn, stop_sequence}
# and no pending tool_use. Hard ceiling so a hung Claude doesn't park forever.
_TURN_TIMEOUT_S = 600.0

# After ESC, Claude normally appends a "[Request interrupted by user]" marker
# to JSONL. Wait briefly for that fact before falling back to a synthetic close.
_INTERRUPT_MARKER_TIMEOUT_S = 5.0


@dataclass(slots=True)
class _PendingApproval:
    """In-memory approval awaiting the user's mobile response."""

    approval_id: str
    detected: DetectedApproval
    turn_id: str | None


@dataclass(slots=True)
class _SessionRuntime:
    """Per-session live state during a write-path operation.

    Holds the PTY child (when a turn is in flight), the session-level
    asyncio lock so concurrent backend requests for the same session
    queue sanely, and the path to the JSONL file we tail.
    """

    claude_uuid: str
    session_id: str
    cwd: str
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    pty: PtyRunner | None = None
    approval_monitor: ApprovalMonitor | None = None
    pending_approvals: dict[str, _PendingApproval] = field(default_factory=dict)
    interrupt_requested: bool = False
    interrupt_requested_at: float | None = None


@dataclass(slots=True)
class ClaudeAdapter:
    """Claude Code adapter — read path (Task 3) + write path (Task 4).

    The write path drives the `claude` TUI via a PTY: spawn with the user's
    prompt as a positional arg, press Enter once the TUI is ready, tail
    the JSONL transcript until a final assistant event arrives, then exit
    cleanly with Ctrl+C × 2. Approval prompts (Task 5) attach on top.

    Methods still raising NotImplementedError are explicitly out of scope
    for Task 4 and will be filled in as later tasks land.
    """

    notification_sink: NotificationSink = None
    projects_dir: Path | None = None
    claude_bin: str | None = None
    claude_target: LaunchTarget | None = None
    _cursors: dict[Path, FileCursor] = field(default_factory=dict)
    _sessions: dict[str, _SessionRuntime] = field(default_factory=dict)
    skip_live_session_ids: set[str] = field(default_factory=set)

    def forget_sync_state(self) -> None:
        """Drop the per-file cursor cache so the next sync re-reads every
        jsonl from the head.

        Called when the server-side runtime entry has been removed
        (DELETE /runtime-capabilities/{runtime}). Without this, our
        `is_stale()` check would silently skip files we already ingested
        in a previous lifetime even though the backend SQL no longer has
        them. Live PTY-driven sessions in `_sessions` are intentionally
        left alone — they belong to in-flight turns, not the read cache.
        """
        self._cursors.clear()

    def apply_transcript_cursors(self, cursors: list[dict[str, Any]]) -> None:
        for raw in cursors:
            transcript_path = raw.get("transcriptPath")
            last_offset = raw.get("lastOffset")
            if not isinstance(transcript_path, str) or not isinstance(last_offset, int):
                continue
            path = Path(transcript_path)
            if path.name != f"{path.stem}.jsonl":
                continue
            cursor = self._cursors.setdefault(path, FileCursor(path=path))
            if last_offset < cursor.offset:
                continue
            cursor.offset = max(0, last_offset)
            cursor.size = cursor.offset
            try:
                stat = path.stat()
            except OSError:
                cursor.mtime = 0.0
            else:
                cursor.mtime = stat.st_mtime if stat.st_size <= cursor.offset else 0.0

    # ── read path (Task 3 — unchanged) ──────────────────────────────────────

    def _resolved_projects_dir(self) -> Path:
        return self.projects_dir or projects_root()

    def _resolved_claude_bin(self) -> str:
        return self._resolved_claude_target().path

    def _resolved_claude_target(self) -> LaunchTarget:
        if self.claude_target is not None:
            return self.claude_target
        return _find_claude_target()

    async def sync_existing_sessions(
        self,
        connector_id: str,
        *,
        limit: int = 100,
        force: bool = False,
        notification_sink: Callable[[list[dict[str, Any]]], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        projects_dir = self._resolved_projects_dir()
        jsonls = list_session_jsonls(projects_dir)
        jsonls.sort(key=_safe_mtime, reverse=True)
        jsonls = jsonls[:limit]

        notifications: list[dict[str, Any]] = []
        synced: list[str] = []
        skipped: list[str] = []
        started = time.perf_counter()
        for path in jsonls:
            claude_uuid = claude_uuid_from_jsonl(path)
            session_id = stable_claude_session_id(connector_id, claude_uuid)
            if self._should_skip_live_session(session_id, claude_uuid):
                skipped.append(claude_uuid)
                continue
            cursor = self._cursors.setdefault(path, FileCursor(path=path))
            if not force and not cursor.is_stale():
                skipped.append(claude_uuid)
                continue
            try:
                if force or cursor.offset <= 0:
                    reduced = self._reduce_one(connector_id, path)
                    cursor.refresh_stat()
                    cursor.offset = cursor.size
                    notifications_to_send = _backend_notifications_from_reduction(reduced)
                else:
                    reduced = self._reduce_from_cursor(
                        connector_id,
                        path,
                        cursor,
                        force_session_id=session_id,
                    )
                    if reduced is None:
                        skipped.append(claude_uuid)
                        continue
                    notifications_to_send = _backend_notifications_from_incremental_reduction(reduced)
                notifications_to_send.append(
                    _transcript_cursor_advanced_notification(
                        session_id=session_id,
                        claude_uuid=claude_uuid,
                        path=path,
                        cursor=cursor,
                        last_event_key=_last_reduced_event_key(reduced),
                    )
                )
            except Exception:
                logger.exception("claude jsonl reduce failed path={}", path)
                continue
            if not reduced.timeline_items and reduced.session_update is None:
                skipped.append(claude_uuid)
                continue
            if notification_sink is not None:
                await notification_sink(notifications_to_send)
            else:
                notifications.extend(notifications_to_send)
            synced.append(session_id)

        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.info(
            "claude existing session sync connector_id={} dir={} synced={} skipped={} elapsed_ms={:.1f}",
            connector_id,
            projects_dir,
            len(synced),
            len(skipped),
            elapsed_ms,
        )
        return {
            "threads": synced,
            "skippedThreads": skipped,
            "backendNotifications": notifications,
        }

    # ── write path (Task 4) ────────────────────────────────────────────────

    async def create_session(self, params: dict[str, Any]) -> dict[str, Any]:
        """Pre-allocate a Claude session uuid and surface it to the backend.

        We DON'T spawn the TUI here — that would start a long-lived claude
        process with no prompt to send. The first `turn.start` does the
        spawn (with `--session-id <uuid>` so the JSONL lands where we
        expect). create_session merely returns the ids the backend needs
        to wire its session row.
        """
        connector_id = _required(params, "connectorId")
        cwd = _required(params, "cwd")
        title = params.get("title")
        claude_uuid = str(uuid_lib.uuid4())
        session_id = stable_claude_session_id(connector_id, claude_uuid)
        self._sessions[session_id] = _SessionRuntime(
            claude_uuid=claude_uuid,
            session_id=session_id,
            cwd=cwd,
        )
        # Pre-accept trust so the very first spawn doesn't hit the dialog.
        try:
            ensure_trust(cwd)
        except Exception:
            logger.exception("claude ensure_trust failed cwd={}", cwd)

        update: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": "claude",
            "externalSessionId": claude_uuid,
            "status": "idle",
            "cwd": cwd,
            "lastSyncedAt": utc_now(),
        }
        if title:
            update["title"] = title
        return {
            "sessionId": session_id,
            "externalSessionId": claude_uuid,
            "backendNotifications": [
                {"method": "session.updated", "params": update}
            ],
        }

    async def sync_session(self, params: dict[str, Any]) -> dict[str, Any]:
        """Backend asks us to re-snapshot one session. We reuse the read
        path: locate the jsonl, reduce in full, push backend notifications."""
        session_id = _required(params, "sessionId")
        connector_id = params.get("connectorId") or _connector_from_session_id(session_id)
        external = params.get("externalSessionId") or self._claude_uuid_for(session_id)
        if not external:
            raise ValueError("sync_session needs externalSessionId or known session mapping")
        if self._should_skip_live_session(session_id, external):
            return {"backendNotifications": []}
        path = self._jsonl_path_for(external)
        if path is None or not path.is_file():
            return {"backendNotifications": []}
        cursor = self._cursors.setdefault(path, FileCursor(path=path))
        if cursor.offset <= 0:
            reduced = self._reduce_one(connector_id or "", path, force_session_id=session_id)
            cursor.refresh_stat()
            cursor.offset = cursor.size
            notifications = _backend_notifications_from_reduction(reduced)
            notifications.append(
                _transcript_cursor_advanced_notification(
                    session_id=session_id,
                    claude_uuid=external,
                    path=path,
                    cursor=cursor,
                    last_event_key=_last_reduced_event_key(reduced),
                )
            )
            return {"backendNotifications": notifications}
        if not cursor.is_stale():
            return {"backendNotifications": []}
        reduced = self._reduce_from_cursor(
            connector_id or "",
            path,
            cursor,
            force_session_id=session_id,
        )
        if reduced is None:
            return {"backendNotifications": []}
        notifications = _backend_notifications_from_incremental_reduction(reduced)
        notifications.append(
            _transcript_cursor_advanced_notification(
                session_id=session_id,
                claude_uuid=external,
                path=path,
                cursor=cursor,
                last_event_key=_last_reduced_event_key(reduced),
            )
        )
        return {"backendNotifications": notifications}

    async def start_turn(self, params: dict[str, Any]) -> dict[str, Any]:
        """Spawn claude with the prompt, press Enter once the TUI is ready,
        and return immediately with a (best-effort) turn id.

        The actual turn-completion drive runs as a background task that
        pushes timeline.itemUpsert + session.updated notifications as the
        JSONL grows. This matches CodexAdapter.start_turn which also
        returns promptly and streams updates afterwards.
        """
        session_id = _required(params, "sessionId")
        content = _required(params, "content")
        external = params.get("externalSessionId")
        runtime = self._sessions.get(session_id)
        if runtime is None:
            if not external:
                raise ValueError("Claude session not registered; pass externalSessionId or create_session first")
            cwd = params.get("cwd") or self._cwd_from_jsonl(external) or os.getcwd()
            runtime = _SessionRuntime(claude_uuid=external, session_id=session_id, cwd=cwd)
            self._sessions[session_id] = runtime

        # Serialise concurrent turns on the same session. We hold the lock
        # across the background task; new requests on this session wait.
        await runtime.lock.acquire()
        runtime.interrupt_requested = False
        runtime.interrupt_requested_at = None
        try:
            try:
                ensure_trust(runtime.cwd)
            except Exception:
                logger.exception("claude ensure_trust failed cwd={}", runtime.cwd)

            args = self._build_spawn_args(
                claude_uuid=runtime.claude_uuid,
                content=content,
                mode=params.get("permissionMode"),
                model=params.get("model"),
                effort=params.get("effort"),
                exists=self._jsonl_exists(runtime.claude_uuid),
            )
            jsonl_path = self._expected_jsonl_path(runtime.cwd, runtime.claude_uuid)
            cursor = self._cursors.setdefault(jsonl_path, FileCursor(path=jsonl_path))
            cursor.refresh_stat()
            if cursor.size > 0:
                cursor.offset = cursor.size

            pty = PtyRunner()
            runtime.pty = pty
            claude_target = self._resolved_claude_target()
            logger.info(
                "claude turn start session_id={} uuid={} bin={} args={}",
                session_id,
                runtime.claude_uuid,
                claude_target.path,
                args,
            )
            pty.spawn(
                claude_target,
                args,
                cwd=runtime.cwd,
                dimensions=PtyDimensions(rows=40, cols=140),
            )

            # Approval monitor — a pyte virtual screen we feed every PTY byte
            # into; on each poll tick it scans the rendered screen for an
            # 'Do you want to proceed?' dialog. Detection runs in a worker
            # thread; the callback hops back to the asyncio loop via
            # `call_soon_threadsafe` to push notifications.
            loop = asyncio.get_running_loop()
            monitor = ApprovalMonitor(
                on_dialog=lambda d: loop.call_soon_threadsafe(
                    lambda: asyncio.ensure_future(
                        self._handle_detected_dialog(runtime, d)
                    )
                ),
            )
            monitor.start()
            runtime.approval_monitor = monitor

            # CRITICAL: drain PTY stdout in a background task. Claude's TUI
            # writes constantly (welcome screen, input box, animation,
            # status bar); if nobody reads, the kernel pipe buffer fills,
            # Claude blocks on write, and nothing — including writing the
            # JSONL — makes progress. We tee every byte into the approval
            # monitor before discarding so the screen scraper stays current.
            drain_task = asyncio.create_task(_drain_pty(pty, monitor=monitor))

            # Set up reducer with whatever's already in the file (resume
            # case) so the background task picks up from the right spot.
            reducer = ClaudeJsonlReducer(
                session_id=session_id,
                claude_uuid=runtime.claude_uuid,
            )
            client_message_id = params.get("clientMessageId")
            if isinstance(client_message_id, str) and client_message_id:
                reducer.register_client_message(
                    client_message_id=client_message_id,
                    text=content,
                )
            pre_spawn_size = cursor.size
            pre_existing = list(iter_jsonl_events(jsonl_path)) if jsonl_path.is_file() else []
            for event in pre_existing:
                reducer._handle(event)
            cursor.refresh_stat()
            consumed_spawned_events = cursor.size > pre_spawn_size and reducer._open_turn_user_uuid is None
            cursor.offset = cursor.size
            turn_id_hint = reducer._open_turn_user_uuid or _last_turn_id(reducer._items)

            # Everything below — waiting for JSONL to appear, pressing Enter,
            # tailing for completion — happens in the background so start_turn
            # returns quickly enough to fit the backend's RPC timeout (cold
            # starts can take minutes).
            task = asyncio.create_task(self._drive_turn_to_completion(
                runtime=runtime,
                jsonl_path=jsonl_path,
                cursor=cursor,
                reducer=reducer,
                send_enter=True,
                drain_task=drain_task,
                consumed_spawned_events=consumed_spawned_events,
            ))
            task.add_done_callback(lambda _t: runtime.lock.release() if runtime.lock.locked() else None)
        except BaseException:
            # If anything blew up before we handed off to the background task,
            # release the lock here.
            if runtime.lock.locked():
                runtime.lock.release()
            raise

        return {"turnId": turn_id_hint}

    async def interrupt_turn(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = _required(params, "sessionId")
        turn_id = params.get("turnId")
        runtime = self._sessions.get(session_id)
        if runtime is not None:
            runtime.interrupt_requested = True
            runtime.interrupt_requested_at = time.monotonic()

        # Live PTY: send ESC and let the drive loop see the flag, break, and
        # emit turn.end (fix B). Fast path — no synthetic item needed here.
        if runtime is not None and runtime.pty is not None and runtime.pty.isalive():
            runtime.pty.send_esc()
            logger.info("claude turn interrupted session_id={} (ESC sent)", session_id)
            return {"interrupted": True}

        # No live PTY: the drive loop is already gone (or this is a legacy
        # stuck session). Directly emit a synthetic turn.end so the session
        # leaves "running". Deduped against any real turn.end by its id.
        if turn_id:
            claude_uuid = runtime.claude_uuid if runtime is not None else None
            item = _synthetic_turn_end(session_id, turn_id, claude_uuid)
            if self.notification_sink is not None:
                await self.notification_sink(
                    "timeline.itemUpsert",
                    {"sessionId": session_id, "item": item},
                )
            logger.info(
                "claude turn interrupted session_id={} (synthetic turn.end)", session_id
            )
        return {"interrupted": False, "reason": "no in-flight turn; closed open turn"}

    async def resolve_approval(self, params: dict[str, Any]) -> dict[str, Any]:
        """Translate the backend's approval decision into a TUI keystroke.

        The phone clicked Yes / No / Cancel; the backend forwards us the
        approval_id and status; we look up the per-session pending entry,
        find the matching choice in the captured dialog, and send the
        corresponding key. Research doc §5.3 says digit + Enter works
        without needing arrow keys, and Esc cancels the whole tool call.
        """
        session_id = _required(params, "sessionId")
        approval_id = _required(params, "approvalId")
        status = _required(params, "status")
        runtime = self._sessions.get(session_id)
        if runtime is None:
            return {"resolved": False, "reason": "session not registered"}
        pending = runtime.pending_approvals.get(approval_id)
        if pending is None:
            return {"resolved": False, "reason": "approval not pending"}
        pty = runtime.pty
        if pty is None or not pty.isalive():
            return {"resolved": False, "reason": "no live PTY"}

        action = _action_for_status(status)
        if action == "cancel":
            pty.send_esc()
            runtime.pending_approvals.pop(approval_id, None)
            logger.info(
                "claude approval cancelled (ESC) session_id={} approval_id={}",
                session_id, approval_id,
            )
            return {"resolved": True, "key": "esc"}

        # Find the option whose action matches what the user picked.
        choice = next(
            (c for c in pending.detected.choices if c.action == action and c.key.isdigit()),
            None,
        )
        if choice is None:
            # Fall back: approve_for_session collapses to approve when the
            # dialog didn't offer option 2 (e.g. some single-shot prompts).
            if action == "approve_for_session":
                choice = next(
                    (c for c in pending.detected.choices if c.action == "approve"),
                    None,
                )
        if choice is None:
            return {"resolved": False, "reason": f"no choice for status={status}"}

        pty.send(choice.key)
        pty.send_enter()
        runtime.pending_approvals.pop(approval_id, None)
        logger.info(
            "claude approval resolved session_id={} approval_id={} status={} key={}",
            session_id, approval_id, status, choice.key,
        )
        return {"resolved": True, "key": choice.key}

    # ── approval flow ──────────────────────────────────────────────────────

    async def _handle_detected_dialog(
        self, runtime: _SessionRuntime, detected: DetectedApproval
    ) -> None:
        """Background callback fired when the approval monitor sees a new
        dialog on the TUI screen. We mint an approval id, remember the
        choice mapping for resolve_approval, and push an
        `approval.requested` notification upstream."""
        approval_id = "appr_" + detected.fingerprint
        if approval_id in runtime.pending_approvals:
            return  # already announced this exact dialog
        turn_id = self._guess_turn_id_for_session(runtime)
        runtime.pending_approvals[approval_id] = _PendingApproval(
            approval_id=approval_id,
            detected=detected,
            turn_id=turn_id,
        )
        logger.info(
            "claude approval detected session_id={} kind={} title={!r}",
            runtime.session_id,
            detected.kind,
            detected.title,
        )
        if self.notification_sink is None:
            return
        payload = {
            "id": approval_id,
            "sessionId": runtime.session_id,
            "turnId": turn_id,
            "status": "pending",
            "kind": detected.kind,
            "title": detected.title or "Claude approval",
            "description": detected.description or detected.question,
            "payload": {
                "question": detected.question,
                "choices": [
                    {"key": c.key, "label": c.label, "action": c.action}
                    for c in detected.choices
                ],
                "focusedKey": detected.focused_key,
            },
            "choices": _collect_actions(detected),
            "source": {
                "runtime": "claude",
                "requestId": approval_id,
                "sessionId": runtime.claude_uuid,
                "turnId": turn_id,
                "method": "tui_dialog",
            },
        }
        await self.notification_sink("approval.requested", payload)

    def _guess_turn_id_for_session(self, runtime: _SessionRuntime) -> str | None:
        # The reducer is the source of truth for "which turn is open right
        # now"; the drive loop owns it though, so we fall back to the
        # latest persisted timeline entry we know about.
        return None

    # ── internals ───────────────────────────────────────────────────────────

    def _build_spawn_args(
        self,
        *,
        claude_uuid: str,
        content: str,
        mode: str | None,
        model: str | None,
        effort: str | None,
        exists: bool,
    ) -> list[str]:
        """Compose claude CLI arguments.

        - First spawn for a session uses `--session-id <uuid>` to pin the
          uuid (so the JSONL lands at a predictable path).
        - Subsequent spawns use `--resume <uuid>` which appends to the
          existing transcript.
        - Per research doc §4.5: `--setting-sources project,local` is only
          added when `--permission-mode` is set, so we don't quietly bypass
          the user's local defaults when no per-message override is asked.
        """
        args: list[str] = []
        if exists:
            args += ["--resume", claude_uuid]
        else:
            args += ["--session-id", claude_uuid]
        if mode:
            args += ["--permission-mode", mode]
            args += ["--setting-sources", "project,local"]
        if model:
            args += ["--model", model]
        if effort:
            args += ["--effort", effort]
        args.append(content)
        return args

    async def _wait_for_jsonl(self, path: Path, timeout: float) -> None:
        """Block until the JSONL file exists (or timeout). Cold starts can
        be slow; bail with a clear error so the backend surfaces 502."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if path.is_file():
                return
            await asyncio.sleep(0.5)
        raise TimeoutError(f"claude JSONL never appeared at {path}")

    async def _drive_turn_to_completion(
        self,
        *,
        runtime: _SessionRuntime,
        jsonl_path: Path,
        cursor: FileCursor,
        reducer: ClaudeJsonlReducer,
        send_enter: bool = False,
        drain_task: asyncio.Task[None] | None = None,
        consumed_spawned_events: bool = False,
    ) -> None:
        """Background-task body: tail JSONL, feed reducer, push deltas
        upstream, terminate the PTY cleanly once the turn closes.

        Errors are caught and logged so a single bad turn doesn't leak
        into the daemon process. The caller's done-callback releases the
        session lock regardless.
        """
        # Claude only writes the JSONL *after* the user presses Enter, so
        # the order is: fixed wait for the TUI to render → send Enter →
        # then poll for the JSONL to materialise. Cold starts (MCP server
        # load, auth, model warm-up) all happen post-Enter.
        if send_enter:
            try:
                await asyncio.sleep(_PRE_ENTER_DELAY_S)
                if runtime.pty is not None and runtime.pty.isalive():
                    runtime.pty.send_enter()
                    logger.info(
                        "claude submitted prompt (Enter sent) session_id={} uuid={}",
                        runtime.session_id,
                        runtime.claude_uuid,
                    )
                await self._wait_for_jsonl(jsonl_path, _JSONL_APPEAR_TIMEOUT_S)
            except Exception:
                logger.exception(
                    "claude pre-tail wait failed session_id={} uuid={}",
                    runtime.session_id,
                    runtime.claude_uuid,
                )

        deadline = time.monotonic() + _TURN_TIMEOUT_S
        last_emit_count = 0
        opened_turn_id: str | None = reducer._open_turn_user_uuid
        if opened_turn_id is None and consumed_spawned_events:
            opened_turn_id = _last_turn_id(reducer._items)
        idle_since: float | None = time.monotonic() if consumed_spawned_events and opened_turn_id else None
        end_turn_seen = consumed_spawned_events
        try:
            while time.monotonic() < deadline:
                new_events = read_new_events(cursor)
                for event in new_events:
                    reducer._handle(event)
                    if opened_turn_id is None and reducer._open_turn_user_uuid is not None:
                        opened_turn_id = reducer._open_turn_user_uuid

                new_items = reducer._items[last_emit_count:]
                if new_items:
                    last_emit_count = len(reducer._items)
                    await self._push_items(runtime.session_id, new_items)

                if reducer._open_turn_user_uuid is None and opened_turn_id is not None:
                    end_turn_seen = True
                    if idle_since is None:
                        idle_since = time.monotonic()
                    if time.monotonic() - idle_since > 1.0:
                        break

                if runtime.interrupt_requested:
                    elapsed = (
                        time.monotonic() - runtime.interrupt_requested_at
                        if runtime.interrupt_requested_at is not None
                        else 0.0
                    )
                    if elapsed > _INTERRUPT_MARKER_TIMEOUT_S:
                        logger.warning(
                            "claude interrupt marker not observed before timeout; emitting synthetic turn.end session_id={} uuid={}",
                            runtime.session_id,
                            runtime.claude_uuid,
                        )
                        break

                if not new_events:
                    await asyncio.sleep(0.1 if runtime.interrupt_requested else 0.2)
                else:
                    idle_since = None

            # The turn never closed naturally (interrupt, timeout, or PTY
            # death). Force a turn.end so the session leaves "running" — the
            # backend derives status purely from turn.start/turn.end items.
            if not end_turn_seen:
                stop_reason = "interrupted" if runtime.interrupt_requested else "incomplete"
                closed_item = reducer.close_open_turn(
                    status="interrupted" if runtime.interrupt_requested else "done",
                    stop_reason=stop_reason,
                    source_event="synthetic_timeout" if runtime.interrupt_requested else None,
                )
                if closed_item is not None:
                    last_emit_count = len(reducer._items)
                    await self._push_items(runtime.session_id, [closed_item])

            session_update = reducer._build_session_update()
            if self.notification_sink is not None:
                await self.notification_sink("session.updated", session_update)
        except Exception:
            logger.exception(
                "claude drive turn failed session_id={} uuid={}",
                runtime.session_id,
                runtime.claude_uuid,
            )
            if self.notification_sink is not None:
                await self.notification_sink(
                    "runtime.error",
                    {"sessionId": runtime.session_id, "runtime": "claude"},
                )
        finally:
            if drain_task is not None and not drain_task.done():
                drain_task.cancel()
            if runtime.approval_monitor is not None:
                try:
                    runtime.approval_monitor.stop()
                except Exception:
                    logger.exception("claude approval monitor stop failed session_id={}", runtime.session_id)
                runtime.approval_monitor = None
            runtime.pending_approvals.clear()
            pty = runtime.pty
            if pty is not None:
                try:
                    if pty.isalive():
                        pty.send_ctrl_c()
                        await asyncio.sleep(0.2)
                        pty.send_ctrl_c()
                        await asyncio.sleep(0.3)
                    pty.terminate(force=True)
                except Exception:
                    logger.exception("claude pty cleanup failed session_id={}", runtime.session_id)
                runtime.pty = None

    async def _push_items(
        self, session_id: str, items: list[dict[str, Any]]
    ) -> None:
        if self.notification_sink is None:
            return
        for item in items:
            await self.notification_sink(
                "timeline.itemUpsert",
                {"sessionId": session_id, "item": item},
            )

    def _reduce_one(
        self,
        connector_id: str,
        path: Path,
        *,
        force_session_id: str | None = None,
    ) -> ReductionResult:
        claude_uuid = claude_uuid_from_jsonl(path)
        session_id = force_session_id or stable_claude_session_id(connector_id, claude_uuid)
        if self._should_skip_live_session(session_id, claude_uuid):
            return ReductionResult()
        reducer = ClaudeJsonlReducer(session_id=session_id, claude_uuid=claude_uuid)
        result = reducer.reduce_full(iter_jsonl_events(path))
        # reduce_full leaves a dangling open turn on purpose. For a session we
        # are NOT live-driving, force-close it so it derives idle rather than
        # parking on "running" forever.
        if not self._is_live(session_id):
            closed = reducer.close_open_turn(status="done", stop_reason="incomplete")
            if closed is not None:
                result.timeline_items.append(closed)
                result.session_update = reducer._build_session_update()
        return result

    def _reduce_from_cursor(
        self,
        connector_id: str,
        path: Path,
        cursor: FileCursor,
        *,
        force_session_id: str | None = None,
    ) -> ReductionResult | None:
        claude_uuid = claude_uuid_from_jsonl(path)
        session_id = force_session_id or stable_claude_session_id(connector_id, claude_uuid)
        if self._should_skip_live_session(session_id, claude_uuid):
            return None
        batch = peek_new_event_batch(cursor)
        if not batch.events:
            commit_event_batch(cursor, batch)
            return None
        reducer = ClaudeJsonlReducer(session_id=session_id, claude_uuid=claude_uuid)
        result = reducer.reduce_full(batch.events)
        if reducer._open_turn_user_uuid is not None:
            return None
        commit_event_batch(cursor, batch)
        return result

    def mark_transcript_consumed(self, *, path: Path, offset: int) -> None:
        cursor = self._cursors.setdefault(path, FileCursor(path=path))
        cursor.refresh_stat()
        cursor.offset = max(cursor.offset, offset)
        cursor.size = max(cursor.size, cursor.offset)

    def _should_skip_live_session(self, session_id: str, claude_uuid: str) -> bool:
        return session_id in self.skip_live_session_ids or claude_uuid in self.skip_live_session_ids

    def _is_live(self, session_id: str) -> bool:
        runtime = self._sessions.get(session_id)
        return (
            runtime is not None
            and runtime.pty is not None
            and runtime.pty.isalive()
        )

    def _expected_jsonl_path(self, cwd: str, claude_uuid: str) -> Path:
        return self._resolved_projects_dir() / encode_cwd(cwd) / f"{claude_uuid}.jsonl"

    def _jsonl_exists(self, claude_uuid: str) -> bool:
        return self._jsonl_path_for(claude_uuid) is not None

    def _jsonl_path_for(self, claude_uuid: str) -> Path | None:
        projects_dir = self._resolved_projects_dir()
        if not projects_dir.is_dir():
            return None
        for cwd_dir in projects_dir.iterdir():
            if not cwd_dir.is_dir():
                continue
            candidate = cwd_dir / f"{claude_uuid}.jsonl"
            if candidate.is_file():
                return candidate
        return None

    def _cwd_from_jsonl(self, claude_uuid: str) -> str | None:
        path = self._jsonl_path_for(claude_uuid)
        if path is None:
            return None
        try:
            for event in iter_jsonl_events(path):
                cwd = event.get("cwd")
                if isinstance(cwd, str) and cwd:
                    return cwd
        except Exception:
            return None
        return None

    def _claude_uuid_for(self, session_id: str) -> str | None:
        runtime = self._sessions.get(session_id)
        return runtime.claude_uuid if runtime is not None else None


def _safe_mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _backend_notifications_from_reduction(
    reduced: ReductionResult,
) -> list[dict[str, Any]]:
    notifications: list[dict[str, Any]] = []
    if reduced.session_update:
        notifications.append(
            {"method": "session.updated", "params": reduced.session_update}
        )
    if reduced.timeline_items:
        session_id = reduced.timeline_items[0]["sessionId"]
        notifications.append(
            {
                "method": "timeline.sync",
                "params": {"sessionId": session_id, "items": reduced.timeline_items},
            }
        )
    return notifications


def _backend_notifications_from_incremental_reduction(
    reduced: ReductionResult,
) -> list[dict[str, Any]]:
    notifications: list[dict[str, Any]] = []
    if reduced.session_update:
        notifications.append(
            {"method": "session.updated", "params": reduced.session_update}
        )
    for item in reduced.timeline_items:
        notifications.append(
            {
                "method": "timeline.itemUpsert",
                "params": {"sessionId": item["sessionId"], "item": item},
            }
        )
    return notifications


def _transcript_cursor_advanced_notification(
    *,
    session_id: str,
    claude_uuid: str,
    path: Path,
    cursor: FileCursor,
    last_event_key: str | None,
) -> dict[str, Any]:
    return {
        "method": "claude.transcriptCursorAdvanced",
        "params": {
            "sessionId": session_id,
            "runtime": "claude",
            "externalSessionId": claude_uuid,
            "transcriptPath": str(path),
            "lastOffset": cursor.offset,
            "lastEventKey": last_event_key,
        },
    }


def _last_reduced_event_key(reduced: ReductionResult) -> str | None:
    for item in reversed(reduced.timeline_items):
        item_id = item.get("id")
        if isinstance(item_id, str) and item_id:
            return item_id
    if reduced.session_update:
        session_id = reduced.session_update.get("sessionId")
        if isinstance(session_id, str) and session_id:
            return session_id
    return None


def _required(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} is required")
    return value


def _action_for_status(status: str) -> str:
    """Backend approval status → adapter action."""
    if status == "approved":
        return "approve"
    if status == "approved_for_session":
        return "approve_for_session"
    if status == "rejected":
        return "reject"
    return "cancel"


def _collect_actions(detected: DetectedApproval) -> list[str]:
    actions: list[str] = []
    for c in detected.choices:
        if c.action not in actions:
            actions.append(c.action)
    return actions


async def _drain_pty(pty: PtyRunner, *, monitor: ApprovalMonitor | None = None) -> None:
    """Continuously drain whatever the Claude TUI writes to its PTY.

    We don't need the bytes for the timeline — the JSONL holds the
    canonical data — but if nobody reads, the kernel buffer fills and
    Claude blocks on write. When an approval monitor is attached, every
    chunk is teed into its pyte stream so the screen scraper can detect
    'Do you want to proceed?' dialogs.
    """
    try:
        while pty.isalive():
            data = pty.read_nonblocking(size=8192, timeout=0.1)
            if data:
                if monitor is not None:
                    monitor.feed(data)
            else:
                await asyncio.sleep(0.05)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("claude pty drain crashed")


def _synthetic_turn_end(
    session_id: str, turn_id: str, claude_uuid: str | None
) -> dict[str, Any]:
    """Build a synthetic turn.end item for a session whose drive loop is gone.

    Routes through the reducer so the item shape stays identical to a real
    turn.end (id `{turn_id}:turn-end`, dedupes with any natural one).
    """
    reducer = ClaudeJsonlReducer(session_id=session_id, claude_uuid=claude_uuid or "")
    reducer._open_turn_user_uuid = turn_id
    item = reducer.close_open_turn(
        status="interrupted",
        stop_reason="interrupted",
        source_event="synthetic_timeout",
    )
    assert item is not None
    return item


def _last_turn_id(items: list[dict[str, Any]]) -> str | None:
    for item in reversed(items):
        if item.get("type") == "turn.start" and isinstance(item.get("turnId"), str):
            return item["turnId"]
    return None


def _connector_from_session_id(session_id: str) -> str | None:
    # sess_claude_<24-hex>. The connector id can't be recovered from the
    # session id alone (deliberately — id is a hash). Callers that need it
    # must pass it in `params`. Return None and let the caller decide.
    return None


def _find_claude_bin() -> str:
    """Discover the `claude` executable."""
    return _find_claude_target().path


def _find_claude_target() -> LaunchTarget:
    """Discover the `claude` executable."""
    explicit = os.environ.get("CLAUDE_BIN")
    if explicit:
        return launch_target("custom", explicit)
    discovered = shutil.which("claude")
    if discovered:
        return launch_target("cli", discovered)
    # Common install locations.
    candidates = [
        Path.home() / ".npm-global" / "bin" / "claude",
        Path.home() / ".local" / "bin" / "claude",
        Path("/opt/homebrew/bin/claude"),
        Path("/usr/local/bin/claude"),
    ]
    for c in candidates:
        if c.is_file():
            return launch_target("cli", str(c))
    return launch_target("cli", "claude")


__all__ = ["ClaudeAdapter"]
