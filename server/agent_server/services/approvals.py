from __future__ import annotations

from loguru import logger

from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcError, ConnectorRpcManager
from agent_server.core.models import RpcResponsePayload
from agent_server.services.timeline_effects import apply_resolved_approval_to_target_item
from agent_server.infra.repositories.facade import Store


class ApprovalServiceError(RuntimeError):
    status_code = 500

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class ApprovalNotFoundError(ApprovalServiceError):
    status_code = 404


class ApprovalConflictError(ApprovalServiceError):
    status_code = 409


class ApprovalUpstreamError(ApprovalServiceError):
    status_code = 502


class ApprovalService:
    def __init__(self, store: Store, manager: ConnectorRpcManager) -> None:
        self._store = store
        self._manager = manager

    async def resolve(
        self,
        approval_id: str,
        status: str,
        *,
        user_id: str,
    ) -> RpcResponsePayload:
        try:
            pending_approval = await self._store.get_approval(approval_id)
            if pending_approval.status != "pending":
                raise ApprovalConflictError("approval already resolved")
            session = await self._store.get_session(pending_approval.sessionId, user_id=user_id)
            logger.info(
                "approval resolve requested approval_id={} status={} session_id={} connector_id={} target_item_id={} request_id={}",
                approval_id,
                status,
                session.id,
                session.connectorId,
                pending_approval.targetItemId,
                pending_approval.source.requestId,
            )
            result = await self._manager.request(
                session.connectorId,
                "approval.resolve",
                {
                    "approvalId": approval_id,
                    "status": status,
                    "requestId": pending_approval.source.requestId,
                    "sessionId": session.id,
                    "runtime": session.runtime,
                    "externalSessionId": session.externalSessionId,
                },
            )
            logger.info(
                "approval resolve connector confirmed approval_id={} status={} session_id={} result={}",
                approval_id,
                status,
                session.id,
                result,
            )
            approval = await self._store.resolve_approval(approval_id, status)
            await apply_resolved_approval_to_target_item(self._store, approval)
            await self._store.refresh_session_status_from_timeline(session.id)
            logger.info(
                "approval resolve stored approval_id={} status={} session_id={} next_session_status={}",
                approval_id,
                status,
                session.id,
                (await self._store.get_session(session.id)).status,
            )
        except ApprovalServiceError:
            raise
        except KeyError:
            logger.warning(
                "approval resolve failed: approval not found approval_id={} status={}",
                approval_id,
                status,
            )
            raise ApprovalNotFoundError("approval not found") from None
        except ConnectorOfflineError as exc:
            logger.warning(
                "approval resolve failed: connector offline approval_id={} status={} error={}",
                approval_id,
                status,
                exc,
            )
            raise ApprovalConflictError(str(exc)) from exc
        except ConnectorRpcError as exc:
            logger.warning(
                "approval resolve failed: connector rpc error approval_id={} status={} code={} message={}",
                approval_id,
                status,
                exc.code,
                exc.message,
            )
            raise ApprovalUpstreamError(exc.message or exc.code) from exc
        return RpcResponsePayload(ok=True, result=result)
