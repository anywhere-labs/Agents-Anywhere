package com.agentsanywhere.app.model

data class AgentSession(
    val id: String,
    val connectorId: String,
    val deviceName: String,
    val title: String,
    val summary: String,
    val cwd: String?,
    val workspaceLabel: String,
    val runtime: String,
    val runtimeLabel: String,
    val status: SessionStatus,
    val statusLabel: String,
    val updatedAtLabel: String,
    val metaLabel: String,
    val pinned: Boolean,
    val archived: Boolean,
    val unread: Boolean,
    val takeover: Boolean,
    val connectorOnline: Boolean,
    val runtimeSettings: Map<String, Any?> = emptyMap(),
    val runtimeSettingsOverride: Map<String, Any?> = emptyMap(),
    val live: Boolean,
    val sortKey: String,
)

enum class SessionStatus {
    Idle,
    Running,
    WaitingApproval,
    Error,
}

data class AgentDevice(
    val id: String,
    val name: String,
    val deviceOs: String? = null,
    val subtitle: String,
    val online: Boolean,
    val attachedRuntimes: List<String> = emptyList(),
    val lastSeenAt: String? = null,
    val createdAt: String? = null,
)

data class RemoteFile(
    val name: String,
    val path: String,
    val type: RemoteFileType,
)

enum class RemoteFileType {
    File,
    Directory,
}
