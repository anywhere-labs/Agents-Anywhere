package com.agentsanywhere.app.api

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
