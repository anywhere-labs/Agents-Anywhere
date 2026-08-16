package com.agentsanywhere.app.feature.sessions

fun String.runtimeLabel(): String {
    return when (this) {
        "codex" -> "Codex"
        "claude" -> "Claude Code"
        "dsh" -> "DeepSeek Harness"
        else -> replaceFirstChar { char ->
            if (char.isLowerCase()) char.titlecase() else char.toString()
        }
    }
}
