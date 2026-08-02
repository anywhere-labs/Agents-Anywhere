from __future__ import annotations

from typing import Any

from connector.runtime_protocol import (
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeReasoningItem,
)
from connector.server.protocol import protocol_selection_id


def model_catalog_from_codex_items(
    items: list[dict[str, Any]],
    revision: int,
) -> RuntimeModelCatalog:
    models = tuple(
        model
        for model in (_model_item(item) for item in items)
        if model is not None
    )
    return RuntimeModelCatalog(runtime="codex", revision=revision, models=models)


def permission_catalog_from_codex_items(
    items: list[dict[str, Any]],
    revision: int,
) -> RuntimePermissionCatalog:
    permissions = tuple(
        permission
        for permission in (_permission_item(item) for item in items)
        if permission is not None
    )
    return RuntimePermissionCatalog(runtime="codex", revision=revision, permissions=permissions)


def codex_permission_catalog_items() -> list[dict[str, Any]]:
    return [
        {
            "id": "untrusted_workspace_write",
            "label": "Ask for untrusted commands",
            "description": "Run trusted commands automatically in workspace-write sandbox; ask before untrusted commands.",
            "identity": {
                "approval_policy": "untrusted",
                "sandbox": "workspace-write",
            },
            "runtimeSettings": {"permissionMode": "untrusted_workspace_write"},
            "nativeSettings": {
                "approvalPolicy": "untrusted",
                "sandbox": "workspace-write",
                "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            },
        },
        {
            "id": "on_request_workspace_write",
            "label": "Ask when requested",
            "description": "Use workspace-write sandbox and let the model decide when to ask for approval.",
            "identity": {
                "approval_policy": "on-request",
                "sandbox": "workspace-write",
            },
            "runtimeSettings": {"permissionMode": "on_request_workspace_write"},
            "nativeSettings": {
                "approvalPolicy": "on-request",
                "sandbox": "workspace-write",
                "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            },
        },
        {
            "id": "on_request_read_only",
            "label": "Read only",
            "description": "Run commands in read-only sandbox; ask before work that needs writes.",
            "identity": {
                "approval_policy": "on-request",
                "sandbox": "read-only",
            },
            "runtimeSettings": {"permissionMode": "on_request_read_only"},
            "nativeSettings": {
                "approvalPolicy": "on-request",
                "sandbox": "read-only",
                "sandboxPolicy": {"type": "readOnly", "networkAccess": False},
            },
        },
        {
            "id": "never_workspace_write",
            "label": "Never ask, workspace write",
            "description": "Do not prompt for approvals; failures are returned to the model. Commands stay sandboxed to workspace writes.",
            "identity": {
                "approval_policy": "never",
                "sandbox": "workspace-write",
            },
            "runtimeSettings": {"permissionMode": "never_workspace_write"},
            "nativeSettings": {
                "approvalPolicy": "never",
                "sandbox": "workspace-write",
                "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            },
        },
        {
            "id": "never_danger_full_access",
            "label": "Full access ⚠️",
            "description": "Never ask and run without sandboxing. Use only in externally sandboxed environments.",
            "identity": {
                "approval_policy": "never",
                "sandbox": "danger-full-access",
            },
            "runtimeSettings": {"permissionMode": "never_danger_full_access"},
            "nativeSettings": {
                "approvalPolicy": "never",
                "sandbox": "danger-full-access",
                "sandboxPolicy": {"type": "dangerFullAccess"},
            },
        },
    ]


def _model_item(item: dict[str, Any]) -> RuntimeModelItem | None:
    model_id = _first_string(item, "id", "model", "modelId", "model_id", "name")
    if model_id is None:
        return None
    reasoning_items = _reasoning_items(
        model_id,
        _first_list(
            item,
            "reasoningItems",
            "reasoning_items",
            "reasoningEfforts",
            "reasoning_efforts",
            "supportedReasoningEfforts",
            "supported_reasoning_efforts",
            "efforts",
        ),
    )
    return RuntimeModelItem(
        id=model_id,
        title=_first_string(item, "displayName", "display_name", "label", "name") or model_id,
        selection_id=None
        if reasoning_items
        else protocol_selection_id("codex", "model", {"model_id": model_id, "reasoning_id": None}),
        description=_first_string(item, "description"),
        reasoning_items=reasoning_items,
        metadata={"source": "codex.model/list", "raw": item},
    )


def _reasoning_items(
    model_id: str,
    raw_items: list[Any],
) -> tuple[RuntimeReasoningItem, ...]:
    result: list[RuntimeReasoningItem] = []
    for raw in raw_items:
        item = raw if isinstance(raw, dict) else {"id": raw}
        reasoning_id = _first_string(
            item,
            "id",
            "reasoningEffort",
            "reasoning_effort",
            "effort",
            "reasoning",
            "value",
            "name",
        )
        if reasoning_id is None:
            continue
        result.append(
            RuntimeReasoningItem(
                id=reasoning_id,
                title=_first_string(item, "displayName", "display_name", "label", "name")
                or _reasoning_label(reasoning_id),
                selection_id=protocol_selection_id(
                    "codex",
                    "model",
                    {"model_id": model_id, "reasoning_id": reasoning_id},
                ),
                description=_first_string(item, "description"),
                metadata={"source": "codex.model/list", "raw": item},
            )
        )
    return tuple(result)


def _permission_item(item: dict[str, Any]) -> RuntimePermissionItem | None:
    permission_id = _first_string(item, "id")
    title = _first_string(item, "label", "displayName", "display_name", "name")
    if permission_id is None or title is None:
        return None
    identity = item.get("identity") if isinstance(item.get("identity"), dict) else {"permission_id": permission_id}
    metadata = {"source": "codex.static-permissions"}
    if isinstance(item.get("runtimeSettings"), dict):
        metadata["runtimeSettings"] = item["runtimeSettings"]
    if isinstance(item.get("nativeSettings"), dict):
        metadata["nativeSettings"] = item["nativeSettings"]
    return RuntimePermissionItem(
        id=permission_id,
        title=title,
        selection_id=protocol_selection_id("codex", "permission", identity),
        description=_first_string(item, "description"),
        metadata=metadata,
    )


def _first_string(item: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _first_list(item: dict[str, Any], *keys: str) -> list[Any]:
    for key in keys:
        value = item.get(key)
        if isinstance(value, list):
            return value
    return []


def _reasoning_label(reasoning_id: str) -> str:
    return {
        "low": "Low",
        "medium": "Medium",
        "high": "High",
        "xhigh": "Extra high",
        "max": "Max",
        "ultra": "Ultra",
    }.get(reasoning_id, reasoning_id)
