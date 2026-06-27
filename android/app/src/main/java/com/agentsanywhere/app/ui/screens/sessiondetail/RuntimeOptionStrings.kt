package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.RuntimeConfigField
import com.agentsanywhere.app.feature.sessiondetail.RuntimeConfigOption

@Composable
internal fun localizedRuntimeOptionLabel(field: RuntimeConfigField, option: RuntimeConfigOption): String {
    return when (field.key) {
        "permissionMode" -> option.label.ifBlank { permissionModeFallbackLabel(option.value) }
        "effort" -> when (option.value) {
            "low" -> stringResource(R.string.runtime_effort_low)
            "medium" -> stringResource(R.string.runtime_effort_medium)
            "high" -> stringResource(R.string.runtime_effort_high)
            "xhigh" -> stringResource(R.string.runtime_effort_xhigh)
            "max" -> stringResource(R.string.runtime_effort_max)
            else -> option.label.ifBlank { option.value }
        }
        else -> option.label.ifBlank { option.value }
    }
}

@Composable
internal fun localizedRuntimeOptionDescription(field: RuntimeConfigField, option: RuntimeConfigOption): String? {
    val description = option.description?.takeIf { it.isNotBlank() } ?: return null
    if (field.key == "permissionMode") {
        return when (option.value) {
            "ask" -> stringResource(R.string.runtime_permission_desc_ask)
            "auto" -> stringResource(R.string.runtime_permission_desc_auto)
            "fullAccess" -> stringResource(R.string.runtime_permission_desc_full_access)
            else -> description
        }
    }
    return when (description) {
        "Default. Large refactors, complex debugging." -> stringResource(R.string.runtime_desc_opus_default)
        "Opus 4.7 with 1M context window." -> stringResource(R.string.runtime_desc_opus_context)
        "Day-to-day workhorse." -> stringResource(R.string.runtime_desc_sonnet_workhorse)
        "Simple / fast." -> stringResource(R.string.runtime_desc_haiku_fast)
        "Legacy Opus, kept for compatibility." -> stringResource(R.string.runtime_desc_legacy)
        else -> description
    }
}

private fun permissionModeFallbackLabel(value: String): String {
    return when (value) {
        "default" -> "Ask permissions"
        "acceptEdits" -> "Accept edits"
        "plan" -> "Plan mode"
        "bypassPermissions" -> "Bypass permissions"
        "ask" -> "Ask for approval"
        "auto" -> "Approve for me"
        "fullAccess" -> "Full access"
        else -> value
    }
}
