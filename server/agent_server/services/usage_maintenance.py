"""Periodic housekeeping for usage statistics.

Every worker runs this loop; the coordinator lock keeps the daily inventory
snapshot idempotent across workers, and the work itself is safe to repeat.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from loguru import logger

from agent_server.core.utc import utc_now
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.services.repository_ports import UsageMaintenanceRepository

DEFAULT_RETENTION_DAYS = 400
DEFAULT_INTERVAL_SECONDS = 15 * 60
LOCK_NAME = "usage-maintenance"


class UsageMaintenanceLoop:
    def __init__(
        self,
        store: UsageMaintenanceRepository,
        coordinator: RedisCoordinator,
        *,
        retention_days: int = DEFAULT_RETENTION_DAYS,
        interval_seconds: float = DEFAULT_INTERVAL_SECONDS,
    ) -> None:
        self._store = store
        self._coordinator = coordinator
        self._retention_days = max(0, retention_days)
        self._interval_seconds = max(1.0, interval_seconds)

    async def run(self) -> None:
        while True:
            try:
                await self.run_once()
            except Exception as exc:  # noqa: BLE001 - keep the loop alive
                logger.warning("usage maintenance deferred error={}", exc)
            await asyncio.sleep(self._interval_seconds)

    async def run_once(self) -> None:
        now = utc_now()
        today = now[:10]
        async with self._coordinator.lock(LOCK_NAME, timeout_seconds=30):
            if not await self._store.usage_inventory_snapshot_exists(today):
                rows = await self._store.usage_inventory_live(now=now)
                await self._store.replace_usage_inventory_snapshot(
                    today, rows, computed_at=utc_now()
                )
                logger.info("usage inventory snapshot recorded date={}", today)
            if self._retention_days > 0:
                cutoff = (
                    datetime.now(UTC) - timedelta(days=self._retention_days)
                ).strftime("%Y-%m-%dT%H")
                deleted = await self._store.delete_usage_events_before(cutoff)
                if deleted:
                    logger.info(
                        "usage events pruned count={} before={}", deleted, cutoff
                    )
