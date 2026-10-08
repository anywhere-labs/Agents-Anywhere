"""PiRuntime: one ``pi --mode rpc`` process per live session.

The runtime is a *polling* runtime: the connector periodically asks it for the
session inventory and reshapes Pi session files into platform timeline items.
Live sessions also stream assistant and tool progress and push an authoritative
snapshot when a run settles.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections.abc import Mapping, Sequence
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any

from connector.runtime_protocol import (
    CAPABILITY_CATALOG_EFFORT,
    CAPABILITY_CATALOG_MODEL,
    CAPABILITY_CATALOG_PERMISSION,
    CAPABILITY_RUNTIME_ATTACHMENT,
    CAPABILITY_SESSION_COMMANDS,
    CAPABILITY_SESSION_INTERACTION_APPROVAL,
    CAPABILITY_SESSION_INTERRUPT,
    CAPABILITY_SESSION_SEND_MESSAGE,
    CAPABILITY_SESSION_STEER,
    AgentRuntime,
    RuntimeAttachment,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeTimelineSnapshot,
    RuntimeUnavailableError,
    SessionMeta,
    SessionNotice,
    SessionSourceState,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.pi import projection
from connector.runtimes.pi.attachments import prepare_attachments
from connector.runtimes.pi.config import normalized_config_values, probe_pi_version
from connector.runtimes.pi.launcher import resolve_pi_command
from connector.runtimes.pi.permissions import (
    APPROVAL_EXTENSION_PATH,
    PERMISSION_MODES,
    parse_approval_request,
    permission_items,
    validate_permission_mode,
)
from connector.runtimes.pi.rpc import (
    PiRpcProcess,
    PiRpcProcessExited,
    PiRpcRequestFailed,
    response_data,
)
from connector.runtimes.pi.sessions import (
    PiSessionSummary,
    SessionDirectory,
    is_meaningful_title,
    load_session_doc,
)
from connector.runtimes.pi.stream import STREAM_EVENT_TYPES, PiStreamAccumulator

logger = logging.getLogger(__name__)

# Optimistic sends are reconciled by client message id; the pairs live in the
# session transcript projection. Keep the most recent ones persisted per
# session so a connector restart cannot orphan the echo of an in-flight send.
CLIENT_MESSAGE_BINDINGS_VERSION = 1
MAX_CLIENT_MESSAGE_BINDINGS_PER_SESSION = 200

# The platform may empty or stale its runtime-state caches when the backend
# restarts (for example the server host rebooting) while this connector keeps
# running. Re-announcing every session's state converges them again; repeated
# reconnects within this window skip the full inventory scan.
REANNOUNCE_MIN_INTERVAL_SECONDS = 60.0

RUNTIME = "pi"
PLATFORM_SESSION_PREFIX = "sess_pi_"

# How often the idle reclaim loop inspects live sessions.
RECLAIM_INTERVAL_SECONDS = 15.0

DIALOG_METHODS = frozenset({"select", "confirm", "input", "editor"})


def _merge_client_message_pairs(
    *groups: Sequence[tuple[str, str]],
) -> tuple[tuple[str, str], ...]:
    """Merge client message pairs, keeping the newest entry per (text, id)."""

    seen: set[tuple[str, str]] = set()
    merged: list[tuple[str, str]] = []
    for group in groups:
        for text, client_message_id in group:
            marker = (text.strip(), client_message_id)
            if marker in seen:
                continue
            seen.add(marker)
            merged.append((text, client_message_id))
    return tuple(merged)


def platform_session_id(namespace: str, external_id: str) -> str:
    """Derive the stable platform session id for a Pi session file."""

    digest = hashlib.sha256(f"{namespace}:pi:{external_id}".encode()).hexdigest()
    return f"{PLATFORM_SESSION_PREFIX}{digest[:24]}"


def _iso_from_epoch(epoch: float) -> str:
    return datetime.fromtimestamp(epoch).astimezone().isoformat()


def _model_selection_id(model: Mapping[str, Any]) -> str | None:
    model_id = model.get("id")
    if not isinstance(model_id, str) or not model_id:
        return None
    provider = model.get("provider")
    if isinstance(provider, str) and provider:
        return f"{provider}:{model_id}"
    return model_id


def _split_model_selection(value: str) -> tuple[str | None, str]:
    provider, separator, model_id = value.partition(":")
    if separator and provider and model_id:
        return provider, model_id
    return None, value


def _model_display_title(
    name: str,
    provider: str | None,
    model_id: str,
    directory: Sequence[tuple[str, str | None, str]],
) -> str:
    """Label a model so identical names from different routes stay distinct.

    Mirrors the platform's own labeling (dsh-bridge-next ``labelModels``):
    when the same display name exists under several providers, append the
    provider; when one provider exposes several ids under the same name,
    append the model id as well. Labels are computed over the full directory
    so search and pagination cannot change them.
    """

    same_name = [entry for entry in directory if entry[0] == name]
    multiple_providers = any(entry[1] != provider for entry in same_name)
    duplicate_model = any(entry[1] == provider and entry[2] != model_id for entry in same_name)
    title = name
    if multiple_providers and provider:
        title += f"（{provider}）"
    if duplicate_model:
        title += f" [{model_id}]"
    return title


class PendingInteraction:
    """One open extension UI dialog waiting for a platform response."""

    def __init__(
        self,
        request: Mapping[str, Any],
        *,
        external_session_id: str | None = None,
        turn_id: str = "",
    ) -> None:
        self.request_id = str(request.get("id"))
        self.method = str(request.get("method"))
        self.title = str(request.get("title") or "Pi 需要你的输入")
        message = request.get("message")
        self.message = message if isinstance(message, str) else None
        options = request.get("options")
        self.options = (
            [str(option) for option in options if isinstance(option, str)]
            if isinstance(options, list)
            else []
        )
        timeout = request.get("timeout")
        self.timeout_ms = timeout if isinstance(timeout, int) else None
        self.approval = parse_approval_request(request)
        self.external_session_id = external_session_id
        self.turn_id = turn_id

    @property
    def notice_id(self) -> str:
        return f"pi-ui-{self.request_id}"

    def as_notice(
        self, session_id: str, *, status: str = "open", action_id: str | None = None
    ) -> SessionNotice:
        if self.approval is not None:
            return self.approval.notice(
                session_id,
                self.external_session_id,
                self.turn_id,
                self.request_id,
                status=status,
                action_id=action_id,
            )
        actions: list[dict[str, Any]] = []
        context: dict[str, Any] = {"method": self.method}
        if self.method == "confirm":
            actions = [
                {"actionId": "confirm", "label": "确认", "style": "primary"},
                {"actionId": "cancel", "label": "取消", "style": "secondary"},
            ]
        elif self.method == "select":
            actions = [
                {"actionId": option, "label": option, "style": "secondary"}
                for option in self.options
            ]
            if actions:
                actions[0]["style"] = "primary"
            actions.append({"actionId": "cancel", "label": "取消", "style": "secondary"})
        else:
            context["inputKind"] = "text"
            context["multiline"] = self.method == "editor"
            if isinstance(self.request_id, str):
                context["requestId"] = self.request_id
        return SessionNotice(
            notice_id=self.notice_id,
            session_id=session_id,
            runtime=RUNTIME,
            type="interaction",
            interaction_type=f"pi.{self.method}",
            title=self.title,
            message=self.message,
            severity="warning",
            status=status,
            response_required=status == "open",
            blocking={"scope": "session", "targetId": session_id} if status == "open" else None,
            actions=tuple(actions) if status == "open" else (),
            source={"runtime": RUNTIME, "component": "pi.extension-ui"},
            context=context,
        )

    def response_payload(
        self,
        action_id: str,
        input_data: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        data = dict(input_data or {})
        if self.approval is not None:
            return {
                "type": "extension_ui_response",
                "id": self.request_id,
                "confirmed": action_id == "approve",
            }
        if action_id in ("cancel", "dismiss", "reject", "no"):
            if self.method == "confirm" and action_id in ("reject", "no"):
                return {"type": "extension_ui_response", "id": self.request_id, "confirmed": False}
            return {"type": "extension_ui_response", "id": self.request_id, "cancelled": True}
        if self.method == "confirm":
            confirmed = data.get("confirmed")
            if isinstance(confirmed, bool):
                return {
                    "type": "extension_ui_response",
                    "id": self.request_id,
                    "confirmed": confirmed,
                }
            return {
                "type": "extension_ui_response",
                "id": self.request_id,
                "confirmed": action_id in ("confirm", "yes", "allow", "approve"),
            }
        # select / input / editor all answer with a string value.
        value = data.get("value")
        if not isinstance(value, str):
            value = data.get("text") if isinstance(data.get("text"), str) else None
        if value is None and self.method == "select":
            value = action_id
        return {
            "type": "extension_ui_response",
            "id": self.request_id,
            "value": value if value is not None else "",
        }


class PiLiveSession:
    """A platform session backed by one running Pi RPC process."""

    def __init__(
        self,
        runtime: PiRuntime,
        platform_id: str,
        *,
        cwd: str,
        session_path: str | None = None,
    ) -> None:
        self.runtime = runtime
        self.platform_id = platform_id
        self.cwd = cwd
        self.session_path = session_path
        self.process: PiRpcProcess | None = None
        self.session_file: str | None = session_path
        self.pi_session_id: str | None = None
        self.session_name: str | None = None
        self.model: Mapping[str, Any] | None = None
        self.thinking_level: str | None = None
        self.is_streaming = False
        self.is_compacting = False
        self.message_count = 0
        self.status_reason: str | None = None
        self.pending_ui: dict[str, PendingInteraction] = {}
        # (text, clientMessageId) pairs waiting for their projected user message.
        self.client_messages: list[tuple[str, str]] = []
        self.last_activity = time.monotonic()
        self._start_lock = asyncio.Lock()
        self.last_state_key: tuple[Any, ...] | None = None
        self.permission_mode = runtime.default_permission_mode
        self._permission_loaded = False
        self.stream: PiStreamAccumulator | None = None
        self.restarting = False
        self._selection_lock = asyncio.Lock()

    @property
    def external_id(self) -> str | None:
        return self.session_file or self.session_path

    @property
    def alive(self) -> bool:
        return self.process is not None and self.process.alive

    @property
    def status(self) -> str:
        if any(True for _ in self.pending_ui.values()):
            return "waiting_approval"
        if self.is_streaming or self.is_compacting:
            return "running"
        return "idle"

    def argv(self) -> list[str]:
        argv = [
            *self.runtime.command(),
            "--mode",
            "rpc",
            "--session-dir",
            str(self.runtime.sessions_dir),
            "--extension",
            str(APPROVAL_EXTENSION_PATH),
        ]
        if self.external_id:
            argv.extend(["--session", self.external_id])
        return argv

    async def ensure_started(self) -> None:
        async with self._start_lock:
            if self.alive:
                return
            if not self._permission_loaded:
                self.permission_mode = await self.runtime._load_permission(self.external_id)
                self._permission_loaded = True
            process = PiRpcProcess(
                self.argv(),
                cwd=self.cwd,
                on_event=self._on_event,
                on_exit=self._handle_exit,
                request_timeout=self.runtime.request_timeout,
                env={"PI_AA_PERMISSION_MODE": self.permission_mode},
            )
            await process.start()
            self.process = process
            try:
                await self.refresh_state()
            except (PiRpcProcessExited, PiRpcRequestFailed, TimeoutError) as exc:
                logger.warning(
                    "pi session %s started but get_state failed: %s",
                    self.platform_id,
                    exc,
                )
            await self.runtime._reset_stream(self)
            await self.runtime._persist_permission(self)

    async def refresh_state(self) -> Mapping[str, Any]:
        process = self.process
        if process is None:
            raise PiRpcProcessExited("Pi RPC process is not running")
        data = response_data(await process.request({"type": "get_state"}))
        self.apply_state(data)
        return data

    def touch(self) -> None:
        """Record activity so the idle reclaim loop leaves this session alone."""

        self.last_activity = time.monotonic()

    def apply_state(self, data: Mapping[str, Any]) -> None:
        model = data.get("model")
        if isinstance(model, Mapping):
            self.model = dict(model)
        thinking = data.get("thinkingLevel")
        if isinstance(thinking, str):
            self.thinking_level = thinking
        self.is_streaming = data.get("isStreaming") is True
        self.is_compacting = data.get("isCompacting") is True
        session_file = data.get("sessionFile")
        if isinstance(session_file, str) and session_file:
            self.session_file = session_file
        session_id = data.get("sessionId")
        if isinstance(session_id, str) and session_id:
            self.pi_session_id = session_id
        name = data.get("sessionName")
        self.session_name = name if isinstance(name, str) and name else None
        count = data.get("messageCount")
        if isinstance(count, int) and not isinstance(count, bool):
            self.message_count = count

    async def command(
        self,
        payload: Mapping[str, Any],
        *,
        timeout: float | None = None,
    ) -> Mapping[str, Any]:
        await self.ensure_started()
        self.touch()
        process = self.process
        if process is None:
            raise PiRpcProcessExited("Pi RPC process is not running")
        return await process.request(payload, timeout=timeout)

    async def send_prompt(
        self,
        content: str,
        *,
        streaming_behavior: str | None = None,
        images: Sequence[Mapping[str, Any]] = (),
    ) -> None:
        if streaming_behavior == "steer":
            payload: dict[str, Any] = {"type": "steer", "message": content}
            if images:
                payload["images"] = list(images)
            await self.command(payload)
            return
        payload = {"type": "prompt", "message": content}
        if images:
            payload["images"] = list(images)
        if streaming_behavior:
            payload["streamingBehavior"] = streaming_behavior
        await self.command(payload)

    async def stop(self) -> None:
        process = self.process
        self.process = None
        if process is not None:
            await process.close()
        if self.stream is not None:
            await self.stream.close()

    async def _handle_exit(self, code: int | None) -> None:
        await self.runtime.handle_live_exit(self, code)

    async def _on_event(self, record: Mapping[str, Any]) -> None:
        await self.runtime.handle_live_event(self, record)

    def state_key(self) -> tuple[Any, ...]:
        return (
            self.status,
            _model_selection_id(self.model or {}),
            self.thinking_level,
            self.permission_mode,
        )


class PiRuntime(AgentRuntime):
    """AgentRuntime implementation for the Pi coding agent."""

    def __init__(self, config: RuntimeConfig, host: RuntimeHostClient) -> None:
        self.config = config
        self.host = host
        values = normalized_config_values(dict(config.values))
        self.executable = str(values["executablePath"])
        self._command: list[str] | None = None
        self.request_timeout = int(values["requestTimeoutMs"]) / 1000
        self._idle_timeout = float(values["idleTimeoutSeconds"])
        self.default_cwd = str(values["defaultCwd"])
        self.default_permission_mode = str(values["permissionMode"])
        self.sessions_dir = Path(str(values["sessionsDir"]))
        self.directory = SessionDirectory(self.sessions_dir)
        self._live: dict[str, PiLiveSession] = {}
        self._live_locks: dict[str, asyncio.Lock] = {}
        self._known_paths: dict[str, str] = {}
        self._synced: dict[str, tuple[float, int]] = {}
        self._utility: PiRpcProcess | None = None
        self._catalog_revision = 0
        self._stopping = False
        self._reclaim_task: asyncio.Task[None] | None = None
        self._stale_reset_task: asyncio.Task[None] | None = None
        self._client_bindings: dict[str, tuple[tuple[str, str], ...]] = {}
        self._last_reannounce_at: float | None = None
        self._reannounce_lock = asyncio.Lock()
        self._identity = RuntimeIdentity(
            runtime=RUNTIME,
            runtime_version="unknown",
            display_name="Pi Coding Agent",
            runtime_id=config.runtime_id,
        )

    # -- lifecycle ----------------------------------------------------------

    @property
    def identity(self) -> RuntimeIdentity:
        return self._identity

    def command(self) -> list[str]:
        """argv prefix that starts Pi (resolves the Windows npm shim to node)."""

        if self._command is None:
            self._command = resolve_pi_command(self.executable) or [self.executable]
        return list(self._command)

    async def start(self) -> None:
        version = await probe_pi_version(self.executable)
        if version is None:
            raise RuntimeUnavailableError(f"pi executable is unavailable: {self.executable!r}")
        self._identity = replace(self._identity, runtime_version=version)
        logger.info("pi runtime started version=%s", version)
        await self._publish_runtime_capabilities()
        self._stale_reset_task = asyncio.create_task(self._reset_stale_running_states())
        if self._idle_timeout > 0:
            self._reclaim_task = asyncio.create_task(self._reclaim_loop())

    async def _publish_runtime_capabilities(self) -> None:
        """Push runtime-scoped facts so the platform persists them.

        The connector's discovery publication drops runtime types outside its
        hard-coded allowlist, so pi's runtime-scoped entries would never reach
        the platform's persisted capability facts. Without them, sessions that
        never published their own facts project as unsupported. Publishing
        through the runtime capability channel merges them into that store.
        """

        try:
            await self.host.session_capabilities_update(await self.get_runtime_capabilities())
        except Exception:  # publishing must not block startup
            logger.exception("failed to publish pi runtime capabilities")

    async def stop(self) -> None:
        self._stopping = True
        for task in (self._reclaim_task, self._stale_reset_task):
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._reclaim_task = None
        self._stale_reset_task = None
        for live in list(self._live.values()):
            await live.stop()
        self._live.clear()
        self._live_locks.clear()
        if self._utility is not None:
            await self._utility.close()
            self._utility = None

    async def on_backend_reconnect(self) -> None:
        await self.reannounce_session_states(reason="backend-reconnect")

    async def reannounce_session_states(self, *, reason: str = "reconnect") -> None:
        """Publish the authoritative state of every known session.

        The platform stores runtime state in server-side caches that a backend
        restart (for example the server host rebooting) can empty or stale
        while this connector keeps running. Clients then refuse input based on
        the stale state until a connector restart pushes fresh facts — which
        would kill live sessions. Re-announcing every session's true state
        lets the platform converge without that restart: sessions with a live
        process keep their live status, everything else is idle.

        Repeats within ``REANNOUNCE_MIN_INTERVAL_SECONDS`` are skipped so a
        reconnect storm cannot trigger repeated full scans; the first call
        after start (or after a long outage) always runs.
        """

        async with self._reannounce_lock:
            now = time.monotonic()
            if (self._last_reannounce_at is not None
                    and now - self._last_reannounce_at < REANNOUNCE_MIN_INTERVAL_SECONDS):
                logger.debug(
                    "skipping session state re-announce reason=%s (ran %.1fs ago)",
                    reason,
                    now - self._last_reannounce_at,
                )
                return
            self._last_reannounce_at = now
            try:
                summaries = await self.list_complete_session_inventory()
            except asyncio.CancelledError:
                raise
            except Exception:  # a failed scan must not break the caller
                logger.exception("failed to list sessions for state re-announce")
                return
            announced = 0
            for summary in summaries:
                live = self._live_for_meta(summary)
                try:
                    if live is not None:
                        await self._push_state(live, force=True)
                    else:
                        await self.host.session_state_update(
                            session_id=summary.session_id,
                            runtime=RUNTIME,
                            external_session_id=summary.external_session_id,
                            status="idle",
                            metadata={"sessionFile": summary.external_session_id},
                        )
                    announced += 1
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception(
                        "failed to re-announce session state for %s",
                        summary.session_id,
                    )
            logger.info(
                "reannounced session states reason=%s sessions=%d",
                reason,
                announced,
            )

    def _live_for_meta(self, summary: SessionMeta) -> PiLiveSession | None:
        """Match an inventory entry to its live session.

        Platform-created sessions keep the platform-allocated id as the live
        key while the inventory identifies the same session by a path-derived
        id, so fall back to matching on the session file.
        """

        live = self._live.get(summary.session_id)
        if live is not None:
            return live
        external_id = summary.external_session_id
        if external_id is None:
            return None
        for candidate in self._live.values():
            if candidate.external_id == external_id:
                return candidate
        return None

    async def _reset_stale_running_states(self) -> None:
        """Re-announce states for sessions left running by a previous process.

        A connector restart kills live pi processes before their exit state
        can be published, so the platform keeps showing "running" until the
        next turn. Right after start() this runtime owns no live process,
        which makes the full re-announcement accurate for every session.
        """

        await self.reannounce_session_states(reason="runtime-start")

    async def _reclaim_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(RECLAIM_INTERVAL_SECONDS)
                await self._reclaim_idle_sessions()
            except asyncio.CancelledError:
                raise
            except Exception:  # a failed pass must not kill the loop
                logger.exception("pi idle reclaim pass failed")

    async def _reclaim_idle_sessions(self) -> None:
        """Close pi processes whose sessions stayed idle past the timeout."""

        if self._idle_timeout <= 0:
            return
        now = time.monotonic()
        for session_id in list(self._live):
            live = self._live.get(session_id)
            if live is None:
                continue
            if now - live.last_activity < self._idle_timeout:
                continue
            if live.is_streaming or live.is_compacting or live.pending_ui:
                continue
            # Serialize with _ensure_live so a reviving turn cannot race the close.
            async with self._live_lock(session_id):
                if self._live.get(session_id) is not live:
                    continue
                if now - live.last_activity < self._idle_timeout:
                    continue
                if live.is_streaming or live.is_compacting or live.pending_ui:
                    continue
                self._live.pop(session_id, None)
            logger.info(
                "reclaimed idle pi session session_id=%s idle_seconds=%.0f",
                session_id,
                now - live.last_activity,
            )
            await live.stop()

    # -- discovery / inventory ---------------------------------------------

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        _ = cursor, force
        summaries = await asyncio.to_thread(
            self.directory.list_sessions, limit if limit and limit > 0 else 0
        )
        return tuple(self._session_meta(summary) for summary in summaries)

    async def list_complete_session_inventory(
        self,
        page_size: int = 100,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        _ = page_size, force
        summaries = await asyncio.to_thread(self.directory.list_sessions, 0)
        return tuple(self._session_meta(summary) for summary in summaries)

    def _session_meta(self, summary: PiSessionSummary) -> SessionMeta:
        platform_id = platform_session_id(self.host.session_namespace, summary.path)
        self._known_paths[platform_id] = summary.path
        stamp = (summary.modified_at, summary.size)
        changed = self._synced.get(summary.path) != stamp
        metadata: dict[str, Any] = dict(summary.metadata())
        metadata["sync"] = {
            "changed": changed,
            "requires_timeline_sync": changed,
        }
        live = self._live.get(platform_id)
        if live is not None and live.session_name:
            metadata["sessionName"] = live.session_name
        return SessionMeta(
            session_id=platform_id,
            external_session_id=summary.path,
            runtime=RUNTIME,
            runtime_id=self.config.runtime_id,
            title=summary.title,
            cwd=summary.cwd,
            ordering_time=_iso_from_epoch(summary.modified_at),
            source_state=SessionSourceState(
                availability="available",
                observed_at=_iso_from_epoch(summary.modified_at),
                observation_origin="inventory",
            ),
            metadata=metadata,
        )

    # -- snapshots ----------------------------------------------------------

    def _client_bindings_key(self, external_session_id: str) -> str:
        return f"pi/client-message-bindings/{self.host.connector_id}/{external_session_id}"

    async def _load_client_bindings(
        self,
        external_session_id: str | None,
    ) -> tuple[tuple[str, str], ...]:
        """Client message id pairs persisted for this session, if any."""

        if not external_session_id:
            return ()
        cached = self._client_bindings.get(external_session_id)
        if cached is not None:
            return cached
        pairs: tuple[tuple[str, str], ...] = ()
        try:
            value = await self.host.sync_state_read(self._client_bindings_key(external_session_id))
        except Exception:
            logger.exception(
                "failed to read client message bindings session=%s",
                external_session_id,
            )
            value = None
        if isinstance(value, Mapping):
            raw_bindings = value.get("bindings")
            if isinstance(raw_bindings, list):
                collected: list[tuple[str, str]] = []
                for raw in raw_bindings:
                    if not isinstance(raw, Mapping):
                        continue
                    text = raw.get("text")
                    client_message_id = raw.get("clientMessageId")
                    if isinstance(text, str) and isinstance(client_message_id, str):
                        collected.append((text, client_message_id))
                pairs = tuple(collected)
        self._client_bindings[external_session_id] = pairs
        return pairs

    async def _persist_client_bindings(self, live: PiLiveSession) -> None:
        """Persist the session's optimistic-send pairs for future projections."""

        external_session_id = live.external_id
        if not external_session_id:
            return
        stored = await self._load_client_bindings(external_session_id)
        merged = _merge_client_message_pairs(stored, tuple(live.client_messages))[
            -MAX_CLIENT_MESSAGE_BINDINGS_PER_SESSION:
        ]
        self._client_bindings[external_session_id] = merged
        try:
            await self.host.sync_state_write(
                self._client_bindings_key(external_session_id),
                {
                    "version": CLIENT_MESSAGE_BINDINGS_VERSION,
                    "bindings": [
                        {"text": text, "clientMessageId": client_message_id}
                        for text, client_message_id in merged
                    ],
                },
            )
        except Exception:
            logger.exception(
                "failed to persist client message bindings session=%s",
                external_session_id,
            )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        path = self._resolve_session_path(session_id, external_session_id)
        if path is None:
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=external_session_id,
                runtime=RUNTIME,
                runtime_id=self.config.runtime_id,
                items=(),
                complete=False,
                metadata={"reason": "session file not found"},
            )
        doc = await asyncio.to_thread(load_session_doc, path)
        if doc is None:
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=str(path),
                runtime=RUNTIME,
                runtime_id=self.config.runtime_id,
                items=(),
                complete=False,
                metadata={"reason": "session file unreadable"},
            )
        live = self._live.get(session_id)
        if live is None:
            live = next(
                (
                    candidate
                    for candidate in self._live.values()
                    if candidate.external_id == doc.summary.path
                ),
                None,
            )
        client_messages = tuple(live.client_messages) if live is not None else ()
        client_messages = _merge_client_message_pairs(
            await self._load_client_bindings(doc.summary.path),
            client_messages,
        )
        logger.info(
            "pi project session_id=%s live=%s client_message_pairs=%d",
            session_id,
            live is not None,
            len(client_messages),
        )
        items = projection.project_session(
            doc.entries,
            session_id=session_id,
            external_session_id=doc.summary.path,
            client_messages=client_messages,
        )
        if live is not None and live.stream is not None:
            if live.is_streaming or live.is_compacting:
                # A polling snapshot must not erase output not yet on disk.
                history = items[:-1] if items and items[-1].type == "turn.end" else items
                merged = {item.id: item for item in history}
                merged.update(
                    {item.id: replace(item, session_id=session_id) for item in live.stream.items()}
                )
                items = tuple(sorted(merged.values(), key=lambda item: item.order_seq))
            items = live.stream.reconcile_snapshot(items)
        truncated = limit is not None and limit > 0
        if truncated:
            items = items[-limit:]
        self._synced[doc.summary.path] = (doc.summary.modified_at, doc.summary.size)
        self._known_paths[session_id] = doc.summary.path
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=doc.summary.path,
            runtime=RUNTIME,
            runtime_id=self.config.runtime_id,
            items=items,
            # Only a full read is a Runtime-owned snapshot; a truncated tail must
            # not let the platform replace (and delete) the stored history.
            complete=not truncated,
            metadata={
                "itemCount": len(items),
                "piSessionId": doc.summary.session_id,
            },
        )

    # -- state / notices ----------------------------------------------------

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        live = self._live.get(session_id)
        if live is not None:
            return self._live_state(live)
        path = self._resolve_session_path(session_id, external_session_id)
        if path is None:
            return None
        return SessionState(
            session_id=session_id,
            external_session_id=str(path),
            runtime=RUNTIME,
            runtime_id=self.config.runtime_id,
            status="idle",
            selections={"permission": await self._load_permission(str(path))},
            metadata={"sessionFile": str(path)},
        )

    def _live_state(self, live: PiLiveSession) -> SessionState:
        selections: dict[str, str | None] = {"permission": live.permission_mode}
        selection_id = _model_selection_id(live.model or {})
        if selection_id:
            selections["model"] = selection_id
        if live.thinking_level:
            selections["thinkingLevel"] = live.thinking_level
        status = live.status
        metadata: dict[str, Any] = {"sessionFile": live.session_file}
        if live.pi_session_id:
            metadata["piSessionId"] = live.pi_session_id
        if live.session_name:
            metadata["sessionName"] = live.session_name
        if live.pending_ui:
            metadata["pendingInteractions"] = len(live.pending_ui)
        return SessionState(
            session_id=live.platform_id,
            external_session_id=live.external_id,
            runtime=RUNTIME,
            runtime_id=self.config.runtime_id,
            status=status,  # type: ignore[arg-type]
            status_reason=live.status_reason,
            selections=selections,
            metadata=metadata,
        )

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        _ = external_session_id
        live = self._live.get(session_id)
        if live is None:
            return ()
        return tuple(pending.as_notice(session_id) for pending in live.pending_ui.values())

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        """Runtime-scoped capability facts advertised to the platform.

        The device-runtime capability endpoint (and the new-session composer
        that reads it) uses this set, so attachments must be advertised here as
        well as on individual sessions. It also gives the platform's session
        projection a runtime-scoped fallback for sessions that never published
        their own facts.
        """

        return RuntimeCapabilitySet(
            runtime=RUNTIME,
            revision=2,
            runtime_id=self.config.runtime_id,
            capabilities=tuple(
                RuntimeCapability(
                    capability_id=capability_id,
                    scope="runtime",
                    runtime=RUNTIME,
                    runtime_id=self.config.runtime_id,
                    # No allowedMimeTypes: the AA server matches MIME types literally (no
                    # wildcards) and treats an absent list as "accept every type".
                    metadata={},
                )
                for capability_id in (
                    CAPABILITY_SESSION_SEND_MESSAGE,
                    CAPABILITY_SESSION_INTERRUPT,
                    CAPABILITY_SESSION_STEER,
                    CAPABILITY_SESSION_INTERACTION_APPROVAL,
                    CAPABILITY_SESSION_COMMANDS,
                    CAPABILITY_RUNTIME_ATTACHMENT,
                    CAPABILITY_CATALOG_MODEL,
                    CAPABILITY_CATALOG_EFFORT,
                    CAPABILITY_CATALOG_PERMISSION,
                )
            ),
            metadata={"source": "pi.runtime"},
        )

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        _ = external_session_id
        return self._session_capability_set(session_id)

    def _session_capability_set(self, session_id: str) -> RuntimeCapabilitySet:
        """Capability facts the pi runtime exposes for one platform session."""

        capabilities = tuple(
            RuntimeCapability(
                capability_id=capability_id,
                scope=scope,  # type: ignore[arg-type]
                runtime=RUNTIME,
                runtime_id=self.config.runtime_id,
                session_id=session_id if scope == "session" else None,
                # Absent allowedMimeTypes == accept all (server has no wildcard matching).
                metadata={},
            )
            for capability_id, scope in (
                (CAPABILITY_SESSION_SEND_MESSAGE, "session"),
                (CAPABILITY_SESSION_INTERRUPT, "session"),
                (CAPABILITY_SESSION_STEER, "session"),
                (CAPABILITY_SESSION_INTERACTION_APPROVAL, "session"),
                (CAPABILITY_SESSION_COMMANDS, "session"),
                (CAPABILITY_RUNTIME_ATTACHMENT, "session"),
                (CAPABILITY_CATALOG_MODEL, "runtime"),
                (CAPABILITY_CATALOG_EFFORT, "session"),
                (CAPABILITY_CATALOG_PERMISSION, "runtime"),
            )
        )
        return RuntimeCapabilitySet(
            runtime=RUNTIME,
            revision=2,
            capabilities=capabilities,
            session_id=session_id,
            runtime_id=self.config.runtime_id,
            metadata={"source": "pi.runtime"},
        )

    async def _publish_session_capabilities(self, session_id: str) -> None:
        """Push capability facts so the platform's cached set stays current.

        The platform falls back to persisted capability facts when a live read
        fails, and only runtime capability notifications feed that store. The
        built-in runtimes publish on every state change; pi must do the same
        or snapshot and websocket projections keep an empty capability set.
        """

        try:
            await self.host.session_capabilities_update(self._session_capability_set(session_id))
        except Exception:
            logger.exception("failed to publish pi session capabilities for %s", session_id)

    # -- catalogs -----------------------------------------------------------

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        data = response_data(await self._utility_command({"type": "get_available_models"}))
        # Pi allows the same model name under several providers; the platform
        # rejects catalogs with duplicate ids, so ids are provider-qualified
        # and titles carry the provider when a name is ambiguous.
        entries: list[tuple[Mapping[str, Any], str, str, str | None, str]] = []
        for raw in _as_list(data.get("models")):
            if not isinstance(raw, Mapping):
                continue
            model_id = raw.get("id")
            if not isinstance(model_id, str) or not model_id:
                continue
            catalog_id = _model_selection_id(raw) or model_id
            name = raw.get("name")
            name = name if isinstance(name, str) and name else model_id
            provider = raw.get("provider")
            provider = provider if isinstance(provider, str) and provider else None
            entries.append((raw, catalog_id, name, provider, model_id))
        directory = [(name, provider, model_id) for _, _, name, provider, model_id in entries]
        models: list[RuntimeModelItem] = []
        for raw, catalog_id, name, provider, model_id in entries:
            title = _model_display_title(name, provider, model_id, directory)
            haystack = f"{catalog_id} {name} {title}".lower()
            if query and query.lower() not in haystack:
                continue
            models.append(
                RuntimeModelItem(
                    id=catalog_id,
                    title=title,
                    selection_id=catalog_id,
                    description=provider,
                    metadata={
                        "provider": raw.get("provider"),
                        "contextWindow": raw.get("contextWindow"),
                        "reasoning": raw.get("reasoning") is True,
                    },
                )
            )
            if len(models) >= limit:
                break
        return RuntimeModelCatalog(
            runtime=RUNTIME,
            revision=self._next_catalog_revision(),
            models=tuple(models),
            runtime_id=self.config.runtime_id,
        )

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        return RuntimePermissionCatalog(
            runtime=RUNTIME,
            revision=self._next_catalog_revision(),
            permissions=permission_items(query=query, limit=limit),
            runtime_id=self.config.runtime_id,
        )

    def _next_catalog_revision(self) -> int:
        """Monotonic revision for runtime catalogs.

        The platform ignores a catalog whose revision does not exceed the
        stored one, so a per-process counter stalls every update after a
        connector restart; a millisecond clock stays monotonic across them.
        """

        self._catalog_revision = max(int(time.time() * 1000), self._catalog_revision + 1)
        return self._catalog_revision

    # -- commands -----------------------------------------------------------

    async def list_commands(
        self,
        session_id: str,
        external_session_id: str | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RuntimeCommand, ...]:
        _ = external_session_id
        live = self._live.get(session_id)
        data = (
            await live.command({"type": "get_commands"})
            if live is not None
            else await self._utility_command({"type": "get_commands"})
        )
        commands: list[RuntimeCommand] = []
        for raw in _as_list(response_data(data).get("commands")):
            if not isinstance(raw, Mapping):
                continue
            name = raw.get("name")
            if not isinstance(name, str) or not name:
                continue
            if query and query.lower() not in name.lower():
                continue
            commands.append(
                RuntimeCommand(
                    id=name,
                    title=name,
                    description=raw.get("description")
                    if isinstance(raw.get("description"), str)
                    else None,
                    scope="session",
                    metadata={"source": raw.get("source")},
                )
            )
            if len(commands) >= limit:
                break
        return tuple(commands)

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        live = await self._ensure_live(session_id, external_session_id, None)
        text = raw if raw else "/" + command + (" " + " ".join(args) if args else "")
        logger.info("pi command execute session_id=%s text=%r", session_id, text)
        await live.send_prompt(text)
        return RuntimeCommandResult(
            command=command,
            ok=True,
            message=f"已发送 {text}",
            result={"sessionId": session_id},
        )

    # -- session operations -------------------------------------------------

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
        runtime_options: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        _ = runtime_options
        images, content = await self._prepare_prompt(session_id, content, attachments)
        workdir = self._resolve_cwd(cwd)
        live = PiLiveSession(self, session_id, cwd=workdir)
        if selections and selections.get("permission") is not None:
            live.permission_mode = validate_permission_mode(selections["permission"])
            live._permission_loaded = True
        if client_message_id:
            live.client_messages.append((_prompt_text(content, images), client_message_id))
        self._live[session_id] = live
        await live.ensure_started()
        if is_meaningful_title(title):
            await live.command({"type": "set_session_name", "name": title})
        if selections:
            await self._apply_selections(live, selections)
        await live.send_prompt(content, images=images)
        if client_message_id:
            await self._persist_client_bindings(live)
        await self._push_meta(live)
        await self._push_state(live, force=True)
        return RuntimeOperationResult(
            result={"sessionId": session_id, "externalSessionId": live.external_id}
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        images, content = await self._prepare_prompt(session_id, content, attachments)
        live = await self._ensure_live(session_id, external_session_id, cwd)
        logger.info(
            "pi turn start session_id=%s client_message_id=%s",
            session_id,
            client_message_id,
        )
        if client_message_id:
            live.client_messages.append((_prompt_text(content, images), client_message_id))
            await self._persist_client_bindings(live)
        if selections:
            await self._apply_selections(live, selections)
        behavior = "followUp" if (live.is_streaming or live.is_compacting) else None
        await live.send_prompt(content, streaming_behavior=behavior, images=images)
        return RuntimeOperationResult(
            result={"sessionId": session_id, "queued": behavior is not None}
        )

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        images, content = await self._prepare_prompt(session_id, content, attachments)
        live = await self._ensure_live(session_id, external_session_id, None)
        if client_message_id:
            live.client_messages.append((_prompt_text(content, images), client_message_id))
            await self._persist_client_bindings(live)
        if live.is_streaming:
            await live.send_prompt(content, streaming_behavior="steer", images=images)
            return RuntimeOperationResult(result={"sessionId": session_id, "steered": True})
        await live.send_prompt(content, images=images)
        return RuntimeOperationResult(result={"sessionId": session_id, "steered": False})

    async def interrupt_session(
        self,
        session_id: str,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        _ = reason
        live = self._live.get(session_id)
        if live is None or not live.alive:
            return RuntimeOperationResult(result={"sessionId": session_id, "noop": True})
        if not (live.is_streaming or live.is_compacting):
            return RuntimeOperationResult(result={"sessionId": session_id, "noop": True})
        await live.command({"type": "abort"}, timeout=max(self.request_timeout, 120.0))
        return RuntimeOperationResult(result={"sessionId": session_id})

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        live = await self._ensure_live(session_id, external_session_id, None)
        await self._apply_selections(live, selections)
        await self._push_state(live, force=True)
        return RuntimeOperationResult(result={"sessionId": session_id})

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        live = self._live.get(session_id)
        if live is None:
            return RuntimeOperationResult(
                ok=False,
                code="pi_interaction_expired",
                message="该交互已失效（会话进程不在运行）。",
            )
        request_id = notice_id.removeprefix("pi-ui-")
        pending = live.pending_ui.get(request_id)
        if pending is None:
            return RuntimeOperationResult(
                ok=False,
                code="pi_interaction_expired",
                message="该交互已处理或已失效。",
            )
        payload = pending.response_payload(action_id, input_data)
        assert live.process is not None
        await live.process.notify(payload)
        live.pending_ui.pop(request_id, None)
        await self.host.notice_upsert(
            pending.as_notice(session_id, status="resolved", action_id=action_id)
        )
        await self._push_state(live, force=True)
        return RuntimeOperationResult(
            result={"resolved": True, "noticeId": notice_id, "sessionId": session_id}
        )

    # -- live event handling ------------------------------------------------

    async def handle_live_event(self, live: PiLiveSession, record: Mapping[str, Any]) -> None:
        live.touch()
        event_type = record.get("type")
        if event_type in STREAM_EVENT_TYPES and live.stream is not None:
            await live.stream.handle_event(record)
        if event_type == "extension_ui_request":
            await self._handle_ui_request(live, record)
            return
        if event_type == "message_end":
            message = record.get("message")
            if isinstance(message, Mapping) and message.get("role") == "assistant":
                live.message_count += 1
            return
        if event_type == "agent_start":
            live.status_reason = None
            live.is_streaming = True
            await self._push_state(live)
            return
        if event_type == "agent_settled":
            if live.stream is not None:
                await live.stream.flush()
            live.is_streaming = False
            live.is_compacting = False
            live.status_reason = None
            await self._push_state(live, force=True)
            await self._publish_timeline(live)
            await self._reset_stream(live)
            await self._push_meta(live)
            try:
                await self.host.session_turn_ended(
                    session_id=live.platform_id,
                    runtime=RUNTIME,
                    external_session_id=live.external_id,
                    outcome="completed",
                )
            except Exception:
                logger.exception("failed to publish turn end for %s", live.platform_id)
            return
        if event_type == "compaction_start":
            live.is_compacting = True
            await self._push_state(live)
            return
        if event_type == "compaction_end":
            live.is_compacting = False
            await self._push_state(live, force=True)
            return
        if event_type == "thinking_level_changed":
            level = record.get("level")
            if isinstance(level, str):
                live.thinking_level = level
                await self._push_state(live)
            return
        if event_type == "session_info_changed":
            name = record.get("name")
            live.session_name = name if isinstance(name, str) and name else None
            await self._push_meta(live)
            return
        if event_type == "auto_retry_start":
            message = record.get("errorMessage")
            live.status_reason = f"retrying: {message}" if isinstance(message, str) else "retrying"
            await self._push_state(live, force=True)
            return
        if event_type == "extension_error":
            logger.warning(
                "pi extension error session=%s extension=%s event=%s",
                live.platform_id,
                record.get("extensionPath"),
                record.get("event"),
            )

    async def handle_live_exit(self, live: PiLiveSession, code: int | None) -> None:
        logger.info("pi session %s process exited code=%s", live.platform_id, code)
        if live.stream is not None:
            await live.stream.close()
        if self._stopping:
            return
        live.is_streaming = False
        live.is_compacting = False
        for pending in list(live.pending_ui.values()):
            await self.host.notice_upsert(pending.as_notice(live.platform_id, status="resolved"))
        live.pending_ui.clear()
        if live.restarting:
            return
        try:
            await self.host.session_state_update(
                session_id=live.platform_id,
                runtime=RUNTIME,
                external_session_id=live.external_id,
                status="idle",
                metadata={
                    "sessionFile": live.session_file,
                    "processExitCode": code,
                },
            )
        except Exception:
            logger.exception("failed to publish exit state for %s", live.platform_id)

    async def _handle_ui_request(self, live: PiLiveSession, record: Mapping[str, Any]) -> None:
        method = record.get("method")
        if method in DIALOG_METHODS:
            items = live.stream.items() if live.stream is not None else ()
            pending = PendingInteraction(
                record,
                external_session_id=live.external_id,
                turn_id=(items[-1].turn_id or "") if items else "",
            )
            live.pending_ui[pending.request_id] = pending
            await self.host.notice_upsert(pending.as_notice(live.platform_id))
            await self._push_state(live, force=True)
            return
        if method == "notify":
            message = record.get("message")
            if not isinstance(message, str) or not message:
                return
            notify_type = record.get("notifyType")
            severity = notify_type if notify_type in ("info", "warning", "error") else "info"
            request_id = str(record.get("id"))
            await self.host.notice_upsert(
                SessionNotice(
                    notice_id=f"pi-notify-{request_id}",
                    session_id=live.platform_id,
                    runtime=RUNTIME,
                    type="notification",
                    title=message,
                    severity=severity,  # type: ignore[arg-type]
                    status="open",
                    source={"runtime": RUNTIME, "component": "pi.extension-ui"},
                )
            )
            return
        logger.debug("ignoring pi extension UI method %r", method)

    # -- internal helpers ---------------------------------------------------

    async def _ensure_live(
        self,
        session_id: str,
        external_session_id: str | None,
        cwd: str | None,
    ) -> PiLiveSession:
        live = self._live.get(session_id)
        if live is None:
            # Resolve the target first; installation below is synchronous, so two
            # concurrent RPCs for the same session share one live session (and one
            # pi process) instead of overwriting each other.
            session_path: str | None = None
            workdir = self._resolve_cwd(cwd)
            resolved = self._resolve_session_path(session_id, external_session_id)
            if resolved is not None:
                session_path = str(resolved)
                doc_cwd = await asyncio.to_thread(self._session_cwd, resolved)
                if doc_cwd:
                    workdir = doc_cwd
            elif external_session_id:
                session_path = external_session_id
            async with self._live_lock(session_id):
                live = self._live.get(session_id)
                if live is None:
                    live = PiLiveSession(
                        self,
                        session_id,
                        cwd=workdir,
                        session_path=session_path,
                    )
                    self._live[session_id] = live
        await live.ensure_started()
        return live

    def _live_lock(self, session_id: str) -> asyncio.Lock:
        lock = self._live_locks.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            self._live_locks[session_id] = lock
        return lock

    @staticmethod
    def _session_cwd(path: Path) -> str | None:
        try:
            with path.open("rb") as handle:
                header = json.loads(handle.readline())
        except (OSError, ValueError):
            return None
        cwd = header.get("cwd") if isinstance(header, Mapping) else None
        if isinstance(cwd, str) and Path(cwd).is_dir():
            return cwd
        return None

    def _resolve_cwd(self, cwd: str | None) -> str:
        candidate = Path(cwd).expanduser() if cwd else Path(self.default_cwd).expanduser()
        if not candidate.is_dir():
            raise RuntimeInvalidRequestError(f"working directory does not exist: {candidate}")
        return str(candidate)

    def _resolve_session_path(
        self,
        session_id: str,
        external_session_id: str | None,
    ) -> Path | None:
        candidates: list[str] = []
        if external_session_id:
            external_path = Path(external_session_id)
            if self._within_sessions_root(external_path):
                candidates.append(external_session_id)
            else:
                logger.warning("ignoring session path outside sessionsDir: %s", external_session_id)
        live = self._live.get(session_id)
        if live is not None and live.session_file:
            candidates.append(live.session_file)
        known = self._known_paths.get(session_id)
        if known:
            candidates.append(known)
        for candidate in candidates:
            path = Path(candidate)
            if path.is_file():
                return path
        # Fall back to a scan when the platform id is not yet known.
        for summary in self.directory.list_sessions(limit=0):
            if platform_session_id(self.host.session_namespace, summary.path) == session_id:
                self._known_paths[session_id] = summary.path
                return Path(summary.path)
        return None

    def _within_sessions_root(self, path: Path) -> bool:
        """Whether a platform-supplied path stays inside the sessions directory."""

        try:
            path.resolve().relative_to(self.directory.root.resolve())
        except (OSError, ValueError):
            return False
        return True

    async def _prepare_prompt(
        self,
        session_id: str,
        content: str,
        attachments: tuple[RuntimeAttachment, ...],
    ) -> tuple[tuple[Mapping[str, Any], ...], str]:
        images, note = await prepare_attachments(self.host, session_id, attachments)
        return images, f"{content}\n\n{note}" if note else content

    async def _reset_stream(self, live: PiLiveSession) -> None:
        if not live.external_id:
            return
        doc = await asyncio.to_thread(load_session_doc, Path(live.external_id))
        entries = doc.entries if doc is not None else ()
        if live.stream is None:
            live.stream = PiStreamAccumulator(
                session_id=live.platform_id,
                external_session_id=live.external_id,
                entries=entries,
                client_messages=tuple(live.client_messages),
                publish=self.host.timeline_item_upsert,
            )
        else:
            await live.stream.reset(entries=entries, client_messages=tuple(live.client_messages))

    def _permission_key(self, external_session_id: str) -> str:
        return f"pi/permission/{self.host.connector_id}/{external_session_id}"

    async def _load_permission(self, external_session_id: str | None) -> str:
        if external_session_id:
            value = await self.host.sync_state_read(self._permission_key(external_session_id))
            if isinstance(value, Mapping) and value.get("mode") in PERMISSION_MODES:
                return str(value["mode"])
        return self.default_permission_mode

    async def _persist_permission(self, live: PiLiveSession) -> None:
        if live.external_id:
            self._known_paths[live.platform_id] = live.external_id
            await self.host.sync_state_write(
                self._permission_key(live.external_id), {"mode": live.permission_mode}
            )

    async def _change_permission(self, live: PiLiveSession, mode: str) -> None:
        if live.permission_mode == mode:
            await self._persist_permission(live)
            return
        model = dict(live.model or {})
        thinking = live.thinking_level
        live.restarting = True
        try:
            # Finish pending dialogs as denials before interrupting this run.
            if live.process is not None:
                for pending in list(live.pending_ui.values()):
                    await live.process.notify(pending.response_payload("reject", None))
                    await self.host.notice_upsert(
                        pending.as_notice(live.platform_id, status="resolved", action_id="reject")
                    )
                live.pending_ui.clear()
                if live.is_streaming or live.is_compacting:
                    await live.command({"type": "abort"})
            await live.stop()
            live.is_streaming = False
            live.is_compacting = False
            live.permission_mode = mode
            live._permission_loaded = True
            await self._persist_permission(live)
            await live.ensure_started()
            # Pi normally restores these from the session. Preserve in-memory
            # selections as well, including selections made before the first turn.
            if model.get("id"):
                payload = {"type": "set_model", "modelId": model["id"]}
                if model.get("provider"):
                    payload["provider"] = model["provider"]
                await live.command(payload)
                live.model = model
            if thinking:
                await live.command({"type": "set_thinking_level", "level": thinking})
                live.thinking_level = thinking
        finally:
            live.restarting = False

    async def _apply_selections(
        self,
        live: PiLiveSession,
        selections: Mapping[str, str | None],
    ) -> None:
        mode = selections.get("permission")
        if mode is not None:
            mode = validate_permission_mode(mode)
        async with live._selection_lock:
            if mode is not None:
                await self._change_permission(live, mode)
            await self._apply_model_selections(live, selections)

    async def _apply_model_selections(
        self, live: PiLiveSession, selections: Mapping[str, str | None]
    ) -> None:
        for key, value in selections.items():
            if value is None:
                continue
            if key == "model":
                provider, model_id = _split_model_selection(value)
                payload: dict[str, Any] = {"type": "set_model", "modelId": model_id}
                if provider:
                    payload["provider"] = provider
                data = response_data(await live.command(payload))
                nested = data.get("model")
                model = nested if isinstance(nested, Mapping) else data
                if isinstance(model.get("id"), str):
                    live.model = dict(model)
            elif key in ("thinkingLevel", "effort", "reasoningEffort"):
                await live.command({"type": "set_thinking_level", "level": value})
                live.thinking_level = value
            else:
                logger.debug("ignoring unknown selection key %r", key)

    async def _push_state(self, live: PiLiveSession, *, force: bool = False) -> None:
        key = live.state_key()
        if not force and key == live.last_state_key:
            return
        state = self._live_state(live)
        logger.info(
            "pi state push session_id=%s status=%s force=%s",
            state.session_id,
            state.status,
            force,
        )
        try:
            await self.host.session_state_update(
                session_id=state.session_id,
                runtime=RUNTIME,
                status=state.status,  # type: ignore[arg-type]
                selections=state.selections,
                external_session_id=state.external_session_id,
                status_reason=state.status_reason,
                error=state.error,
                metadata=state.metadata,
            )
            live.last_state_key = key
        except Exception:
            logger.exception("failed to push pi session state for %s", live.platform_id)
            return
        await self._publish_session_capabilities(live.platform_id)

    async def _push_meta(self, live: PiLiveSession) -> None:
        path = live.session_file or live.session_path
        summary = await asyncio.to_thread(self.directory.find_by_path, path) if path else None
        try:
            await self.host.session_meta_upsert(
                session_id=live.platform_id,
                runtime=RUNTIME,
                external_session_id=path,
                title=(summary.title if summary is not None else live.session_name),
                cwd=(summary.cwd if summary is not None else live.cwd),
                ordering_time=(
                    _iso_from_epoch(summary.modified_at) if summary is not None else None
                ),
                metadata=(summary.metadata() if summary is not None else {"piSessionFile": path}),
            )
        except Exception:
            logger.exception("failed to push pi session meta for %s", live.platform_id)

    async def _publish_timeline(self, live: PiLiveSession) -> None:
        path = live.session_file or live.session_path
        if not path or not Path(path).is_file():
            return
        snapshot = await self.get_session_snapshot(live.platform_id, path)
        if not snapshot.complete:
            return
        try:
            await self.host.timeline_sync(
                session_id=live.platform_id,
                runtime=RUNTIME,
                items=snapshot.items,
                external_session_id=snapshot.external_session_id,
                complete=True,
            )
        except Exception:
            logger.exception("failed to push pi timeline for %s", live.platform_id)

    # -- utility process ----------------------------------------------------

    async def _ensure_utility(self) -> PiRpcProcess:
        if self._utility is not None and self._utility.alive:
            return self._utility
        process = PiRpcProcess(
            [
                *self.command(),
                "--mode",
                "rpc",
                "--no-session",
                "--extension",
                str(APPROVAL_EXTENSION_PATH),
            ],
            cwd=self.default_cwd,
            env={"PI_AA_PERMISSION_MODE": self.default_permission_mode},
            request_timeout=self.request_timeout,
        )
        await process.start()
        self._utility = process
        return process

    async def _utility_command(self, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        process = await self._ensure_utility()
        return await process.request(payload)


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _prompt_text(content: str, images: Sequence[Mapping[str, Any]]) -> str:
    """Match the persisted user message, including projected image placeholders."""

    return projection.content_text([{"type": "text", "text": content}, *images])
