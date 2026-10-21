"""Drive a SyncRelay with the 2.0 ingest/snapshot API in tests."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from connector.runtimes.dsh.bridge.host import (
    SnapshotPage,
    SnapshotRequest,
    SubscriptionRegistry,
    SyncBatch,
)
from connector.runtimes.dsh.bridge.sync import SyncRelay

CAPTURE_ID = "capture"


def ready_relay(receiver: Any, *, durable: bool = True, projection: int = 3) -> SyncRelay:
    """A relay in the state ``subscribe()`` leaves it in once the plugin confirmed the stream."""
    registry = SubscriptionRegistry()
    client = SimpleNamespace(host=SimpleNamespace(registry=registry), connected=True)
    relay = SyncRelay(client, receiver)
    relay.subscription_id = "sub"
    relay.projection_version = projection
    relay.durable_checkpoints = durable
    relay.expected_batch = 1
    relay.confirmed.set()
    registry.add("sub", relay)
    return relay


async def ingest(relay: SyncRelay, *operations: dict[str, Any]) -> None:
    """Deliver one batch of operations, as the plugin's ``ingestBatch`` call would."""
    await relay.ingest(SyncBatch(
        subscriptionId=relay.subscription_id or "",
        batchSeq=relay.expected_batch,
        projectionVersion=relay.projection_version or 3,
        operations=list(operations),
    ))


async def begin_snapshot(
    relay: SyncRelay,
    *,
    session_id: str = "session",
    meta: dict[str, Any] | None = None,
    through_seq: int = 0,
) -> None:
    await relay.begin_snapshot(SnapshotRequest(
        captureId=CAPTURE_ID,
        subscriptionId=relay.subscription_id or "",
        sessionId=session_id,
        meta=meta or {"externalSessionId": "native"},
        throughSeq=through_seq,
    ))


async def add_page(relay: SyncRelay, items: list[dict[str, Any]]) -> None:
    await relay.add_snapshot_page(SnapshotPage(captureId=CAPTURE_ID, items=items))
