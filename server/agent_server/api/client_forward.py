"""Thin FastAPI side of ``services.client_forward``: one call per forwarded route handler.

Every device-served route keeps its handler, request and response models (OpenAPI and 422 do not change). The
handler first asks ``forward_session`` / ``forward_connector``: when ``ClientCallSwitch`` names the route and the
session's device speaks device-meshcall, the request goes to the device with ``Client/call`` and its answer is
returned; otherwise they return None and the handler runs its existing path.

The Server keeps what only it can do: ownership (a session or device the caller does not own is left to the
handler, which answers 404), v2 devices (D4, the handler's own path), admission, usage, directory broadcasts and
the facts it owns (``ClientServerFacts``).
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from agent_server.core.api_namespace import API_V2_PREFIX
from agent_server.core.client_routes import MAX_REQUEST_BODY_BYTES
from agent_server.core.device_meshcall import (
    AttachmentRef,
    ClientCaller,
    ClientServerFacts,
)
from agent_server.core.models import SessionView
from agent_server.services.client_forward import (
    ClientAnswer,
    ClientForwarder,
    ClientForwardError,
)

#: ``body`` default of ``forward``: forward the JSON body the client sent.
RAW_BODY: Any = object()


def forwarder_of(conn: Request) -> ClientForwarder | None:
    return getattr(conn.app.state, "client_forwarder", None)


def forwarding(conn: Request, route_id: str) -> bool:
    """Whether ``route_id`` goes through ``Client/call`` (cheap: no I/O)."""

    forwarder = forwarder_of(conn)
    return forwarder is not None and forwarder.enabled(route_id)


def caller_of(conn: Request, user_id: str) -> ClientCaller:
    headers = conn.headers
    return ClientCaller(
        userId=user_id,
        clientId=headers.get("x-client-id") or None,
        platform=headers.get("x-client-platform") or headers.get("x-device-os") or None,
    )


def client_path(conn: Request) -> str:
    """The canonical ``/api/v2/...`` path the client called, without the query string."""

    path = conn.url.path
    return path if path.startswith(f"{API_V2_PREFIX}/") else f"{API_V2_PREFIX}{path}"


async def raw_body(conn: Request) -> Any:
    """The JSON body the client sent (None without one); 413 before parsing a body over the limit."""

    data = await conn.body()
    if len(data) > MAX_REQUEST_BODY_BYTES:
        raise HTTPException(
            413,
            {"code": "request_too_large", "message": f"the request body is larger than {MAX_REQUEST_BODY_BYTES} bytes"},
        )
    if not data:
        return None
    return json.loads(data)


def http_error(exc: ClientForwardError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail())


def to_response(answer: ClientAnswer, *, headers: dict[str, str] | None = None) -> Response:
    if "json" in answer.content_type:
        content = answer.model.model_dump(mode="json") if answer.model is not None else answer.body
        return JSONResponse(content=content, status_code=answer.status, headers=headers)
    content = answer.body if isinstance(answer.body, (str, bytes)) else json.dumps(answer.body)
    return Response(content=content, status_code=answer.status, media_type=answer.content_type, headers=headers)


async def call(
    conn: Request,
    route_id: str,
    *,
    user_id: str,
    device_id: str,
    session_id: str | None = None,
    body: Any = RAW_BODY,
    server: ClientServerFacts | None = None,
    response_model: type[BaseModel] | None = None,
    offline: Callable[[], Awaitable[Any]] | None = None,
    decorate: Callable[[Any], Awaitable[Any]] | None = None,
    path: str | None = None,
    query: dict[str, str] | None = None,
) -> ClientAnswer:
    """``ClientForwarder.call`` for this request; ``ClientForwardError`` becomes the HTTP error.

    ``decorate``: what the Server overlays on a successful answer before ``response_model`` checks it.
    """

    forwarder = forwarder_of(conn)
    assert forwarder is not None
    if body is RAW_BODY:
        body = await raw_body(conn)
    try:
        answer = await forwarder.call(
            route_id,
            user_id=user_id,
            device_id=device_id,
            path=path or client_path(conn),
            query=dict(conn.query_params) if query is None else query,
            caller=caller_of(conn, user_id),
            body=body,
            server=server,
            response_model=None if decorate is not None else response_model,
            offline=offline,
            session_id=session_id,
        )
        if decorate is not None and answer.ok and not answer.offline:
            answer.body = await decorate(answer.body)
            if response_model is not None:
                forwarder.check(route_id, answer, response_model)
    except ClientForwardError as exc:
        raise http_error(exc) from exc
    return answer


async def owned_session(conn: Request, route_id: str, *, user_id: str, session_id: str) -> SessionView | None:
    """The caller's session when ``route_id`` is forwarded and its device speaks device-meshcall, else None."""

    if not forwarding(conn, route_id):
        return None
    try:
        session = await conn.app.state.store.get_session(session_id, user_id=user_id)
    except KeyError:
        return None
    if not await conn.app.state.device_reads.is_v3_device(session.connectorId):
        return None
    return session


