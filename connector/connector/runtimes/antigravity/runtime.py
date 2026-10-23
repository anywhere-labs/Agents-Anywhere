from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAttachment,
    RuntimeCapabilitySet,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeOperationResult,
    RuntimeSessionStateCache,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.antigravity.discovery import (
    find_antigravity_ls,
    get_antigravity_env,
)
from connector.runtimes.antigravity.provider_config import (
    DEFAULT_AGENTAPI_PATH,
    DEFAULT_ANTIGRAVITY_DIR,
    antigravity_capabilities,
    antigravity_session_capabilities,
)
from connector.runtimes.antigravity.sessions import AntigravitySessionReader
from connector.runtimes.antigravity.timeline import AntigravityTimelineReader
from connector.runtimes.custom_models import custom_model_items
from connector.server.protocol import protocol_selection_id

BUILTIN_MODELS: tuple[str, ...] = ("flash", "pro", "flash_lite")


def antigravity_model_selection_id(model_id: str) -> str:
    return protocol_selection_id("antigravity", "model", {"model_id": model_id})


def resolve_model_id(
    selection_or_model: str | None,
    allowed_models: tuple[str, ...] | set[str] = BUILTIN_MODELS,
    default_model: str = "flash",
) -> str:
    if not selection_or_model:
        if default_model in allowed_models:
            return default_model
        return "flash"

    allowed_set = set(allowed_models)
    if selection_or_model in allowed_set:
        return selection_or_model

    for mid in allowed_set:
        if selection_or_model == antigravity_model_selection_id(mid):
            return mid

    raise RuntimeInvalidRequestError(f"Unsupported model: {selection_or_model}")


