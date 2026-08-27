from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import (
    RuntimeAgentPresetCatalog,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInventoryItem,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    SessionNotice,
)


def runtime_config_schema_payload(schema: RuntimeConfigSchema) -> dict[str, Any]:
    return {
        "runtime": schema.runtime,
        "revision": schema.revision,
        "schema": dict(schema.schema),
        "uiSchema": dict(schema.ui_schema) if schema.ui_schema is not None else None,
        "defaults": dict(schema.defaults),
        "metadata": dict(schema.metadata),
    }


def runtime_config_payload(config: RuntimeConfig) -> dict[str, Any]:
    return {
        "runtime": config.runtime,
        "revision": config.revision,
        "values": dict(config.values),
        "schema": dict(config.schema) if config.schema is not None else None,
        "uiSchema": dict(config.ui_schema) if config.ui_schema is not None else None,
        "metadata": dict(config.metadata),
    }


def operation_result_payload(result: RuntimeOperationResult) -> dict[str, Any]:
    payload = _operation_result_without_turn_data(result.result)
    if result.ok and result.code is None and result.message is None:
        return payload
    return {
        "ok": result.ok,
        **({"code": result.code} if result.code is not None else {}),
        **({"message": result.message} if result.message is not None else {}),
        **payload,
    }


def command_result_payload(result: RuntimeCommandResult) -> dict[str, Any]:
    return {
        "command": result.command,
        "ok": result.ok,
        "code": result.code,
        "message": result.message,
        "result": dict(result.result),
    }


def capability_set_payload(capabilities: RuntimeCapabilitySet) -> dict[str, Any]:
    return drop_none_payload(
        {
            "runtime": capabilities.runtime,
            "revision": capabilities.revision,
            "sessionId": capabilities.session_id,
            "connectorId": capabilities.connector_id,
            "capabilities": [
                capability_payload(capability)
                for capability in capabilities.capabilities
            ],
            "metadata": dict(capabilities.metadata),
        }
    )


def capability_payload(capability: RuntimeCapability) -> dict[str, Any]:
    return drop_none_payload(
        {
            "capabilityId": capability.capability_id,
            "version": capability.version,
            "scope": capability.scope,
            "runtime": capability.runtime,
            "sessionId": capability.session_id,
            "connectorId": capability.connector_id,
            "supported": capability.supported,
            "available": capability.available,
            "allowed": capability.allowed,
            "unavailableReason": capability.unavailable_reason,
            "metadata": dict(capability.metadata),
        }
    )


def drop_none_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}


def server_payload_without_turn_data(value: Any) -> Any:
    """Remove runtime-owned turn details from data crossing into Server."""

    if isinstance(value, Mapping):
        return {
            key: server_payload_without_turn_data(item)
            for key, item in value.items()
            if key not in {"turnId", "turn_id"}
        }
    if isinstance(value, (list, tuple)):
        return [server_payload_without_turn_data(item) for item in value]
    return value


def _operation_result_without_turn_data(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            key: _operation_result_without_turn_data(item)
            for key, item in value.items()
            if key not in {"turn", "turnId", "turn_id"}
        }
    if isinstance(value, (list, tuple)):
        return [_operation_result_without_turn_data(item) for item in value]
    return value


def runtime_command_payload(command: RuntimeCommand) -> dict[str, Any]:
    return {
        "id": command.id,
        "title": command.title,
        "description": command.description,
        "aliases": list(command.aliases),
        "category": command.category,
        "scope": command.scope,
        "enabled": command.enabled,
        "disabledReason": command.disabled_reason,
        "acceptsArgs": command.accepts_args,
        "argsSchema": dict(command.args_schema) if command.args_schema is not None else None,
        "metadata": dict(command.metadata),
    }


def session_state_payload(state: Any) -> dict[str, Any]:
    return {
        "sessionId": state.session_id,
        "runtime": state.runtime,
        "externalSessionId": state.external_session_id,
        "status": state.status,
        "selections": dict(state.selections),
        "statusReason": state.status_reason,
        "error": dict(state.error) if state.error is not None else None,
        "metadata": dict(state.metadata),
    }


