"""``aa.local.v2.Control``: the Connector process's control surface on its Router.

It replaces the stdio JSON-RPC channel of ``anywhere-cli rpc``. The process
that launched the Connector (Desktop or the DSH plugin) calls it with the
``host`` key it read from the ready line.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Literal, TypeVar

from meshcall import (
    InvalidArgumentError,
    MeshCallError,
    mutates,
    query,
    service,
    stream,
)
from pydantic import BaseModel

from connector.control import ConnectorBusyError, ConnectorController
from connector.mesh.events import EventHub, Sequenced, stream_items
from connector.mesh.hub import CONTROL_SERVICE, run_on_loop

T = TypeVar("T")

# Application error for failures the caller should see verbatim (a missing
# config, an unreachable server), as the stdio channel's -32000 did.
CONNECTOR_ERROR = "connector_error"


class ConnectorState(BaseModel):
    status: Literal["running", "expired credential", "error", "stopped"]
    running: bool
    pairing: bool
    authFailed: bool
    lastError: str | None = None
    configPath: str
    runtimePath: str
    hasConfig: bool


class ConnectorPaths(BaseModel):
    configPath: str
    configDir: str
    runtimePath: str


class ConnectorSettings(BaseModel):
    serverUrl: str = ""
    connectorId: str = ""
    connectorToken: str = ""
    heartbeatSeconds: float = 20
    reconnectSeconds: float = 3
    syncExistingOnConnect: bool = True
    syncIntervalSeconds: float = 30
    statePath: str | None = None


class PairingStatus(BaseModel):
    status: Literal["starting", "waiting", "claimed", "expired", "consumed", "cancelled", "error"]
    serverUrl: str | None = None
    pairingId: str | None = None
    code: str | None = None
    config: ConnectorSettings | None = None
    error: str | None = None


class ControlEvent(BaseModel):
    """One change, in order: ``seq`` grows by one per event of this process."""

    seq: int
    kind: Literal["state", "pairing"]
    state: ConnectorState | None = None
    pairing: PairingStatus | None = None


Payload = ConnectorState | PairingStatus


class ControlEvents:
    """Turns controller notifications into ordered, replayable events."""

    def __init__(self) -> None:
        # State and pairing only: the newest of each kind is what a late subscriber needs.
        self.hub: EventHub[tuple[str, Payload]] = EventHub(
            history=1000, capacity=64, coalescing=frozenset({"state", "pairing"}),
        )

    async def notify(self, method_name: str, params: Any) -> None:
        self.publish(method_name, params)

    def publish(self, method_name: str, params: Any) -> None:
        kind = method_name.removeprefix("connector/")
        if kind == "state":
            self.hub.publish("state", ("state", ConnectorState.model_validate(params)))
        elif kind == "pairing":
            self.hub.publish("pairing", ("pairing", PairingStatus.model_validate(params)))


def _settings(config: ConnectorSettings | None) -> dict[str, Any] | None:
    return config.model_dump() if config is not None else None


@service(CONTROL_SERVICE, description="Configure, start and stop this Connector, and follow its state.")
class ControlService:
    # Control commands are never implicitly replayed: even a repeated stop or
    # config save could undo a newer user command after a connection failure.
    def __init__(
        self,
        controller: ConnectorController,
        events: ControlEvents,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self._controller = controller
        self._events = events
        self._loop = loop

    async def _run(self, work: Callable[[], Awaitable[T] | T]) -> T:
        async def call() -> T:
            try:
                result = work()
                return await result if isinstance(result, Awaitable) else result
            except MeshCallError:
                raise
            except ConnectorBusyError as exc:
                raise MeshCallError("connector_busy", str(exc), retryable=False) from exc
            except ValueError as exc:
                raise InvalidArgumentError(str(exc)) from exc
            except Exception as exc:
                raise MeshCallError(CONNECTOR_ERROR, str(exc) or exc.__class__.__name__) from exc

        return await run_on_loop(self._loop, call())

    @query
    async def getState(self) -> ConnectorState:
        """The runtime's status and the last error it reported."""
        return ConnectorState.model_validate(await self._run(self._controller.get_state))

    @query
    async def getPaths(self) -> ConnectorPaths:
        """Where this Connector keeps its configuration and the machine runtime record."""
        return ConnectorPaths.model_validate(await self._run(self._controller.get_paths))

    @mutates
    async def acquireOwnership(self) -> ConnectorState:
        """Reserve the machine for this Connector; fails with connector_already_running."""
        return ConnectorState.model_validate(await self._run(self._controller.acquire_ownership))

    @query
    async def getConfig(self) -> ConnectorSettings:
        """The saved configuration, or the defaults when none is saved."""
        return ConnectorSettings.model_validate(await self._run(self._controller.get_config))

    @mutates
    async def saveConfig(self, config: ConnectorSettings) -> ConnectorSettings:
        """Validate and save the configuration; claims the machine first."""
        payload = config.model_dump()
        return ConnectorSettings.model_validate(await self._run(lambda: self._controller.save_config(payload)))

    @mutates
    async def start(self, config: ConnectorSettings | None = None) -> ConnectorState:
        """Start the runtime with the given or the saved configuration."""
        payload = _settings(config)
        return ConnectorState.model_validate(await self._run(lambda: self._controller.start(payload)))

    @mutates
    async def stop(self) -> ConnectorState:
        """Stop the runtime; the machine stays reserved for this process."""
        return ConnectorState.model_validate(await self._run(self._controller.stop))

    @mutates
    async def restart(self, config: ConnectorSettings | None = None) -> ConnectorState:
        """Stop, then start with the given or the saved configuration."""
        payload = _settings(config)
        return ConnectorState.model_validate(await self._run(lambda: self._controller.restart(payload)))

    # Repeating this command replaces the pairing, so it must not be retried.
    @mutates
    async def startPairing(
        self,
        server: str | None = None,
        resolveTimeout: float = 10,
        timeout: float = 600,
        pollInterval: float = 2,
    ) -> PairingStatus:
        """Start a pairing against server; progress arrives as pairing events."""
        params = {
            "server": server,
            "resolveTimeout": resolveTimeout,
            "timeout": timeout,
            "pollInterval": pollInterval,
        }
        return PairingStatus.model_validate(await self._run(lambda: self._controller.start_pairing(params)))

    @mutates
    async def cancelPairing(self) -> PairingStatus:
        """Cancel the pairing in progress, if any."""
        return PairingStatus.model_validate(await self._run(self._controller.cancel_pairing))

    @stream
    async def events(self, since: int | None = None) -> AsyncIterator[ControlEvent]:
        """State and pairing events after since; read getState for the current state."""
        subscription = self._events.hub.subscribe(since)
        async for event in stream_items(subscription):
            kind, payload = event.item
            yield _event(event, kind, payload)


def _event(event: Sequenced[tuple[str, Payload]], kind: str, payload: Payload) -> ControlEvent:
    if kind == "state":
        return ControlEvent(seq=event.seq, kind="state", state=payload if isinstance(payload, ConnectorState) else None)
    return ControlEvent(seq=event.seq, kind="pairing", pairing=payload if isinstance(payload, PairingStatus) else None)
