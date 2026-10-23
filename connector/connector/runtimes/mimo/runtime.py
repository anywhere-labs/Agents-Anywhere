"""MiMoCode runtime — process lifecycle + native session IDs."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Mapping

from connector.runtime_protocol import (
    RuntimeIdentity,
    RuntimeOperationResult,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionState,
)
from connector.runtime_protocol.models import RuntimeTimelineItem

from .db import MimoDb, default_mimocode_db

RUNTIME = "mimo"
ADAPTER_VERSION = "0.2.0"

_SESSION_ID_RE = re.compile(r"\bses_[A-Za-z0-9]+")


def _hash(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:32]


def _iso_from_ms(ms: int | None) -> str | None:
    if not ms:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + "Z"


def _parse_session_id(text: str) -> str | None:
    m = _SESSION_ID_RE.search(text or "")
    return m.group(0) if m else None


class MimoAgentRuntime:
    """AgentRuntime for MiMoCode (OpenCode fork) via CLI + local SQLite history."""

    def __init__(
        self,
        db_path: Path | None,
        mimo_bin: str | None,
        default_cwd: str,
        host: Any = None,
        runtime_id: str | None = None,
    ):
        self._db_path = Path(db_path) if db_path else default_mimocode_db()
        self._mimo_bin = mimo_bin or shutil.which("mimo")
        self._default_cwd = default_cwd
        self._host = host
        self._runtime_id = runtime_id
        self._db = MimoDb(self._db_path) if self._db_path and Path(self._db_path).is_file() else None
        self._started = False
        # native session id (ses_...) -> process
        self._procs: dict[str, subprocess.Popen[str]] = {}
        self._interrupted: set[str] = set()
        self._status: dict[str, str] = {}
        self._last_error: dict[str, str] = {}
        # platform session_id -> native id
        self._external: dict[str, str] = {}

    # ----- identity / lifecycle -----

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime=RUNTIME,
            runtime_version=ADAPTER_VERSION,
            display_name="MiMo Code (MiMo Desktop)",
            protocol_version="1.0",
            runtime_id=self._runtime_id,
        )

    @property
    def sync_mode(self) -> str:
        return "polling"

    async def start(self) -> None:
        self._started = True

    async def stop(self) -> None:
        for sid, proc in list(self._procs.items()):
            self._kill_proc(proc)
            self._status[sid] = "stopped"
        self._procs.clear()
        self._started = False

    def _kill_proc(self, proc: subprocess.Popen[str]) -> None:
        try:
            if proc.poll() is not None:
                return
            if os.name == "nt":
                # kill process tree so wrapper/cmd children die too
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True,
                    timeout=5,
                    check=False,
                )
            else:
                proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()
        except Exception:
            pass

    def _resolve_native(self, session_id: str, external_session_id: str | None) -> str:
        return external_session_id or self._external.get(session_id) or session_id

    def _find_proc(self, session_id: str) -> tuple[str, subprocess.Popen[str]] | None:
        keys = [self._external.get(session_id), session_id]
        if session_id.startswith("mimo_"):
            keys.append(session_id[len("mimo_") :])
        for k in keys:
            if k and k in self._procs:
                return k, self._procs[k]
        for k, proc in self._procs.items():
            if k in session_id or session_id.endswith(k):
                return k, proc
        return None

    # ----- sessions -----

    def _meta_from_row(self, row, session_id: str | None = None) -> SessionMeta:
        sid = session_id or f"mimo_{row.id}"
        return SessionMeta(
            session_id=sid,
            external_session_id=row.id,
            runtime=RUNTIME,
            title=row.title,
            cwd=row.cwd,
            ordering_time=_iso_from_ms(row.updated_ms or row.created_ms),
            metadata={"project_id": row.project_id, "slug": row.slug, "native_id": row.id},
            runtime_id=self._runtime_id,
        )

    async def list_sessions(self, limit: int = 100, cursor: str | None = None, force: bool = False):
        if not self._db:
            return tuple()
        out = []
        for row in self._db.list_sessions()[:limit]:
            out.append(self._meta_from_row(row))
        return tuple(out)

    async def list_complete_session_inventory(self, page_size: int = 100, force: bool = False):
        return await self.list_sessions(limit=page_size, force=force)

    def supports_complete_session_inventory(self) -> bool:
        return True

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        sid = self._resolve_native(session_id, external_session_id)
        if not self._db:
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=sid,
                runtime=RUNTIME,
                items=(),
                complete=True,
                metadata={"reason": "mimocode.db unavailable"},
                runtime_id=self._runtime_id,
            )
        items: list[RuntimeTimelineItem] = []
        seq = 0
        for m in self._db.iter_messages(sid):
            seq += 1
            if limit and seq > limit:
                break
            item_id = f"mimo_item_{m['id']}"
            content: dict[str, Any] = {"text": m["text"]}
            if m.get("model"):
                content["model"] = m["model"]
            if m.get("tools"):
                content["tools"] = m["tools"]
            items.append(
                RuntimeTimelineItem(
                    id=item_id,
                    session_id=session_id,
                    type="message",
                    status="completed",
                    order_seq=seq,
                    content_hash=_hash(item_id, m["text"]),
                    role=m["role"],
                    turn_id=None,
                    content=content,
                    source={"native_id": m["id"], "runtime": RUNTIME},
                    revision=1,
                    metadata={},
                )
            )
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=sid,
            runtime=RUNTIME,
            items=tuple(items),
            complete=True,
            metadata={"count": len(items)},
            runtime_id=self._runtime_id,
        )

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        sid = self._resolve_native(session_id, external_session_id)
        status = self._status.get(sid)
        if status is None:
            proc = self._procs.get(sid)
            if proc is not None:
                status = "running" if proc.poll() is None else "idle"
            else:
                status = "idle"
        return SessionState(
            session_id=session_id,
            external_session_id=sid,
            runtime=RUNTIME,
            status=status,  # type: ignore[arg-type]
            selections={},
            error={"message": self._last_error[sid]} if sid in self._last_error else None,
            metadata={"cwd": self._default_cwd, "native_id": sid},
            runtime_id=self._runtime_id,
        )

    # ----- turns -----

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple = (),
        client_message_id: str | None = None,
        runtime_options: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        if not self._mimo_bin:
            return RuntimeOperationResult(
                ok=False,
                code="runtime_unavailable",
                message="mimo CLI not installed",
            )
        workdir = cwd or self._default_cwd
        before = {r.id for r in (self._db.list_sessions() if self._db else [])}
        proc, stdout = await self._spawn_turn(workdir, content, selections or {}, None)
        # derive native id from output or DB diff
        native = _parse_session_id(stdout or "")
        if not native and self._db:
            await asyncio.sleep(0.3)
            for r in self._db.list_sessions():
                if r.id not in before and (not cwd or r.cwd == workdir):
                    native = r.id
                    break
        if not native:
            native = f"mimo_tmp_{uuid.uuid4().hex[:12]}"
        self._external[session_id] = native
        self._procs[native] = proc
        self._status[native] = "running"
        return RuntimeOperationResult(
            ok=True,
            result={"external_session_id": native, "session_id": session_id, "title": title},
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple = (),
        client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        if not self._mimo_bin:
            return RuntimeOperationResult(
                ok=False,
                code="runtime_unavailable",
                message="mimo CLI not installed",
            )
        sid = self._resolve_native(session_id, external_session_id)
        # Prefer official continue path when CLI supports it
        workdir = cwd or self._default_cwd
        proc, _ = await self._spawn_turn(workdir, content, selections or {}, sid)
        self._procs[sid] = proc
        self._interrupted.discard(sid)
        self._status[sid] = "running"
        return RuntimeOperationResult(
            ok=True,
            result={"external_session_id": sid, "session_id": session_id},
        )

    async def interrupt_session(self, session_id: str, reason: str | None = None) -> RuntimeOperationResult:
        sid = self._resolve_native(session_id, None)
        found = self._find_proc(session_id) or (sid in self._procs and (sid, self._procs[sid]))
        self._interrupted.add(sid)
        self._status[sid] = "idle"
        self._status[session_id] = "idle"
        proc = None
        if found:
            key, proc = found
            self._kill_proc(proc)
            self._procs.pop(key, None)
        await self._emit_state(session_id, sid)
        alive = bool(proc is not None and proc.poll() is None)
        return RuntimeOperationResult(
            ok=True,
            code="interrupted",
            message=reason,
            result={
                "interrupted": True,
                "process_alive": alive,
                "external_session_id": sid,
            },
        )

    async def _spawn_turn(
        self,
        cwd: str,
        prompt: str,
        selections: Mapping[str, str | None],
        external_session_id: str | None,
    ) -> tuple[subprocess.Popen[str], str]:
        cmd = [self._mimo_bin, "run"]
        if external_session_id and os.environ.get("MIMO_RUNTIME_CONTINUE_FLAG"):
            # optional flag if CLI grows --session
            cmd += [os.environ["MIMO_RUNTIME_CONTINUE_FLAG"], external_session_id]
        model = selections.get("model")
        if model and isinstance(model, str) and not model.startswith("sel_"):
            cmd += ["--model", model]
        cmd.append(prompt)
        proc = await asyncio.to_thread(
            subprocess.Popen,
            cmd,
            cwd=cwd or None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        stdout = ""
        try:
            # don't block forever; drain what we can
            out, _ = await asyncio.wait_for(
                asyncio.to_thread(proc.communicate),
                timeout=float(os.environ.get("MIMO_RUNTIME_TURN_TIMEOUT", "900")),
            )
            stdout = out or ""
        except Exception as e:
            self._kill_proc(proc)
            stdout = f"{e}"
        return proc, stdout

    async def _emit_state(self, session_id: str, ext: str) -> None:
        if not self._host:
            return
        st = await self.get_session_state(session_id, ext)
        for name in ("notify_session_state", "session_state_upsert", "session.state"):
            fn = getattr(self._host, name, None)
            if callable(fn):
                try:
                    await fn(st)
                    return
                except Exception:
                    continue
