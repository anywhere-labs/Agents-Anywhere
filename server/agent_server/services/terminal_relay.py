"""Attach the existing terminal relay to Connector-owned V2 terminals.

RPC is used only to establish the relay. PTY bytes, resizing and snapshots
travel over the dedicated socket; disconnecting it never closes the PTY.

v3 devices have no relay socket: input, resizing and snapshots are
``Workspace/call`` (``terminal.write``, ``terminal.resize``,
``terminal.snapshot``) and the output is a ``Workspace/terminalOutput`` stream
per terminal WebSocket (``output``), whose items become the same ``replay``,
``output`` and ``exit`` frames the v2 relay sends.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Protocol

from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.infra.terminal_broker import (
    Terminal,
    TerminalBroker,
    TerminalRelayError,
)
from agent_server.services.connector_rpc import ConnectorUpstreamError
from agent_server.services.repository_ports import ConnectorTerminalRepository
from agent_server.services.terminal import terminal_connector_scope_id
from agent_server.services.workspace import request_connector, request_connector_bound


class TerminalOutputPort(Protocol):
    """A v3 device's terminal output (``infra.device_link.DeviceRpcBridge.terminal_output``)."""

    def terminal_output(
        self, device_id: str, terminal_id: str, scope_id: str, from_seq: int = 0
    ) -> AsyncIterator[dict[str, Any]]: ...


# v2 relay requests -> the v2 workspace method a v3 device runs for them.
_MESH_REQUESTS: dict[str, str] = {
    "snapshot": "terminal.snapshot",
    "input": "terminal.write",
    "resize": "terminal.resize",
}


