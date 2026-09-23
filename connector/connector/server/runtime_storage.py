"""Connector-owned instance storage, with one-time full legacy copies."""
from __future__ import annotations

import shutil
import os
import tempfile
import threading
from pathlib import Path

from connector.core.json_kv import JsonKeyValueStore
from connector.core.runtime_owner import state_lock
from connector.server.sync_state import JsonSyncStateStore


def directory_id(value: str) -> str:
    if not value or value in {".", ".."} or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-" for c in value):
        raise ValueError("Invalid Connector/runtime directory identity")
    return value


class RuntimeStorageManager:
    def __init__(self, legacy: JsonSyncStateStore, legacy_kv: Path | None = None) -> None:
        self.legacy = legacy
        self.legacy_kv = legacy_kv or JsonKeyValueStore.default_path()
        self.root = legacy.path.parent
        self._stores: dict[tuple[str, str], tuple[JsonSyncStateStore, JsonKeyValueStore]] = {}
        self._lock = threading.RLock()

    def prepare(self, connector_id: str, runtime_id: str) -> tuple[JsonSyncStateStore, JsonKeyValueStore]:
        identity = (directory_id(connector_id), directory_id(runtime_id))
        with self._lock:
            if identity in self._stores:
                return self._stores[identity]
            target = self.root / identity[0] / identity[1]
            with state_lock(target.parent / f".{identity[1]}.migration.lock"):
                if not target.exists():
                    temporary = Path(tempfile.mkdtemp(prefix=f".{identity[1]}-", dir=target.parent))
                    try:
                        # Include already committed but not yet flushed legacy state.
                        self.legacy.flush()
                        if self.legacy.path.exists():
                            shutil.copyfile(self.legacy.path, temporary / "sync-state.json")
                        if self.legacy_kv.exists():
                            shutil.copyfile(self.legacy_kv, temporary / "kv.json")
                        state = JsonSyncStateStore(temporary / "sync-state.json")
                        kv = JsonKeyValueStore(temporary / "kv.json")
                        # Validate both copies before publishing the whole directory.
                        kv.read_document()
                        if not state.path.exists():
                            state._write({"version": 1, "states": {}})
                        if not kv.path.exists():
                            kv.write_document({"version": 1, "values": {}})
                        for file in temporary.iterdir():
                            file.chmod(0o600)
                            # Windows fsync requires a writable file descriptor.
                            with file.open("r+b") as stream:
                                os.fsync(stream.fileno())
                        temporary.rename(target)
                    finally:
                        if temporary.exists():
                            shutil.rmtree(temporary)
                stores = (JsonSyncStateStore(target / "sync-state.json"), JsonKeyValueStore(target / "kv.json"))
                self._stores[identity] = stores
                return stores

    def flush(self) -> bool:
        with self._lock:
            stores = list(self._stores.values())
        changed = False
        for state, _ in stores:
            changed = state.flush() or changed
        return changed