class AntigravityRuntime(AgentRuntime):
    def __init__(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
        *,
        agentapi_path: Path | None = None,
        session_reader: AntigravitySessionReader | None = None,
        timeline_reader: AntigravityTimelineReader | None = None,
        poll_interval: float = 1.5,
        max_duration_seconds: float = 300.0,
    ) -> None:
        self.config = config
        self.host = host
        self._identity = RuntimeIdentity(
            runtime="antigravity",
            runtime_version="2.14.0",
            display_name="Antigravity",
            protocol_version="1.0",
        )
        self._session_reader = session_reader or AntigravitySessionReader()
        self._timeline_reader = timeline_reader or AntigravityTimelineReader()
        self._agentapi_path = agentapi_path or Path(
            config.values.get("agentapiPath") or DEFAULT_AGENTAPI_PATH
        )
        self._poll_interval = poll_interval
        self._max_duration_seconds = max_duration_seconds
        self._session_states = RuntimeSessionStateCache("antigravity", self.host)
        self._session_selections: dict[str, dict[str, str | None]] = {}
        self._map_file = DEFAULT_ANTIGRAVITY_DIR / "anywhere_session_map.json"
        self._session_map: dict[str, str] = {}
        self._external_to_session: dict[str, str] = {}
        self._load_session_map()

    def _load_session_map(self) -> None:
        if self._map_file.exists():
            try:
                data = json.loads(self._map_file.read_text("utf-8"))
                if isinstance(data, dict):
                    self._session_map.update(data)
                    self._external_to_session.update({v: k for k, v in data.items()})
            except Exception as e:
                logger.warning(
                    f"[Antigravity] Failed to load session map from {self._map_file}: {e}"
                )

    def _save_session_map(self) -> None:
        try:
            current: dict[str, str] = {}
            if self._map_file.exists():
                try:
                    loaded = json.loads(self._map_file.read_text("utf-8"))
                    if isinstance(loaded, dict):
                        current.update(loaded)
                except Exception:
                    pass
            current.update(self._session_map)
            self._session_map.update(current)
            self._map_file.write_text(
                json.dumps(self._session_map, indent=2, ensure_ascii=False), "utf-8"
            )
        except Exception as e:
            logger.warning(
                f"[Antigravity] Failed to save session map to {self._map_file}: {e}"
            )

    def _is_valid_antigravity_conversation(self, cid: str) -> bool:
        if not cid or cid.startswith("sess_") or len(cid) != 36:
            return False
        transcript_path = (
            self._timeline_reader.brain_dir
            / cid
            / ".system_generated"
            / "logs"
            / "transcript.jsonl"
        )
        return transcript_path.exists()

    def _get_default_model(self) -> str:
        configured = self.config.values.get("defaultModel")
        if configured and configured in self._get_allowed_models():
            return str(configured)
        return "flash"

    def _get_allowed_models(self) -> set[str]:
        models = set(BUILTIN_MODELS)
        raw_custom = self.config.values.get("customModels")
        if isinstance(raw_custom, list):
            for item in raw_custom:
                if isinstance(item, dict) and "modelId" in item:
                    models.add(str(item["modelId"]))
        return models

    def _resolve_model_id(self, selection_or_model: str | None) -> str:
        return resolve_model_id(
            selection_or_model,
            allowed_models=self._get_allowed_models(),
            default_model=self._get_default_model(),
        )

    def get_effective_session_selections(
        self, session_id: str, external_session_id: str | None = None
    ) -> dict[str, str | None]:
        if session_id in self._session_selections:
            return dict(self._session_selections[session_id])
        if external_session_id and external_session_id in self._session_selections:
            return dict(self._session_selections[external_session_id])
        cached = self._session_states.get(session_id)
        if cached and cached.selections:
            return dict(cached.selections)
        if external_session_id:
            cached_ext = self._session_states.get_by_external_session_id(
                external_session_id
            )
            if cached_ext and cached_ext.selections:
                return dict(cached_ext.selections)
        default_model = self._get_default_model()
        return {"model": antigravity_model_selection_id(default_model)}

    def _validate_and_normalize_selections(
        self, selections: Mapping[str, str | None]
    ) -> dict[str, str | None]:
        normalized: dict[str, str | None] = {}
        for key, val in selections.items():
            if key == "model":
                if val is None:
                    normalized["model"] = None
                else:
                    resolved = self._resolve_model_id(val)
                    normalized["model"] = antigravity_model_selection_id(resolved)
            else:
                normalized[key] = val
        return normalized

    async def _create_new_conversation(
        self,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
    ) -> tuple[bool, str, str]:
        env, work_dir = get_antigravity_env(cwd=cwd)
        raw_model = (selections or {}).get("model") or self._get_default_model()
        model = self._resolve_model_id(raw_model)

        args = [str(self._agentapi_path), "new-conversation", f"--model={model}"]
        if title:
            args.append(f"--title={title}")
        args.append(content)

        proc = await asyncio.create_subprocess_exec(
            *args,
            env=env,
            cwd=work_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_b, stderr_b = await proc.communicate()
        stdout_str = stdout_b.decode("utf-8", errors="replace").strip()
        stderr_str = stderr_b.decode("utf-8", errors="replace").strip()

        if proc.returncode != 0:
            err_msg = stderr_str or stdout_str or "Failed to create conversation"
            return False, "", err_msg

        external_id = ""
        try:
            data = json.loads(stdout_str)
            resp = data.get("response", {})
            if "newConversation" in resp:
                external_id = resp["newConversation"].get("conversationId", "")
            elif "conversationId" in resp:
                external_id = resp.get("conversationId", "")
        except Exception:
            pass

        if not external_id:
            return False, "", f"Could not parse conversationId from: {stdout_str}"

        return True, external_id, ""

    @property
    def sync_mode(self) -> str:
        return "polling"

    @property
    def identity(self) -> RuntimeIdentity:
        return self._identity

    async def start(self) -> None:
        logger.info("[Antigravity] Starting Antigravity runtime adapter")
        pid, csrf, ls_addr = find_antigravity_ls()
        if pid is not None:
            await self.host.runtime_health_update("running")
            logger.info(
                f"[Antigravity] Successfully started Antigravity runtime (PID: {pid}, LS: {ls_addr})"
            )
        else:
            await self.host.runtime_health_update(
                "starting",
                {
                    "code": "antigravity_not_running",
                    "message": "Antigravity language server is not detected running.",
                    "retryable": True,
                },
            )

    async def stop(self) -> None:
        logger.info("[Antigravity] Stopping Antigravity runtime adapter")
        await self.host.runtime_health_update("stopped")

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        return antigravity_capabilities(self.host.connector_id)

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        default_model = self._get_default_model()
        builtins = [
            RuntimeModelItem(
                id="flash",
                title="Gemini Flash",
                selection_id=antigravity_model_selection_id("flash"),
                description="Fast and versatile model for coding and general tasks (Default)",
                enabled=True,
                metadata={
                    "provider": "google",
                    "tier": "flash",
                    "is_recommended": default_model == "flash",
                },
            ),
            RuntimeModelItem(
                id="pro",
                title="Gemini Pro",
                selection_id=antigravity_model_selection_id("pro"),
                description="Deep reasoning model for complex architectural analysis",
                enabled=True,
                metadata={
                    "provider": "google",
                    "tier": "pro",
                    "is_recommended": default_model == "pro",
                },
            ),
            RuntimeModelItem(
                id="flash_lite",
                title="Gemini Flash Lite",
                selection_id=antigravity_model_selection_id("flash_lite"),
                description="Low-latency lightweight model for fast responses",
                enabled=True,
                metadata={
                    "provider": "google",
                    "tier": "flash_lite",
                    "is_recommended": default_model == "flash_lite",
                },
            ),
        ]
        custom = custom_model_items(
            runtime="antigravity",
            raw=self.config.values.get("customModels"),
            existing_model_ids=set(BUILTIN_MODELS),
        )
        all_models = tuple(builtins) + tuple(custom)
        if query:
            lowered = query.casefold()
            all_models = tuple(
                m
                for m in all_models
                if lowered in m.id.casefold() or lowered in m.title.casefold()
            )
        return RuntimeModelCatalog(
            runtime="antigravity",
            revision=self.config.revision,
            models=all_models[:limit],
        )

    def _resolve_external_id(
        self, session_id: str, external_session_id: str | None = None
    ) -> str:
        if external_session_id and not external_session_id.startswith("sess_"):
            self._session_map[session_id] = external_session_id
            self._external_to_session[external_session_id] = session_id
            self._save_session_map()
            return external_session_id
        if session_id in self._session_map:
            return self._session_map[session_id]
        if self._map_file.exists():
            try:
                data = json.loads(self._map_file.read_text("utf-8"))
                if isinstance(data, dict) and session_id in data:
                    self._session_map[session_id] = data[session_id]
                    self._external_to_session[data[session_id]] = session_id
                    return data[session_id]
            except Exception:
                pass
        return session_id

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        sessions = self._session_reader.list_sessions(
            limit=limit, cursor=cursor, force=force
        )
        for s in sessions:
            ext = s.external_session_id or s.session_id
            self._session_map[s.session_id] = ext
            if s.external_session_id:
                self._external_to_session[s.external_session_id] = s.session_id
        return sessions

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        cid = self._resolve_external_id(session_id, external_session_id)
        return self._timeline_reader.get_session_snapshot(
            session_id=session_id,
            external_session_id=cid,
            limit=limit,
        )

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        cid = self._resolve_external_id(session_id, external_session_id)
        selections = self.get_effective_session_selections(session_id, cid)
        return self._session_reader.get_session_state(
            session_id=session_id,
            external_session_id=cid,
            selections=selections,
            default_model=self._get_default_model(),
        )

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        return ()

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        return antigravity_session_capabilities(
            session_id=session_id,
            connector_id=self.host.connector_id,
            revision=self.config.revision,
        )

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
        logger.info(
            f"[Antigravity] create_and_start_session: session_id={session_id}, title={title}, content={content[:50]}"
        )
        try:
            effective_selections = (
                self._validate_and_normalize_selections(selections)
                if selections
                else self.get_effective_session_selections(session_id)
            )
        except RuntimeInvalidRequestError as exc:
            return RuntimeOperationResult(
                ok=False,
                code="INVALID_REQUEST",
                message=str(exc),
            )

        self._session_selections[session_id] = effective_selections

        ok, external_id, err_msg = await self._create_new_conversation(
            content=content,
            title=title,
            cwd=cwd,
            selections=effective_selections,
        )
        if not ok:
            logger.error(f"[Antigravity] create_and_start_session failed: {err_msg}")
            return RuntimeOperationResult(
                ok=False,
                code="AGENTAPI_ERROR",
                message=err_msg,
            )

        self._session_map[session_id] = external_id
        self._external_to_session[external_id] = session_id
        self._session_selections[external_id] = effective_selections
        self._save_session_map()

        session_title = title or (content[:30] + ("..." if len(content) > 30 else ""))
        await self.host.session_meta_upsert(
            session_id=session_id,
            runtime="antigravity",
            external_session_id=external_id,
            title=session_title,
            cwd=cwd,
            metadata={"source": "antigravity.create_and_start_session"},
        )
        await self._session_states.update(
            session_id=session_id,
            external_session_id=external_id,
            status="running",
            selections=effective_selections,
            metadata={"source": "antigravity.create_and_start_session"},
        )
        await self.host.session_capabilities_update(
            antigravity_session_capabilities(
                session_id=session_id,
                connector_id=self.host.connector_id,
                revision=self.config.revision,
            )
        )

        asyncio.create_task(
            self._poll_turn_completion(
                session_id=session_id,
                external_session_id=external_id,
                selections=effective_selections,
            )
        )

        return RuntimeOperationResult(
            ok=True,
            result={
                "sessionId": session_id,
                "externalSessionId": external_id,
            },
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
        cid = self._resolve_external_id(session_id, external_session_id)
        logger.info(
            f"[Antigravity] start_turn for conversation {cid} (session_id={session_id}): {content[:50]}"
        )

        try:
            effective_selections = (
                self._validate_and_normalize_selections(selections)
                if selections
                else self.get_effective_session_selections(session_id, cid)
            )
        except RuntimeInvalidRequestError as exc:
            return RuntimeOperationResult(
                ok=False,
                code="INVALID_REQUEST",
                message=str(exc),
            )

        self._session_selections[session_id] = effective_selections
        if cid:
            self._session_selections[cid] = effective_selections

        # If not a valid existing Antigravity conversation (e.g. unmapped sess_...), auto-initialize!
        if not self._is_valid_antigravity_conversation(cid):
            logger.info(
                f"[Antigravity] Session {session_id} has no valid Antigravity conversation ({cid}), auto-creating conversation"
            )
            ok, new_cid, err_msg = await self._create_new_conversation(
                content=content,
                title=content[:30],
                cwd=cwd,
                selections=effective_selections,
            )
            if not ok:
                logger.error(
                    f"[Antigravity] Auto-create conversation failed: {err_msg}"
                )
                return RuntimeOperationResult(
                    ok=False,
                    code="AGENTAPI_ERROR",
                    message=err_msg,
                )
            cid = new_cid
            self._session_map[session_id] = cid
            self._external_to_session[cid] = session_id
            self._session_selections[cid] = effective_selections
            self._save_session_map()

            await self.host.session_meta_upsert(
                session_id=session_id,
                runtime="antigravity",
                external_session_id=cid,
                title=content[:30],
                cwd=cwd,
                metadata={"source": "antigravity.start_turn.auto_create"},
            )
            await self._session_states.update(
                session_id=session_id,
                external_session_id=cid,
                status="running",
                selections=effective_selections,
                metadata={"source": "antigravity.start_turn.auto_create"},
            )
            asyncio.create_task(
                self._poll_turn_completion(
                    session_id=session_id,
                    external_session_id=cid,
                    selections=effective_selections,
                )
            )
            return RuntimeOperationResult(
                ok=True,
                result={
                    "sessionId": session_id,
                    "externalSessionId": cid,
                },
            )

        # Existing conversation: send message
        env, work_dir = get_antigravity_env(cwd=cwd, conversation_id=cid)
        args = [
            str(self._agentapi_path),
            "send-message",
            cid,
            content,
        ]

        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                env=env,
                cwd=work_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, stderr_b = await proc.communicate()
            stdout_str = stdout_b.decode("utf-8", errors="replace").strip()
            stderr_str = stderr_b.decode("utf-8", errors="replace").strip()

            if proc.returncode != 0:
                err_msg = stderr_str or stdout_str or "Failed to send message"
                logger.warning(
                    f"[Antigravity] agentapi send-message failed on {cid}: {err_msg}"
                )
                if (
                    "does not match target project_id" in err_msg
                    or "permission_denied" in err_msg
                ):
                    logger.info(
                        f"[Antigravity] Project mismatch on {cid}, auto-creating new conversation under active project"
                    )
                    ok, new_cid, _create_err = await self._create_new_conversation(
                        content=content,
                        title=content[:30],
                        cwd=cwd,
                        selections=effective_selections,
                    )
                    if ok:
                        cid = new_cid
                        self._session_map[session_id] = cid
                        self._external_to_session[cid] = session_id
                        self._session_selections[cid] = effective_selections
                        self._save_session_map()
                        await self.host.session_meta_upsert(
                            session_id=session_id,
                            runtime="antigravity",
                            external_session_id=cid,
                            title=content[:30],
                            cwd=cwd,
                        )
                        await self._session_states.update(
                            session_id=session_id,
                            external_session_id=cid,
                            status="running",
                            selections=effective_selections,
                        )
                        asyncio.create_task(
                            self._poll_turn_completion(
                                session_id=session_id,
                                external_session_id=cid,
                                selections=effective_selections,
                            )
                        )
                        return RuntimeOperationResult(
                            ok=True,
                            result={
                                "sessionId": session_id,
                                "externalSessionId": cid,
                            },
                        )
                return RuntimeOperationResult(
                    ok=False,
                    code="AGENTAPI_ERROR",
                    message=err_msg,
                )

            await self._session_states.update(
                session_id=session_id,
                external_session_id=cid,
                status="running",
                selections=effective_selections,
                metadata={"source": "antigravity.start_turn"},
            )

            asyncio.create_task(
                self._poll_turn_completion(
                    session_id=session_id,
                    external_session_id=cid,
                    selections=effective_selections,
                )
            )

            return RuntimeOperationResult(
                ok=True,
                result={
                    "sessionId": session_id,
                    "externalSessionId": cid,
                    "output": stdout_str,
                },
            )
        except Exception as exc:
            logger.error(f"[Antigravity] Exception in start_turn: {exc}")
            return RuntimeOperationResult(
                ok=False,
                code="EXECUTION_ERROR",
                message=str(exc),
            )

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        cid = self._resolve_external_id(session_id, external_session_id)
        try:
            validated = self._validate_and_normalize_selections(selections)
        except RuntimeInvalidRequestError as exc:
            return RuntimeOperationResult(
                ok=False,
                code="antigravity_invalid_selection",
                message=str(exc),
            )

        current = self.get_effective_session_selections(session_id, cid)
        current.update(validated)
        self._session_selections[session_id] = current
        if cid:
            self._session_selections[cid] = current

        state = self._session_reader.get_session_state(
            session_id=session_id,
            external_session_id=cid,
            selections=current,
            default_model=self._get_default_model(),
        )
        await self._session_states.update(
            session_id=session_id,
            external_session_id=cid,
            status=state.status,
            selections=current,
            metadata={"source": "antigravity.session.selections.update"},
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "sessionId": session_id,
                "externalSessionId": cid,
                "selections": current,
                "updated": True,
            },
        )

    async def _poll_turn_completion(
        self,
        session_id: str,
        external_session_id: str,
        selections: Mapping[str, str | None] | None = None,
        max_duration_seconds: float | None = None,
        poll_interval: float | None = None,
    ) -> None:
        """Polls conversation status and transcript until turn finishes, streaming timeline updates."""
        poll_int = (
            poll_interval if poll_interval is not None else self._poll_interval
        )
        max_dur = (
            max_duration_seconds
            if max_duration_seconds is not None
            else self._max_duration_seconds
        )
        elapsed = 0.0

        try:
            initial_snapshot = self._timeline_reader.get_session_snapshot(
                session_id=session_id,
                external_session_id=external_session_id,
            )
            initial_item_count = len(initial_snapshot.items)
        except Exception:
            initial_item_count = 0

        initial_wait = min(poll_int, 1.0)
        await asyncio.sleep(initial_wait)
        elapsed += initial_wait

        last_item_count = initial_item_count
        saw_running = False

        while elapsed < max_dur:
            try:
                snapshot = self._timeline_reader.get_session_snapshot(
                    session_id=session_id,
                    external_session_id=external_session_id,
                )
                if snapshot.items and len(snapshot.items) != last_item_count:
                    last_item_count = len(snapshot.items)
                    await self.host.timeline_sync(
                        session_id=session_id,
                        runtime="antigravity",
                        items=snapshot.items,
                        external_session_id=external_session_id,
                        complete=False,
                    )

                state = self._session_reader.get_session_state(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    selections=selections,
                    default_model=self._get_default_model(),
                )
                if state and state.status == "running":
                    saw_running = True

                is_idle = state is not None and state.status == "idle"
                last_role = snapshot.items[-1].role if snapshot.items else None
                has_new_assistant_response = (
                    len(snapshot.items) > initial_item_count
                    and last_role == "assistant"
                )

                if is_idle and last_role != "user" and (
                    saw_running or has_new_assistant_response
                ):
                    logger.info(
                        f"[Antigravity] Turn completed for session {session_id} (ext={external_session_id}), syncing final timeline with {len(snapshot.items)} items."
                    )
                    await self.host.timeline_sync(
                        session_id=session_id,
                        runtime="antigravity",
                        items=snapshot.items,
                        external_session_id=external_session_id,
                        complete=True,
                    )
                    await self._session_states.update(
                        session_id=session_id,
                        external_session_id=external_session_id,
                        status="idle",
                        selections=selections,
                        metadata={"source": "antigravity.turn_completion"},
                    )
                    await self.host.session_turn_ended(
                        session_id=session_id,
                        runtime="antigravity",
                        external_session_id=external_session_id,
                    )
                    return
            except Exception as e:
                logger.warning(f"[Antigravity] Error polling turn completion: {e}")

            await asyncio.sleep(poll_int)
            elapsed += poll_int

        logger.warning(
            f"[Antigravity] Turn polling timed out for session {session_id} after {max_dur}s"
        )
        try:
            snapshot = self._timeline_reader.get_session_snapshot(
                session_id=session_id,
                external_session_id=external_session_id,
            )
            state = self._session_reader.get_session_state(
                session_id=session_id,
                external_session_id=external_session_id,
                selections=selections,
                default_model=self._get_default_model(),
            )
            if state and state.status == "running":
                # Native status is STILL running!
                await self.host.timeline_sync(
                    session_id=session_id,
                    runtime="antigravity",
                    items=snapshot.items,
                    external_session_id=external_session_id,
                    complete=False,
                )
                await self._session_states.update(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    status="running",
                    selections=selections,
                    metadata={"source": "antigravity.turn_timeout_still_running"},
                )
                # DO NOT call session_turn_ended!
            else:
                await self.host.timeline_sync(
                    session_id=session_id,
                    runtime="antigravity",
                    items=snapshot.items,
                    external_session_id=external_session_id,
                    complete=True,
                )
                await self._session_states.update(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    status="idle",
                    selections=selections,
                    metadata={"source": "antigravity.turn_timeout_idle"},
                )
                await self.host.session_turn_ended(
                    session_id=session_id,
                    runtime="antigravity",
                    external_session_id=external_session_id,
                )
        except Exception as e:
            logger.warning(f"[Antigravity] Error handling turn timeout: {e}")
