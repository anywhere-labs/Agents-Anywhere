from __future__ import annotations

from connector.acp.config_options import (
    extract_mode_options,
    extract_model_options,
    find_config_option,
    is_interactive_auth_method,
    order_headless_auth_method_ids,
    order_interactive_auth_method_ids,
    summarize_auth_methods,
)


def test_extract_model_options_from_config_options() -> None:
    options = [
        {
            "id": "mode",
            "category": "mode",
            "options": [{"value": "ask", "name": "Ask"}],
        },
        {
            "id": "model",
            "category": "model",
            "options": [
                {"value": "m1", "name": "Model One"},
                {"value": "m2", "name": "Model Two"},
            ],
        },
    ]
    models = extract_model_options(options)
    assert models == [
        {"value": "m1", "label": "Model One"},
        {"value": "m2", "label": "Model Two"},
    ]
    modes = extract_mode_options(options)
    assert modes == [{"value": "ask", "label": "Ask"}]
    assert find_config_option(options, category="model", preferred_ids=("model",))["id"] == "model"


def test_summarize_auth_methods() -> None:
    methods = summarize_auth_methods(
        [
            {"id": "iOA", "name": "Login with iOA"},
            {"id": "external", "name": "Login with Google/Github"},
            {"id": "cached_token", "name": "Cached token"},
        ]
    )
    assert methods[0]["id"] == "iOA"
    assert methods[0]["interactive"] == "true"
    assert "Google" in methods[1]["name"]
    assert methods[1]["interactive"] == "true"
    assert methods[2]["interactive"] == "false"


def test_codebuddy_auth_methods_are_all_interactive() -> None:
    """CodeBuddy advertises only browser/TUI methods — discovery must not call them."""
    advertised = ["iOA", "external", "internal", "selfhosted"]
    assert all(is_interactive_auth_method(m) for m in advertised)
    assert order_headless_auth_method_ids(advertised) == []


def test_order_headless_skips_interactive_keeps_cached() -> None:
    ordered = order_headless_auth_method_ids(
        ["iOA", "external", "cached_token", "cursor_login"],
        preferred=("cursor_login",),
    )
    assert ordered == ["cursor_login", "cached_token"]
    assert not any(is_interactive_auth_method(m) for m in ordered)


def test_order_interactive_for_user_triggered_login() -> None:
    ordered = order_interactive_auth_method_ids(
        ["iOA", "external", "cached_token", "selfhosted"],
        preferred=("external",),
    )
    assert ordered == ["external", "iOA", "selfhosted"]
    assert all(is_interactive_auth_method(m) for m in ordered)
