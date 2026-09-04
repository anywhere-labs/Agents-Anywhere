package com.agentsanywhere.app.api

data class RemoteProject(
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
    val attachedSessions: Int,
    val serverTime: String?,
)
