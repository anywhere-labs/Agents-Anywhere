package com.agentsanywhere.app.feature.files

import com.agentsanywhere.app.api.RemoteFileTransfer
import java.io.File

/** A file on a work device that the file preview page opens. */
data class FilePreviewTarget(
    val connectorId: String,
    val root: String,
    val path: String,
) {
    val name: String
        get() = fileNameFromRemotePath(path)
}

/**
 * Current name, size and hash of a remote file, plus the one-shot transfer the
 * Server prepared for downloading it.
 */
data class RemoteFileInfo(
    val target: FilePreviewTarget,
    val path: String,
    val name: String,
    val size: Long,
    val mediaType: String,
    val sha256: String,
    internal val transfer: RemoteFileTransfer,
    internal val preparedAtMillis: Long,
)

/** A remote file downloaded into the preview cache under its original name. */
data class LocalRemoteFile(
    val info: RemoteFileInfo,
    val file: File,
)

data class DownloadedFile(
    val path: String,
    val name: String,
    val mediaType: String,
    val size: Long,
    val sha256: String,
    val file: File,
)

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

/** Why opening or downloading a remote file failed, for user-facing messages. */
sealed interface RemoteFileFailure {
    data object NotFound : RemoteFileFailure
    data object TooLarge : RemoteFileFailure
    data object DeviceOffline : RemoteFileFailure
    data class Other(val message: String?) : RemoteFileFailure
}
