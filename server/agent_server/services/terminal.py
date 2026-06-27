from __future__ import annotations

from typing import Any

from loguru import logger

from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.core.models import (
    TerminalCreateRequest,
    TerminalListResponse,
    TerminalPatchRequest,
    TerminalResizeRequest,
    TerminalResponse,
    TerminalView,
)
from agent_server.services.workspace import (
    local_rpc_session,
    request_connector,
    resolve_workspace_path,
)
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.core.utc import utc_now


class TerminalServiceError(RuntimeError):
    status_code = 500

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class TerminalNotFoundError(TerminalServiceError):
    status_code = 404


class TerminalConflictError(TerminalServiceError):
    status_code = 409


def _label_for(req: TerminalCreateRequest, default_count: int) -> str:
    if req.label and req.label.strip():
        return req.label.strip()
    shell = (req.shell or "").strip().replace("\\", "/").rstrip("/")
    base = shell.rsplit("/", 1)[-1] if shell else "Shell"
    return base if default_count == 0 else f"{base} {default_count + 1}"


def terminal_connector_scope_id(connector_id: str) -> str:
    return f"browse_{connector_id}"


class TerminalService:
    def __init__(
        self,
        store: Store,
        manager: ConnectorRpcManager,
        broker: TerminalBroker,
    ) -> None:
        self._store = store
        self._manager = manager
        self._broker = broker

    async def create(
        self,
        session_id: str,
        payload: TerminalCreateRequest,
        *,
        user_id: str,
    ) -> TerminalResponse:
        session = await local_rpc_session(session_id, user_id, self._store, self._manager)
        async with self._broker.session_lock(session.id):
            await self._cleanup_stale_user_terminals(
                connector_id=session.connectorId,
                session_id=session.id,
                keep_group_id=payload.ephemeralGroupId,
            )
            cwd = resolve_workspace_path(session.cwd, payload.cwd or ".")
            existing = [
                term
                for term in self._broker.get_for_session(session.id)
                if term.purpose == "user" and term.ephemeral_group_id == payload.ephemeralGroupId
            ]
            term = await self._broker.register(
                session_id=session.id,
                connector_id=session.connectorId,
                label=_label_for(payload, len(existing)),
                root=session.cwd,
                cwd=cwd,
                shell=payload.shell or "",
                cols=payload.cols,
                rows=payload.rows,
                command=payload.command,
                args=payload.args,
                profile=payload.profile,
                env=payload.env,
                ephemeral_group_id=payload.ephemeralGroupId,
            )
            try:
                result = await request_connector(
                    self._manager,
                    session.connectorId,
                    "terminal.create",
                    {
                        "terminalId": term.id,
                        "sessionId": session.id,
                        "root": session.cwd,
                        "cwd": cwd,
                        "shell": payload.shell,
                        "command": payload.command,
                        "args": payload.args or [],
                        "profile": payload.profile,
                        "cols": payload.cols,
                        "rows": payload.rows,
                        "env": payload.env or {},
                    },
                    timeout=15,
                )
            except Exception:
                await self._broker.remove(term.id)
                raise
            pid = result.get("pid") if isinstance(result, dict) else None
            await self._broker.mark_running(term.id, pid=pid)
            return TerminalResponse(terminal=TerminalView(**term.view()), serverTime=utc_now())

    async def create_for_connector(
        self,
        connector_id: str,
        root: str,
        payload: TerminalCreateRequest,
    ) -> TerminalResponse:
        scope_id = terminal_connector_scope_id(connector_id)
        async with self._broker.session_lock(scope_id):
            await self._cleanup_stale_user_terminals(
                connector_id=connector_id,
                session_id=scope_id,
                keep_group_id=payload.ephemeralGroupId,
            )
            cwd = resolve_workspace_path(root, payload.cwd or ".")
            existing = [
                term
                for term in self._broker.get_for_session(scope_id)
                if term.purpose == "user" and term.ephemeral_group_id == payload.ephemeralGroupId
            ]
            term = await self._broker.register(
                session_id=scope_id,
                connector_id=connector_id,
                label=_label_for(payload, len(existing)),
                root=root,
                cwd=cwd,
                shell=payload.shell or "",
                cols=payload.cols,
                rows=payload.rows,
                command=payload.command,
                args=payload.args,
                profile=payload.profile,
                env=payload.env,
                ephemeral_group_id=payload.ephemeralGroupId,
            )
            try:
                await request_connector(
                    self._manager,
                    connector_id,
                    "terminal.relay.connect",
                    {
                        "terminalId": term.id,
                        "sessionId": scope_id,
                        "token": term.relay_token,
                    },
                    timeout=15,
                )
                connected = await self._broker.wait_connector(term.id, timeout=10)
                if connected is None:
                    raise TerminalConflictError("terminal relay did not connect")
            except Exception:
                await self._broker.remove(term.id)
                raise
            return TerminalResponse(terminal=TerminalView(**term.view()), serverTime=utc_now())

    async def _close_connector_terminal(
        self,
        *,
        connector_id: str,
        session_id: str,
        terminal_id: str,
    ) -> None:
        try:
            await request_connector(
                self._manager,
                connector_id,
                "terminal.close",
                {"terminalId": terminal_id, "sessionId": session_id},
                timeout=5,
            )
        except Exception as exc:
            status_code = getattr(exc, "status_code", "?")
            logger.warning(
                "terminal.close rpc failed terminal_id={} session_id={} status={}",
                terminal_id,
                session_id,
                status_code,
            )

    async def _cleanup_stale_user_terminals(
        self,
        *,
        connector_id: str,
        session_id: str,
        keep_group_id: str | None,
    ) -> None:
        for term in list(self._broker.get_for_session(session_id)):
            if term.purpose != "user":
                continue
            if keep_group_id is not None and term.ephemeral_group_id == keep_group_id:
                continue
            logger.info(
                "closing stale user terminal terminal_id={} session_id={} keep_group_id={}",
                term.id,
                session_id,
                keep_group_id,
            )
            await self._close_connector_terminal(
                connector_id=connector_id,
                session_id=session_id,
                terminal_id=term.id,
            )
            await self._broker.remove(term.id)

    async def list(self, session_id: str, *, user_id: str) -> TerminalListResponse:
        try:
            session = await self._store.get_session(session_id, user_id=user_id)
        except KeyError:
            raise TerminalNotFoundError("session not found") from None
        items = [
            TerminalView(**t.view())
            for t in self._broker.get_for_session(session.id)
            if t.purpose == "user"
        ]
        return TerminalListResponse(terminals=items, serverTime=utc_now())

    async def list_for_connector(self, connector_id: str) -> TerminalListResponse:
        scope_id = terminal_connector_scope_id(connector_id)
        items = [
            TerminalView(**t.view())
            for t in self._broker.get_for_session(scope_id)
            if t.purpose == "user"
        ]
        return TerminalListResponse(terminals=items, serverTime=utc_now())

    async def rename(
        self,
        session_id: str,
        terminal_id: str,
        payload: TerminalPatchRequest,
        *,
        user_id: str,
    ) -> TerminalResponse:
        try:
            session = await self._store.get_session(session_id, user_id=user_id)
        except KeyError:
            raise TerminalNotFoundError("session not found") from None
        term = self._broker.get(terminal_id)
        if term is None or term.session_id != session.id:
            raise TerminalNotFoundError("terminal not found")
        await self._broker.rename(terminal_id, payload.label.strip())
        return TerminalResponse(terminal=TerminalView(**term.view()), serverTime=utc_now())

    async def rename_for_connector(
        self,
        connector_id: str,
        terminal_id: str,
        payload: TerminalPatchRequest,
    ) -> TerminalResponse:
        scope_id = terminal_connector_scope_id(connector_id)
        term = self._broker.get(terminal_id)
        if term is None or term.session_id != scope_id:
            raise TerminalNotFoundError("terminal not found")
        await self._broker.rename(terminal_id, payload.label.strip())
        return TerminalResponse(terminal=TerminalView(**term.view()), serverTime=utc_now())

    async def close(
        self,
        session_id: str,
        terminal_id: str,
        *,
        user_id: str,
    ) -> TerminalResponse:
        session = await local_rpc_session(session_id, user_id, self._store, self._manager)
        term = self._broker.get(terminal_id)
        if term is None or term.session_id != session.id:
            raise TerminalNotFoundError("terminal not found")
        try:
            await request_connector(
                self._manager,
                session.connectorId,
                "terminal.close",
                {"terminalId": terminal_id, "sessionId": session.id},
                timeout=10,
            )
        except Exception as exc:
            status_code = getattr(exc, "status_code", "?")
            logger.warning(
                "terminal.close rpc failed terminal_id={} session_id={} status={}",
                terminal_id,
                session.id,
                status_code,
            )
        snapshot = TerminalView(**term.view())
        await self._broker.remove(terminal_id)
        return TerminalResponse(terminal=snapshot, serverTime=utc_now())

    async def close_for_connector(self, connector_id: str, terminal_id: str) -> TerminalResponse:
        scope_id = terminal_connector_scope_id(connector_id)
        term = self._broker.get(terminal_id)
        if term is None or term.session_id != scope_id:
            raise TerminalNotFoundError("terminal not found")
        await self._broker.send_to_connector(terminal_id, {"type": "close"})
        snapshot = TerminalView(**term.view())
        await self._broker.remove(terminal_id)
        return TerminalResponse(terminal=snapshot, serverTime=utc_now())

    async def resize(
        self,
        session_id: str,
        terminal_id: str,
        payload: TerminalResizeRequest,
        *,
        user_id: str,
    ) -> TerminalResponse:
        await self.resize_dimensions(
            session_id,
            terminal_id,
            cols=payload.cols,
            rows=payload.rows,
            user_id=user_id,
        )
        term = self._broker.get(terminal_id)
        if term is None:
            raise TerminalNotFoundError("terminal not found")
        return TerminalResponse(terminal=TerminalView(**term.view()), serverTime=utc_now())

    async def resize_for_connector(
        self,
        connector_id: str,
        terminal_id: str,
        payload: TerminalResizeRequest,
    ) -> TerminalResponse:
        await self.resize_dimensions_for_connector(
            connector_id,
            terminal_id,
            cols=payload.cols,
            rows=payload.rows,
        )
        term = self._broker.get(terminal_id)
        if term is None:
            raise TerminalNotFoundError("terminal not found")
        return TerminalResponse(terminal=TerminalView(**term.view()), serverTime=utc_now())

    async def write(
        self,
        session_id: str,
        terminal_id: str,
        *,
        data_base64: str,
        user_id: str,
    ) -> None:
        session = await self._store.get_session(session_id, user_id=user_id)
        term = self._broker.get(terminal_id)
        if term is None or term.session_id != session.id:
            raise TerminalNotFoundError("terminal not found")
        await request_connector(
            self._manager,
            term.connector_id,
            "terminal.write",
            {"terminalId": terminal_id, "sessionId": session.id, "dataBase64": data_base64},
            timeout=10,
        )

    async def write_for_connector(
        self,
        connector_id: str,
        terminal_id: str,
        *,
        data_base64: str,
    ) -> None:
        scope_id = terminal_connector_scope_id(connector_id)
        term = self._broker.get(terminal_id)
        if term is None or term.session_id != scope_id:
            raise TerminalNotFoundError("terminal not found")
        if not await self._broker.send_to_connector(
            terminal_id,
            {"type": "input", "data": data_base64},
        ):
            raise TerminalNotFoundError("terminal not found")

    async def resize_dimensions(
        self,
        session_id: str,
        terminal_id: str,
        *,
        cols: int,
        rows: int,
        user_id: str,
    ) -> None:
        session = await local_rpc_session(session_id, user_id, self._store, self._manager)
        term = self._broker.get(terminal_id)
        if term is None or term.session_id != session.id:
            raise TerminalNotFoundError("terminal not found")
        result = await request_connector(
            self._manager,
            term.connector_id,
            "terminal.resize",
            {"terminalId": terminal_id, "sessionId": session.id, "cols": cols, "rows": rows},
            timeout=10,
        )
        if isinstance(result, dict) and result.get("closed") is True:
            await self._broker.remove(terminal_id)
            raise TerminalNotFoundError("terminal not found")
        await self._broker.resize(terminal_id, cols, rows)

    async def resize_dimensions_for_connector(
        self,
        connector_id: str,
        terminal_id: str,
        *,
        cols: int,
        rows: int,
    ) -> None:
        scope_id = terminal_connector_scope_id(connector_id)
        term = self._broker.get(terminal_id)
        if term is None or term.session_id != scope_id:
            raise TerminalNotFoundError("terminal not found")
        await self._broker.resize(terminal_id, cols, rows)
        if not await self._broker.send_to_connector(
            terminal_id,
            {"type": "resize", "cols": cols, "rows": rows},
        ):
            raise TerminalNotFoundError("terminal not found")
