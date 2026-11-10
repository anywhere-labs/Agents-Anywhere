"""Connector-local delivery receipts for asynchronous Codex questionnaires."""

from __future__ import annotations

import hashlib

from connector.core.json_kv import JsonKeyValueStore


class AsyncInputSubmissions:
    def __init__(self, namespace: str, store: JsonKeyValueStore | None = None) -> None:
        self._namespace = namespace
        self._store = store
        self._statuses: dict[str, str] = {}

    def status(self, call_id: str) -> str | None:
        if call_id in self._statuses:
            return self._statuses[call_id]
        value = self._store.get(self._key(call_id)) if self._store is not None else None
        status = value.get("status") if value is not None else None
        if status in {"sending", "answered", "cancelled"}:
            self._statuses[call_id] = str(status)
            return str(status)
        return None

    def record(self, call_id: str, status: str) -> None:
        if self.status(call_id) == status:
            return
        if self._store is not None:
            self._store.set(self._key(call_id), {"status": status})
        self._statuses[call_id] = status

    def forget(self, call_id: str) -> None:
        if self._store is not None:
            self._store.delete(self._key(call_id))
        self._statuses.pop(call_id, None)

    def _key(self, call_id: str) -> str:
        digest = hashlib.sha256(call_id.encode("utf-8")).hexdigest()
        return f"codex/async-input/{self._namespace}/{digest}"
