from __future__ import annotations

import asyncio
import json

from agent_server.infra.timeline_broker import TimelineBroker


def test_dashboard_events_are_debounced() -> None:
    async def exercise() -> None:
        broker = TimelineBroker(dashboard_debounce_seconds=0.01)
        queue = await broker.register_dashboard("user1")

        await broker.publish_dashboard("user1", {"reason": "first", "serverTime": "t1"})
        await broker.publish_dashboard("user1", {"reason": "second", "serverTime": "t2"})

        message = await asyncio.wait_for(queue.get(), timeout=1)
        payload = json.loads(message)
        assert payload["type"] == "dashboard.changed"
        assert payload["serverTime"] == "t2"
        assert queue.empty()

    asyncio.run(exercise())
