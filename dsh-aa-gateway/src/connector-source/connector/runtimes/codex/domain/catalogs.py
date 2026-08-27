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
        model for model in (_model_item(item) for item in items) if model is not None
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
    return RuntimePermissionCatalog(
        runtime="codex", revision=revision, permissions=permissions
    )


def codex_permission_catalog_items() -> list[dict[str, Any]]:
    return [
        {
            "id": "request_approval",
            "label": "Request approval",
            "description": "Always ask before editing files outside the workspace or using the internet.",
            "identity": {"permission_mode": "request_approval"},
            "runtimeSettings": {"permissionMode": "request_approval"},
            "nativeSettings": {
                "approvalPolicy": "on-request",
                "approvalsReviewer": "user",
                "sandbox": "workspace-write",
                "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            },
            "i18n": {
                "labelKey": "dashboard.new.permissionModes.requestApproval.label",
                "descriptionKey": "dashboard.new.permissionModes.requestApproval.description",
            },
        },
        {
            "id": "auto_review",
            "label": "Auto review",
            "description": "Only ask for approval when Codex detects a risky operation.",
            "identity": {"permission_mode": "auto_review"},
            "runtimeSettings": {"permissionMode": "auto_review"},
            "nativeSettings": {
                "approvalPolicy": "on-request",
                "approvalsReviewer": "auto_review",
                "sandbox": "workspace-write",
                "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            },
            "i18n": {
                "labelKey": "dashboard.new.permissionModes.autoReview.label",
                "descriptionKey": "dashboard.new.permissionModes.autoReview.description",
            },
        },
        {
            "id": "full_access",
            "label": "Full access",
            "description": "Allow unrestricted internet access and access to any file on this computer.",
            "identity": {"permission_mode": "full_access"},
            "runtimeSettings": {"permissionMode": "full_access"},
            "nativeSettings": {
                "approvalPolicy": "never",
                "sandbox": "danger-full-access",
                "sandboxPolicy": {"type": "dangerFullAccess"},
            },
            "i18n": {
                "labelKey": "dashboard.new.permissionModes.fullAccess.label",
                "descriptionKey": "dashboard.new.permissionModes.fullAccess.description",
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
        title=_first_string(item, "displayName", "display_name", "label", "name")
        or model_id,
        selection_id=None
        if reasoning_items
        else protocol_selection_id(
            "codex", "model", {"model_id": model_id, "reasoning_id": None}
        ),
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
                title=_first_string(
                    item, "displayName", "display_name", "label", "name"
                )
                or _reasoning_label(reasoning_id),
                selection_id=protocol_selection_id(
                    "codex",
                    "model",
                    {"model_id": model_id, "reasoning_id": reasoning_id},
                ),
                metadata={"source": "codex.model/list", "raw": item},
            )
        )
    return tuple(result)


def _permission_item(item: dict[str, Any]) -> RuntimePermissionItem | None:
    permission_id = _first_string(item, "id")
    title = _first_string(item, "label", "displayName", "display_name", "name")
    if permission_id is None or title is None:
        return None
    identity = (
        item.get("identity")
        if isinstance(item.get("identity"), dict)
        else {"permission_id": permission_id}
    )
    metadata = {"source": "codex.static-permissions"}
    if isinstance(item.get("runtimeSettings"), dict):
        metadata["runtimeSettings"] = item["runtimeSettings"]
    if isinstance(item.get("nativeSettings"), dict):
        metadata["nativeSettings"] = item["nativeSettings"]
    if isinstance(item.get("i18n"), dict):
        metadata["i18n"] = item["i18n"]
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
