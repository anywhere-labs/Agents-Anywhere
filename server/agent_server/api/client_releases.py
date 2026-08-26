from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from agent_server.core.models import AppReleasePlatform, AppUpdateCheckResponse
from agent_server.deps import get_store
from agent_server.infra.repositories.facade import Store


router = APIRouter(prefix="/client-releases", tags=["client-releases"])


@router.get("/check", response_model=AppUpdateCheckResponse)
async def check_app_update(
    platform: AppReleasePlatform = Query(),
    version_code: int = Query(alias="versionCode", ge=1),
    db: Store = Depends(get_store),
) -> AppUpdateCheckResponse:
    release = await db.latest_app_release(platform)
    if release is None:
        raise HTTPException(status_code=503, detail=f"{platform} release metadata is unavailable")

    download_url = (release["download_url"] or "").strip() or None
    latest_version_code = int(release["version_code"])
    return AppUpdateCheckResponse(
        platform=platform,
        updateAvailable=latest_version_code > version_code and download_url is not None,
        latestVersionCode=latest_version_code,
        latestVersionName=str(release["version_name"]),
        downloadUrl=download_url,
        sha256=(release["sha256"] or "").strip() or None,
    )
