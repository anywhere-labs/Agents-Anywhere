package com.agentsanywhere.app.ui.screens.sessiondetail

import com.agentsanywhere.app.feature.sessiondetail.RuntimeMessageAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionComposerDraftStoreTest {
    @Test
    fun retryDraftKeepsStableClientMessageIdAndOriginalAction() {
        val store = SessionComposerDraftStore()
        store.save(
            sessionId = "session",
            text = "retry me",
            attachments = emptyList(),
            clientMessageId = "client-stable",
            retryAction = RuntimeMessageAction.Steer,
        )

        val restored = store.restore("session", "cancelled")

        assertEquals("retry me", restored.text)
        assertEquals("client-stable", restored.clientMessageId)
        assertEquals(RuntimeMessageAction.Steer, restored.retryAction)
    }

    @Test
    fun clearingDraftRemovesRetryIdentity() {
        val store = SessionComposerDraftStore()
        store.save("session", "retry", emptyList(), "client-stable", RuntimeMessageAction.Send)
        store.clear("session")

        val restored = store.restore("session", "cancelled")

        assertEquals("", restored.text)
        assertNull(restored.clientMessageId)
        assertNull(restored.retryAction)
    }
}
