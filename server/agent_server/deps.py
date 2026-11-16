from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, Header, HTTPException
from starlette.requests import HTTPConnection

from agent_server.core.auth import verify_user_access_claims
from agent_server.core.models import UserView
from agent_server.infra.connector_gateway import ConnectorGateway
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.device_mesh import DeviceMesh
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.session_watch import SessionWatchHub
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.attachments import AttachmentService
from agent_server.services.catalogs import CatalogService
from agent_server.services.connector_files import ConnectorFileService
from agent_server.services.connector_ingest import ConnectorIngestService
from agent_server.services.connector_notifications import ConnectorNotificationService
from agent_server.services.connector_realtime import ConnectorRealtimeService
from agent_server.services.connector_shell import ConnectorShellService
from agent_server.services.device_reads import DeviceReadService
from agent_server.services.device_runtimes import (
    DeviceRuntimeError,
    DeviceRuntimeService,
)
from agent_server.services.event_recovery import EventRecoveryService
from agent_server.services.model_channels import (
    ChannelDriver,
    ChannelWakeIndex,
    ModelChannelService,
)
from agent_server.services.model_config import ModelConfigError, ModelConfigService
from agent_server.services.session_message_queue import MessageQueueService
from agent_server.services.session_run import SessionRunConflictError, SessionRunService
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache
from agent_server.services.terminal import TerminalService
from agent_server.services.terminal_relay import TerminalRelayService
from agent_server.services.timeline_write_buffer import TimelineWriteBuffer
from agent_server.services.tokens_link import TokensLinkError, TokensLinkService
from agent_server.services.usage_events import UsageRecorder


def get_store(conn: HTTPConnection) -> Store:
    return conn.app.state.store


def get_attachment_service(conn: HTTPConnection) -> AttachmentService:
    return conn.app.state.store.attachments


def get_catalog_service(conn: HTTPConnection) -> CatalogService:
    return CatalogService(conn.app.state.store)


def get_event_recovery_service(conn: HTTPConnection) -> EventRecoveryService:
    return EventRecoveryService(
        conn.app.state.store,
        conn.app.state.rpc,
        conn.app.state.timeline_write_buffer,
    )


def get_connector_ingest_service(conn: HTTPConnection) -> ConnectorIngestService:
    realtime = get_connector_realtime_service(conn)
    return ConnectorIngestService(
        conn.app.state.store,
        ConnectorNotificationService(
            conn.app.state.store,
            realtime,
            conn.app.state.timeline_write_buffer,
            usage_recorder=get_usage_recorder(conn),
        ),
        conn.app.state.timeline_broker,
        conn.app.state.device_runtime_service,
        conn.app.state.rpc,
        conn.app.state.session_runtime_state_cache,
        conn.app.state.capability_refresh,
        runtime_event=model_channel_service_for(conn.app.state).runtime_event,
        session_idle=message_queue_wake_for(conn.app.state),
    )


def message_queue_wake_for(state: Any):
    dispatcher = getattr(state, "message_queue_dispatcher", None)
    return dispatcher.wake if dispatcher is not None else None


def get_message_queue_wake(conn: HTTPConnection):
    return message_queue_wake_for(conn.app.state)


def get_usage_recorder(conn: HTTPConnection) -> UsageRecorder:
    return conn.app.state.usage_recorder


def get_connector_realtime_service(conn: HTTPConnection) -> ConnectorRealtimeService:
    return ConnectorRealtimeService(
        conn.app.state.shell_tasks,
        conn.app.state.terminal_broker,
        conn.app.state.terminal_stream_hub,
    )


def get_connector_shell_service(conn: HTTPConnection) -> ConnectorShellService:
    return ConnectorShellService(
        ConnectorGateway(conn.app.state.rpc),
        conn.app.state.shell_tasks,
    )


def get_connector_file_service(conn: HTTPConnection) -> ConnectorFileService:
    return ConnectorFileService(
        ConnectorGateway(conn.app.state.rpc),
        conn.app.state.fs_downloads,
    )


def get_session_run_service(conn: HTTPConnection) -> SessionRunService:
    return session_run_service_for(conn.app.state)


def session_run_service_for(state: Any) -> SessionRunService:
    """Build the run service from app state (requests and background dispatch)."""
    channels = model_channel_service_for(state)

    async def prepare_channel(connector_id: str, runtime_id: str, *, user_id: str) -> str:
        try:
            return await channels.prepare_runtime(connector_id, runtime_id, user_id=user_id)
        except (TokensLinkError, ModelConfigError, DeviceRuntimeError) as exc:
            raise SessionRunConflictError(exc.detail) from exc

    @asynccontextmanager
    async def admit(connector_id: str, runtime_id: str, *, user_id: str | None) -> AsyncIterator[None]:
        try:
            async with channels.admit(connector_id, runtime_id, user_id=user_id):
                yield
        except ModelConfigError as exc:
            raise SessionRunConflictError(exc.detail) from exc

    return SessionRunService(
        state.store,
        state.rpc,
        state.device_runtime_service,
        usage_recorder=state.usage_recorder,
        prepare_model_channel=prepare_channel,
        admit_runtime=admit,
        message_queue=getattr(state, "message_queue_dispatcher", None),
        queue_broker=getattr(state, "timeline_broker", None),
    )


def get_message_queue_service(conn: HTTPConnection) -> MessageQueueService:
    state = conn.app.state
    return MessageQueueService(
        state.store,
        getattr(state, "timeline_broker", None),
        getattr(state, "message_queue_dispatcher", None),
    )


