from __future__ import annotations

import os

import pytest

from connector.local_runtime import (
    ConnectorAlreadyRunningError,
    assert_can_start,
    clear_runtime,
    read_runtime,
    runtime_path,
    write_runtime,
)
from connector.runtime import ConnectorConfig


def _config(connector_id: str = "conn_1") -> ConnectorConfig:
    return ConnectorConfig(
        server_url="http://127.0.0.1:8000",
        connector_id=connector_id,
        connector_token="cxt_secret",
    )


def test_runtime_path_sits_next_to_connector_config(tmp_path) -> None:
    assert runtime_path(tmp_path / "connector.json") == tmp_path / "connector-runtime.json"


def test_runtime_metadata_blocks_another_local_instance(tmp_path) -> None:
    path = tmp_path / "connector-runtime.json"
    write_runtime(path, _config("conn_1"), kind="cli", pid=os.getpid())

    with pytest.raises(ConnectorAlreadyRunningError) as exc:
        assert_can_start(path, _config("conn_2"))

    assert exc.value.owner.kind == "cli"
    clear_runtime(path)


def test_runtime_metadata_clears_stale_pid(tmp_path) -> None:
    path = tmp_path / "connector-runtime.json"
    write_runtime(path, _config(), kind="desktop", pid=99999999)

    assert_can_start(path, _config())

    assert read_runtime(path) is None