class TerminalRelayService:
    def __init__(
        self,
        store: ConnectorTerminalRepository,
        manager: ConnectorRpcManager,
        broker: TerminalBroker,
        output: TerminalOutputPort | None = None,
    ) -> None:
        self._store = store
        self._manager = manager
        self._broker = broker
        self._output = output

    async def ensure(self, connector_id: str, terminal_id: str) -> Terminal:
        term = await self._broker.get(terminal_id)
        if term is not None:
            self._validate(term, connector_id)
            if await self._broker.has_connector(terminal_id):
                return term
        async with self._broker.session_lock(f"relay:{connector_id}:{terminal_id}"):
            term = await self._broker.get(terminal_id)
            if term is not None:
                self._validate(term, connector_id)
                if await self._broker.has_connector(terminal_id):
                    return term
            else:
                meta = await self._store.get_connector_terminal_root(
                    connector_id=connector_id,
                    terminal_id=terminal_id,
                )
                if meta is None:
                    raise TerminalRelayError("terminal not found", 404)
                term = await self._broker.register(
                    terminal_id=terminal_id,
                    session_id=terminal_connector_scope_id(connector_id),
                    connector_id=connector_id,
                    label="Shell",
                    root=meta["root"],
                    cwd=meta["cwd"],
                    shell="",
                    cols=80,
                    rows=24,
                    purpose="relay",
                    relay_mode="attach",
                )
            try:
                _, connection_id = await request_connector_bound(
                    self._manager,
                    connector_id,
                    "terminal.relay.connect",
                    {
                        "terminalId": term.id,
                        "sessionId": term.session_id,
                        "token": term.relay_token,
                        "mode": "attach",
                    },
                    timeout=15,
                )
                await self._broker.bind_connection(terminal_id, connection_id)
                if await self._broker.wait_connector(terminal_id, timeout=10) is None:
                    raise TerminalRelayError("terminal relay did not connect")
            except ConnectorUpstreamError as exc:
                await self._broker.remove(terminal_id)
                if getattr(exc.__cause__, "code", None) == "terminal_not_found":
                    raise TerminalRelayError("terminal not found", 404) from exc
                raise
            except Exception:
                await self._broker.remove(terminal_id)
                raise
            return term

    async def request(
        self, connector_id: str, terminal_id: str, payload: dict[str, Any], *, mesh: bool = False
    ) -> Any:
        """A relay request (``snapshot``, ``input``, ``resize``). ``mesh``: the connector is a v3 device."""

        if mesh:
            return await self._request_mesh(connector_id, terminal_id, payload)
        await self.ensure(connector_id, terminal_id)
        # Never retry a write: a lost acknowledgement doesn't mean the shell
        # didn't execute it.
        return await self._broker.request_relay(terminal_id, payload)

    async def _request_mesh(self, connector_id: str, terminal_id: str, payload: dict[str, Any]) -> Any:
        kind = payload.get("type")
        method = _MESH_REQUESTS.get(kind) if isinstance(kind, str) else None
        if method is None:
            raise TerminalRelayError(f"unsupported terminal request: {kind}", 422)
        params: dict[str, Any] = {
            "terminalId": terminal_id,
            "sessionId": terminal_connector_scope_id(connector_id),
        }
        if kind == "snapshot":
            params["fromSeq"] = payload.get("fromSeq", 0)
        elif kind == "input":
            params["dataBase64"] = payload.get("data")
        else:
            params["cols"] = payload.get("cols")
            params["rows"] = payload.get("rows")
        try:
            # Like the relay, never retried: a lost answer to a write does not mean it did not run.
            return await request_connector(self._manager, connector_id, method, params, timeout=15)
        except ConnectorUpstreamError as exc:
            if getattr(exc.__cause__, "code", None) == "terminal_not_found":
                raise TerminalRelayError("terminal not found", 404) from exc
            raise

    async def output(self, connector_id: str, terminal_id: str, from_seq: int = 0) -> AsyncIterator[dict[str, Any]]:
        """A v3 device's terminal as the stream WebSocket's frames: ``replay``, then ``output``, then ``exit``.

        Ends after ``exit``. A device that is offline, a lost stream or a missing terminal raise
        ``TerminalRelayError`` (409, 503, 404); the caller reports it and closes the socket.
        """

        if self._output is None:
            raise TerminalRelayError("terminal output is not available on this server", 503)
        scope_id = terminal_connector_scope_id(connector_id)
        try:
            async for item in self._output.terminal_output(connector_id, terminal_id, scope_id, from_seq):
                frame = _client_frame(item)
                if frame is not None:
                    yield frame
        except ConnectorOfflineError as exc:
            raise TerminalRelayError("connector is offline", 409) from exc
        except ConnectorRpcError as exc:
            if exc.code == "terminal_not_found":
                raise TerminalRelayError("terminal not found", 404) from exc
            raise TerminalRelayError(exc.message or exc.code, 502) from exc
        except TimeoutError as exc:
            # The stream broke after it opened (device link lost, Router restart): reconnect to resume.
            raise TerminalRelayError("terminal stream was interrupted", 503) from exc

    @staticmethod
    def _validate(term: Terminal, connector_id: str) -> None:
        if term.connector_id != connector_id or term.relay_mode != "attach":
            raise TerminalRelayError("terminal not found", 404)


def _client_frame(item: dict[str, Any]) -> dict[str, Any] | None:
    """``TerminalOutputItem`` -> the v2 stream WebSocket frame."""

    method = item.get("m")
    params = item.get("p") if isinstance(item.get("p"), dict) else {}
    seq = params.get("seq")
    if method == "terminal.replay":
        data = params.get("dataBase64")
        return {
            "type": "replay",
            "data": data if isinstance(data, str) else "",
            "seq": seq if isinstance(seq, int) else 0,
        }
    if method == "terminal.output":
        data = params.get("dataBase64")
        if not isinstance(data, str) or not isinstance(seq, int):
            return None
        return {"type": "output", "data": data, "seq": seq}
    if method == "terminal.exited":
        exit_code = params.get("exitCode")
        reason = params.get("reason")
        return {
            "type": "exit",
            "exitCode": exit_code if isinstance(exit_code, int) else None,
            "reason": reason if isinstance(reason, str) else "exit",
        }
    return None
