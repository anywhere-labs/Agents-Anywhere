package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession

enum class SessionFilterPage(val title: String) {
    Agent("Agent"),
    Device("Device"),
    Workspace("Workspace"),
}

data class SessionFilterState(
    val agentRuntime: String? = null,
    val deviceId: String? = null,
    val workspace: String? = null,
) {
    val isActive: Boolean
        get() = agentRuntime != null || deviceId != null || workspace != null
}

data class SessionFilterOption(
    val value: String?,
    val label: String,
    val count: Int,
    val selected: Boolean,
    val enabled: Boolean = true,
)

const val AllWorkspaceLabel = "(none)"

fun SessionFilterState.updatedFor(
    page: SessionFilterPage,
    value: String?,
): SessionFilterState {
    return when (page) {
        SessionFilterPage.Agent -> copy(agentRuntime = value)
        SessionFilterPage.Device -> copy(deviceId = value)
        SessionFilterPage.Workspace -> copy(workspace = value)
    }
}

fun List<AgentSession>.filteredBy(filters: SessionFilterState): List<AgentSession> {
    return filter { session ->
        (filters.agentRuntime == null || session.runtime == filters.agentRuntime) &&
            (filters.deviceId == null || session.connectorId == filters.deviceId) &&
            (filters.workspace == null || session.workspaceFilterLabel() == filters.workspace)
    }
}

fun filterOptionsFor(
    page: SessionFilterPage,
    sessions: List<AgentSession>,
    devices: List<AgentDevice>,
    filters: SessionFilterState,
): List<SessionFilterOption> {
    return when (page) {
        SessionFilterPage.Agent -> {
            val runtimeLabels = linkedMapOf<String, String>()
            devices.forEach { device ->
                device.attachedRuntimes.forEach { runtime ->
                    runtimeLabels.putIfAbsent(runtime, runtime.runtimeLabel())
                }
            }
            sessions.forEach { session ->
                runtimeLabels.putIfAbsent(session.runtime, session.runtimeLabel)
            }
            val options = runtimeLabels.entries
                .sortedBy { it.value.lowercase() }
                .map { (runtime, label) ->
                    val count = sessions.count { it.runtime == runtime }
                    SessionFilterOption(
                        value = runtime,
                        label = label,
                        count = count,
                        selected = filters.agentRuntime == runtime,
                        enabled = count > 0,
                    )
                }
            listOf(
                SessionFilterOption(
                    value = null,
                    label = "All agents",
                    count = sessions.size,
                    selected = filters.agentRuntime == null,
                ),
            ) + options
        }
        SessionFilterPage.Device -> {
            val options = devices.map { device ->
                val count = sessions.count { it.connectorId == device.id }
                SessionFilterOption(
                    value = device.id,
                    label = device.name,
                    count = count,
                    selected = filters.deviceId == device.id,
                    enabled = count > 0,
                )
            }
            listOf(
                SessionFilterOption(
                    value = null,
                    label = "All devices",
                    count = devices.size,
                    selected = filters.deviceId == null,
                ),
            ) + options
        }
        SessionFilterPage.Workspace -> {
            val workspaceCounts = sessions
                .groupingBy { it.workspaceFilterLabel() }
                .eachCount()
                .toSortedMap(compareBy<String> { it.lowercase() })
            val options = workspaceCounts.map { (workspace, count) ->
                SessionFilterOption(
                    value = workspace,
                    label = workspace,
                    count = count,
                    selected = filters.workspace == workspace,
                )
            }
            listOf(
                SessionFilterOption(
                    value = null,
                    label = "All workspaces",
                    count = workspaceCounts.size,
                    selected = filters.workspace == null,
                ),
            ) + options
        }
    }
}

fun AgentSession.workspaceFilterLabel(): String {
    return workspaceLabel.ifBlank { AllWorkspaceLabel }
}

fun String.runtimeLabel(): String {
    return when (this) {
        "codex" -> "Codex"
        "claude" -> "Claude Code"
        "opencode" -> "OpenCode"
        "acp" -> "ACP"
        else -> replaceFirstChar { char ->
            if (char.isLowerCase()) char.titlecase() else char.toString()
        }
    }
}
