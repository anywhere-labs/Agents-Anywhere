package com.agentsanywhere.app.ui.screens.sessiondetail

import android.net.Uri
import com.agentsanywhere.app.feature.sessiondetail.TimelineAttachment
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class SessionComposerDraftStoreTest {
    @Test
    fun sessionAndPreparedDraftsKeepTextAndAttachmentsAcrossStoreRecreation() {
        val context = RuntimeEnvironment.getApplication()
        val account = "draft-restoration-regression"
        val store = SessionComposerDraftStore(context, account)
        val remote = TimelineAttachment("file-a", "a.txt", "text/plain", 12L, "sha-a")
        val attachment = PendingAttachment(
            uri = Uri.parse("content://regression/a"), name = "a.txt", mediaType = "text/plain",
            size = 12L, id = "attachment-a", uploadState = AttachmentUploadState.Uploaded, remote = remote,
        )
        val localAttachment = attachment.copy(
            uri = Uri.parse("content://regression/local"), id = "attachment-local", remote = null,
            uploadState = AttachmentUploadState.Uploading,
        )
        listOf("session-a", "session-b", "local-prepared").forEach(store::clear)
        store.save("session-a", "A draft", listOf(attachment), "retry-a")
        store.save("session-b", "B draft", emptyList())
        store.save("local-prepared", "Prepared draft", listOf(localAttachment), "retry-local")

        // Use a new real store so these reads exercise SharedPreferences + JSON, not its in-memory map.
        val recreated = SessionComposerDraftStore(context, account)
        assertEquals(SessionComposerDraft("A draft", listOf(attachment), "retry-a"), recreated.restore("session-a", "cancelled"))
        assertEquals(SessionComposerDraft("B draft"), recreated.restore("session-b", "cancelled"))
        assertEquals(
            SessionComposerDraft("Prepared draft", listOf(localAttachment.copy(
                uploadState = AttachmentUploadState.Failed, errorMessage = "cancelled",
            )), "retry-local"),
            recreated.restore("local-prepared", "cancelled"),
        )
        recreated.clear("session-b")
        val third = SessionComposerDraftStore(context, account)
        assertEquals(SessionComposerDraft(), third.restore("session-b", "cancelled"))
        assertEquals("A draft", third.restore("session-a", "cancelled").text)
        assertEquals("Prepared draft", third.restore("local-prepared", "cancelled").text)
        assertEquals(SessionComposerDraft(), SessionComposerDraftStore(context, "$account-other").restore("session-a", "cancelled"))
    }
}
