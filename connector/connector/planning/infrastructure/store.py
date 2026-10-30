"""One atomic aggregate/operation journal per configured Runtime instance."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path


class PlanningStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS planning_document(session_id TEXT NOT NULL, plan_id TEXT NOT NULL,
                    revision INTEGER NOT NULL, payload TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(session_id,plan_id,revision));
                CREATE TABLE IF NOT EXISTS planning_state(session_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS planning_operation(session_id TEXT NOT NULL, operation_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,operation_id));
            """)
        path.chmod(0o600)

    def connect(self):
        return sqlite3.connect(self.path, timeout=30)

    def load(self, session_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT payload FROM planning_state WHERE session_id=?", (session_id,)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def operation(self, session_id: str, operation_id: str) -> tuple[str, dict] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT fingerprint,payload FROM planning_operation WHERE session_id=? AND operation_id=?",
                (session_id, operation_id),
            ).fetchone()
        return (row[0], json.loads(row[1])) if row else None

    def save(self, state: dict, operation: tuple[str, str, dict] | None = None) -> None:
        with self.connect() as conn:
            for document in state.get("proposals", []):
                if document.get("markdown") is not None:
                    conn.execute(
                        "INSERT INTO planning_document(session_id,plan_id,revision,payload) VALUES(?,?,?,?) ON CONFLICT(session_id,plan_id,revision) DO NOTHING",
                        (
                            state["session_id"],
                            document["planId"],
                            document["revision"],
                            json.dumps(document, ensure_ascii=False),
                        ),
                    )
            previous = conn.execute(
                "SELECT payload FROM planning_state WHERE session_id=?",
                (state["session_id"],),
            ).fetchone()
            old = json.loads(previous[0]) if previous else None
            if (
                not old
                or old.get("epoch") != state.get("epoch")
                or old.get("revision", 0) <= state.get("revision", 0)
            ):
                conn.execute(
                    "INSERT INTO planning_state VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload",
                    (state["session_id"], json.dumps(state, ensure_ascii=False)),
                )
            if operation:
                key, fingerprint, result = operation
                conn.execute(
                    "INSERT INTO planning_operation VALUES(?,?,?,?) ON CONFLICT(session_id,operation_id) "
                    "DO UPDATE SET payload=excluded.payload",
                    (state["session_id"], key, fingerprint, json.dumps(result)),
                )

    def unpublished(self, session_id: str) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT payload FROM planning_document WHERE session_id=? AND published=0 ORDER BY rowid LIMIT 1",
                (session_id,),
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def mark_published(self, session_id: str, document: dict) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE planning_document SET published=1 WHERE session_id=? AND plan_id=? AND revision=?",
                (session_id, document["planId"], document["revision"]),
            )
