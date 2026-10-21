"""Run Connector services on a real local Router for tests."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from meshcall import LocalRouter, Mesh
from pydantic import BaseModel, ConfigDict

from connector.control import ConnectorController
from connector.mesh.control import ControlEvents, ControlService
from connector.mesh.hub import CONTROL_SERVICE
from connector.mesh.logs import LogHub, LogsService


class Params(BaseModel):
    model_config = ConfigDict(extra="allow")


class Anything(BaseModel):
    model_config = ConfigDict(extra="allow")


class ControlCaller:
    def __init__(self, mesh: Mesh) -> None:
        self.mesh = mesh

    async def __call__(self, method: str, **params: Any) -> dict[str, Any]:
        result = await self.mesh.call_unary(CONTROL_SERVICE, method, Params(**params), Anything, timeout=10)
        return result.model_dump()


@asynccontextmanager
async def control_channel(
    controller: ConnectorController,
    events: ControlEvents | None = None,
) -> AsyncIterator[ControlCaller]:
    router = LocalRouter(port=0)
    async with router:
        server = Mesh(router)
        server.mount(ControlService(controller, events or ControlEvents(), asyncio.get_running_loop()), LogsService(LogHub()))
        async with server.serve():
            client = Mesh(router)
            async with client:
                yield ControlCaller(client)