async def owned_device(conn: Request, route_id: str, *, user_id: str, connector_id: str) -> bool:
    """Whether ``route_id`` is forwarded to the caller's v3 device ``connector_id``."""

    if not forwarding(conn, route_id):
        return False
    try:
        connector = await conn.app.state.store.get_connector(connector_id)
    except KeyError:
        return False
    if connector.userId != user_id:
        return False
    return await conn.app.state.device_reads.is_v3_device(connector_id)


async def forward_session(
    conn: Request,
    route_id: str,
    *,
    user_id: str,
    session_id: str,
    response_model: type[BaseModel] | None = None,
    offline: Callable[[SessionView], Awaitable[Any]] | None = None,
    server: Callable[[SessionView], Awaitable[ClientServerFacts | None]] | None = None,
    headers: dict[str, str] | None = None,
) -> Response | None:
    """Forward a route under ``/sessions/{session_id}``; None when it takes its existing path."""

    session = await owned_session(conn, route_id, user_id=user_id, session_id=session_id)
    if session is None:
        return None
    answer = await call(
        conn,
        route_id,
        user_id=user_id,
        device_id=session.connectorId,
        session_id=session.id,
        server=await server(session) if server is not None else None,
        response_model=response_model,
        offline=(lambda: offline(session)) if offline is not None else None,
    )
    return to_response(answer, headers=headers)


async def forward_connector(
    conn: Request,
    route_id: str,
    *,
    user_id: str,
    connector_id: str,
    response_model: type[BaseModel] | None = None,
    body: Any = RAW_BODY,
    path: str | None = None,
    query: dict[str, str] | None = None,
    server: ClientServerFacts | None = None,
) -> Response | None:
    """Forward a route under ``/connectors/{connector_id}``; None when it takes its existing path.

    ``body``, ``path`` and ``query`` replace the request's own (a preview read forwarded as the device's route).
    """

    if not await owned_device(conn, route_id, user_id=user_id, connector_id=connector_id):
        return None
    answer = await call(
        conn,
        route_id,
        user_id=user_id,
        device_id=connector_id,
        body=body,
        response_model=response_model,
        path=path,
        query=query,
        server=server,
    )
    return to_response(answer)


async def attachment_facts(
    conn: Request, *, user_id: str, session: SessionView, body: Any, field: str = "attachments"
) -> list[AttachmentRef] | None:
    """The Server's records of the attachments the body references (``{"fileId"}`` items under ``field``)."""

    items = body.get(field) if isinstance(body, dict) else None
    if not isinstance(items, list) or not items:
        return None
    refs: list[AttachmentRef] = []
    for item in items:
        file_id = item.get("fileId") if isinstance(item, dict) else None
        if not isinstance(file_id, str) or not file_id:
            continue
        try:
            record = await conn.app.state.store.read_uploaded_file(
                session_id=session.id, file_id=file_id, user_id=user_id
            )
        except KeyError:
            raise HTTPException(404, f"attachment not found: {file_id}") from None
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        refs.append(
            AttachmentRef(
                fileId=str(record.get("fileId") or file_id),
                name=str(record.get("name") or file_id),
                mediaType=str(record.get("mediaType") or "application/octet-stream"),
                size=int(record.get("size") or 0),
                sha256=record.get("sha256"),
            )
        )
    return refs or None
