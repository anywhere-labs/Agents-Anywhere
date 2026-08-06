from __future__ import annotations

from typing import Any

from connector.runtime_protocol import RuntimeHostClient, RuntimeSupervisor
from connector.server.local_rpc import (
    BackgroundScheduler,
    LocalRpcHandler,
    StartTerminalRelay,
    UploadPreparedDownload,
)
from connector.server.runtime_rpc import RuntimeRpcHandler


class ConnectorRequestDispatcher:
    """Top-level backend connector RPC router."""

    def __init__(
        self,
        agent_runtime_supervisor: RuntimeSupervisor,
        agent_runtime_host: RuntimeHostClient,
        local_ops: Any,
        upload_prepared_download: UploadPreparedDownload,
        start_terminal_relay: StartTerminalRelay,
        schedule_background: BackgroundScheduler,
    ) -> None:
        self.runtime_rpc = RuntimeRpcHandler(
            agent_runtime_supervisor=agent_runtime_supervisor,
            agent_runtime_host=agent_runtime_host,
            schedule_background=schedule_background,
        )
        self.local_rpc = LocalRpcHandler(
            local_ops=local_ops,
            upload_prepared_download=upload_prepared_download,
            start_terminal_relay=start_terminal_relay,
            schedule_background=schedule_background,
        )

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if self.runtime_rpc.supports(method):
            return await self.runtime_rpc.dispatch(method, params)
        if self.local_rpc.supports(method):
            return await self.local_rpc.dispatch(method, params)
        raise ValueError(f"unsupported connector method: {method}")

    async def discover_runtimes(self) -> dict[str, Any]:
        return await self.runtime_rpc.discover_runtimes()
