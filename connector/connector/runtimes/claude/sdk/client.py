from __future__ import annotations

import inspect
from collections.abc import AsyncIterator, Callable, Mapping
from typing import Any

from connector.runtimes.claude.domain.models import model_selection_from_selection_id
from connector.runtimes.claude.domain.permissions import (
    permission_mode_from_selection_id,
)
from connector.runtimes.claude.domain.session import ClaudeSession

SdkLoader = Callable[[], Any]
ClaudeClientFactory = Callable[[Any, Any], Any]


def load_sdk(sdk_loader: SdkLoader | None) -> Any:
    if sdk_loader is None:
        raise RuntimeError("Claude SDK loader is not configured")
    return sdk_loader()


def new_sdk_client(
    sdk: Any,
    config_values: Mapping[str, Any],
    session: ClaudeSession,
    client_factory: ClaudeClientFactory | None = None,
    can_use_tool: Any | None = None,
    stderr: Callable[[str], None] | None = None,
) -> Any:
    options = build_sdk_options(
        sdk,
        config_values,
        session,
        can_use_tool=can_use_tool,
        stderr=stderr,
    )
    if client_factory is not None:
        return client_factory(sdk, options)
    client_cls = getattr(sdk, "ClaudeSDKClient", None)
    if client_cls is None:
        raise RuntimeError("ClaudeSDKClient is not available")
    try:
        return client_cls(options=options)
    except TypeError:
        return client_cls(options)


def build_sdk_options(
    sdk: Any,
    config_values: Mapping[str, Any],
    session: ClaudeSession,
    can_use_tool: Any | None = None,
    stderr: Callable[[str], None] | None = None,
) -> Any:
    values = dict(config_values)
    kwargs: dict[str, Any] = {"include_partial_messages": True}
    if session.cwd:
        kwargs["cwd"] = session.cwd
    if session.external_session_id:
        kwargs["resume"] = session.external_session_id
    model_selection = model_selection_from_selection_id(
        session.selections.get("model"),
        values.get("customModels"),
    )
    if model_selection is not None:
        kwargs["model"] = model_selection.model_id
        if model_selection.effort_id is not None:
            kwargs["effort"] = model_selection.effort_id
    permission_mode = permission_mode_from_selection_id(
        session.selections.get("permission")
    )
    if permission_mode is not None:
        kwargs["permission_mode"] = permission_mode
    executable_path = values.get("executablePath")
    if isinstance(executable_path, str) and executable_path:
        kwargs["cli_path"] = executable_path
    environment = values.get("environment")
    if isinstance(environment, Mapping):
        kwargs["env"] = dict(environment)
    if can_use_tool is not None:
        kwargs["can_use_tool"] = can_use_tool
    if stderr is not None:
        kwargs["stderr"] = stderr
    hooks = _permission_hooks(sdk)
    if hooks is not None:
        kwargs["hooks"] = hooks
    options_cls = getattr(sdk, "ClaudeAgentOptions", None) or getattr(
        sdk,
        "ClaudeCodeOptions",
        None,
    )
    if options_cls is None:
        return kwargs
    return options_cls(**kwargs)


async def connect_client(client: Any) -> None:
    connect = getattr(client, "connect", None)
    if callable(connect):
        await maybe_await(connect())


async def disconnect_client(client: Any) -> None:
    disconnect = getattr(client, "disconnect", None)
    if callable(disconnect):
        await maybe_await(disconnect())


async def interrupt_client(client: Any) -> bool:
    interrupt = getattr(client, "interrupt", None)
    if not callable(interrupt):
        return False
    await maybe_await(interrupt())
    return True


async def query_client(client: Any, content: str) -> None:
    query = getattr(client, "query", None)
    if not callable(query):
        raise RuntimeError("ClaudeSDKClient.query is unavailable")
    await maybe_await(query(content))


async def receive_response_messages(client: Any) -> AsyncIterator[Any]:
    receive_response = getattr(client, "receive_response", None)
    if not callable(receive_response):
        return
    response = receive_response()
    if hasattr(response, "__aiter__"):
        async for message in response:
            yield message
        return
    messages = await maybe_await(response)
    if messages is None:
        return
    for message in messages:
        yield message


async def maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _permission_hooks(sdk: Any) -> dict[str, Any] | None:
    hook_matcher = _optional_attr(sdk, "HookMatcher", "types.HookMatcher")
    if hook_matcher is None:
        return None

    async def keep_permission_stream_open(
        _input_data: Any,
        _tool_use_id: Any = None,
        _context: Any = None,
    ) -> dict[str, bool]:
        return {"continue_": True}

    return {
        "PreToolUse": [
            hook_matcher(matcher=None, hooks=[keep_permission_stream_open])
        ]
    }


def _optional_attr(root: Any, *paths: str) -> Any:
    for path in paths:
        current = root
        for part in path.split("."):
            current = getattr(current, part, None)
            if current is None:
                break
        if current is not None:
            return current
    return None
