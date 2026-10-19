from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from typing import Any

from meshcall import DeadlineExceededError, MeshCallError, UnavailableError
from pydantic import BaseModel, ConfigDict

from connector.logging import logger
from connector.mesh.hub import DSH_BRIDGE_SERVICE
from connector.runtimes.dsh.bridge.host import BridgeHost

ExitHandler = Callable[[BaseException | None], Awaitable[None]]

# Call metadata naming the Connector's session namespace; the plugin scopes
# session identities by it, as the 1.0 ``initialize`` handshake did.
NAMESPACE_METADATA = "aa-session-namespace"
CONNECTOR_METADATA = "aa-connector-id"
PROTOCOL_VERSION = "2.0"
# How often the initial call checks whether the plugin registered its Bridge.
DISCOVERY_RETRY_SECONDS = 0.1
# The initial call waits for the plugin only this long; an offline DSH is
# reported as waiting_bridge and the runtime's restart loop owns the polling.
DISCOVERY_BUDGET_SECONDS = 2.0

# MeshCall codes a 1.x caller knew under the plugin's error names.
_PROTOCOL_CODES = {
    "method_not_found": "METHOD_NOT_FOUND",
    "invalid_argument": "INVALID_PARAMS",
    "deadline_exceeded": "REQUEST_TIMEOUT",
}


class Payload(BaseModel):
    model_config = ConfigDict(extra="allow")


class BridgeRpcError(RuntimeError):
    """An answer from the plugin: ``bridge_code`` is its error name (``SESSION_NOT_FOUND`` …)."""

    def __init__(self, code: str, message: str, *, retryable: bool = False, details: Mapping[str, Any] | None = None) -> None:
        super().__init__(message)
        self.bridge_code = code
        self.retryable = retryable
        self.details = dict(details or {})


class BridgeUnavailableError(ConnectionError):
    """No plugin is registered on the Router, or the Router is gone."""


def bridge_error(error: MeshCallError) -> Exception:
    if isinstance(error, UnavailableError):
        return BridgeUnavailableError(error.message)
    if isinstance(error, DeadlineExceededError):
        return BridgeRpcError("REQUEST_TIMEOUT", error.message, retryable=True)
    code = _PROTOCOL_CODES.get(error.code, error.code)
    return BridgeRpcError(code, error.message, retryable=error.retryable, details=error.details)


class BridgeClient:
    """Calls ``aa.dsh.v2.Bridge`` through this process's Router.

    ``connected`` means the plugin answered and no call has since found it
    gone; a call that finds no Bridge instance reports the plugin gone once.
    """

    def __init__(
        self,
        host: BridgeHost,
        *,
        connector_id: str,
        session_namespace: str | None = None,
        client_version: str = PROTOCOL_VERSION,
        startup_timeout: float = 10,
        request_timeout: float = 30,
        exit_handler: ExitHandler | None = None,
    ) -> None:
        self.host = host
        self.connector_id = connector_id
        self.session_namespace = session_namespace or connector_id
        self.client_version = client_version
        self.startup_timeout = startup_timeout
        self.request_timeout = request_timeout
        self.exit_handler = exit_handler
        self.initialize_result: dict[str, Any] | None = None
        self._connected = False
        self._closing = False
        # asyncio keeps only weak references to tasks; retain the exit handler
        # so a disconnect always rebuilds the runtime instead of being garbage
        # collected before it runs.
        self._exit_task: asyncio.Task[None] | None = None

    @property
    def connected(self) -> bool:
        return self._connected and not self._closing

    @property
    def metadata(self) -> dict[str, str]:
        return {NAMESPACE_METADATA: self.session_namespace, CONNECTOR_METADATA: self.connector_id}

    @property
    def mesh(self) -> Any:
        mesh = self.host.hub.mesh
        if mesh is None:
            raise BridgeUnavailableError("The local router is not running")
        return mesh

    async def start(self) -> dict[str, Any]:
        # The Connector publishes its rendezvous before it calls the first Bridge
        # method; the plugin needs a moment to discover the Router and register.
        # Wait for it within startup_timeout instead of reporting the runtime down.
        loop = asyncio.get_running_loop()
        budget = min(self.startup_timeout, DISCOVERY_BUDGET_SECONDS)
        deadline = loop.time() + budget
        timeout = budget
        while True:
            try:
                result = await self.request("initialize", {
                    "protocolVersion": PROTOCOL_VERSION,
                    "runtime": "dsh",
                    "clientInfo": {"name": "agents-anywhere-connector", "version": self.client_version},
                }, timeout=timeout)
                break
            except BridgeUnavailableError:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise
                await asyncio.sleep(min(DISCOVERY_RETRY_SECONDS, remaining))
                timeout = max(0.1, deadline - loop.time())
        identity = result.get("identity") if isinstance(result, dict) else None
        if not isinstance(identity, dict) or identity.get("runtime") != "dsh":
            raise ValueError("DSH bridge returned an invalid identity")
        if not str(identity.get("protocolVersion", "")).startswith("2."):
            raise ValueError("DSH bridge protocol is incompatible")
        self.initialize_result = result
        self._connected = True
        return result

    async def request(self, method: str, params: Mapping[str, Any] | None = None, *, timeout: float | None = None) -> Any:
        try:
            result = await self.mesh.call_unary(
                DSH_BRIDGE_SERVICE, method, Payload(**dict(params or {})), Payload,
                timeout=timeout or self.request_timeout, metadata=self.metadata,
            )
        except MeshCallError as error:
            mapped = bridge_error(error)
            if isinstance(mapped, BridgeUnavailableError):
                self.lost(mapped)
            raise mapped from error
        return result.model_dump()

    async def stream(self, method: str, params: Mapping[str, Any] | None = None) -> AsyncIterator[dict[str, Any]]:
        """Items of a server stream; the stream has no deadline of its own."""
        try:
            async with self.mesh.call_server_stream(
                DSH_BRIDGE_SERVICE, method, Payload(**dict(params or {})), Payload, metadata=self.metadata,
            ) as items:
                async for item in items:
                    yield item.model_dump()
        except MeshCallError as error:
            mapped = bridge_error(error)
            if isinstance(mapped, BridgeUnavailableError):
                self.lost(mapped)
            raise mapped from error

    def lost(self, error: BaseException | None = None) -> None:
        if not self._connected or self._closing:
            return
        self._connected = False
        logger.info("DSH bridge left the local router ({})", error)
        if self.exit_handler is not None:
            self._exit_task = asyncio.get_running_loop().create_task(self.exit_handler(error))

    async def close(self) -> None:
        self._closing = True
