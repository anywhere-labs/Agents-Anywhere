from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable
from typing import Any

from connector.runtimes.claude.sdk.client import maybe_await


async def list_sdk_sessions(
    sdk: Any,
    *,
    directory: str | None = None,
    limit: int | None = 100,
    offset: int = 0,
) -> tuple[Any, ...]:
    list_sessions = _sdk_callable(sdk, "list_sessions")
    result = await _invoke_sdk(
        list_sessions,
        {
            "directory": directory,
            "limit": limit,
            "offset": offset,
            "include_worktrees": True,
        },
    )
    return tuple(await _collect_sequence(result))


async def read_sdk_session_info(
    sdk: Any,
    *,
    session_id: str,
    directory: str | None = None,
) -> Any | None:
    get_session_info = getattr(sdk, "get_session_info", None)
    if not callable(get_session_info):
        return None
    result = await _invoke_sdk(
        get_session_info,
        {"session_id": session_id, "directory": directory},
    )
    return await maybe_await(result)


async def read_sdk_session_messages(
    sdk: Any,
    *,
    session_id: str,
    directory: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> tuple[Any, ...]:
    get_session_messages = _sdk_callable(sdk, "get_session_messages")
    result = await _invoke_sdk(
        get_session_messages,
        {
            "session_id": session_id,
            "directory": directory,
            "limit": limit,
            "offset": offset,
        },
    )
    return tuple(await _collect_sequence(result))


def _sdk_callable(sdk: Any, name: str) -> Callable[..., Any]:
    value = getattr(sdk, name, None)
    if not callable(value):
        raise RuntimeError(f"Claude SDK does not expose {name}()")
    return value


async def _invoke_sdk(fn: Callable[..., Any], kwargs: dict[str, Any]) -> Any:
    call_kwargs = _supported_kwargs(fn, kwargs)
    if inspect.iscoroutinefunction(fn) or inspect.isasyncgenfunction(fn):
        return fn(**call_kwargs)
    return await asyncio.to_thread(fn, **call_kwargs)


async def _collect_sequence(value: Any) -> list[Any]:
    resolved = await maybe_await(value)
    if resolved is None:
        return []
    if hasattr(resolved, "__aiter__"):
        return [item async for item in resolved]
    return list(resolved)


def _supported_kwargs(fn: Callable[..., Any], kwargs: dict[str, Any]) -> dict[str, Any]:
    filtered = {key: value for key, value in kwargs.items() if value is not None}
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return filtered
    if any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    ):
        return filtered
    return {
        key: value
        for key, value in filtered.items()
        if key in signature.parameters
    }
