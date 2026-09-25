from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from connector.logging import logger
from connector.runtime_protocol.models import (
    SessionMeta,
    SessionSourceState,
    SessionState,
)
from connector.runtimes.antigravity.provider_config import DEFAULT_DB_PATH
from connector.server.protocol import protocol_selection_id

DEFAULT_MODEL_SELECTION = protocol_selection_id(
    "antigravity", "model", {"model_id": "flash"}
)


class AntigravitySessionReader:
    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = db_path or DEFAULT_DB_PATH

    def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        if not self.db_path.exists():
            return ()

        try:
            con = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
            con.row_factory = sqlite3.Row
            query = """
                SELECT conversation_id, title, preview, last_modified_time, status, workspace_uris
                FROM conversation_summaries
                WHERE nesting_depth = 0 AND killed = 0
                ORDER BY last_modified_time DESC
                LIMIT ?
            """
            rows = con.execute(query, (limit,)).fetchall()
            con.close()

            observed_at = datetime.now(timezone.utc).isoformat()
            sessions: list[SessionMeta] = []
            for row in rows:
                cid = row["conversation_id"]
                title = row["title"] or "Untitled Conversation"
                mod_time = row["last_modified_time"]
                status_raw = row["status"] or ""
                status_str = "running" if status_raw == "CASCADE_RUN_STATUS_RUNNING" else "idle"

                cwd: str | None = None
                ws = row["workspace_uris"]
                if ws:
                    try:
                        uris = json.loads(ws) if isinstance(ws, str) and ws.startswith("[") else [ws]
                        if uris and isinstance(uris[0], str) and uris[0].startswith("file://"):
                            cwd = uris[0][7:]
                    except Exception:
                        pass

                sessions.append(
                    SessionMeta(
                        session_id=cid,
                        external_session_id=cid,
                        runtime="antigravity",
                        title=title,
                        cwd=cwd,
                        ordering_time=str(mod_time) if mod_time else None,
                        source_state=SessionSourceState(
                            availability="available",
                            observed_at=observed_at,
                        ),
                        metadata={
                            "preview": row["preview"] or "",
                            "status": status_str,
                            "raw_status": status_raw,
                            "sync": {
                                "changed": True,
                                "requires_timeline_sync": True,
                            },
                        },
                    )
                )
            return tuple(sessions)
        except Exception as e:
            logger.error(f"[Antigravity] Failed to list sessions: {e}")
            return ()

    def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState:
        cid = external_session_id or session_id
        if not self.db_path.exists():
            return SessionState(
                session_id=session_id,
                external_session_id=cid,
                runtime="antigravity",
                status="idle",
                selections={"model": DEFAULT_MODEL_SELECTION},
            )

        try:
            con = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
            con.row_factory = sqlite3.Row
            row = con.execute(
                "SELECT status, preview FROM conversation_summaries WHERE conversation_id = ?",
                (cid,),
            ).fetchone()
            con.close()

            status_str = "idle"
            if row and row["status"] == "CASCADE_RUN_STATUS_RUNNING":
                status_str = "running"

            return SessionState(
                session_id=session_id,
                external_session_id=cid,
                runtime="antigravity",
                status=status_str,
                selections={"model": DEFAULT_MODEL_SELECTION},
                metadata={"preview": row["preview"] if row else ""},
            )
        except Exception as e:
            logger.error(f"[Antigravity] Failed to get session state for {session_id}: {e}")
            return SessionState(
                session_id=session_id,
                external_session_id=cid,
                runtime="antigravity",
                status="idle",
                selections={"model": DEFAULT_MODEL_SELECTION},
            )
