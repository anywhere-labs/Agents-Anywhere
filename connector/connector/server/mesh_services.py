"""MeshCall inbound adapters for Server -> Connector control requests.

The services are split by product domain.  They deliberately delegate to the
existing Connector application dispatcher: transport code owns validation,
concurrency and error translation, while runtime/session/local capability
behavior remains in its existing application handlers.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

from meshcall import MeshCallError, mutates, query, service
from pydantic import BaseModel, ConfigDict

from connector.logging import logger
from connector.runtime_protocol import RuntimeProtocolError

Dispatch = Callable[[str, dict[str, Any]], Awaitable[Any]]


class Payload(BaseModel):
    """Protocol payload while domain DTOs remain owned by protocol/handlers."""

    model_config = ConfigDict(extra="allow")


class ConnectorControlExecutor:
    """Run Mesh service calls on the Connector application event loop."""

    CRITICAL_METHODS: ClassVar[frozenset[str]] = frozenset(
        {"interaction.respond", "session.notices"}
    )

    def __init__(self, dispatch: Dispatch) -> None:
        self._dispatch = dispatch
        self._regular = asyncio.Semaphore(8)
        self._critical = asyncio.Semaphore(2)

    async def execute(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        semaphore = (
            self._critical if method in self.CRITICAL_METHODS else self._regular
        )
        async with semaphore:
            result = await self._dispatch(method, params)
        if not isinstance(result, dict):
            raise TypeError(f"Connector method {method} returned a non-object result")
        return result


class _DomainService:
    def __init__(
        self,
        executor: ConnectorControlExecutor,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self._executor = executor
        self._loop = loop

    async def _call(self, method: str, request: Payload) -> Payload:
        try:
            future = asyncio.run_coroutine_threadsafe(
                self._executor.execute(method, request.model_dump()),
                self._loop,
            )
            # The retired WebSocket RPC stopped waiting at its deadline but did
            # not cancel work already admitted by the Connector. Shielding the
            # main-loop future preserves that mutation boundary during transport
            # disconnects and caller timeouts.
            result = await asyncio.shield(asyncio.wrap_future(future))
            return Payload(**result)
        except MeshCallError:
            raise
        except RuntimeProtocolError as exc:
            raise MeshCallError(
                exc.code,
                str(exc),
                retryable=bool(getattr(exc, "retryable", False)),
            ) from exc
        except Exception as exc:
            logger.exception("connector mesh request failed method={}", method)
            raise MeshCallError(
                getattr(exc, "code", None) or "connector_error",
                str(exc) or exc.__class__.__name__,
                retryable=bool(getattr(exc, "retryable", False)),
                details={"errorType": exc.__class__.__name__},
            ) from exc


@service("aa.remote.v1.RuntimeControl", targeted=True)
class RuntimeControlService(_DomainService):
    """Discover, inspect and manage configured Runtime instances."""

    @query(description="Discover Runtime providers and active instances.")
    async def discover(self, request: Payload) -> Payload:
        return await self._call("runtime.discover", request)

    @query(description="Read the configuration schema for a Runtime provider.")
    async def configSchema(self, request: Payload) -> Payload:
        return await self._call("runtime.configSchema", request)

    @query(description="Read one Runtime instance configuration and status.")
    async def config(self, request: Payload) -> Payload:
        return await self._call("runtime.config", request)

    @query(description="Validate a Runtime configuration without starting it.")
    async def validateConfig(self, request: Payload) -> Payload:
        return await self._call("runtime.validateConfig", request)

    @mutates(description="Start or reconcile a configured Runtime instance.")
    async def start(self, request: Payload) -> Payload:
        return await self._call("runtime.start", request)

    @mutates(description="Stop a configured Runtime instance.")
    async def stop(self, request: Payload) -> Payload:
        return await self._call("runtime.stop", request)

    @query(description="Read Runtime-wide capabilities.")
    async def capabilities(self, request: Payload) -> Payload:
        return await self._call("runtime.capabilities", request)

    @query(description="List Runtime-wide commands.")
    async def commands(self, request: Payload) -> Payload:
        return await self._call("runtime.commands", request)

    @query(description="Read the Runtime model catalog.")
    async def modelCatalog(self, request: Payload) -> Payload:
        return await self._call("runtime.modelCatalog", request)

    @query(description="Read the Runtime permission catalog.")
    async def permissionCatalog(self, request: Payload) -> Payload:
        return await self._call("runtime.permissionCatalog", request)


@service("aa.remote.v1.Sessions", targeted=True)
class SessionService(_DomainService):
    """Read and operate Agent sessions owned by a Runtime instance."""

    @query(description="Discover native sessions for a Runtime instance.")
    async def discover(self, request: Payload) -> Payload:
        return await self._call("session.discover", request)

    @mutates(description="Create a session and start its first turn.")
    async def create(self, request: Payload) -> Payload:
        return await self._call("session.create", request)

    @mutates(description="Apply a Server session snapshot to the Runtime adapter.")
    async def sync(self, request: Payload) -> Payload:
        return await self._call("session.sync", request)

    @query(description="Read the current live state of a session.")
    async def state(self, request: Payload) -> Payload:
        return await self._call("session.state", request)

    @query(description="Read effective capabilities for a session.")
    async def capabilities(self, request: Payload) -> Payload:
        return await self._call("session.capabilities", request)

    @query(description="Read current Runtime-owned notices for a session.")
    async def notices(self, request: Payload) -> Payload:
        return await self._call("session.notices", request)

    @mutates(description="Update model, permission or other session selections.")
    async def updateSelections(self, request: Payload) -> Payload:
        return await self._call("session.selections.update", request)

    @query(description="List commands available in a session.")
    async def commands(self, request: Payload) -> Payload:
        return await self._call("session.commands", request)

    @mutates(description="Execute a Runtime command in a session.")
    async def executeCommand(self, request: Payload) -> Payload:
        return await self._call("session.command.execute", request)

    @mutates(description="Send a user message to an existing session.")
    async def sendMessage(self, request: Payload) -> Payload:
        return await self._call("session.send_message", request)

    @mutates(description="Append guidance to a running session turn.")
    async def steer(self, request: Payload) -> Payload:
        return await self._call("session.steer", request)

    @mutates(description="Interrupt the active turn of a session.")
    async def interrupt(self, request: Payload) -> Payload:
        return await self._call("session.interrupt", request)

    @mutates(description="Respond to a Runtime interaction or approval.")
    async def respondInteraction(self, request: Payload) -> Payload:
        return await self._call("interaction.respond", request)


@service("aa.remote.v1.Workspaces", targeted=True)
class WorkspaceService(_DomainService):
    """Reconcile Runtime-owned workspace inventory."""

    @mutates(
        description="Request a fresh Runtime-owned workspace inventory.",
        idempotent=True,
    )
    async def refresh(self, request: Payload) -> Payload:
        return await self._call("workspace.refresh", request)


@service("aa.remote.v1.Files", targeted=True)
class FileService(_DomainService):
    """Control Connector-local file access; file bytes retain their data plane."""

    @mutates(description="Prepare a Connector file for download through the data plane.")
    async def prepareDownload(self, request: Payload) -> Payload:
        return await self._call("fs.prepareDownload", request)

    @mutates(description="Start upload of a previously prepared download.")
    async def uploadPreparedDownload(self, request: Payload) -> Payload:
        return await self._call("fs.uploadPreparedDownload", request)

    @mutates(description="Write a local workspace file.")
    async def writeFile(self, request: Payload) -> Payload:
        return await self._call("fs.writeFile", request)

    @query(description="List a local workspace directory.")
    async def readDir(self, request: Payload) -> Payload:
        return await self._call("fs.readDir", request)

    @query(description="Read a local workspace text file.")
    async def readText(self, request: Payload) -> Payload:
        return await self._call("fs.readText", request)


@service("aa.remote.v1.Shell", targeted=True)
class ShellService(_DomainService):
    """Execute and supervise bounded Connector-local shell tasks."""

    @mutates(description="Execute a bounded local shell command.")
    async def execute(self, request: Payload) -> Payload:
        return await self._call("shell.exec", request)

    @mutates(description="Start a tracked local shell task.")
    async def startTask(self, request: Payload) -> Payload:
        return await self._call("shell.task.start", request)

    @mutates(description="Cancel a tracked local shell task.", idempotent=True)
    async def cancelTask(self, request: Payload) -> Payload:
        return await self._call("shell.task.cancel", request)


@service("aa.remote.v1.Terminals", targeted=True)
class TerminalService(_DomainService):
    """Manage PTYs; the continuous byte stream remains on the relay data plane."""

    @mutates(description="Create a local terminal.")
    async def create(self, request: Payload) -> Payload:
        return await self._call("terminal.create", request)

    @mutates(description="Write input to a local terminal.")
    async def write(self, request: Payload) -> Payload:
        return await self._call("terminal.write", request)

    @mutates(description="Resize a local terminal.")
    async def resize(self, request: Payload) -> Payload:
        return await self._call("terminal.resize", request)

    @mutates(description="Close a local terminal.", idempotent=True)
    async def close(self, request: Payload) -> Payload:
        return await self._call("terminal.close", request)

    @mutates(description="Rename a local terminal.")
    async def rename(self, request: Payload) -> Payload:
        return await self._call("terminal.rename", request)

    @mutates(description="Change terminal persistence across client disconnects.")
    async def setPersistent(self, request: Payload) -> Payload:
        return await self._call("terminal.setPersistent", request)

    @query(description="List local terminals.")
    async def list(self, request: Payload) -> Payload:
        return await self._call("terminal.list", request)

    @mutates(description="Release a terminal client lease.", idempotent=True)
    async def release(self, request: Payload) -> Payload:
        return await self._call("terminal.release", request)

    @query(description="Read a terminal scrollback snapshot.")
    async def snapshot(self, request: Payload) -> Payload:
        return await self._call("terminal.snapshot", request)

    @mutates(description="Connect the terminal relay data plane.")
    async def connectRelay(self, request: Payload) -> Payload:
        return await self._call("terminal.relay.connect", request)


DOMAIN_SERVICE_TYPES: dict[str, type[_DomainService]] = {
    "RuntimeControl": RuntimeControlService,
    "Sessions": SessionService,
    "Workspaces": WorkspaceService,
    "Files": FileService,
    "Shell": ShellService,
    "Terminals": TerminalService,
}


def bind_control_services(
    names: dict[str, str],
    dispatch: Dispatch,
    loop: asyncio.AbstractEventLoop,
) -> tuple[_DomainService, ...]:
    """Bind connection-scoped service names without mutating shared contracts."""

    executor = ConnectorControlExecutor(dispatch)
    bound: list[_DomainService] = []
    for domain, base in DOMAIN_SERVICE_TYPES.items():
        methods = {
            key: value
            for key, value in base.__dict__.items()
            if hasattr(value, "__meshcall_method__")
        }
        methods["__module__"] = __name__
        service_type = service(names[domain], targeted=True)(
            type(f"Bound{domain}Service", (base,), methods)
        )
        bound.append(service_type(executor, loop))
    return tuple(bound)
