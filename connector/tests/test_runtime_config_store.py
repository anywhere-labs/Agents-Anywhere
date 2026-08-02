from __future__ import annotations

import json
import stat

import pytest

from connector.core.runtime_config_store import (
    JsonRuntimeConfigStore,
    RuntimeConfigStoreError,
)


def test_runtime_config_store_saves_loads_and_deletes_runtime_values(tmp_path) -> None:
    path = tmp_path / "runtime-configs.json"
    store = JsonRuntimeConfigStore(path)

    assert store.load("codex") == {}

    store.save(
        "codex",
        {
            "sdkMode": "auto",
            "ipcEnabled": True,
            "environment": {"EXAMPLE": "1"},
        },
    )
    store.save("claude", {"executablePath": "/opt/claude"})

    assert store.load("codex") == {
        "sdkMode": "auto",
        "ipcEnabled": True,
        "environment": {"EXAMPLE": "1"},
    }
    assert store.load_all() == {
        "claude": {"executablePath": "/opt/claude"},
        "codex": {
            "sdkMode": "auto",
            "ipcEnabled": True,
            "environment": {"EXAMPLE": "1"},
        },
    }
    assert stat.S_IMODE(path.stat().st_mode) == 0o600

    store.delete("codex")

    assert store.load("codex") == {}
    assert store.load("claude") == {"executablePath": "/opt/claude"}


def test_runtime_config_store_returns_copies(tmp_path) -> None:
    store = JsonRuntimeConfigStore(tmp_path / "runtime-configs.json")
    store.save("codex", {"environment": {"A": "1"}})

    loaded = store.load("codex")
    loaded["environment"]["A"] = "changed"

    assert store.load("codex") == {"environment": {"A": "1"}}


def test_runtime_config_store_rejects_invalid_runtime(tmp_path) -> None:
    store = JsonRuntimeConfigStore(tmp_path / "runtime-configs.json")

    with pytest.raises(RuntimeConfigStoreError):
        store.load("")


def test_runtime_config_store_rejects_invalid_json(tmp_path) -> None:
    path = tmp_path / "runtime-configs.json"
    path.write_text("{", encoding="utf-8")
    store = JsonRuntimeConfigStore(path)

    with pytest.raises(RuntimeConfigStoreError, match="invalid JSON"):
        store.load("codex")


def test_runtime_config_store_rejects_invalid_shape(tmp_path) -> None:
    path = tmp_path / "runtime-configs.json"
    path.write_text(json.dumps({"runtimes": []}), encoding="utf-8")
    store = JsonRuntimeConfigStore(path)

    with pytest.raises(RuntimeConfigStoreError, match="runtimes must be an object"):
        store.load("codex")
