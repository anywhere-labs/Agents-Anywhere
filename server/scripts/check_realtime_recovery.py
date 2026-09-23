"""Probe isolated Pub/Sub recovery; never disconnect application clients.

Run inside the release image with AGENT_SERVER_REDIS_URL in its environment.
Only ephemeral channels and clients with a fresh random probe name are used.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid

from redis.asyncio import Redis

from agent_server.api.server_push_websocket import run_server_push_until_disconnect
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.timeline_broker import TimelineBroker


class ProbeSocket:
    close_code: int | None = None

    async def receive(self):
        await asyncio.Event().wait()

    async def close(self, *, code: int, reason: str):
        self.close_code = code


async def main() -> None:
    name = f"aa-recovery-probe-{uuid.uuid4().hex}"
    client = Redis.from_url(os.environ["AGENT_SERVER_REDIS_URL"],
                            decode_responses=True, client_name=name)
    broker = TimelineBroker(RedisCoordinator(client=client, prefix=name))
    await broker.start()
    try:
        queue = await broker.register("probe")
        for seq in (1, 2):
            signal = broker.connection_lost
            socket = ProbeSocket()
            async def idle_stream():
                await asyncio.Event().wait()
            socket_task = asyncio.create_task(run_server_push_until_disconnect(
                socket, idle_stream(), recovery_signal=signal))
            clients = [c for c in await client.client_list()
                       if c.get("name") == name and int(c.get("psub", 0)) == 2]
            assert len(clients) == 1
            await client.client_kill_filter(_id=clients[0]["id"])
            await asyncio.wait_for(signal.wait(), 10)
            await asyncio.wait_for(socket_task, 2)
            assert socket.close_code == 1012
            async with asyncio.timeout(20):
                while not broker.healthy:
                    await asyncio.sleep(.05)
            assert broker.connection_lost is not signal
            await broker.publish("probe", {"sessionId": "probe", "nextSeq": seq})
            message = await asyncio.wait_for(queue.get(), 3)
            assert json.loads(message)["nextSeq"] == seq
        await broker.publish("probe", {"sessionId": "probe", "nextSeq": 3,
                                       "items": [{"text": "中" * 400_000}]})
        message = await asyncio.wait_for(queue.get(), 3)
        assert len(message) < 100
        assert (await message.prepared_events())[0].event_type == "session.refetch_required"
        print("PASS: two real Redis disconnects recovered; sockets closed 1012; subsequent delivery and oversized-message recovery verified")
    finally:
        await broker.close()
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
