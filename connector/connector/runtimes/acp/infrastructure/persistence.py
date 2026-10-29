from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from ..domain.definitions import AcpError


class Store:
    """One local transaction commits coordination state and outbound facts."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
        """)

    @contextmanager
    def transaction(self):
        if self.db.in_transaction:
            name = "nested_" + uuid4().hex
            self.db.execute(f"SAVEPOINT {name}")
            try:
                yield self
                self.db.execute(f"RELEASE SAVEPOINT {name}")
            except BaseException:
                self.db.execute(f"ROLLBACK TO SAVEPOINT {name}")
                self.db.execute(f"RELEASE SAVEPOINT {name}")
                raise
            return
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield self
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def get(self, kind: str, key: str) -> dict | None:
        row = self.db.execute(
            "SELECT body FROM records WHERE kind=? AND id=?", (kind, key)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def require(self, kind: str, key: str) -> dict:
        result = self.get(kind, key)
        if result is None:
            raise AcpError("operation_not_found", "操作或会话不存在。")
        return result

    def values(self, kind: str) -> list[dict]:
        return [
            json.loads(row[0])
            for row in self.db.execute(
                "SELECT body FROM records WHERE kind=? ORDER BY id", (kind,)
            )
        ]

    def put(self, kind: str, key: str, value: dict) -> None:
        self.db.execute(
            "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
            (kind, key, json.dumps(value, ensure_ascii=False, allow_nan=False)),
        )

    def delete(self, kind: str, key: str) -> None:
        self.db.execute("DELETE FROM records WHERE kind=? AND id=?", (kind, key))

    def emit(self, method: str, params: dict) -> str:
        if self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] >= 4096:
            raise AcpError("sync_backpressure", "同步积压已达到上限，请恢复连接。")
        identifier = uuid4().hex
        self.db.execute(
            "INSERT INTO outbox(id,body) VALUES(?,?)",
            (
                identifier,
                json.dumps(
                    {"method": method, "params": params},
                    ensure_ascii=False,
                    allow_nan=False,
                ),
            ),
        )
        return identifier

    def pending(self, limit: int = 128) -> list[tuple[int, str, dict]]:
        return [
            (seq, key, json.loads(body))
            for seq, key, body in self.db.execute(
                "SELECT seq,id,body FROM outbox ORDER BY seq LIMIT ?", (limit,)
            )
        ]

    def acknowledge(self, identifiers: list[str]) -> None:
        self.db.executemany(
            "DELETE FROM outbox WHERE id=?", [(key,) for key in identifiers]
        )

    def close(self) -> None:
        self.db.close()
