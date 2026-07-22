from __future__ import annotations

from fastapi import Depends, Header, HTTPException
from starlette.requests import HTTPConnection

from agent_server.core.auth import verify_user_access_token
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.core.models import UserView
from agent_server.services.approvals import ApprovalService
from agent_server.services.attachments import AttachmentService
from agent_server.services.connector_ingest import ConnectorIngestService
from agent_server.services.device_runtimes import DeviceRuntimeService
from agent_server.services.session_run import SessionRunService
from agent_server.services.terminal import TerminalService
from agent_server.services.shell_tasks import ShellTaskManager
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker


def get_store(conn: HTTPConnection) -> Store:
    return conn.app.state.store


def get_attachment_service(conn: HTTPConnection) -> AttachmentService:
    return conn.app.state.store.attachments


def get_approval_service(conn: HTTPConnection) -> ApprovalService:
    return ApprovalService(conn.app.state.store, conn.app.state.rpc)


def get_connector_ingest_service(conn: HTTPConnection) -> ConnectorIngestService:
    return ConnectorIngestService(
        conn.app.state.store,
        conn.app.state.shell_tasks,
        conn.app.state.terminal_broker,
        conn.app.state.terminal_stream_hub,
        conn.app.state.timeline_broker,
        conn.app.state.device_runtime_service,
    )


def get_session_run_service(conn: HTTPConnection) -> SessionRunService:
    return SessionRunService(conn.app.state.store, conn.app.state.rpc)


def get_device_runtime_service(conn: HTTPConnection) -> DeviceRuntimeService:
    return conn.app.state.device_runtime_service


def get_terminal_service(conn: HTTPConnection) -> TerminalService:
    return TerminalService(
        conn.app.state.store,
        conn.app.state.rpc,
        conn.app.state.terminal_broker,
    )


def get_rpc(conn: HTTPConnection) -> ConnectorRpcManager:
    return conn.app.state.rpc


def get_shell_tasks(conn: HTTPConnection) -> ShellTaskManager:
    return conn.app.state.shell_tasks


def get_fs_downloads(conn: HTTPConnection) -> FsDownloadRelayManager:
    return conn.app.state.fs_downloads


def get_timeline_broker(conn: HTTPConnection) -> TimelineBroker:
    return conn.app.state.timeline_broker


def current_user_id(authorization: str | None = Header(None, alias="Authorization")) -> str:
    """Lightweight: returns user id from the bearer token without DB lookup.

    Use this for endpoints that only need to know who the caller is. For
    endpoints that need role / disabled, use current_user instead.
    """
    prefix = "Bearer "
    if authorization is None or not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="missing user access token")
    user_id = verify_user_access_token(authorization[len(prefix) :])
    if user_id is None:
        raise HTTPException(status_code=401, detail="invalid user access token")
    return user_id


async def current_user(
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> UserView:
    """Load the full user record. Rejects accounts that were disabled or deleted
    after the token was issued.
    """
    try:
        user = await db.get_user(user_id)
    except KeyError:
        raise HTTPException(status_code=401, detail="user no longer exists") from None
    if user.disabled:
        raise HTTPException(status_code=403, detail="account disabled")
    await db.record_platform_activity(user.userId)
    return user


def require_admin(user: UserView = Depends(current_user)) -> UserView:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin role required")
    return user