def session_notice_payload(notice: SessionNotice) -> dict[str, Any]:
    return drop_none_payload(
        {
            "noticeId": notice.notice_id,
            "sessionId": notice.session_id,
            "source": {"runtime": notice.runtime, **dict(notice.source)},
            "type": notice.type,
            "title": notice.title,
            "message": notice.message,
            "severity": notice.severity,
            "status": notice.status,
            "interactionType": notice.interaction_type,
            "blocking": dict(notice.blocking) if notice.blocking is not None else None,
            "responseRequired": notice.response_required,
            "actions": [dict(action) for action in notice.actions],
            "context": dict(notice.context),
            "metadata": dict(notice.metadata),
        }
    )


def model_catalog_payload(catalog: RuntimeModelCatalog) -> dict[str, Any]:
    return {
        "runtime": catalog.runtime,
        "revision": catalog.revision,
        "models": [
            {
                "id": model.id,
                "displayName": model.title,
                "selectionId": model.selection_id,
                "description": model.description,
                "default": model.default,
                "reasoningItems": [
                    {
                        "id": reasoning.id,
                        "displayName": reasoning.title,
                        "selectionId": reasoning.selection_id,
                        "description": reasoning.description,
                        "default": reasoning.default,
                        "metadata": {
                            **dict(reasoning.metadata),
                            "enabled": reasoning.enabled,
                            **(
                                {"disabledReason": reasoning.disabled_reason}
                                if reasoning.disabled_reason is not None
                                else {}
                            ),
                        },
                    }
                    for reasoning in model.reasoning_items
                ],
                "metadata": {
                    **dict(model.metadata),
                    "enabled": model.enabled,
                    **(
                        {"disabledReason": model.disabled_reason}
                        if model.disabled_reason is not None
                        else {}
                    ),
                },
            }
            for model in catalog.models
        ],
    }


def permission_catalog_payload(catalog: RuntimePermissionCatalog) -> dict[str, Any]:
    return {
        "runtime": catalog.runtime,
        "revision": catalog.revision,
        "permissions": [
            {
                "id": permission.id,
                "displayName": permission.title,
                "selectionId": permission.selection_id,
                "description": permission.description,
                "default": False,
                "metadata": {
                    **dict(permission.metadata),
                    "enabled": permission.enabled,
                    **(
                        {"disabledReason": permission.disabled_reason}
                        if permission.disabled_reason is not None
                        else {}
                    ),
                },
            }
            for permission in catalog.permissions
        ],
    }


def agent_preset_catalog_payload(catalog: RuntimeAgentPresetCatalog) -> dict[str, Any]:
    return {
        "runtime": catalog.runtime,
        "revision": catalog.revision,
        "presets": [
            {
                "id": preset.id,
                "displayName": preset.title,
                "agentPreset": preset.agent_preset,
                "description": preset.description,
                "default": preset.default,
                "enabled": preset.enabled,
                "disabledReason": preset.disabled_reason,
                "metadata": dict(preset.metadata),
            }
            for preset in catalog.presets
        ],
    }


def session_meta_payload(session: Any) -> dict[str, Any]:
    return {
        "sessionId": session.session_id,
        "externalSessionId": session.external_session_id,
        "runtime": session.runtime,
        "title": session.title,
        "cwd": session.cwd,
        "orderingTime": session.ordering_time,
        "metadata": dict(session.metadata),
    }


def agent_inventory_payload(item: RuntimeInventoryItem) -> dict[str, Any]:
    return {
        "runtimeId": item.runtime,
        "runtimeType": item.runtime_type,
        "displayName": item.display_name,
        "discovery": {
            "available": item.available,
            **({"reason": item.reason} if item.reason is not None else {}),
        },
        "schema": item.config_schema.schema if item.config_schema is not None else None,
        "uiSchema": item.config_schema.ui_schema if item.config_schema is not None else None,
        "defaults": item.config_schema.defaults if item.config_schema is not None else {},
        "status": "available" if item.available else "unavailable",
        "configured": item.configured,
        "capabilities": dict(item.capabilities),
        "metadata": dict(item.metadata),
    }
