from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from connector.time import utc_now


@dataclass(frozen=True, slots=True)
class RuntimeSyncState:
    fingerprint: dict[str, Any] | None = None
    cursor: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


class SyncStateStore:
    def get(self, runtime: str, connector_id: str, external_session_id: str) -> RuntimeSyncState | None:
        raise NotImplementedError

    def set(
        self,
        runtime: str,
        connector_id: str,
        external_session_id: str,
        *,
        fingerprint: dict[str, Any] | None = None,
        cursor: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        raise NotImplementedError

    def delete_runtime(self, runtime: str, connector_id: str) -> None:
        raise NotImplementedError


class SqliteSyncStateStore(SyncStateStore):
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    @classmethod
    def default_path(cls) -> Path:
        return Path(
            os.environ.get(
                "AGENT_CONNECTOR_STATE_DB",
                Path.home() / ".agent-server" / "connector-state.sqlite3",
            )
        )

    def get(self, runtime: str, connector_id: str, external_session_id: str) -> RuntimeSyncState | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT fingerprint_json, cursor_json, metadata_json
                FROM runtime_sync_state
                WHERE runtime = ? AND connector_id = ? AND external_session_id = ?
                """,
                (runtime, connector_id, external_session_id),
            ).fetchone()
        if row is None:
            return None
        return RuntimeSyncState(
            fingerprint=_loads(row["fingerprint_json"]),
            cursor=_loads(row["cursor_json"]),
            metadata=_loads(row["metadata_json"]),
        )

    def set(
        self,
        runtime: str,
        connector_id: str,
        external_session_id: str,
        *,
        fingerprint: dict[str, Any] | None = None,
        cursor: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO runtime_sync_state (
                    runtime,
                    connector_id,
                    external_session_id,
                    fingerprint_json,
                    cursor_json,
                    metadata_json,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(runtime, connector_id, external_session_id) DO UPDATE SET
                    fingerprint_json = excluded.fingerprint_json,
                    cursor_json = excluded.cursor_json,
                    metadata_json = excluded.metadata_json,
                    updated_at = excluded.updated_at
                """,
                (
                    runtime,
                    connector_id,
                    external_session_id,
                    _dumps(fingerprint),
                    _dumps(cursor),
                    _dumps(metadata),
                    now,
                ),
            )

    def delete_runtime(self, runtime: str, connector_id: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM runtime_sync_state WHERE runtime = ? AND connector_id = ?",
                (runtime, connector_id),
            )

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS runtime_sync_state (
                    runtime TEXT NOT NULL,
                    connector_id TEXT NOT NULL,
                    external_session_id TEXT NOT NULL,
                    fingerprint_json TEXT,
                    cursor_json TEXT,
                    metadata_json TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (runtime, connector_id, external_session_id)
                )
                """
            )


def _dumps(value: dict[str, Any] | None) -> str | None:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _loads(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    loaded = json.loads(value)
    return loaded if isinstance(loaded, dict) else None
