from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from agent_server.deps import current_user_id, get_store
from agent_server.core.models import (
    PairingClaimRequest,
    PairingClaimResponse,
    PairingPollRequest,
    PairingPollResponse,
    PairingStartRequest,
    PairingStartResponse,
)
from agent_server.infra.repositories.facade import Store
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/pairing", tags=["pairing"])


@router.post("/start", response_model=PairingStartResponse)
async def pairing_start(payload: PairingStartRequest, db: Store = Depends(get_store)) -> PairingStartResponse:
    pairing = await db.create_pairing(server_url=payload.serverUrl, ttl_seconds=payload.ttlSeconds)
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
) -> PairingClaimResponse:
    try:
        connector = await db.claim_pairing(
            code=payload.code,
            name=payload.name,
            user_id=user_id,
            server_url=payload.serverUrl,
            connector_id=payload.connectorId,
            connector_token=payload.connectorToken,
            owner_user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="pairing code not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return PairingClaimResponse(status="claimed", connector=connector)


@router.post("/poll", response_model=PairingPollResponse)
async def pairing_poll(payload: PairingPollRequest, db: Store = Depends(get_store)) -> PairingPollResponse:
    try:
        return await db.poll_pairing(pairing_id=payload.pairingId)
    except KeyError:
        raise HTTPException(status_code=404, detail="pairing id not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
