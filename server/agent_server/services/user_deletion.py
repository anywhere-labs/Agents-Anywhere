"""Delete a user account together with its devices and sessions."""

from __future__ import annotations

from typing import TYPE_CHECKING

from agent_server.services.connector_deletion import (
    DeviceLinkRevoker,
    delete_connector_data,
)
from agent_server.services.repository_ports import UserDeletionRepository

if TYPE_CHECKING:
    from agent_server.infra.connector_presence_registry import ConnectorPresenceRegistry
    from agent_server.services.session_runtime_state_cache import (
        SessionRuntimeStateCache,
    )


class UserDeletionPending(Exception):
    """Device cleanup failed; the device stays pending and will be retried."""


async def delete_user_account(
    user_id: str,
    store: UserDeletionRepository,
    manager: ConnectorPresenceRegistry,
    runtime_state_cache: SessionRuntimeStateCache,
    device_link: DeviceLinkRevoker,
) -> None:
    """Remove every device (and its sessions/projects) first, then the user.

    ``connectors.user_id`` has no foreign key and sessions block project
    cascades, so deleting the user row directly would orphan devices or fail.
    Each device goes through the same flow as a user-requested device deletion:
    it is marked pending (``revoked=2``) before external cleanup, so a failure
    is finished later by ``ConnectorDeletionRecovery``.

    Raises ``KeyError`` when the user does not exist, ``ValueError`` when a
    guard rejects the deletion, and ``UserDeletionPending`` when device cleanup
    has to be retried.
    """
    # Reject guarded deletions (missing user, last admin) before touching devices.
    await store.ensure_user_deletable(user_id)
    for connector_id in await store.list_user_connector_ids(user_id):
        try:
            await delete_connector_data(
                connector_id,
                user_id,
                store,
                manager,
                runtime_state_cache,
                device_link,
            )
        except KeyError:
            continue  # Deleted concurrently by the owner or the recovery worker.
        except Exception as exc:  # device remains pending for recovery
            raise UserDeletionPending(connector_id) from exc
    await store.delete_user(user_id)
