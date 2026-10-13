"""Read-only access to MiMoCode local SQLite (mimocode.db).

Schema (OpenCode/MiMoCode lineage):
  session(id, project_id, slug, directory, title, time_created, time_updated, ...)
  message(id, session_id, data, time_created, ...)
  part(id, message_id, session_id, data, time_created, ...)

message/part data are JSON blobs: {role, time:{created}, model:{modelID}, ...}
part data: {type: text|tool|file, ...}
"""

from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator


def default_mimocode_db() -> Path | None:
    home = Path(os.path.expanduser("~"))
    candidates = [
        home / ".local/share/mimocode/mimocode.db",
        Path(os.environ.get("LOCALAPPDATA", "")) / "mimocode/mimocode.db",
        Path(os.environ.get("APPDATA", "")) / "mimocode/mimocode.db",
        Path(os.environ.get("MIMOCODE_HOME", "")) / "mimocode.db",
    ]
    # Windows redirected Application Data
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata).parent / ".local/share/mimocode/mimocode.db")
    for c in candidates:
        if c and c.is_file():
            return c
    return None


@dataclass
class MimoSessionRow:
    id: str
    title: str
    cwd: str | None
    project_id: str | None
    created_ms: int | None
    updated_ms: int | None
    slug: str | None


class MimoDb:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        if not self.db_path.is_file():
            raise FileNotFoundError(f"mimocode.db not found: {self.db_path}")

    def _connect(self) -> sqlite3.Connection:
        # read-only URI to avoid locking Desktop
        uri = f"file:{self.db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    def list_sessions(self) -> list[MimoSessionRow]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, project_id, slug, directory, title,
                       time_created, time_updated
                FROM session
                ORDER BY time_updated DESC, time_created DESC
                """
            ).fetchall()
        out: list[MimoSessionRow] = []
        for r in rows:
            out.append(
                MimoSessionRow(
                    id=str(r["id"]),
                    title=str(r["title"] or r["slug"] or r["id"]),
                    cwd=r["directory"],
                    project_id=r["project_id"],
                    created_ms=r["time_created"],
                    updated_ms=r["time_updated"],
                    slug=r["slug"],
                )
            )
        return out

    def get_session(self, session_id: str) -> MimoSessionRow | None:
        with self._connect() as conn:
            r = conn.execute(
                """
                SELECT id, project_id, slug, directory, title,
                       time_created, time_updated
                FROM session WHERE id = ?
                """,
                (session_id,),
            ).fetchone()
        if not r:
            return None
        return MimoSessionRow(
            id=str(r["id"]),
            title=str(r["title"] or r["slug"] or r["id"]),
            cwd=r["directory"],
            project_id=r["project_id"],
            created_ms=r["time_created"],
            updated_ms=r["time_updated"],
            slug=r["slug"],
        )

    def iter_messages(self, session_id: str) -> Iterator[dict[str, Any]]:
        """Yield normalized message dicts for timeline projection."""
        with self._connect() as conn:
            msgs = conn.execute(
                """
                SELECT id, data, time_created FROM message
                WHERE session_id = ?
                ORDER BY time_created ASC, id ASC
                """,
                (session_id,),
            ).fetchall()
            parts_by_msg: dict[str, list[sqlite3.Row]] = {}
            for p in conn.execute(
                """
                SELECT message_id, data, time_created FROM part
                WHERE session_id = ?
                ORDER BY time_created ASC, id ASC
                """,
                (session_id,),
            ).fetchall():
                parts_by_msg.setdefault(p["message_id"], []).append(p)

        for m in msgs:
            try:
                data = json.loads(m["data"] or "{}")
            except json.JSONDecodeError:
                data = {}
            role = data.get("role") or "user"
            ts = (data.get("time") or {}).get("created") or m["time_created"]
            model = None
            model_obj = data.get("model")
            if isinstance(model_obj, dict):
                model = model_obj.get("modelID") or model_obj.get("id")
            texts: list[str] = []
            tools: list[dict[str, Any]] = []
            for p in parts_by_msg.get(m["id"], []):
                try:
                    pd = json.loads(p["data"] or "{}")
                except json.JSONDecodeError:
                    continue
                ptype = pd.get("type")
                if ptype == "text":
                    t = pd.get("text") or ""
                    if t:
                        texts.append(t)
                elif ptype == "tool":
                    state = pd.get("state") or {}
                    tools.append(
                        {
                            "tool": pd.get("tool") or "tool",
                            "status": state.get("status") or "",
                            "output": (state.get("output") or "")[:2000]
                            if isinstance(state.get("output"), str)
                            else "",
                        }
                    )
                elif ptype == "file":
                    texts.append(f"[file] {pd.get('filename') or pd.get('url') or ''}")
            content = "\n".join(texts).strip()
            if not content and tools:
                content = "\n".join(
                    f"[tool:{t['tool']} {t['status']}]" for t in tools
                )
            if not content:
                content = data.get("summary") or ""
            if not content:
                continue
            yield {
                "id": str(m["id"]),
                "role": role,
                "text": content,
                "timestamp_ms": ts,
                "model": model,
                "tools": tools,
            }
