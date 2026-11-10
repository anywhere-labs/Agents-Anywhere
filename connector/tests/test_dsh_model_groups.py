from __future__ import annotations

from connector.runtime_protocol import RuntimeModelCatalog, RuntimeModelItem
from connector.runtimes.dsh.bridge.models import model_catalog
from connector.server.runtime_rpc_payloads import model_catalog_payload


def _model(provider: str, provider_name: str, model: str, title: str | None = None,
           model_name: str | None = None) -> dict[str, object]:
    return {
        "id": f"{provider}/{model}",
        "title": title or model,
        "selectionId": f"dsh:model:{provider}-{model}",
        "enabled": True,
        "reasoningItems": [],
        "metadata": {"provider": provider, "providerName": provider_name, "model": model,
                     "modelName": model_name or model},
    }


def _groups(*models: dict[str, object]) -> list[object]:
    payload = model_catalog_payload(model_catalog({"runtime": "dsh", "revision": 1, "models": list(models)}))
    return [model["group"] for model in payload["models"]]


def test_dsh_models_are_grouped_by_the_provider_that_routes_them() -> None:
    # The Bridge title carries the provider for a colliding name; the row under
    # the header does not repeat it.
    assert _groups(
        _model("deepseek", "DeepSeek", "v4", title="v4（DeepSeek）"),
        _model("relay-a", "Relay A", "v4", title="v4（Relay A）"),
        _model("deepseek", "DeepSeek", "v4-flash"),
    ) == [
        {"id": "deepseek", "displayName": "DeepSeek", "itemDisplayName": "v4"},
        {"id": "relay-a", "displayName": "Relay A", "itemDisplayName": "v4"},
        {"id": "deepseek", "displayName": "DeepSeek", "itemDisplayName": "v4-flash"},
    ]


def test_providers_sharing_a_display_name_keep_their_ids_visible() -> None:
    assert [group["displayName"] for group in _groups(  # type: ignore[index]
        _model("relay-a", "Relay", "v4"),
        _model("relay-b", "Relay", "v4"),
        _model("deepseek", "DeepSeek", "v4"),
    )] == ["Relay / relay-a", "Relay / relay-b", "DeepSeek"]


def test_same_name_inside_one_provider_keeps_the_model_id() -> None:
    assert [group["itemDisplayName"] for group in _groups(  # type: ignore[index]
        _model("relay", "Relay", "v4-0601", model_name="DeepSeek V4"),
        _model("relay", "Relay", "v4-0715", model_name="DeepSeek V4"),
        _model("relay", "Relay", "r2", model_name="DeepSeek R2"),
    )] == ["DeepSeek V4 [v4-0601]", "DeepSeek V4 [v4-0715]", "DeepSeek R2"]


def test_missing_provider_metadata_leaves_the_model_ungrouped() -> None:
    bare = _model("x", "X", "v4")
    bare["metadata"] = {}
    unnamed = _model("relay-c", "", "v4")
    unnamed["metadata"] = {"provider": "relay-c", "model": "v4"}
    assert _groups(bare, unnamed) == [
        None,
        {"id": "relay-c", "displayName": "relay-c", "itemDisplayName": None},
    ]


def test_runtimes_without_groups_send_null() -> None:
    catalog = RuntimeModelCatalog(runtime="codex", revision=1, models=(RuntimeModelItem(id="gpt", title="GPT"),))
    assert model_catalog_payload(catalog)["models"][0]["group"] is None
