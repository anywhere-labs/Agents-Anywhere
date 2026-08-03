from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimePermissionCatalog,
)

ModelCatalogReader = Callable[[], Awaitable[RuntimeModelCatalog]]
PermissionCatalogReader = Callable[[], Awaitable[RuntimePermissionCatalog]]


async def model_settings_from_selection(
    selection_id: str | None,
    read_catalog: ModelCatalogReader,
) -> dict[str, str]:
    if selection_id is None:
        return {}
    catalog = await read_catalog()
    for model in catalog.models:
        if model.selection_id == selection_id:
            return {"model": model.id}
        for reasoning in model.reasoning_items:
            if reasoning.selection_id == selection_id:
                return {"model": model.id, "effort": reasoning.id}
    raise RuntimeInvalidRequestError(f"unknown Codex model selection: {selection_id}")


async def permission_settings_from_selection(
    selection_id: str | None,
    read_catalog: PermissionCatalogReader,
) -> dict[str, Any]:
    if selection_id is None:
        return {}
    catalog = await read_catalog()
    for permission in catalog.permissions:
        if permission.selection_id == selection_id:
            native = permission.metadata.get("nativeSettings")
            return dict(native) if isinstance(native, dict) else {}
    raise RuntimeInvalidRequestError(
        f"unknown Codex permission selection: {selection_id}"
    )


async def selections_from_thread_state(
    thread: dict[str, Any],
    read_model_catalog: ModelCatalogReader,
    read_permission_catalog: PermissionCatalogReader,
) -> dict[str, str]:
    selections: dict[str, str] = {}
    model_selection = await model_selection_from_thread_state(
        thread, read_model_catalog
    )
    if model_selection is not None:
        selections["model"] = model_selection
    permission_selection = await permission_selection_from_thread_state(
        thread,
        read_permission_catalog,
    )
    if permission_selection is not None:
        selections["permission"] = permission_selection
    return selections


async def model_selection_from_thread_state(
    thread: dict[str, Any],
    read_catalog: ModelCatalogReader,
) -> str | None:
    model_id = _first_string(
        thread,
        "model",
        ("turnStartParams", "model"),
        ("threadSettings", "model"),
        ("settings", "model"),
        ("latestTurnStartParams", "model"),
    )
    if model_id is None:
        return None
    effort = _first_string(
        thread,
        "effort",
        "reasoning",
        "reasoningEffort",
        "reasoning_effort",
        ("turnStartParams", "effort"),
        ("turnStartParams", "reasoning"),
        ("turnStartParams", "reasoningEffort"),
        ("turnStartParams", "reasoning_effort"),
        ("threadSettings", "effort"),
        ("threadSettings", "reasoning"),
        ("threadSettings", "reasoningEffort"),
        ("threadSettings", "reasoning_effort"),
        ("settings", "effort"),
        ("settings", "reasoning"),
        ("settings", "reasoningEffort"),
        ("settings", "reasoning_effort"),
        ("latestTurnStartParams", "effort"),
        ("latestTurnStartParams", "reasoning"),
        ("latestTurnStartParams", "reasoningEffort"),
        ("latestTurnStartParams", "reasoning_effort"),
    )
    catalog = await read_catalog()
    for model in catalog.models:
        if model.id != model_id:
            continue
        if effort is None:
            return model.selection_id
        for reasoning in model.reasoning_items:
            if reasoning.id == effort:
                return reasoning.selection_id
    return None


async def permission_selection_from_thread_state(
    thread: dict[str, Any],
    read_catalog: PermissionCatalogReader,
) -> str | None:
    approval_policy = _first_string(
        thread,
        "approvalPolicy",
        "approval_policy",
        ("turnStartParams", "approvalPolicy"),
        ("turnStartParams", "approval_policy"),
        ("threadSettings", "approvalPolicy"),
        ("threadSettings", "approval_policy"),
        ("settings", "approvalPolicy"),
        ("settings", "approval_policy"),
        ("latestTurnStartParams", "approvalPolicy"),
        ("latestTurnStartParams", "approval_policy"),
    )
    sandbox = _sandbox_mode(
        _first_present(
            thread,
            "sandbox",
            "sandboxPolicy",
            "sandbox_policy",
            ("turnStartParams", "sandbox"),
            ("turnStartParams", "sandboxPolicy"),
            ("turnStartParams", "sandbox_policy"),
            ("threadSettings", "sandbox"),
            ("threadSettings", "sandboxPolicy"),
            ("threadSettings", "sandbox_policy"),
            ("settings", "sandbox"),
            ("settings", "sandboxPolicy"),
            ("settings", "sandbox_policy"),
            ("latestTurnStartParams", "sandbox"),
            ("latestTurnStartParams", "sandboxPolicy"),
            ("latestTurnStartParams", "sandbox_policy"),
        )
    )
    if approval_policy is None and sandbox is None:
        return None
    catalog = await read_catalog()
    for permission in catalog.permissions:
        native = permission.metadata.get("nativeSettings")
        if not isinstance(native, dict):
            continue
        if (
            approval_policy is not None
            and native.get("approvalPolicy") != approval_policy
        ):
            continue
        if sandbox is not None and native.get("sandbox") != sandbox:
            continue
        return permission.selection_id
    return None


def _first_string(
    value: dict[str, Any],
    *paths: str | tuple[str, ...],
) -> str | None:
    for path in paths:
        candidate = _nested_value(value, path)
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _first_present(
    value: dict[str, Any],
    *paths: str | tuple[str, ...],
) -> Any:
    for path in paths:
        candidate = _nested_value(value, path)
        if candidate is not None:
            return candidate
    return None


def _nested_value(value: dict[str, Any], path: str | tuple[str, ...]) -> Any:
    if isinstance(path, str):
        return value.get(path)
    current: Any = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _sandbox_mode(value: Any) -> str | None:
    if isinstance(value, str):
        if value in {"read-only", "workspace-write", "danger-full-access"}:
            return value
        return {
            "readOnly": "read-only",
            "workspaceWrite": "workspace-write",
            "dangerFullAccess": "danger-full-access",
        }.get(value)
    if isinstance(value, dict):
        sandbox_type = value.get("type")
        if isinstance(sandbox_type, str):
            return _sandbox_mode(sandbox_type)
    return None
