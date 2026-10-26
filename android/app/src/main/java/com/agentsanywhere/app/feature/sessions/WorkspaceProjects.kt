package com.agentsanywhere.app.feature.sessions


private fun windowsPath(path: String, deviceOs: String?) = deviceOs == "windows"
    || Regex("^[a-zA-Z]:[/\\\\]").containsMatchIn(path) || path.startsWith("\\\\")

fun workspacePathKey(path: String, deviceOs: String? = null): String {
    val trimmed = path.trim()
    val windows = windowsPath(trimmed, deviceOs)
    val slashes = if (windows) trimmed.replace('\\', '/') else trimmed
    val parts = mutableListOf<String>()
    slashes.split('/').forEach { part ->
        when {
            part.isEmpty() || part == "." -> Unit
            !windows && part == ".." -> if (parts.isNotEmpty()) parts.removeAt(parts.lastIndex) else Unit
            else -> parts.add(part)
        }
    }
    val prefix = when {
        slashes.startsWith("//") && !slashes.startsWith("///") -> "//"
        slashes.startsWith('/') -> "/"
        else -> ""
    }
    val key = prefix + parts.joinToString("/")
    return if (windows) key.lowercase(java.util.Locale.ROOT) else key
}

fun workspaceProjectName(path: String): String {
    val windows = windowsPath(path, null)
    val normalized = (if (windows) path.trim().replace('\\', '/') else path.trim()).trimEnd('/')
    if (windows && (Regex("^[a-zA-Z]:$").matches(normalized) || Regex("^//[^/]+/[^/]+$").matches(normalized))) return "Workspace"
    return normalized.substringAfterLast('/').ifBlank { "Workspace" }
}
