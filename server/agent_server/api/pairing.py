from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from starlette.requests import HTTPConnection

from agent_server.core.models import (
    ConnectorConfigBundle,
    PairingClaimRequest,
    PairingClaimResponse,
    PairingPollRequest,
    PairingPollResponse,
    PairingStartRequest,
    PairingStartResponse,
)
from agent_server.core.utc import utc_now
from agent_server.deps import current_user_id, get_store
from agent_server.infra.pairing_store import (
    PairingNotClaimable,
    PairingNotFound,
    PairingStore,
)
from agent_server.infra.repositories.facade import Store

router = APIRouter(prefix="/pairing", tags=["pairing"])


def get_pairing_store(conn: HTTPConnection) -> PairingStore:
    return conn.app.state.pairing


@router.post("/start", response_model=PairingStartResponse)
async def pairing_start(
    payload: PairingStartRequest, pairings: PairingStore = Depends(get_pairing_store)
) -> PairingStartResponse:
    pairing = await pairings.start(server_url=payload.serverUrl, ttl_seconds=payload.ttlSeconds)
    return PairingStartResponse(
        pairingId=pairing["pairingId"],
        code=pairing["code"],
        expiresAt=pairing["expiresAt"],
        serverTime=utc_now(),
    )


@router.post("/claim", response_model=PairingClaimResponse)
async def pairing_claim(
    payload: PairingClaimRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    pairings: PairingStore = Depends(get_pairing_store),
) -> PairingClaimResponse:
    try:
        claim = await pairings.begin_claim(payload.code)
        if payload.connectorId or payload.connectorToken:
            if not payload.connectorId or not payload.connectorToken:
                raise PairingNotClaimable("connector id and token must be provided together")
            if not await db.verify_connector_token(payload.connectorId, payload.connectorToken):
                raise PairingNotClaimable("invalid connector credential")
            connector = await db.get_connector(payload.connectorId)
            if connector.userId != user_id:
                raise PairingNotClaimable("invalid connector credential")
            token = payload.connectorToken
        else:
            connector, token, _prefix = await db.create_connector(
                name=payload.name, user_id=user_id, connector_kind="cli"
            )
        await pairings.finish_claim(
            claim, connector_id=connector.id, connector_token=token, server_url=payload.serverUrl
        )
    except PairingNotFound:
        raise HTTPException(status_code=404, detail="pairing code not found") from None
    except PairingNotClaimable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return PairingClaimResponse(status="claimed", connector=connector)


@router.post("/poll", response_model=PairingPollResponse)
async def pairing_poll(
    payload: PairingPollRequest, pairings: PairingStore = Depends(get_pairing_store)
) -> PairingPollResponse:
    try:
        result = await pairings.poll(payload.pairingId)
    except PairingNotFound:
        raise HTTPException(status_code=404, detail="pairing id not found") from None
    except PairingNotClaimable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    config = result.get("config")
    return PairingPollResponse(
        status=result["status"],
        expiresAt=result["expiresAt"],
        config=ConnectorConfigBundle(**config) if config else None,
    )
