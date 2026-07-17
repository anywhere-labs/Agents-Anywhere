from __future__ import annotations

import asyncio
import secrets
import tempfile
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from connector.acp.config_options import (
    extract_mode_options,
    extract_model_options,
    find_config_option,
    is_interactive_auth_method,
    order_headless_auth_method_ids,
    order_interactive_auth_method_ids,
    summarize_auth_methods,
)
from connector.acp.manifest import AgentManifest
from connector.acp.reducer import AcpTimelineReducer, map_approval_status_to_option
from connector.acp.rpc import AcpJsonRpcClient, AcpJsonRpcError
from connector.launch import LaunchTarget, launch_target
from connector.logging import logger
from connector.perf import StageTimer, elapsed_ms, log_stage
from connector.time import utc_now


NotificationSink = Callable[[str, dict[str, Any]], Awaitable[None]] | None
AttachmentDownloader = Callable[[str, str], Awaitable[tuple[bytes, str, str]]]

# Default ceiling for a single prompt turn (can be overridden via manifest.quirks).
_DEFAULT_MAX_TURN_SECONDS = 60 * 60
# User-triggered interactive OAuth (browser) — allow several minutes to complete.
_INTERACTIVE_AUTH_TIMEOUT_S = 5 * 60
# Bound session/new: fail fast instead of hanging near UI/RPC ceilings.
_SESSION_NEW_TIMEOUT_S = 20.0
_AUTH_ERROR_TOKENS = (
    "auth",
    "login",
    "unauthor",
    "api key",
    "credential",
    "not configured",
    "token",
)


@dataclass(slots=True)
class _PendingApproval:
    request_id: str | int
    future: asyncio.Future[str]
    options: list[dict[str, Any]]


@dataclass(slots=True)
class _SessionRuntime:
    session_id: str
    cwd: str | None = None
    external_session_id: str | None = None
    active_turn_id: str | None = None
    active_task: asyncio.Task[None] | None = None
    interrupted: bool = False
    client_message_id: str | None = None
    reducer: AcpTimelineReducer | None = None
    pending_approvals: dict[str, _PendingApproval] = field(default_factory=dict)
    # ACP config options from session/new (model/mode selectors).
    config_options: list[dict[str, Any]] = field(default_factory=list)
    # Short lock only for claiming/releasing a turn (not held for the whole turn).
    claim_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    turn_timer: StageTimer | None = None


