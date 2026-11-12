import asyncio
import sys

from connector.runtimes.acp.application.sessions import SessionService
from connector.runtimes.acp.domain.definitions import (
    AcpError,
    AgentProfile,
    LaunchDefinition,
)
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.infrastructure.persistence import Store
from connector.runtimes.acp.infrastructure.projection import Projection


class FailingStartClient(AgentClient):
    async def start(self, launch, root):
        raise RuntimeError("agent exited during startup")


def service(tmp_path, client_factory=AgentClient) -> SessionService:
    return SessionService(
        Store(tmp_path / "state.sqlite"),
        AgentProfile("controlled", "Controlled"),
        LaunchDefinition(sys.executable, ("-c", "pass"), "fixture"),
        client_factory,
        Projection,
        tmp_path,
    )


async def settled(app: SessionService) -> dict:
    async with asyncio.timeout(5):
        while app.preparation_view("prep")["phase"] == "opening":
            await asyncio.sleep(0.01)
    return app.preparation_view("prep")


def prepare(app: SessionService, tmp_path) -> None:
    (tmp_path / "workspace").mkdir()
    app.prepare({"preparationId": "prep", "clientPreparationId": "c", "cwd": str(tmp_path / "workspace")})


def test_local_check_failing_before_launch_is_a_definite_failure_with_its_own_message(tmp_path) -> None:
    async def scenario():
        app = service(tmp_path)

        async def missing_cli():
            raise AcpError("pi_cli_missing", "未找到本机 pi，请指定 CLI 路径或明确选择受管环境。")

        app.launch_for_preparation = missing_cli
        prepare(app, tmp_path)
        view = await settled(app)
        assert view["phase"] == "failed"
        assert view["failure"] == {"code": "pi_cli_missing", "message": "未找到本机 pi，请指定 CLI 路径或明确选择受管环境。"}
        assert view["canCancel"] is False

    asyncio.run(scenario())


def test_failure_after_the_agent_started_keeps_an_unknown_outcome(tmp_path) -> None:
    async def scenario():
        app = service(tmp_path, FailingStartClient)
        prepare(app, tmp_path)
        view = await settled(app)
        assert view["phase"] == "outcome_unknown"
        assert view["failure"]["code"] == "agent_open_failed"

    asyncio.run(scenario())
