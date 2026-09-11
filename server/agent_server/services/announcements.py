from __future__ import annotations

from datetime import UTC, datetime, timedelta

from agent_server.core.announcement import AnnouncementSettings, AnnouncementUpdate
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.services.repository_ports import InstanceSettingsRepository

ANNOUNCEMENT_SETTING = "public_announcement"


def next_publication_time(previous: str | None) -> str:
    now = datetime.now(UTC)
    if previous:
        now = max(now, datetime.fromisoformat(previous) + timedelta(milliseconds=1))
    return now.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class AnnouncementService:
    def __init__(
        self, store: InstanceSettingsRepository, coordinator: RedisCoordinator
    ) -> None:
        self._store = store
        self._coordinator = coordinator

    async def get(self) -> AnnouncementSettings:
        raw = await self._store.get_setting(ANNOUNCEMENT_SETTING)
        return (
            AnnouncementSettings.model_validate_json(raw)
            if raw
            else AnnouncementSettings()
        )

    async def update(self, payload: AnnouncementUpdate) -> AnnouncementSettings:
        # Serialize the publication timestamp and JSON setting across workers.
        async with self._coordinator.lock("instance-announcement"):
            current = await self.get()
            if (
                current.enabled == payload.enabled
                and current.markdown == payload.markdown
            ):
                return current
            published_at = current.publishedAt
            if payload.enabled:
                published_at = next_publication_time(published_at)
            updated = AnnouncementSettings(
                enabled=payload.enabled,
                markdown=payload.markdown,
                publishedAt=published_at,
            )
            await self._store.set_setting(
                ANNOUNCEMENT_SETTING, updated.model_dump_json()
            )
            return updated
