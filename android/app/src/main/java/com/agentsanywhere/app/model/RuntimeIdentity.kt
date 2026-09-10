package com.agentsanywhere.app.model

data class RuntimeInstanceLabels(
    val primary: String,
    val secondary: String?,
)

fun String.runtimeTypeLabel(): String {
    return when (this) {
        "codex" -> "Codex"
        "claude" -> "Claude Code"
        "dsh" -> "DeepSeek Harness"
        else -> replaceFirstChar { char ->
            if (char.isLowerCase()) char.titlecase() else char.toString()
        }
    }
}

fun runtimeInstanceLabels(name: String?, runtimeType: String): RuntimeInstanceLabels {
    val typeLabel = runtimeType.runtimeTypeLabel()
    val instanceName = name?.trim()
        ?.takeIf(String::isNotBlank)
        ?.takeUnless { it.equals(runtimeType, ignoreCase = true) }
    val primary = instanceName ?: typeLabel
    return RuntimeInstanceLabels(
        primary = primary,
        secondary = typeLabel.takeUnless { it.equals(primary, ignoreCase = true) },
    )
}
