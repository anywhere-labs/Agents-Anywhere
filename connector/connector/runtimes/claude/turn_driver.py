from __future__ import annotations

import asyncio
import secrets
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeConfig,
    RuntimeSessionStateCache,
    RuntimeUnsupportedError,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude import options as claude_options
from connector.runtimes.claude import timeline, utils
from connector.runtimes.claude.attachments import materialize_claude_content
from connector.runtimes.claude.ordering import RuntimeOrderAllocator
from connector.runtimes.claude.runtime_session import ClaudeSession, maybe_await

RequireSdk = Callable[[], Any]
ClaudeClientFactory = Callable[[Any, Mapping[str, Any]], Any]
CanUseTool = Callable[[str, dict[str, Any], Any], Any]


@dataclass(slots=True)
class ClaudeTurnDriver:
    config: RuntimeConfig
    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    ordering: RuntimeOrderAllocator
    require_sdk: RequireSdk
    can_use_tool: CanUseTool
    client_factory: ClaudeClientFactory | None = None

    async def drive_turn(
        self,
        session: ClaudeSession,
        content: str,
        attachments: tuple[RuntimeAttachment, ...],
        client_message_id: str | None,
    ) -> None:
        turn_id = session.active_turn_id or f"turn_claude_{secrets.token_urlsafe(12)}"
        try:
            sdk = self.require_sdk()
            client = self.new_client(sdk, session)
            session.client = client
            connect = getattr(client, "connect", None)
            if callable(connect):
                await maybe_await(connect())
            await self._set_session_state(
                session_id=session.session_id,
                external_session_id=session.external_session_id,
                status="running",
                metadata={"source": "claude.turn/running", "turn_id": turn_id},
            )
            query = getattr(client, "query", None)
            if not callable(query):
                raise RuntimeUnsupportedError("ClaudeSDKClient.query")
            await query(
                timeline.prompt_stream(
                    await materialize_claude_content(
                        self.host, session.session_id, content, attachments
                    )
                )
            )
            await self.host.timeline_item_upsert(
                timeline.message_item(
                    session_id=session.session_id,
                    external_session_id=session.external_session_id,
                    turn_id=turn_id,
                    role="user",
                    text=content,
                    source_event="claude.turn/start.user",
                    order_seq=self.ordering.order_for(
                        utils.stable_item_id(
                            "claude_user",
                            session.session_id,
                            turn_id,
                            client_message_id,
                            content,
                        )
                    ),
                    item_id=utils.stable_item_id(
                        "claude_user",
                        session.session_id,
                        turn_id,
                        client_message_id,
                        content,
                    ),
                    client_message_id=client_message_id,
                )
            )
            async for raw in timeline.receive_response(client):
                for item in timeline.timeline_items_from_live_message(
                    session_id=session.session_id,
                    external_session_id=session.external_session_id,
                    turn_id=turn_id,
                    message=raw,
                    next_order=self.ordering.order_for,
                ):
                    await self.host.timeline_item_upsert(item)
                    source_session_id = item.source.get("sessionId")
                    if isinstance(source_session_id, str) and source_session_id:
                        session.external_session_id = source_session_id
            await self._set_session_state(
                session_id=session.session_id,
                external_session_id=session.external_session_id,
                status="idle",
                metadata={"source": "claude.turn/completed", "turn_id": turn_id},
            )
        except asyncio.CancelledError:
            await self._set_session_state(
                session_id=session.session_id,
                external_session_id=session.external_session_id,
                status="idle",
                metadata={"source": "claude.turn/cancelled", "turn_id": turn_id},
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "claude runtime turn failed session_id={}", session.session_id
            )
            await self._set_session_state(
                session_id=session.session_id,
                external_session_id=session.external_session_id,
                status="error",
                error={
                    "code": getattr(exc, "code", None) or exc.__class__.__name__,
                    "message": str(exc) or exc.__class__.__name__,
                },
                metadata={"source": "claude.turn/failed", "turn_id": turn_id},
            )
        finally:
            session.active_turn_id = None
            disconnect = getattr(session.client, "disconnect", None)
            if callable(disconnect):
                try:
                    await maybe_await(disconnect())
                except Exception:  # noqa: BLE001
                    logger.exception("disconnecting Claude SDK client failed")

    def new_client(self, sdk: Any, session: ClaudeSession) -> Any:
        options = claude_options.sdk_options(
            sdk=sdk,
            config_values=self.config.values,
            cwd=session.cwd,
            external_session_id=session.external_session_id,
            permission_selection=session.selections.get("permission"),
            can_use_tool=self.can_use_tool,
        )
        if self.client_factory is not None:
            return self.client_factory(sdk, options)
        client_cls = getattr(sdk, "ClaudeSDKClient", None)
        if client_cls is None:
            raise RuntimeUnsupportedError("ClaudeSDKClient")
        try:
            return client_cls(options=options)
        except TypeError:
            return client_cls(options)

    async def _set_session_state(
        self,
        session_id: str,
        external_session_id: str | None,
        status: str,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        await self.session_states.update(
            session_id=session_id,
            external_session_id=external_session_id,
            status=status,  # type: ignore[arg-type]
            error=error,
            metadata=metadata,
        )
