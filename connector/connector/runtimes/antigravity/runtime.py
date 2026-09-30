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
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeOperationResult,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.antigravity.discovery import (
    get_antigravity_env,
    find_antigravity_ls,
)
from connector.runtimes.antigravity.provider_config import (
    DEFAULT_AGENTAPI_PATH,
    DEFAULT_ANTIGRAVITY_DIR,
    antigravity_capabilities,
    antigravity_session_capabilities,
)
from connector.runtimes.antigravity.sessions import AntigravitySessionReader
from connector.runtimes.antigravity.timeline import AntigravityTimelineReader
from connector.server.protocol import protocol_selection_id


def antigravity_model_selection_id(model_id: str) -> str:
    return protocol_selection_id("antigravity", "model", {"model_id": model_id})


_MODEL_TIER_MAPPING: dict[str, str] = {
    # Gemini models
    "flash": "flash",
    "pro": "pro",
    "flash_lite": "flash_lite",
    "gemini-3.8-flash": "flash",
    "gemini-3.7-flash": "flash",
    "gemini-3.6-flash": "flash",
    "gemini-3.1-pro": "pro",
    # Claude models
    "claude-sonnet-4-6": "pro",
    "claude-opus-4-6": "pro",
    "claude-haiku-4-5": "flash",
    # Open models
    "gpt-oss-120b": "flash",
}


def resolve_model_id(selection_or_model: str | None) -> str:
    if not selection_or_model:
        return "flash"
    for mid, tier in _MODEL_TIER_MAPPING.items():
        if selection_or_model == mid or selection_or_model == antigravity_model_selection_id(mid):
            return tier
    # Fallback: check if the string contains key identifiers
    lowered = selection_or_model.lower()
    if "pro" in lowered or "opus" in lowered or "sonnet" in lowered:
        return "pro"
    if "lite" in lowered or "haiku" in lowered:
        return "flash_lite"
    return "flash"




