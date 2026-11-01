"""Model and permission catalogs for Antigravity."""

from __future__ import annotations

import subprocess
from connector.runtime_protocol.models import (
    RuntimeModelCatalog,
    RuntimeModelGroup,
    RuntimeModelItem,
    RuntimeReasoningItem,
)
from connector.runtimes.acp.domain.catalogs import selection_id
from .discovery import discover_antigravity

ANTIGRAVITY_PERMISSION_OPTIONS: tuple[tuple[str, str], ...] = (
    ("bypassPermissions", "完全访问"),
    ("default", "变更前确认"),
)

ANTIGRAVITY_REASONING_LEVELS: tuple[tuple[str, str], ...] = (
    ("low", "低"),
    ("medium", "中"),
    ("high", "高"),
    ("max", "最高"),
)

DEFAULT_ANTIGRAVITY_MODELS = (
    ("gemini-3.8-flash", "Gemini 3.8 Flash", "Google", True),
    ("claude-sonnet-4-6", "Claude Sonnet 4.6", "Anthropic", True),
    ("claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)", "Anthropic", True),
    ("gpt-oss-120b-medium", "GPT-OSS 120B", "OpenAI", False),
)


def load_antigravity_model_catalog(
    runtime: str, query: str | None = None, limit: int = 100
) -> RuntimeModelCatalog:
    needle = (query or "").strip().lower()
    models: list[RuntimeModelItem] = []

    discovered_models = []
    launch = discover_antigravity()
    if launch:
        try:
            res = subprocess.run(
                [launch.executable, "models"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            for line in res.stdout.splitlines():
                line = line.strip()
                if not line or "..." in line:
                    continue
                parts = line.split(None, 1)
                mid = parts[0]
                label = parts[1] if len(parts) > 1 else mid
                group = "Google" if "gemini" in mid else ("Anthropic" if "claude" in mid else "Antigravity")
                discovered_models.append((mid, label, group, True))
        except Exception:
            pass

    items = discovered_models or DEFAULT_ANTIGRAVITY_MODELS
    for mid, label, group_name, supports_reasoning in items:
        if needle and needle not in mid.lower() and needle not in label.lower():
            continue
        group = RuntimeModelGroup(id=group_name, title=group_name)
        reasoning_items = (
            tuple(
                RuntimeReasoningItem(
                    id=eid,
                    title=etitle,
                    selection_id=selection_id(mid, eid),
                )
                for eid, etitle in ANTIGRAVITY_REASONING_LEVELS
            )
            if supports_reasoning
            else ()
        )
        models.append(
            RuntimeModelItem(
                id=mid,
                title=label,
                selection_id=mid,
                reasoning_items=reasoning_items,
                group=group,
            )
        )
    return RuntimeModelCatalog(runtime=runtime, revision=1, models=tuple(models[:limit]))
