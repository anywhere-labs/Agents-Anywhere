package com.agentsanywhere.app.api

data class RemoteConnector(
    val id: String,
    val name: String,
    val deviceOs: String?,
    val status: String,
    val lastSeenAt: String?,
    val attachedRuntimes: List<String>,
    val createdAt: String?,
    val updatedAt: String?,
)

data class RemoteConnectorCredential(
    val connector: RemoteConnector,
    val connectorToken: String,
    val tokenPrefix: String?,
)

data class RemoteDirectory(
    val path: String,
    val entries: List<RemoteDirectoryEntry>,
    val truncated: Boolean,
)

data class RemoteDirectoryEntry(
    val name: String,
    val path: String,
    val type: String,
    val size: Long?,
)

data class RemoteTextFile(
    val path: String,
    val name: String,
    val size: Long,
    val sha256: String,
    val encoding: String,
    val content: String,
    val truncated: Boolean,
    val binary: Boolean,
    val serverTime: String,
)

data class RemoteTerminal(
    val terminalId: String,
    val sessionId: String,
    val label: String,
    val cwd: String,
    val cols: Int,
    val rows: Int,
    val purpose: String,
    val pid: Int?,
    val status: String,
    val exitCode: Int?,
    val scrollbackSeq: Int,
)
