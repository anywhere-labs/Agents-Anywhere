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
    ): List<TimelineAttachment> {
        val uploaded = sessionsApi.uploadSessionAttachments(serverUrl, accessToken, sessionId, attachments)
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

    fun download(
        serverUrl: String,
        accessToken: String,
        sessionId: String,
        attachment: TimelineAttachment,
    ): DownloadedAttachment {
        val downloaded = sessionsApi.downloadSessionAttachment(serverUrl, accessToken, sessionId, attachment.fileId)
        return DownloadedAttachment(
            fileId = downloaded.fileId,
            name = downloaded.name,
            mediaType = attachment.mediaType,
            size = downloaded.size,
            sha256 = downloaded.sha256,
            bytes = downloaded.bytes,
        )
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
        val localSha256 = sha256(local.bytes)
        if (remote.size != local.bytes.size.toLong()) {
            throw AttachmentTransferException(AttachmentTransferFailure.SizeMismatch, local.name)
        }
        if (remote.sha256?.lowercase() != localSha256) {
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

private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes)
    .joinToString("") { byte -> "%02x".format(byte) }

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
    target.writeBytes(attachment.bytes)
    return target
}
