"""Atomic runtime-local goal journal. Native calls are never made in a transaction."""

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path


class GoalStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connect() as c:
            version = c.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise RuntimeError("goal_database_version_unsupported")
            c.executescript("""
            CREATE TABLE IF NOT EXISTS goal_state(session_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS goal_operations(session_id TEXT NOT NULL, operation_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,operation_id), FOREIGN KEY(session_id) REFERENCES goal_state(session_id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS goal_log_cursors(session_id TEXT PRIMARY KEY REFERENCES goal_state(session_id) ON DELETE CASCADE, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS goal_outbox(session_id TEXT NOT NULL, revision INTEGER NOT NULL,
                payload TEXT NOT NULL, PRIMARY KEY(session_id,revision), FOREIGN KEY(session_id) REFERENCES goal_state(session_id) ON DELETE CASCADE);
            PRAGMA user_version=1;
            """)
        path.chmod(0o600)

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=FULL")
        c.execute("PRAGMA busy_timeout=30000")
        for suffix in ("", "-wal", "-shm"):
            path = Path(str(self.path) + suffix)
            if path.exists():
                os.chmod(path, 0o600)
        try:
            yield c
        finally:
            c.close()

    def load(self, session_id):
        with self.connect() as c:
            row = c.execute(
                "SELECT payload FROM goal_state WHERE session_id=?", (session_id,)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def operation(self, session_id, operation_id):
        with self.connect() as c:
            row = c.execute(
                "SELECT fingerprint,payload FROM goal_operations WHERE session_id=? AND operation_id=?",
                (session_id, operation_id),
            ).fetchone()
        return (row[0], json.loads(row[1])) if row else None

    def cursor(self, session_id):
        with self.connect() as c:
            row = c.execute(
                "SELECT payload FROM goal_log_cursors WHERE session_id=?", (session_id,)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, state, operation=None, cursor=None):
        with self.connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                sid = state["sessionId"]
                c.execute(
                    "INSERT INTO goal_state VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload",
                    (sid, json.dumps(state)),
                )
                if operation:
                    oid, fp, result = operation
                    c.execute(
                        "INSERT INTO goal_operations VALUES(?,?,?,?) ON CONFLICT(session_id,operation_id) DO UPDATE SET payload=excluded.payload",
                        (sid, oid, fp, json.dumps(result)),
                    )
                if cursor is not None:
                    c.execute(
                        "INSERT INTO goal_log_cursors VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload",
                        (sid, json.dumps(cursor)),
                    )
                if state.get("externalSessionId") and (
                    state.get("goal")
                    or state.get("lastOutcome")
                    or state["sourceRevision"] > 0
                ):
                    c.execute(
                        "INSERT OR IGNORE INTO goal_outbox VALUES(?,?,?)",
                        (sid, state["sourceRevision"], json.dumps(state)),
                    )
                c.commit()
            except BaseException:
                c.rollback()
                raise

    def sessions(self):
        with self.connect() as c:
            return [
                json.loads(row[0])
                for row in c.execute("SELECT payload FROM goal_state")
            ]

    def pending(self):
        with self.connect() as c:
            rows = c.execute(
                "SELECT session_id,revision,payload FROM goal_outbox ORDER BY rowid LIMIT 50"
            ).fetchall()
        return [(sid, rev, json.loads(payload)) for sid, rev, payload in rows]

    def acknowledged(self, sid, revision):
        with self.connect() as c:
            c.execute(
                "DELETE FROM goal_outbox WHERE session_id=? AND revision=?",
                (sid, revision),
            )

    def delete(self, sid, *, tombstone=False):
        with self.connect() as c:
            c.execute("BEGIN IMMEDIATE")
            for table in (
                "goal_state",
                "goal_operations",
                "goal_log_cursors",
                "goal_outbox",
            ):
                c.execute(f"DELETE FROM {table} WHERE session_id=?", (sid,))
            if tombstone:
                c.execute(
                    "INSERT INTO goal_state VALUES(?,?)",
                    (sid, json.dumps({"sessionId": sid, "_deleted": True})),
                )
            c.commit()
        import hashlib
        import shutil

        assets = (
            self.path.parent / "goal-assets" / hashlib.sha256(sid.encode()).hexdigest()
        )
        if assets.is_dir():
            shutil.rmtree(assets)
