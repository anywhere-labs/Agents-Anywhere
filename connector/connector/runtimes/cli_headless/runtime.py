from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    ErrorSystemContent,
    MarkdownMessageContent,
    MessageTimelineItem,
    ReasoningSystemContent,
    RuntimeAttachment,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeOperationResult,
    RuntimeSessionStateCache,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    RuntimeUnavailableError,
    SessionMeta,
    SystemTimelineItem,
    TimelineSource,
    ToolCallContent,
    ToolTimelineItem,
    TurnEndSystemContent,
    TurnEndTimelineItem,
    TurnStartSystemContent,
    TurnStartTimelineItem,
)
from connector.runtime_protocol.host import RuntimeHostClient, runtime_kv_store
from connector.runtimes.cli_headless.acp_client import (
    AcpClient,
    AcpError,
    chunk_text,
    thought_flag,
)
from connector.runtimes.cli_headless.attachments import (
    HeadlessTurnAttachment,
    materialize_headless_attachments,
)

MAX_OUTPUT_CHARS = 200_000
TURN_TIMEOUT_SECONDS = 1800
STREAM_FLUSH_CHARS = 200
STREAM_FLUSH_SECONDS = 0.5
READ_SLICE_SECONDS = 30.0
# Single synthetic catalog entry reported when the CLI owns model choice. The
# app sends it back on every turn, so it must be accepted as "let the CLI
# decide" instead of being rejected as an unknown model id.
DEFAULT_MODEL_ID = "default"
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


@dataclass
class _StreamState:
    """Mutable per-turn accumulator for streamed CLI output."""

    item_id: str
    text: str = ""
    published: int = 0
    revision: int = 0
    order_seq: int | None = None
    last_flush: float = 0.0
    legacy: bool = False
    error: str | None = None
    thinking: str = ""
    thinking_published: int = 0
    thinking_revision: int = 0
    thinking_order_seq: int | None = None
    tool_blocks: dict[Any, dict[str, Any]] = field(default_factory=dict)
    tool_orders: dict[str, int] = field(default_factory=dict)


def _append_bounded(current: str, addition: str) -> str:
    combined = current + addition
    if len(combined) > MAX_OUTPUT_CHARS:
        return combined[-MAX_OUTPUT_CHARS:]
    return combined


@dataclass(frozen=True)
class HeadlessCliSpec:
    """Static description of one headless CLI kernel (argv builder + probe)."""

    key: str
    display_name: str
    description: str
    available: Callable[[], bool]
    # (prompt, workspace, model, cli_session, attachments) -> argv.
    # cli_session None = start a fresh CLI session; str = resume that one.
    build_argv: Callable[
        [str, str | None, str | None, str | None, tuple[HeadlessTurnAttachment, ...]],
        list[str] | None,
    ]
    # Selectable models as (model_id, title) pairs; empty = CLI default only.
    models: tuple[tuple[str, str], ...] = ()
    # Optional persistent transport. When set, turns reuse one long-lived
    # ``<cli> acp`` process instead of paying the CLI's start-up per message.
    # Returns the argv to launch the ACP server, or None when the CLI is absent.
    acp_command: Callable[[], list[str] | None] | None = None


@dataclass
class _HeadlessSession:
    session_id: str
    external_session_id: str
    title: str | None
    cwd: str | None
    items: list[RuntimeTimelineItem] = field(default_factory=list)
    next_order: int = 1
    turn_task: asyncio.Task[None] | None = None
    process: asyncio.subprocess.Process | None = None
    active_turn_id: str | None = None
    # Native CLI session id captured from stream events; enables multi-turn resume.
    cli_session_id: str | None = None
    # Model chosen for this session through session.selections.update. The CLI
    # is per-turn, so the selection is remembered here and passed with --model.
    model: str | None = None
    # Session id owned by the persistent ACP child while it is alive; it equals
    # cli_session_id, but is tracked separately so a died-and-restarted child
    # can be restored with session/load.
    acp_session_id: str | None = None


