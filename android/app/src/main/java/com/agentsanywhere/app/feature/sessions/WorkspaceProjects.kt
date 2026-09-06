package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentProject

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

fun workspaceProject(projects: List<AgentProject>, connectorId: String, path: String, deviceOs: String? = null): AgentProject? {
    val key = workspacePathKey(path, deviceOs)
    return projects.firstOrNull { key.isNotBlank() && it.connectorId == connectorId && workspacePathKey(it.workspacePath, deviceOs) == key }
}

fun workspaceProjectName(path: String): String {
    val windows = windowsPath(path, null)
    val normalized = (if (windows) path.trim().replace('\\', '/') else path.trim()).trimEnd('/')
    if (windows && (Regex("^[a-zA-Z]:$").matches(normalized) || Regex("^//[^/]+/[^/]+$").matches(normalized))) return "Workspace"
    return normalized.substringAfterLast('/').ifBlank { "Workspace" }
}

fun availableProjectName(name: String, projects: List<AgentProject>, ignoreId: String? = null, reservedNames: Set<String> = emptySet()): String {
    fun limit(value: String, count: Int): String = value.codePoints().toArray().take(count)
        .let { points -> String(points.toIntArray(), 0, points.size) }
    val base = limit(name.trim().ifBlank { "Workspace" }, 255)
    val names = projects.filterNot { it.id == ignoreId }.mapTo(mutableSetOf()) { it.name }.apply { addAll(reservedNames) }
    var candidate = base
    var suffix = 1
    while (candidate in names) {
        val ending = " (${suffix++})"
        candidate = limit(base, 255 - ending.length) + ending
    }
    return candidate
}
