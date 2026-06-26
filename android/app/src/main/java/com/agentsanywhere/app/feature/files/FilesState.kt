package com.agentsanywhere.app.feature.files

data class FilesDirectory(
    val path: String,
    val entries: List<FileEntry> = emptyList(),
)

data class FileEntry(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val size: Long?,
)

data class TextFile(
    val path: String,
    val name: String,
    val size: Long,
    val sha256: String,
    val encoding: String,
    val content: String,
    val truncated: Boolean,
    val binary: Boolean,
)