def get_device_runtime_service(conn: HTTPConnection) -> DeviceRuntimeService:
    return conn.app.state.device_runtime_service


def _channel_runtime(state: Any) -> tuple[ChannelWakeIndex, ChannelDriver]:
    """The process-wide wait index and switch tasks, made once per app."""
    wake = getattr(state, "channel_wake", None)
    driver = getattr(state, "channel_driver", None)
    if wake is None or driver is None:
        coordinator = getattr(state, "redis", None)
        wake, driver = ChannelWakeIndex(coordinator), ChannelDriver(coordinator, store=state.store)
        state.channel_wake, state.channel_driver = wake, driver
    return wake, driver


def tokens_link_service_for(state: Any) -> TokensLinkService:
    broker = getattr(state, "timeline_broker", None)
    model_config = ModelConfigService(
        state.store, state.device_runtime_service, broker=broker, prober=getattr(state, "gateway_prober", None)
    )
    tokens = TokensLinkService(
        state.store,
        model_config,
        client_factory=state.tokens_client_factory,
        access_cache=state.tokens_access_cache,
        broker=broker,
    )
    wake, driver = _channel_runtime(state)
    tokens.channels = ModelChannelService(
        state.store, model_config, state.device_runtime_service, wake=wake, driver=driver, broker=broker,
    )
    model_config.set_channel_change_handler(tokens.channels.kick)
    return tokens


def model_channel_service_for(state: Any) -> ModelChannelService:
    channels = tokens_link_service_for(state).channels
    assert channels is not None
    return channels


def get_model_channel_service(conn: HTTPConnection) -> ModelChannelService:
    return model_channel_service_for(conn.app.state)


def get_tokens_link_service(conn: HTTPConnection) -> TokensLinkService:
    # Built per request so it always uses the current runtime service.
    return tokens_link_service_for(conn.app.state)


def get_model_config_service(conn: HTTPConnection) -> ModelConfigService:
    # Through the link service, so applying a Tokens profile can fetch its key.
    return get_tokens_link_service(conn).model_config


def get_terminal_service(conn: HTTPConnection) -> TerminalService:
    return TerminalService(
        conn.app.state.store,
        conn.app.state.rpc,
        conn.app.state.terminal_broker,
    )


def get_terminal_relay_service(conn: HTTPConnection) -> TerminalRelayService:
    return TerminalRelayService(
        conn.app.state.store,
        conn.app.state.rpc,
        conn.app.state.terminal_broker,
    )


def get_rpc(conn: HTTPConnection) -> ConnectorRpcManager:
    return conn.app.state.rpc


def get_device_mesh(conn: HTTPConnection) -> DeviceMesh:
    return conn.app.state.device_mesh


def get_device_reads(conn: HTTPConnection) -> DeviceReadService:
    return conn.app.state.device_reads


def get_session_watch(conn: HTTPConnection) -> SessionWatchHub:
    return conn.app.state.session_watch


def get_terminal_broker(conn: HTTPConnection) -> TerminalBroker:
    return conn.app.state.terminal_broker


def get_fs_downloads(conn: HTTPConnection) -> FsDownloadRelayManager:
    return conn.app.state.fs_downloads


def get_timeline_broker(conn: HTTPConnection) -> TimelineBroker:
    return conn.app.state.timeline_broker


def get_timeline_write_buffer(conn: HTTPConnection) -> TimelineWriteBuffer:
    return conn.app.state.timeline_write_buffer


def get_session_runtime_state_cache(
    conn: HTTPConnection,
) -> SessionRuntimeStateCache:
    return conn.app.state.session_runtime_state_cache


async def authenticate_access_token(app: Any, token: str) -> tuple[str, str | None] | None:
    """``(user_id, family_id)`` for a valid token of an active login (``services.user_tokens``)."""

    tokens = getattr(app.state, "user_tokens", None)
    if tokens is None:
        claims = verify_user_access_claims(token)
        return claims
    return await tokens.authenticate(token)


async def current_user_claims(
    conn: HTTPConnection,
    authorization: str | None = Header(None, alias="Authorization"),
) -> tuple[str, str | None]:
    """``(user_id, family_id)`` of the bearer token; 401 when it is invalid or its login was revoked."""

    prefix = "Bearer "
    if authorization is None or not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="missing user access token")
    claims = await authenticate_access_token(conn.app, authorization[len(prefix) :])
    if claims is None:
        raise HTTPException(status_code=401, detail="invalid user access token")
    return claims


async def current_user_id(
    conn: HTTPConnection,
    authorization: str | None = Header(None, alias="Authorization"),
) -> str:
    """The caller's user id.

    The token's signature is checked, and the account and login (token family)
    must still be active; that status is cached per worker for a few seconds.
    For endpoints that need role, use current_user. Every authenticated call
    also counts as platform presence for usage statistics; the recorder
    throttles that per user so it stays off the hot path.
    """
    user_id, _family = await current_user_claims(conn, authorization)
    recorder = getattr(conn.app.state, "usage_recorder", None)
    if recorder is not None:
        await recorder.touch_user(user_id)
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
    return user


def require_admin(user: UserView = Depends(current_user)) -> UserView:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin role required")
    return user


def get_runtime_workflow_service(conn: HTTPConnection):
    from agent_server.services.runtime_workflows import RuntimeWorkflowService
    return RuntimeWorkflowService(conn.app.state.store, conn.app.state.rpc, conn.app.state.device_runtime_service)
