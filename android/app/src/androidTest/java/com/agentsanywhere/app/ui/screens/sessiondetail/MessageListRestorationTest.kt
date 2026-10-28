package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.Context
import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.sessiondetail.MessageAuthor
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessage
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessageKind
import com.agentsanywhere.app.ui.designsystem.AAAppearanceMode
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import java.util.Locale
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real MessageList, the same external per-session saveable boundary as the workspace, no cached UI/controller. */
@RunWith(AndroidJUnit4::class)
class MessageListRestorationTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val restoration = StateRestorationTester(compose)
    private val context: Context = ApplicationProvider.getApplicationContext<Context>().let {
        it.createConfigurationContext(Configuration(it.resources.configuration).apply { setLocale(Locale.ENGLISH) })
    }
    private val controller = SessionDetailController(SessionsApi(), object : AuthSessionReader {
        override fun readServerUrl() = "https://example.invalid"
        override fun readAccessToken() = "test-token"
    })
    private val title get() = context.getString(R.string.session_reasoning_summary, 1)
    private val readingText = ("A_READING_MARKER " + "A stable reading sentence that reflows with the actual pane width. ".repeat(24)).trimEnd()

    @Test
    fun pagedReadingMessageSurvivesSwitchLoadingFreshSnapshotAndSavedInstanceRestore() {
        val host = Host()
        show(host)
        // Start from the actual latest page; the existing paging callback supplies older history.
        leaveLatest()
        jumpWhileTouching(20)
        compose.waitForIdle()
        assertTrue("The fixture must first page history through onLoadOlder", host.olderRequests > 0)
        openReadingMessage()
        val before = readingLine()
        val requestsBeforeSwitch = host.olderRequests

        compose.runOnIdle {
            host.id = "B"
            host.messages = messages("B", 0, 40)
            host.hasMore = false
        }
        compose.waitForIdle()
        assertEquals("B starts following latest, not A's saved numeric index", 0f, scrollValue(), .5f)
        assertTrue("B must not inherit A's expanded reasoning", compose.onAllNodesWithText(readingText).fetchSemanticsNodes().isEmpty())
        compose.runOnIdle {
            host.id = "A"
            host.loading = true
            host.messages = emptyList()
        }
        compose.onNodeWithText("Loading A").assertIsDisplayed()
        // Save while MessageList is absent: unused restored values must survive the loading branch.
        restoration.emulateSavedInstanceStateRestore()
        compose.runOnIdle {
            host.messages = messages("A", 20, 70) // More latest rows, and the saved message is not in this snapshot.
            host.hasMore = true
            host.loading = false
        }
        compose.waitForIdle()
        assertTrue("Restoring a missing message must request older history, not adopt the same index in a fresh snapshot", host.olderRequests > requestsBeforeSwitch)
        compose.onNodeWithText(readingText).assertIsDisplayed()
        assertReadingLine(before)
        assertTrue("Restoring history must not silently resume following", scrollValue() > 0f)
    }

    @Test
    fun failedMissingAnchorRecoveryWaitsForProgressThenRestoresAcrossOlderPages() {
        val failedPage = CompletableDeferred<Boolean>()
        val resumedPage = CompletableDeferred<Boolean>()
        val host = Host().apply {
            messages = messages("A", 0, 40)
            hasMore = false
        }
        show(host)
        leaveLatest()
        openReadingMessage()
        val before = readingLine()
        compose.runOnIdle {
            host.id = "B"
            host.messages = messages("B", 0, 40)
        }
        compose.waitForIdle()
        compose.runOnIdle {
            host.id = "A"
            host.messages = messages("A", 60, 120)
            host.hasMore = true
            host.pageGate = failedPage
        }
        compose.waitForIdle()
        assertEquals(1, host.olderRequests)
        assertTrue("A real async request must expose loadingOlder=true before completing", host.loadingOlder)
        val range = compose.onNode(hasScrollAction()).fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
        assertTrue("The saved numeric viewport must not independently trigger near-oldest paging", range.value() + 10f < range.maxValue())
        val failedSnapshot = host.messages
        compose.runOnIdle {
            // A second unintended callback would block here rather than create an unbounded test loop.
            host.pageGate = resumedPage
            failedPage.complete(false)
        }
        repeat(5) {
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
        }
        assertEquals("A failed same-page anchor recovery must not immediately retry", 1, host.olderRequests)
        assertTrue(host.historyError)
        assertTrue(host.hasMore)
        assertEquals(failedSnapshot, host.messages)
        assertTrue("The failed request must finish without leaving loadingOlder stuck", !host.loadingOlder)

        // Existing caller progress clears the error; the original anchor must still survive.
        compose.runOnIdle {
            host.messages = messages("A", 40, 60) + host.messages
            host.historyError = false
        }
        compose.waitForIdle()
        assertEquals(2, host.olderRequests)
        assertTrue(host.loadingOlder)
        compose.runOnIdle {
            host.pageGate = null
            resumedPage.complete(true)
        }
        compose.waitForIdle()
        assertEquals("Both remaining older pages must load until A-12 is recovered", 3, host.olderRequests)
        assertReadingLine(before)
    }

    @Test
    fun actualPaneResizeAndSavedInstanceRestoreKeepTheSameTextLine() {
        val host = Host().apply { messages = messages("A", 0, 40); hasMore = false }
        show(host)
        leaveLatest()
        openReadingMessage()
        val before = readingLine()
        val widthBefore = compose.onNode(hasScrollAction()).fetchSemanticsNode().boundsInRoot.width
        compose.runOnIdle { host.width = 260 }
        compose.waitForIdle()
        val widthAfter = compose.onNode(hasScrollAction()).fetchSemanticsNode().boundsInRoot.width
        assertTrue("Change real parent constraints, not a helper's fake width", widthBefore - widthAfter > 20f)
        assertReadingLine(before)
        restoration.emulateSavedInstanceStateRestore()
        compose.waitForIdle()
        assertReadingLine(before)
        assertTrue(scrollValue() > 0f)
    }

    @Test
    fun actualActivityRecreationRestoresMissingReadingMessageAtNewPaneWidth() {
        val host = Host().apply { messages = messages("A", 0, 40); hasMore = false }
        show(host, actualActivity = true)
        leaveLatest()
        openReadingMessage()
        val before = readingLine()
        compose.activityRule.scenario.recreate()
        compose.activityRule.scenario.onActivity { activity ->
            host.width = 260
            host.top = 32
            host.messages = messages("A", 20, 70)
            host.hasMore = true
            activity.setContent(content = checkNotNull(activityContent))
        }
        compose.waitForIdle()
        assertTrue("Activity saved state must recover missing history with the existing callback", host.olderRequests > 0)
        assertReadingLine(before)
    }

    private var activityContent: (@Composable () -> Unit)? = null

    private fun show(host: Host, actualActivity: Boolean = false) {
        val content: @Composable () -> Unit = {
            CompositionLocalProvider(LocalContext provides context, LocalConfiguration provides context.resources.configuration) {
                AgentsAnywhereTheme(appearanceMode = AAAppearanceMode.Light) {
                    val holder = rememberSaveableStateHolder()
                    val scope = rememberCoroutineScope()
                    Box(Modifier.padding(top = host.top.dp).width(host.width.dp).height(640.dp)) {
                        key(host.id) {
                            holder.SaveableStateProvider("session:${host.id}") {
                                if (host.loading) Text("Loading ${host.id}") else MessageList(
                                    messages = host.messages, darkMode = false, sessionId = host.id,
                                    workspaceRoot = "/workspace/project", controller = controller,
                                    forceLatestRequest = 0, streamLatestRequest = 0, workingLabel = null,
                                    bottomContentPadding = 24.dp,
                                    hasMore = host.hasMore, loadingOlder = host.loadingOlder, historyError = host.historyError,
                                    onLoadOlder = {
                                        host.olderRequests += 1
                                        val gate = host.pageGate
                                        host.loadingOlder = true
                                        host.historyError = false
                                        scope.launch {
                                            if (gate?.await() != false) {
                                                val oldest = host.messages.minOf { it.orderSeq }.toInt()
                                                val start = (oldest - 20).coerceAtLeast(0)
                                                host.messages = messages(host.id, start, oldest) + host.messages
                                                host.hasMore = start > 0
                                            } else host.historyError = true
                                            host.loadingOlder = false
                                        }
                                    },
                                    onPreviewAttachment = {}, onOpenAttachment = {}, onCopyMessage = {},
                                    onShareReply = {}, onOpenFile = {},
                                )
                            }
                        }
                    }
                }
            }
        }
        if (actualActivity) {
            activityContent = content
            compose.activityRule.scenario.onActivity { it.setContent(content = content) }
        } else restoration.setContent(content)
        compose.waitForIdle()
    }

    private fun leaveLatest() {
        compose.onNode(hasScrollAction()).performTouchInput { swipeDown(startY = height * .3f, endY = height * .6f, durationMillis = 400) }
        compose.waitForIdle()
    }

    private fun jumpWhileTouching(index: Int) {
        // Keep the real reading engine in user-navigation mode while the test materializes a far row.
        compose.onNode(hasScrollAction()).performTouchInput { down(center) }
        compose.onNode(hasScrollAction()).performScrollToIndex(index)
        compose.onNode(hasScrollAction()).performTouchInput { up() }
        compose.waitForIdle()
    }

    private fun openReadingMessage() {
        // 40 messages, reverseLayout, plus bottom spacer => message A-12 is at index 28.
        jumpWhileTouching(28)
        compose.onNodeWithText(title).performClick()
        repeat(2) {
            compose.onNode(hasScrollAction()).performTouchInput { swipeUp(startY = height * .8f, endY = height * .3f, durationMillis = 700) }
        }
        compose.waitForIdle()
        compose.onNodeWithText(readingText).assertIsDisplayed()
    }

    private data class Line(val offset: Int, val y: Float)

    private fun layout(): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(readingText).performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(results) }
        return results.single()
    }

    private fun readingLine(): Line {
        val textTop = compose.onNodeWithText(readingText).fetchSemanticsNode().positionInRoot.y
        val viewport = compose.onNode(hasScrollAction()).fetchSemanticsNode().boundsInRoot
        val readingTop = viewport.top + 74f * context.resources.displayMetrics.density
        val layout = layout()
        val offset = layout.getLineStart(layout.getLineForVerticalPosition((readingTop - textTop).coerceAtLeast(0f)))
        assertTrue("The reading paragraph must cross the reading viewport top before saving", textTop <= readingTop)
        return Line(offset, textTop + layout.getLineTop(layout.getLineForOffset(offset)) - viewport.top)
    }

    private fun assertReadingLine(expected: Line) {
        compose.onNodeWithText(readingText).assertIsDisplayed()
        val top = compose.onNodeWithText(readingText).fetchSemanticsNode().positionInRoot.y
        assertEquals("The saved reading character's line must remain at the same viewport coordinate", expected.y,
            top + layout().getLineTop(layout().getLineForOffset(expected.offset)) -
                compose.onNode(hasScrollAction()).fetchSemanticsNode().boundsInRoot.top, 3f)
    }

    private fun scrollValue(): Float = compose.onNode(hasScrollAction()).fetchSemanticsNode()
        .config[SemanticsProperties.VerticalScrollAxisRange].value()

    private inner class Host {
        var id by mutableStateOf("A")
        var messages by mutableStateOf(messages("A", 20, 40))
        var loading by mutableStateOf(false)
        var hasMore by mutableStateOf(true)
        var loadingOlder by mutableStateOf(false)
        var historyError by mutableStateOf(false)
        var pageGate: CompletableDeferred<Boolean>? = null
        var width by mutableStateOf(360)
        var top by mutableStateOf(0)
        var olderRequests = 0
    }

    private fun messages(prefix: String, start: Int, end: Int): List<TimelineMessage> = (start until end).map { index ->
        if (index == 12) TimelineMessage(
            id = "$prefix-$index", author = MessageAuthor.Agent, text = "reasoning", orderSeq = index,
            kind = TimelineMessageKind.Reasoning, status = "done", reasoningSegments = listOf(readingText),
        ) else TimelineMessage(
            id = "$prefix-$index", author = if (index % 2 == 0) MessageAuthor.User else MessageAuthor.Agent,
            text = "$prefix message $index. " + "Stable history content. ".repeat(3), orderSeq = index,
        )
    }
}
