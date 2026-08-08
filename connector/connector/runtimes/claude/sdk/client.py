from __future__ import annotations

import inspect
from collections.abc import AsyncIterator, Callable, Mapping
from typing import Any

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
) -> Any:
    options = build_sdk_options(sdk, config_values, session, can_use_tool=can_use_tool)
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
) -> Any:
    values = dict(config_values)
    kwargs: dict[str, Any] = {"include_partial_messages": True}
    if session.cwd:
        kwargs["cwd"] = session.cwd
    if session.external_session_id:
        kwargs["resume"] = session.external_session_id
    executable_path = values.get("executablePath")
    if isinstance(executable_path, str) and executable_path:
        kwargs["cli_path"] = executable_path
    environment = values.get("environment")
    if isinstance(environment, Mapping):
        kwargs["env"] = dict(environment)
    if can_use_tool is not None:
        kwargs["can_use_tool"] = can_use_tool
        kwargs.setdefault("permission_prompt_tool_name", "stdio")
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
