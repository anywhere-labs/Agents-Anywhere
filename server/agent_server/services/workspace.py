from __future__ import annotations

import ntpath
import posixpath
import re
from typing import Any

from fastapi import HTTPException

from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcError, ConnectorRpcManager
from agent_server.core.models import SessionView
from agent_server.infra.repositories.facade import Store


_WINDOWS_DRIVE_RE = re.compile(r"^[A-Za-z]:")


async def local_rpc_session(
    session_id: str,
    user_id: str,
    db: Store,
    manager: ConnectorRpcManager,
) -> SessionView:
    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    if not manager.is_online(session.connectorId):
        raise HTTPException(status_code=409, detail="connector is offline")
    if not session.cwd:
        raise HTTPException(status_code=409, detail="session cwd is required")
    return session


def resolve_workspace_path(root: str | None, raw_path: str) -> str:
    if not root:
        raise HTTPException(status_code=409, detail="session cwd is required")
    if _looks_like_windows_path(root):
        return _resolve_windows_workspace_path(root, raw_path)
    return _resolve_posix_workspace_path(root, raw_path)


def _looks_like_windows_path(path: str) -> bool:
    return (
        bool(_WINDOWS_DRIVE_RE.match(path))
        or path.startswith("\\\\")
        or path.startswith("//")
        or ("\\" in path and not path.startswith("/"))
    )


def _clean_remote_path(path: str) -> str:
    value = path.strip()
    return value or "."


def _resolve_windows_workspace_path(root: str, raw_path: str) -> str:
    root_path = ntpath.normpath(_clean_remote_path(root))
    path = _clean_remote_path(raw_path)
    if path.startswith("~"):
        return path

    drive, _ = ntpath.splitdrive(path)
    if drive and ntpath.isabs(path):
        resolved = path
    elif path.startswith(("\\", "/")):
        root_drive, _ = ntpath.splitdrive(root_path)
        resolved = f"{root_drive}{path}" if root_drive else path
    elif drive:
        resolved = ntpath.join(root_path, path[len(drive) :].lstrip("\\/"))
    else:
        resolved = ntpath.join(root_path, path)
    return ntpath.normpath(resolved)


def _resolve_posix_workspace_path(root: str, raw_path: str) -> str:
    root_path = posixpath.normpath(_clean_remote_path(root))
    path = _clean_remote_path(raw_path)
    if path.startswith("~"):
        return path
    if posixpath.isabs(path):
        return posixpath.normpath(path)
    return posixpath.normpath(posixpath.join(root_path, path))


async def request_connector(
    manager: ConnectorRpcManager,
    connector_id: str,
    method: str,
    params: dict[str, Any],
    *,
    timeout: float,
) -> Any:
    try:
        return await manager.request(connector_id, method, params, timeout=timeout)
    except ConnectorOfflineError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ConnectorRpcError as exc:
        raise HTTPException(status_code=502, detail=exc.message or exc.code) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=f"{method} timed out") from exc
