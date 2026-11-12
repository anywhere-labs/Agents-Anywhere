"""Lossless model + thinking selections in AA's existing opaque selection IDs."""
import base64
import json

from connector.runtime_protocol.models import (
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeReasoningItem,
)

from .definitions import AcpError

PREFIX = "acp-selection:"


def selection_id(model, effort):
    return PREFIX + base64.urlsafe_b64encode(json.dumps([model, effort], separators=(",", ":")).encode()).decode()


def decode_selection(value):
    if not isinstance(value, str) or not value.startswith(PREFIX):
        return {"model": value}
    try:
        model, effort = json.loads(base64.urlsafe_b64decode(value[len(PREFIX):]))
        if not isinstance(model, str) or not isinstance(effort, str):
            raise TypeError()
        return {"model": model, "effort": effort}
    except (ValueError, TypeError, UnicodeError) as error:
        raise AcpError("invalid_selection", "模型与推理强度选择无效。") from error


def model_catalog(snapshot, runtime: str) -> RuntimeModelCatalog:
    """Keep ACP selections typed until the shared wire projection."""
    efforts = [
        value
        for option in snapshot.options
        if option.get("category") == "effort" and option.get("type") == "select"
        for group in option.get("options", [])
        for value in group.get("options", [group])
    ]
    models = tuple(
        RuntimeModelItem(
            id=value["value"],
            title=value["name"],
            selection_id=value["value"],
            reasoning_items=tuple(
                RuntimeReasoningItem(
                    id=effort["value"],
                    title=effort["name"],
                    selection_id=selection_id(value["value"], effort["value"]),
                )
                for effort in efforts
            ),
        )
        for option in snapshot.options
        if option.get("category") == "model" and option.get("type") == "select"
        for group in option.get("options", [])
        for value in group.get("options", [group])
    )
    return RuntimeModelCatalog(runtime=runtime, revision=snapshot.revision, models=models)
