from __future__ import annotations

"""Deprecated Connector-local runtime config store.

Runtime config values are Server-owned in v2. Connector runtime providers only
publish config schemas/defaults and validate config values supplied by Server
RPC. This module is kept as migration reference only and must not be imported by
active Connector code.
"""

import copy
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from connector.paths import connector_data_dir


class RuntimeConfigStoreError(RuntimeError):
    code = "runtime_config_store_error"


class JsonRuntimeConfigStore:
    """JSON-backed runtime config value store.

    The store persists per-runtime config values only. Runtime validation,
    normalization, and effective `RuntimeConfig` creation remain provider
    responsibilities.
    """

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path is not None else self.default_path()

    @classmethod
    def default_path(cls) -> Path:
        return connector_data_dir() / "runtime-configs.json"

    def load(self, runtime: str) -> dict[str, Any]:
        self._validate_runtime(runtime)
        runtimes = self._read_runtimes()
        values = runtimes.get(runtime)
        if values is None:
            return {}
        if not isinstance(values, dict):
            raise RuntimeConfigStoreError(f"runtime config for {runtime!r} must be an object")
        return copy.deepcopy(values)

    def load_all(self) -> dict[str, dict[str, Any]]:
        result: dict[str, dict[str, Any]] = {}
        for runtime, values in self._read_runtimes().items():
            if isinstance(runtime, str) and isinstance(values, dict):
                result[runtime] = copy.deepcopy(values)
        return result

    def save(self, runtime: str, values: Mapping[str, Any]) -> None:
        self._validate_runtime(runtime)
        if not isinstance(values, Mapping):
            raise RuntimeConfigStoreError("runtime config values must be an object")
        runtimes = self._read_runtimes()
        runtimes[runtime] = copy.deepcopy(dict(values))
        self._write_runtimes(runtimes)

    def delete(self, runtime: str) -> None:
        self._validate_runtime(runtime)
        runtimes = self._read_runtimes()
        if runtime not in runtimes:
            return
        runtimes.pop(runtime)
        self._write_runtimes(runtimes)

    def _read_runtimes(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as exc:
            raise RuntimeConfigStoreError(f"runtime config store is invalid JSON: {exc}") from exc
        if not isinstance(payload, dict):
            raise RuntimeConfigStoreError("runtime config store root must be an object")
        runtimes = payload.get("runtimes", {})
        if not isinstance(runtimes, dict):
            raise RuntimeConfigStoreError("runtime config store runtimes must be an object")
        return runtimes

    def _write_runtimes(self, runtimes: Mapping[str, Any]) -> None:
        payload = {
            "version": 1,
            "runtimes": runtimes,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_name(f"{self.path.name}.tmp")
        tmp_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        tmp_path.chmod(0o600)
        tmp_path.replace(self.path)
        self.path.chmod(0o600)

    @staticmethod
    def _validate_runtime(runtime: str) -> None:
        if not isinstance(runtime, str) or not runtime:
            raise RuntimeConfigStoreError("runtime must be a non-empty string")
