"""Lifecycle-owned outbox delivery and reconciliation compensation."""

from __future__ import annotations

import asyncio
import json
import random
import secrets
import time
from typing import Any

from loguru import logger
from redis.exceptions import RedisError


class ChannelReconciler:
    def __init__(
        self, store: Any, channels: Any, coordinator: Any, tokens: Any
    ) -> None:
        self.store, self.channels, self.coordinator, self.tokens = (
            store,
            channels,
            coordinator,
            tokens,
        )
        self.owner = secrets.token_urlsafe(18)
        self.topic = coordinator.key("channel-sync-wake")
        self.tasks: list[asyncio.Task[Any]] = []

    async def start(self) -> None:
        self.tasks = [
            asyncio.create_task(self._deliver()),
            asyncio.create_task(self._compensate()),
        ]
        if self.coordinator.distributed:
            self.tasks.append(asyncio.create_task(self._listen()))

    async def close(self) -> None:
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    async def _deliver(self) -> None:
        idle = 1
        while True:
            try:
                rows = await self.store.claim_channel_notifications(self.owner)
                for row in rows:
                    success = False
                    try:
                        if self.coordinator.distributed:
                            await self.coordinator.client.publish(
                                self.topic,
                                json.dumps(
                                    {
                                        "userId": row["user_id"],
                                        "connectorId": row["connector_id"],
                                    }
                                ),
                            )
                        # Local delivery always complements lossy pub/sub.
                        await self.channels._plan(
                            row["user_id"], connector=row["connector_id"]
                        )
                        success = True
                    except Exception:  # noqa: BLE001 - background failures retain durable work
                        logger.exception(
                            "channel notification delivery failed id={}", row["id"]
                        )
                    finally:
                        await self.store.finish_channel_notification(
                            row["id"], self.owner, success=success
                        )
                idle = 1 if rows else min(idle + 1, 5)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - background failures retain durable work
                logger.exception("channel outbox scan failed")
                idle = 5
            await asyncio.sleep(idle)

    async def _listen(self) -> None:
        while True:
            try:
                async with self.coordinator.client.pubsub() as subscription:
                    await subscription.subscribe(self.topic)
                    async for message in subscription.listen():
                        if message["type"] != "message":
                            continue
                        body = json.loads(message["data"])
                        await self.channels._plan(
                            body["userId"], connector=body["connectorId"]
                        )
            except asyncio.CancelledError:
                raise
            except (RedisError, ValueError, KeyError):
                logger.warning(
                    "channel subscription disconnected; durable compensation remains active"
                )
                await asyncio.sleep(5)
            except Exception:  # noqa: BLE001 - background failures retain durable work
                logger.exception("channel subscription failed")
                await asyncio.sleep(5)

    async def _compensate(self) -> None:
        next_full = 0.0
        cursor = ""
        while True:
            try:
                full = time.monotonic() >= next_full
                devices = await self.store.channel_due_devices(after=cursor, full=full)
                for device in devices:
                    user_id, connector_id = device["user_id"], device["id"]
                    await self.channels._plan(
                        user_id, connector=connector_id, reconnect=full
                    )
                if len(devices) == 100:
                    cursor = devices[-1]["id"]
                    await asyncio.sleep(0)
                    continue
                cursor = ""
                if full:
                    # A successful remote read resolves uncertain rotation; never issue rotate again.
                    for intent in await self.store.pending_rotation_intents():
                        try:
                            await self.tokens.sync(user_id=intent["user_id"])
                            await self.channels.refresh(
                                user_id=intent["user_id"], rewrite="tokens"
                            )
                            await self.store.save_rotation_intent(
                                intent["user_id"],
                                intent["profile_id"],
                                intent["key_id"],
                                "confirmed",
                            )
                        except Exception:  # noqa: BLE001 - background failures retain durable work
                            logger.exception(
                                "channel rotation reconciliation pending user_id={}",
                                intent["user_id"],
                            )
                    await self.store.prune_channel_notifications()
                    logger.info(
                        "channel reconciliation statistics {}",
                        await self.store.channel_statistics(),
                    )
                    next_full = time.monotonic() + random.uniform(48, 72)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - background failures retain durable work
                logger.exception("channel reconciliation compensation failed")
            await asyncio.sleep(5)
