from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from starlette.requests import HTTPConnection

from agent_server.core.announcement import (
    AnnouncementResponse,
    AnnouncementSettings,
    AnnouncementUpdate,
    PublicAnnouncement,
)
from agent_server.deps import require_admin
from agent_server.services.announcements import AnnouncementService

router = APIRouter(tags=["announcements"])
admin_router = APIRouter(
    prefix="/admin/announcement", tags=["admin"], dependencies=[Depends(require_admin)]
)


def get_service(conn: HTTPConnection) -> AnnouncementService:
    return AnnouncementService(conn.app.state.store, conn.app.state.redis)


AnnouncementServiceDep = Annotated[AnnouncementService, Depends(get_service)]


@router.get("/announcement", response_model=AnnouncementResponse)
async def get_public_announcement(
    response: Response, service: AnnouncementServiceDep
) -> AnnouncementResponse:
    response.headers["Cache-Control"] = "no-store"
    settings = await service.get()
    if not settings.enabled or not settings.publishedAt:
        return AnnouncementResponse()
    return AnnouncementResponse(
        announcement=PublicAnnouncement(
            markdown=settings.markdown, publishedAt=settings.publishedAt
        )
    )


@admin_router.get("", response_model=AnnouncementSettings)
async def get_announcement_settings(
    response: Response, service: AnnouncementServiceDep
) -> AnnouncementSettings:
    response.headers["Cache-Control"] = "no-store"
    return await service.get()


@admin_router.put("", response_model=AnnouncementSettings)
async def update_announcement(
    payload: AnnouncementUpdate, service: AnnouncementServiceDep
) -> AnnouncementSettings:
    return await service.update(payload)