class HeadlessCliRuntime(AgentRuntime):
    """One-shot headless CLI runtime.

    Each turn spawns the CLI in full-auto mode, streams stdout into an
    assistant message item, and ends the turn when the process exits.
    Sessions are tracked in memory for the lifetime of this runtime.
    """

    def __init__(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
        spec: HeadlessCliSpec,
    ) -> None:
        self.config = config
        self.host = host
        self.spec = spec
        self._sessions: dict[str, _HeadlessSession] = {}
        self._states = RuntimeSessionStateCache(spec.key, host)
        self._stopping = False
        self._kv = runtime_kv_store(host)
        self._acp: AcpClient | None = None
        self._acp_lock = asyncio.Lock()
        self._acp_sessions: dict[str, str] = {}
        self._load_persisted_sessions()

    # ------------------------------------------------------------------ identity

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime=self.spec.key,
            runtime_version="headless-1",
            display_name=self.spec.display_name,
        )

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        self._stopping = False

    async def stop(self) -> None:
        self._stopping = True
        tasks = [
            rec.turn_task
            for rec in self._sessions.values()
            if rec.turn_task is not None and not rec.turn_task.done()
        ]
        for rec in self._sessions.values():
            await self._kill_process(rec)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self._close_acp()

    # ------------------------------------------------------------------ reads

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        return RuntimeCapabilitySet(
            runtime=self.spec.key,
            revision=1,
            connector_id=self.host.connector_id,
            capabilities=(
                RuntimeCapability(
                    capability_id="session.send_message",
                    scope="runtime",
                    runtime=self.spec.key,
                    connector_id=self.host.connector_id,
                ),
                RuntimeCapability(
                    capability_id="session.interrupt",
                    scope="runtime",
                    runtime=self.spec.key,
                    connector_id=self.host.connector_id,
                ),
                RuntimeCapability(
                    capability_id="catalog.model",
                    scope="runtime",
                    runtime=self.spec.key,
                    connector_id=self.host.connector_id,
                ),
                RuntimeCapability(
                    capability_id="runtime.attachment",
                    scope="runtime",
                    runtime=self.spec.key,
                    connector_id=self.host.connector_id,
                ),
            ),
            metadata={"source": "cli_headless.static"},
        )

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        """Report the capabilities this kernel offers for one session.

        The Server fetches this set for every action that targets an existing
        session (reply, interrupt, catalog read) and inherits session-scoped
        entries only from what this method returns. The base implementation
        returns an empty set, which marks every inherited id unsupported and
        makes the Server reject those actions with "session capability is
        unavailable" — a session could be started but never replied to.
        """

        return RuntimeCapabilitySet(
            runtime=self.spec.key,
            revision=1,
            connector_id=self.host.connector_id,
            session_id=session_id,
            capabilities=tuple(
                RuntimeCapability(
                    capability_id=capability_id,
                    scope="session",
                    runtime=self.spec.key,
                    connector_id=self.host.connector_id,
                    session_id=session_id,
                )
                for capability_id in (
                    "session.send_message",
                    "session.interrupt",
                    "catalog.model",
                    "runtime.attachment",
                )
            ),
            metadata={
                "source": "cli_headless.session",
                "external_session_id": external_session_id,
            },
        )

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> Any:
        if self.spec.models:
            items = tuple(
                RuntimeModelItem(
                    id=model_id,
                    title=title,
                    selection_id=model_id,
                )
                for model_id, title in self.spec.models
            )
        else:
            # The CLI picks its own model; expose that single fact as a catalog
            # so the app's model picker is not empty.
            items = (
                RuntimeModelItem(
                    id=DEFAULT_MODEL_ID,
                    title=f"默认（{self.spec.display_name} CLI 配置的模型）",
                    selection_id=DEFAULT_MODEL_ID,
                    description="模型由本机 CLI 自己的配置决定，此处选择不改变行为",
                ),
            )
        return RuntimeModelCatalog(runtime=self.spec.key, revision=2, models=items)

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        metas = tuple(
            SessionMeta(
                session_id=rec.session_id,
                external_session_id=rec.external_session_id,
                runtime=self.spec.key,
                title=rec.title,
                cwd=rec.cwd,
            )
            for rec in self._sessions.values()
        )
        return metas[:limit]

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> Any | None:
        return self._states.get(session_id)

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        rec = self._sessions.get(session_id)
        if rec is None:
            raise RuntimeInvalidRequestError(
                f"{self.spec.display_name} runtime has no session {session_id!r}"
            )
        items = tuple(rec.items if limit is None else rec.items[-limit:])
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=rec.external_session_id,
            runtime=self.spec.key,
            items=items,
            # This timeline only lives in memory (and is empty again after a
            # connector restart), so it must never claim to be a complete
            # replacement: a complete sync makes the Server delete every stored
            # item that is missing from the snapshot, which would wipe a session's
            # history on reconnect. Codex and Claude always report complete=False.
            complete=False,
            metadata={"source": "cli_headless.snapshot"},
        )

    # ------------------------------------------------------------------ turns

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: dict | None = None,
        attachments: tuple = (),
        client_message_id: str | None = None,
        runtime_options: dict | None = None,
    ) -> RuntimeOperationResult:
        if runtime_options:
            raise RuntimeInvalidRequestError("Unsupported creation option")
        _require_message(content, client_message_id)
        rec = self._sessions.get(session_id)
        if rec is None:
            rec = _HeadlessSession(
                session_id=session_id,
                external_session_id=f"{self.spec.key}-{uuid.uuid4().hex[:12]}",
                title=title or _derive_title(content),
                cwd=cwd or self._workspace_dir(),
            )
            self._sessions[session_id] = rec
            await self.host.session_meta_upsert(
                session_id=session_id,
                runtime=self.spec.key,
                external_session_id=rec.external_session_id,
                title=rec.title,
                cwd=rec.cwd,
                metadata={"source": f"{self.spec.key}.session/create"},
            )
            self._persist_sessions()
        staged = await materialize_headless_attachments(self.host, session_id, attachments)
        return self._launch_turn(rec, content, client_message_id, selections, staged)

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections=None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        _require_message(content, client_message_id)
        rec = self._sessions.get(session_id)
        if rec is None:
            raise RuntimeInvalidRequestError(
                f"{self.spec.display_name} runtime has no session {session_id!r}"
            )
        staged = await materialize_headless_attachments(self.host, session_id, attachments)
        return self._launch_turn(rec, content, client_message_id, selections, staged)

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        """Remember the model chosen for this session.

        The Server calls this when the user picks a model, and it is the only way
        a selection reaches a runtime whose process is created per turn. Without
        it the app's model picker silently does nothing and every session keeps
        using the configured default.
        """

        rec = self._sessions.get(session_id)
        if rec is None:
            raise RuntimeInvalidRequestError(
                f"{self.spec.display_name} runtime has no session {session_id!r}"
            )
        if "model" not in selections:
            return RuntimeOperationResult(
                ok=True,
                result={
                    "sessionId": session_id,
                    "externalSessionId": rec.external_session_id,
                    "selections": {"model": rec.model},
                },
            )
        requested = selections.get("model")
        model_ids = {model_id for model_id, _title in self.spec.models}
        cli_owns_model_choice = not self.spec.models and requested == DEFAULT_MODEL_ID
        if requested is None or cli_owns_model_choice:
            rec.model = None
        elif isinstance(requested, str) and requested in model_ids:
            rec.model = requested
        else:
            return RuntimeOperationResult(
                ok=False,
                code="model_unknown",
                message=f"{self.spec.key} does not offer model {requested!r}",
                result={"sessionId": session_id},
            )
        self._persist_sessions()
        return RuntimeOperationResult(
            ok=True,
            result={
                "sessionId": session_id,
                "externalSessionId": rec.external_session_id,
                "selections": {"model": rec.model},
            },
        )

    def _resolve_model(
        self,
        selections=None,
        session_model: str | None = None,
    ) -> str | None:
        """Turn selection wins, then the session selection, then the configured default."""
        model_ids = {model_id for model_id, _title in self.spec.models}
        selected = None
        if isinstance(selections, dict):
            candidate = selections.get("model")
            if isinstance(candidate, str) and candidate in model_ids:
                selected = candidate
        if selected is None and session_model in model_ids:
            selected = session_model
        if selected is None:
            configured = self.config.values.get("defaultModel")
            if isinstance(configured, str) and configured in model_ids:
                selected = configured
        return selected

    def _launch_turn(
        self,
        rec: _HeadlessSession,
        content: str,
        client_message_id: str | None,
        selections=None,
        attachments: tuple[HeadlessTurnAttachment, ...] = (),
    ) -> RuntimeOperationResult:
        if rec.turn_task is not None and not rec.turn_task.done():
            return RuntimeOperationResult(
                ok=False,
                code="turn_in_progress",
                message="This session already has a running turn",
                result={"sessionId": rec.session_id},
            )
        model = self._resolve_model(selections, rec.model)
        rec.turn_task = asyncio.create_task(
            self._run_turn(rec, content, client_message_id, model, attachments),
            name=f"{self.spec.key}-turn-{rec.session_id}",
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "sessionId": rec.session_id,
                "externalSessionId": rec.external_session_id,
            },
        )

    async def interrupt_session(
        self,
        session_id: str,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        rec = self._sessions.get(session_id)
        if rec is None or rec.active_turn_id is None:
            return RuntimeOperationResult(
                ok=True,
                result={"interrupted": False, "alreadyStopped": True},
            )
        acp_session_id = self._acp_sessions.get(session_id)
        if self._acp is not None and self._acp.alive and acp_session_id:
            # ACP has a real cancel: the agent stops the turn and reports
            # stopReason="cancelled", instead of the process simply dying.
            try:
                await self._acp.cancel(acp_session_id)
            except AcpError as exc:
                logger.warning("{} could not cancel ACP session: {}", self.spec.key, exc)
        await self._kill_process(rec)
        return RuntimeOperationResult(
            ok=True,
            result={"interrupted": True, "alreadyStopped": False},
        )

    # ------------------------------------------------------------------ turn body

    async def _run_turn(
        self,
        rec: _HeadlessSession,
        content: str,
        client_message_id: str | None,
        model: str | None = None,
        attachments: tuple[HeadlessTurnAttachment, ...] = (),
    ) -> None:
        session_id = rec.session_id
        turn_id = uuid.uuid4().hex
        rec.active_turn_id = turn_id
        try:
            await self._publish_turn_start(rec, turn_id)
            await self._publish_user_message(rec, turn_id, content, client_message_id)
            await self._states.update(
                session_id=session_id,
                external_session_id=rec.external_session_id,
                status="running",
                metadata={"source": f"{self.spec.key}.turn/started"},
            )
            if self.spec.acp_command is not None and not attachments:
                await self._run_acp_turn(rec, turn_id, content, model)
            else:
                await self._run_oneshot_turn(rec, turn_id, content, model, attachments)
        except asyncio.CancelledError:
            await self._kill_process(rec)
            await self._fail_turn(rec, turn_id, "cancelled", "Turn was cancelled", "cancelled")
        except Exception as exc:  # noqa: BLE001
            logger.exception("{} turn failed", self.spec.key)
            await self._kill_process(rec)
            await self._fail_turn(rec, turn_id, "turn_failed", str(exc) or type(exc).__name__, "failed")
        finally:
            rec.active_turn_id = None
            rec.process = None

    async def _run_oneshot_turn(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        content: str,
        model: str | None,
        attachments: tuple[HeadlessTurnAttachment, ...],
    ) -> None:
        """One process for this turn only (the original kernel behaviour)."""

        argv = self.spec.build_argv(content, rec.cwd, model, rec.cli_session_id, attachments)
        if argv is None:
            raise RuntimeUnavailableError(
                f"{self.spec.display_name} CLI was not found on this machine"
            )
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=rec.cwd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            creationflags=CREATE_NO_WINDOW,
        )
        rec.process = proc
        exit_code, error_message = await self._stream_output(rec, turn_id, proc)
        await self._finish_turn(rec, turn_id, exit_code, error_message)

    # ------------------------------------------------------- persistent (ACP)

    async def _ensure_acp_client(self) -> AcpClient:
        """Return the long-lived ACP process, starting it on first use."""

        if self._acp is not None and self._acp.alive:
            return self._acp
        await self._close_acp()
        if self.spec.acp_command is None:
            raise AcpError(f"{self.spec.key} has no persistent transport")
        command = self.spec.acp_command()
        if command is None:
            raise AcpError(f"{self.spec.display_name} CLI was not found on this machine")
        client = AcpClient(command, self._workspace_dir())
        await client.start()
        try:
            await client.initialize()
        except AcpError:
            await client.close()
            raise
        self._acp = client
        self._acp_sessions.clear()
        logger.info("{} started persistent ACP process {}", self.spec.key, command)
        return client

    async def _close_acp(self) -> None:
        client = self._acp
        self._acp = None
        self._acp_sessions.clear()
        if client is not None:
            await client.close()

    async def _ensure_acp_session(self, rec: _HeadlessSession) -> tuple[AcpClient, str]:
        """Map a connector session onto an ACP session on the shared process."""

        client = await self._ensure_acp_client()
        known = self._acp_sessions.get(rec.session_id)
        if known:
            return client, known
        cwd = rec.cwd or self._workspace_dir()
        for candidate in (rec.acp_session_id, rec.cli_session_id):
            if not candidate:
                continue
            try:
                await client.load_session(candidate, cwd)
            except AcpError as exc:
                logger.warning(
                    "{} could not restore ACP session {}: {}",
                    self.spec.key,
                    candidate,
                    exc,
                )
                continue
            self._acp_sessions[rec.session_id] = candidate
            rec.acp_session_id = candidate
            rec.cli_session_id = candidate
            return client, candidate
        result = await client.new_session(cwd)
        session_id = result.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise AcpError("ACP session/new returned no session id")
        self._acp_sessions[rec.session_id] = session_id
        rec.acp_session_id = session_id
        rec.cli_session_id = session_id
        self._persist_sessions()
        return client, session_id

    async def _run_acp_turn(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        content: str,
        model: str | None,
    ) -> None:
        """Drive one turn over the persistent process.

        Measured against mcode 0.6.5: a second prompt on the same process took
        4.85s where a fresh process took 23.09s, because the CLI's own start-up
        (~11s for mcode) is paid once instead of per message.
        """

        state = _StreamState(item_id=f"{rec.session_id}:{turn_id}:assistant")
        try:
            client, acp_session_id = await self._ensure_acp_session(rec)
        except AcpError as exc:
            logger.warning(
                "{} persistent transport unavailable ({}); using one process per turn",
                self.spec.key,
                exc,
            )
            await self._run_oneshot_turn(rec, turn_id, content, model, ())
            return

        stop_reason = "end_turn"
        try:
            async with self._acp_lock:
                async for update in client.prompt(acp_session_id, content):
                    if "__stopReason" in update:
                        stop_reason = str(update["__stopReason"])
                        break
                    await self._apply_acp_update(rec, turn_id, state, update)
        except AcpError as exc:
            await self._close_acp()
            await self._fail_turn(rec, turn_id, "acp_turn_failed", str(exc), "failed")
            return

        await self._flush_assistant(rec, turn_id, state, force=True)
        state.revision += 1
        await self._publish_assistant(
            rec,
            turn_id,
            state.item_id,
            state.text,
            state.order_seq,
            state.revision,
            "done",
        )
        if state.thinking:
            await self._flush_reasoning(rec, turn_id, state, force=True)

        if stop_reason == "cancelled":
            await self._fail_turn(rec, turn_id, "cancelled", "Turn was cancelled", "cancelled")
            return
        if stop_reason not in {"end_turn", "max_tokens", "max_turn_requests"}:
            await self._fail_turn(
                rec,
                turn_id,
                "acp_stop_reason",
                f"{self.spec.display_name} stopped the turn: {stop_reason}",
                "failed",
            )
            return
        await self._finish_turn(rec, turn_id, 0, None)

    async def _apply_acp_update(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        state: _StreamState,
        update: dict[str, Any],
    ) -> None:
        """Translate one ``session/update`` payload into timeline items."""

        text = chunk_text(update)
        if text is not None:
            if thought_flag(update):
                state.thinking = _append_bounded(state.thinking, text)
                await self._flush_reasoning(rec, turn_id, state)
            else:
                state.text = _append_bounded(state.text, text)
                await self._flush_assistant(rec, turn_id, state)
            return
        kind = str(update.get("sessionUpdate") or "")
        if kind not in {"tool_call", "tool_call_update"}:
            return
        tool_id = update.get("toolCallId")
        if not isinstance(tool_id, str) or not tool_id:
            return
        # A tool_call_update only carries what changed (usually just a status),
        # so accumulate per tool instead of overwriting the announced title and
        # input with the sparse follow-up.
        merged = state.tool_blocks.setdefault(tool_id, {})
        title = update.get("title") or update.get("name")
        if isinstance(title, str) and title:
            merged["title"] = title
        if isinstance(update.get("kind"), str):
            merged["kind"] = update["kind"]
        if update.get("rawInput") is not None:
            merged["rawInput"] = update["rawInput"]
        if isinstance(update.get("status"), str):
            merged["status"] = update["status"]
        if not merged.get("title"):
            return
        tool_input = merged.get("rawInput")
        if tool_input is None:
            tool_input = {
                key: merged[key]
                for key in ("kind", "status")
                if merged.get(key) is not None
            }
        await self._publish_cli_tool_item(
            rec,
            turn_id,
            state,
            {
                "id": tool_id,
                "type": merged["title"],
                "input": tool_input,
            },
            merged.get("status") in {"completed", "failed"},
        )

    async def _stream_output(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        proc: asyncio.subprocess.Process,
    ) -> tuple[int | None, str | None]:
        """Stream CLI stdout into timeline items.

        Understands both Claude-fork stream-json (codebuddy) and the mcode
        item/turn event schema; non-JSON lines fall back to raw-text streaming.
        Returns (exit_code, error_message).
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + TURN_TIMEOUT_SECONDS
        state = _StreamState(
            item_id=f"{rec.session_id}:{turn_id}:assistant",
        )
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise TimeoutError(
                    f"{self.spec.display_name} turn exceeded {TURN_TIMEOUT_SECONDS}s"
                )
            try:
                raw = await asyncio.wait_for(
                    proc.stdout.readline(), timeout=min(remaining, READ_SLICE_SECONDS)
                )
            except TimeoutError:
                continue
            if not raw:
                break
            await self._handle_stream_line(rec, turn_id, state, raw)
            if state.error:
                await self._kill_process(rec)
                break
        exit_code = await proc.wait()
        revision = state.revision + 1
        await self._publish_assistant(
            rec, turn_id, state.item_id, state.text, state.order_seq, revision, "done"
        )
        error_message = state.error
        if error_message is None and exit_code not in (0, None):
            error_message = f"{self.spec.display_name} CLI exited with code {exit_code}"
        return exit_code, error_message

    async def _handle_stream_line(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        state: _StreamState,
        raw: bytes,
    ) -> None:
        line = raw.decode("utf-8", errors="replace").strip().lstrip("\ufeff")
        if not line:
            return
        event: dict[str, Any] | None = None
        if not state.legacy:
            try:
                loaded = json.loads(line)
                event = loaded if isinstance(loaded, dict) else None
            except ValueError:
                event = None
        if event is None:
            # Raw text mode (plain --output-format text, or CLI warnings).
            if line.startswith("{") or not state.text:
                state.legacy = True
            state.text = _append_bounded(state.text, line + "\n")
            await self._flush_assistant(rec, turn_id, state, force=True)
            return
        await self._handle_stream_event(rec, turn_id, state, event)

    async def _handle_stream_event(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        state: _StreamState,
        event: dict[str, Any],
    ) -> None:
        kind = event.get("type")
        # ---- Claude-fork family (codebuddy) --------------------------------
        if kind == "system" and event.get("subtype") == "init":
            session_id = event.get("session_id")
            if isinstance(session_id, str) and session_id:
                rec.cli_session_id = session_id
        elif kind == "stream_event":
            inner = event.get("event") or {}
            await self._handle_codebuddy_block(rec, turn_id, state, inner)
        elif kind == "assistant":
            message = event.get("message") or {}
            for block in message.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = block.get("text")
                    if text:
                        # Authoritative full text: replace accumulated deltas.
                        state.text = _append_bounded("", text)
                        await self._flush_assistant(rec, turn_id, state, force=True)
        elif kind == "result":
            if event.get("is_error"):
                state.error = str(
                    event.get("result") or event.get("subtype") or "CLI reported an error"
                )
            elif not state.text and event.get("result"):
                state.text = _append_bounded("", str(event["result"]))
                await self._flush_assistant(rec, turn_id, state, force=True)
        # ---- mcode family ----------------------------------------------------
        elif kind == "session.started":
            session_id = event.get("sessionId")
            if isinstance(session_id, str) and session_id:
                rec.cli_session_id = session_id
        elif kind in ("item.started", "item.updated", "item.completed"):
            item = event.get("item") or {}
            item_type = item.get("type")
            if item_type == "agent_message":
                delta = item.get("contentDelta")
                if isinstance(delta, str) and delta:
                    state.text = _append_bounded(state.text, delta)
                    await self._flush_assistant(rec, turn_id, state)
                content = item.get("content")
                if kind == "item.completed" and isinstance(content, str) and content:
                    state.text = _append_bounded("", content)
                    await self._flush_assistant(rec, turn_id, state, force=True)
            elif item_type:
                await self._publish_cli_tool_item(
                    rec, turn_id, state, item, kind == "item.completed"
                )
        elif kind == "turn.failed":
            state.error = str(event.get("error") or "mcode turn failed")

    async def _handle_codebuddy_block(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        state: _StreamState,
        inner: dict[str, Any],
    ) -> None:
        block_type = inner.get("type")
        index = inner.get("index")
        if block_type == "content_block_start":
            block = inner.get("content_block") or {}
            if block.get("type") == "tool_use":
                state.tool_blocks[index] = {
                    "tool_use_id": block.get("id"),
                    "name": block.get("name") or "tool",
                    "json": "",
                }
                await self._publish_cli_tool_item(
                    rec,
                    turn_id,
                    state,
                    {
                        "id": block.get("id") or f"idx-{index}",
                        "type": block.get("name") or "tool",
                        "input": {},
                    },
                    False,
                )
        elif block_type == "content_block_delta":
            delta = inner.get("delta") or {}
            delta_type = delta.get("type")
            if delta_type == "text_delta":
                state.text = _append_bounded(state.text, delta.get("text", ""))
                await self._flush_assistant(rec, turn_id, state)
            elif delta_type == "thinking_delta":
                # Surface the model's reasoning the way the Claude runtime does,
                # so the waiting phase of a reasoning model is visible.
                state.thinking = _append_bounded(state.thinking, delta.get("thinking", ""))
                await self._flush_reasoning(rec, turn_id, state)
            elif delta_type == "input_json_delta":
                block = state.tool_blocks.get(index)
                if block is not None:
                    block["json"] += delta.get("partial_json", "")
        elif block_type == "content_block_stop":
            block = state.tool_blocks.pop(index, None)
            if block is not None:
                tool_input: Any = block["json"]
                try:
                    tool_input = json.loads(block["json"]) if block["json"] else {}
                except ValueError:
                    pass
                await self._publish_cli_tool_item(
                    rec,
                    turn_id,
                    state,
                    {
                        "id": block.get("tool_use_id") or f"idx-{index}",
                        "type": block["name"],
                        "input": tool_input,
                    },
                    True,
                )

    async def _flush_assistant(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        state: _StreamState,
        force: bool = False,
    ) -> None:
        now = time.monotonic()
        grown = len(state.text) - state.published
        due = now - state.last_flush >= STREAM_FLUSH_SECONDS
        if not force and grown < STREAM_FLUSH_CHARS and not due:
            return
        state.revision += 1
        state.order_seq = await self._publish_assistant(
            rec, turn_id, state.item_id, state.text, state.order_seq, state.revision, "inProgress"
        )
        state.published = len(state.text)
        state.last_flush = now

    async def _flush_reasoning(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        state: _StreamState,
        force: bool = False,
    ) -> None:
        now = time.monotonic()
        grown = len(state.thinking) - state.thinking_published
        due = now - state.last_flush >= STREAM_FLUSH_SECONDS
        if not force and grown < STREAM_FLUSH_CHARS and not due:
            return
        state.thinking_revision += 1
        item_id = f"{rec.session_id}:{turn_id}:reasoning"
        if state.thinking_order_seq is None:
            state.thinking_order_seq = rec.next_order
            rec.next_order += 1
        reasoning = SystemTimelineItem(
            id=item_id,
            type="system",
            status="inProgress",
            content=ReasoningSystemContent(text=state.thinking),
            source=TimelineSource(
                runtime=self.spec.key,
                external_session_id=rec.external_session_id,
                turn_id=turn_id,
                event="thinking",
            ),
            turn_id=turn_id,
            revision=state.thinking_revision,
        )
        platform_item = reasoning.to_platform_item(rec.session_id, state.thinking_order_seq)
        rec.items = [existing for existing in rec.items if existing.id != item_id]
        rec.items.append(platform_item)
        state.thinking_published = len(state.thinking)
        state.last_flush = now
        await self.host.timeline_item_upsert(platform_item)

    async def _publish_cli_tool_item(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        state: _StreamState,
        item: dict[str, Any],
        completed: bool,
    ) -> None:
        tool_id = str(item.get("id") or uuid.uuid4().hex)
        item_id = f"{rec.session_id}:{turn_id}:tool:{tool_id}"
        name = str(item.get("type") or "tool")
        tool_input = item.get("input")
        if tool_input is None:
            tool_input = item.get("inputPreview")
        platform_item = ToolTimelineItem(
            id=item_id,
            type="tool",
            status="done" if completed else "inProgress",
            content=ToolCallContent(
                title=name,
                input=tool_input if isinstance(tool_input, (dict, list, str)) else str(tool_input),
            ),
            source=TimelineSource(
                runtime=self.spec.key,
                external_session_id=rec.external_session_id,
                turn_id=turn_id,
                native_item_id=tool_id,
                event="tool",
            ),
            role="tool",
            turn_id=turn_id,
        )
        order_seq = state.tool_orders.get(item_id)
        if order_seq is None:
            order_seq = rec.next_order
            rec.next_order += 1
            state.tool_orders[item_id] = order_seq
        upserted = platform_item.to_platform_item(rec.session_id, order_seq)
        rec.items = [existing for existing in rec.items if existing.id != item_id]
        rec.items.append(upserted)
        await self.host.timeline_item_upsert(upserted)

    async def _finish_turn(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        exit_code: int | None,
        error_message: str | None,
    ) -> None:
        if error_message is None and exit_code == 0:
            self._persist_sessions()
            await self._publish_turn_end(rec, turn_id, "done")
            await self._states.update(
                session_id=rec.session_id,
                external_session_id=rec.external_session_id,
                status="idle",
                metadata={"source": f"{self.spec.key}.turn/completed"},
            )
            await self.host.session_turn_ended(
                session_id=rec.session_id,
                runtime=self.spec.key,
                external_session_id=rec.external_session_id,
                turn_id=turn_id,
                outcome="completed",
            )
        else:
            await self._fail_turn(
                rec,
                turn_id,
                "cli_turn_error",
                error_message
                or f"{self.spec.display_name} CLI exited with code {exit_code}",
                "failed",
            )

    async def _fail_turn(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        code: str,
        message: str,
        outcome: str,
    ) -> None:
        await self._publish_system_error(rec, turn_id, message)
        await self._publish_turn_end(rec, turn_id, "failed")
        status = "error" if outcome == "failed" else "idle"
        await self._states.update(
            session_id=rec.session_id,
            external_session_id=rec.external_session_id,
            status=status,
            error={"code": code, "message": message} if outcome == "failed" else None,
            metadata={"source": f"{self.spec.key}.turn/{outcome}"},
        )
        await self.host.session_turn_ended(
            session_id=rec.session_id,
            runtime=self.spec.key,
            external_session_id=rec.external_session_id,
            turn_id=turn_id,
            outcome=outcome,
        )

    # ------------------------------------------------------------------ publishing

    def _workspace_dir(self) -> str | None:
        value = self.config.values.get("workspaceDir")
        return value if isinstance(value, str) and value.strip() else None

    def _kv_key(self) -> str:
        return f"cli_headless:{self.spec.key}:sessions"

    def _load_persisted_sessions(self) -> None:
        """Restore session registry after a connector restart.

        Timeline history is in-memory only and starts empty; the registry
        itself survives so existing sessions remain continuable.
        """
        try:
            document = self._kv.get(self._kv_key())
        except Exception:  # noqa: BLE001
            return
        if not isinstance(document, dict):
            return
        records = document.get("sessions")
        if not isinstance(records, list):
            return
        for record in records:
            if not isinstance(record, dict):
                continue
            session_id = record.get("session_id")
            external_id = record.get("external_session_id")
            if not isinstance(session_id, str) or not isinstance(external_id, str):
                continue
            if session_id in self._sessions:
                continue
            self._sessions[session_id] = _HeadlessSession(
                session_id=session_id,
                external_session_id=external_id,
                title=record.get("title"),
                cwd=record.get("cwd"),
                cli_session_id=record.get("cli_session_id"),
                model=record.get("model"),
                acp_session_id=record.get("acp_session_id"),
            )

    def _persist_sessions(self) -> None:
        records = [
            {
                "session_id": rec.session_id,
                "external_session_id": rec.external_session_id,
                "title": rec.title,
                "cwd": rec.cwd,
                "cli_session_id": rec.cli_session_id,
                "model": rec.model,
                "acp_session_id": rec.acp_session_id,
            }
            for rec in self._sessions.values()
        ]
        try:
            self._kv.set(self._kv_key(), {"sessions": records})
        except Exception:  # noqa: BLE001
            logger.warning("{} failed to persist session registry", self.spec.key)

    async def _publish_turn_start(self, rec: _HeadlessSession, turn_id: str) -> None:
        item = TurnStartTimelineItem(
            id=f"{rec.session_id}:{turn_id}:turn-start",
            type="turn.start",
            status="done",
            content=TurnStartSystemContent(),
            source=TimelineSource(
                runtime=self.spec.key,
                external_session_id=rec.external_session_id,
                turn_id=turn_id,
                event="turn.start",
            ),
            turn_id=turn_id,
        )
        await self._append_item(rec, item)

    async def _publish_user_message(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        content: str,
        client_message_id: str | None,
    ) -> None:
        item = MessageTimelineItem(
            id=f"{rec.session_id}:{turn_id}:user",
            type="message",
            status="done",
            content=MarkdownMessageContent(text=content),
            source=TimelineSource(
                runtime=self.spec.key,
                external_session_id=rec.external_session_id,
                turn_id=turn_id,
                client_message_id=client_message_id,
                event="user_message",
            ),
            role="user",
            turn_id=turn_id,
        )
        await self._append_item(rec, item)

    async def _publish_assistant(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        item_id: str,
        text: str,
        order_seq: int | None,
        revision: int,
        status: str,
    ) -> int:
        item = MessageTimelineItem(
            id=item_id,
            type="message",
            status=status,  # type: ignore[arg-type]
            content=MarkdownMessageContent(text=text),
            source=TimelineSource(
                runtime=self.spec.key,
                external_session_id=rec.external_session_id,
                turn_id=turn_id,
                event="stdout",
            ),
            role="assistant",
            turn_id=turn_id,
            revision=revision,
        )
        if order_seq is None:
            order_seq = rec.next_order
            rec.next_order += 1
        platform_item = item.to_platform_item(rec.session_id, order_seq)
        rec.items = [existing for existing in rec.items if existing.id != item_id]
        rec.items.append(platform_item)
        await self.host.timeline_item_upsert(platform_item)
        return order_seq

    async def _publish_turn_end(self, rec: _HeadlessSession, turn_id: str, status: str) -> None:
        item = TurnEndTimelineItem(
            id=f"{rec.session_id}:{turn_id}:turn-end",
            type="turn.end",
            status=status,  # type: ignore[arg-type]
            content=TurnEndSystemContent(),
            source=TimelineSource(
                runtime=self.spec.key,
                external_session_id=rec.external_session_id,
                turn_id=turn_id,
                event="turn.end",
            ),
            turn_id=turn_id,
        )
        await self._append_item(rec, item)

    async def _publish_system_error(
        self,
        rec: _HeadlessSession,
        turn_id: str,
        message: str,
    ) -> None:
        item = SystemTimelineItem(
            id=f"{rec.session_id}:{turn_id}:error",
            type="system",
            status="done",
            content=ErrorSystemContent(message=message, severity="error"),
            source=TimelineSource(
                runtime=self.spec.key,
                external_session_id=rec.external_session_id,
                turn_id=turn_id,
                event="error",
            ),
            turn_id=turn_id,
        )
        await self._append_item(rec, item)

    async def _append_item(
        self,
        rec: _HeadlessSession,
        item: Any,
    ) -> None:
        order_seq = rec.next_order
        rec.next_order += 1
        platform_item = item.to_platform_item(rec.session_id, order_seq)
        rec.items.append(platform_item)
        await self.host.timeline_item_upsert(platform_item)

    async def _kill_process(self, rec: _HeadlessSession) -> None:
        proc = rec.process
        if proc is None or proc.returncode is not None:
            return
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        except OSError:
            logger.warning("{} failed to kill subprocess", self.spec.key)


def _require_message(content: str, client_message_id: str | None) -> None:
    if not content.strip() or not client_message_id:
        raise RuntimeInvalidRequestError(
            "A message and a stable clientMessageId are required"
        )


def _derive_title(content: str) -> str:
    collapsed = " ".join(content.split())
    return collapsed[:40] or None


def _text(chunks: list[str]) -> str:
    return "".join(chunks)[-MAX_OUTPUT_CHARS:]
