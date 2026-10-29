"""Exercise production ACP HTTP routes with explicitly controlled service ports."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from agent_server.api.connector_runtimes import router as component_router
from agent_server.api.runtime_workflows import router as workflow_router
from agent_server.deps import (
    current_user_id,
    get_device_runtime_service,
    get_rpc,
    get_runtime_workflow_service,
)
from agent_server.services.device_runtimes import DeviceRuntimeError


class ControlledDenied(DeviceRuntimeError):
    status_code = 403


class ControlledPorts:
    def __init__(self):
        self.calls = []
        self.denied = False
        self.timeout = False

    async def get_runtime(self, connector_id, runtime_id, *, user_id):
        assert user_id == "controlled-account"
        if self.denied:
            raise ControlledDenied("controlled denial")
        return SimpleNamespace(runtimeType="acp")

    async def request(self, connector_id, method, params, **kwargs):
        self.calls.append((method, params))
        if self.timeout:
            raise TimeoutError
        return {"phase": "completed", "operationId": params.get("operationId")}

    async def session_action(self, session_id, action, values, *, user_id):
        self.calls.append((action, values))
        return {"configuration": {"revision": 2, "options": []}, "ok": True}


async def main():
    app = FastAPI()
    app.include_router(component_router, prefix="/api/v2")
    app.include_router(workflow_router, prefix="/api/v2")
    ports = ControlledPorts()
    for dependency in (
        get_device_runtime_service,
        get_rpc,
        get_runtime_workflow_service,
    ):
        app.dependency_overrides[dependency] = lambda: ports
    app.dependency_overrides[current_user_id] = lambda: "controlled-account"
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://controlled"
    ) as client:
        components = "/api/v2/connectors/device/runtimes/agent/components"
        response = await client.get(components)
        assert response.status_code == 200, response.text
        assert ports.calls[-1][1]["runtimeId"] == "agent"
        count = len(ports.calls)
        ports.denied = True
        assert (await client.get(components)).status_code == 403
        assert len(ports.calls) == count
        ports.denied = False
        assert (
            await client.post(components, json={"operation": "activate"})
        ).status_code == 422
        assert len(ports.calls) == count
        operation = {
            "operation": "activate",
            "operationId": "stable-update",
            "releaseId": "a" * 64,
        }
        ports.timeout = True
        response = await client.post(components, json=operation)
        assert (
            response.status_code == 503
            and response.json()["detail"]["queryBeforeRetry"]
        )
        ports.timeout = False
        response = await client.post(
            components,
            json={"operation": "get_operation", "operationId": "stable-update"},
        )
        assert (
            response.status_code == 202
            and response.json()["operationId"] == "stable-update"
        )
        configuration = "/api/v2/runtime-workflows/sessions/session/configuration"
        values = {
            "operationId": "stable-config",
            "expectedRevision": 1,
            "values": {"enabled": False, "selection": ""},
        }
        response = await client.post(configuration, json=values)
        assert response.status_code == 200, response.text
        assert ports.calls[-1][1]["values"] == values["values"]
        count = len(ports.calls)
        values["values"] = {"enabled": 0}
        assert (await client.post(configuration, json=values)).status_code == 422
        assert len(ports.calls) == count
    print(
        "ACP HTTP routes: device authorization, strict typed configuration, stable update identity and unknown-outcome query passed (controlled service ports)"
    )


if __name__ == "__main__":
    asyncio.run(main())
