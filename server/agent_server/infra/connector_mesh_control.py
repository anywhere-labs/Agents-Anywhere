"""MeshCall adapter implementing the Server's Connector request transport."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import asdict
from typing import Any

from meshcall import DeadlineExceededError, MeshCallError, UnavailableError
from meshcall.protocol import CallOpenFrame, encode_frame
from meshcall.transport import DEFAULT_MAX_FRAME_SIZE
from pydantic import BaseModel, ConfigDict

from agent_server.infra.connector_control_log import (
    business_fields,
    control_log,
    error_fields,
    result_fields,
)
from agent_server.infra.connector_mesh import ConnectorMesh
from agent_server.infra.connector_mesh_contract import (
    CONTROL_METHODS,
    service_names,
)
from agent_server.infra.connector_mesh_routes import MeshRoute
from agent_server.infra.connector_rpc import (
    ConnectorConnection,
    ConnectorNotDispatchedError,
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
    ConnectorTransportTimeout,
    bounded_connector_request,
    connector_request_timeout,
    current_request_deadline,
    routed_request_timeout,
)


class Payload(BaseModel):
    model_config = ConfigDict(extra="allow")


class ControlRequest(BaseModel):
    request: Payload


class MeshConnectorControlTransport:
    """Route application requests to the matching Connector domain service."""

    def __init__(self, mesh: ConnectorMesh, rpc: ConnectorRpcManager) -> None:
        self.mesh = mesh
        self.rpc = rpc

    def supports(self, method: str) -> bool:
        return method in CONTROL_METHODS

    @bounded_connector_request
    async def request_bound(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> tuple[Any, str]:
        connection_id = await self.rpc.current_connection_id(connector_id)
        if connection_id is None:
            raise ConnectorOfflineError("connector is offline")
        result = await self._request_on_connection(
            connector_id,
            connection_id,
            method,
            params,
            timeout=timeout,
        )
        return result, connection_id

    @bounded_connector_request
    async def request_on_connection(
        self,
        connection: ConnectorConnection,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any:
        if not await self.rpc.is_connection_id_current(
            connection.connector_id, connection.connection_id
        ):
            raise ConnectorOfflineError("connector connection was replaced")
        return await self._request_on_connection(
            connection.connector_id,
            connection.connection_id,
            method,
            params,
            timeout=timeout,
        )

    @bounded_connector_request
    async def _request_on_connection(
        self,
        connector_id: str,
        connection_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any:
        loop = asyncio.get_running_loop()
        budget = current_request_deadline()
        assert budget is not None
        deadline = budget.when
        call_id = budget.call_id
        started_at = time.monotonic()
        context = {**business_fields(params), "callId": call_id, "method": method,
                   "connectorId": connector_id, "connectionId": connection_id,
                   "sourceWorkerId": self.rpc.instance_id, "routerId": self.mesh.router_id}
        outcome, delivery, phase = "cancelled", "not_dispatched", "route_lookup"
        lookups, retries = 0, 0
        details = {}
        route = None
        control_log("request.started", **context)
        try:
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise ConnectorTransportTimeout(
                        f"{method} timed out waiting for Connector MeshCall",
                        details={"deliveryState": "not_dispatched", "controlCallId": call_id},
                    )
                if not await self.rpc.is_connection_id_current(connector_id, connection_id):
                    raise ConnectorNotDispatchedError("connector connection changed")
                route = await self.mesh.routes.get(connector_id)
                lookups += 1
                if route is None or route.connection_id != connection_id:
                    await asyncio.sleep(min(0.1, remaining))
                    continue
                self._check_frame_budget(route, method, params, remaining, call_id)
                context.update(linkId=route.link_id, routerId=route.router_id,
                               targetWorkerId=route.worker_id, generation=route.generation)
                remaining = deadline - loop.time()
                if remaining <= 0:
                    continue
                try:
                    phase = "local_mesh" if route.router_id == self.mesh.router_id else "redis_mesh"
                    delivery = "outcome_unknown"
                    control_log("request.dispatch", level="DEBUG", phase=phase, **context)
                    if phase == "local_mesh":
                        response = await self._call_local(route, method, params, remaining, call_id)
                    else:
                        response = await self.rpc.route_mesh_request(
                            route.worker_id, connection_id,
                            {"connectorId": connector_id, "meshRoute": asdict(route),
                             "method": method, "params": params, "timeout": remaining,
                             "controlCallId": call_id}, timeout=remaining,
                        )
                    break
                except ConnectorNotDispatchedError:
                    delivery, phase = "not_dispatched", "route_lookup"
                    budget.delivery_state = delivery
                    retries += 1
                    await asyncio.sleep(min(0.1, max(0, deadline - loop.time())))
            if not await self.rpc.is_connection_id_current(connector_id, connection_id):
                raise ConnectorOfflineError(
                    "connector connection changed", details={"deliveryState": "outcome_unknown"},
                )
            outcome, delivery = "returned", "response_received"
            details = result_fields(response)
            return response
        except asyncio.CancelledError:
            if budget.remaining() <= 0:
                outcome, delivery = "timeout", budget.delivery_state
                details = {"reason": "deadline_expired"}
            else:
                details = {"reason": "caller_cancelled"}
            raise
        except Exception as exc:
            outcome = "timeout" if isinstance(exc, TimeoutError) else "failed"
            delivery = (getattr(exc, "details", None) or {}).get("deliveryState", delivery)
            details = error_fields(exc, stack=not isinstance(exc, (ConnectorRpcError, ConnectorOfflineError, TimeoutError)))
            raise
        finally:
            control_log("request.finished", level="INFO" if outcome == "returned" else "WARNING",
                        **{**context, **details}, outcome=outcome, deliveryState=delivery, phase=phase,
                        lookupCount=lookups, routeRetries=retries,
                        elapsedMs=(time.monotonic() - started_at) * 1000)

    async def request_routed(self, payload: dict[str, Any]) -> Any:
        async with connector_request_timeout(routed_request_timeout(payload), call_id=payload.get("controlCallId")):
            return await self._request_routed(payload)

    async def _request_routed(self, payload: dict[str, Any]) -> Any:
        route = MeshRoute.decode(json.dumps(payload.get("meshRoute")))
        method, params = payload.get("method"), payload.get("params")
        if (route is None or route.router_id != self.mesh.router_id
                or route.worker_id != self.rpc.instance_id
                or payload.get("connectorId") != route.connector_id
                or payload.get("connectionId") != route.connection_id
                or method not in CONTROL_METHODS or not isinstance(params, dict)):
            raise ConnectorNotDispatchedError("invalid connector mesh route")
        if (await self.mesh.routes.get(route.connector_id) != route
                or not await self.rpc.is_connection_id_current(route.connector_id, route.connection_id)):
            raise ConnectorNotDispatchedError("connector mesh route was replaced")
        return await self._call_local(
            route, method, params, current_request_deadline().remaining(),
            str(payload.get("controlCallId") or ""),
        )

    @staticmethod
    def _check_frame_budget(route: MeshRoute, method: str, params: dict[str, Any], timeout: float, call_id: str) -> None:
        # Reject impossible Mesh frames before putting their payload on Redis
        # Pub/Sub. Otherwise a single oversized call can overflow the owner
        # subscriber's output buffer before the SDK gets a chance to reject it.
        domain, mesh_method = CONTROL_METHODS[method]
        frame = CallOpenFrame(
            call_id="0" * 32, service=service_names(route.connector_id, route.connection_id, route.link_id)[domain],
            method=mesh_method, payload={"request": params}, timeout_ms=max(1, round(timeout * 1000)),
            instance_id=route.link_id,
            metadata={"aa-control-call-id": call_id, "aa-connection-id": route.connection_id},
        )
        size = len(encode_frame(frame).encode())
        if size > DEFAULT_MAX_FRAME_SIZE:
            raise ConnectorRpcError("resource_exhausted", f"MeshCall frame is {size} bytes, limit {DEFAULT_MAX_FRAME_SIZE}",
                                    details={"source": "client", "reason": "frame_too_large",
                                             "deliveryState": "not_dispatched", "controlCallId": call_id})

    async def _call_local(
        self, route: MeshRoute, method: str, params: dict[str, Any], timeout: float, call_id: str,
    ) -> dict[str, Any]:
        domain, mesh_method = CONTROL_METHODS[method]
        names = service_names(route.connector_id, route.connection_id, route.link_id)
        budget = current_request_deadline()
        deadline = min(asyncio.get_running_loop().time() + timeout, budget.when) if budget else asyncio.get_running_loop().time() + timeout
        registration_waits = 0
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise ConnectorTransportTimeout(
                    f"{method} timed out waiting for Connector MeshCall",
                    details={"deliveryState": "not_dispatched", "controlCallId": call_id},
                )
            try:
                if budget is not None:
                    budget.delivery_state = "outcome_unknown"
                response = await self.mesh.connection().call_unary(
                    names[domain], mesh_method, ControlRequest(request=Payload(**params)), Payload,
                    timeout=remaining, instance=route.link_id,
                    metadata={"aa-control-call-id": call_id, "aa-connection-id": route.connection_id},
                )
                return response.model_dump()
            except DeadlineExceededError as exc:
                if (exc.details or {}).get("source") == "connector_domain":
                    raise ConnectorRpcError(exc.code, exc.message, details=exc.details) from exc
                raise ConnectorTransportTimeout(
                    f"{method} timed out",
                    details={"deliveryState": "outcome_unknown", "controlCallId": call_id},
                ) from exc
            except UnavailableError as exc:
                # no_instances is emitted before dispatch. It is safe to wait
                # for a just-connected device without replaying a mutation.
                details = exc.details or {}
                if details.get("source") == "connector_domain":
                    raise ConnectorRpcError(exc.code, exc.message, details=details) from exc
                if (details.get("source") == "connector_executor"
                        and details.get("deliveryState") == "not_dispatched"):
                    raise ConnectorNotDispatchedError(exc.message, details=details) from exc
                if (
                    details.get("source") == "router"
                    and details.get("reason") == "no_instances"
                ):
                    if budget is not None:
                        budget.delivery_state = "not_dispatched"
                    registration_waits += 1
                    if registration_waits == 1:
                        control_log("registration.wait", level="DEBUG", callId=call_id, method=method,
                                    connectorId=route.connector_id, connectionId=route.connection_id,
                                    routerId=route.router_id, targetWorkerId=route.worker_id, linkId=route.link_id)
                    if await self.mesh.routes.get(route.connector_id) != route:
                        raise ConnectorNotDispatchedError("connector mesh registration changed") from exc
                    await asyncio.sleep(min(0.1, remaining))
                    continue
                raise ConnectorOfflineError(
                    exc.message or "connector is offline",
                    details={**details, "deliveryState": "outcome_unknown", "controlCallId": call_id},
                ) from exc
            except MeshCallError as exc:
                raise ConnectorRpcError(exc.code, exc.message, details=exc.details) from exc
