"""AgentRuntime implementation bridging MiMoCode CLI + local mimocode.db."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Mapping

from .db import MimoDb, default_mimocode_db

RUNTIME = "mimo"
ADAPTER_VERSION = "0.1.0"


def _hash(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:32]


def _iso_from_ms(ms: int | None) -> str | None:
    if not ms:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + "Z"


class MimoAgentRuntime:
    """Protocol-compatible AgentRuntime (draft v1).

    Capabilities:
      - historyRead via mimocode.db
      - create_and_start_session / start_turn via `mimo run` headless
      - model catalog best-effort via `mimo models` if CLI present
    """

    def __init__(
        self,
        db_path: Path | None,
        mimo_bin: str | None,
        default_cwd: str,
        host: Any = None,
    ):
        self._db_path = db_path or default_mimocode_db()
        self._mimo_bin = mimo_bin
        self._default_cwd = default_cwd
        self._host = host
        self._db = MimoDb(self._db_path) if self._db_path else None
        self._started = False
        self._status = "disconnected"
        self._sessions: dict[str, dict[str, Any]] = {}

    @property
    def runtime(self) -> str:
        return RUNTIME

    @property
    def adapter_version(self) -> str:
        return ADAPTER_VERSION

    def identity(self) -> dict[str, Any]:
        return {
            "runtime": self.runtime,
            "adapter_version": self.adapter_version,
            "display_name": "MiMo Code (MiMo Desktop)",
            "protocol_version": "1.0",
        }

    async def start(self) -> None:
        self._started = True
        self._status = "idle"

    async def stop(self) -> None:
        self._started = False
        self._status = "disconnected"

    async def get_state(self, session_id: str, external_session_id: str | None = None):
        sid = external_session_id or session_id
        rec = self._sessions.get(sid, {})
        return {
            "session_id": session_id,
            "external_session_id": sid,
            "runtime": RUNTIME,
            "status": rec.get("status") or ("idle" if self._started else "disconnected"),
            "selections": rec.get("selections") or {},
            "metadata": {"cwd": rec.get("cwd") or self._default_cwd},
        }

    async def list_sessions(self) -> list[dict[str, Any]]:
        if not self._db:
            return []
        out = []
        for s in self._db.list_sessions():
            out.append(
                {
                    "session_id": f"mimo_{s.id}",
                    "external_session_id": s.id,
                    "runtime": RUNTIME,
                    "title": s.title,
                    "cwd": s.cwd,
                    "ordering_time": _iso_from_ms(s.updated_ms or s.created_ms),
                    "metadata": {"project_id": s.project_id, "slug": s.slug},
                }
            )
        return out

    async def read_timeline(
        self,
        session_id: str,
        external_session_id: str | None = None,
        cursor: str | None = None,
        limit: int = 200,
    ) -> dict[str, Any]:
        sid = external_session_id or session_id
        if not self._db:
            return {
                "session_id": session_id,
                "external_session_id": sid,
                "runtime": RUNTIME,
                "items": [],
                "complete": True,
                "metadata": {"reason": "mimocode.db unavailable"},
            }
        items = []
        seq = 0
        for m in self._db.iter_messages(sid):
            seq += 1
            item_id = f"mimo_item_{m['id']}"
            content: dict[str, Any] = {"text": m["text"]}
            if m.get("model"):
                content["model"] = m["model"]
            if m.get("tools"):
                content["tools"] = m["tools"]
            items.append(
                {
                    "id": item_id,
                    "session_id": session_id,
                    "type": "message",
                    "status": "completed",
                    "order_seq": seq,
                    "content_hash": _hash(item_id, m["text"]),
                    "role": m["role"],
                    "turn_id": None,
                    "content": content,
                    "source": {"native_id": m["id"], "runtime": RUNTIME},
                    "revision": 1,
                    "metadata": {},
                }
            )
            if len(items) >= limit:
                break
        return {
            "session_id": session_id,
            "external_session_id": sid,
            "runtime": RUNTIME,
            "items": items,
            "complete": True,
            "metadata": {"count": len(items)},
        }

    async def get_model_catalog(self):
        models: list[dict[str, Any]] = []
        if self._mimo_bin:
            try:
                proc = await asyncio.to_thread(
                    subprocess.run,
                    [self._mimo_bin, "models"],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    encoding="utf-8",
                    errors="replace",
                )
                for line in (proc.stdout or "").splitlines():
                    line = line.strip()
                    if not line or line.startswith("-"):
                        continue
                    models.append(
                        {
                            "id": line,
                            "title": line,
                            "selection_id": f"sel_model_mimo_{_hash(line)}",
                            "description": None,
                            "reasoning_items": (),
                            "enabled": True,
                            "metadata": {"source": "mimo models"},
                        }
                    )
            except Exception:
                pass
        if not models:
            models.append(
                {
                    "id": "default",
                    "title": "MiMo default (from session/config)",
                    "selection_id": "sel_model_mimo_default",
                    "description": "Use the model stored in MiMoCode config/session",
                    "reasoning_items": (),
                    "enabled": True,
                    "metadata": {},
                }
            )
        return {
            "runtime": RUNTIME,
            "revision": 1,
            "models": models,
        }

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        selections: Mapping[str, Any] | None = None,
        cwd: str | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        if not self._mimo_bin:
            raise RuntimeError("mimo CLI not installed; cannot start new sessions")
        workdir = cwd or self._default_cwd
        ext = f"mimo_new_{uuid.uuid4().hex[:12]}"
        self._sessions[ext] = {
            "status": "running",
            "cwd": workdir,
            "selections": dict(selections or {}),
        }
        await self._emit_state(session_id, ext)
        # fire and forget headless run; timeline picked up from DB on next scan
        asyncio.create_task(
            self._run_headless(workdir, content, selections or {}, session_id, ext)
        )
        return {
            "session_id": session_id,
            "external_session_id": ext,
            "runtime": RUNTIME,
            "status": "running",
        }

    async def start_turn(
        self,
        session_id: str,
        content: str,
        selections: Mapping[str, Any] | None = None,
        external_session_id: str | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        sid = external_session_id or session_id
        if not self._mimo_bin:
            raise RuntimeError("mimo CLI not installed; cannot start turns")
        rec = self._sessions.setdefault(sid, {})
        rec["status"] = "running"
        if selections:
            rec["selections"] = dict(selections)
        await self._emit_state(session_id, sid)
        asyncio.create_task(
            self._run_headless(
                rec.get("cwd") or self._default_cwd,
                content,
                rec.get("selections") or {},
                session_id,
                sid,
            )
        )
        return {"session_id": session_id, "external_session_id": sid, "status": "running"}

    async def interrupt_turn(self, session_id: str, external_session_id: str | None = None):
        # Best-effort: mark local state; process kill would need PID tracking
        sid = external_session_id or session_id
        rec = self._sessions.setdefault(sid, {})
        rec["status"] = "idle"
        await self._emit_state(session_id, sid)
        return {"ok": True, "interrupted": True}

    async def _emit_state(self, session_id: str, ext: str) -> None:
        if not self._host:
            return
        st = await self.get_state(session_id, ext)
        notify = getattr(self._host, "notify_session_state", None) or getattr(
            self._host, "session_state_upsert", None
        )
        if callable(notify):
            try:
                await notify(st)
            except Exception:
                pass

    async def _run_headless(
        self,
        cwd: str,
        prompt: str,
        selections: Mapping[str, Any],
        session_id: str,
        ext: str,
    ) -> None:
        cmd = [self._mimo_bin, "run"]
        model = selections.get("model")
        # selection ids are hashed; pass through if it looks like a model id
        if model and isinstance(model, str) and not model.startswith("sel_model_"):
            cmd += ["--model", model]
        cmd.append(prompt)
        try:
            proc = await asyncio.to_thread(
                subprocess.run,
                cmd,
                cwd=cwd or None,
                capture_output=True,
                text=True,
                timeout=int(os.environ.get("MIMO_RUNTIME_TURN_TIMEOUT", "600")),
                encoding="utf-8",
                errors="replace",
            )
            rec = self._sessions.setdefault(ext, {})
            rec["status"] = "idle"
            rec["last_exit"] = proc.returncode
            rec["last_output"] = (proc.stdout or "")[-4000:]
        except Exception as e:
            rec = self._sessions.setdefault(ext, {})
            rec["status"] = "error"
            rec["error"] = str(e)
        await self._emit_state(session_id, ext)
