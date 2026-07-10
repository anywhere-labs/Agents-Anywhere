from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from agent_server.core.models import (
    DashboardOverviewResponse,
    DashboardSegment,
    DashboardSettingsUpdateRequest,
    DashboardSettingsView,
    DashboardSnapshotResponse,
)
from agent_server.core.utc import utc_now
from agent_server.deps import get_store, require_admin
from agent_server.infra.repositories.facade import Store
from agent_server.services.admin_dashboard import AdminDashboardService


router = APIRouter(
    prefix="/admin/dashboard",
    tags=["admin-dashboard"],
    dependencies=[Depends(require_admin)],
)


def _service(db: Store = Depends(get_store)) -> AdminDashboardService:
    return AdminDashboardService(db)


@router.get("/settings", response_model=DashboardSettingsView)
async def get_dashboard_settings(
    service: AdminDashboardService = Depends(_service),
) -> DashboardSettingsView:
    return await service.get_settings()


@router.patch("/settings", response_model=DashboardSettingsView)
async def update_dashboard_settings(
    payload: DashboardSettingsUpdateRequest,
    service: AdminDashboardService = Depends(_service),
) -> DashboardSettingsView:
    return await service.update_settings(payload)


@router.get("/overview", response_model=DashboardOverviewResponse)
async def get_dashboard_overview(
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    timezone: str = Query("Asia/Shanghai", alias="tz"),
    service: AdminDashboardService = Depends(_service),
) -> DashboardOverviewResponse:
    target_to = to_date or _today(timezone)
    target_from = from_date or (target_to - timedelta(days=29))
    try:
        return await service.get_overview(
            from_date=target_from,
            to_date=target_to,
            timezone=timezone,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/snapshots/today", response_model=DashboardSnapshotResponse)
async def refresh_today_snapshot(
    timezone: str = Query("Asia/Shanghai", alias="tz"),
    service: AdminDashboardService = Depends(_service),
) -> DashboardSnapshotResponse:
    try:
        return await service.refresh_snapshot(_today(timezone), timezone=timezone)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/snapshots/{target_date}", response_model=DashboardSnapshotResponse)
async def refresh_snapshot(
    target_date: date,
    timezone: str = Query("Asia/Shanghai", alias="tz"),
    service: AdminDashboardService = Depends(_service),
) -> DashboardSnapshotResponse:
    try:
        return await service.refresh_snapshot(target_date, timezone=timezone)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/users/export")
async def export_dashboard_users(
    date_value: date | None = Query(None, alias="date"),
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    segment: DashboardSegment = "all",
    service: AdminDashboardService = Depends(_service),
) -> Response:
    target_from = from_date or date_value or _today()
    target_to = to_date or date_value or target_from
    try:
        content = await service.export_users_xlsx(
            from_date=target_from,
            to_date=target_to,
            segment=segment,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    filename = f"dashboard-users-{target_from.isoformat()}-{target_to.isoformat()}-{segment}-{utc_now()[:10]}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _today(timezone: str = "Asia/Shanghai") -> date:
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo(timezone)).date()
