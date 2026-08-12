package com.agentsanywhere.app.ui.screens.sessiondetail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionMessagesStateTest {
    @Test
    fun realtimeUpdatesFollowOnlyWhenReaderHasNotPausedHistory() {
        assertTrue(
            shouldAutoFollowRealtime(
                hasRealtimeUpdate = true,
                autoFollowLatest = true,
                userPaused = false,
                scrolling = false,
            ),
        )
        assertFalse(
            shouldAutoFollowRealtime(
                hasRealtimeUpdate = true,
                autoFollowLatest = false,
                userPaused = true,
                scrolling = false,
            ),
        )
        assertFalse(
            shouldAutoFollowRealtime(
                hasRealtimeUpdate = true,
                autoFollowLatest = true,
                userPaused = false,
                scrolling = true,
            ),
        )
    }

    @Test
    fun attachmentMediaTypeAllowsEmptyOrValidMimeButRejectsHeaderInjection() {
        assertTrue(isValidAttachmentMediaType(""))
        assertTrue(isValidAttachmentMediaType("image/png"))
        assertTrue(isValidAttachmentMediaType("APPLICATION/PDF"))
        assertFalse(isValidAttachmentMediaType("image/png\r\nX-Test: injected"))
        assertFalse(isValidAttachmentMediaType("not-a-mime"))
    }

    @Test
    fun attachmentCacheFileNameCannotEscapeCacheDirectory() {
        val safe = attachmentCacheFileName("../../file/id", "../secret name.txt")

        assertFalse(safe.contains('/'))
        assertFalse(safe.contains('\\'))
        assertTrue(safe.endsWith("secret_name.txt"))
    }

    @Test
    fun failedUploadUpdatesOnlyItsOwnAttachmentAndLeavesSuccessfulRefsIntact() {
        data class UploadResult(val id: String, val state: AttachmentUploadState, val error: String? = null)
        val uploaded = UploadResult("uploaded", AttachmentUploadState.Uploaded)
        val failed = UploadResult("failed", AttachmentUploadState.Uploading)

        val result = listOf(uploaded, failed).updateItemById("failed", UploadResult::id) {
            it.copy(state = AttachmentUploadState.Failed, error = "URI permission denied")
        }

        assertEquals(AttachmentUploadState.Uploaded, result[0].state)
        assertEquals(AttachmentUploadState.Failed, result[1].state)
        assertEquals("URI permission denied", result[1].error)
    }
}
