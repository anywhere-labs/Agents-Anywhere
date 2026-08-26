from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from agent_server.core.models import AndroidUpdateCheckResponse
from agent_server.deps import get_store
from agent_server.infra.repositories.facade import Store


router = APIRouter(prefix="/client-releases", tags=["client-releases"])


@router.get("/android/check", response_model=AndroidUpdateCheckResponse)
async def check_android_update(
    version_code: int = Query(alias="versionCode", ge=1),
    db: Store = Depends(get_store),
) -> AndroidUpdateCheckResponse:
    release = await db.latest_android_app_release()
    if release is None:
        raise HTTPException(status_code=503, detail="Android release metadata is unavailable")

    download_url = (release["download_url"] or "").strip() or None
    latest_version_code = int(release["version_code"])
    return AndroidUpdateCheckResponse(
        updateAvailable=latest_version_code > version_code and download_url is not None,
        latestVersionCode=latest_version_code,
        latestVersionName=str(release["version_name"]),
        downloadUrl=download_url,
        sha256=(release["sha256"] or "").strip() or None,
    )
