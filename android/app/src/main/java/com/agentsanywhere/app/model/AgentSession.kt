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
    val lastReadSeq: Int,
    val takeover: Boolean,
    val connectorOnline: Boolean,
    val live: Boolean,
    val sortKey: String,
    val updatedSeq: Int,
)

enum class SessionStatus {
    Idle,
    Waiting,
    Pending,
    Running,
    Stopping,
    WaitingApproval,
    Error,
    Blocked,
    Unknown,
}

data class AgentDevice(
    val id: String,
    val name: String,
    val deviceOs: String? = null,
    val subtitle: String,
    val online: Boolean,
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
