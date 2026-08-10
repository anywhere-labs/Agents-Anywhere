package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession

data class DeviceDetailState(
    val device: AgentDevice?,
    val workspaces: List<DeviceDetailWorkspace>,
    val activeSessions: List<AgentSession>,
    val archivedSessions: List<AgentSession>,
)

data class DeviceDetailWorkspace(
    val path: String?,
    val title: String,
    val detail: String,
    val sessionCount: Int,
    val sortKey: String,
)

fun SessionsState.deviceDetailState(deviceId: String?): DeviceDetailState {
    val device = devices.firstOrNull { it.id == deviceId } ?: devices.firstOrNull()
    val allSessions = sessions + archivedSessions
    val deviceSessions = allSessions.filter { session -> session.connectorId == device?.id }

    return DeviceDetailState(
        device = device,
        workspaces = deviceSessions
            .groupBy { it.cwd?.trim()?.trimEnd('/', '\\')?.takeIf(String::isNotBlank) }
            .map { (path, grouped) ->
                DeviceDetailWorkspace(
                    path = path,
                    title = workspaceTitle(path),
                    detail = path ?: "No working directory",
                    sessionCount = grouped.size,
                    sortKey = grouped.maxOfOrNull { it.sortKey } ?: "",
                )
            }
            .sortedWith(compareByDescending<DeviceDetailWorkspace> { it.sortKey }.thenBy { it.title.lowercase() }),
        activeSessions = sessions.filter { it.connectorId == device?.id },
        archivedSessions = archivedSessions.filter { it.connectorId == device?.id },
    )
}

private fun workspaceTitle(path: String?): String {
    val clean = path?.trimEnd('/', '\\') ?: return "(none)"
    if (clean == "/") return "/"
    return clean.replace('\\', '/').substringAfterLast('/').ifBlank { clean }
}
