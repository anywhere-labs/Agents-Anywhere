"""Attach the existing terminal relay to Connector-owned V2 terminals.

RPC is used only to establish the relay. PTY bytes, resizing and snapshots
travel over the dedicated socket; disconnecting it never closes the PTY.
"""

from __future__ import annotations

from typing import Any

from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import (
    Terminal,
    TerminalBroker,
    TerminalRelayError,
)
from agent_server.services.connector_rpc import ConnectorUpstreamError
from agent_server.services.terminal import terminal_connector_scope_id
from agent_server.services.workspace import request_connector_bound


class TerminalRelayService:
    def __init__(
        self, store: Store, manager: ConnectorRpcManager, broker: TerminalBroker
    ) -> None:
        self._store = store
        self._manager = manager
        self._broker = broker

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
        self, connector_id: str, terminal_id: str, payload: dict[str, Any]
    ) -> Any:
        await self.ensure(connector_id, terminal_id)
        # Never retry a write: a lost acknowledgement doesn't mean the shell
        # didn't execute it.
        return await self._broker.request_relay(terminal_id, payload)

    @staticmethod
    def _validate(term: Terminal, connector_id: str) -> None:
        if term.connector_id != connector_id or term.relay_mode != "attach":
            raise TerminalRelayError("terminal not found", 404)
