from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any


class ClaudeSdkUnavailableError(RuntimeError):
    pass


class ClaudeSdkChatDriver:
    """Thin optional boundary for Claude Agent SDK Chat Mode.

    The project does not yet depend on `claude-agent-sdk`, so this driver
    imports it lazily. It gives the migration a concrete seam for the future
    SDK stream implementation without replacing the existing connector-side
    Claude CLI/PTY adapter before we have real SDK fixtures.
    """

    runtime = "claude"

    def __init__(
        self,
        *,
        sdk_module: Any | None = None,
        permission_handler: Callable[..., Awaitable[Any]] | None = None,
    ) -> None:
        self._sdk_module = sdk_module
        self._permission_handler = permission_handler
        self._clients: dict[str, Any] = {}

    def build_options_kwargs(self, params: dict[str, Any]) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"include_partial_messages": True}
        if isinstance(params.get("cwd"), str) and params["cwd"]:
            kwargs["cwd"] = params["cwd"]
        if isinstance(params.get("externalSessionId"), str) and params["externalSessionId"]:
            kwargs["resume"] = params["externalSessionId"]
        if isinstance(params.get("claudeCliPath"), str) and params["claudeCliPath"]:
            kwargs["cli_path"] = params["claudeCliPath"]
        if isinstance(params.get("permissionMode"), str) and params["permissionMode"]:
            kwargs["permission_mode"] = params["permissionMode"]
        if isinstance(params.get("model"), str) and params["model"]:
            kwargs["model"] = params["model"]
        if isinstance(params.get("effort"), str) and params["effort"]:
            kwargs["effort"] = params["effort"]
        if self._permission_handler is not None:
            kwargs["can_use_tool"] = self._permission_handler
        return kwargs

    async def create_session(self, params: dict[str, Any]) -> dict[str, Any]:
        client = self._client(params)
        session_id = _required(params, "sessionId")
        self._clients[session_id] = client
        connect = getattr(client, "connect", None)
        if callable(connect):
            await connect()
        return {"sessionId": session_id}

    async def start_turn(self, params: dict[str, Any]) -> dict[str, Any]:
        client = self._clients.get(_required(params, "sessionId"))
        if client is None:
            client = self._client(params)
        self._clients[params["sessionId"]] = client
        query = getattr(client, "query", None)
        if not callable(query):
            raise ClaudeSdkUnavailableError("ClaudeSDKClient does not expose query()")
        await query(_required(params, "content"))
        return {"turnId": params.get("turnId")}

    async def interrupt(self, params: dict[str, Any]) -> dict[str, Any]:
        client = self._clients.get(_required(params, "sessionId"))
        if client is None:
            return {"interrupted": False, "reason": "no active Claude SDK client"}
        interrupt = getattr(client, "interrupt", None)
        if not callable(interrupt):
            raise ClaudeSdkUnavailableError("ClaudeSDKClient does not expose interrupt()")
        await interrupt()
        return {"interrupted": True}

    def _client(self, params: dict[str, Any]) -> Any:
        sdk = self._load_sdk()
        options = sdk.ClaudeAgentOptions(**self.build_options_kwargs(params))
        return sdk.ClaudeSDKClient(options=options)

    def _load_sdk(self) -> Any:
        if self._sdk_module is not None:
            return self._sdk_module
        try:
            import claude_agent_sdk  # type: ignore[import-not-found]
        except ModuleNotFoundError as exc:
            raise ClaudeSdkUnavailableError(
                "claude-agent-sdk is not installed; add it before enabling Claude Chat Mode"
            ) from exc
        return claude_agent_sdk


def _required(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"missing {key}")
    return value
