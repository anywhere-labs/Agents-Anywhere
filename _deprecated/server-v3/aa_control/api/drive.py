from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from aa_control.api.deps import current_drive_caller, get_drive_service, require_admin_user
from aa_control.core.models import (
    AdminDrivePolicyResponse,
    CompleteDriveUploadRequest,
    CreateDriveFolderRequest,
    CreateDriveUploadRequest,
    CreateDriveUploadResponse,
    DriveDownloadUrlResponse,
    DriveEntriesResponse,
    DriveFileView,
    DriveFolderDeleteResponse,
    DriveFolderMoveResponse,
    DriveFolderView,
    DrivePurpose,
    DriveQuotaView,
    DriveResolveResponse,
    ListDriveFilesResponse,
    MoveDriveEntryRequest,
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


@router.patch("/drive/files/{file_id}", response_model=DriveFileView)
async def move_drive_file(
    file_id: str,
    payload: MoveDriveEntryRequest,
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> DriveFileView:
    return await drive.move_file(caller=caller, file_id=file_id, req=payload)


@router.delete("/drive/files/{file_id}", response_model=OkResponse)
async def delete_drive_file(
    file_id: str,
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> OkResponse:
    deleted = await drive.delete_file(caller=caller, file_id=file_id)
    return OkResponse(ok=deleted)


# ---------------------------------------------------------------------------
# Drive filesystem: folder listing, folders, moves and `drive:` references
# ---------------------------------------------------------------------------


@router.get("/drive/entries", response_model=DriveEntriesResponse)
async def list_drive_entries(
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
    path: Annotated[str, Query(max_length=2048)] = "/",
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> DriveEntriesResponse:
    return await drive.list_entries(caller=caller, path=path, limit=limit, offset=offset)


@router.post("/drive/folders", response_model=DriveFolderView, status_code=201)
async def create_drive_folder(
    payload: CreateDriveFolderRequest,
    response: Response,
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> DriveFolderView:
    folder, created = await drive.create_folder(caller=caller, req=payload)
    if not created:
        response.status_code = 200
    return folder


@router.patch("/drive/folders/{folder_id}", response_model=DriveFolderMoveResponse)
async def move_drive_folder(
    folder_id: str,
    payload: MoveDriveEntryRequest,
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> DriveFolderMoveResponse:
    return await drive.move_folder(caller=caller, folder_id=folder_id, req=payload)


@router.delete("/drive/folders/{folder_id}", response_model=DriveFolderDeleteResponse)
async def delete_drive_folder(
    folder_id: str,
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
) -> DriveFolderDeleteResponse:
    return await drive.delete_folder(caller=caller, folder_id=folder_id)


@router.get("/drive/resolve", response_model=DriveResolveResponse)
async def resolve_drive_path(
    caller: Annotated[DriveCaller, Depends(current_drive_caller)],
    drive: Annotated[DriveService, Depends(get_drive_service)],
    path: Annotated[str | None, Query(max_length=2048)] = None,
    ref: Annotated[str | None, Query(max_length=8192)] = None,
) -> DriveResolveResponse:
    return await drive.resolve(caller=caller, path=path, ref=ref)


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
