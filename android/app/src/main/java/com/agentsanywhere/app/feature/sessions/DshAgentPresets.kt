package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.feature.devices.DeviceRuntime

data class DshAgentPresetOption(
    val id: String,
    val label: String,
    val enabled: Boolean,
)

fun dshAgentPresetOptions(runtime: DeviceRuntime?): List<DshAgentPresetOption> {
    if (runtime?.type != "dsh") return emptyList()
    val field = runtime.uiSchema["defaultAgentPreset"] as? Map<*, *> ?: return emptyList()
    val options = field["options"] as? List<*> ?: return emptyList()
    return options.mapNotNull { value ->
        val option = value as? Map<*, *> ?: return@mapNotNull null
        val id = (option["value"] as? String)?.trim()?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
        DshAgentPresetOption(
            id = id,
            label = (option["label"] as? String)?.trim()?.takeIf(String::isNotEmpty) ?: id,
            enabled = option["disabled"] != true,
        )
    }
}

fun dshNewSessionAgentPreset(
    runtime: DeviceRuntime?,
    options: List<DshAgentPresetOption>,
    selectedId: String?,
): String? {
    if (runtime?.type != "dsh") return null
    val schemaProperties = runtime.schema?.get("properties") as? Map<*, *>
    val presetSchema = schemaProperties?.get("defaultAgentPreset") as? Map<*, *>
    val defaultId = listOf(
        runtime.config?.get("defaultAgentPreset"),
        runtime.defaults["defaultAgentPreset"],
        presetSchema?.get("default"),
    ).firstNotNullOfOrNull { (it as? String)?.trim()?.takeIf(String::isNotEmpty) }
    if (options.isEmpty()) return defaultId
    return listOfNotNull(selectedId, defaultId)
        .firstOrNull { id -> options.any { it.id == id && it.enabled } }
        ?: options.firstOrNull(DshAgentPresetOption::enabled)?.id
}
