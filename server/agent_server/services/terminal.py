from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import HTTPException
from loguru import logger

from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.runtimes.serializers import serializer_for_runtime
from agent_server.core.models import (
    TerminalCreateRequest,
    TerminalListResponse,
    TerminalPatchRequest,
    TerminalResizeRequest,
    TerminalResponse,
    SessionView,
    TerminalView,
)
from agent_server.services.workspace import (
    local_rpc_session,
    request_connector,
    resolve_workspace_path,
)
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import Terminal, TerminalBroker
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
    return "zsh" if default_count == 0 else f"zsh {default_count + 1}"


def _primary_claude_terminal(terminals: list[Terminal]) -> Terminal | None:
    for term in terminals:
        if term.purpose == "primary_claude":
            return term
    return None


def _open_connector_terminal_ids(result: object) -> set[str]:
    if not isinstance(result, dict):
        return set()
    terminals = result.get("terminals")
    if not isinstance(terminals, list):
        return set()
    ids: set[str] = set()
    for item in terminals:
        if not isinstance(item, dict) or item.get("closed") is True:
            continue
        terminal_id = item.get("terminalId")
        if isinstance(terminal_id, str) and terminal_id:
            ids.add(terminal_id)
    return ids


def _claude_terminal_args(
    *,
    external_session_id: str | None,
    runtime_params: dict[str, object],
) -> list[str]:
    args = ["--resume", external_session_id] if external_session_id else []
    permission_mode = runtime_params.get("permissionMode")
    if isinstance(permission_mode, str) and permission_mode:
        args += ["--permission-mode", permission_mode]
        args += ["--setting-sources", "project,local"]
    model = runtime_params.get("model")
    if isinstance(model, str) and model:
        args += ["--model", model]
    effort = runtime_params.get("effort")
    if isinstance(effort, str) and effort:
        args += ["--effort", effort]
    return args


