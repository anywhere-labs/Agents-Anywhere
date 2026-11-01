"""Model and permission catalogs for ZCode."""

from __future__ import annotations

from connector.runtime_protocol.models import (
    RuntimeModelCatalog,
    RuntimeModelGroup,
    RuntimeModelItem,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeReasoningItem,
)
from connector.runtimes.acp.domain.catalogs import selection_id

ZCODE_PERMISSION_OPTIONS: tuple[tuple[str, str], ...] = (
    ("default", "变更前确认"),
    ("acceptEdits", "自动编辑"),
    ("plan", "计划模式"),
    ("bypassPermissions", "完全访问"),
)

ZCODE_REASONING_LEVELS: tuple[tuple[str, str], ...] = (
    ("low", "低"),
    ("medium", "中"),
    ("high", "高"),
    ("max", "最高"),
)


def load_zcode_model_catalog(
    runtime: str, query: str | None = None, limit: int = 100
) -> RuntimeModelCatalog:
    try:
        from .bridge import zcode_model_catalog
        cat = zcode_model_catalog()
    except Exception:
        return RuntimeModelCatalog(runtime=runtime, revision=0, models=())

    needle = (query or "").strip().lower()
    models: list[RuntimeModelItem] = []
    for m in cat.get("availableModels", []):
        model_id = str(m.get("modelId", ""))
        label = str(m.get("label") or model_id)
        if needle and needle not in model_id.lower() and needle not in label.lower():
            continue
        provider_label = str(m.get("providerLabel") or "ZCode")
        supports_reasoning = m.get("supportsReasoningEffort", True)
        group = RuntimeModelGroup(id=provider_label, title=provider_label)
        reasoning_items = (
            tuple(
                RuntimeReasoningItem(
                    id=effort_id,
                    title=effort_title,
                    selection_id=selection_id(model_id, effort_id),
                )
                for effort_id, effort_title in ZCODE_REASONING_LEVELS
            )
            if supports_reasoning
            else ()
        )
        models.append(
            RuntimeModelItem(
                id=model_id,
                title=label,
                selection_id=model_id,
                reasoning_items=reasoning_items,
                group=group,
            )
        )
    return RuntimeModelCatalog(runtime=runtime, revision=1, models=tuple(models[:limit]))
