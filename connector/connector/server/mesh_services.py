"""MeshCall inbound adapters for Server -> Connector control requests.

The services are split by product domain.  They deliberately delegate to the
existing Connector application dispatcher: transport code owns validation,
concurrency and error translation, while runtime/session/local capability
behavior remains in its existing application handlers.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from threading import Event
from typing import Any, ClassVar

from meshcall import MeshCallError, RpcContext, mutates, query, service
from pydantic import BaseModel, ConfigDict

from connector.runtime_protocol import RuntimeProtocolError
from connector.server.control_log import (
    business_fields,
    control_log,
    error_fields,
    result_fields,
)

Dispatch = Callable[[str, dict[str, Any]], Awaitable[Any]]


class Payload(BaseModel):
    """Protocol payload while domain DTOs remain owned by protocol/handlers."""

    model_config = ConfigDict(extra="allow")


class ConnectorControlExecutor:
    """Run Mesh service calls on the Connector application event loop."""

    CRITICAL_METHODS: ClassVar[frozenset[str]] = frozenset(
        {"interaction.respond", "session.notices"}
    )

    def __init__(self, dispatch: Dispatch, *, connector_id: str = "") -> None:
        self.connector_id = connector_id
        self._queued = {"regular": 0, "critical": 0}
        self._active = {"regular": 0, "critical": 0}
        self._dispatch = dispatch
        self._regular = asyncio.Semaphore(8)
        self._critical = asyncio.Semaphore(2)
        self.generation = ""
        self._tasks: set[asyncio.Task] = set()

    def open_session(self, dispatch: Dispatch, generation: str) -> None:
        if self._tasks:
            raise RuntimeError("previous Connector control session is still active")
        self._dispatch = dispatch
        self.generation = generation

    async def close_session(self) -> None:
        self.generation = "closed"
        tasks = tuple(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def execute(
        self, method: str, params: dict[str, Any], generation: str, call_id: str, connection_id: str,
        *, context: dict[str, Any] | None = None, detached: Event | None = None,
    ) -> dict[str, Any]:
        task = asyncio.current_task()
        assert task is not None
        self._tasks.add(task)
        queued_at = time.monotonic()
        started_at = None
        lane = "critical" if method in self.CRITICAL_METHODS else "regular"
        semaphore = self._critical if lane == "critical" else self._regular
        fields = {**business_fields(params), **(context or {}), "callId": call_id, "method": method,
                  "connectorId": self.connector_id, "connectionId": connection_id, "lane": lane}
        self._queued[lane] += 1
        waiting, active = True, False
        phase, outcome = "queued", "cancelled"
        details = {}
        control_log("execution.queued", level="INFO" if semaphore.locked() else "DEBUG", **fields,
                    queueDepth=self._queued[lane], activeCount=self._active[lane])
        try:
            async with semaphore:
                self._queued[lane] -= 1
                waiting = False
                if generation != self.generation:
                    raise MeshCallError("unavailable", "Connector connection was replaced",
                                        details={"source": "connector_executor", "deliveryState": "not_dispatched"})
                self._active[lane] += 1
                active = True
                started_at = time.monotonic()
                phase = "started"
                control_log("execution.started", **fields, queueWaitMs=(started_at - queued_at) * 1000,
                            queueDepth=self._queued[lane], activeCount=self._active[lane])
                result = await self._dispatch(method, params)
            if not isinstance(result, dict):
                raise TypeError(f"Connector method {method} returned a non-object result")
            phase, outcome = "returned", "returned"
            details = result_fields(result)
            return result
        except asyncio.CancelledError:
            details = {"reason": "base_connection_closed" if self.generation == "closed" else "task_cancelled"}
            phase = "cancelled_running" if started_at is not None else "cancelled_queued"
            raise
        except Exception as exc:
            outcome = "not_dispatched" if (getattr(exc, "details", None) or {}).get("deliveryState") == "not_dispatched" else "failed"
            phase = "failed"
            details = error_fields(exc, stack=not isinstance(exc, (RuntimeProtocolError, MeshCallError)))
            raise
        finally:
            if waiting:
                self._queued[lane] -= 1
            if active:
                self._active[lane] -= 1
            self._tasks.discard(task)
            ended_at = time.monotonic()
            level = "INFO" if outcome == "returned" else ("WARNING" if not details.get("errorStack") else "ERROR")
            control_log("execution.finished", level=level, **{**fields, **details}, phase=phase, outcome=outcome,
                        callerDetached=bool(detached and detached.is_set()),
                        deliveryState="not_dispatched" if started_at is None else (
                            "handler_returned" if outcome == "returned" else "execution_started"),
                        queueWaitMs=((started_at or ended_at) - queued_at) * 1000,
                        runMs=(ended_at - started_at) * 1000 if started_at is not None else 0,
                        elapsedMs=(ended_at - queued_at) * 1000,
                        queueDepth=self._queued[lane], activeCount=self._active[lane])


class _DomainService:
    def __init__(
        self,
        executor: ConnectorControlExecutor,
        loop: asyncio.AbstractEventLoop,
        generation: str = "",
    ) -> None:
        self._executor = executor
        self._loop = loop
        self._generation = generation

    async def _call(self, method: str, request: Payload, ctx: RpcContext) -> Payload:
        detached = Event()
        context = {"callId": ctx.metadata.get("aa-control-call-id", ctx.call_id),
                   "meshCallId": ctx.call_id, "connectionId": ctx.metadata.get("aa-connection-id", ""),
                   "connectorId": self._executor.connector_id, "method": method}
        future = None
        try:
            future = asyncio.run_coroutine_threadsafe(
                self._executor.execute(
                    method, request.model_dump(), self._generation,
                    ctx.metadata.get("aa-control-call-id", ctx.call_id),
                    ctx.metadata.get("aa-connection-id", ""), context=context, detached=detached,
                ),
                self._loop,
            )
            # The retired WebSocket RPC stopped waiting at its deadline but did
            # not cancel work already admitted by the Connector. Shielding the
            # main-loop future preserves that mutation boundary during transport
            # disconnects and caller timeouts.
            pending = asyncio.wrap_future(future)
            pending.add_done_callback(lambda done: None if done.cancelled() else done.exception())
            result = await asyncio.shield(pending)
            return Payload(**result)
        except asyncio.CancelledError:
            detached.set()
            control_log("caller.detached", **context, callerDetached=True, reason="transport_wait_cancelled")
            raise
        except MeshCallError as exc:
            if (exc.details or {}).get("source") == "connector_executor":
                raise
            raise MeshCallError(exc.code, exc.message, retryable=exc.retryable,
                                details={**(exc.details or {}), "source": "connector_domain"}) from exc
        except RuntimeProtocolError as exc:
            raise MeshCallError(
                exc.code,
                str(exc),
                retryable=bool(getattr(exc, "retryable", False)),
                details={"source": "connector_domain"},
            ) from exc
        except Exception as exc:
            if future is None:
                control_log("adapter.failed", level="ERROR", **context, **error_fields(exc))
            raise MeshCallError(
                getattr(exc, "code", None) or exc.__class__.__name__,
                str(exc) or exc.__class__.__name__,
                retryable=bool(getattr(exc, "retryable", False)),
                details={"source": "connector_domain", "errorType": exc.__class__.__name__},
            ) from exc


@service("aa.remote.v1.RuntimeControl", targeted=True)
class RuntimeControlService(_DomainService):
    """Discover, inspect and manage configured Runtime instances."""

    @query(description="Discover Runtime providers and active instances.")
    async def discover(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("runtime.discover", request, ctx)

    @query(description="Read the configuration schema for a Runtime provider.")
    async def configSchema(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("runtime.configSchema", request, ctx)

    @query(description="Read one Runtime instance configuration and status.")
    async def config(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("runtime.config", request, ctx)

    @query(description="Validate a Runtime configuration without starting it.")
    async def validateConfig(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("runtime.validateConfig", request, ctx)

    @mutates(description="Start or reconcile a configured Runtime instance.")
    async def start(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("runtime.start", request, ctx)

    @mutates(description="Stop a configured Runtime instance.")
    async def stop(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("runtime.stop", request, ctx)

    @query(description="Read Runtime-wide capabilities.")
    async def capabilities(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("runtime.capabilities", request, ctx)

    @query(description="List Runtime-wide commands.")
    async def commands(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("runtime.commands", request, ctx)

    @query(description="Read the Runtime model catalog.")
    async def modelCatalog(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("runtime.modelCatalog", request, ctx)

    @query(description="Read the Runtime permission catalog.")
    async def permissionCatalog(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("runtime.permissionCatalog", request, ctx)


@service("aa.remote.v1.Sessions", targeted=True)
class SessionService(_DomainService):
    """Read and operate Agent sessions owned by a Runtime instance."""

    @query(description="Discover native sessions for a Runtime instance.")
    async def discover(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("session.discover", request, ctx)

    @mutates(description="Create a session and start its first turn.")
    async def create(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("session.create", request, ctx)

    @mutates(description="Apply a Server session snapshot to the Runtime adapter.")
    async def sync(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("session.sync", request, ctx)

    @query(description="Read the current live state of a session.")
    async def state(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("session.state", request, ctx)

    @query(description="Read effective capabilities for a session.")
    async def capabilities(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("session.capabilities", request, ctx)

    @query(description="Read current Runtime-owned notices for a session.")
    async def notices(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("session.notices", request, ctx)

    @mutates(description="Update model, permission or other session selections.")
    async def updateSelections(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("session.selections.update", request, ctx)

    @query(description="List commands available in a session.")
    async def commands(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("session.commands", request, ctx)

    @mutates(description="Execute a Runtime command in a session.")
    async def executeCommand(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("session.command.execute", request, ctx)

    @mutates(description="Send a user message to an existing session.")
    async def sendMessage(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("session.send_message", request, ctx)

    @mutates(description="Append guidance to a running session turn.")
    async def steer(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("session.steer", request, ctx)

    @mutates(description="Interrupt the active turn of a session.")
    async def interrupt(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("session.interrupt", request, ctx)

    @mutates(description="Respond to a Runtime interaction or approval.")
    async def respondInteraction(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("interaction.respond", request, ctx)


@service("aa.remote.v1.Workspaces", targeted=True)
class WorkspaceService(_DomainService):
    """Reconcile Runtime-owned workspace inventory."""

    @mutates(
        description="Request a fresh Runtime-owned workspace inventory.",
        idempotent=True,
    )
    async def refresh(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("workspace.refresh", request, ctx)


@service("aa.remote.v1.Files", targeted=True)
class FileService(_DomainService):
    """Control Connector-local file access; file bytes retain their data plane."""

    @mutates(description="Prepare a Connector file for download through the data plane.")
    async def prepareDownload(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("fs.prepareDownload", request, ctx)

    @mutates(description="Start upload of a previously prepared download.")
    async def uploadPreparedDownload(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("fs.uploadPreparedDownload", request, ctx)

    @mutates(description="Write a local workspace file.")
    async def writeFile(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("fs.writeFile", request, ctx)

    @query(description="List a local workspace directory.")
    async def readDir(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("fs.readDir", request, ctx)

    @query(description="Read a local workspace text file.")
    async def readText(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("fs.readText", request, ctx)


@service("aa.remote.v1.Shell", targeted=True)
class ShellService(_DomainService):
    """Execute and supervise bounded Connector-local shell tasks."""

    @mutates(description="Execute a bounded local shell command.")
    async def execute(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("shell.exec", request, ctx)

    @mutates(description="Start a tracked local shell task.")
    async def startTask(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("shell.task.start", request, ctx)

    @mutates(description="Cancel a tracked local shell task.", idempotent=True)
    async def cancelTask(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("shell.task.cancel", request, ctx)


@service("aa.remote.v1.Terminals", targeted=True)
class TerminalService(_DomainService):
    """Manage PTYs; the continuous byte stream remains on the relay data plane."""

    @mutates(description="Create a local terminal.")
    async def create(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("terminal.create", request, ctx)

    @mutates(description="Write input to a local terminal.")
    async def write(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("terminal.write", request, ctx)

    @mutates(description="Resize a local terminal.")
    async def resize(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("terminal.resize", request, ctx)

    @mutates(description="Close a local terminal.", idempotent=True)
    async def close(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("terminal.close", request, ctx)

    @mutates(description="Rename a local terminal.")
    async def rename(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("terminal.rename", request, ctx)

    @mutates(description="Change terminal persistence across client disconnects.")
    async def setPersistent(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("terminal.setPersistent", request, ctx)

    @query(description="List local terminals.")
    async def list(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("terminal.list", request, ctx)

    @mutates(description="Release a terminal client lease.", idempotent=True)
    async def release(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("terminal.release", request, ctx)

    @query(description="Read a terminal scrollback snapshot.")
    async def snapshot(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("terminal.snapshot", request, ctx)

    @mutates(description="Connect the terminal relay data plane.")
    async def connectRelay(self, request: Payload, ctx: RpcContext) -> Payload:
        return await self._call("terminal.relay.connect", request, ctx)


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
    *,
    executor: ConnectorControlExecutor | None = None,
) -> tuple[_DomainService, ...]:
    """Bind connection-scoped service names without mutating shared contracts."""

    executor = executor or ConnectorControlExecutor(dispatch)
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
        bound.append(service_type(executor, loop, executor.generation))
    return tuple(bound)
