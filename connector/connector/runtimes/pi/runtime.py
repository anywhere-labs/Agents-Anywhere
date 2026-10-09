"""PiRuntime: one ``pi --mode rpc`` process per live session.

The runtime is a *polling* runtime: the connector periodically asks it for the
session inventory and reshapes Pi session files into platform timeline items.
Live sessions also stream assistant and tool progress and push an authoritative
snapshot when a run settles.
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import json
import logging
import time
from collections.abc import Mapping, Sequence
from dataclasses import asdict, replace
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
    InputRequestForm,
    InputRequestOption,
    InputRequestQuestion,
    InputRequestValidationError,
    PreparedSessionTimelineSync,
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
    RuntimeReasoningItem,
    RuntimeTimelineItem,
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
    PiRpcError,
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
# select / input / editor dialogs are answered through the platform's
# inputRequest v1 form, as a single question with this id.
DIALOG_QUESTION_ID = "answer"

# Pi resolves a dialog itself once its timeout passes, without an RPC event.
# Expire the platform notice shortly after so the session is not left blocked.
DIALOG_TIMEOUT_GRACE_SECONDS = 1.0

# Per session file: the file stamp and item fingerprints of the last timeline
# the platform accepted. Bump the version to force one complete resync.
TIMELINE_CHECKPOINT_VERSION = 1
TURN_MARKER_TYPES = frozenset({"turn.start", "turn.end"})

# Pi thinking levels, lowest first. A reasoning model's catalog entry offers
# the ones it supports as reasoning items whose selection id is
# ``<model selection id>#<level>``, the platform's single model selection.
THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
THINKING_LABELS = {
    "off": "Off",
    "minimal": "Minimal",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra high",
    "max": "Max",
}
THINKING_SEPARATOR = "#"

# A prompt that runs an extension command is answered only after the command
# handler finishes, which can wait on a dialog the user answers in AA. Report
# such a prompt as accepted after this long and keep waiting in the background.
PROMPT_ACCEPT_SECONDS = 10.0

# Pi's built-in /compact is not in get_commands; AA offers it like Codex does.
COMPACT_COMMAND = "compact"


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


def supported_thinking_levels(model: Mapping[str, Any]) -> tuple[str, ...]:
    """The thinking levels Pi accepts for a model (pi-ai getSupportedThinkingLevels).

    A model without reasoning only runs with thinking ``off``, which is no
    choice, so it has none. A level mapped to null is unsupported; ``xhigh``
    and ``max`` must be mapped explicitly.
    """

    if model.get("reasoning") is not True:
        return ()
    level_map = model.get("thinkingLevelMap")
    level_map = level_map if isinstance(level_map, Mapping) else {}
    levels: list[str] = []
    for level in THINKING_LEVELS:
        if level in level_map and level_map[level] is None:
            continue
        if level in ("xhigh", "max") and level not in level_map:
            continue
        levels.append(level)
    return tuple(levels)


def _thinking_selection_id(model_selection_id: str, level: str) -> str:
    return f"{model_selection_id}{THINKING_SEPARATOR}{level}"


def _session_model_selection(
    model: Mapping[str, Any] | None, thinking_level: str | None
) -> str | None:
    """The catalog selection a session runs with: its reasoning item if any."""

    selection_id = _model_selection_id(model or {})
    if selection_id and thinking_level in supported_thinking_levels(model or {}):
        return _thinking_selection_id(selection_id, str(thinking_level))
    return selection_id


def _split_thinking_selection(value: str) -> tuple[str, str | None]:
    """Split ``provider:model#level`` into the model selection and the level."""

    model_value, separator, level = value.rpartition(THINKING_SEPARATOR)
    if separator and model_value and level in THINKING_LEVELS:
        return model_value, level
    return value, None


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
        placeholder = request.get("placeholder")
        self.placeholder = placeholder if isinstance(placeholder, str) else None
        prefill = request.get("prefill")
        self.prefill = prefill if isinstance(prefill, str) else None
        timeout = request.get("timeout")
        self.timeout_ms = timeout if isinstance(timeout, int) else None
        self.approval = parse_approval_request(request)
        # Form option id -> the exact option string Pi expects back.
        self.choices: dict[str, str] = {}
        self.form: InputRequestForm | None = None
        if self.approval is None and self.method in ("select", "input", "editor"):
            self.form = self._build_form()
        self.external_session_id = external_session_id
        self.turn_id = turn_id
        # Set for dialogs a run opened; that run settling means Pi closed them.
        self.during_run = False
        self.expiry: asyncio.Task[None] | None = None

    def cancel_expiry(self) -> None:
        if self.expiry is not None and self.expiry is not asyncio.current_task():
            self.expiry.cancel()
        self.expiry = None

    def _build_form(self) -> InputRequestForm:
        options: list[InputRequestOption] = []
        if self.method == "select":
            for index, option in enumerate(self.options):
                if not option.strip():
                    continue
                option_id = f"o_{index}"
                self.choices[option_id] = option
                options.append(InputRequestOption(option_id=option_id, label=option))
        prompt = (self.message or "").strip() or self.title.strip() or "Pi 需要你的输入"
        # The v1 form has no default value: show what Pi offers to edit, so
        # the answer can start from it. The answer replaces it as a whole.
        if self.method == "input" and self.placeholder and self.placeholder.strip():
            prompt += f"\n\n提示：{self.placeholder.strip()}"
        if self.method == "editor" and self.prefill and self.prefill.strip():
            prompt += f"\n\n当前内容（提交的文本会整体替换它）：\n{self.prefill}"
        return InputRequestForm(
            questions=(
                InputRequestQuestion(
                    question_id=DIALOG_QUESTION_ID,
                    prompt=prompt,
                    options=tuple(options),
                    # A select without usable options can still be answered.
                    allow_custom=not options,
                ),
            )
        )

    def _form_value(self, data: Mapping[str, Any]) -> str:
        assert self.form is not None
        try:
            answer = self.form.parse_answers(data)[DIALOG_QUESTION_ID]
        except InputRequestValidationError as exc:
            raise RuntimeInvalidRequestError(str(exc)) from exc
        if answer.option_ids:
            return self.choices[answer.option_ids[0]]
        # parse_answers trims; keep editor text exactly as submitted.
        return str(data["answers"][DIALOG_QUESTION_ID]["customText"])

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
        # The platform only accepts its own interaction types; the Pi dialog
        # method stays in the context.
        context: dict[str, Any] = {"method": self.method, "requestId": self.request_id}
        cancel = {"actionId": "cancel", "label": "取消", "style": "secondary"}
        if self.form is None:
            interaction_type = "confirmation"
            actions = [{"actionId": "confirm", "label": "确认", "style": "primary"}, cancel]
        else:
            interaction_type = "input_request"
            actions = [self.form.action(label="提交"), cancel]
            if self.method != "select":
                context["inputKind"] = "text"
                context["multiline"] = self.method == "editor"
        return SessionNotice(
            notice_id=self.notice_id,
            session_id=session_id,
            runtime=RUNTIME,
            type="interaction",
            interaction_type=interaction_type,
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
        # select / input / editor all answer with a string value: the form
        # answer, or a direct value from callers that bypass the form.
        value = data.get("value")
        if not isinstance(value, str):
            value = data.get("text") if isinstance(data.get("text"), str) else None
        if value is None and "answers" in data and self.form is not None:
            value = self._form_value(data)
        if value is None and self.method == "select":
            if action_id not in self.options:
                raise RuntimeInvalidRequestError("请选择一个选项。")
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
        # How the current run ends: the last assistant stopReason, and whether
        # the platform asked to interrupt it.
        self.run_stop_reason: str | None = None
        self.abort_requested = False
        self.pending_ui: dict[str, PendingInteraction] = {}
        # (text, clientMessageId) pairs waiting for their projected user message.
        self.client_messages: list[tuple[str, str]] = []
        # clientMessageId -> what the user sent ({"text", "attachments"}) when
        # Pi stores a different prompt (attachment notes, image blocks).
        self.client_displays: dict[str, dict[str, Any]] = {}
        # Prompts Pi has not answered yet, such as extension commands waiting
        # on a dialog; the session is not idle while any is in flight.
        self.pending_prompts: set[asyncio.Future[Mapping[str, Any]]] = set()
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
    def busy(self) -> bool:
        """Running, compacting, asking, or still handling a prompt."""

        return bool(
            self.is_streaming or self.is_compacting or self.pending_ui or self.pending_prompts
        )

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
                try:
                    await self.refresh_state()
                except PiRpcError as exc:
                    logger.warning(
                        "pi session %s started but get_state failed: %s",
                        self.platform_id,
                        exc,
                    )
                await self.runtime._reset_stream(self)
                await self.runtime._persist_permission(self)
            except BaseException:
                # Never keep a process the next call would take as initialised.
                self.process = None
                await process.close()
                raise

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
    ) -> str:
        """Send a prompt and return Pi's disposition, or ``pending``.

        ``pending`` means Pi took the prompt but is still running it as an
        extension command (for example waiting on a dialog answer).
        """

        if streaming_behavior == "steer":
            payload: dict[str, Any] = {"type": "steer", "message": content}
            if images:
                payload["images"] = list(images)
            await self.command(payload)
            return "queued"
        payload = {"type": "prompt", "message": content}
        if images:
            payload["images"] = list(images)
        if streaming_behavior:
            payload["streamingBehavior"] = streaming_behavior
        response = await self.submit_command(payload)
        if response is None:
            return "pending"
        disposition = response_data(response).get("disposition")
        return disposition if isinstance(disposition, str) else "started"

    async def submit_command(
        self,
        payload: Mapping[str, Any],
        *,
        accept_seconds: float | None = None,
    ) -> Mapping[str, Any] | None:
        """Send a command that may run for long; ``None`` if still running.

        Pi answers quickly when it rejects a command, so one still running
        after ``accept_seconds`` was accepted. Its later failure is only logged.
        """

        await self.ensure_started()
        self.touch()
        process = self.process
        if process is None:
            raise PiRpcProcessExited("Pi RPC process is not running")
        _request_id, future = await process.submit(payload)
        try:
            done, _pending = await asyncio.wait(
                {future},
                timeout=PROMPT_ACCEPT_SECONDS if accept_seconds is None else accept_seconds,
            )
        except asyncio.CancelledError:
            self._track_prompt(future, str(payload.get("type")))
            raise
        if done:
            return future.result()
        self._track_prompt(future, str(payload.get("type")))
        return None

    def _track_prompt(self, future: asyncio.Future[Mapping[str, Any]], kind: str) -> None:
        self.pending_prompts.add(future)

        def finished(done: asyncio.Future[Mapping[str, Any]]) -> None:
            self.pending_prompts.discard(done)
            self.touch()
            if done.cancelled():
                return
            error = done.exception()
            if error is not None:
                logger.warning(
                    "pi %s failed after it was accepted session_id=%s: %s",
                    kind,
                    self.platform_id,
                    error,
                )
                return
            # An extension command records its result (custom messages) when
            # its handler returns; no run settles to publish it.
            self.runtime._schedule_publish(self)

        future.add_done_callback(finished)

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
            _session_model_selection(self.model, self.thinking_level),
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
        # Platform-allocated ids persisted in the session index (id -> path).
        self._indexed_paths: dict[str, str] = {}
        # Committed (mtime, size) per session file. Loaded lazily from the
        # timeline checkpoints and advanced only after the platform accepted a
        # sync, so a read or a failed upload never marks a file as synced.
        self._synced: dict[str, tuple[float, int]] = {}
        self._synced_loaded: set[str] = set()
        # Oversized session files and the file stamp last reported for each.
        self._oversized: dict[str, tuple[float, int]] = {}
        # Live-stream item ids per session file that no committed sync has
        # reconciled yet. A final timeline without them must replace history.
        self._stream_ids: dict[str, set[str]] = {}
        self._utility: PiRpcProcess | None = None
        self._utility_lock = asyncio.Lock()
        self._catalog_revision = 0
        self._stopping = False
        self._reclaim_task: asyncio.Task[None] | None = None
        self._stale_reset_task: asyncio.Task[None] | None = None
        self._publish_tasks: set[asyncio.Task[None]] = set()
        self._client_bindings: dict[str, tuple[tuple[str, str], ...]] = {}
        self._client_displays: dict[str, dict[str, dict[str, Any]]] = {}
        # Model objects from the last catalog read, by model selection id.
        self._catalog_models: dict[str, Mapping[str, Any]] = {}
        # Per session file: the file stamp and the selections Pi restores from it.
        self._file_selections: dict[str, tuple[tuple[float, int], dict[str, str]]] = {}
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
        """Push this instance's runtime-scoped facts so the platform persists them.

        Sessions that never published their own facts fall back to these.
        """

        try:
            await self.host.runtime_capabilities_update(await self.get_runtime_capabilities())
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
        for task in list(self._publish_tasks):
            task.cancel()
        await asyncio.gather(*self._publish_tasks, return_exceptions=True)
        for live in list(self._live.values()):
            await live.stop()
        self._live.clear()
        self._live_locks.clear()
        async with self._utility_lock:
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
            try:
                summaries = await self.list_complete_session_inventory(report=False)
            except asyncio.CancelledError:
                raise
            except Exception:  # a failed scan must not break the caller
                logger.exception("failed to list sessions for state re-announce")
                return
            announced = 0
            failed = False
            covered: set[int] = set()
            for summary in summaries:
                live = self._live_for_meta(summary)
                try:
                    if live is not None:
                        covered.add(id(live))
                        if not await self._push_state(live, force=True):
                            failed = True
                            continue
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
                    failed = True
                    logger.exception(
                        "failed to re-announce session state for %s",
                        summary.session_id,
                    )
            # A new session's file appears only once Pi saves its first entry,
            # so a running first turn is live but not yet in the inventory.
            for live in list(self._live.values()):
                if id(live) in covered:
                    continue
                if await self._push_state(live, force=True):
                    announced += 1
                else:
                    failed = True
            # Only a complete pass starts the cooldown: a cancelled or partly
            # failed one (e.g. the connection dropped again) must not suppress
            # the next reconnect's re-announcement.
            if not failed:
                self._last_reannounce_at = now
            logger.info(
                "reannounced session states reason=%s sessions=%d failed=%s",
                reason,
                announced,
                failed,
            )

    def _live_for(
        self,
        session_id: str,
        external_session_id: str | None,
    ) -> PiLiveSession | None:
        """Find the live session for a platform id or its session file.

        Platform-created sessions keep the platform-allocated id as the live
        key while the inventory identifies the same session by a path-derived
        id, so fall back to matching on the session file.
        """

        live = self._live.get(session_id)
        if live is not None or not external_session_id:
            return live
        for candidate in self._live.values():
            if candidate.external_id == external_session_id:
                return candidate
        return None

    def _live_for_meta(self, summary: SessionMeta) -> PiLiveSession | None:
        return self._live_for(summary.session_id, summary.external_session_id)

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
            if live.busy:
                continue
            # Serialize with _ensure_live so a reviving turn cannot race the close.
            async with self._live_lock(session_id):
                if self._live.get(session_id) is not live:
                    continue
                if now - live.last_activity < self._idle_timeout:
                    continue
                if live.busy:
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
        await self._load_synced_stamps(summaries)
        return tuple(self._session_meta(summary) for summary in summaries)

    async def list_complete_session_inventory(
        self,
        page_size: int = 100,
        force: bool = False,
        *,
        report: bool = True,
    ) -> tuple[SessionMeta, ...]:
        """``report=False`` reads without consuming the scanner's change flags."""

        _ = page_size, force
        summaries = await asyncio.to_thread(self.directory.list_sessions, 0)
        await self._load_synced_stamps(summaries)
        return tuple(self._session_meta(summary, report=report) for summary in summaries)

    async def _load_synced_stamps(self, summaries: Sequence[PiSessionSummary]) -> None:
        """Seed committed file stamps from the persisted timeline checkpoints."""

        for summary in summaries:
            if summary.path in self._synced_loaded:
                continue
            checkpoint = await self._read_timeline_checkpoint(summary.path)
            stamp = _checkpoint_stamp(checkpoint)
            if stamp is not None:
                self._synced.setdefault(summary.path, stamp)
            self._synced_loaded.add(summary.path)

    def _session_meta(self, summary: PiSessionSummary, *, report: bool = True) -> SessionMeta:
        platform_id = platform_session_id(self.host.session_namespace, summary.path)
        self._known_paths[platform_id] = summary.path
        stamp = (summary.modified_at, summary.size)
        source_state = SessionSourceState(
            availability="available",
            observed_at=_iso_from_epoch(summary.modified_at),
            observation_origin="inventory",
        )
        if summary.oversized:
            # Too large to parse: list it as unavailable, never sync history.
            changed = self._oversized.get(summary.path) != stamp
            if report:
                self._oversized[summary.path] = stamp
            sync = {"changed": changed, "requires_timeline_sync": False}
            source_state = replace(
                source_state, availability="unavailable", reason="history_too_large"
            )
        else:
            changed = self._synced.get(summary.path) != stamp
            sync = {"changed": changed, "requires_timeline_sync": changed}
        metadata: dict[str, Any] = dict(summary.metadata())
        metadata["sync"] = sync
        live = self._live_for(platform_id, summary.path)
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
            source_state=source_state,
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
        displays: dict[str, dict[str, Any]] = {}
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
                        display = raw.get("display")
                        if isinstance(display, Mapping):
                            displays[client_message_id] = dict(display)
                pairs = tuple(collected)
        self._client_bindings[external_session_id] = pairs
        self._client_displays[external_session_id] = displays
        return pairs

    async def _load_client_displays(
        self, external_session_id: str | None
    ) -> dict[str, dict[str, Any]]:
        if not external_session_id:
            return {}
        await self._load_client_bindings(external_session_id)
        return self._client_displays.get(external_session_id, {})

    async def _persist_client_bindings(self, live: PiLiveSession) -> None:
        """Persist the session's optimistic-send pairs for future projections."""

        external_session_id = live.external_id
        if not external_session_id:
            return
        stored = await self._load_client_bindings(external_session_id)
        merged = _merge_client_message_pairs(stored, tuple(live.client_messages))[
            -MAX_CLIENT_MESSAGE_BINDINGS_PER_SESSION:
        ]
        kept = {client_message_id for _text, client_message_id in merged}
        displays = {
            client_message_id: display
            for client_message_id, display in {
                **self._client_displays.get(external_session_id, {}),
                **live.client_displays,
            }.items()
            if client_message_id in kept
        }
        self._client_bindings[external_session_id] = merged
        self._client_displays[external_session_id] = displays
        try:
            await self.host.sync_state_write(
                self._client_bindings_key(external_session_id),
                {
                    "version": CLIENT_MESSAGE_BINDINGS_VERSION,
                    "bindings": [
                        {
                            "text": text,
                            "clientMessageId": client_message_id,
                            **(
                                {"display": displays[client_message_id]}
                                if client_message_id in displays
                                else {}
                            ),
                        }
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
        snapshot, _stamp = await self._read_snapshot(session_id, external_session_id, limit)
        return snapshot

    async def _read_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> tuple[RuntimeTimelineSnapshot, tuple[float, int] | None]:
        """Project a session file; the stamp identifies the file version read."""

        path = await self._resolve_session_path(session_id, external_session_id)
        if path is None:
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=external_session_id,
                runtime=RUNTIME,
                runtime_id=self.config.runtime_id,
                items=(),
                complete=False,
                metadata={"reason": "session file not found"},
            ), None
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
            ), None
        live = self._live_for(session_id, doc.summary.path)
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
        client_displays = {
            **await self._load_client_displays(doc.summary.path),
            **(live.client_displays if live is not None else {}),
        }
        items = projection.project_session(
            doc.entries,
            session_id=session_id,
            external_session_id=doc.summary.path,
            client_messages=client_messages,
            client_displays=client_displays,
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
        ), (doc.summary.modified_at, doc.summary.size)

    # -- checkpointed timeline sync ----------------------------------------

    def _timeline_checkpoint_key(self, path: str) -> str:
        return f"pi/timeline-sync/{path}"

    async def _read_timeline_checkpoint(self, path: str) -> Mapping[str, Any] | None:
        try:
            value = await self.host.sync_state_read(self._timeline_checkpoint_key(path))
        except Exception:
            logger.exception("failed to read pi timeline checkpoint session=%s", path)
            return None
        return value if isinstance(value, Mapping) else None

    async def prepare_session_timeline_sync(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> PreparedSessionTimelineSync:
        """Diff the session file against the last timeline the platform accepted.

        Only new or changed items are sent. A complete replacement is sent when
        no valid checkpoint exists, or when an incremental sync would leave the
        platform wrong: it never deletes items, keeps an existing item where it
        is and appends new ids after its newest one. So removed items (another
        branch, live-only stream ids), moved items and new items placed before
        an already published one all need a replacement. ``commit`` records the
        checkpoint and must only run after the platform accepted the sync.
        """

        snapshot, stamp = await self._read_snapshot(session_id, external_session_id)
        path = snapshot.external_session_id
        if stamp is None or not path:
            return PreparedSessionTimelineSync(snapshot=None)
        published = _checkpoint_items(await self._read_timeline_checkpoint(path))
        # Capture before publishing: ids streamed after this read stay pending.
        streamed = frozenset(self._stream_ids.get(path, ()))
        items = tuple(item for item in snapshot.items if item.type not in TURN_MARKER_TYPES)
        fingerprints = {item.id: _item_fingerprint(item) for item in items}
        if published is None or _incremental_sync_misplaces(published, streamed, items):
            replacement, delta = True, items
        else:
            replacement = False
            delta = tuple(
                item
                for item in items
                if item.id in streamed or published.get(item.id) != fingerprints[item.id]
            )
        prepared = replace(snapshot, items=delta, complete=replacement) if delta or replacement else None

        async def commit() -> None:
            pending = self._stream_ids.get(path)
            if pending is not None:
                pending.difference_update(streamed)
                if not pending:
                    self._stream_ids.pop(path, None)
            key = self._timeline_checkpoint_key(path)
            if path in self._stream_ids:
                # Items streamed after this read are on the platform but not in
                # the checkpoint; a restart could not tell, so keep none.
                await self.host.sync_state_delete(key)
            else:
                await self.host.sync_state_write(
                    key,
                    {
                        "version": TIMELINE_CHECKPOINT_VERSION,
                        "sessionId": session_id,
                        "stamp": list(stamp),
                        "items": fingerprints,
                    },
                )
            self._synced[path] = stamp
            self._synced_loaded.add(path)

        return PreparedSessionTimelineSync(snapshot=prepared, commit=commit)

    async def _publish_stream_item(self, path: str, item: RuntimeTimelineItem) -> None:
        first = path not in self._stream_ids
        # Record first: a failed callback may still have reached the platform.
        self._stream_ids.setdefault(path, set()).add(item.id)
        if first:
            # Stream ids live in memory only. Drop the checkpoint before the
            # first one goes out, so a restart replaces the whole timeline
            # instead of appending to items it does not know were streamed.
            # A streamed turn ends in a replacement anyway.
            try:
                await self.host.sync_state_delete(self._timeline_checkpoint_key(path))
            except Exception:
                logger.exception("failed to drop pi timeline checkpoint session=%s", path)
        await self.host.timeline_item_upsert(item)

    # -- state / notices ----------------------------------------------------

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        # The inventory addresses a platform-created session by its file; a
        # live session found that way must not be reported as idle.
        live = self._live_for(session_id, external_session_id)
        if live is not None:
            return self._live_state(live)
        path = await self._resolve_session_path(session_id, external_session_id)
        if path is None:
            return None
        return SessionState(
            session_id=session_id,
            external_session_id=str(path),
            runtime=RUNTIME,
            runtime_id=self.config.runtime_id,
            status="idle",
            selections={
                "permission": await self._load_permission(str(path)),
                **await self._file_session_selections(path),
            },
            metadata={"sessionFile": str(path)},
        )

    async def _file_session_selections(self, path: Path) -> dict[str, str]:
        """The model and thinking level Pi restores when it reopens this file."""

        key = str(path)
        try:
            stat = await asyncio.to_thread(path.stat)
        except OSError:
            return {}
        stamp = (stat.st_mtime, stat.st_size)
        cached = self._file_selections.get(key)
        if cached is None or cached[0] != stamp:
            doc = await asyncio.to_thread(load_session_doc, path)
            settings = _restored_settings(doc.entries) if doc is not None else {}
            cached = (stamp, settings)
            self._file_selections[key] = cached
        settings = cached[1]
        selections: dict[str, str] = {}
        model_id = settings.get("model")
        thinking = settings.get("thinkingLevel")
        if model_id:
            if not self._catalog_models:
                try:
                    await self.list_model_catalog()
                except Exception:  # the plain model id is still right
                    logger.debug("pi model catalog unavailable for session state", exc_info=True)
            model = self._catalog_models.get(model_id, {})
            selections["model"] = (
                _thinking_selection_id(model_id, thinking)
                if thinking in supported_thinking_levels(model)
                else model_id
            )
        if thinking:
            selections["thinkingLevel"] = thinking
        return selections

    def _live_state(self, live: PiLiveSession) -> SessionState:
        selections: dict[str, str | None] = {"permission": live.permission_mode}
        selection_id = _session_model_selection(live.model, live.thinking_level)
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
        live = self._live_for(session_id, external_session_id)
        if live is None:
            return ()
        # Notices carry no external id: use the id the platform knows.
        return tuple(pending.as_notice(live.platform_id) for pending in live.pending_ui.values())

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
        self._catalog_models = {catalog_id: raw for raw, catalog_id, *_ in entries}
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
                    # Choosing the model alone keeps the session's thinking
                    # level (Pi clamps it to what the model supports).
                    selection_id=catalog_id,
                    description=provider,
                    reasoning_items=tuple(
                        RuntimeReasoningItem(
                            id=level,
                            title=THINKING_LABELS[level],
                            selection_id=_thinking_selection_id(catalog_id, level),
                        )
                        for level in supported_thinking_levels(raw)
                    ),
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
        commands: list[RuntimeCommand] = [
            _command(
                COMPACT_COMMAND,
                "Compact the session context. Text after the command guides the summary.",
                source="builtin",
            )
        ]
        for raw in _as_list(response_data(data).get("commands")):
            if not isinstance(raw, Mapping):
                continue
            name = raw.get("name")
            if not isinstance(name, str) or not name or name == COMPACT_COMMAND:
                continue
            description = raw.get("description")
            commands.append(
                _command(
                    name,
                    description if isinstance(description, str) else None,
                    source=raw.get("source"),
                )
            )
        if query:
            needle = query.lower()
            commands = [command for command in commands if needle in command.id.lower()]
        return tuple(commands[: max(0, limit)])

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
        if command == COMPACT_COMMAND:
            return await self._compact(live, session_id, _command_arguments(text, command))
        disposition = await live.send_prompt(text)
        # Pi answers an extension command once its handler returns ("handled");
        # skills and prompt templates start a run. Either way it was accepted.
        completed = disposition == "handled"
        if completed:
            self._schedule_publish(live)
        return RuntimeCommandResult(
            command=command,
            ok=True,
            message=f"已执行 {text}" if completed else f"已发送 {text}",
            result={
                "sessionId": session_id,
                "executionState": "completed" if completed else "accepted",
            },
        )

    async def _compact(
        self, live: PiLiveSession, session_id: str, instructions: str
    ) -> RuntimeCommandResult:
        if live.is_streaming or live.is_compacting:
            raise RuntimeInvalidRequestError("会话正在运行，请等这一轮结束后再压缩。")
        payload: dict[str, Any] = {"type": "compact"}
        if instructions:
            payload["customInstructions"] = instructions
        try:
            response = await live.submit_command(payload)
        except PiRpcRequestFailed as exc:
            return RuntimeCommandResult(
                command=COMPACT_COMMAND,
                ok=False,
                code="compact_failed",
                message=str(exc),
                result={"sessionId": session_id, "executionState": "completed"},
            )
        if response is None:
            return RuntimeCommandResult(
                command=COMPACT_COMMAND,
                ok=True,
                message="正在压缩会话上下文",
                result={"sessionId": session_id, "executionState": "accepted"},
            )
        data = response_data(response)
        before, after = data.get("tokensBefore"), data.get("estimatedTokensAfter")
        message = "已压缩会话上下文"
        if isinstance(before, int) and isinstance(after, int):
            message += f"（约 {before} → {after} tokens）"
        return RuntimeCommandResult(
            command=COMPACT_COMMAND,
            ok=True,
            message=message,
            result={"sessionId": session_id, "executionState": "completed"},
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
        sent = content
        images, content = await self._prepare_prompt(session_id, content, attachments)
        workdir = self._resolve_cwd(cwd)
        live = PiLiveSession(self, session_id, cwd=workdir)
        if selections and selections.get("permission") is not None:
            live.permission_mode = validate_permission_mode(selections["permission"])
            live._permission_loaded = True
        if client_message_id:
            self._bind_client_message(
                live, _prompt_text(content, images), client_message_id, sent, attachments
            )
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
        sent = content
        images, content = await self._prepare_prompt(session_id, content, attachments)
        live = await self._ensure_live(session_id, external_session_id, cwd)
        logger.info(
            "pi turn start session_id=%s client_message_id=%s",
            session_id,
            client_message_id,
        )
        if client_message_id:
            self._bind_client_message(
                live, _prompt_text(content, images), client_message_id, sent, attachments
            )
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
        sent = content
        images, content = await self._prepare_prompt(session_id, content, attachments)
        live = await self._ensure_live(session_id, external_session_id, None)
        if client_message_id:
            self._bind_client_message(
                live, _prompt_text(content, images), client_message_id, sent, attachments
            )
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
        live.abort_requested = True
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
        pending.cancel_expiry()
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
                stop_reason = message.get("stopReason")
                live.run_stop_reason = stop_reason if isinstance(stop_reason, str) else None
            return
        if event_type == "agent_start":
            live.status_reason = None
            live.is_streaming = True
            live.run_stop_reason = None
            live.abort_requested = False
            await self._push_state(live)
            return
        if event_type == "agent_settled":
            if live.stream is not None:
                await live.stream.flush()
            live.is_streaming = False
            live.is_compacting = False
            live.status_reason = None
            outcome = _turn_outcome(live.run_stop_reason, live.abort_requested)
            live.run_stop_reason = None
            live.abort_requested = False
            # A dialog the run opened and left unanswered was cancelled or timed
            # out inside Pi; Pi sends no event for that.
            await self._close_pending_interactions(live, status="cancelled", run_only=True)
            await self._push_state(live, force=True)
            await self._publish_timeline(live)
            await self._reset_stream(live)
            await self._push_meta(live)
            await self._publish_turn_end(live, outcome)
            return
        if event_type == "compaction_start":
            live.is_compacting = True
            await self._push_state(live)
            return
        if event_type == "compaction_end":
            live.is_compacting = False
            await self._push_state(live, force=True)
            if not live.is_streaming:
                # A manual /compact runs outside a turn; nothing else would
                # publish its marker until the next scan.
                await self._publish_timeline(live)
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
        for pending in live.pending_ui.values():
            pending.cancel_expiry()
        if self._stopping:
            return
        interrupted_run = live.is_streaming or live.is_compacting
        live.is_streaming = False
        live.is_compacting = False
        await self._close_pending_interactions(live, status="resolved")
        if interrupted_run:
            # The run never settled; close the platform turn instead of leaving
            # it open. A restart or an interrupt ends it deliberately.
            outcome = "interrupted" if live.restarting or live.abort_requested else "failed"
            live.run_stop_reason = None
            live.abort_requested = False
            await self._publish_turn_end(live, outcome)
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

    async def _publish_turn_end(self, live: PiLiveSession, outcome: str) -> None:
        try:
            await self.host.session_turn_ended(
                session_id=live.platform_id,
                runtime=RUNTIME,
                external_session_id=live.external_id,
                outcome=outcome,
            )
        except Exception:
            logger.exception("failed to publish turn end for %s", live.platform_id)

    async def _close_pending_interactions(
        self, live: PiLiveSession, *, status: str, run_only: bool = False
    ) -> None:
        for pending in list(live.pending_ui.values()):
            if run_only and not pending.during_run:
                continue
            await self._close_interaction(live, pending, status=status)

    async def _close_interaction(
        self, live: PiLiveSession, pending: PendingInteraction, *, status: str
    ) -> None:
        live.pending_ui.pop(pending.request_id, None)
        pending.cancel_expiry()
        try:
            await self.host.notice_upsert(pending.as_notice(live.platform_id, status=status))
        except Exception:
            logger.exception("failed to close pi interaction %s", pending.notice_id)

    async def _expire_interaction(self, live: PiLiveSession, pending: PendingInteraction) -> None:
        assert pending.timeout_ms is not None
        await asyncio.sleep(pending.timeout_ms / 1000 + DIALOG_TIMEOUT_GRACE_SECONDS)
        if live.pending_ui.get(pending.request_id) is not pending:
            return
        await self._close_interaction(live, pending, status="expired")
        await self._push_state(live, force=True)

    async def _handle_ui_request(self, live: PiLiveSession, record: Mapping[str, Any]) -> None:
        method = record.get("method")
        if method in DIALOG_METHODS:
            items = live.stream.items() if live.stream is not None else ()
            pending = PendingInteraction(
                record,
                external_session_id=live.external_id,
                turn_id=(items[-1].turn_id or "") if items else "",
            )
            pending.during_run = live.is_streaming or live.is_compacting
            live.pending_ui[pending.request_id] = pending
            if pending.timeout_ms is not None and pending.timeout_ms > 0:
                pending.expiry = asyncio.create_task(self._expire_interaction(live, pending))
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
            if external_session_id and not self._within_sessions_root(Path(external_session_id)):
                # Pi would open (and append to) any file passed as --session.
                raise RuntimeInvalidRequestError(
                    "Pi session path is outside the configured sessions directory"
                )
            workdir = self._resolve_cwd(cwd)
            resolved = await self._resolve_session_path(session_id, external_session_id)
            if resolved is not None:
                session_path = str(resolved)
                doc_cwd = await asyncio.to_thread(self._session_cwd, resolved)
                if doc_cwd:
                    workdir = doc_cwd
            elif external_session_id:
                # Inside sessionsDir but not written yet: Pi creates it lazily.
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

    async def _resolve_session_path(
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
        indexed = await self._indexed_session_path(session_id)
        if indexed is not None:
            return indexed
        # Inventory ids derive from the path alone: match file names off the
        # event loop instead of re-reading every session file.
        found = await asyncio.to_thread(
            self._scan_session_path, self.host.session_namespace, session_id
        )
        if found is not None:
            self._known_paths[session_id] = found
            return Path(found)
        return None

    def _scan_session_path(self, namespace: str, session_id: str) -> str | None:
        root = self.directory.root
        if not root.is_dir():
            return None
        for path in root.rglob("*.jsonl"):
            if platform_session_id(namespace, str(path)) == session_id and path.is_file():
                return str(path)
        return None

    def _session_index_key(self, session_id: str) -> str:
        return f"pi/session-index/{session_id}"

    async def _indexed_session_path(self, session_id: str) -> Path | None:
        """Path of a platform-created session, persisted across restarts."""

        try:
            value = await self.host.sync_state_read(self._session_index_key(session_id))
        except Exception:
            logger.exception("failed to read pi session index session=%s", session_id)
            return None
        raw = value.get("path") if isinstance(value, Mapping) else None
        if not isinstance(raw, str) or not raw:
            return None
        path = Path(raw)
        if not self._within_sessions_root(path) or not path.is_file():
            return None
        self._known_paths[session_id] = raw
        self._indexed_paths[session_id] = raw
        return path

    async def _remember_session_path(self, live: PiLiveSession) -> None:
        path = live.external_id
        if not path:
            return
        self._known_paths[live.platform_id] = path
        # Inventory ids are derivable from the path; only platform-allocated
        # ids need the persisted index.
        if platform_session_id(self.host.session_namespace, path) == live.platform_id:
            return
        if self._indexed_paths.get(live.platform_id) == path:
            return
        try:
            await self.host.sync_state_write(
                self._session_index_key(live.platform_id), {"path": path}
            )
        except Exception:
            logger.exception("failed to persist pi session index session=%s", live.platform_id)
            return
        self._indexed_paths[live.platform_id] = path

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

    @staticmethod
    def _bind_client_message(
        live: PiLiveSession,
        prompt: str,
        client_message_id: str,
        content: str,
        attachments: tuple[RuntimeAttachment, ...],
    ) -> None:
        """Pair the prompt Pi will store with the client's message."""

        live.client_messages.append((prompt, client_message_id))
        PiRuntime._remember_display(live, client_message_id, content, attachments)
        if live.stream is not None:
            live.stream.bind_client_message(
                prompt, client_message_id, live.client_displays.get(client_message_id)
            )

    @staticmethod
    def _remember_display(
        live: PiLiveSession,
        client_message_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...],
    ) -> None:
        """Show what the user sent, not the prompt Pi stores for attachments."""

        if not client_message_id or not attachments:
            return
        live.client_displays[client_message_id] = {
            "text": content,
            "attachments": [
                {
                    "fileId": attachment.file_id,
                    **({"name": attachment.name} if attachment.name else {}),
                    **({"mediaType": attachment.media_type} if attachment.media_type else {}),
                    **({"size": attachment.size} if attachment.size is not None else {}),
                }
                for attachment in attachments
            ],
        }

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
                client_displays=dict(live.client_displays),
                publish=functools.partial(self._publish_stream_item, live.external_id),
            )
        else:
            await live.stream.reset(
                entries=entries,
                client_messages=tuple(live.client_messages),
                client_displays=dict(live.client_displays),
            )

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
            await self._remember_session_path(live)
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
                    pending.cancel_expiry()
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
            selection_id = _model_selection_id(model)
            if selection_id:
                await self._set_model(live, selection_id)
            if thinking:
                await self._set_thinking_level(live, thinking)
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
        # Pi records every set_model / set_thinking_level in the session file,
        # and clients resend their selections with each message; only send
        # actual changes.
        for key, value in selections.items():
            if value is None:
                continue
            if key == "model":
                model_value, level = _split_thinking_selection(value)
                await self._set_model(live, model_value)
                if level is not None:
                    await self._set_thinking_level(live, level)
            elif key in ("thinkingLevel", "effort", "reasoningEffort"):
                await self._set_thinking_level(live, value)
            else:
                logger.debug("ignoring unknown selection key %r", key)

    async def _set_model(self, live: PiLiveSession, selection_id: str) -> None:
        if live.model and _model_selection_id(live.model) == selection_id:
            return
        provider, model_id = _split_model_selection(selection_id)
        payload: dict[str, Any] = {"type": "set_model", "modelId": model_id}
        if provider:
            payload["provider"] = provider
        data = response_data(await live.command(payload))
        nested = data.get("model")
        model = nested if isinstance(nested, Mapping) else data
        if isinstance(model.get("id"), str):
            live.model = dict(model)
        # Pi clamps the thinking level to what the new model supports.
        state = response_data(await live.command({"type": "get_state"}))
        thinking = state.get("thinkingLevel")
        if isinstance(thinking, str):
            live.thinking_level = thinking

    async def _set_thinking_level(self, live: PiLiveSession, level: str) -> None:
        if live.thinking_level == level:
            return
        await live.command({"type": "set_thinking_level", "level": level})
        live.thinking_level = level

    async def _push_state(self, live: PiLiveSession, *, force: bool = False) -> bool:
        key = live.state_key()
        if not force and key == live.last_state_key:
            return True
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
            return False
        await self._publish_session_capabilities(live.platform_id)
        return True

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

    def _schedule_publish(self, live: PiLiveSession) -> None:
        """Publish outside a run; a running turn publishes when it settles."""

        if self._stopping or live.is_streaming:
            return
        task = asyncio.get_running_loop().create_task(self._publish_timeline(live))
        self._publish_tasks.add(task)
        task.add_done_callback(self._publish_tasks.discard)

    async def _publish_timeline(self, live: PiLiveSession) -> None:
        """Publish the settled run through the same checkpoint as the scanner.

        The host notifier keeps this ordered behind the run's streamed items.
        Without a commit the scanner retries from the previous checkpoint.
        """

        path = live.session_file or live.session_path
        if not path or not Path(path).is_file():
            return
        try:
            prepared = await self.prepare_session_timeline_sync(live.platform_id, path)
            snapshot = prepared.snapshot
            if snapshot is not None:
                await self.host.timeline_sync(
                    session_id=live.platform_id,
                    runtime=RUNTIME,
                    items=snapshot.items,
                    external_session_id=snapshot.external_session_id,
                    complete=snapshot.complete,
                )
            if prepared.commit is not None:
                await prepared.commit()
        except Exception:
            logger.exception("failed to push pi timeline for %s", live.platform_id)

    # -- utility process ----------------------------------------------------

    async def _ensure_utility(self) -> PiRpcProcess:
        async with self._utility_lock:
            if self._utility is not None and self._utility.alive:
                return self._utility
            if self._stopping:
                raise RuntimeUnavailableError("Pi runtime is stopping")
            if self._utility is not None:
                # Exited on its own: release its reader tasks before replacing it.
                await self._utility.close()
                self._utility = None
            process = self._utility_process()
            try:
                await process.start()
            except BaseException:
                await process.close()
                raise
            self._utility = process
            return process

    def _utility_process(self) -> PiRpcProcess:
        return PiRpcProcess(
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

    async def _utility_command(self, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        process = await self._ensure_utility()
        return await process.request(payload)


def _command(name: str, description: str | None, *, source: Any) -> RuntimeCommand:
    """Pi commands all take one free-form argument string (``/name args``)."""

    return RuntimeCommand(
        id=name,
        title=name,
        description=description,
        scope="session",
        accepts_args=True,
        args_schema={"type": "string"},
        metadata={"source": source, "ui": {"kind": "execute", "acceptsMultiline": True}},
    )


def _command_arguments(text: str, command: str) -> str:
    return text.strip().removeprefix("/" + command).strip()


def _restored_settings(entries: Sequence[Mapping[str, Any]]) -> dict[str, str]:
    """Pi's getSessionContextSettings over the active branch.

    The last model change or assistant message names the model, and the last
    thinking level change the level.
    """

    settings: dict[str, str] = {}
    for entry in entries:
        entry_type = entry.get("type")
        if entry_type == "thinking_level_change":
            level = entry.get("thinkingLevel")
            if isinstance(level, str):
                settings["thinkingLevel"] = level
        elif entry_type == "model_change":
            selection_id = _model_selection_id(
                {"provider": entry.get("provider"), "id": entry.get("modelId")}
            )
            if selection_id:
                settings["model"] = selection_id
        elif entry_type == "message":
            message = entry.get("message")
            if isinstance(message, Mapping) and message.get("role") == "assistant":
                selection_id = _model_selection_id(
                    {"provider": message.get("provider"), "id": message.get("model")}
                )
                if selection_id:
                    settings["model"] = selection_id
    return settings


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _turn_outcome(stop_reason: str | None, abort_requested: bool) -> str:
    if abort_requested or stop_reason == "aborted":
        return "interrupted"
    if stop_reason == "error":
        return "failed"
    return "completed"


def _item_fingerprint(item: RuntimeTimelineItem) -> str:
    """``<orderSeq>:<digest>`` of everything the platform stores for an item.

    Revisions rise on every live re-publication and one file is synced under
    both its platform-created and its inventory session id; neither changes
    the item itself.
    """

    data = asdict(item)
    data.pop("revision")
    data.pop("session_id")
    encoded = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return f"{item.order_seq}:{hashlib.sha256(encoded.encode()).hexdigest()}"


def _fingerprint_order(fingerprint: str) -> int | None:
    order, separator, digest = fingerprint.partition(":")
    if not separator or not digest:
        return None
    try:
        return int(order)
    except ValueError:
        return None


def _checkpoint_items(value: Mapping[str, Any] | None) -> dict[str, str] | None:
    if not isinstance(value, Mapping) or value.get("version") != TIMELINE_CHECKPOINT_VERSION:
        return None
    items = value.get("items")
    if not isinstance(items, Mapping) or _checkpoint_stamp(value) is None:
        return None
    if not all(
        isinstance(key, str) and isinstance(fingerprint, str) and _fingerprint_order(fingerprint) is not None
        for key, fingerprint in items.items()
    ):
        return None
    return dict(items)


def _checkpoint_stamp(value: Mapping[str, Any] | None) -> tuple[float, int] | None:
    if not isinstance(value, Mapping) or value.get("version") != TIMELINE_CHECKPOINT_VERSION:
        return None
    stamp = value.get("stamp")
    if not isinstance(stamp, list) or len(stamp) != 2:
        return None
    modified_at, size = stamp
    if isinstance(modified_at, bool) or not isinstance(modified_at, (int, float)):
        return None
    if isinstance(size, bool) or not isinstance(size, int):
        return None
    return float(modified_at), size


def _incremental_sync_misplaces(
    published: Mapping[str, str],
    streamed: frozenset[str],
    items: Sequence[RuntimeTimelineItem],
) -> bool:
    """Whether an incremental sync would leave the platform timeline wrong."""

    current = {item.id: item.order_seq for item in items}
    if (published.keys() | streamed) - current.keys():
        return True
    newest = max((current[item_id] for item_id in streamed), default=-1)
    for item_id, fingerprint in published.items():
        order = _fingerprint_order(fingerprint)
        if order != current[item_id]:
            return True
        newest = max(newest, order)
    return any(
        order < newest
        for item_id, order in current.items()
        if item_id not in published and item_id not in streamed
    )


def _prompt_text(content: str, images: Sequence[Mapping[str, Any]]) -> str:
    """Match the persisted user message, including projected image placeholders."""

    return projection.content_text([{"type": "text", "text": content}, *images])
