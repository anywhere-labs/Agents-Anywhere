from __future__ import annotations

import copy
import json
import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from connector.paths import connector_data_dir
from connector.time import utc_now

STATE_FILE_VERSION = 1


@dataclass(frozen=True, slots=True)
class RuntimeSyncState:
    fingerprint: dict[str, Any] | None = None
    cursor: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


class SyncStateStore:
    def get(
        self, runtime: str, connector_id: str, external_session_id: str
    ) -> RuntimeSyncState | None:
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

    def delete(self, runtime: str, connector_id: str, external_session_id: str) -> None:
        raise NotImplementedError

    def flush(self) -> bool:
        """Persist pending changes and return whether a write was performed."""

        raise NotImplementedError


class JsonSyncStateStore(SyncStateStore):
    """Single-process sync state cached in memory and persisted as JSON."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._flush_lock = threading.Lock()
        self._document = self._read()
        self._generation = 0
        self._flushed_generation = 0

    @classmethod
    def default_path(cls) -> Path:
        configured = os.environ.get("AGENT_CONNECTOR_STATE_FILE")
        return (
            Path(configured).expanduser()
            if configured
            else connector_data_dir() / "connector-state.json"
        )

    def get(
        self, runtime: str, connector_id: str, external_session_id: str
    ) -> RuntimeSyncState | None:
        with self._lock:
            value = (
                self._document["states"]
                .get(runtime, {})
                .get(connector_id, {})
                .get(external_session_id)
            )
            if not isinstance(value, dict):
                return None
            return RuntimeSyncState(
                fingerprint=_copy_optional_dict(value.get("fingerprint")),
                cursor=_copy_optional_dict(value.get("cursor")),
                metadata=_copy_optional_dict(value.get("metadata")),
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
        next_value = {
            "fingerprint": copy.deepcopy(fingerprint),
            "cursor": copy.deepcopy(cursor),
            "metadata": copy.deepcopy(metadata),
        }
        with self._lock:
            runtime_states = self._document["states"].setdefault(runtime, {})
            connector_states = runtime_states.setdefault(connector_id, {})
            current = connector_states.get(external_session_id)
            if _stored_value_matches(current, next_value):
                return
            connector_states[external_session_id] = {
                **next_value,
                "updatedAt": utc_now(),
            }
            self._generation += 1

    def delete_runtime(self, runtime: str, connector_id: str) -> None:
        with self._lock:
            runtime_states = self._document["states"].get(runtime)
            if (
                not isinstance(runtime_states, dict)
                or connector_id not in runtime_states
            ):
                return
            del runtime_states[connector_id]
            if not runtime_states:
                del self._document["states"][runtime]
            self._generation += 1

    def delete(self, runtime: str, connector_id: str, external_session_id: str) -> None:
        with self._lock:
            runtime_states = self._document["states"].get(runtime)
            if not isinstance(runtime_states, dict):
                return
            connector_states = runtime_states.get(connector_id)
            if (
                not isinstance(connector_states, dict)
                or external_session_id not in connector_states
            ):
                return
            del connector_states[external_session_id]
            if not connector_states:
                del runtime_states[connector_id]
            if not runtime_states:
                del self._document["states"][runtime]
            self._generation += 1

    def flush(self) -> bool:
        with self._flush_lock:
            with self._lock:
                generation = self._generation
                if generation == self._flushed_generation:
                    return False
                document = copy.deepcopy(self._document)
            self._write(document)
            with self._lock:
                self._flushed_generation = generation
            return True

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"version": STATE_FILE_VERSION, "states": {}}
        try:
            document = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(
                f"invalid connector sync state file: {self.path}"
            ) from exc
        if (
            not isinstance(document, dict)
            or document.get("version") != STATE_FILE_VERSION
            or not isinstance(document.get("states"), dict)
        ):
            raise RuntimeError(f"unsupported connector sync state file: {self.path}")
        return document

    def _write(self, document: dict[str, Any]) -> None:
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                json.dump(
                    document, temporary, ensure_ascii=False, indent=2, sort_keys=True
                )
                temporary.write("\n")
                temporary.flush()
                os.fsync(temporary.fileno())
            temporary_path.chmod(0o600)
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path is not None and temporary_path.exists():
                temporary_path.unlink()


def _copy_optional_dict(value: Any) -> dict[str, Any] | None:
    return copy.deepcopy(value) if isinstance(value, dict) else None


def _stored_value_matches(current: Any, next_value: dict[str, Any]) -> bool:
    if not isinstance(current, dict):
        return False
    return all(current.get(key) == value for key, value in next_value.items())
