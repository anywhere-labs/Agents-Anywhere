from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from connector.runtimes.claude import permissions as permission_catalogs
from connector.runtimes.claude import utils


def sdk_options(
    sdk: Any,
    config_values: Mapping[str, Any],
    cwd: str | None,
    external_session_id: str | None,
    permission_selection: str | None,
    can_use_tool: Callable[[str, dict[str, Any], Any], Any] | None = None,
) -> Any:
    kwargs: dict[str, Any] = {
        "include_partial_messages": True,
    }
    if can_use_tool is not None:
        kwargs["can_use_tool"] = can_use_tool
    if cwd:
        kwargs["cwd"] = cwd
    if external_session_id:
        kwargs["resume"] = external_session_id
    executable_path = config_values.get("executablePath")
    if isinstance(executable_path, str) and executable_path:
        kwargs["cli_path"] = executable_path
    environment = config_values.get("environment")
    if isinstance(environment, Mapping):
        kwargs["env"] = dict(environment)
    permission_mode = permission_catalogs.permission_mode_from_selection(
        permission_selection
    )
    if permission_mode:
        kwargs["permission_mode"] = permission_mode
    hook_matcher = utils.optional_attr(sdk, "HookMatcher", "types.HookMatcher")
    if hook_matcher is not None:

        async def _keep_permission_stream_open(
            _input_data: Any,
            _tool_use_id: Any = None,
            _context: Any = None,
        ) -> dict[str, bool]:
            return {"continue_": True}

        kwargs["hooks"] = {
            "PreToolUse": [
                hook_matcher(matcher=None, hooks=[_keep_permission_stream_open])
            ]
        }
    options_cls = getattr(sdk, "ClaudeAgentOptions", None) or getattr(
        sdk, "ClaudeCodeOptions", None
    )
    if options_cls is None:
        return kwargs
    return options_cls(**kwargs)
