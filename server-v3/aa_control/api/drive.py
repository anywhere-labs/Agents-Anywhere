from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from aa_control.api.deps import current_drive_caller, get_drive_service, require_admin_user
from aa_control.core.models import (
    AdminDrivePolicyResponse,
    CompleteDriveUploadRequest,
    CreateDriveUploadRequest,
    CreateDriveUploadResponse,
    DriveDownloadUrlResponse,
    DriveFileView,
    DrivePurpose,
    DriveQuotaView,
    ListDriveFilesResponse,
    OkResponse,
    UpdateDrivePolicyRequest,
    UserView,
)
from aa_control.services.drive_service import DriveCaller, DriveService

router = APIRouter(tags=["drive"])


@router.get("/drive/quota", response_model=DriveQuotaView)
async def get_drive_quota(
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> DriveQuotaView:
    return await drive.get_quota(user_id=caller.user_id, entitlements=caller.entitlements)


@router.post("/drive/uploads", response_model=CreateDriveUploadResponse, status_code=201)
async def create_drive_upload(
    payload: CreateDriveUploadRequest,
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> CreateDriveUploadResponse:
    return await drive.create_upload(caller=caller, req=payload)


@router.post("/drive/files/{file_id}/complete", response_model=DriveFileView)
async def complete_drive_upload(
    file_id: str,
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
    payload: CompleteDriveUploadRequest | None = None,
) -> DriveFileView:
    return await drive.complete_upload(
        caller=caller,
        file_id=file_id,
        req=payload or CompleteDriveUploadRequest(),
    )


@router.get("/drive/files", response_model=ListDriveFilesResponse)
async def list_drive_files(
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
    purpose: Annotated[DrivePurpose | None, Query()] = None,
    vfs_prefix: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ListDriveFilesResponse:
    return await drive.list_files(
        caller=caller,
        purpose=purpose,
        vfs_prefix=vfs_prefix,
        limit=limit,
        offset=offset,
    )


@router.get("/drive/files/{file_id}", response_model=DriveFileView)
async def get_drive_file(
    file_id: str,
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> DriveFileView:
    return await drive.get_file(caller=caller, file_id=file_id)


@router.get("/drive/files/{file_id}/download-url", response_model=DriveDownloadUrlResponse)
async def get_drive_download_url(
    file_id: str,
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> DriveDownloadUrlResponse:
    return await drive.create_download_url(caller=caller, file_id=file_id)


@router.delete("/drive/files/{file_id}", response_model=OkResponse)
async def delete_drive_file(
    file_id: str,
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> OkResponse:
    deleted = await drive.delete_file(caller=caller, file_id=file_id)
    return OkResponse(ok=deleted)


# ---------------------------------------------------------------------------
# Admin per-account drive policy management (quota / max file / TTL)
# ---------------------------------------------------------------------------


@router.get("/admin/drive/policies/{user_id}", response_model=AdminDrivePolicyResponse)
async def get_admin_drive_policy(
    user_id: str,
    _admin: Annotated[UserView, Depends(require_admin_user)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> AdminDrivePolicyResponse:
    return await drive.get_admin_policy(target_user_id=user_id)


@router.put("/admin/drive/policies/{user_id}", response_model=AdminDrivePolicyResponse)
async def update_admin_drive_policy(
    user_id: str,
    payload: UpdateDrivePolicyRequest,
    admin: Annotated[UserView, Depends(require_admin_user)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> AdminDrivePolicyResponse:
    return await drive.update_admin_policy(
        target_user_id=user_id,
        req=payload,
        admin_user_id=admin.id,
    )


@router.delete("/admin/drive/policies/{user_id}", response_model=AdminDrivePolicyResponse)
async def delete_admin_drive_policy(
    user_id: str,
    admin: Annotated[UserView, Depends(require_admin_user)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> AdminDrivePolicyResponse:
    return await drive.delete_admin_policy(target_user_id=user_id, admin_user_id=admin.id)