class AntigravityRuntime(AgentRuntime):
    def __init__(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> None:
        self.config = config
        self.host = host
        self._identity = RuntimeIdentity(
            runtime="antigravity",
            runtime_version="2.14.0",
            display_name="Antigravity",
            protocol_version="1.0",
        )
        self._session_reader = AntigravitySessionReader()
        self._timeline_reader = AntigravityTimelineReader()
        self._agentapi_path = Path(
            config.values.get("agentapiPath") or DEFAULT_AGENTAPI_PATH
        )
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
                logger.warning(f"[Antigravity] Failed to load session map from {self._map_file}: {e}")

    def _save_session_map(self) -> None:
        try:
            current = {}
            if self._map_file.exists():
                try:
                    current = json.loads(self._map_file.read_text("utf-8"))
                except Exception:
                    pass
            current.update(self._session_map)
            self._session_map.update(current)
            self._map_file.write_text(json.dumps(self._session_map, indent=2, ensure_ascii=False), "utf-8")
        except Exception as e:
            logger.warning(f"[Antigravity] Failed to save session map to {self._map_file}: {e}")

    def _is_valid_antigravity_conversation(self, cid: str) -> bool:
        if not cid or cid.startswith("sess_") or len(cid) != 36:
            return False
        transcript_path = (
            self._timeline_reader.brain_dir / cid / ".system_generated" / "logs" / "transcript.jsonl"
        )
        return transcript_path.exists()

    async def _create_new_conversation(
        self,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
    ) -> tuple[bool, str, str]:
        env, work_dir = get_antigravity_env(cwd=cwd)
        raw_model = (selections or {}).get("model") or self.config.values.get("defaultModel") or "flash"
        model = resolve_model_id(raw_model)

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
            # Supervisor strictly expects status to be "running"
            await self.host.runtime_health_update("running")
            logger.info(f"[Antigravity] Successfully started Antigravity runtime (PID: {pid}, LS: {ls_addr})")
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
        models = (
            RuntimeModelItem(
                id="gemini-3.8-flash",
                title="Gemini 3.8 Flash (High)",
                selection_id=antigravity_model_selection_id("gemini-3.8-flash"),
                description="Google flagship multimodal reasoning model (Default)",
                enabled=True,
                metadata={"provider": "google", "tier": "flash", "is_recommended": True},
            ),
            RuntimeModelItem(
                id="gemini-3.7-flash",
                title="Gemini 3.7 Flash (Medium)",
                selection_id=antigravity_model_selection_id("gemini-3.7-flash"),
                description="Fast and versatile hybrid reasoning model",
                enabled=True,
                metadata={"provider": "google", "tier": "flash"},
            ),
            RuntimeModelItem(
                id="gemini-3.6-flash",
                title="Gemini 3.6 Flash (Medium, Fast)",
                selection_id=antigravity_model_selection_id("gemini-3.6-flash"),
                description="Low-latency flash model with balanced reasoning",
                enabled=True,
                metadata={"provider": "google", "tier": "flash"},
            ),
            RuntimeModelItem(
                id="gemini-3.1-pro",
                title="Gemini 3.1 Pro (Low)",
                selection_id=antigravity_model_selection_id("gemini-3.1-pro"),
                description="Deep reasoning model for complex architectural analysis",
                enabled=True,
                metadata={"provider": "google", "tier": "pro"},
            ),
            RuntimeModelItem(
                id="claude-sonnet-4-6",
                title="Claude Sonnet 4.6 (Thinking)",
                selection_id=antigravity_model_selection_id("claude-sonnet-4-6"),
                description="Anthropic Claude Sonnet with extended thinking capabilities",
                enabled=True,
                metadata={"provider": "anthropic", "tier": "pro"},
            ),
            RuntimeModelItem(
                id="claude-opus-4-6",
                title="Claude Opus 4.6 (Thinking)",
                selection_id=antigravity_model_selection_id("claude-opus-4-6"),
                description="Anthropic Claude Opus flagship model with maximum reasoning depth",
                enabled=True,
                metadata={"provider": "anthropic", "tier": "pro"},
            ),
            RuntimeModelItem(
                id="claude-haiku-4-5",
                title="Claude Haiku 4.5",
                selection_id=antigravity_model_selection_id("claude-haiku-4-5"),
                description="Fast and efficient Claude model for quick edits and queries",
                enabled=True,
                metadata={"provider": "anthropic", "tier": "flash"},
            ),
            RuntimeModelItem(
                id="gpt-oss-120b",
                title="GPT-OSS 120B (Medium)",
                selection_id=antigravity_model_selection_id("gpt-oss-120b"),
                description="Open-weights 120B parameter reasoning model",
                enabled=True,
                metadata={"provider": "openai", "tier": "flash"},
            ),
            RuntimeModelItem(
                id="flash",
                title="Gemini Flash (Tier Auto)",
                selection_id=antigravity_model_selection_id("flash"),
                description="Direct Flash tier routing (Auto-selected latest flash)",
                enabled=True,
                metadata={"provider": "google", "tier": "flash"},
            ),
            RuntimeModelItem(
                id="pro",
                title="Gemini Pro (Tier Auto)",
                selection_id=antigravity_model_selection_id("pro"),
                description="Direct Pro tier routing (Auto-selected latest pro)",
                enabled=True,
                metadata={"provider": "google", "tier": "pro"},
            ),
            RuntimeModelItem(
                id="flash_lite",
                title="Gemini Flash Lite (Tier Auto)",
                selection_id=antigravity_model_selection_id("flash_lite"),
                description="Direct Flash Lite tier routing for lowest latency",
                enabled=True,
                metadata={"provider": "google", "tier": "flash_lite"},
            ),
        )
        if query:
            lowered = query.casefold()
            models = tuple(
                m for m in models
                if lowered in m.id.casefold() or lowered in m.title.casefold()
            )
        return RuntimeModelCatalog(
            runtime="antigravity",
            revision=2,
            models=models[:limit],
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
        return self._session_reader.get_session_state(
            session_id=session_id,
            external_session_id=cid,
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
        logger.info(f"[Antigravity] create_and_start_session: session_id={session_id}, title={title}, content={content[:50]}")
        ok, external_id, err_msg = await self._create_new_conversation(
            content=content,
            title=title,
            cwd=cwd,
            selections=selections,
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
        await self.host.session_state_update(
            session_id=session_id,
            runtime="antigravity",
            external_session_id=external_id,
            status="running",
            selections=selections,
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
                selections=selections,
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
        logger.info(f"[Antigravity] start_turn for conversation {cid} (session_id={session_id}): {content[:50]}")

        # If not a valid existing Antigravity conversation (e.g. unmapped sess_...), auto-initialize!
        if not self._is_valid_antigravity_conversation(cid):
            logger.info(f"[Antigravity] Session {session_id} has no valid Antigravity conversation ({cid}), auto-creating conversation")
            ok, new_cid, err_msg = await self._create_new_conversation(
                content=content,
                title=content[:30],
                cwd=cwd,
                selections=selections,
            )
            if not ok:
                logger.error(f"[Antigravity] Auto-create conversation failed: {err_msg}")
                return RuntimeOperationResult(
                    ok=False,
                    code="AGENTAPI_ERROR",
                    message=err_msg,
                )
            cid = new_cid
            self._session_map[session_id] = cid
            self._external_to_session[cid] = session_id
            self._save_session_map()

            await self.host.session_meta_upsert(
                session_id=session_id,
                runtime="antigravity",
                external_session_id=cid,
                title=content[:30],
                cwd=cwd,
                metadata={"source": "antigravity.start_turn.auto_create"},
            )
            await self.host.session_state_update(
                session_id=session_id,
                runtime="antigravity",
                external_session_id=cid,
                status="running",
                selections=selections,
                metadata={"source": "antigravity.start_turn.auto_create"},
            )
            asyncio.create_task(
                self._poll_turn_completion(
                    session_id=session_id,
                    external_session_id=cid,
                    selections=selections,
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
                logger.warning(f"[Antigravity] agentapi send-message failed on {cid}: {err_msg}")
                if "does not match target project_id" in err_msg or "permission_denied" in err_msg:
                    logger.info(f"[Antigravity] Project mismatch on {cid}, auto-creating new conversation under active project")
                    ok, new_cid, create_err = await self._create_new_conversation(
                        content=content,
                        title=content[:30],
                        cwd=cwd,
                        selections=selections,
                    )
                    if ok:
                        cid = new_cid
                        self._session_map[session_id] = cid
                        self._external_to_session[cid] = session_id
                        self._save_session_map()
                        await self.host.session_meta_upsert(
                            session_id=session_id,
                            runtime="antigravity",
                            external_session_id=cid,
                            title=content[:30],
                            cwd=cwd,
                        )
                        await self.host.session_state_update(
                            session_id=session_id,
                            runtime="antigravity",
                            external_session_id=cid,
                            status="running",
                            selections=selections,
                        )
                        asyncio.create_task(
                            self._poll_turn_completion(
                                session_id=session_id,
                                external_session_id=cid,
                                selections=selections,
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

            await self.host.session_state_update(
                session_id=session_id,
                runtime="antigravity",
                external_session_id=cid,
                status="running",
                selections=selections,
                metadata={"source": "antigravity.start_turn"},
            )

            asyncio.create_task(
                self._poll_turn_completion(
                    session_id=session_id,
                    external_session_id=cid,
                    selections=selections,
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
        await self.host.session_state_update(
            session_id=session_id,
            runtime="antigravity",
            external_session_id=cid,
            selections=selections,
        )
        return RuntimeOperationResult(
            ok=True,
            result={"sessionId": session_id, "externalSessionId": cid, "selections": dict(selections)},
        )

    async def _poll_turn_completion(
        self,
        session_id: str,
        external_session_id: str,
        selections: Mapping[str, str | None] | None = None,
        max_duration_seconds: float = 300.0,
    ) -> None:
        """Polls conversation status and transcript until turn finishes, streaming timeline updates."""
        poll_interval = 1.5
        elapsed = 0.0

        try:
            initial_snapshot = self._timeline_reader.get_session_snapshot(
                session_id=session_id,
                external_session_id=external_session_id,
            )
            initial_item_count = len(initial_snapshot.items)
        except Exception:
            initial_item_count = 0

        await asyncio.sleep(1.0)
        elapsed += 1.0

        last_item_count = initial_item_count
        saw_running = False

        while elapsed < max_duration_seconds:
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
                )
                if state and state.status == "running":
                    saw_running = True

                is_idle = state is not None and state.status == "idle"
                last_role = snapshot.items[-1].role if snapshot.items else None
                has_new_assistant_response = (
                    len(snapshot.items) > initial_item_count
                    and last_role == "assistant"
                )

                if is_idle and last_role != "user" and (saw_running or has_new_assistant_response):
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
                    await self.host.session_state_update(
                        session_id=session_id,
                        runtime="antigravity",
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

            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

        logger.warning(
            f"[Antigravity] Turn polling timed out for session {session_id} after {max_duration_seconds}s"
        )
        try:
            snapshot = self._timeline_reader.get_session_snapshot(
                session_id=session_id,
                external_session_id=external_session_id,
            )
            await self.host.timeline_sync(
                session_id=session_id,
                runtime="antigravity",
                items=snapshot.items,
                external_session_id=external_session_id,
                complete=True,
            )
            await self.host.session_state_update(
                session_id=session_id,
                runtime="antigravity",
                external_session_id=external_session_id,
                status="idle",
                selections=selections,
            )
            await self.host.session_turn_ended(
                session_id=session_id,
                runtime="antigravity",
                external_session_id=external_session_id,
            )
        except Exception:
            pass
