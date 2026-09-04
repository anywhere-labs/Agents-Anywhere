package com.agentsanywhere.app.model

data class AgentProject(
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