@dataclass(slots=True)
class AcpAdapter:
    """Generic Adapter backed by an ACP agent subprocess."""

    manifest: AgentManifest
    notification_sink: NotificationSink = None
    attachment_downloader: AttachmentDownloader | None = None
    launch: LaunchTarget | None = None
    client_factory: Callable[[list[str], dict[str, str] | None, str | None], AcpJsonRpcClient] | None = None
    _client: AcpJsonRpcClient | None = field(default=None, init=False, repr=False)
    _initialized: bool = field(default=False, init=False, repr=False)
    _needs_restart: bool = field(default=False, init=False, repr=False)
    _agent_capabilities: dict[str, Any] = field(default_factory=dict, init=False, repr=False)
    _auth_methods: list[dict[str, Any]] = field(default_factory=list, init=False, repr=False)
    _sessions: dict[str, _SessionRuntime] = field(default_factory=dict, init=False, repr=False)
    _start_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    _auth_status: str = field(default="unknown", init=False, repr=False)
    _auth_hint: str | None = field(default=None, init=False, repr=False)
    # external_session_id -> last known ACP configOptions from session/new|set_config

    @property
    def runtime(self) -> str:
        return self.manifest.id

    def rewire(self, target: LaunchTarget | None) -> None:
        """Point at a new binary. Old process is closed on next ensure_client."""
        self.launch = target
        self._initialized = False
        self._needs_restart = True

    def forget_sync_state(self) -> None:
        return None

    def forget_persisted_sync_state(self, connector_id: str) -> None:
        self.forget_sync_state()

    async def create_session(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = _optional_string(params.get("sessionId")) or f"sess_{self.runtime}_{secrets.token_urlsafe(10)}"
        cwd = _require_cwd(params)
        runtime = self._runtime_for(session_id, params)
        timer = StageTimer()
        # Skip spawn/session/new when a prior probe already proved auth is missing.
        self._raise_if_auth_blocked()
        client = await self._ensure_client()
        try:
            # Bound cold session/new (Cursor/Grok historically hung well past UI timeouts).
            result = await client.request(
                "session/new",
                {
                    "cwd": cwd,
                    "mcpServers": params.get("mcpServers") if isinstance(params.get("mcpServers"), list) else [],
                },
                timeout=_SESSION_NEW_TIMEOUT_S,
            )
        except (AcpJsonRpcError, TimeoutError, asyncio.TimeoutError) as exc:
            stderr = client.stderr_excerpt if client else ""
            detail = str(exc)
            if _is_authish_error(detail):
                detail = await self._mark_auth_required(detail)
            if stderr:
                detail = f"{detail}; stderr={stderr[:800]}"
            if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
                detail = (
                    f"{self.runtime} session/new timed out after {_SESSION_NEW_TIMEOUT_S:.0f}s: {detail}"
                )
            raise AcpJsonRpcError(detail) from exc
        external = _optional_string(result.get("sessionId")) or _optional_string(result.get("session_id"))
        if not external:
            raise AcpJsonRpcError(f"{self.runtime} session/new did not return sessionId")
        self._set_auth_status("ok")
        runtime.external_session_id = external
        runtime.cwd = cwd
        runtime.reducer = AcpTimelineReducer(runtime=self.runtime)
        config_options = result.get("configOptions") if isinstance(result.get("configOptions"), list) else []
        runtime.config_options = [opt for opt in config_options if isinstance(opt, dict)]
        # Apply preferred model/mode from AA settings if agent exposed config options.
        await self._apply_session_settings(client, runtime, params)
        model_options = extract_model_options(runtime.config_options)
        mode_options = extract_mode_options(runtime.config_options)
        elapsed = timer.elapsed_ms()
        log_stage(
            "adapter.create_session",
            elapsed,
            runtime=self.runtime,
            session_id=session_id,
        )
        logger.info(
            "{} session created session_id={} external={} elapsed_ms={}",
            self.runtime,
            session_id,
            external,
            elapsed,
        )
        await self._emit(
            "session.updated",
            {
                "sessionId": session_id,
                "runtime": self.runtime,
                "externalSessionId": external,
                "status": "idle",
                "cwd": cwd,
                "sourceObservedAt": utc_now(),
                "configOptions": runtime.config_options,
                "modelOptions": model_options,
                "modeOptions": mode_options,
            },
        )
        # Also refresh device-level observed options for schema merge.
        if model_options or mode_options or runtime.config_options:
            await self._emit(
                "runtime.optionsUpdated",
                {
                    "runtime": self.runtime,
                    "configOptions": runtime.config_options,
                    "modelOptions": model_options,
                    "modeOptions": mode_options,
                    "authStatus": "ok",
                    "sourceObservedAt": utc_now(),
                },
            )
        return {
            "sessionId": session_id,
            "externalSessionId": external,
            "configOptions": runtime.config_options,
            "modelOptions": model_options,
            "modeOptions": mode_options,
            "backendNotifications": [],
        }

    async def sync_session(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = _required(params, "sessionId")
        runtime = self._sessions.get(session_id)
        external = _optional_string(params.get("externalSessionId")) or (
            runtime.external_session_id if runtime else None
        )
        if external is None:
            return {"backendNotifications": []}
        caps = self._agent_capabilities
        session_caps = caps.get("sessionCapabilities") if isinstance(caps.get("sessionCapabilities"), dict) else {}
        load_supported = bool(caps.get("loadSession")) or "load" in session_caps or "resume" in session_caps
        if not load_supported:
            return {"backendNotifications": []}
        cwd = (
            _optional_string(params.get("cwd"))
            or (runtime.cwd if runtime else None)
        )
        if not cwd:
            raise ValueError("missing cwd")
        client = await self._ensure_client()
        method = "session/load" if bool(caps.get("loadSession")) or "load" in session_caps else "session/resume"
        try:
            await client.request(
                method,
                {
                    "sessionId": external,
                    "cwd": cwd,
                    "mcpServers": [],
                },
            )
        except AcpJsonRpcError as exc:
            logger.warning("{} {} failed: {}", self.runtime, method, exc)
        return {"backendNotifications": []}

    async def sync_existing_sessions(
        self,
        connector_id: str,
        *,
        limit: int = 100,
        force: bool = False,
        notification_sink: Callable[[list[dict[str, Any]]], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        del connector_id, force, notification_sink
        caps = self._agent_capabilities
        session_caps = caps.get("sessionCapabilities") if isinstance(caps.get("sessionCapabilities"), dict) else {}
        if "list" not in session_caps and not caps.get("sessionList"):
            return {"threads": [], "skippedThreads": [], "backendNotifications": []}
        try:
            client = await self._ensure_client()
            result = await client.request("session/list", {"limit": limit})
            sessions = result.get("sessions") if isinstance(result.get("sessions"), list) else []
            threads = [
                str(item.get("sessionId"))
                for item in sessions
                if isinstance(item, dict) and item.get("sessionId")
            ]
            return {"threads": threads[:limit], "skippedThreads": [], "backendNotifications": []}
        except Exception:
            logger.exception("{} session/list failed", self.runtime)
            return {"threads": [], "skippedThreads": [], "backendNotifications": []}

    async def start_turn(self, params: dict[str, Any]) -> dict[str, Any]:
        sync_timer = StageTimer()
        session_id = _required(params, "sessionId")
        content = _required(params, "content")
        runtime = self._runtime_for(session_id, params)
        if runtime.external_session_id is None:
            created = await self.create_session(params)
            runtime.external_session_id = created.get("externalSessionId")

        async with runtime.claim_lock:
            if runtime.active_task is not None and not runtime.active_task.done():
                raise AcpJsonRpcError(f"{self.runtime} turn already running for this session")
            runtime.interrupted = False
            turn_id = _optional_string(params.get("turnId")) or f"turn_{self.runtime}_{secrets.token_urlsafe(8)}"
            runtime.active_turn_id = turn_id
            runtime.client_message_id = _optional_string(params.get("clientMessageId"))
            if runtime.reducer is None:
                runtime.reducer = AcpTimelineReducer(runtime=self.runtime)
            runtime.turn_timer = StageTimer()
            runtime.active_task = asyncio.create_task(
                self._drive_turn(runtime=runtime, params=params, content=content, turn_id=turn_id)
            )
        log_stage(
            "adapter.start_turn_sync",
            sync_timer.elapsed_ms(),
            runtime=self.runtime,
            session_id=session_id,
            turn_id=turn_id,
        )
        return {"turnId": turn_id}

    async def interrupt_turn(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = _required(params, "sessionId")
        runtime = self._sessions.get(session_id)
        if runtime is None or runtime.external_session_id is None:
            return {"interrupted": False, "reason": "session not registered"}
        runtime.interrupted = True
        for pending in list(runtime.pending_approvals.values()):
            if not pending.future.done():
                pending.future.set_result("cancelled")
        try:
            client = await self._ensure_client()
            await client.notify("session/cancel", {"sessionId": runtime.external_session_id})
            return {"interrupted": True}
        except Exception as exc:
            logger.exception("{} session/cancel failed", self.runtime)
            return {"interrupted": False, "reason": str(exc)}

    async def resolve_approval(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = _required(params, "sessionId")
        approval_id = _required(params, "approvalId")
        status = _required(params, "status")
        runtime = self._sessions.get(session_id)
        if runtime is None:
            return {"resolved": False, "reason": "session not registered"}
        pending = runtime.pending_approvals.get(approval_id)
        if pending is None:
            for key, value in runtime.pending_approvals.items():
                if str(value.request_id) == str(approval_id):
                    pending = value
                    approval_id = key
                    break
        if pending is None:
            return {"resolved": False, "reason": "approval not pending"}
        if not pending.future.done():
            pending.future.set_result(status)
        return {"resolved": True}

    async def close(self) -> None:
        await self._shutdown_client()

    def _runtime_for(self, session_id: str, params: dict[str, Any]) -> _SessionRuntime:
        runtime = self._sessions.get(session_id)
        if runtime is None:
            runtime = _SessionRuntime(
                session_id=session_id,
                cwd=_optional_string(params.get("cwd")),
                external_session_id=_optional_string(params.get("externalSessionId")),
                reducer=AcpTimelineReducer(runtime=self.runtime),
            )
            self._sessions[session_id] = runtime
        if params.get("cwd"):
            runtime.cwd = _optional_string(params.get("cwd"))
        if params.get("externalSessionId"):
            runtime.external_session_id = _optional_string(params.get("externalSessionId"))
        return runtime

    async def _drive_turn(
        self,
        *,
        runtime: _SessionRuntime,
        params: dict[str, Any],
        content: str,
        turn_id: str,
    ) -> None:
        assert runtime.reducer is not None
        max_turn_s = _max_turn_seconds(self.manifest)
        outcome = "done"
        try:
            reduced = runtime.reducer.turn_start(
                session_id=runtime.session_id,
                turn_id=turn_id,
                external_session_id=runtime.external_session_id,
                content=content,
                client_message_id=runtime.client_message_id,
                attachments=_attachments_metadata(params),
            )
            await self._emit_reduction(reduced)
            client = await self._ensure_client()
            # Re-apply model/settings before each turn (composer can change mid-session).
            await self._apply_session_settings(client, runtime, params)
            prompt = await self._build_prompt(content=content, params=params, runtime=runtime)
            try:
                result = await client.request(
                    "session/prompt",
                    {
                        "sessionId": runtime.external_session_id,
                        "prompt": prompt,
                    },
                    timeout=max_turn_s,
                )
            except AcpJsonRpcError as exc:
                if runtime.interrupted:
                    outcome = "cancelled"
                    end = runtime.reducer.turn_end(
                        session_id=runtime.session_id,
                        turn_id=turn_id,
                        external_session_id=runtime.external_session_id,
                        stop_reason="cancelled",
                        interrupted=True,
                    )
                    await self._emit_reduction(end)
                    return
                raise exc
            stop_reason = _optional_string(result.get("stopReason") or result.get("stop_reason"))
            if runtime.interrupted:
                outcome = "cancelled"
            end = runtime.reducer.turn_end(
                session_id=runtime.session_id,
                turn_id=turn_id,
                external_session_id=runtime.external_session_id,
                stop_reason=stop_reason,
                interrupted=runtime.interrupted,
            )
            await self._emit_reduction(end)
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        except Exception as exc:
            outcome = "cancelled" if runtime.interrupted else "failed"
            logger.exception(
                "ACP turn failed runtime={} session_id={} turn_id={}",
                self.runtime,
                runtime.session_id,
                turn_id,
            )
            stderr = self._client.stderr_excerpt if self._client else ""
            if runtime.reducer is not None:
                # Always go through reducer so contentHash/revision stay consistent.
                end = runtime.reducer.turn_end(
                    session_id=runtime.session_id,
                    turn_id=turn_id,
                    external_session_id=runtime.external_session_id,
                    stop_reason=(str(exc)[:500] or "failed"),
                    interrupted=runtime.interrupted,
                )
                await self._emit_reduction(end)
            await self._emit(
                "runtime.error",
                {
                    "sessionId": runtime.session_id,
                    "runtime": self.runtime,
                    "message": str(exc),
                    "stderr": stderr or None,
                },
            )
        finally:
            timer = runtime.turn_timer
            if timer is not None:
                timer.mark_turn_complete(
                    outcome=outcome,
                    runtime=self.runtime,
                    session_id=runtime.session_id,
                    turn_id=turn_id,
                )
                runtime.turn_timer = None
            async with runtime.claim_lock:
                if runtime.active_turn_id == turn_id:
                    runtime.active_turn_id = None
                    runtime.active_task = None
                    runtime.client_message_id = None
                runtime.pending_approvals.clear()

    async def _build_prompt(
        self,
        *,
        content: str,
        params: dict[str, Any],
        runtime: _SessionRuntime,
    ) -> list[dict[str, Any]]:
        blocks: list[dict[str, Any]] = [{"type": "text", "text": content}]
        attachments = params.get("attachments")
        if not isinstance(attachments, list) or self.attachment_downloader is None:
            return blocks
        for entry in attachments:
            if not isinstance(entry, dict):
                continue
            file_id = entry.get("fileId") or entry.get("id")
            if not isinstance(file_id, str) or not file_id:
                continue
            media_type = str(entry.get("mediaType") or entry.get("media_type") or "")
            name = str(entry.get("name") or file_id)
            try:
                data, original_name, detected_type = await self.attachment_downloader(
                    runtime.session_id, file_id
                )
            except Exception:
                logger.exception("attachment download failed file_id={}", file_id)
                blocks.append({"type": "text", "text": f"\n\nAttached file: {name}"})
                continue
            media = media_type or detected_type or "application/octet-stream"
            if media.startswith("image/"):
                import base64

                blocks.append(
                    {
                        "type": "image",
                        "mimeType": media,
                        "data": base64.b64encode(data).decode("ascii"),
                    }
                )
            else:
                blocks.append(
                    {
                        "type": "text",
                        "text": f"\n\nAttached file: {original_name or name} ({media})",
                    }
                )
        return blocks

    async def _ensure_client(self, *, skip_auto_auth: bool = False) -> AcpJsonRpcClient:
        async with self._start_lock:
            if (
                not self._needs_restart
                and self._client is not None
                and self._initialized
                and self._client.alive
            ):
                return self._client
            await self._shutdown_client_unlocked()
            command = self._command()
            started = time.perf_counter()
            # Process cwd is launch context only (None → inherit connector cwd).
            # Per-session workspace is always passed via session/new|load cwd.
            factory = self.client_factory or (
                lambda cmd, env, workdir: AcpJsonRpcClient(cmd, env=env, cwd=workdir)
            )
            client = factory(command, dict(self.manifest.env) or None, None)
            await client.start(
                notification_handler=self._on_notification,
                server_request_handler=self._on_server_request,
                exit_handler=self._on_client_exit,
            )
            try:
                # Cap initialize: cold agent spawn (esp. Cursor via shell shims)
                # previously hung for the default 120s and blocked UI.
                init = await client.request(
                    "initialize",
                    {
                        "protocolVersion": 1,
                        "clientCapabilities": {
                            **self.manifest.client_capabilities(),
                            "session": {"configOptions": {"boolean": {}}},
                        },
                        "clientInfo": {
                            "name": "agents-anywhere-connector",
                            "version": _connector_version(),
                        },
                    },
                    timeout=45.0,
                )
            except (AcpJsonRpcError, TimeoutError, asyncio.TimeoutError) as exc:
                stderr = client.stderr_excerpt
                await self._shutdown_client_unlocked()
                detail = str(exc)
                if stderr:
                    detail = f"{detail}; agent stderr: {stderr[:800]}"
                raise AcpJsonRpcError(
                    f"failed to initialize {self.runtime} ACP agent: {detail}"
                ) from exc
            self._agent_capabilities = (
                init.get("agentCapabilities")
                if isinstance(init.get("agentCapabilities"), dict)
                else {}
            )
            auth_methods = init.get("authMethods") if isinstance(init.get("authMethods"), list) else []
            self._auth_methods = [m for m in auth_methods if isinstance(m, dict)]
            if not skip_auto_auth:
                await self._maybe_authenticate(client)
            self._client = client
            self._initialized = True
            self._needs_restart = False
            log_stage(
                "adapter.ensure_client",
                elapsed_ms(started),
                runtime=self.runtime,
                command=" ".join(str(part) for part in command[:6]),
            )
            return client

    async def warm_start(self) -> None:
        """Best-effort pre-spawn of the ACP process so first session is faster."""
        try:
            await self._ensure_client()
        except Exception as exc:
            logger.info("{} warm_start skipped: {}", self.runtime, exc)

    async def _shutdown_client(self) -> None:
        async with self._start_lock:
            await self._shutdown_client_unlocked()

    async def _shutdown_client_unlocked(self) -> None:
        client = self._client
        self._client = None
        self._initialized = False
        if client is not None:
            try:
                await client.close()
            except Exception:
                logger.exception("{} failed to close ACP client", self.runtime)

    async def _on_client_exit(self) -> None:
        """Called when the agent process stdout closes unexpectedly."""
        logger.warning("{} ACP process exited", self.runtime)
        self._needs_restart = True
        self._initialized = False
        # Fail any in-flight turns so UI does not stick on running.
        for runtime in list(self._sessions.values()):
            for pending in list(runtime.pending_approvals.values()):
                if not pending.future.done():
                    pending.future.set_result("cancelled")
            if runtime.active_turn_id and runtime.reducer is not None:
                turn_id = runtime.active_turn_id
                try:
                    end = runtime.reducer.turn_end(
                        session_id=runtime.session_id,
                        turn_id=turn_id,
                        external_session_id=runtime.external_session_id,
                        stop_reason="agent_process_exited",
                        interrupted=True,
                    )
                    await self._emit_reduction(end)
                except Exception:
                    logger.exception("failed to finalize turn after process exit")
                await self._emit(
                    "runtime.error",
                    {
                        "sessionId": runtime.session_id,
                        "runtime": self.runtime,
                        "message": "ACP agent process exited",
                    },
                )

    async def _apply_session_settings(
        self,
        client: AcpJsonRpcClient,
        runtime: _SessionRuntime,
        params: dict[str, Any],
    ) -> None:
        """Map AA model/permissionMode/effort onto ACP session/set_config_option when available."""
        if not runtime.external_session_id:
            return
        model = _optional_string(params.get("model"))
        permission_mode = _optional_string(params.get("permissionMode"))
        effort = _optional_string(params.get("effort"))
        if not model and not permission_mode and not effort:
            return

        options = runtime.config_options
        model_opt = find_config_option(options, category="model", preferred_ids=("model", "llm", "models"))
        mode_opt = find_config_option(
            options, category="mode", preferred_ids=("mode", "permission", "permissionMode")
        )
        effort_opt = find_config_option(
            options,
            category="thought_level",
            preferred_ids=("effort", "reasoning", "thought_level", "thinking"),
        )
        model_id = _optional_string(model_opt.get("id")) if model_opt else None
        mode_id = _optional_string(mode_opt.get("id")) if mode_opt else None
        effort_id = _optional_string(effort_opt.get("id")) if effort_opt else None
        quirk_model = self.manifest.quirks.get("modelConfigId") if isinstance(self.manifest.quirks, dict) else None
        if isinstance(quirk_model, str) and quirk_model:
            model_id = model_id or quirk_model

        async def _set(config_id: str | None, value: str | None) -> None:
            if not config_id or not value:
                return
            try:
                result = await client.request(
                    "session/set_config_option",
                    {
                        "sessionId": runtime.external_session_id,
                        "configId": config_id,
                        "value": value,
                    },
                    timeout=30.0,
                )
                updated = result.get("configOptions") if isinstance(result.get("configOptions"), list) else None
                if updated is not None:
                    runtime.config_options = [opt for opt in updated if isinstance(opt, dict)]
            except AcpJsonRpcError as exc:
                # Fallback for Gemini-style unstable model API
                if config_id == model_id:
                    try:
                        await client.request(
                            "session/set_model",
                            {"sessionId": runtime.external_session_id, "modelId": value},
                            timeout=30.0,
                        )
                        return
                    except AcpJsonRpcError:
                        pass
                logger.warning(
                    "{} session/set_config_option id={} value={} failed: {}",
                    self.runtime,
                    config_id,
                    value,
                    exc,
                )

        await _set(model_id, model)
        await _set(mode_id, permission_mode)
        await _set(effort_id, effort)

        # If agent never advertised configOptions, still try common methods once.
        if not options and model:
            for method, body in (
                (
                    "session/set_config_option",
                    {
                        "sessionId": runtime.external_session_id,
                        "configId": "model",
                        "value": model,
                    },
                ),
                (
                    "session/set_model",
                    {"sessionId": runtime.external_session_id, "modelId": model},
                ),
                (
                    "unstable_setSessionModel",
                    {"sessionId": runtime.external_session_id, "modelId": model},
                ),
            ):
                try:
                    await client.request(method, body, timeout=15.0)
                    break
                except AcpJsonRpcError:
                    continue

    async def authenticate_interactive(self, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """User-triggered ACP login (browser OAuth or headless re-check).

        Never called from discovery/reconnect. First reuses local CLI credentials
        via session/new; only then calls authenticate for the chosen method.
        """
        params = params if isinstance(params, dict) else {}
        requested = _optional_string(params.get("methodId") or params.get("method_id"))
        # Skip auto headless auth on ensure — we re-probe and auth intentionally below.
        client = await self._ensure_client(skip_auto_auth=True)
        method_ids = [
            str(item.get("id") or item.get("methodId") or "")
            for item in self._auth_methods
            if (item.get("id") or item.get("methodId"))
        ]
        method_ids = [mid for mid in method_ids if mid]

        # Many agents (Cursor/Gemini) already have disk credentials — session/new
        # succeeds without calling authenticate (which often times out).
        probe = await self._probe_auth_and_options(client)
        if probe.get("authStatus") == "ok":
            probe["methodId"] = requested or "local_session"
            probe["reusedLocalCredentials"] = True
            await self._emit_auth_status(probe)
            return probe

        if requested:
            if requested not in method_ids:
                raise AcpJsonRpcError(
                    f"{self.manifest.display_name} does not advertise auth method {requested!r}. "
                    f"Available: {', '.join(method_ids) or '(none)'}"
                )
            ordered = [requested]
        else:
            ordered = order_interactive_auth_method_ids(
                method_ids,
                preferred=list(self.manifest.preferred_auth_method_ids),
            )
            if not ordered:
                ordered = order_headless_auth_method_ids(
                    method_ids,
                    preferred=list(self.manifest.preferred_auth_method_ids),
                )
        if not ordered:
            await self._emit_auth_status(probe)
            return probe

        last_error: str | None = None
        used_method: str | None = None
        for mid in ordered:
            # cursor_login / gemini-api-key can hang when re-prompting; use a longer
            # budget only for explicit user-triggered sign-in.
            timeout = (
                _INTERACTIVE_AUTH_TIMEOUT_S
                if is_interactive_auth_method(mid)
                else 45.0
            )
            try:
                logger.info(
                    "{} starting user-triggered authenticate method={} interactive={}",
                    self.runtime,
                    mid,
                    is_interactive_auth_method(mid),
                )
                await client.request(
                    "authenticate",
                    {"methodId": mid},
                    timeout=timeout,
                )
                used_method = mid
                break
            except Exception as exc:
                last_error = str(exc)
                logger.warning(
                    "{} interactive authenticate method={} failed: {}",
                    self.runtime,
                    mid,
                    exc,
                )
                continue

        if used_method is None:
            # Last chance: local credentials may still work without authenticate RPC.
            probe = await self._probe_auth_and_options(client)
            if probe.get("authStatus") == "ok":
                probe["methodId"] = "local_session"
                probe["reusedLocalCredentials"] = True
                await self._emit_auth_status(probe)
                return probe
            methods = summarize_auth_methods(self._auth_methods)
            names = ", ".join(m["name"] for m in methods) or "interactive login"
            detail = (
                f"Authentication failed for {self.manifest.display_name}. "
                f"Tried: {', '.join(ordered)}. Methods: {names}."
            )
            if last_error:
                detail = f"{detail} Last error: {last_error}"
            if self.manifest.pre_auth_hint:
                detail = f"{detail} Hint: {self.manifest.pre_auth_hint}"
            raise AcpJsonRpcError(detail)

        probe = await self._probe_auth_and_options(client)
        probe["methodId"] = used_method
        if probe.get("authStatus") != "ok":
            logger.info(
                "{} auth method={} returned but session still requires auth; restarting agent process",
                self.runtime,
                used_method,
            )
            self._needs_restart = True
            client = await self._ensure_client(skip_auto_auth=True)
            await self._maybe_authenticate(client)
            probe = await self._probe_auth_and_options(client)
            probe["methodId"] = used_method
            probe["restarted"] = True

        await self._emit_auth_status(probe)
        return probe

    def _raise_if_auth_blocked(self) -> None:
        if self._auth_status != "required":
            return
        methods = summarize_auth_methods(self._auth_methods)
        names = ", ".join(m["name"] for m in methods) or "interactive login"
        detail = self._auth_hint or (
            f"Authentication required for {self.manifest.display_name}. "
            f"ACP auth methods: {names}. "
            "Use Sign in in Agents Anywhere to complete browser OAuth on this device "
            "(interactive TUI login does not always satisfy headless ACP)."
        )
        raise AcpJsonRpcError(detail)

    def _set_auth_status(self, status: str, hint: str | None = None) -> None:
        self._auth_status = status
        if status == "required":
            self._auth_hint = hint or self._auth_hint
        elif status == "ok":
            self._auth_hint = None

    async def _mark_auth_required(self, raw_detail: str) -> str:
        methods = summarize_auth_methods(self._auth_methods)
        names = ", ".join(m["name"] for m in methods) or "interactive login"
        detail = (
            f"Authentication required for {self.manifest.display_name}. "
            f"ACP auth methods: {names}. "
            "Use Sign in in Agents Anywhere to complete browser OAuth on this device "
            "(interactive TUI login does not always satisfy headless ACP)."
        )
        if self.manifest.pre_auth_hint:
            detail = f"{detail} Hint: {self.manifest.pre_auth_hint}"
        elif raw_detail and not _is_authish_error(raw_detail):
            detail = f"{detail} ({raw_detail[:200]})"
        self._set_auth_status("required", detail)
        try:
            await self._emit(
                "runtime.optionsUpdated",
                {
                    "runtime": self.runtime,
                    "authStatus": "required",
                    "authMethods": methods,
                    "authHint": detail,
                    "sourceObservedAt": utc_now(),
                },
            )
        except Exception:
            pass
        return detail

    async def _probe_auth_and_options(self, client: AcpJsonRpcClient) -> dict[str, Any]:
        """session/new probe: authStatus + live model/mode options."""
        methods = summarize_auth_methods(self._auth_methods)
        probe: dict[str, Any] = {
            "runtime": self.runtime,
            "authStatus": "unknown",
            "authMethods": methods,
            "modelOptions": [],
            "modeOptions": [],
            "configOptions": [],
        }
        with tempfile.TemporaryDirectory(prefix="aa-acp-auth-") as tmp:
            try:
                session = await client.request(
                    "session/new",
                    {"cwd": tmp, "mcpServers": []},
                    timeout=_SESSION_NEW_TIMEOUT_S,
                )
            except AcpJsonRpcError as exc:
                message = str(exc)
                if _is_authish_error(message):
                    names = ", ".join(m["name"] for m in methods) or "interactive login"
                    probe["authStatus"] = "required"
                    probe["authHint"] = self.manifest.pre_auth_hint or (
                        f"{self.manifest.display_name} still requires authentication "
                        f"({names}). Complete login on the device running the connector, "
                        "then try again."
                    )
                    self._set_auth_status("required", probe["authHint"])
                    return probe
                probe["authStatus"] = "unknown"
                probe["error"] = message
                self._set_auth_status("unknown")
                return probe

        probe["authStatus"] = "ok"
        self._set_auth_status("ok")
        config_options = session.get("configOptions") if isinstance(session.get("configOptions"), list) else []
        config_options = [opt for opt in config_options if isinstance(opt, dict)]
        if config_options:
            probe["configOptions"] = config_options
            models = extract_model_options(config_options)
            modes = extract_mode_options(config_options)
            if models:
                probe["modelOptions"] = models
            if modes:
                probe["modeOptions"] = modes
        session_id = session.get("sessionId") or session.get("session_id")
        if isinstance(session_id, str) and session_id:
            for method in ("session/close", "session/cancel"):
                try:
                    if method == "session/cancel":
                        await client.notify(method, {"sessionId": session_id})
                    else:
                        await client.request(method, {"sessionId": session_id}, timeout=3.0)
                    break
                except Exception:
                    continue
        return probe

    async def _emit_auth_status(self, probe: dict[str, Any]) -> None:
        status = str(probe.get("authStatus") or "unknown")
        hint = probe.get("authHint") if isinstance(probe.get("authHint"), str) else None
        self._set_auth_status(status, hint)
        payload: dict[str, Any] = {
            "runtime": self.runtime,
            "authStatus": status,
            "authMethods": probe.get("authMethods") or summarize_auth_methods(self._auth_methods),
            "sourceObservedAt": utc_now(),
        }
        if hint:
            payload["authHint"] = hint
        for key in ("configOptions", "modelOptions", "modeOptions"):
            if probe.get(key) is not None:
                payload[key] = probe[key]
        await self._emit("runtime.optionsUpdated", payload)

    async def _maybe_authenticate(self, client: AcpJsonRpcClient) -> bool:
        """Best-effort headless auth only. Never open browser OAuth.

        Avoids expensive session/new probes on every ensure_client (was adding
        10–20s before the first user turn). Real auth is verified on session/new.
        """
        if not self._auth_methods:
            return True
        method_ids = [
            str(item.get("id") or item.get("methodId") or "")
            for item in self._auth_methods
            if (item.get("id") or item.get("methodId"))
        ]
        method_ids = [mid for mid in method_ids if mid]
        ordered = order_headless_auth_method_ids(
            method_ids,
            preferred=list(self.manifest.preferred_auth_method_ids),
        )
        if not ordered:
            # Interactive-only agents (CodeBuddy): skip; session/new will surface auth.
            return True
        for mid in ordered:
            try:
                await client.request(
                    "authenticate",
                    {"methodId": mid, "_meta": {"headless": True}},
                    timeout=4.0,
                )
                logger.info("{} authenticated via method={}", self.runtime, mid)
                return True
            except Exception as exc:
                logger.debug(
                    "{} authenticate method={} failed: {}",
                    self.runtime,
                    mid,
                    exc,
                )
                continue
        # Do not fail ensure_client — create_session will report auth errors.
        logger.info(
            "{} headless auth not confirmed; will verify on session/new methods={}",
            self.runtime,
            method_ids,
        )
        return True

    def _command(self) -> list[str]:
        if self.launch is not None:
            return self.launch.command(self.manifest.launch_args())
        binary = self.manifest.command[0]
        target = launch_target("cli", binary)
        if len(self.manifest.command) == 1:
            return target.command(self.manifest.launch_args())
        return list(self.manifest.command) + self.manifest.launch_args()

    async def _on_notification(self, payload: dict[str, Any]) -> None:
        method = payload.get("method")
        if method != "session/update":
            return
        params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
        external = _optional_string(params.get("sessionId") or params.get("session_id"))
        update = params.get("update") if isinstance(params.get("update"), dict) else {}
        runtime = self._session_by_external(external)
        if runtime is None or runtime.reducer is None or runtime.active_turn_id is None:
            return
        reduced = runtime.reducer.reduce_session_update(
            session_id=runtime.session_id,
            turn_id=runtime.active_turn_id,
            external_session_id=runtime.external_session_id,
            update=update,
        )
        await self._emit_reduction(reduced)

    async def _on_server_request(
        self,
        request_id: str | int,
        method: str,
        params: dict[str, Any],
    ) -> dict[str, Any] | None:
        if method == "session/request_permission":
            return await self._handle_permission(request_id, params)
        if method.startswith("cursor/"):
            return self._handle_cursor_extension(method, params)
        if method.startswith("fs/"):
            if method == "fs/read_text_file":
                raise AcpJsonRpcError("fs/read_text_file not implemented in connector v1")
            raise AcpJsonRpcError(f"Unsupported fs method: {method}")
        logger.warning("ACP unsupported server request method={}", method)
        return {}

    async def _handle_permission(
        self,
        request_id: str | int,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        external = _optional_string(params.get("sessionId") or params.get("session_id"))
        runtime = self._session_by_external(external)
        if runtime is None or runtime.reducer is None:
            return {"outcome": {"outcome": "cancelled"}}
        turn_id = runtime.active_turn_id or f"turn_{self.runtime}_perm"
        reduced = runtime.reducer.reduce_permission_request(
            session_id=runtime.session_id,
            turn_id=turn_id,
            external_session_id=runtime.external_session_id,
            request_id=request_id,
            params=params,
        )
        await self._emit_reduction(reduced)
        approval = reduced.approval or {}
        approval_id = str(approval.get("id") or request_id)
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str] = loop.create_future()
        options = params.get("options") if isinstance(params.get("options"), list) else []
        runtime.pending_approvals[approval_id] = _PendingApproval(
            request_id=request_id,
            future=future,
            options=[opt for opt in options if isinstance(opt, dict)],
        )
        try:
            status = await asyncio.wait_for(future, timeout=60 * 60)
        except TimeoutError:
            status = "cancelled"
        finally:
            runtime.pending_approvals.pop(approval_id, None)
        if status == "cancelled":
            return {"outcome": {"outcome": "cancelled"}}
        option_id = map_approval_status_to_option(status, options if isinstance(options, list) else [])
        if option_id is None:
            if status in {"approved", "approved_for_session"} and options:
                first = options[0] if isinstance(options[0], dict) else {}
                option_id = str(first.get("optionId") or first.get("option_id") or "allow-once")
            else:
                return {"outcome": {"outcome": "cancelled"}}
        return {"outcome": {"outcome": "selected", "optionId": option_id}}

    def _handle_cursor_extension(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        del params
        quirks = self.manifest.quirks.get("extensionMethods") if isinstance(self.manifest.quirks, dict) else {}
        policy = (quirks or {}).get(method, "ignore")
        if method == "cursor/ask_question":
            return {"outcome": {"outcome": "skipped", "reason": "not supported by Agents Anywhere v1"}}
        if method == "cursor/create_plan":
            if policy in {"accept", "ignore"}:
                return {"outcome": {"outcome": "accepted"}}
            return {"outcome": {"outcome": "rejected", "reason": "not supported"}}
        return {"outcome": {"outcome": "accepted"}}

    def _session_by_external(self, external: str | None) -> _SessionRuntime | None:
        if not external:
            return None
        for runtime in self._sessions.values():
            if runtime.external_session_id == external:
                return runtime
        return None

    async def _emit_reduction(self, reduced: Any) -> None:
        if reduced.session_update:
            await self._emit("session.updated", reduced.session_update)
        for item in reduced.timeline_items:
            item_type = item.get("type") if isinstance(item, dict) else None
            timer = None
            session_id = item.get("sessionId") if isinstance(item, dict) else None
            if isinstance(session_id, str):
                session_runtime = self._sessions.get(session_id)
                timer = session_runtime.turn_timer if session_runtime is not None else None
            if timer is not None and item_type not in {"turn.start", "turn.end"}:
                if (
                    item_type == "message"
                    and isinstance(item, dict)
                    and item.get("role") == "assistant"
                    and isinstance(item.get("content"), dict)
                    and (
                        (isinstance(item["content"].get("text"), str) and item["content"]["text"].strip())
                        or (isinstance(item["content"].get("rawText"), str) and item["content"]["rawText"].strip())
                    )
                ):
                    timer.mark_first_timeline(
                        runtime=self.runtime,
                        session_id=session_id,
                        turn_id=item.get("turnId") if isinstance(item, dict) else None,
                        stage_alias="adapter.first_assistant_token",
                    )
            await self._emit("timeline.itemUpsert", {"sessionId": item["sessionId"], "item": item})
        if reduced.approval:
            await self._emit("approval.requested", reduced.approval)

    async def _emit(self, method: str, params: dict[str, Any]) -> None:
        if self.notification_sink is None:
            return
        await self.notification_sink(method, params)


def _required(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"missing {key}")
    return value


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _require_cwd(params: dict[str, Any]) -> str:
    cwd = _optional_string(params.get("cwd"))
    if not cwd:
        raise ValueError("missing cwd: ACP sessions require an absolute workspace path")
    return cwd


def _is_authish_error(message: str) -> bool:
    lowered = message.lower()
    return any(token in lowered for token in _AUTH_ERROR_TOKENS)


def _attachments_metadata(params: dict[str, Any]) -> list[dict[str, Any]] | None:
    raw = params.get("timelineAttachments") or params.get("attachments")
    if not isinstance(raw, list):
        return None
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        file_id = entry.get("fileId") or entry.get("id")
        if not isinstance(file_id, str):
            continue
        item: dict[str, Any] = {"fileId": file_id}
        for key in ("name", "mediaType", "size", "sha256"):
            if entry.get(key) is not None:
                item[key] = entry[key]
        out.append(item)
    return out or None


def _max_turn_seconds(manifest: AgentManifest) -> float | None:
    quirks = manifest.quirks if isinstance(manifest.quirks, dict) else {}
    raw = quirks.get("maxTurnSeconds", _DEFAULT_MAX_TURN_SECONDS)
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return float(_DEFAULT_MAX_TURN_SECONDS)
    if value <= 0:
        return None
    return value


def _connector_version() -> str:
    try:
        from importlib.metadata import version

        return version("anywhere-cli")
    except Exception:
        return "0.1.7"