def _launch_signature(command: str, args: list[str]) -> str:
    return json.dumps([command, args], separators=(",", ":"), ensure_ascii=True)


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
                cwd=cwd,
                shell=payload.shell or "",
                cols=payload.cols,
                rows=payload.rows,
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
                cwd=cwd,
                shell=payload.shell or "",
                cols=payload.cols,
                rows=payload.rows,
                ephemeral_group_id=payload.ephemeralGroupId,
            )
            try:
                result = await request_connector(
                    self._manager,
                    connector_id,
                    "terminal.create",
                    {
                        "terminalId": term.id,
                        "sessionId": scope_id,
                        "root": root,
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

    async def ensure_primary_claude(
        self,
        session_id: str,
        *,
        user_id: str,
    ) -> TerminalResponse:
        session = await local_rpc_session(session_id, user_id, self._store, self._manager)
        if session.runtime != "claude":
            raise TerminalConflictError("terminal primary is only supported for Claude")
        if session.effectiveRunMode != "terminal":
            raise TerminalConflictError("session is not in Claude terminal mode")

        async with self._broker.session_lock(session.id):
            return await self._ensure_primary_claude_locked(session, user_id=user_id)

    async def _ensure_primary_claude_locked(
        self,
        session: SessionView,
        *,
        user_id: str,
    ) -> TerminalResponse:
        runtime_params = await self._claude_runtime_params(session, user_id=user_id)
        args = _claude_terminal_args(
            external_session_id=session.externalSessionId,
            runtime_params=runtime_params,
        )
        launch_signature = _launch_signature("claude", args)

        existing = self._broker.get_for_session(session.id)
        primary = _primary_claude_terminal(existing)
        if primary is not None:
            if primary.launch_signature != launch_signature:
                logger.info(
                    "recreating Claude terminal after launch config changed "
                    "terminal_id={} session_id={}",
                    primary.id,
                    session.id,
                )
                await self._close_connector_terminal(
                    connector_id=session.connectorId,
                    session_id=session.id,
                    terminal_id=primary.id,
                )
                await self._broker.remove(primary.id)
                return await self._create_primary_claude(
                    session,
                    args=args,
                    launch_signature=launch_signature,
                )
            if primary.status == "starting":
                connector_terminal_ids = await self._connector_terminal_ids(
                    session.connectorId,
                    session.id,
                )
                if connector_terminal_ids is not None and primary.id in connector_terminal_ids:
                    return TerminalResponse(
                        terminal=TerminalView(**primary.view()),
                        serverTime=utc_now(),
                    )
                logger.info(
                    "recreating stale starting Claude terminal terminal_id={} session_id={}",
                    primary.id,
                    session.id,
                )
                await self._close_connector_terminal(
                    connector_id=session.connectorId,
                    session_id=session.id,
                    terminal_id=primary.id,
                )
                await self._broker.remove(primary.id)
            if primary.status == "running":
                connector_terminal_ids = await self._connector_terminal_ids(
                    session.connectorId,
                    session.id,
                )
                if connector_terminal_ids is None:
                    return TerminalResponse(
                        terminal=TerminalView(**primary.view()),
                        serverTime=utc_now(),
                    )
                if primary.id in connector_terminal_ids:
                    return TerminalResponse(
                        terminal=TerminalView(**primary.view()),
                        serverTime=utc_now(),
                    )
                logger.info(
                    "recreating stale Claude terminal terminal_id={} session_id={}",
                    primary.id,
                    session.id,
                )
            await self._broker.remove(primary.id)

        return await self._create_primary_claude(
            session,
            args=args,
            launch_signature=launch_signature,
        )

    async def _claude_runtime_params(
        self,
        session: SessionView,
        *,
        user_id: str,
    ) -> dict[str, Any]:
        try:
            effective_settings = await self._store.get_effective_runtime_settings(
                session.id,
                user_id=user_id,
            )
            return serializer_for_runtime("claude").serialize(
                settings=effective_settings,
                cwd=session.cwd,
            )
        except ValueError as exc:
            raise TerminalConflictError(str(exc)) from exc

    async def _connector_terminal_ids(self, connector_id: str, session_id: str) -> set[str] | None:
        try:
            result = await request_connector(
                self._manager,
                connector_id,
                "terminal.list",
                {"sessionId": session_id},
                timeout=2,
            )
        except HTTPException as exc:
            logger.warning(
                "terminal.list rpc failed while checking primary terminal "
                "connector_id={} session_id={} status={} detail={}",
                connector_id,
                session_id,
                exc.status_code,
                exc.detail,
            )
            return None
        return _open_connector_terminal_ids(result)

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

    async def _create_primary_claude(
        self,
        session: SessionView,
        *,
        args: list[str],
        launch_signature: str,
    ) -> TerminalResponse:
        cwd = resolve_workspace_path(session.cwd, ".")
        term = await self._broker.register(
            session_id=session.id,
            connector_id=session.connectorId,
            label="Claude",
            cwd=cwd,
            shell="",
            cols=120,
            rows=36,
            purpose="primary_claude",
            launch_signature=launch_signature,
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
                    "shell": None,
                    "command": "claude",
                    "args": args,
                    "profile": "claude",
                    "cols": term.cols,
                    "rows": term.rows,
                    "env": {},
                },
                timeout=15,
            )
        except asyncio.CancelledError:
            await self._broker.remove(term.id)
            raise
        except Exception:
            await self._broker.remove(term.id)
            raise
        pid = result.get("pid") if isinstance(result, dict) else None
        await self._broker.mark_running(term.id, pid=pid)
        return TerminalResponse(terminal=TerminalView(**term.view()), serverTime=utc_now())

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
        try:
            await request_connector(
                self._manager,
                connector_id,
                "terminal.close",
                {"terminalId": terminal_id, "sessionId": scope_id},
                timeout=10,
            )
        except Exception as exc:
            status_code = getattr(exc, "status_code", "?")
            logger.warning(
                "terminal.close rpc failed terminal_id={} session_id={} status={}",
                terminal_id,
                scope_id,
                status_code,
            )
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
        await request_connector(
            self._manager,
            term.connector_id,
            "terminal.write",
            {"terminalId": terminal_id, "sessionId": scope_id, "dataBase64": data_base64},
            timeout=10,
        )

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
        result = await request_connector(
            self._manager,
            term.connector_id,
            "terminal.resize",
            {"terminalId": terminal_id, "sessionId": scope_id, "cols": cols, "rows": rows},
            timeout=10,
        )
        if isinstance(result, dict) and result.get("closed") is True:
            await self._broker.remove(terminal_id)
            raise TerminalNotFoundError("terminal not found")
        await self._broker.resize(terminal_id, cols, rows)
