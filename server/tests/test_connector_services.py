from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_server.infra.connector_gateway import ConnectorGateway
from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcError
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.services.connector_files import ConnectorFileService
from agent_server.services.connector_realtime import ConnectorRealtimeService
from agent_server.services.connector_rpc import (
    ConnectorProtocolError,
    ConnectorRequestTimeoutError,
    ConnectorUnavailableError,
    ConnectorUpstreamError,
)
from agent_server.services.connector_shell import ConnectorShellService
from agent_server.services.shell_tasks import ShellTaskManager


class StubRpc:
    def __init__(self, result: Any = None, error: Exception | None = None) -> None:
        self.result = result
        self.error = error
        self.requests: list[tuple[str, str, dict[str, Any], float]] = []

    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any:
        self.requests.append((connector_id, method, params, timeout))
        if self.error is not None:
            raise self.error
        return self.result


@pytest.mark.parametrize(
    ("transport_error", "service_error"),
    [
        (ConnectorOfflineError("offline"), ConnectorUnavailableError),
        (ConnectorRpcError("upstream_error", "failed"), ConnectorUpstreamError),
        (TimeoutError(), ConnectorRequestTimeoutError),
    ],
)
def test_connector_gateway_translates_transport_errors(
    transport_error: Exception,
    service_error: type[Exception],
) -> None:
    async def exercise() -> None:
        gateway = ConnectorGateway(StubRpc(error=transport_error))
        with pytest.raises(service_error):
            await gateway.request(
                "connector-1",
                "shell.exec",
                {},
                timeout=1,
            )

    asyncio.run(exercise())


def test_shell_service_abandons_task_when_start_rpc_fails() -> None:
    async def exercise() -> None:
        rpc = StubRpc(error=ConnectorRpcError("upstream_error", "start failed"))
        tasks = ShellTaskManager()
        service = ConnectorShellService(ConnectorGateway(rpc), tasks)

        with pytest.raises(ConnectorUpstreamError, match="start failed"):
            await service.start(
                connector_id="connector-1",
                scope_id="browse_connector-1",
                root="/repo",
                cwd="/repo",
                command="pwd",
                timeout_ms=30_000,
            )

        task_id = rpc.requests[0][2]["taskId"]
        with pytest.raises(KeyError):
            await tasks.get(task_id, session_id="browse_connector-1")

    asyncio.run(exercise())


def test_file_service_prepares_ephemeral_download() -> None:
    async def exercise() -> None:
        rpc = StubRpc(
            result={
                "path": "/repo/report.txt",
                "name": "report.txt",
                "size": 12,
                "sha256": "abc",
                "mediaType": "text/plain",
            }
        )
        downloads = FsDownloadRelayManager()
        service = ConnectorFileService(rpc, downloads)

        prepared = await service.prepare_download(
            connector_id="connector-1",
            scope_id="browse_connector-1",
            root="/repo",
            path="/repo/report.txt",
        )

        assert prepared.transfer.connector_id == "connector-1"
        assert prepared.transfer.name == "report.txt"
        assert (
            await downloads.get(
                prepared.transfer.transfer_id,
                prepared.transfer.token,
            )
            == prepared.transfer
        )
        assert rpc.requests == [
            (
                "connector-1",
                "fs.prepareDownload",
                {
                    "sessionId": "browse_connector-1",
                    "root": "/repo",
                    "path": "/repo/report.txt",
                },
                30,
            )
        ]

    asyncio.run(exercise())


def test_file_service_rejects_invalid_connector_response() -> None:
    async def exercise() -> None:
        service = ConnectorFileService(
            StubRpc(result="invalid"), FsDownloadRelayManager()
        )
        with pytest.raises(ConnectorProtocolError, match="invalid fs.prepareDownload"):
            await service.prepare_download(
                connector_id="connector-1",
                scope_id="browse_connector-1",
                root="/repo",
                path="/repo/report.txt",
            )

    asyncio.run(exercise())


def test_realtime_service_completes_shell_task() -> None:
    class TerminalBrokerStub:
        async def on_output(self, *args, **kwargs) -> None:
            raise AssertionError("unexpected terminal output")

        async def on_exited(self, *args, **kwargs) -> None:
            raise AssertionError("unexpected terminal exit")

    class TerminalStreamHubStub:
        async def publish_output(self, *args, **kwargs) -> None:
            raise AssertionError("unexpected terminal output")

        async def publish_exit(self, *args, **kwargs) -> None:
            raise AssertionError("unexpected terminal exit")

    async def exercise() -> None:
        tasks = ShellTaskManager()
        task = await tasks.create(
            session_id="browse_connector-1",
            connector_id="connector-1",
            command="pwd",
            cwd="/repo",
            timeout_ms=30_000,
        )
        service = ConnectorRealtimeService(
            tasks,
            TerminalBrokerStub(),  # type: ignore[arg-type]
            TerminalStreamHubStub(),  # type: ignore[arg-type]
        )

        handled = await service.apply(
            connector_id="connector-1",
            method="shell.task.completed",
            params={
                "taskId": task.id,
                "sessionId": task.session_id,
                "status": "completed",
                "result": {"exitCode": 0, "stdout": "/repo\n"},
            },
        )

        assert handled is True
        completed = await tasks.get(task.id, session_id=task.session_id)
        assert completed.status == "completed"
        assert completed.result == {"exitCode": 0, "stdout": "/repo\n"}

    asyncio.run(exercise())
