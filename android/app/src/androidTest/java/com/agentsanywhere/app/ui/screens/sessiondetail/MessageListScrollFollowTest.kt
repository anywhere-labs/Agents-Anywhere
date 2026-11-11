package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.Context
import android.content.res.Configuration
import java.util.Locale
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNotice
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNoticeAction
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNoticeActionInput
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.height
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.onNodeWithTag
import android.view.View
import android.view.ViewGroup
import io.github.rosemoe.sora.widget.CodeEditor
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.sessiondetail.MessageAuthor
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessiondetail.TimelineFileChange
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessage
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessageKind
import com.agentsanywhere.app.ui.designsystem.AAAppearanceMode
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

private class ScrollTestAuthReader : AuthSessionReader {
    override fun readServerUrl(): String = "https://example.invalid"

    override fun readAccessToken(): String = "test-token"
}

/**
 * Regression coverage for issue #427: while an agent was streaming, reading an
 * expanded thinking chain or tool call reset the timeline to the latest message.
 *
 * The tests drive the real [MessageList] with synthetic DSH-shaped messages.
 * They assert user-visible behaviour (what stays on screen and whether the list
 * is still away from the latest item), not the internal scroll call.
 */
@RunWith(AndroidJUnit4::class)
class MessageListScrollFollowTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val controller = SessionDetailController(SessionsApi(), ScrollTestAuthReader())
    private val context: Context = ApplicationProvider.getApplicationContext<Context>().let {
        it.createConfigurationContext(Configuration(it.resources.configuration).apply { setLocale(Locale.ENGLISH) })
    }

    private val reasoningTitle: String
        get() = context.getString(R.string.session_reasoning_summary, 4)

    private val groupTitle: String
        get() = context.getString(R.string.session_tool_summary_reasoning, 1) + ", " +
            context.getString(R.string.session_tool_summary_commands, 1)

    @Test
    fun appendedToolsKeepReadingHeaderAtSamePixel() {
        val session = TestSession(initialMessages())
        showMessageList(session)
        expandRunningDetails()
        val before = compose.onNodeWithText(reasoningTitle).fetchSemanticsNode().boundsInRoot.top
        repeat(4) { index ->
            compose.runOnIdle {
                val tool = TimelineMessage(id = "append-$index", author = MessageAuthor.Tool,
                    text = "read_file", kind = TimelineMessageKind.ToolCall, title = "read_file", input = "README.md")
                session.messages = session.messages.dropLast(1) + tool + session.messages.last()
                session.streamRequest += 1
            }
            compose.waitForIdle()
            val after = compose.onNodeWithText(reasoningTitle).fetchSemanticsNode().boundsInRoot.top
            assertEquals("Appending to an expanded run must preserve the reader's pixel position", before, after, 2f)
        }
    }

    @Test
    fun singletonDetailsSurviveBecomingAGroup() {
        val reasoning = initialMessages().first { it.id == "reasoning-1" }
        val session = TestSession(initialMessages().take(16) + reasoning)
        showMessageList(session)
        clickText(reasoningTitle, "expand standalone reasoning")
        val text = reasoning.reasoningSegments.first()
        compose.onNodeWithText(text).assertIsDisplayed()
        compose.runOnIdle {
            session.messages = session.messages + TimelineMessage(id = "second-tool", author = MessageAuthor.Tool,
                text = "read_file", kind = TimelineMessageKind.ToolCall, title = "read_file", input = "README.md")
            session.streamRequest += 1
        }
        compose.waitForIdle()
        compose.onNodeWithText(text).assertIsDisplayed()
    }

    @Test
    fun growingReasoningPreservesAnExistingTextLine() {
        val marker = "QA428_FIXED_LINE"
        val session = TestSession(initialMessages().map {
            if (it.id == "reasoning-1") it.copy(reasoningSegments = listOf(
                "$marker a stable sentence with several words to measure. " + "Stable reading words that stay unchanged. ".repeat(100) + "\nA stable end.",
                "Second paragraph.", "Third paragraph.", "Fourth paragraph.")) else it
        })
        showMessageList(session)
        clickText(groupTitle, "expand run")
        clickText(reasoningTitle, "expand reasoning")
        compose.onNode(hasScrollAction()).performTouchInput {
            swipeUp(startY = height * .7f, endY = height * .5f, durationMillis = 400)
        }
        compose.waitForIdle()
        compose.onNodeWithText(marker, substring = true).assertIsDisplayed()
        val initialLayout = textLayout(marker)
        val textTop = compose.onNodeWithText(marker, substring = true).fetchSemanticsNode().positionInRoot.y
        val readingOffset = initialLayout.getLineStart(initialLayout.getLineForVerticalPosition((600f - textTop).coerceAtLeast(0f)))
        val before = textLineY(marker, readingOffset)
        assertTrue("Measure a genuinely visible reading line", before >= 0f && before < 2800f)
        repeat(3) { index ->
            compose.runOnIdle {
                session.messages = session.messages.map { message ->
                    if (message.id == "reasoning-1") message.copy(reasoningSegments =
                        listOf(message.reasoningSegments.first() + " More streamed words $index.".repeat(30)) +
                            message.reasoningSegments.drop(1), revision = message.revision + 1) else message
                }
                session.streamRequest += 1
            }
            compose.waitForIdle()
            assertEquals("An existing reasoning line must stay at its reading coordinate", before, textLineY(marker, readingOffset), 2f)
        }
    }

    @Test
    fun loadingHistoryAndReplacingSnapshotPreserveReadingCoordinate() {
        val session = TestSession(initialMessages())
        showMessageList(session)
        expandRunningDetails()
        val before = compose.onNodeWithText(reasoningTitle).fetchSemanticsNode().boundsInRoot.top
        compose.runOnIdle {
            val older = (1..30).map { TimelineMessage(id = "older-$it", author = MessageAuthor.User, text = "Older page $it") }
            session.messages = (older + session.messages).map { it.copy() }
        }
        compose.waitForIdle()
        assertEquals(before, compose.onNodeWithText(reasoningTitle).fetchSemanticsNode().boundsInRoot.top, 2f)
        compose.onAllNodesWithText("Ran rg -n scroll", substring = true)[0].assertIsDisplayed()
    }

    @Test
    fun targetedApprovalRegroupingPreservesExpandedReasoning() {
        val session = TestSession(initialMessages())
        showMessageList(session)
        clickText(groupTitle, "expand run")
        clickText(reasoningTitle, "expand reasoning")
        val before = compose.onNodeWithText(reasoningTitle).fetchSemanticsNode().boundsInRoot.top
        compose.runOnIdle { session.notices = listOf(targetedNotice()) }
        compose.waitForIdle()
        assertEquals(before, compose.onNodeWithText(reasoningTitle).fetchSemanticsNode().boundsInRoot.top, 2f)
        compose.onNodeWithText(initialMessages().first { it.id == "reasoning-1" }.reasoningSegments.first()).assertIsDisplayed()
        compose.runOnIdle { session.notices = emptyList() }
        compose.waitForIdle()
        assertEquals(before, compose.onNodeWithText(reasoningTitle).fetchSemanticsNode().boundsInRoot.top, 2f)
    }

    @Test
    fun lazyDisposalKeepsExpansionButAnotherSessionDoesNotInheritIt() {
        val session = TestSession(initialMessages())
        showMessageList(session)
        expandRunningDetails()
        compose.onNode(hasScrollAction()).performScrollToIndex(15)
        compose.waitForIdle()
        compose.runOnIdle { session.forceLatestRequest += 1 }
        compose.waitForIdle()
        compose.onNodeWithText(reasoningTitle).assertExists()
        compose.runOnIdle { session.id = "another-session"; session.forceLatestRequest = 0; session.streamRequest = 0 }
        compose.waitForIdle()
        assertTrue(compose.onAllNodesWithText(reasoningTitle).fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun appendedCodeOutputKeepsItsInternalScrollPosition() {
        var output by mutableStateOf((1..100).joinToString("\n") { "QA428 code output $it " + "wide ".repeat(60) })
        compose.setContent {
            AgentsAnywhereTheme(appearanceMode = AAAppearanceMode.Light) {
                SoraCodeBlock(text = output, languageHint = "text", darkMode = false,
                    modifier = Modifier.height(220.dp).testTag("preview"))
            }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("preview").performTouchInput { swipeUp(durationMillis = 400) }
        var beforeY = 0
        compose.runOnIdle {
            val editor = findEditor(compose.activity.window.decorView)!!
            beforeY = editor.offsetY
            assertTrue("The output must actually be scrolled before appending", beforeY > 0)
            output += (101..150).joinToString("\n", prefix = "\n") { "New code output $it" }
        }
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(beforeY, findEditor(compose.activity.window.decorView)!!.offsetY) }
    }

    /** Reading just below the reply's start: the rows above it hold the reading position. */
    @Test
    fun streamingReplyKeepsRowsAboveItInTheFrameItGrows() = assertStreamingKeepsReadingLine(minY = 600f, swipe = .35f)

    /** Reading near the top of the viewport: the reply's own earlier paragraphs hold the position. */
    @Test
    fun streamingReplyKeepsItsOwnLineInTheFrameItGrows() = assertStreamingKeepsReadingLine(minY = 250f, swipe = .15f)

    /** The reply's end and the working indicator stay on screen, so the bottom row is not the one growing. */
    @Test
    fun streamingReplyKeepsEarlierRowsWhenItsEndIsOnScreen() {
        val line = "Synthetic user message 7"
        val session = TestSession(initialMessages())
        showMessageList(session)
        compose.onNode(hasScrollAction()).performTouchInput {
            swipeDown(startY = height * .4f, endY = height * .5f, durationMillis = 400)
        }
        assertReadingLineHoldsWhileStreaming(session, line, minY = 600f)
    }

    /**
     * Reading a long reply from start towards end by dragging slowly while output keeps streaming
     * at the bottom: each drawn frame must move only by the finger's drag delta, never jumping
     * upward when streamed paragraphs arrive below the viewport.
     */
    @Test
    fun slowForwardDragThroughLongStreamingReplyNeverJumpsOnStreamUpdates() {
        val marker = "QA_FORWARD_DRAG_LINE"
        val paragraphs = (1..24).map { "Section $it of a very long final reply. " + "Detailed explanation words for reading. ".repeat(10) }
        val reply = (paragraphs.take(2) + "$marker start reading forward here. ${paragraphs[2]}" + paragraphs.drop(3)).joinToString("\n\n")
        val session = TestSession(initialMessages().map {
            if (it.id == "assistant-last") it.copy(text = reply) else it
        })
        showMessageList(session)
        scrollMarkerIntoReadingArea(marker, minY = 520f, swipe = .35f)

        compose.mainClock.autoAdvance = false
        try {
            // Put finger down and cross touch slop so the gesture enters active user scroll.
            compose.onNode(hasScrollAction()).performTouchInput {
                down(Offset(width * 0.5f, height * 0.65f))
                moveBy(Offset(0f, -40f))
            }
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()

            // Hold finger stationary on screen while new paragraphs stream in at the bottom.
            val heldY = textLineY(marker, 0)
            repeat(3) { index ->
                compose.runOnIdle {
                    appendLongParagraph(session, "stationary-$index")
                }
                compose.mainClock.advanceTimeByFrame()
                compose.waitForIdle()
                assertEquals("Holding finger still while output streams must not jump the reading line", heldY, textLineY(marker, 0), 3f)
            }

            // Now drag slowly upward (-18px/frame, reading from front to back) while output keeps streaming.
            var expectedY = textLineY(marker, 0)
            repeat(5) { index ->
                val dragStep = -18f
                compose.onNode(hasScrollAction()).performTouchInput {
                    moveBy(Offset(0f, dragStep))
                }
                compose.runOnIdle {
                    appendLongParagraph(session, "dragging-$index")
                }
                compose.mainClock.advanceTimeByFrame()
                compose.waitForIdle()
                expectedY += dragStep
                assertEquals("Dragging forward by $dragStep while streaming must not lurch", expectedY, textLineY(marker, 0), 4f)
            }

            // Pause finger briefly so VelocityTracker sees zero release velocity, then lift on the
            // exact same frame another streamed paragraph arrives.
            compose.onNode(hasScrollAction()).performTouchInput {
                advanceEventTime(120)
                moveBy(Offset.Zero)
            }
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
            val beforeLiftY = textLineY(marker, 0)
            compose.onNode(hasScrollAction()).performTouchInput { up() }
            compose.runOnIdle {
                appendLongParagraph(session, "on-lift")
            }
            repeat(3) {
                compose.mainClock.advanceTimeByFrame()
                compose.waitForIdle()
                assertEquals("Lifting finger while output streams must keep the reading line put", beforeLiftY, textLineY(marker, 0), 4f)
            }
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    /**
     * Gentle forward flick (inertial fling towards latest) through a long streaming reply:
     * streamed paragraphs arriving mid-fling and as the fling stops must not cause sudden lurches.
     */
    @Test
    fun forwardFlingThroughLongStreamingReplyCoastsSmoothlyWithoutStreamingJumps() {
        val marker = "QA_FORWARD_FLING_LINE"
        val paragraphs = (1..26).map { "Chapter $it of a long streamed report. " + "Steady prose for reading forward. ".repeat(10) }
        val reply = (paragraphs.take(1) + "$marker coasting past this paragraph. ${paragraphs[1]}" + paragraphs.drop(2)).joinToString("\n\n")
        val session = TestSession(initialMessages().map {
            if (it.id == "assistant-last") it.copy(text = reply) else it
        })
        showMessageList(session)
        scrollMarkerIntoReadingArea(marker, minY = 900f, swipe = .38f)

        compose.mainClock.autoAdvance = false
        try {
            // Trigger a gentle upward flick so the list enters inertial fling towards latest.
            compose.onNode(hasScrollAction()).performTouchInput {
                swipeUp(startY = height * 0.7f, endY = height * 0.52f, durationMillis = 120)
            }
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()

            var prevY = textLineY(marker, 0)
            var prevStep = -Float.MAX_VALUE
            repeat(12) { frame ->
                if (frame % 2 == 1) {
                    compose.runOnIdle {
                        appendLongParagraph(session, "fling-$frame")
                    }
                }
                compose.mainClock.advanceTimeByFrame()
                compose.waitForIdle()
                val currentY = textLineY(marker, 0)
                val step = currentY - prevY // <= 0 while moving upward towards latest
                assertTrue("Forward fling must not jump backwards (step=$step at frame $frame)", step <= 2f)
                if (prevStep != -Float.MAX_VALUE && frame > 1) {
                    // Decelerating fling: upward speed cannot suddenly spike by a streamed paragraph's height (~120px+).
                    assertTrue(
                        "Streamed output during fling must not spike frame displacement (prevStep=$prevStep, step=$step at frame $frame)",
                        step >= prevStep - 12f,
                    )
                }
                prevStep = step
                prevY = currentY
            }
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    /**
     * When the viewport is filled entirely by a non-text region (a tall fenced code block spanning
     * the whole reading viewport so no BasicText layout is visible), streaming growth must not
     * oscillate between [TimelineReadingState.placed] and [TimelineReadingState.settle] across frames.
     */
    @Test
    fun nonTextAnchoredViewportDoesNotOscillateBetweenFramesWhileStreaming() {
        val codeFence = "```kotlin\n" + (1..80).joinToString("\n") { "val line$it = \"stable code block filling viewport $it\"" } + "\n```"
        val tail = (1..8).joinToString("\n\n") { "Tail paragraph $it below the code block. " + "Generated words. ".repeat(10) }
        val session = TestSession(initialMessages().map {
            if (it.id == "assistant-last") it.copy(text = "$codeFence\n\n$tail") else it
        })
        showMessageList(session)
        // Scroll until the code block label "kotlin" is just above the reading top, so the entire
        // visible reading area is filled by the code panel alone.
        var swipes = 0
        while (swipes++ < 35 && compose.onAllNodesWithText("kotlin").fetchSemanticsNodes()
                .firstOrNull()?.let { it.positionInRoot.y in -400f..180f } != true) {
            compose.onNode(hasScrollAction()).performTouchInput {
                swipeDown(startY = height * .3f, endY = height * .55f, durationMillis = 400)
            }
            compose.waitForIdle()
        }
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()
        val before = compose.onNodeWithText("kotlin").fetchSemanticsNode().positionInRoot.y
        assertTrue("Code panel header should sit near/above viewport top so code fills the viewport, was $before", before in -500f..260f)

        compose.mainClock.autoAdvance = false
        try {
            repeat(3) { index ->
                compose.runOnIdle {
                    appendLongParagraph(session, "code-anchor-$index")
                }
                repeat(4) { subFrame ->
                    compose.mainClock.advanceTimeByFrame()
                    compose.waitForIdle()
                    val now = compose.onNodeWithText("kotlin").fetchSemanticsNode().positionInRoot.y
                    assertEquals("Frame $index.$subFrame must not oscillate", before, now, 2f)
                }
            }
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    /** Finishing the turn removes the working indicator and adds reply actions without jumping or crashing. */
    @Test
    fun completingStreamingTurnKeepsReadingLineSteady() {
        val marker = "QA_TURN_FINISH_LINE"
        val paragraphs = (1..16).map { "Turn finish paragraph $it. " + "Steady reading words. ".repeat(9) }
        val reply = (paragraphs.take(2) + "$marker keep steady on finish. ${paragraphs[2]}" + paragraphs.drop(3)).joinToString("\n\n")
        val session = TestSession(initialMessages().map {
            if (it.id == "assistant-last") it.copy(text = reply) else it
        })
        showMessageList(session)
        scrollMarkerIntoReadingArea(marker, minY = 450f, swipe = .3f)
        val before = textLineY(marker, 0)

        compose.mainClock.autoAdvance = false
        try {
            compose.runOnIdle {
                session.workingLabel = null
                session.turnInProgress = false
                session.messages = session.messages.map {
                    if (it.id == "assistant-last") it.copy(status = "done", revision = it.revision + 1) else it
                }
                session.streamRequest += 1
            }
            repeat(4) { frame ->
                compose.mainClock.advanceTimeByFrame()
                compose.waitForIdle()
                assertEquals("Turn completion frame $frame must keep reading line steady", before, textLineY(marker, 0), 3f)
            }
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    private fun scrollMarkerIntoReadingArea(marker: String, minY: Float, swipe: Float) {
        var swipes = 0
        while (swipes++ < 40 && compose.onAllNodesWithText(marker, substring = true).fetchSemanticsNodes()
                .firstOrNull()?.let { it.positionInRoot.y > minY } != true) {
            compose.onNode(hasScrollAction()).performTouchInput {
                swipeDown(startY = height * .25f, endY = height * (.25f + swipe), durationMillis = 400)
            }
            compose.waitForIdle()
        }
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()
    }

    private fun appendLongParagraph(session: TestSession, tag: String) {
        session.messages = session.messages.map { message ->
            if (message.id == "assistant-last") message.copy(
                text = message.text + "\n\nStreamed paragraph $tag. " + "More generated words arriving below viewport. ".repeat(14),
                revision = message.revision + 1,
            ) else message
        }
        session.streamRequest += 1
    }

    private fun assertStreamingKeepsReadingLine(minY: Float, swipe: Float) {
        val marker = "QA_STREAM_READING_LINE"
        val paragraphs = (1..12).map { "Paragraph $it of a long streamed reply. " + "Steady words for reading. ".repeat(8) }
        val reply = (paragraphs.take(2) + "$marker the reader stops here. ${paragraphs[2]}" + paragraphs.drop(3)).joinToString("\n\n")
        val session = TestSession(initialMessages().map {
            if (it.id == "assistant-last") it.copy(text = reply) else it
        })
        showMessageList(session)
        // Read the start of the reply while its end is still below the viewport and growing.
        var swipes = 0
        while (swipes++ < 30 && compose.onAllNodesWithText(marker, substring = true).fetchSemanticsNodes()
                .firstOrNull()?.let { it.positionInRoot.y > minY } != true) {
            compose.onNode(hasScrollAction()).performTouchInput {
                swipeDown(startY = height * .25f, endY = height * (.25f + swipe), durationMillis = 400)
            }
            compose.waitForIdle()
        }
        assertReadingLineHoldsWhileStreaming(session, marker, minY)
    }

    /** Streams paragraphs into the last reply one frame at a time; [line] must not move in any drawn frame. */
    private fun assertReadingLineHoldsWhileStreaming(session: TestSession, line: String, minY: Float) {
        // Let the fling end and the reading state record what is on screen.
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()
        val before = textLineY(line, 0)
        assertTrue("The reading line must be on screen, was $before", before > minY && before < 1800f)

        compose.mainClock.autoAdvance = false
        repeat(4) { index ->
            compose.runOnIdle {
                session.messages = session.messages.map { message ->
                    if (message.id == "assistant-last") message.copy(
                        text = message.text + "\n\nStreamed paragraph $index. " + "More generated words. ".repeat(12),
                        revision = message.revision + 1,
                    ) else message
                }
                session.streamRequest += 1
            }
            compose.mainClock.advanceTimeByFrame()
            // Positioned callbacks run on the UI thread before the frame is drawn; read after them.
            compose.waitForIdle()
            assertEquals("The frame that shows new output must not move the reading line", before, textLineY(line, 0), 2f)
            compose.mainClock.advanceTimeByFrame()
            assertEquals("The reading line must stay put after the update settles", before, textLineY(line, 0), 2f)
        }
        compose.mainClock.autoAdvance = true
    }

    private fun textLayout(marker: String): TextLayoutResult {
        val node = compose.onNodeWithText(marker, substring = true)
        val layouts = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        return layouts.single()
    }

    private fun textLineY(marker: String, offset: Int): Float {
        val node = compose.onNodeWithText(marker, substring = true)
        val layout = textLayout(marker)
        return node.fetchSemanticsNode().positionInRoot.y + layout.getLineTop(layout.getLineForOffset(offset))
    }

    private fun findEditor(view: View): CodeEditor? {
        if (view is CodeEditor) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) findEditor(view.getChildAt(i))?.let { return it }
        return null
    }

    private fun targetedNotice() = RuntimeNotice(
        noticeId = "qa428-notice", type = "interaction", sessionId = "synthetic-session", title = "QA428 approval",
        message = "A harmless synthetic approval", severity = "info", status = "open", interactionType = "approval",
        blocking = null, responseRequired = true, revision = 1, updatedSeq = 1,
        source = mapOf("timelineItemId" to "tool-1"), actions = listOf(RuntimeNoticeAction("allow-once", "Allow", "primary", RuntimeNoticeActionInput(false, null, null), emptyMap())),
        context = emptyMap(), metadata = emptyMap(), expiresAt = null, createdAt = null, updatedAt = null, resolvedAt = null,
    )

    @Test
    fun streamingUpdatesDoNotPullReaderBackToLatest() {
        val session = TestSession(initialMessages())
        showMessageList(session)
        expandRunningDetails()

        val readingPosition = scrollValue()
        assertTrue("Expanding details should move the list away from latest", readingPosition > 0f)
        assertReasoningVisible()

        repeat(5) { appendReasoningLine(session, it) }

        assertTrue(
            "Streaming updates must not re-anchor the list to the latest message",
            scrollValue() > 0f,
        )
        assertReasoningVisible()
        compose.onAllNodesWithText("Reasoned", substring = true)[0].assertIsDisplayed()
    }

    @Test
    fun newToolCallKeepsExpandedDetailsOpen() {
        val session = TestSession(initialMessages())
        showMessageList(session)
        expandRunningDetails()
        assertReasoningVisible()

        val insertAt = session.messages.indexOfLast { it.id == "assistant-last" }.coerceAtLeast(0)
        session.messages = session.messages.toMutableList().apply {
            add(
                insertAt,
                TimelineMessage(
                    id = "tool-3",
                    author = MessageAuthor.Tool,
                    text = "read_file",
                    status = "running",
                    type = "tool",
                    kind = TimelineMessageKind.ToolCall,
                    title = "read_file",
                    subtitle = "README.md",
                    input = "{\"path\":\"README.md\"}",
                ),
            )
        }
        session.streamRequest += 1
        compose.waitForIdle()

        assertTrue(
            "A new tool call in the run must not send the reader back to latest",
            scrollValue() > 0f,
        )
        assertReasoningVisible()
        compose.onAllNodesWithText("Ran rg -n scroll", substring = true)[0].assertIsDisplayed()
    }

    @Test
    fun streamingOutputStillFollowsWhenReaderIsAtLatest() {
        val session = TestSession(initialMessages())
        showMessageList(session)

        assertEquals("The timeline should start at the latest message", 0f, scrollValue(), 0.5f)

        session.messages = session.messages + TimelineMessage(
            id = "assistant-new",
            author = MessageAuthor.Agent,
            text = "Fresh synthetic output arriving at the bottom.",
            status = "running",
        )
        session.streamRequest += 1
        compose.waitForIdle()

        assertEquals(
            "A reader already at the bottom should keep following new output",
            0f,
            scrollValue(),
            0.5f,
        )
        compose.onNodeWithText("Fresh synthetic output arriving at the bottom.").assertIsDisplayed()
    }

    @Test
    fun collapseHidesDetailsAgain() {
        val session = TestSession(initialMessages())
        showMessageList(session)

        // Expand and collapse at the run header so the toggle target stays on screen.
        clickText(groupTitle, "expand run")
        assertReasoningVisible()

        clickText(groupTitle, "collapse run")

        assertTrue(
            "Collapsing the run should hide the reasoning details",
            compose.onAllNodesWithText("Reasoning ·", substring = true).fetchSemanticsNodes().isEmpty(),
        )
        compose.onAllNodesWithText("Reasoned", substring = true)[0].assertIsDisplayed()
    }

    @Test
    fun forceLatestRequestStillReturnsToLatest() {
        val session = TestSession(initialMessages())
        showMessageList(session)
        expandRunningDetails()
        assertTrue(scrollValue() > 0f)

        session.forceLatestRequest += 1
        compose.waitForIdle()

        assertEquals(
            "Sending a message should still bring the timeline back to latest",
            0f,
            scrollValue(),
            0.5f,
        )
    }

    private fun showMessageList(session: TestSession) {
        compose.setContent {
            CompositionLocalProvider(LocalContext provides context, LocalConfiguration provides context.resources.configuration) {
                AgentsAnywhereTheme(appearanceMode = AAAppearanceMode.Light) {
                    Box(Modifier.fillMaxSize()) {
                        MessageList(
                            planningContent = {},
                            messages = session.messages,
                            darkMode = false,
                            sessionId = session.id,
                            notices = session.notices,
                            workspaceRoot = "/workspace/project",
                            controller = controller,
                            forceLatestRequest = session.forceLatestRequest,
                            streamLatestRequest = session.streamRequest,
                            workingLabel = session.workingLabel,
                            turnInProgress = session.turnInProgress,
                            hasMore = false,
                            loadingOlder = false,
                            onLoadOlder = {},
                            onPreviewAttachment = {},
                            onOpenAttachment = {},
                            onCopyMessage = {},
                            onShareReply = {},
                            onOpenFile = {},
                        )
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    private fun expandRunningDetails() {
        clickText(groupTitle, "expand run")
        clickText(reasoningTitle, "expand reasoning")
        clickText("Ran rg -n scroll", "expand command")
    }

    private fun appendReasoningLine(session: TestSession, index: Int) {
        session.messages = session.messages.map { message ->
            if (message.id == "reasoning-1") {
                message.copy(
                    reasoningSegments = message.reasoningSegments +
                        "Streamed reasoning line $index from the harness.",
                    revision = message.revision + 1,
                    updatedSeq = message.updatedSeq + 1,
                )
            } else {
                message
            }
        }
        session.streamRequest += 1
        compose.waitForIdle()
    }

    private fun assertReasoningVisible() {
        compose.onAllNodesWithText("Reasoning ·", substring = true)[0].assertIsDisplayed()
    }

    private fun clickText(text: String, label: String) {
        val nodes = compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes()
        assertTrue("Could not find $label node for \"$text\"", nodes.isNotEmpty())
        compose.onAllNodesWithText(text, substring = true)[0].performClick()
        compose.waitForIdle()
    }

    private fun scrollValue(): Float {
        val node = compose.onNode(hasScrollAction()).fetchSemanticsNode()
        return node.config[SemanticsProperties.VerticalScrollAxisRange].value()
    }

    private class TestSession(initial: List<TimelineMessage>) {
        var id by mutableStateOf("synthetic-session")
        var notices by mutableStateOf(emptyList<RuntimeNotice>())
        var messages by mutableStateOf(initial)
        var streamRequest by mutableStateOf(0)
        var forceLatestRequest by mutableStateOf(0)
        var workingLabel by mutableStateOf<String?>("DeepSeek Harness is working")
        var turnInProgress by mutableStateOf(true)
    }

    private fun initialMessages(): List<TimelineMessage> = buildList {
        repeat(8) { index ->
            add(
                TimelineMessage(
                    id = "user-$index",
                    author = MessageAuthor.User,
                    text = "Synthetic user message $index with enough text to take a few lines on a phone screen.",
                ),
            )
            add(
                TimelineMessage(
                    id = "assistant-$index",
                    author = MessageAuthor.Agent,
                    text = "Synthetic assistant reply $index. This is generated test data for scroll verification only.",
                ),
            )
        }
        add(
            TimelineMessage(
                id = "reasoning-1",
                author = MessageAuthor.Agent,
                text = "reasoning",
                status = "running",
                type = "system",
                kind = TimelineMessageKind.Reasoning,
                reasoningSegments = listOf(
                    "First, inspect the repository structure and identify the session timeline implementation.",
                    "Then verify how streaming updates interact with the list scroll position.",
                    "Check the reverse layout anchoring behaviour while details are expanded.",
                    "Finally, decide on a minimal fix that preserves the reading position.",
                ),
            ),
        )
        add(
            TimelineMessage(
                id = "tool-1",
                author = MessageAuthor.Tool,
                text = "command",
                status = "running",
                type = "tool",
                kind = TimelineMessageKind.Command,
                command = "rg -n scroll",
                output = (1..12).joinToString("\n") { "line $it: SessionMessages.kt scroll output" },
            ),
        )
        add(
            TimelineMessage(
                id = "tool-2",
                author = MessageAuthor.Tool,
                text = "file_change",
                status = "done",
                type = "tool",
                kind = TimelineMessageKind.FileChange,
                fileChanges = listOf(
                    TimelineFileChange(
                        action = "update",
                        path = "android/app/src/main/java/com/agentsanywhere/app/ui/screens/sessiondetail/SessionMessages.kt",
                        diff = "+ synthetic diff line",
                    ),
                ),
            ),
        )
        add(
            TimelineMessage(
                id = "assistant-last",
                author = MessageAuthor.Agent,
                text = "Streaming synthetic assistant output.",
                status = "running",
            ),
        )
    }
}
