from __future__ import annotations

import asyncio
import os
from pathlib import Path

from connector.launch import launch_target
from connector.runtimes.dsh.bridge.client import BridgeClient


def test_bridge_client_handshake_notification_and_shutdown(tmp_path: Path) -> None:
    child = tmp_path / "fake-dsh"
    child.write_text(
        """#!/usr/bin/env python3
import json
import sys
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if method == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','method':'runtime.capabilities.update','params':{'runtime':'dsh','revision':'1','capabilities':[]}}), flush=True)
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'identity':{'runtime':'dsh','runtimeVersion':'test','protocolVersion':'1.0'}}}), flush=True)
    elif method == 'ping':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'nonce':request['params'].get('nonce')}}), flush=True)
    elif method == 'shutdown':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'ok':True}}), flush=True)
        break
"""
    )
    os.chmod(child, 0o700)

    async def run() -> None:
        notifications: list[tuple[str, dict[str, object]]] = []
        exits: list[int | None] = []

        async def notification(method: str, params: dict[str, object]) -> None:
            notifications.append((method, params))

        async def exited(code: int | None) -> None:
            exits.append(code)

        client = BridgeClient(
            target=launch_target("test", str(child)),
            profile="aa",
            environment=dict(os.environ),
            cwd=str(tmp_path),
            connector_id="connector-test",
            client_version="test",
            startup_timeout=2,
            request_timeout=2,
            shutdown_timeout=2,
            kill_grace=1,
            notification_handler=notification,
            exit_handler=exited,
        )
        initialized = await client.start()
        assert initialized["identity"]["runtime"] == "dsh"
        assert await client.request("ping", {"nonce": "n1"}) == {"nonce": "n1"}
        await asyncio.sleep(0)
        assert notifications[0][0] == "runtime.capabilities.update"
        await client.close()
        assert exits == []

    asyncio.run(run())


def test_bridge_client_observes_notification_handler_failure(tmp_path: Path) -> None:
    async def run() -> None:
        loop_errors: list[dict[str, object]] = []

        async def notification(_method: str, _params: dict[str, object]) -> None:
            raise ValueError("invalid notification")

        async def exited(_code: int | None) -> None:
            return None

        client = BridgeClient(
            target=launch_target("test", str(tmp_path / "unused-dsh")),
            profile="aa",
            environment=dict(os.environ),
            cwd=str(tmp_path),
            connector_id="connector-test",
            client_version="test",
            startup_timeout=2,
            request_timeout=2,
            shutdown_timeout=2,
            kill_grace=1,
            notification_handler=notification,
            exit_handler=exited,
        )
        loop = asyncio.get_running_loop()
        previous_handler = loop.get_exception_handler()
        loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))
        try:
            client._dispatch_notification("timeline.item.upsert", {})
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        finally:
            loop.set_exception_handler(previous_handler)

        assert client._notification_tasks == set()
        assert loop_errors == []

    asyncio.run(run())
