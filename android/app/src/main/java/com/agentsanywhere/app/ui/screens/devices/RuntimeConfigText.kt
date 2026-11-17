package com.agentsanywhere.app.ui.screens.devices

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.RuntimeConfigCopy
import com.agentsanywhere.app.feature.devices.RuntimeConfigField
import com.agentsanywhere.app.feature.devices.RuntimeConfigFieldKind
import com.agentsanywhere.app.feature.devices.RuntimeConfigIssue

/** Runtime schemas name their copy with the Web translation keys; these are the ones Android translates. */
@StringRes
private fun runtimeConfigCopyRes(key: String): Int? = when (key) {
    "dashboard.device.runtimeConfigFields.agentCliPath.label" -> R.string.runtime_config_field_agent_cli_path
    "dashboard.device.runtimeConfigFields.claudeExecutablePath.label" -> R.string.runtime_config_field_claude_executable_path
    "dashboard.device.runtimeConfigFields.claudeExecutablePath.description" -> R.string.runtime_config_field_claude_executable_path_description
    "dashboard.device.runtimeConfigFields.codexExecutablePath.label" -> R.string.runtime_config_field_codex_executable_path
    "dashboard.device.runtimeConfigFields.codexExecutablePath.description" -> R.string.runtime_config_field_codex_executable_path_description
    "dashboard.device.runtimeConfigFields.codexHome.label" -> R.string.runtime_config_field_codex_home
    "dashboard.device.runtimeConfigFields.codexHome.description" -> R.string.runtime_config_field_codex_home_description
    "dashboard.device.runtimeConfigFields.useSystemCodex.label" -> R.string.runtime_config_field_use_system_codex
    "dashboard.device.runtimeConfigFields.useSystemCodex.description" -> R.string.runtime_config_field_use_system_codex_description
    "dashboard.device.runtimeConfigFields.ipcEnabled.label" -> R.string.runtime_config_field_ipc_enabled
    "dashboard.device.runtimeConfigFields.ipcEnabled.description" -> R.string.runtime_config_field_ipc_enabled_description
    "dashboard.device.runtimeConfigFields.ipcDeeplinkHandoff.label" -> R.string.runtime_config_field_ipc_deeplink_handoff
    "dashboard.device.runtimeConfigFields.ipcDeeplinkHandoff.description" -> R.string.runtime_config_field_ipc_deeplink_handoff_description
    "dashboard.device.runtimeConfigFields.modelGatewayBaseUrl.label" -> R.string.runtime_config_gateway_url
    "dashboard.device.runtimeConfigFields.modelGatewayBaseUrl.description" -> R.string.runtime_config_gateway_url_description
    "dashboard.device.runtimeConfigFields.modelGatewayApiKey.label" -> R.string.runtime_config_gateway_key
    "dashboard.device.runtimeConfigFields.modelGatewayApiKey.description" -> R.string.runtime_config_gateway_key_description
    "dashboard.device.runtimeConfigComponents.keyValue.label" -> R.string.runtime_config_key_value_label
    "dashboard.device.runtimeConfigComponents.keyValue.description" -> R.string.runtime_config_key_value_description
    "dashboard.device.runtimeConfigComponents.customModels.label" -> R.string.runtime_config_custom_models_label
    "dashboard.device.runtimeConfigComponents.customModels.description" -> R.string.runtime_config_custom_models_description
    "dashboard.device.runtimeConfigComponents.modelGateway.label" -> R.string.runtime_config_model_gateway_label
    "dashboard.device.runtimeConfigComponents.modelGateway.description" -> R.string.runtime_config_model_gateway_description
    else -> null
}

@StringRes
private fun componentLabelRes(kind: RuntimeConfigFieldKind): Int? = when (kind) {
    RuntimeConfigFieldKind.KeyValue -> R.string.runtime_config_key_value_label
    RuntimeConfigFieldKind.CustomModels -> R.string.runtime_config_custom_models_label
    is RuntimeConfigFieldKind.ModelGateway -> R.string.runtime_config_model_gateway_label
    else -> null
}

@StringRes
private fun componentDescriptionRes(kind: RuntimeConfigFieldKind): Int? = when (kind) {
    RuntimeConfigFieldKind.KeyValue -> R.string.runtime_config_key_value_description
    RuntimeConfigFieldKind.CustomModels -> R.string.runtime_config_custom_models_description
    is RuntimeConfigFieldKind.ModelGateway -> R.string.runtime_config_model_gateway_description
    else -> null
}

/** A translation for the schema's key, then the component's own copy, then the schema text. */
@Composable
internal fun runtimeConfigTitle(field: RuntimeConfigField): String {
    if (field.kind is RuntimeConfigFieldKind.ModelGateway && field.required) {
        return stringResource(R.string.runtime_config_model_gateway_required_label)
    }
    val res = field.copy.labelKey?.let(::runtimeConfigCopyRes) ?: componentLabelRes(field.kind)
    return res?.let { stringResource(it) } ?: field.title
}

@Composable
internal fun runtimeConfigDescription(field: RuntimeConfigField): String? {
    if (field.kind is RuntimeConfigFieldKind.ModelGateway && field.required) {
        return stringResource(R.string.runtime_config_model_gateway_required_description)
    }
    val res = field.copy.descriptionKey?.let(::runtimeConfigCopyRes) ?: componentDescriptionRes(field.kind)
    return res?.let { stringResource(it) } ?: field.copy.description
}

@Composable
internal fun runtimeConfigText(copy: RuntimeConfigCopy, @StringRes fallbackTitle: Int): Pair<String, String?> {
    val title = copy.labelKey?.let(::runtimeConfigCopyRes)?.let { stringResource(it) }
        ?: copy.title
        ?: stringResource(fallbackTitle)
    val description = copy.descriptionKey?.let(::runtimeConfigCopyRes)?.let { stringResource(it) } ?: copy.description
    return title to description
}

@StringRes
internal fun runtimeConfigIssueRes(issue: RuntimeConfigIssue): Int = when (issue) {
    RuntimeConfigIssue.Required -> R.string.runtime_config_issue_required
    RuntimeConfigIssue.InvalidNumber -> R.string.runtime_config_issue_number
    RuntimeConfigIssue.InvalidJson -> R.string.runtime_config_issue_json
    RuntimeConfigIssue.DuplicateVariable -> R.string.runtime_config_issue_duplicate_variable
    RuntimeConfigIssue.DuplicateModel -> R.string.runtime_config_issue_duplicate_model
    RuntimeConfigIssue.DuplicateEffort -> R.string.runtime_config_issue_duplicate_effort
    RuntimeConfigIssue.UnsupportedValue -> R.string.runtime_config_issue_unsupported_value
    RuntimeConfigIssue.ChooseOption -> R.string.runtime_config_issue_choose_option
    RuntimeConfigIssue.TooLong -> R.string.runtime_config_issue_too_long
    RuntimeConfigIssue.InvalidFormat -> R.string.runtime_config_issue_format
    RuntimeConfigIssue.OutOfRange -> R.string.runtime_config_issue_range
    RuntimeConfigIssue.InvalidItemCount -> R.string.runtime_config_issue_item_count
    RuntimeConfigIssue.DuplicateItems -> R.string.runtime_config_issue_duplicate_items
    RuntimeConfigIssue.IncompleteGroup -> R.string.runtime_config_issue_incomplete_group
    RuntimeConfigIssue.UnsupportedField -> R.string.runtime_config_issue_unsupported_field
}
