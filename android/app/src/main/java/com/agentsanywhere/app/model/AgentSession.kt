package com.agentsanywhere.app.model

data class AgentSession(
    val id: String,
    val connectorId: String,
    val projectId: String?,
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
    val runtimeId: String = runtime,
    val runtimeType: String = runtime,
    val runtimeName: String = runtimeLabel,
    val archivedAt: String? = null,
    val optimisticTopUntil: Long = 0L,
    // Preserve the canonical timestamp, including null, separately from the display activity fallback.
    val sortAt: String? = null,
    /** Protocol 1.2 state-only enums (`none` from older Servers); readable while the device is offline. */
    val planState: String = "none",
    val goalState: String = "none",
    /** E2EE: the title / working directory came from sealed display envelopes (never the Server's plaintext). */
    val encryptedDisplay: Boolean = false,
    /** E2EE: the envelope could not be opened; [title] / [workspaceLabel] hold the "Encrypted" placeholder and [cwd] is null. */
    val titleLocked: Boolean = false,
    val cwdLocked: Boolean = false,
    /** Protocol 1.2 agent collaboration: who created this session and the supervision edges around it. */
    val origin: SessionOrigin? = null,
    val supervisors: List<SupervisionEdge> = emptyList(),
    val supervised: List<SupervisionEdge> = emptyList(),
) {
    val runtimeLabels: RuntimeInstanceLabels
        get() = runtimeInstanceLabels(runtimeName, runtimeType)

    val runtimeContextLabel: String
        get() = listOfNotNull(runtimeLabels.primary, runtimeLabels.secondary).joinToString(" · ")
}

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
    val online: Boolean,
    val lastSeenAt: String? = null,
    val createdAt: String? = null,
    /** "cli", "desktop" and so on; null when the Server does not say. */
    val connectorKind: String? = null,
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
