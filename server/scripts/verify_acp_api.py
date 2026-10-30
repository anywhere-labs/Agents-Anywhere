"""Exercise production ACP HTTP routes with explicitly controlled service ports."""

from __future__ import annotations

import asyncio

from agent_server.api.runtime_workflows import router as workflow_router
from agent_server.deps import (
    current_user_id,
    get_runtime_workflow_service,
)
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


class ControlledPorts:
    def __init__(self):
        self.calls = []

    async def session_action(self, session_id, action, values, *, user_id):
        self.calls.append((action, values))
        return {"configuration": {"revision": 2, "options": []}, "ok": True}


async def main():
    app = FastAPI()
    app.include_router(workflow_router, prefix="/api/v2")
    ports = ControlledPorts()
    app.dependency_overrides[get_runtime_workflow_service] = lambda: ports
    app.dependency_overrides[current_user_id] = lambda: "controlled-account"
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://controlled"
    ) as client:
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
        "ACP HTTP routes: strict typed configuration and rejected invalid values passed (controlled service ports)"
    )


if __name__ == "__main__":
    asyncio.run(main())
