from __future__ import annotations

import json
import time
from typing import Any

from aa_control.core.auth import (
    generate_opaque_token,
    hash_secret_digest,
    verify_pkce_s256,
)
from aa_control.core.config import ControlSettings
from aa_control.core.errors import (
    DeviceOfflineError,
    ForbiddenError,
    NotFoundError,
    UnauthenticatedError,
    ValidationError,
)
from aa_control.core.models import (
    ALL_MCP_SCOPES,
    DEFAULT_CHECKED_MCP_SCOPES,
    ListSessionsRequest,
)
from aa_control.infra.db.repositories import ControlRepository, DeviceRow, McpClientRow, McpGrantRow
from aa_control.infra.redis_store import RedisControlStore
from aa_control.infra.router_pool import RouterPoolPort
from aa_control.services.fanout_service import FanoutService

MCP_PROTOCOL_VERSION = "2025-03-26"

MCP_TOOLS_CATALOG: list[dict[str, Any]] = [
    {
        "name": "list_devices",
        "description": "List online and offline normal-mode devices authorized for this MCP grant (encrypted devices are excluded).",
        "required_scope": "devices:read",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "list_sessions",
        "description": "List sessions across authorized online normal-mode devices.",
        "required_scope": "sessions:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "device_ids": {"type": "array", "items": {"type": "string"}},
                "limit_per_device": {"type": "integer", "minimum": 1, "maximum": 500},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "read_session",
        "description": "Read paginated text messages from a session on an authorized normal-mode device.",
        "required_scope": "sessions:read",
        "inputSchema": {
            "type": "object",
            "required": ["device_id", "session_id"],
            "properties": {
                "device_id": {"type": "string"},
                "session_id": {"type": "string"},
                "cursor": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "create_session",
        "description": "Create a new session on an authorized normal-mode device.",
        "required_scope": "sessions:write",
        "inputSchema": {
            "type": "object",
            "required": ["device_id", "agent", "cwd"],
            "properties": {
                "device_id": {"type": "string"},
                "agent": {"type": "string"},
                "cwd": {"type": "string"},
                "title": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "send_message",
        "description": "Send a user message to a session on an authorized normal-mode device.",
        "required_scope": "sessions:write",
        "inputSchema": {
            "type": "object",
            "required": ["device_id", "session_id", "text"],
            "properties": {
                "device_id": {"type": "string"},
                "session_id": {"type": "string"},
                "text": {"type": "string"},
                "wait": {"type": "boolean"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "stop_session",
        "description": "Stop an active run in a session on an authorized normal-mode device.",
        "required_scope": "sessions:write",
        "inputSchema": {
            "type": "object",
            "required": ["device_id", "session_id"],
            "properties": {
                "device_id": {"type": "string"},
                "session_id": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "answer_approval",
        "description": "Approve or reject a pending tool approval on an authorized normal-mode device (requires approvals:answer scope, unchecked by default).",
        "required_scope": "approvals:answer",
        "inputSchema": {
            "type": "object",
            "required": ["device_id", "session_id", "approval_id", "decision"],
            "properties": {
                "device_id": {"type": "string"},
                "session_id": {"type": "string"},
                "approval_id": {"type": "string"},
                "decision": {"type": "string", "enum": ["approve", "reject"]},
                "reason": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
]


class McpService:
    """OAuth 2.1 authorization server + MCP Streamable HTTP tool dispatcher."""

    def __init__(
        self,
        *,
        settings: ControlSettings,
        repo: ControlRepository,
        redis_store: RedisControlStore,
        router_pool: RouterPoolPort,
        fanout_service: FanoutService,
    ) -> None:
        self._settings = settings
        self._repo = repo
        self._redis = redis_store
        self._routers = router_pool
        self._fanout = fanout_service

    # ------------------------------------------------------------------
    # OAuth 2.1 Dynamic Client Registration & Authorization
    # ------------------------------------------------------------------

    def oauth_metadata(self, issuer: str) -> dict[str, Any]:
        base = issuer.rstrip("/")
        return {
            "issuer": base,
            "authorization_endpoint": self.authorization_endpoint(issuer),
            "token_endpoint": f"{base}/oauth/token",
            "registration_endpoint": f"{base}/oauth/register",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code"],
            "code_challenge_methods_supported": ["S256"],
            "scopes_supported": list(ALL_MCP_SCOPES),
            "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
        }

    def authorization_endpoint(self, issuer: str) -> str:
        """Where MCP clients send the user's browser to approve access.

        With ``web_origin`` configured this is the Web consent page; otherwise the control plane's own
        ``/oauth/authorize`` (a Bearer-only JSON API that only first-party clients can drive).
        """
        base = (self._settings.web_origin or issuer).rstrip("/")
        return f"{base}/oauth/authorize"

    def consent_page_redirect(self, query: str) -> str | None:
        """URL of the Web consent page carrying the same authorization query, or ``None`` if unset."""
        if not self._settings.web_origin:
            return None
        target = f"{self._settings.web_origin}/oauth/authorize"
        return f"{target}?{query}" if query else target

    def protected_resource_metadata(self, issuer: str) -> dict[str, Any]:
        base = issuer.rstrip("/")
        return {
            "resource": f"{base}/mcp",
            "authorization_servers": [base],
            "scopes_supported": list(ALL_MCP_SCOPES),
            "bearer_methods_supported": ["header"],
        }

    async def register_client(
        self,
        *,
        client_name: str,
        redirect_uris: list[str],
    ) -> dict[str, Any]:
        if not client_name.strip():
            raise ValidationError("client_name is required")
        if not redirect_uris:
            raise ValidationError("at least one redirect_uri is required")
        row = await self._repo.create_mcp_oauth_client(
            client_name=client_name.strip(),
            redirect_uris=redirect_uris,
        )
        return {
            "client_id": row.client_id,
            "client_name": row.client_name,
            "redirect_uris": row.redirect_uris,
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
        }

    async def consent_preview(
        self,
        *,
        user_id: str,
        client_id: str,
        redirect_uri: str,
        requested_scopes: list[str],
    ) -> dict[str, Any]:
        client = await self._validate_client_redirect(client_id, redirect_uri)
        all_devices = await self._repo.list_devices_for_user(user_id)
        normal_devices = [
            {"id": d.id, "name": d.name, "platform": d.platform}
            for d in all_devices
            if d.mode_hint == "normal"
        ]
        requested = [s for s in requested_scopes if s in ALL_MCP_SCOPES] or list(DEFAULT_CHECKED_MCP_SCOPES)
        # Hard requirement: approvals:answer is NEVER pre-checked by default on consent screen.
        scopes_ui = [
            {
                "scope": s,
                "default_checked": s in DEFAULT_CHECKED_MCP_SCOPES and s in requested,
                "high_risk": s == "approvals:answer",
            }
            for s in ALL_MCP_SCOPES
        ]
        return {
            "client_id": client.client_id,
            "client_name": client.client_name,
            "redirect_uri": redirect_uri,
            "scopes": scopes_ui,
            "eligible_devices": normal_devices,
            "note": "Encrypted devices cannot be controlled via MCP and are not selectable.",
        }

    async def approve_authorization(
        self,
        *,
        user_id: str,
        client_id: str,
        redirect_uri: str,
        code_challenge: str,
        code_challenge_method: str,
        approved_scopes: list[str],
        device_ids: list[str],
    ) -> str:
        await self._validate_client_redirect(client_id, redirect_uri)
        if code_challenge_method != "S256" or len(code_challenge) < 43:
            raise ValidationError("valid S256 code_challenge is required")
        valid_scopes = [s for s in approved_scopes if s in ALL_MCP_SCOPES]
        if not valid_scopes:
            raise ValidationError("at least one valid MCP scope must be approved")

        # Validate device_ids: only user-owned normal-mode devices are allowed.
        user_devices = {d.id: d for d in await self._repo.list_devices_for_user(user_id)}
        filtered_devices: list[str] = []
        for did in device_ids:
            dev = user_devices.get(did)
            if dev is None:
                raise NotFoundError(f"device {did} not found")
            if dev.mode_hint == "encrypted":
                raise ForbiddenError(f"encrypted device {did} cannot be granted to MCP")
            filtered_devices.append(did)

        raw_code = generate_opaque_token("aamcpc_", 24)
        await self._repo.create_mcp_auth_code(
            code_hash=hash_secret_digest(raw_code),
            client_id=client_id,
            user_id=user_id,
            redirect_uri=redirect_uri,
            code_challenge=code_challenge,
            scopes=valid_scopes,
            device_ids=filtered_devices,
            expires_at=int(time.time()) + self._settings.mcp_auth_code_ttl_seconds,
        )
        return raw_code

    async def exchange_code(
        self,
        *,
        client_id: str,
        code: str,
        redirect_uri: str,
        code_verifier: str,
    ) -> dict[str, Any]:
        client = await self._validate_client_redirect(client_id, redirect_uri)
        consumed = await self._repo.consume_mcp_auth_code(hash_secret_digest(code))
        if consumed is None:
            raise UnauthenticatedError("invalid, expired, or already used authorization code")
        if consumed.client_id != client.client_id or consumed.redirect_uri != redirect_uri:
            raise UnauthenticatedError("authorization code client/redirect mismatch")
        if not verify_pkce_s256(code_verifier, consumed.code_challenge):
            raise UnauthenticatedError("PKCE code_verifier verification failed")

        raw_token = generate_opaque_token("aamcp_", 32)
        expires_in = self._settings.mcp_access_token_ttl_seconds
        grant = await self._repo.create_mcp_grant(
            user_id=consumed.user_id,
            client_id=client.client_id,
            client_name=client.client_name,
            scopes=consumed.scopes,
            device_ids=consumed.device_ids,
            access_token_hash=hash_secret_digest(raw_token),
            expires_at=int(time.time()) + expires_in,
        )
        await self._repo.record_audit(
            user_id=consumed.user_id,
            actor=f"user:{consumed.user_id}",
            action="mcp.grant.create",
            metadata={
                "grant_id": grant.id,
                "client_id": client.client_id,
                "scopes": grant.scopes,
                "device_ids": grant.device_ids,
            },
        )
        return {
            "access_token": raw_token,
            "token_type": "Bearer",
            "expires_in": expires_in,
            "scope": " ".join(grant.scopes),
            "grant_id": grant.id,
        }

    async def authenticate_token(self, raw_token: str) -> McpGrantRow:
        grant = await self._repo.get_active_mcp_grant_by_token_hash(hash_secret_digest(raw_token))
        if grant is None:
            raise UnauthenticatedError("invalid, expired, or revoked MCP token")
        return grant

    async def list_grants(self, user_id: str) -> list[dict[str, Any]]:
        rows = await self._repo.list_mcp_grants_for_user(user_id)
        return [
            {
                "id": g.id,
                "client_id": g.client_id,
                "client_name": g.client_name,
                "scopes": g.scopes,
                "device_ids": g.device_ids,
                "expires_at": g.expires_at,
                "revoked_at": g.revoked_at,
                "created_at": g.created_at,
            }
            for g in rows
        ]

    async def revoke_grant(self, *, user_id: str, grant_id: str) -> bool:
        revoked = await self._repo.revoke_mcp_grant(user_id=user_id, grant_id=grant_id)
        if revoked:
            await self._repo.record_audit(
                user_id=user_id,
                actor=f"user:{user_id}",
                action="mcp.grant.revoke",
                metadata={"grant_id": grant_id},
            )
        return revoked

    # ------------------------------------------------------------------
    # MCP Streamable HTTP JSON-RPC 2.0 Handler
    # ------------------------------------------------------------------

    async def handle_jsonrpc(self, *, grant: McpGrantRow, request: dict[str, Any]) -> dict[str, Any] | None:
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}

        if method == "notifications/initialized":
            return None

        if method == "initialize":
            return _rpc_result(
                req_id,
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "agents-anywhere-v3", "version": "3.0.0"},
                },
            )

        if method == "tools/list":
            tools = [
                {
                    "name": t["name"],
                    "description": t["description"],
                    "inputSchema": t["inputSchema"],
                }
                for t in MCP_TOOLS_CATALOG
                if t["required_scope"] in grant.scopes
            ]
            return _rpc_result(req_id, {"tools": tools})

        if method == "tools/call":
            tool_name = str(params.get("name") or "")
            arguments = params.get("arguments") or {}
            if not isinstance(arguments, dict):
                return _rpc_error(req_id, -32602, "arguments must be an object")
            try:
                result_payload = await self._execute_tool(
                    grant=grant,
                    tool_name=tool_name,
                    arguments=arguments,
                )
            except (ForbiddenError, UnauthenticatedError) as exc:
                return _rpc_error(req_id, -32003, exc.message)
            except (NotFoundError, ValidationError, DeviceOfflineError) as exc:
                return _rpc_result(
                    req_id,
                    {
                        "content": [{"type": "text", "text": exc.message}],
                        "isError": True,
                    },
                )
            except Exception as exc:  # noqa: BLE001
                return _rpc_result(
                    req_id,
                    {
                        "content": [{"type": "text", "text": str(exc)}],
                        "isError": True,
                    },
                )
            return _rpc_result(
                req_id,
                {
                    "content": [{"type": "text", "text": json.dumps(result_payload, ensure_ascii=False)}],
                    "structuredContent": result_payload,
                    "isError": False,
                },
            )

        return _rpc_error(req_id, -32601, f"method not found: {method}")

    async def _execute_tool(
        self,
        *,
        grant: McpGrantRow,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        tool_spec = next((t for t in MCP_TOOLS_CATALOG if t["name"] == tool_name), None)
        if tool_spec is None:
            raise NotFoundError(f"unknown MCP tool: {tool_name}")

        required_scope = tool_spec["required_scope"]
        if required_scope not in grant.scopes:
            raise ForbiddenError(f"MCP grant lacks required scope '{required_scope}'")

        allowed_ids = set(grant.device_ids) if grant.device_ids else None
        actor = f"mcp:{grant.client_name}"

        if tool_name == "list_devices":
            all_devs = await self._repo.list_devices_for_user(grant.user_id)
            presences = await self._redis.get_presences([d.id for d in all_devs])
            visible: list[dict[str, Any]] = []
            for d in all_devs:
                if allowed_ids is not None and d.id not in allowed_ids:
                    continue
                pres = presences.get(d.id)
                mode = pres.mode_hint if pres is not None else d.mode_hint
                if mode == "encrypted":
                    continue
                visible.append(
                    {
                        "id": d.id,
                        "name": d.name,
                        "platform": pres.platform if pres is not None else d.platform,
                        "presence": "online" if pres is not None else "offline",
                        "summary": pres.summary.model_dump() if (pres and pres.summary) else None,
                    }
                )
            await self._repo.record_audit(user_id=grant.user_id, actor=actor, action="mcp.list_devices")
            return {"devices": visible}

        if tool_name == "list_sessions":
            req = ListSessionsRequest(
                device_ids=arguments.get("device_ids"),
                limit_per_device=arguments.get("limit_per_device"),
            )
            resp = await self._fanout.list_sessions_once(
                user_id=grant.user_id,
                req=req,
                via="mcp",
                mcp_client=grant.client_name,
                allowed_device_ids=allowed_ids,
            )
            await self._repo.record_audit(user_id=grant.user_id, actor=actor, action="mcp.list_sessions")
            return resp.model_dump(exclude_none=True)

        # Single-device tools: enforce ownership, grant device scope, normal mode, online state.
        device_id = str(arguments.get("device_id") or "")
        if not device_id:
            raise ValidationError("device_id is required")
        dev = await self._require_mcp_normal_online_device(
            grant=grant,
            device_id=device_id,
            allowed_ids=allowed_ids,
        )
        session_id = str(arguments.get("session_id") or "") or None
        rpc_method_map = {
            "read_session": "list_messages",
            "create_session": "create",
            "send_message": "send",
            "stop_session": "stop",
            "answer_approval": "answer",
        }
        rpc_method = rpc_method_map[tool_name]
        rpc_payload = {k: v for k, v in arguments.items() if k != "device_id"}

        result = await self._routers.call_device_sessions(
            device_id=dev.id,
            method=rpc_method,
            payload=rpc_payload,
            on_behalf_of=f"user:{grant.user_id}",
            via="mcp",
            mcp_client=grant.client_name,
            timeout=30.0 if tool_name == "send_message" and arguments.get("wait") else 10.0,
        )
        # Metadata-only audit log: NEVER record message/prompt text or tool output!
        await self._repo.record_audit(
            user_id=grant.user_id,
            actor=actor,
            action=f"mcp.{tool_name}",
            device_id=dev.id,
            session_id=session_id or str(result.get("session_id") or result.get("id") or "") or None,
        )
        return result

    async def _require_mcp_normal_online_device(
        self,
        *,
        grant: McpGrantRow,
        device_id: str,
        allowed_ids: set[str] | None,
    ) -> DeviceRow:
        if allowed_ids is not None and device_id not in allowed_ids:
            raise ForbiddenError(f"device {device_id} is outside this MCP grant scope")
        dev = await self._repo.get_device(device_id)
        if dev is None or dev.user_id != grant.user_id:
            raise NotFoundError(f"device {device_id} not found")
        pres = await self._redis.get_presence(dev.id)
        effective_mode = pres.mode_hint if pres is not None else dev.mode_hint
        if effective_mode == "encrypted":
            raise ForbiddenError("encrypted devices cannot be accessed through MCP")
        if pres is None:
            raise DeviceOfflineError(f"device {dev.id} is offline")
        return dev

    async def _validate_client_redirect(self, client_id: str, redirect_uri: str) -> McpClientRow:
        client = await self._repo.get_mcp_oauth_client(client_id)
        if client is None:
            raise NotFoundError(f"MCP OAuth client {client_id} not found")
        if redirect_uri not in client.redirect_uris:
            raise ValidationError("redirect_uri is not registered for this MCP client")
        return client


def _rpc_result(req_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _rpc_error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}
