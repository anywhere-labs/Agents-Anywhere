from agent_server.core.operations import OperationRecord, OperationRequest
from agent_server.infra.connector_rpc import ConnectorOfflineError
from agent_server.infra.mesh_operations import MeshOperations


class MeshOperationTransport:
    def __init__(self, mesh: MeshOperations, repository) -> None:
        self.mesh = mesh
        self.repository = repository

    async def exchange(
        self, request: OperationRequest, *, accepted: bool
    ) -> OperationRecord | None:
        client, connection_id = await self.mesh.client(request.connectorId)
        record = await client.get(request.operationId)
        if not await self.mesh.rpc.is_connection_id_current(
            request.connectorId, connection_id
        ):
            raise ConnectorOfflineError("Connector connection changed")
        if record is None and not accepted:
            async with self.repository.connector_lifecycle(request.connectorId):
                runtime = await self.repository.get_device_runtime(
                    request.connectorId, request.runtimeId, user_id=request.userId
                )
                if (
                    runtime["runtimeType"] != request.runtime
                    or not runtime["configured"]
                ):
                    raise ValueError("Runtime source changed")
                config = await self.mesh.rpc.request(
                    request.connectorId,
                    "runtime.config",
                    {"runtime": request.runtime, "runtimeId": request.runtimeId},
                    timeout=5,
                )
                if (config.get("config") or {}).get(
                    "revision"
                ) != request.configRevision:
                    raise ValueError(
                        "Runtime configuration changed before operation delivery"
                    )
                if not await self.mesh.rpc.is_connection_id_current(
                    request.connectorId, connection_id
                ):
                    raise ConnectorOfflineError("Connector connection changed")
                record = await client.submit(request)
        if not await self.mesh.rpc.is_connection_id_current(
            request.connectorId, connection_id
        ):
            raise ConnectorOfflineError("Connector connection changed")
        if record is not None and record.request.fingerprint() != request.fingerprint():
            raise ValueError("Operation response identity mismatch")
        # Result reception ACK is sent on the next polling attempt after persistence.
        # Never ACK before the Server transaction commits the result.
        return record

    async def acknowledge(self, request: OperationRequest) -> None:
        client, _ = await self.mesh.client(request.connectorId)
        record = await client.ackResult(request.operationId)
        if (
            record is None
            or not record.resultReceived
            or record.request.fingerprint() != request.fingerprint()
        ):
            raise ValueError("Operation acknowledgement identity mismatch")

    async def legacy_receipt(self, operation: dict) -> dict:
        return await self.mesh.rpc.request(
            operation["connector_id"],
            "project.operation",
            {
                "runtime": operation["runtime"],
                "runtimeId": operation["runtime_id"],
                "requestId": operation["id"],
            },
            timeout=5,
        )
