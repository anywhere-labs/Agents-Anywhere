package com.agentsanywhere.app.model

data class AgentProject(
    val runtime: String? = null,
    val runtimeId: String? = null,
    val nativeProjectId: String? = null,
    val identityKind: String = "legacy",
    val roots: List<String> = emptyList(),
    val sourceState: String = "pending",
    val sourceAvailability: String = "unknown",
    val rootStates: Map<String, String> = emptyMap(),
    val lastSyncedAt: String? = null,
    val id: String,
    val userId: String,
    val connectorId: String,
    val name: String,
    val workspacePath: String,
    val pinned: Boolean,
    val pinnedAt: String?,
    val activeSessionCount: Int,
    val lastActivityAt: String?,
    val createdAt: String,
    val updatedAt: String,
    val manuallyCreated: Boolean = false,
    val sidebarSessionCounts: ProjectSessionCounts? = null,
) {
    val preferredWorkspacePath: String get() = roots.firstOrNull { rootStates[it] == "present" } ?: workspacePath
}

data class ProjectSessionCounts(val active: Int = 0, val archived: Int = 0)
