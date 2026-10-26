"""Persistent operation orchestration. Transport and storage are injected ports."""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

from loguru import logger

from agent_server.core.operations import OperationRecord, OperationRequest


class OperationRepository(Protocol):
    async def claim_mesh_operations(
        self, *, limit: int = 16
    ) -> list[dict[str, Any]]: ...
    async def finish_mesh_attempt(
        self, operation_id: str, generation: int, **values: Any
    ) -> None: ...
    async def get_device_runtime(
        self, connector_id: str, runtime_id: str, *, user_id: str
    ) -> dict: ...
    async def operation_server_identity(self) -> str: ...
    async def acknowledge_mesh_result(
        self, operation_id: str, generation: int
    ) -> None: ...


class OperationTransport(Protocol):
    async def exchange(
        self, request: OperationRequest, *, accepted: bool
    ) -> OperationRecord | None: ...
    async def legacy_receipt(self, operation: dict) -> dict: ...
    async def acknowledge(self, request: OperationRequest) -> None: ...


class OperationDispatcher:
    def __init__(
        self, repository: OperationRepository, transport: OperationTransport
    ) -> None:
        self.repository, self.transport = repository, transport

    async def run(self) -> None:
        while True:
            try:
                rows = await self.repository.claim_mesh_operations()
                await asyncio.gather(*(self.deliver(row) for row in rows))
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - keep persistent scheduling alive
                logger.exception("operation dispatch deferred")
            await asyncio.sleep(1)

    async def deliver(self, row: dict[str, Any]) -> None:
        stage = row["execution_status"]
        result = None
        message = None
        accepted = bool(row["delivery_accepted"])
        try:
            # All retries re-check ownership and revocation, never just the initial HTTP admission.
            runtime = await self.repository.get_device_runtime(
                row["connector_id"], row["runtime_id"], user_id=row["user_id"]
            )
            if runtime["runtimeType"] != row["runtime"]:
                raise ValueError("Runtime source changed")
            if row["execution_json"] is None:
                receipt = await self.transport.legacy_receipt(row)
                stage = receipt.get("status", "unknown")
                if stage not in {"succeeded", "failed"}:
                    stage = "unknown"
                result = receipt.get("result")
                if stage == "succeeded" and (
                    not isinstance(result, dict) or not result.get("nativeProjectId")
                ):
                    stage, message = "unknown", "旧原生回执缺少项目身份，需要核对"
            else:
                request = OperationRequest.model_validate_json(row["execution_json"])
                if (
                    request.userId,
                    request.connectorId,
                    request.runtimeId,
                    request.runtime,
                    request.operationId,
                ) != (
                    row["user_id"],
                    row["connector_id"],
                    row["runtime_id"],
                    row["runtime"],
                    row["id"],
                ):
                    raise ValueError("Stored operation source mismatch")
                if request.server != await self.repository.operation_server_identity():
                    raise ValueError("Operation belongs to a different Server")
                if row["status"] in {"succeeded", "failed"}:
                    await self.transport.acknowledge(request)
                    await self.repository.acknowledge_mesh_result(
                        row["id"], row["dispatch_generation"]
                    )
                    return
                record = await self.transport.exchange(request, accepted=accepted)
                if record is None:
                    stage, message = "unknown", "设备回执缺失，不能确认原生结果"
                else:
                    if record.request.fingerprint() != request.fingerprint():
                        raise ValueError("Device operation receipt source mismatch")
                    stage, accepted = record.status, True
                    result = (
                        record.result.model_dump()
                        if record.result is not None
                        else None
                    )
                    message = record.message
        except asyncio.CancelledError:
            raise
        except (KeyError, ValueError) as error:
            stage = (
                "unknown"
                if accepted
                or row["execution_json"] is None
                or row["dispatch_generation"] > 1
                else "failed"
            )
            message = str(error)
        except Exception:  # noqa: BLE001 - transport failure is not evidence of native failure
            # Transport failure is never proof of native failure; retain durable stage.
            message = "工作设备暂不可达，正在等待连接恢复"
        await self.repository.finish_mesh_attempt(
            row["id"],
            row["dispatch_generation"],
            execution_status=stage,
            result=result,
            accepted=accepted,
            message=message,
        )
