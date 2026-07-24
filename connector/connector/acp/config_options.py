"""Helpers for ACP session configOptions → AA runtime schema options."""

from __future__ import annotations

from typing import Any


def extract_model_options(config_options: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    """Return [{value, label}, ...] from ACP configOptions model category."""
    option = find_config_option(config_options, category="model", preferred_ids=("model", "llm", "models"))
    if option is None:
        return []
    values = option.get("options") if isinstance(option.get("options"), list) else []
    out: list[dict[str, str]] = []
    for entry in values:
        if not isinstance(entry, dict):
            continue
        value = entry.get("value")
        if value is None:
            continue
        label = entry.get("name") or entry.get("label") or str(value)
        out.append({"value": str(value), "label": str(label)})
    return out


def extract_mode_options(config_options: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    option = find_config_option(
        config_options,
        category="mode",
        preferred_ids=("mode", "permission", "permissionMode"),
    )
    if option is None:
        return []
    values = option.get("options") if isinstance(option.get("options"), list) else []
    out: list[dict[str, str]] = []
    for entry in values:
        if not isinstance(entry, dict):
            continue
        value = entry.get("value")
        if value is None:
            continue
        label = entry.get("name") or entry.get("label") or str(value)
        out.append({"value": str(value), "label": str(label)})
    return out


def find_config_option(
    config_options: list[dict[str, Any]] | None,
    *,
    category: str | None,
    preferred_ids: tuple[str, ...],
) -> dict[str, Any] | None:
    options = [opt for opt in (config_options or []) if isinstance(opt, dict)]
    if category:
        for opt in options:
            if str(opt.get("category") or "") == category:
                return opt
    for preferred in preferred_ids:
        for opt in options:
            option_id = str(opt.get("id") or "")
            if option_id.lower() == preferred.lower():
                return opt
    for preferred in preferred_ids:
        for opt in options:
            option_id = str(opt.get("id") or "").lower()
            name = str(opt.get("name") or "").lower()
            if preferred.lower() in (option_id, name):
                return opt
    return None


def summarize_auth_methods(auth_methods: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for method in auth_methods or []:
        if not isinstance(method, dict):
            continue
        method_id = method.get("id") or method.get("methodId")
        if not method_id:
            continue
        mid = str(method_id)
        out.append(
            {
                "id": mid,
                "name": str(method.get("name") or mid),
                "interactive": "true" if is_interactive_auth_method(mid) else "false",
            }
        )
    return out


# Methods that open a browser / device-code flow. Calling authenticate() with these
# is a side-effecting action — a short RPC timeout does NOT prevent the browser from opening.
_INTERACTIVE_AUTH_METHOD_IDS = frozenset(
    {
        "ioa",
        "external",
        "internal",
        "selfhosted",
        "oauth",
        "browser",
        "web",
        "device_code",
        "device-code",
        "login",  # bare "login" is usually interactive TUI/browser
    }
)

_INTERACTIVE_AUTH_TOKENS = (
    "oauth",
    "browser",
    "web_login",
    "web-login",
    "device_code",
    "device-code",
    "interactive",
)

# Known headless / cached-credential methods (tried first when advertised).
_HEADLESS_AUTH_METHOD_IDS = (
    "cached_token",
    "cursor_login",
    "xai.api_key",
    "api_key",
    "token",
)


def is_interactive_auth_method(method_id: str) -> bool:
    """Return True if calling authenticate(methodId) is expected to open a browser/TUI."""
    mid = (method_id or "").strip().lower()
    if not mid:
        return True
    if mid in _INTERACTIVE_AUTH_METHOD_IDS:
        return True
    return any(tok in mid for tok in _INTERACTIVE_AUTH_TOKENS)


def order_headless_auth_method_ids(
    advertised: list[str],
    *,
    preferred: list[str] | tuple[str, ...] = (),
) -> list[str]:
    """Order only non-interactive auth method ids that the agent actually advertises.

    Discovery and session start MUST never call interactive OAuth methods — even with
    a short timeout the agent process still opens a browser tab.
    """
    advertised_set = {m for m in advertised if m}
    ordered: list[str] = []
    for mid in (*preferred, *_HEADLESS_AUTH_METHOD_IDS, *advertised):
        if not mid or mid not in advertised_set:
            continue
        if is_interactive_auth_method(mid):
            continue
        if mid not in ordered:
            ordered.append(mid)
    return ordered


def order_interactive_auth_method_ids(
    advertised: list[str],
    *,
    preferred: list[str] | tuple[str, ...] = (),
) -> list[str]:
    """Order interactive OAuth/browser method ids for user-triggered login only."""
    advertised_set = {m for m in advertised if m}
    ordered: list[str] = []
    for mid in (*preferred, *advertised):
        if not mid or mid not in advertised_set:
            continue
        if not is_interactive_auth_method(mid):
            continue
        if mid not in ordered:
            ordered.append(mid)
    return ordered
