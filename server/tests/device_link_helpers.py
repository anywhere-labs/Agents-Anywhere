"""Shared helpers for v3 device tests: the real Server app, a user with a device, outbox payloads."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from mesh_fixtures import RouterProcess

from agent_server.core.auth import create_user_access_token


@asynccontextmanager
async def server(router: RouterProcess, monkeypatch) -> AsyncIterator[tuple[Any, httpx.AsyncClient]]:
    monkeypatch.setenv("AGENT_SERVER_MESH_ROUTER_URL", router.url)
    monkeypatch.setenv("AGENT_SERVER_MESH_PASSWORD", router.password)
    monkeypatch.setenv("AGENT_SERVER_MESH_PUBLIC_URL", router.url)
    from agent_server.app import create_app

    app = create_app()
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://server") as client,
    ):
        yield app, client


async def user_and_device(app: Any, client: httpx.AsyncClient) -> tuple[dict[str, str], str, str]:
    user = await app.state.store.create_user(user_id="user_v3", password="password-v3")
    headers = {"Authorization": f"Bearer {create_user_access_token(user.userId)}"}
    created = await client.post("/api/v2/connectors", headers=headers, json={"name": "laptop"})
    created.raise_for_status()
    body = created.json()
    project = await client.post(
        "/api/v2/projects",
        headers=headers,
        json={"connectorId": body["connector"]["id"], "name": "repo", "workspacePath": "/repo"},
    )
    project.raise_for_status()
    return headers, body["connector"]["id"], body["connectorToken"]


def summary(session_id: str, head: int, *, status: str = "idle", title: str = "Fix the build") -> dict[str, Any]:
    return {
        "summary": {
            "sessionId": session_id,
            "runtimeId": "codex",
            "runtimeType": "codex",
            "externalSessionId": f"thr_{session_id}",
            "status": status,
            "sortAt": "2026-11-16T10:00:00Z",
            "lastActivityAt": "2026-11-16T10:00:00Z",
            "latestTurnEndSeq": head,
            "headSeq": head,
            "resetSeq": 0,
            "planState": "none",
            "goalState": "active",
            "displayDevice": {"mode": "plain", "payload": {"title": title, "cwd": "/repo"}},
        }
    }


def timeline_item(session_id: str, order: int, text: str) -> dict[str, Any]:
    return {
        "id": f"tl_{order}",
        "sessionId": session_id,
        "type": "message",
        "role": "assistant" if order % 2 else "user",
        "status": "done",
        "content": {"text": text, "format": "markdown"},
        "source": {"runtime": "codex", "sessionId": f"thr_{session_id}", "itemId": f"item_{order}"},
        "orderSeq": order,
        "revision": 1,
        "contentHash": f"sha256:{order}",
        "createdAt": "2026-11-16T10:00:00Z",
        "updatedAt": "2026-11-16T10:00:00Z",
    }


async def eventually(check, timeout: float = 10.0) -> Any:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        value = await check()
        if value:
            return value
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.05)


async def acked(device: Any, oid: int) -> bool:
    return device.state.acked_oid >= oid


async def offline(presence: Any, device_id: str) -> bool:
    return not await presence.is_online(device_id)
