package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.QueuedSessionMessage
import com.agentsanywhere.app.feature.sessiondetail.SessionMessageQueueState
import com.agentsanywhere.app.feature.sessiondetail.SessionMessageQueueStore
import com.agentsanywhere.app.feature.sessiondetail.TimelineAttachment
import com.agentsanywhere.app.feature.sessiondetail.SessionSendMode
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class SessionMessageQueueUiTest {
    @get:Rule val compose = createComposeRule()
    private fun label(id: Int) = InstrumentationRegistry.getInstrumentation().targetContext.getString(id)

    @Test fun busyComposerCanQueueWhileSendingAndStopRemainsSeparate() {
        var sends = 0
        var stops = 0
        compose.setContent {
            Box(Modifier.width(360.dp)) {
                MessageComposer(
                    darkMode = false, draft = "Next instruction", onDraftChange = {}, takeoverEnabled = true,
                    takeoverBusy = false, inputEnabled = true, attachmentsEnabled = true, canSend = true,
                    sending = true, showInterrupt = true, interrupting = false, busy = true, hasInput = true,
                    sendMode = SessionSendMode.Queue, canSteer = true, onSendModeChange = {}, placeholder = "",
                    attachments = emptyList(), onToggleTakeover = {}, onPickPhoto = {}, onPickFile = {},
                    onOpenCamera = {}, onRemoveAttachment = {}, onRetryAttachment = {}, onPreviewAttachment = {},
                    onReadOnlyClick = {}, onSend = { sends++ }, onInterrupt = { stops++ },
                )
            }
        }
        compose.onNodeWithContentDescription(label(R.string.session_queue_message)).performClick()
        compose.runOnIdle { assertEquals(1, sends); assertEquals(0, stops) }
        compose.onNodeWithContentDescription(label(R.string.session_interrupt)).performClick()
        compose.runOnIdle { assertEquals(1, stops) }
    }

    @Test fun composerModeMenuSwitchesToSteering() {
        var mode by mutableStateOf(SessionSendMode.Queue)
        var sends = 0
        compose.setContent {
            MessageComposer(
                darkMode = true, draft = "Change direction", onDraftChange = {}, takeoverEnabled = true,
                takeoverBusy = false, inputEnabled = true, attachmentsEnabled = true, canSend = true,
                sending = false, showInterrupt = true, interrupting = false, busy = true, hasInput = true,
                sendMode = mode, canSteer = true, onSendModeChange = { mode = it }, placeholder = "",
                attachments = emptyList(), onToggleTakeover = {}, onPickPhoto = {}, onPickFile = {},
                onOpenCamera = {}, onRemoveAttachment = {}, onRetryAttachment = {}, onPreviewAttachment = {},
                onReadOnlyClick = {}, onSend = { sends++ }, onInterrupt = {},
            )
        }
        compose.onNodeWithContentDescription(label(R.string.session_send_mode)).performClick()
        compose.onNodeWithText(label(R.string.session_steer_message)).performClick()
        compose.runOnIdle { assertEquals(SessionSendMode.Steer, mode) }
        compose.onNodeWithContentDescription(label(R.string.session_steer_message)).performClick()
        compose.runOnIdle { assertEquals(1, sends) }
    }

    @Test fun pausedQueueRequiresFreshSendAndEditingOpensNoDialog() {
        var selected: String? = null
        compose.setContent {
            SessionMessageQueue(
                queue = SessionMessageQueueState(messages = listOf(QueuedSessionMessage("id", "Original")), paused = true),
                canSendNow = true, onEdit = { id, _, _ -> selected = id }, onDelete = {}, onSendNow = {},
            )
        }
        compose.onNodeWithContentDescription(label(R.string.session_queue_expand)).performClick()
        compose.onNodeWithContentDescription(label(R.string.session_queue_send_now_paused)).assertIsNotEnabled()
        compose.onNodeWithContentDescription(label(R.string.session_queue_edit)).assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("id", selected) }
        compose.onNode(isDialog()).assertDoesNotExist()
    }

    @Test fun queuedEditStaysInlineAndPreservesRegularComposerAndAttachments() {
        val attachment = TimelineAttachment("file", "notes.txt", "text/plain", 12)
        val store = SessionMessageQueueStore()
        store.enqueue("session", QueuedSessionMessage("id", "Queued instruction", attachments = listOf(attachment)))
        var regularDraft by mutableStateOf("Original draft")
        compose.setContent {
            val queue by store.observe("session").collectAsState()
            Column {
                SessionMessageQueue(queue, true,
                    onEdit = { id, editing, text -> store.edit("session", id, editing, text) },
                    onDelete = {}, onSendNow = {})
                MessageComposer(
                    darkMode = false, draft = regularDraft, onDraftChange = { regularDraft = it }, takeoverEnabled = true,
                    takeoverBusy = false, inputEnabled = true, attachmentsEnabled = true, canSend = true,
                    sending = false, showInterrupt = false, interrupting = false, busy = false, hasInput = true,
                    sendMode = SessionSendMode.Queue, canSteer = false, onSendModeChange = {}, placeholder = "",
                    attachments = emptyList(), onToggleTakeover = {}, onPickPhoto = {}, onPickFile = {},
                    onOpenCamera = {}, onRemoveAttachment = {}, onRetryAttachment = {}, onPreviewAttachment = {},
                    onReadOnlyClick = {}, onSend = {}, onInterrupt = {},
                )
            }
        }
        compose.onNodeWithContentDescription(label(R.string.session_queue_edit)).performClick()
        compose.onNode(isDialog()).assertDoesNotExist()
        compose.onNode(hasSetTextAction() and hasText("Queued instruction")).performTextReplacement("Revised instruction")
        compose.onNode(hasSetTextAction() and hasText("Original draft")).assertExists()
        compose.onNodeWithContentDescription(label(R.string.session_queue_save)).performClick()
        compose.runOnIdle {
            assertEquals("Revised instruction", store.read("session").messages.single().content)
            assertEquals(listOf(attachment), store.read("session").messages.single().attachments)
            assertEquals("Original draft", regularDraft)
        }
        compose.onNodeWithContentDescription(label(R.string.session_queue_edit)).performClick()
        compose.onNode(hasSetTextAction() and hasText("Revised instruction")).performTextReplacement("Discard this")
        compose.onNodeWithContentDescription(label(R.string.session_queue_cancel)).performClick()
        compose.runOnIdle {
            assertEquals("Revised instruction", store.read("session").messages.single().content)
            assertEquals("Original draft", regularDraft)
        }
    }
}
