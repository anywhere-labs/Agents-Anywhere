from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query

from agent_server.core.models import UsageLiveResponse, UsageReportResponse
from agent_server.deps import get_rpc, get_store, require_admin
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store
from agent_server.services.usage_report import UsageReportError, UsageReportService

router = APIRouter(
    prefix="/admin/usage",
    tags=["admin-usage"],
    dependencies=[Depends(require_admin)],
)

DEFAULT_RANGE_DAYS = 30


@router.get("/report", response_model=UsageReportResponse)
async def get_usage_report(
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    timezone: str = Query("UTC", alias="tz"),
    db: Store = Depends(get_store),
) -> UsageReportResponse:
    service = UsageReportService(db)
    try:
        target_to = to_date or service.today(timezone)
        target_from = from_date or (target_to - timedelta(days=DEFAULT_RANGE_DAYS - 1))
        return await service.report(
            from_date=target_from,
            to_date=target_to,
            timezone=timezone,
        )
    except UsageReportError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/live", response_model=UsageLiveResponse)
async def get_usage_live(
    db: Store = Depends(get_store),
    rpc: ConnectorRpcManager = Depends(get_rpc),
) -> UsageLiveResponse:
    return await UsageReportService(db).live(presence=rpc)
