package com.agentsanywhere.app.api

data class RemoteProject(
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
    val sidebarSessionCounts: com.agentsanywhere.app.model.ProjectSessionCounts? = null,
)

data class RemoteProjectListResponse(
    val projects: List<RemoteProject>,
    val serverTime: String?,
)

data class RemoteProjectResponse(
    val project: RemoteProject,
    val serverTime: String?,
)

data class RemoteProjectCreateResponse(
    val project: RemoteProject,
    val serverTime: String?,
)

// Account-owned durable receipt; safe to resume after the editor or app restarts.
data class RemotePendingProjectOperation(
    val operationId: String, val status: String, val name: String,
    val connectorId: String, val runtime: String, val runtimeId: String, val workspacePath: String,
    val syncState: String? = null,
)
