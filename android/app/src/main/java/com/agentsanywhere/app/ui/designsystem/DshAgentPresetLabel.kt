package com.agentsanywhere.app.ui.designsystem

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.agentsanywhere.app.R

@Composable
fun dshAgentPresetLabel(id: String, label: String = id): String {
    // Built-in preset ids usually publish no display name (DSH deployments
    // echo the id as name), so the localized mapping wins for those ids.
    val localized = when (id.lowercase()) {
        "standard" -> stringResource(R.string.dsh_agent_preset_standard)
        "ptc" -> stringResource(R.string.dsh_agent_preset_ptc)
        "minimal" -> stringResource(R.string.dsh_agent_preset_minimal)
        "cordis" -> stringResource(R.string.dsh_agent_preset_cordis)
        else -> null
    }
    if (localized != null) return localized
    // Deployment-provided presets publish their own human-readable names.
    return label.trim().takeIf { it.isNotEmpty() && !it.equals(id, ignoreCase = true) } ?: id
}
