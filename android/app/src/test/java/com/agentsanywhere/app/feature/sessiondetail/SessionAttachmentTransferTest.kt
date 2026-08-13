package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.AttachmentTransferException
import com.agentsanywhere.app.api.AttachmentTransferFailure
import com.agentsanywhere.app.api.RemoteUploadedAttachment
import com.agentsanywhere.app.api.UploadFilePart
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.Assert.assertThrows

class SessionAttachmentTransferTest {
    @Test
    fun attachmentRefContainsOnlyServerFileId() {
        val ref = TimelineAttachment(
            fileId = "file/one",
            name = "notes.txt",
            mediaType = "text/plain",
            size = 5,
            sha256 = "digest",
        ).toRemoteAttachmentRef()

        assertEquals("file/one", ref.fileId)
    }

    @Test
    fun mediaTypeAndCacheNameRejectHeaderAndPathInjection() {
        assertTrue(isValidAttachmentMediaType("image/png"))
        assertFalse(isValidAttachmentMediaType("image/png\r\nAuthorization: secret"))

        val name = attachmentCacheFileName("../../file/id", "../secret name.txt")
        assertFalse(name.contains('/'))
        assertFalse(name.contains('\\'))
        assertTrue(name.endsWith("secret_name.txt"))
    }

    @Test
    fun uploadVerificationRejectsIncompleteSizeAndDigestMismatch() {
        val bytes = "hello".toByteArray()
        val local = UploadFilePart("notes.txt", "text/plain", bytes)
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { byte -> "%02x".format(byte) }
        fun remote(size: Long = bytes.size.toLong(), sha256: String = digest) = RemoteUploadedAttachment(
            fileId = "file",
            name = "notes.txt",
            mediaType = "text/plain",
            size = size,
            sha256 = sha256,
        )

        assertEquals("file", verifyUploadedAttachments(listOf(remote()), listOf(local)).single().fileId)
        assertEquals(
            AttachmentTransferFailure.IncompleteUpload,
            assertThrows(AttachmentTransferException::class.java) {
                verifyUploadedAttachments(emptyList(), listOf(local))
            }.failure,
        )
        assertEquals(
            AttachmentTransferFailure.SizeMismatch,
            assertThrows(AttachmentTransferException::class.java) {
                verifyUploadedAttachments(listOf(remote(size = 2)), listOf(local))
            }.failure,
        )
        assertEquals(
            AttachmentTransferFailure.Sha256Mismatch,
            assertThrows(AttachmentTransferException::class.java) {
                verifyUploadedAttachments(listOf(remote(sha256 = "bad")), listOf(local))
            }.failure,
        )
    }

    @Test
    fun downloadedAttachmentIsWrittenInsideDedicatedCacheDirectory() {
        val cacheDir = Files.createTempDirectory("attachment-transfer-test").toFile()
        try {
            val target = cacheDownloadedAttachment(
                cacheDir,
                DownloadedAttachment(
                    fileId = "../../file/id",
                    name = "../notes.txt",
                    mediaType = "text/plain",
                    size = 5,
                    sha256 = "digest",
                    bytes = "hello".toByteArray(),
                ),
            )

            assertEquals(File(cacheDir, "session-attachments").canonicalFile, target.parentFile)
            assertEquals("hello", target.readText())
        } finally {
            cacheDir.deleteRecursively()
        }
    }
}
