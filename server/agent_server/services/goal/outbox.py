"""At-least-once delivery of already committed goal projections."""

import asyncio
import json
from uuid import uuid4

from loguru import logger


async def run_goal_outbox(store, broker):
    owner = str(uuid4())
    while True:
        try:
            for event in await store.claim_goal_events(owner):
                try:
                    async with store.session_revision_fence(event["session_id"]):
                        await broker.publish(
                            event["session_id"], json.loads(event["payload"])
                        )
                    await store.finish_goal_event(event["event_id"], owner, True)
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001 - retain outbox work on transport failure
                    logger.exception("goal event delivery deferred")
                    await store.finish_goal_event(event["event_id"], owner, False)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - retain outbox work on transport failure
            logger.exception("goal outbox deferred")
        await asyncio.sleep(1)
