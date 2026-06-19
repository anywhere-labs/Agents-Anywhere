package com.agentsanywhere.app.feature.runtime

import com.agentsanywhere.app.model.RemoteFile

data class FilesState(
    val path: String = "",
    val files: List<RemoteFile> = emptyList(),
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
)

data class TerminalState(
    val lines: List<String> = emptyList(),
    val isConnected: Boolean = false,
    val errorMessage: String? = null,
)

data class CodePreviewState(
    val path: String = "",
    val lines: List<String> = emptyList(),
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
)
