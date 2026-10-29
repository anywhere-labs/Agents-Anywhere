package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.AttachmentTransferException
import com.agentsanywhere.app.api.AttachmentTransferFailure
import com.agentsanywhere.app.api.RemoteAttachmentRef
import com.agentsanywhere.app.api.RemoteUploadedAttachment
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.UploadFilePart
import java.io.File
import java.security.MessageDigest

internal class SessionAttachmentTransfer(
    private val sessionsApi: SessionsApi,
) {
    fun upload(
        serverUrl: String,
        accessToken: String,
        sessionId: String,
        attachments: List<UploadFilePart>,
        onProgress: ((sent: Long, total: Long) -> Unit)? = null,
    ): List<TimelineAttachment> {
        val uploaded = sessionsApi.uploadSessionAttachments(
            serverUrl = serverUrl,
            authorizationToken = accessToken,
            sessionId = sessionId,
            files = attachments,
            onProgress = onProgress,
        )
        return verifyUploadedAttachments(uploaded, attachments)
    }

    fun imageRequest(
        serverUrl: String,
        accessToken: String,
        sessionId: String,
        attachment: TimelineAttachment,
    ): AttachmentImageRequest = AttachmentImageRequest(
        url = sessionsApi.attachmentOpenUrl(serverUrl, sessionId, attachment.fileId),
        authorizationToken = accessToken,
        cacheKey = "attachment:$sessionId:${attachment.fileId}",
    )

    /**
     * Downloads straight to disk. The streaming endpoint is preferred because the
     * legacy JSON endpoint wraps the file in base64 and holds the whole payload in
     * memory twice; servers that predate the endpoint return 404/405 and we fall
     * back to the old path.
     */
    fun download(
        serverUrl: String,
        accessToken: String,
        sessionId: String,
        attachment: TimelineAttachment,
        cacheDir: File,
    ): DownloadedAttachment {
        val destination = downloadDestination(cacheDir, attachment)
        val response = sessionsApi.openSessionAttachmentStream(
            serverUrl = serverUrl,
            authorizationToken = accessToken,
            sessionId = sessionId,
            fileId = attachment.fileId,
        )
        if (response != null) {
            try {
                response.use { streaming ->
                    val body = streaming.body
                        ?: throw AttachmentTransferException(AttachmentTransferFailure.SizeMismatch, attachment.name)
                    val digest = MessageDigest.getInstance("SHA-256")
                    var total = 0L
                    destination.outputStream().use { output ->
                        body.byteStream().use { input ->
                            val buffer = ByteArray(DOWNLOAD_BUFFER_BYTES)
                            while (true) {
                                val read = input.read(buffer)
                                if (read == -1) break
                                total += read
                                if (total > MAX_DOWNLOAD_BYTES) {
                                    throw AttachmentTransferException(
                                        AttachmentTransferFailure.SizeMismatch,
                                        attachment.name,
                                    )
                                }
                                output.write(buffer, 0, read)
                                digest.update(buffer, 0, read)
                            }
                        }
                    }
                    val actualSha256 = digest.digest().toHex()
                    val expectedSize = streaming.header("Content-Length")?.toLongOrNull()
                    if (expectedSize != null && expectedSize >= 0 && expectedSize != total) {
                        throw AttachmentTransferException(AttachmentTransferFailure.SizeMismatch, attachment.name)
                    }
                    val expectedSha256 = streaming.header("X-File-Sha256")?.lowercase()?.takeIf { it.length == 64 }
                    if (expectedSha256 != null && expectedSha256 != actualSha256) {
                        throw AttachmentTransferException(AttachmentTransferFailure.Sha256Mismatch, attachment.name)
                    }
                    return DownloadedAttachment(
                        fileId = attachment.fileId,
                        name = attachment.name,
                        mediaType = attachment.mediaType,
                        size = total,
                        sha256 = actualSha256,
                        file = destination,
                    )
                }
            } catch (error: Throwable) {
                destination.delete()
                throw error
            }
        }

        val downloaded = try {
            sessionsApi.downloadSessionAttachment(
                serverUrl = serverUrl,
                authorizationToken = accessToken,
                sessionId = sessionId,
                fileId = attachment.fileId,
                destination = destination,
            )
        } catch (error: Throwable) {
            destination.delete()
            throw error
        }
        return DownloadedAttachment(
            fileId = downloaded.fileId,
            name = downloaded.name,
            mediaType = attachment.mediaType,
            size = downloaded.size,
            sha256 = downloaded.sha256,
            file = downloaded.file,
        )
    }

    private fun downloadDestination(cacheDir: File, attachment: TimelineAttachment): File {
        val directory = File(cacheDir, "downloads").apply { mkdirs() }
        val safeId = attachment.fileId.replace(Regex("[^A-Za-z0-9._-]"), "_").take(64)
        return File(directory, safeId.ifBlank { "attachment" }).canonicalFile
    }
}

internal fun verifyUploadedAttachments(
    uploaded: List<RemoteUploadedAttachment>,
    localAttachments: List<UploadFilePart>,
): List<TimelineAttachment> {
    if (uploaded.size != localAttachments.size) {
        throw AttachmentTransferException(AttachmentTransferFailure.IncompleteUpload)
    }
    return uploaded.zip(localAttachments).map { (remote, local) ->
        val localSize = local.file.length()
        if (remote.size != localSize) {
            throw AttachmentTransferException(AttachmentTransferFailure.SizeMismatch, local.name)
        }
        if (remote.sha256?.lowercase() != sha256(local.file)) {
            throw AttachmentTransferException(AttachmentTransferFailure.Sha256Mismatch, local.name)
        }
        remote.toTimelineAttachment()
    }
}

internal fun TimelineAttachment.toRemoteAttachmentRef(): RemoteAttachmentRef = RemoteAttachmentRef(fileId = fileId)

private fun RemoteUploadedAttachment.toTimelineAttachment(): TimelineAttachment = TimelineAttachment(
    fileId = fileId,
    name = name,
    mediaType = mediaType,
    size = size,
    sha256 = sha256,
)

private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read == -1) break
            digest.update(buffer, 0, read)
        }
    }
    return digest.digest().toHex()
}

private fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(byte) }

private val ATTACHMENT_MEDIA_TYPE_PATTERN = Regex("^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$")

internal fun isValidAttachmentMediaType(mediaType: String): Boolean =
    mediaType.isEmpty() || ATTACHMENT_MEDIA_TYPE_PATTERN.matches(mediaType.lowercase())

internal fun attachmentCacheFileName(fileId: String, name: String): String {
    val safeId = fileId.replace(Regex("[^A-Za-z0-9._-]"), "_").take(48).ifBlank { "attachment" }
    val safeName = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(180).ifBlank { "download" }
    return "$safeId-$safeName"
}

internal fun cacheDownloadedAttachment(
    cacheDir: File,
    attachment: DownloadedAttachment,
): File {
    val directory = File(cacheDir, "session-attachments").apply { mkdirs() }
    check(directory.isDirectory) { "Could not create the attachment cache directory." }
    val target = File(directory, attachmentCacheFileName(attachment.fileId, attachment.name)).canonicalFile
    check(target.parentFile == directory.canonicalFile) { "Attachment cache path escaped its directory." }
    if (target != attachment.file) {
        attachment.file.copyTo(target, overwrite = true)
    }
    return target
}

private const val DOWNLOAD_BUFFER_BYTES = 64 * 1024
private const val MAX_DOWNLOAD_BYTES = 200L * 1024L * 1024L
