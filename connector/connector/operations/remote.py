"""Remote Mesh registration; execution survives socket and token replacement."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from meshcall import Mesh, Router
from pydantic import BaseModel

from connector.logging import logger
from connector.operations.executor import OperationExecutor
from connector.operations.models import OperationRequest, OperationResult, ProtocolInfo
from connector.operations.service import bind_service
from connector.operations.store import OperationStore
from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeScope,
    RuntimeUnavailableError,
)
from connector.server.sync_state import JsonSyncStateStore
from connector.server.urls import is_loopback_url


class RemoteOperations:
    def __init__(self, backend) -> None:
        self.backend = backend
        state_path = (
            Path(backend.config.state_path)
            if backend.config.state_path
            else JsonSyncStateStore.default_path()
        )
        namespace = hashlib.sha256(
            f"{backend.config.server_url.rstrip('/')}:{backend.config.connector_id}".encode()
        ).hexdigest()
        self.store_path = state_path.expanduser().parent / "operations" / namespace
        self.executor: OperationExecutor | None = None
        self.source: dict[str, str] = {}

    async def prepare(self, request: OperationRequest) -> None:
        if any(getattr(request, key) != value for key, value in self.source.items()):
            raise RuntimeInvalidRequestError("Operation source changed")
        try:
            entry = self.backend.agent_runtime_supervisor.entry(request.runtimeId)
        except RuntimeInvalidRequestError as error:
            raise RuntimeUnavailableError("等待 Runtime 实例恢复配置") from error
        if entry.config is None:
            raise RuntimeUnavailableError("等待 Runtime 配置就绪")
        self.backend._dispatcher.runtime_rpc._resolve_agent_runtime(
            {"runtime": request.runtime, "runtimeId": request.runtimeId}
        )
        if entry.config.revision != request.configRevision:
            raise RuntimeInvalidRequestError(
                "Runtime configuration changed before execution"
            )

    async def execute(
        self, request: OperationRequest, recover: bool
    ) -> OperationResult:
        if any(getattr(request, key) != value for key, value in self.source.items()):
            raise RuntimeInvalidRequestError("Operation source changed")
        handler = self.backend._dispatcher.runtime_rpc
        runtime = handler._resolve_agent_runtime(
            {"runtime": request.runtime, "runtimeId": request.runtimeId}
        )
        config = self.backend.agent_runtime_supervisor.entry(request.runtimeId).config
        if config is None or config.revision != request.configRevision:
            raise RuntimeInvalidRequestError(
                "Runtime configuration changed; do not replay this operation"
            )
        native = getattr(runtime, "native_runtime", runtime)
        if hasattr(native, "execute_workspace_operation"):
            result = await native.execute_workspace_operation(
                request.model_dump(), recover=recover
            )
        else:
            if recover:
                # A passed idempotencyKey is not proof the installed native runtime supports durable replay.
                raise RuntimeError(
                    "Native result requires reconciliation; automatic replay is unavailable"
                )
            result = await runtime.create_workspace(
                name=request.name, path=request.path, request_id=request.operationId
            )
        await handler._invalidate_workspaces(
            RuntimeScope(request.runtimeId, request.runtime)
        )
        return OperationResult.model_validate(result)

    async def acknowledge(self, request: OperationRequest) -> None:
        runtime = self.backend._dispatcher.runtime_rpc._resolve_agent_runtime(
            {"runtime": request.runtime, "runtimeId": request.runtimeId}
        )
        native = getattr(runtime, "native_runtime", runtime)
        if hasattr(native, "ack_workspace_operation"):
            await native.ack_workspace_operation(request.model_dump())

    async def run(self) -> None:
        if self.executor is None:
            self.executor = OperationExecutor(
                OperationStore(self.store_path),
                self.execute,
                self.acknowledge,
                self.prepare,
            )
        while True:
            mesh = None
            try:
                backend = self.backend
                token = await backend.ensure_access_token()
                response = await backend._get_http_client().post(
                    backend.config.server_url.rstrip("/")
                    + "/api/v2/connector/mesh/bootstrap",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "connectionToken": backend._workspace_connection_token,
                        "protocolVersion": "1.0",
                    },
                )
                response.raise_for_status()
                info = response.json()
                if (
                    info["protocolVersion"] != "1.0"
                    or info["connectorId"] != backend.config.connector_id
                ):
                    raise ValueError("MeshCall bootstrap identity mismatch")
                parts = urlsplit(backend.config.server_url)
                url = urlunsplit(
                    (
                        "wss" if parts.scheme == "https" else "ws",
                        parts.netloc,
                        info["path"],
                        "",
                        "",
                    )
                )
                if parts.scheme == "http" and not is_loopback_url(
                    backend.config.server_url
                ):
                    raise ValueError("Remote MeshCall connections require HTTPS/WSS")
                if parts.scheme not in {"http", "https"}:
                    raise ValueError("Unsupported Server URL")
                self.source = {
                    "server": info["serverId"],
                    "userId": info["userId"],
                    "connectorId": info["connectorId"],
                }
                await self.executor.start()
                service = bind_service(
                    info["service"],
                    self.executor,
                    asyncio.get_running_loop(),
                    self.source,
                )
                mesh = Mesh(Router(url), token=info["token"])
                mesh.mount(service, instance_id=info["instanceId"], max_inflight=16)
                async with mesh.serve(access_log=False, drain_timeout=0):
                    # Introspection detects a Router restart even when the existing
                    # service driver is trying to reconnect with a now-invalid token.
                    for _ in range(168):
                        await asyncio.sleep(5)
                        async with asyncio.timeout(5):

                            class Empty(BaseModel):
                                pass

                            await mesh.call_unary(
                                info["service"],
                                "ping",
                                Empty(),
                                ProtocolInfo,
                                instance=info["instanceId"],
                                timeout=4,
                            )
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - connection failures rebuild the transport, not operations
                logger.warning(
                    "remote operations unavailable; retrying ({})", type(error).__name__
                )
                await asyncio.sleep(3)
            finally:
                if mesh is not None:
                    # Expired/revoked credentials can make the SDK close path raise.
                    with contextlib.suppress(Exception):
                        await mesh.close()

    async def close(self) -> None:
        if self.executor:
            await self.executor.close()
