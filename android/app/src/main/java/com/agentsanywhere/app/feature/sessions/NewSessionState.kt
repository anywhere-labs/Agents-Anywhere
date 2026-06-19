package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession

data class NewSessionState(
    val title: String = "New Session",
    val selectedDeviceId: String? = null,
    val selectedRuntime: String? = null,
    val selectedWorkspacePath: String = "~",
    val homePath: String? = null,
    val currentPath: String = "~",
    val pathEntries: List<NewSessionPathEntry> = emptyList(),
    val isLoadingPath: Boolean = false,
    val isCreating: Boolean = false,
    val errorMessage: String? = null,
    val pathErrorMessage: String? = null,
)

data class NewSessionAgent(
    val runtime: String,
    val label: String,
)

data class NewSessionWorkspace(
    val title: String,
    val path: String,
    val detail: String,
    val home: Boolean = false,
)

data class NewSessionPathEntry(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val size: Long?,
)

data class NewSessionDirectory(
    val path: String,
    val entries: List<NewSessionPathEntry>,
)

fun AgentDevice.newSessionAgents(): List<NewSessionAgent> {
    return attachedRuntimes
        .map { runtime -> NewSessionAgent(runtime = runtime, label = runtime.runtimeLabel()) }
        .sortedBy { it.label.lowercase() }
}

fun workspaceOptionsFor(
    sessions: List<AgentSession>,
    deviceId: String?,
    homePath: String?,
): List<NewSessionWorkspace> {
    val home = homePath?.takeIf { it.isNotBlank() } ?: "~"
    val existing = sessions
        .asSequence()
        .filter { session -> deviceId == null || session.connectorId == deviceId }
        .mapNotNull { it.cwd?.trim()?.trimEnd('/')?.takeIf(String::isNotBlank) }
        .distinct()
        .filterNot { it == home }
        .map { path ->
            NewSessionWorkspace(
                title = workspaceTitle(path, homePath),
                path = path,
                detail = pathDisplay(path, homePath),
            )
        }
        .sortedBy { it.title.lowercase() }
        .toList()

    return listOf(
        NewSessionWorkspace(
            title = "Home directory",
            path = home,
            detail = pathDisplay(home, homePath),
            home = true,
        ),
    ) + existing
}

fun parentPath(path: String): String {
    val clean = path.trim().trimEnd('/', '\\').ifBlank { "." }
    if (clean == "." || clean == "/" || Regex("^[A-Za-z]:[\\\\/]?$").matches(clean)) return ""
    val normalized = clean.replace('\\', '/')
    val slash = normalized.lastIndexOf("/")
    return when {
        slash < 0 -> "."
        slash == 0 -> "/"
        else -> normalized.take(slash)
    }
}

private fun workspaceTitle(path: String, homePath: String?): String {
    val home = homePath?.trimEnd('/')
    if (!home.isNullOrBlank() && path.trimEnd('/') == home) return "Home directory"
    return path.trimEnd('/').substringAfterLast('/').ifBlank { path }
}

private fun pathDisplay(path: String, homePath: String?): String {
    val home = homePath?.trimEnd('/')?.takeIf { it.isNotBlank() } ?: return path
    val clean = path.trimEnd('/')
    if (clean == home) return home
    if (!clean.startsWith("$home/")) return path
    return "~/${clean.removePrefix("$home/")}"
}
