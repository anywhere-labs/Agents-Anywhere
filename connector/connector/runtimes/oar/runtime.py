from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeOperationResult,
    RuntimeTimelineItem,
    SessionMeta,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.timeline import timeline_content_hash
from connector.runtimes.oar.client import OarSidecarClient


class OarRuntime(AgentRuntime):
    def __init__(self, config: RuntimeConfig, host: RuntimeHostClient) -> None:
        self.config, self.host = config, host
        self._sessions: dict[str, dict[str, Any]] = {}
        sidecar_dir = str(config.values.get("sidecarPath") or "")
        self._sidecar = OarSidecarClient(str(config.values.get("nodeExecutable", "node")), sidecar_dir, self._on_event)
        self._seq: dict[str, int] = {}
        self._text: dict[str, str] = {}

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity("oar", "1", "OAR (Pi)")

    async def start(self) -> None:
        await self._sidecar.start()
        await self.host.runtime_health_update("starting")
        await self.host.runtime_health_update("running")

    async def stop(self) -> None:
        for session_id in list(self._sessions):
            try:
                await self._sidecar.request("dispose", {"sessionId": session_id})
            except (OSError, RuntimeError):
                continue
        await self._sidecar.close()

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        capabilities = tuple(RuntimeCapability(capability_id=value, scope="runtime", runtime="oar") for value in ("session.send_message", "session.interrupt", "session.steer", "runtime.config"))
        return RuntimeCapabilitySet(runtime="oar", revision=1, capabilities=capabilities, connector_id=self.host.connector_id)

    async def get_session_state(self, session_id: str, external_session_id: str | None = None) -> SessionState | None:
        state = self._sessions.get(session_id)
        if state is None:
            return None
        return SessionState(session_id=session_id, external_session_id=state.get("externalSessionId") or external_session_id, runtime="oar", status=state.get("status", "idle"))

    async def list_sessions(self, limit: int = 100, cursor: str | None = None, force: bool = False) -> tuple[SessionMeta, ...]:
        return tuple(SessionMeta(session_id=session_id, external_session_id=value.get("externalSessionId"), runtime="oar", cwd=value.get("cwd")) for session_id, value in list(self._sessions.items())[:limit])

    async def create_and_start_session(self, session_id: str, content: str, title: str | None = None, cwd: str | None = None, selections: Mapping[str, str | None] | None = None, attachments=(), client_message_id: str | None = None, runtime_options: Mapping[str, Any] | None = None) -> RuntimeOperationResult:
        await self._sidecar.request("start", {"sessionId": session_id, "cwd": cwd, "model": (runtime_options or {}).get("model") or self.config.values.get("defaultModel")})
        self._sessions[session_id] = {"status": "running", "cwd": cwd}
        await self.host.session_meta_upsert(session_id, "oar", title=title, cwd=cwd)
        await self._sidecar.request("prompt", {"sessionId": session_id, "content": content})
        return RuntimeOperationResult(ok=True, result={"sessionId": session_id})

    async def start_turn(self, session_id: str, external_session_id: str | None, content: str, selections=None, attachments=(), client_message_id: str | None = None, cwd: str | None = None) -> RuntimeOperationResult:
        if session_id not in self._sessions:
            await self._sidecar.request("start", {"sessionId": session_id, "cwd": cwd, "resume": external_session_id})
            self._sessions[session_id] = {"externalSessionId": external_session_id, "cwd": cwd, "status": "idle"}
        await self._sidecar.request("deliver", {"sessionId": session_id, "content": content})
        self._sessions[session_id]["status"] = "running"
        return RuntimeOperationResult(ok=True, result={"sessionId": session_id})

    async def interrupt_session(self, session_id: str, reason: str | None = None) -> RuntimeOperationResult:
        await self._sidecar.request("abort", {"sessionId": session_id})
        self._sessions.get(session_id, {})["status"] = "interrupted"
        return RuntimeOperationResult(ok=True)

    async def _on_event(self, payload: Mapping[str, Any]) -> None:
        session_id = str(payload.get("sessionId"))
        event = payload.get("event") or {}
        kind = event.get("kind")
        if kind == "text_delta":
            self._text[session_id] = self._text.get(session_id, "") + str(event.get("text", ""))
            await self._upsert_message(session_id, self._text[session_id], "inProgress")
        elif kind == "turn_ended":
            self._sessions.setdefault(session_id, {})["status"] = "idle"
            await self.host.session_state_update(session_id, "oar", status="idle")
            await self.host.session_turn_ended(session_id, "oar", outcome=str((event.get("outcome") or {}).get("kind", "completed")))

    async def _upsert_message(self, session_id: str, text: str, status: str) -> None:
        self._seq[session_id] = self._seq.get(session_id, 0) + 1
        content = {"text": text}
        item_id = f"oar:{session_id}:assistant"
        item = RuntimeTimelineItem(id=item_id, session_id=session_id, type="message", status=status, order_seq=self._seq[session_id], content_hash=timeline_content_hash("message", status, "assistant", content), role="assistant", content=content, source={"runtime": "oar"}, revision=self._seq[session_id])
        await self.host.timeline_item_upsert(item)
