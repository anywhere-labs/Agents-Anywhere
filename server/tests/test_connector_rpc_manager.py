from __future__ import annotations

from agent_server.infra.connector_rpc import ConnectorRpcManager


def test_connector_rpc_manager_replaces_existing_connection() -> None:
    manager = ConnectorRpcManager(heartbeat_timeout_seconds=60, clock=lambda: 10)
    old = manager.register("conn_1", object())  # type: ignore[arg-type]
    new = manager.register("conn_1", object())  # type: ignore[arg-type]

    assert new is not old
    assert manager.is_online("conn_1") is True


def test_connector_rpc_manager_replaces_stale_connection() -> None:
    now = 10

    def clock() -> float:
        return now

    manager = ConnectorRpcManager(heartbeat_timeout_seconds=5, clock=clock)
    old = manager.register("conn_1", object())  # type: ignore[arg-type]
    now = 20

    new = manager.register("conn_1", object())  # type: ignore[arg-type]

    assert new is not old
    assert manager.is_online("conn_1") is True
