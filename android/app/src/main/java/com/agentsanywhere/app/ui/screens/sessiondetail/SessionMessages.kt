package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.MessageAuthor
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNotice
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNoticeAction
import com.agentsanywhere.app.feature.sessiondetail.TimelineAttachment
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessage
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessageKind
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.valentinilk.shimmer.shimmer
import com.composables.icons.lucide.ArrowDown
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.CircleAlert
import com.composables.icons.lucide.Clock
import com.composables.icons.lucide.FilePenLine
import com.composables.icons.lucide.Hammer
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Sparkles
import com.composables.icons.lucide.SquareTerminal
import com.composables.icons.lucide.WifiOff
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlin.math.abs

private const val SESSION_WELCOME_WRITE_MS = 58L
private const val SESSION_WELCOME_ERASE_MS = 22L
private const val SESSION_WELCOME_HOLD_MS = 15_000L
private const val LOAD_OLDER_VISIBLE_THRESHOLD = 3
private const val RETURN_TO_LATEST_ANIMATION_WINDOW = 12
private val AUTO_FOLLOW_RESUME_THRESHOLD = 8.dp
private val AUTO_FOLLOW_DRAG_PAUSE_THRESHOLD = 32.dp
private val SessionWelcomeFontFamily = FontFamily(
    Font(R.font.newsreader_opsz_wght, FontWeight(650)),
)

internal sealed interface TimelineRenderItem {
    val key: String
    val messages: List<TimelineMessage>

    data class Single(val message: TimelineMessage) : TimelineRenderItem {
        override val key: String = message.id
        override val messages: List<TimelineMessage> = listOf(message)
    }

    data class ToolRun(override val messages: List<TimelineMessage>) : TimelineRenderItem {
        override val key: String = "tool-run:${messages.firstOrNull()?.id ?: "unknown"}"
    }

    data class Reconnect(override val messages: List<TimelineMessage>) : TimelineRenderItem {
        override val key: String = "reconnect:${messages.firstOrNull()?.id ?: "unknown"}"
    }
}

@Composable
internal fun SessionDetailLoadingState() {
    val baseColor = LocalAAColors.current.subtle

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .shimmer()
            .padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item(key = "loading-top-space") { Spacer(Modifier.height(82.dp)) }
        item(key = "loading-agent-1") {
            AgentMessageSkeleton(baseColor = baseColor, widths = listOf(0.88f, 0.72f, 0.54f))
        }
        item(key = "loading-tool") {
            ToolMessageSkeleton(baseColor = baseColor)
        }
        item(key = "loading-user-1") {
            UserMessageSkeleton(baseColor = baseColor, widthFraction = 0.38f)
        }
        item(key = "loading-agent-2") {
            AgentMessageSkeleton(baseColor = baseColor, widths = listOf(0.80f, 0.92f, 0.66f, 0.44f))
        }
        item(key = "loading-bottom-space") { Spacer(Modifier.height(190.dp)) }
    }
}

@Composable
private fun AgentMessageSkeleton(baseColor: Color, widths: List<Float>) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        widths.forEachIndexed { index, width ->
            SkeletonBlock(
                modifier = Modifier
                    .fillMaxWidth(width)
                    .height(if (index == 0) 18.dp else 16.dp),
                baseColor = baseColor,
                shape = RoundedCornerShape(8.dp),
            )
        }
    }
}

@Composable
private fun UserMessageSkeleton(baseColor: Color, widthFraction: Float) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
    ) {
        SkeletonBlock(
            modifier = Modifier
                .fillMaxWidth(widthFraction)
                .height(52.dp),
            baseColor = baseColor,
            shape = RoundedCornerShape(22.dp),
        )
    }
}

@Composable
private fun ToolMessageSkeleton(baseColor: Color) {
    Row(
        modifier = Modifier.padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SkeletonBlock(
            modifier = Modifier.size(14.dp),
            baseColor = baseColor,
            shape = CircleShape,
        )
        SkeletonBlock(
            modifier = Modifier
                .width(112.dp)
                .height(13.dp),
            baseColor = baseColor,
            shape = RoundedCornerShape(7.dp),
        )
    }
}

@Composable
private fun SkeletonBlock(
    modifier: Modifier,
    baseColor: Color,
    shape: androidx.compose.ui.graphics.Shape,
) {
    Box(
        modifier = modifier
            .clip(shape)
            .background(baseColor),
    )
}

@Composable
internal fun MessageList(
    messages: List<TimelineMessage>,
    darkMode: Boolean,
    sessionId: String,
    controller: SessionDetailController,
    forceLatestRequest: Int,
    streamLatestRequest: Int,
    workingLabel: String?,
    turnInProgress: Boolean = workingLabel != null,
    notices: List<RuntimeNotice> = emptyList(),
    canRespondToNotices: Boolean = false,
    respondingNoticeIds: Set<String> = emptySet(),
    noticeResponseErrors: Map<String, String> = emptyMap(),
    bottomContentPadding: Dp = 168.dp,
    hasMore: Boolean,
    loadingOlder: Boolean,
    onLoadOlder: () -> Unit,
    onPreviewAttachment: (TimelineAttachment) -> Unit,
    onOpenAttachment: (TimelineAttachment) -> Unit,
    onCopyMessage: (String) -> Unit,
    onOpenFile: (String) -> Unit,
    onRespondNotice: (RuntimeNotice, RuntimeNoticeAction, Map<String, Any?>?) -> Unit = { _, _, _ -> },
) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val resumeThresholdPx = with(density) { AUTO_FOLLOW_RESUME_THRESHOLD.roundToPx() }
    val dragPauseThresholdPx = with(density) { AUTO_FOLLOW_DRAG_PAUSE_THRESHOLD.toPx() }
    val displayMessages = messages
    val displayWorkingLabel = workingLabel
    val openInteractions = remember(notices, sessionId) {
        notices.filter { it.openInteraction && !it.blocksSession(sessionId) }
    }
    val interactionByTarget = remember(openInteractions) {
        openInteractions.mapNotNull { notice -> notice.timelineTargetId()?.let { it to notice } }.toMap()
    }
    val detachedNotices = remember(openInteractions, notices) {
        openInteractions.filter { it.timelineTargetId() == null } + notices.filter(RuntimeNotice::openNotification)
    }
    val interactionTargetIds = remember(interactionByTarget) { interactionByTarget.keys }
    val timelineItems = remember(displayMessages, interactionTargetIds) {
        groupTimelineMessages(displayMessages, interactionTargetIds)
    }
    val agentCopyTextByTurnEnd = remember(timelineItems, turnInProgress) {
        buildAgentCopyTextByTurnEnd(timelineItems, turnInProgress)
    }
    var showScrollToBottom by remember { mutableStateOf(false) }
    var autoFollowLatest by remember(sessionId) { mutableStateOf(true) }
    var userPausedAutoFollow by remember(sessionId) { mutableStateOf(false) }
    val scrollButtonBottomPadding = bottomContentPadding.coerceAtLeast(24.dp)

    fun releaseReadLock() {
        userPausedAutoFollow = false
        autoFollowLatest = true
    }

    fun pauseAutoFollowWithSnapshot() {
        userPausedAutoFollow = true
        autoFollowLatest = false
    }

    LaunchedEffect(listState) {
        var lastPosition = listState.firstVisibleItemIndex * 1_000 + listState.firstVisibleItemScrollOffset
        var lastTime = System.nanoTime()
        snapshotFlow {
            (listState.firstVisibleItemIndex * 1_000 + listState.firstVisibleItemScrollOffset) to listState.isScrollInProgress
        }.collectLatest { (position, scrolling) ->
                val now = System.nanoTime()
                val elapsedMs = ((now - lastTime) / 1_000_000).coerceAtLeast(1)
                val slowEnough = abs(position - lastPosition) / elapsedMs < 2
                lastPosition = position
                lastTime = now
                if (position > 0 && (slowEnough || !scrolling)) {
                    delay(120)
                    showScrollToBottom = listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 0
                } else {
                    showScrollToBottom = false
                }
        }
    }

    LaunchedEffect(listState, resumeThresholdPx) {
        snapshotFlow {
            Triple(
                listState.isAtLatest(),
                listState.isNearLatest(resumeThresholdPx),
                listState.isScrollInProgress,
            )
        }
            .distinctUntilChanged()
            .collectLatest { (atLatest, nearLatest, scrolling) ->
                if (atLatest && !scrolling) {
                    releaseReadLock()
                } else if (nearLatest && !scrolling && !userPausedAutoFollow) {
                    autoFollowLatest = true
                }
            }
    }

    LaunchedEffect(forceLatestRequest) {
        if (forceLatestRequest > 0) {
            releaseReadLock()
            listState.scrollToItem(0)
        }
    }

    LaunchedEffect(streamLatestRequest) {
        if (shouldAutoFollowRealtime(
                hasRealtimeUpdate = streamLatestRequest > 0,
                autoFollowLatest = autoFollowLatest,
                userPaused = userPausedAutoFollow,
                scrolling = listState.isScrollInProgress,
            )
        ) {
            listState.scrollToItem(0)
        }
    }

    LaunchedEffect(listState, hasMore, loadingOlder, displayMessages.size) {
        snapshotFlow {
            val layout = listState.layoutInfo
            val total = layout.totalItemsCount
            val lastVisible = layout.visibleItemsInfo.maxOfOrNull { it.index } ?: -1
            total > 0 && lastVisible >= total - LOAD_OLDER_VISIBLE_THRESHOLD
        }
            .distinctUntilChanged()
            .collectLatest { nearOldest ->
                if (nearOldest && hasMore && !loadingOlder) {
                    onLoadOlder()
                }
            }
    }

    Box(Modifier.fillMaxSize()) {
        SessionSelectionContainer(modifier = Modifier.fillMaxSize()) {
            LazyColumn(
                state = listState,
                reverseLayout = true,
                modifier = Modifier
                    .fillMaxSize()
                    .imePadding()
                    .pointerInput(sessionId, dragPauseThresholdPx) {
                        awaitPointerEventScope {
                            while (true) {
                                val down = awaitPointerEvent(PointerEventPass.Initial)
                                    .changes
                                    .firstOrNull { it.pressed && !it.previousPressed }
                                    ?: continue
                                val pointerId = down.id
                                val startY = down.position.y

                                while (true) {
                                    val event = awaitPointerEvent(PointerEventPass.Initial)
                                    val change = event.changes.firstOrNull { it.id == pointerId }
                                        ?: event.changes.firstOrNull { it.pressed }
                                        ?: break
                                    if (!change.pressed) break
                                    if (abs(change.position.y - startY) >= dragPauseThresholdPx) {
                                        pauseAutoFollowWithSnapshot()
                                    }
                                }
                            }
                        }
                    }
                    .padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                item(key = "bottom-space") { Spacer(Modifier.height(bottomContentPadding)) }
                if (displayWorkingLabel != null) {
                    item(key = "working-indicator") {
                        DisableSelection {
                            WorkingIndicator(label = displayWorkingLabel)
                        }
                    }
                }
                items(detachedNotices.asReversed(), key = { "notice:${it.noticeId}" }) { notice ->
                    RuntimeNoticeCard(
                        notice = notice,
                        busy = notice.noticeId in respondingNoticeIds,
                        actionsDisabled = !canRespondToNotices || respondingNoticeIds.isNotEmpty(),
                        errorMessage = noticeResponseErrors[notice.noticeId],
                        onRespond = { action, input -> onRespondNotice(notice, action, input) },
                        notificationOnly = notice.type == "notification",
                    )
                }
                items(timelineItems.asReversed(), key = { it.key }) { item ->
                    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                        when (item) {
                            is TimelineRenderItem.Single -> TimelineMessageRow(
                                message = item.message,
                                darkMode = darkMode,
                                listState = listState,
                                sessionId = sessionId,
                                controller = controller,
                                onPreviewAttachment = onPreviewAttachment,
                                onOpenAttachment = onOpenAttachment,
                                onCopyMessage = onCopyMessage,
                                onOpenFile = onOpenFile,
                                interaction = interactionByTarget[item.message.sourceItemId],
                                canRespondToNotices = canRespondToNotices,
                                respondingNoticeIds = respondingNoticeIds,
                                noticeResponseErrors = noticeResponseErrors,
                                onRespondNotice = onRespondNotice,
                            )
                            is TimelineRenderItem.ToolRun -> ToolRunGroup(
                                messages = item.messages,
                                darkMode = darkMode,
                                listState = listState,
                                onOpenFile = onOpenFile,
                            )
                            is TimelineRenderItem.Reconnect -> ReconnectGroup(
                                messages = item.messages,
                                darkMode = darkMode,
                            )
                        }
                        agentCopyTextByTurnEnd[item.key]?.let { copyText ->
                            DisableSelection {
                                AgentReplyCopyAction(
                                    darkMode = darkMode,
                                    copyText = copyText,
                                    onCopyMessage = onCopyMessage,
                                )
                            }
                        }
                    }
                }
                if (loadingOlder) {
                    item(key = "loading-older") {
                        DisableSelection {
                            OlderMessagesLoadingIndicator()
                        }
                    }
                }
                item(key = "top-space") { Spacer(Modifier.height(74.dp)) }
            }
        }

        if (showScrollToBottom) {
            ScrollToBottomButton(
                onClick = {
                    scope.launch {
                        listState.animateToLatestFromAnywhere()
                        releaseReadLock()
                        listState.scrollToItem(0)
                    }
                },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .imePadding()
                    .padding(bottom = scrollButtonBottomPadding),
            )
        }
    }
}

private suspend fun LazyListState.animateToLatestFromAnywhere() {
    if (firstVisibleItemIndex > RETURN_TO_LATEST_ANIMATION_WINDOW) {
        scrollToItem(RETURN_TO_LATEST_ANIMATION_WINDOW)
    }
    animateScrollToItem(0)
}

private fun LazyListState.isNearLatest(thresholdPx: Int): Boolean {
    return firstVisibleItemIndex == 0 && firstVisibleItemScrollOffset <= thresholdPx
}

internal fun shouldAutoFollowRealtime(
    hasRealtimeUpdate: Boolean,
    autoFollowLatest: Boolean,
    userPaused: Boolean,
    scrolling: Boolean,
): Boolean = hasRealtimeUpdate && autoFollowLatest && !userPaused && !scrolling

private fun LazyListState.isAtLatest(): Boolean {
    return firstVisibleItemIndex == 0 && firstVisibleItemScrollOffset == 0
}

@Composable
private fun AgentReplyCopyAction(
    darkMode: Boolean,
    copyText: String,
    onCopyMessage: (String) -> Unit,
) {
    val divider = LocalAAColors.current.border.copy(alpha = 0.5f)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 4.dp, end = 4.dp, top = 3.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(divider),
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Start,
        ) {
            MessageCopyButton(
                darkMode = darkMode,
                label = stringResource(R.string.session_copy_reply),
                onClick = { onCopyMessage(copyText) },
            )
        }
    }
}

internal fun groupTimelineMessages(
    messages: List<TimelineMessage>,
    interactionTargetIds: Set<String> = emptySet(),
): List<TimelineRenderItem> {
    val result = mutableListOf<TimelineRenderItem>()
    val pendingTools = mutableListOf<TimelineMessage>()
    val pendingReconnects = mutableListOf<TimelineMessage>()

    fun flushTools() {
        when (pendingTools.size) {
            0 -> Unit
            1 -> result += TimelineRenderItem.Single(pendingTools.first())
            else -> result += TimelineRenderItem.ToolRun(pendingTools.toList())
        }
        pendingTools.clear()
    }

    fun flushReconnects() {
        when (pendingReconnects.size) {
            0 -> Unit
            1 -> result += TimelineRenderItem.Single(pendingReconnects.first())
            else -> result += TimelineRenderItem.Reconnect(pendingReconnects.toList())
        }
        pendingReconnects.clear()
    }

    for (message in messages) {
        if (message.isReconnectError() && message.sourceItemId !in interactionTargetIds) {
            flushTools()
            pendingReconnects += message
        } else if (message.isToolRunItem() && message.sourceItemId !in interactionTargetIds) {
            flushReconnects()
            pendingTools += message
        } else {
            flushReconnects()
            flushTools()
            result += TimelineRenderItem.Single(message)
        }
    }
    flushReconnects()
    flushTools()
    return result
}

private fun buildAgentCopyTextByTurnEnd(
    items: List<TimelineRenderItem>,
    latestTurnInProgress: Boolean,
): Map<String, String> {
    return buildMap {
        val replyParts = mutableListOf<String>()
        var turnEndKey: String? = null
        var hasOpenTurn = false

        fun finishTurn(includeCopyAction: Boolean = true) {
            val copyText = replyParts
                .filter(String::isNotBlank)
                .joinToString("\n\n")
                .trim()
            if (includeCopyAction && copyText.isNotBlank()) {
                turnEndKey?.let { put(it, copyText) }
            }
            replyParts.clear()
            turnEndKey = null
            hasOpenTurn = false
        }

        items.forEach { item ->
            val startsTurn = item.messages.any { message ->
                message.kind == TimelineMessageKind.Text && message.author == MessageAuthor.User
            }
            if (startsTurn && hasOpenTurn) finishTurn()
            if (startsTurn) hasOpenTurn = true

            val copyableParts = item.messages
                .map(TimelineMessage::agentCopyText)
                .filter(String::isNotBlank)
            if (copyableParts.isNotEmpty() && !hasOpenTurn) {
                // Older pages can begin in the middle of a turn, before its user item is loaded.
                hasOpenTurn = true
            }
            if (hasOpenTurn) {
                turnEndKey = item.key
                replyParts += copyableParts
            }
        }
        if (hasOpenTurn) finishTurn(includeCopyAction = !latestTurnInProgress)
    }
}

private fun TimelineMessage.isCopyableAgentText(): Boolean {
    return kind == TimelineMessageKind.Text && author == MessageAuthor.Agent
}

private fun TimelineMessage.agentCopyText(): String {
    return if (isCopyableAgentText()) text.trimEnd('\r', '\n') else ""
}

private fun TimelineMessage.isToolRunItem(): Boolean {
    return kind == TimelineMessageKind.Reasoning ||
        kind == TimelineMessageKind.Command ||
        kind == TimelineMessageKind.FileChange ||
        kind == TimelineMessageKind.ToolCall ||
        (kind == TimelineMessageKind.Artifact && contentKind != "diff")
}

private fun TimelineMessage.isReconnectError(): Boolean =
    type == "system" && status == "failed" && text.startsWith("Reconnecting...")

internal fun diagnosticTimelineText(message: TimelineMessage): String {
    return message.takeIf { it.kind == TimelineMessageKind.Diagnostic }?.text.orEmpty()
}

@Composable
private fun OlderMessagesLoadingIndicator() {
    val color = LocalAAColors.current.ink
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(
            color = color,
            strokeWidth = 2.dp,
            modifier = Modifier.size(22.dp),
        )
    }
}

@Composable
private fun ToolRunGroup(
    messages: List<TimelineMessage>,
    darkMode: Boolean,
    listState: LazyListState,
    onOpenFile: (String) -> Unit = {},
) {
    val colors = LocalAAColors.current
    val primary = colors.ink
    val muted = colors.muted
    val surface = colors.sessionTimelineActivitySurface
    val haptic = LocalHapticFeedback.current
    val active = messages.any { it.status in setOf("pending", "running", "waiting_approval") }
    val failed = messages.any { it.status in setOf("failed", "cancelled", "interrupted") }
    var expanded by remember(messages.joinToString(":") { it.id }) { mutableStateOf(false) }
    var cardTop by remember(messages.joinToString(":") { it.id }) { mutableStateOf<Float?>(null) }
    var lockedTop by remember(messages.joinToString(":") { it.id }) { mutableStateOf<Float?>(null) }

    fun toggleExpanded() {
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        lockedTop = cardTop
        expanded = !expanded
    }

    val modifier = Modifier
        .fillMaxWidth()
        .padding(horizontal = 4.dp)
        .onGloballyPositioned {
            val nextTop = it.positionInWindow().y
            val delta = (lockedTop ?: nextTop) - nextTop
            if (abs(delta) > 1f) listState.dispatchRawDelta(delta)
            lockedTop = null
            cardTop = nextTop
        }

    if (!expanded) {
        Row(
            modifier = modifier
                .heightIn(min = 34.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(surface)
                .then(if (active) Modifier.shimmer() else Modifier)
                .noRippleClickable(onClick = ::toggleExpanded)
                .padding(horizontal = 6.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TimelineChevron(expanded = false, tint = muted)
            Icon(
                imageVector = Lucide.Hammer,
                contentDescription = null,
                tint = if (failed) colors.errorIcon else muted,
                modifier = Modifier.size(16.dp),
            )
            Text(
                text = toolRunSummary(messages),
                modifier = Modifier.weight(1f),
                color = if (failed) LocalAAColors.current.errorIcon else muted,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        return
    }

    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 34.dp)
                .noRippleClickable(onClick = ::toggleExpanded)
                .padding(horizontal = 6.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TimelineChevron(expanded = true, tint = muted)
            Icon(
                imageVector = Lucide.Hammer,
                contentDescription = null,
                tint = if (failed) colors.errorIcon else muted,
                modifier = Modifier.size(16.dp),
            )
            Text(
                text = toolRunSummary(messages),
                modifier = Modifier.weight(1f),
                color = if (failed) LocalAAColors.current.errorIcon else primary,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        messages.forEach { message ->
            if (message.kind == TimelineMessageKind.Reasoning) {
                ReasoningSection(
                    message = message,
                    darkMode = darkMode,
                    listState = listState,
                    embedded = true,
                )
            } else {
                ToolActivityCard(
                    message = message,
                    darkMode = darkMode,
                    listState = listState,
                    embedded = true,
                    onOpenFile = onOpenFile,
                )
            }
        }
    }
}

@Composable
private fun toolRunSummary(messages: List<TimelineMessage>): String {
    val commands = messages.count { it.kind == TimelineMessageKind.Command }
    val reasoning = messages.count { it.kind == TimelineMessageKind.Reasoning }
    val changes = messages.flatMap { it.fileChanges }
    val fileChanges = changes.count { it.action != "add" }
    val createdFiles = changes.count { it.action == "add" }
    val parts = buildList {
        if (reasoning > 0) add(stringResource(R.string.session_tool_summary_reasoning, reasoning))
        if (commands > 0) add(stringResource(R.string.session_tool_summary_commands, commands))
        if (fileChanges > 0) add(stringResource(R.string.session_tool_summary_changed_files, fileChanges))
        if (createdFiles > 0) add(stringResource(R.string.session_tool_summary_created_files, createdFiles))
    }
    return parts.joinToString(", ").ifBlank {
        stringResource(R.string.session_tool_summary_items, messages.size)
    }
}

@Composable
private fun ReconnectGroup(messages: List<TimelineMessage>, darkMode: Boolean) {
    val muted = LocalAAColors.current.muted
    var expanded by remember(messages.joinToString(":") { it.id }) { mutableStateOf(false) }
    val attempts = messages.mapNotNull { message ->
        Regex("(\\d+\\s*/\\s*\\d+)").find(message.text)?.groupValues?.getOrNull(1)?.replace(" ", "")
    }
    val first = attempts.firstOrNull()
    val last = attempts.lastOrNull()
    val range = if (first != null && last != null && first != last) "$first–$last" else last ?: messages.size.toString()
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 6.dp)
                .noRippleClickable { expanded = !expanded },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TimelineChevron(expanded = expanded, tint = muted)
            Icon(
                imageVector = Lucide.WifiOff,
                contentDescription = null,
                tint = muted,
                modifier = Modifier.size(16.dp),
            )
            Text(
                text = stringResource(R.string.session_reconnect_summary, range),
                color = muted,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
        if (expanded) {
            messages.forEach { message -> ToolPlaceholder(message, darkMode) }
        }
    }
}

@Composable
private fun WorkingIndicator(label: String) {
    val muted = LocalAAColors.current.muted
    Row(
        modifier = Modifier.padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WorkingSpinner(color = muted)
        Text(
            text = label,
            color = muted,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun WorkingSpinner(color: Color) {
    val transition = rememberInfiniteTransition(label = "agent-working")
    val rotation by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1_600, easing = LinearEasing),
        ),
        label = "agent-working-rotation",
    )

    Canvas(
        modifier = Modifier
            .size(16.dp)
            .graphicsLayer { rotationZ = rotation },
    ) {
        val strokeWidth = 2.dp.toPx()
        drawCircle(
            color = color.copy(alpha = 0.24f),
            style = Stroke(width = strokeWidth),
        )
        drawArc(
            color = color,
            startAngle = -90f,
            sweepAngle = 100f,
            useCenter = false,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )
    }
}

@Composable
private fun ScrollToBottomButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current

    Box(
        modifier = modifier
            .size(48.dp)
            .shadow(10.dp, CircleShape, ambientColor = colors.appShadow, spotColor = colors.appShadow)
            .clip(CircleShape)
            .background(colors.raisedSurface)
            .border(1.dp, colors.border, CircleShape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Lucide.ArrowDown,
            contentDescription = null,
            tint = colors.ink,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun TimelineMessageRow(
    message: TimelineMessage,
    darkMode: Boolean,
    listState: LazyListState,
    sessionId: String,
    controller: SessionDetailController,
    onPreviewAttachment: (TimelineAttachment) -> Unit,
    onOpenAttachment: (TimelineAttachment) -> Unit,
    onCopyMessage: (String) -> Unit,
    onOpenFile: (String) -> Unit,
    interaction: RuntimeNotice? = null,
    canRespondToNotices: Boolean = false,
    respondingNoticeIds: Set<String> = emptySet(),
    noticeResponseErrors: Map<String, String> = emptyMap(),
    onRespondNotice: (RuntimeNotice, RuntimeNoticeAction, Map<String, Any?>?) -> Unit = { _, _, _ -> },
) {
    when (message.kind) {
        TimelineMessageKind.Reasoning -> ReasoningSection(
            message = message,
            darkMode = darkMode,
            listState = listState,
        )
        TimelineMessageKind.Command,
        TimelineMessageKind.FileChange,
        TimelineMessageKind.ToolCall,
        TimelineMessageKind.Artifact -> ToolActivityCard(
            message = message,
            darkMode = darkMode,
            listState = listState,
            onOpenFile = onOpenFile,
            interaction = interaction,
            interactionBusy = interaction?.noticeId?.let { it in respondingNoticeIds } == true,
            actionsDisabled = !canRespondToNotices || respondingNoticeIds.isNotEmpty(),
            interactionError = interaction?.noticeId?.let(noticeResponseErrors::get),
            onRespondNotice = { notice, action, input -> onRespondNotice(notice, action, input) },
        )
        TimelineMessageKind.Marker,
        TimelineMessageKind.Error,
        TimelineMessageKind.Diagnostic,
        TimelineMessageKind.System -> ToolPlaceholder(message, darkMode, onCopyMessage)
        TimelineMessageKind.Text -> when (message.author) {
            MessageAuthor.User -> UserBubble(
                message,
                darkMode,
                sessionId,
                controller,
                onPreviewAttachment,
                onOpenAttachment,
                onCopyMessage,
            )
            MessageAuthor.Agent -> AgentMessageContent(
                message = message,
                darkMode = darkMode,
                sessionId = sessionId,
                controller = controller,
                onPreviewAttachment = onPreviewAttachment,
                onOpenAttachment = onOpenAttachment,
                onOpenFile = onOpenFile,
            )
            MessageAuthor.Tool -> PlatformMessageContent(
                message = message,
                darkMode = darkMode,
                sessionId = sessionId,
                controller = controller,
                onPreviewAttachment = onPreviewAttachment,
                onOpenAttachment = onOpenAttachment,
            )
        }
    }
}

@Composable
private fun AgentMessageContent(
    message: TimelineMessage,
    darkMode: Boolean,
    sessionId: String,
    controller: SessionDetailController,
    onPreviewAttachment: (TimelineAttachment) -> Unit,
    onOpenAttachment: (TimelineAttachment) -> Unit,
    onOpenFile: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (message.text.isNotBlank()) AgentMarkdownText(message.text, darkMode, onOpenFile = onOpenFile)
        UserAttachmentStrip(
            attachments = message.attachments,
            darkMode = darkMode,
            sessionId = sessionId,
            controller = controller,
            onPreviewAttachment = onPreviewAttachment,
            onOpenAttachment = onOpenAttachment,
            alignEnd = false,
        )
    }
}

@Composable
private fun PlatformMessageContent(
    message: TimelineMessage,
    darkMode: Boolean,
    sessionId: String,
    controller: SessionDetailController,
    onPreviewAttachment: (TimelineAttachment) -> Unit,
    onOpenAttachment: (TimelineAttachment) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (message.text.isNotBlank()) ToolPlaceholder(message, darkMode)
        UserAttachmentStrip(
            attachments = message.attachments,
            darkMode = darkMode,
            sessionId = sessionId,
            controller = controller,
            onPreviewAttachment = onPreviewAttachment,
            onOpenAttachment = onOpenAttachment,
            alignEnd = false,
        )
    }
}

@Composable
private fun UserBubble(
    message: TimelineMessage,
    darkMode: Boolean,
    sessionId: String,
    controller: SessionDetailController,
    onPreviewAttachment: (TimelineAttachment) -> Unit,
    onOpenAttachment: (TimelineAttachment) -> Unit,
    onCopyMessage: (String) -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val maxBubbleWidth = maxWidth * 0.78f
        val meta = when (message.status) {
            "failed" -> stringResource(R.string.session_status_failed)
            else -> ""
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
        ) {
            Column(
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                val hasAttachments = message.attachments.isNotEmpty()
                val text = message.text
                    .trimEnd('\r', '\n')
                    .takeUnless { it == "(No text content.)" && hasAttachments }
                    .orEmpty()
                var expanded by remember(message.id, text) { mutableStateOf(false) }
                var canExpand by remember(message.id, text) { mutableStateOf(false) }
                UserAttachmentStrip(
                    attachments = message.attachments,
                    darkMode = darkMode,
                    sessionId = sessionId,
                    controller = controller,
                    onPreviewAttachment = onPreviewAttachment,
                    onOpenAttachment = onOpenAttachment,
                )
                if (text.isNotBlank()) {
                    Row(
                        modifier = Modifier.widthIn(max = maxBubbleWidth + 38.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.Bottom,
                    ) {
                        DisableSelection {
                            MessageCopyButton(
                                darkMode = darkMode,
                                onClick = { onCopyMessage(text) },
                                modifier = Modifier.padding(bottom = 3.dp),
                            )
                        }
                        Box(
                            modifier = Modifier
                                .widthIn(max = maxBubbleWidth)
                                .clip(RoundedCornerShape(22.dp))
                                .background(LocalAAColors.current.sessionMessageBubble)
                                .padding(horizontal = 17.dp, vertical = 13.dp),
                        ) {
                            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                                Text(
                                    text = text,
                                    color = LocalAAColors.current.sessionMessageText,
                                    fontSize = 16.5.sp,
                                    lineHeight = 24.sp,
                                    fontWeight = FontWeight.Normal,
                                    maxLines = if (expanded) Int.MAX_VALUE else 8,
                                    overflow = TextOverflow.Ellipsis,
                                    onTextLayout = { result ->
                                        if (!expanded) canExpand = result.hasVisualOverflow
                                    },
                                )
                                if (canExpand || expanded) {
                                    DisableSelection {
                                        Text(
                                            text = if (expanded) {
                                                stringResource(R.string.session_show_less)
                                            } else {
                                                stringResource(R.string.session_read_more)
                                            },
                                            color = LocalAAColors.current.noticeWarning,
                                            fontSize = 12.sp,
                                            fontWeight = FontWeight.Bold,
                                            modifier = Modifier.noRippleClickable { expanded = !expanded },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                if (meta.isNotBlank()) {
                    DisableSelection {
                        Text(
                            text = meta,
                            color = if (message.status == "failed") {
                                LocalAAColors.current.errorIcon
                            } else {
                                LocalAAColors.current.muted
                            },
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageCopyButton(
    darkMode: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
) {
    val iconRes = if (darkMode) R.drawable.ic_copy_bash_command_light else R.drawable.ic_copy_bash_command_dark
    val contentColor = LocalAAColors.current.muted
    Row(
        modifier = modifier
            .height(30.dp)
            .then(
                if (label == null) {
                    Modifier
                        .width(30.dp)
                        .clip(CircleShape)
                } else {
                    Modifier.padding(start = 8.dp, end = 10.dp)
                },
            )
            .noRippleClickable(onClick = onClick),
        horizontalArrangement = Arrangement.spacedBy(if (label == null) 0.dp else 9.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(
            painter = painterResource(iconRes),
            contentDescription = label ?: stringResource(R.string.common_copy),
            modifier = Modifier.size(17.dp),
        )
        if (label != null) {
            Text(
                text = label,
                color = contentColor,
                fontSize = 12.sp,
                lineHeight = 14.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun UserAttachmentStrip(
    attachments: List<TimelineAttachment>,
    darkMode: Boolean,
    sessionId: String,
    controller: SessionDetailController,
    onPreviewAttachment: (TimelineAttachment) -> Unit,
    onOpenAttachment: (TimelineAttachment) -> Unit,
    alignEnd: Boolean = true,
) {
    if (attachments.isEmpty()) return
    Column(
        horizontalAlignment = if (alignEnd) Alignment.End else Alignment.Start,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        attachments.forEach { attachment ->
            if (attachment.isImage) {
                RemoteAttachmentImage(
                    sessionId = sessionId,
                    controller = controller,
                    attachment = attachment,
                    modifier = Modifier
                        .size(width = 196.dp, height = 142.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .noRippleClickable { onPreviewAttachment(attachment) },
                    contentScale = ContentScale.Crop,
                )
            } else {
                UserFileAttachmentCard(
                    attachment = attachment,
                    darkMode = darkMode,
                    onOpen = { onOpenAttachment(attachment) },
                )
            }
        }
    }
}

@Composable
private fun UserFileAttachmentCard(
    attachment: TimelineAttachment,
    darkMode: Boolean,
    onOpen: () -> Unit,
) {
    val colors = LocalAAColors.current
    val iconRes = if (darkMode) R.drawable.ic_attachment_file_white else R.drawable.ic_attachment_file_black

    Row(
        modifier = Modifier
            .width(224.dp)
            .height(72.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(colors.sessionMessageBubble)
            .noRippleClickable(onClick = onOpen)
            .padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(42.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(colors.raisedSurface.copy(alpha = 0.86f)),
            contentAlignment = Alignment.Center,
        ) {
            Image(
                painter = painterResource(iconRes),
                contentDescription = null,
                modifier = Modifier.size(22.dp),
            )
        }
        Column(Modifier.weight(1f)) {
            Text(
                text = attachment.name,
                color = colors.sessionMessageText,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = formatBytes(attachment.size),
                color = colors.muted,
                fontSize = 11.sp,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun ReasoningSection(
    message: TimelineMessage,
    darkMode: Boolean,
    listState: LazyListState,
    embedded: Boolean = false,
) {
    val colors = LocalAAColors.current
    val muted = colors.muted
    val segments = message.reasoningSegments.ifEmpty { listOfNotNull(message.text.takeIf(String::isNotBlank)) }
    val inlineSummary = segments.singleOrNull()?.let(::inlineReasoningSummary)
    val title = when {
        inlineSummary != null -> stringResource(R.string.session_reasoning_single_summary, inlineSummary)
        segments.isNotEmpty() -> stringResource(R.string.session_reasoning_summary, segments.size)
        else -> stringResource(R.string.session_reasoning)
    }
    val expandable = segments.isNotEmpty() && inlineSummary == null
    var expanded by remember(message.id) { mutableStateOf(false) }
    var sectionTop by remember(message.id) { mutableStateOf<Float?>(null) }
    var lockedTop by remember(message.id) { mutableStateOf<Float?>(null) }

    fun toggleExpanded() {
        lockedTop = sectionTop
        expanded = !expanded
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .onGloballyPositioned {
                val nextTop = it.positionInWindow().y
                val delta = (lockedTop ?: nextTop) - nextTop
                if (abs(delta) > 1f) listState.dispatchRawDelta(delta)
                lockedTop = null
                sectionTop = nextTop
            }
            .then(if (embedded) Modifier else Modifier.padding(horizontal = 4.dp)),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 34.dp)
                .then(if (expandable) Modifier.noRippleClickable(onClick = ::toggleExpanded) else Modifier)
                .padding(horizontal = 6.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (expandable) {
                TimelineChevron(expanded = expanded, tint = muted)
            }
            Icon(
                imageVector = Lucide.Sparkles,
                contentDescription = null,
                tint = muted,
                modifier = Modifier.size(16.dp),
            )
            Text(
                text = title,
                modifier = Modifier.weight(1f),
                color = colors.ink,
                fontSize = 13.sp,
                fontWeight = TimelineActivityLabelWeight,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (expanded && expandable) {
            Box(modifier = Modifier.padding(start = 30.dp, end = 6.dp)) {
                AgentMarkdownText(
                    text = segments.joinToString("\n\n"),
                    darkMode = darkMode,
                    onOpenFile = {},
                    compact = true,
                )
            }
        }
    }
}

private fun inlineReasoningSummary(text: String): String? {
    if ('\n' in text || '\r' in text) return null
    val plain = text
        .replace(Regex("!\\[([^]]*)]\\([^)]+\\)"), "$1")
        .replace(Regex("\\[([^]]+)]\\([^)]+\\)"), "$1")
        .replace(Regex("`([^`]+)`"), "$1")
        .replace(Regex("[*_~#>]+"), "")
        .replace(Regex("\\s+"), " ")
        .trim()
    return plain.takeIf { it.isNotEmpty() && it.length <= 80 }
}

private val TimelineActivityLabelWeight = FontWeight.Normal

@Composable
private fun ToolActivityCard(
    message: TimelineMessage,
    darkMode: Boolean,
    listState: LazyListState,
    embedded: Boolean = false,
    onOpenFile: (String) -> Unit = {},
    interaction: RuntimeNotice? = null,
    interactionBusy: Boolean = false,
    actionsDisabled: Boolean = false,
    interactionError: String? = null,
    onRespondNotice: (RuntimeNotice, RuntimeNoticeAction, Map<String, Any?>?) -> Unit = { _, _, _ -> },
) {
    val colors = LocalAAColors.current
    val surface = colors.subtle
    val border = colors.border
    val primary = colors.ink
    val muted = colors.muted
    val collapsedSurface = colors.sessionTimelineActivitySurface
    val hasDetail = message.kind == TimelineMessageKind.Command ||
        message.kind == TimelineMessageKind.FileChange ||
        (message.kind == TimelineMessageKind.ToolCall && message.hasToolCallDetail) ||
        (message.kind == TimelineMessageKind.Artifact && message.rawContent.isNotBlank())
    val expandable = hasDetail || interaction != null
    val active = message.status in setOf("pending", "running", "waiting_approval")
    val failed = message.status in setOf("failed", "cancelled", "interrupted")
    val haptic = LocalHapticFeedback.current
    var expanded by remember(message.id) { mutableStateOf(interaction != null) }
    var cardTop by remember(message.id) { mutableStateOf<Float?>(null) }
    var lockedTop by remember(message.id) { mutableStateOf<Float?>(null) }
    fun toggleExpanded() {
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        lockedTop = cardTop
        expanded = !expanded
    }
    LaunchedEffect(interaction?.noticeId) {
        if (interaction != null) expanded = true
    }
    val target = toolActivitySummary(message)
    val cardModifier = Modifier
        .fillMaxWidth()
        .onGloballyPositioned {
            val nextTop = it.positionInWindow().y
            val delta = (lockedTop ?: nextTop) - nextTop
            if (abs(delta) > 1f) listState.dispatchRawDelta(delta)
            lockedTop = null
            cardTop = nextTop
        }
        .then(if (embedded) Modifier else Modifier.padding(horizontal = 4.dp))

    Column(
        modifier = cardModifier,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 34.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(collapsedSurface)
                .then(if (active) Modifier.shimmer() else Modifier)
                .then(
                    when {
                        expandable -> Modifier.noRippleClickable { toggleExpanded() }
                        message.kind == TimelineMessageKind.Artifact && message.detail.isNotBlank() -> {
                            Modifier.noRippleClickable { onOpenFile(message.detail) }
                        }
                        else -> Modifier
                    },
                )
                .padding(horizontal = 6.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (expandable) {
                TimelineChevron(expanded = expanded, tint = muted)
            } else {
                Spacer(Modifier.width(16.dp))
            }
            ToolActivityIcon(kind = message.kind, failed = failed)
            Text(
                text = target,
                modifier = Modifier.weight(1f),
                color = if (failed) LocalAAColors.current.errorIcon else primary,
                fontSize = 13.sp,
                fontWeight = TimelineActivityLabelWeight,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (message.kind == TimelineMessageKind.Artifact) {
                CompactStatusPill(label = message.status)
            }
        }
        if (expanded && expandable) {
            if (hasDetail) {
                DisableSelection {
                    ToolActivityDetailCard(
                        message = message,
                        darkMode = darkMode,
                        onOpenFile = onOpenFile,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(14.dp))
                            .background(surface)
                            .border(1.dp, border, RoundedCornerShape(14.dp)),
                    )
                }
            }
            interaction?.let { notice ->
                RuntimeNoticeCard(
                    notice = notice,
                    busy = interactionBusy,
                    actionsDisabled = actionsDisabled,
                    errorMessage = interactionError,
                    onRespond = { action, input -> onRespondNotice(notice, action, input) },
                    compact = true,
                )
            }
        }
    }
}

@Composable
private fun toolActivitySummary(message: TimelineMessage): String {
    return when (message.kind) {
        TimelineMessageKind.Command -> stringResource(
            R.string.session_tool_ran,
            message.command.ifBlank { message.detail.ifBlank { stringResource(R.string.session_command_fallback) } },
        )
        TimelineMessageKind.FileChange -> {
            val changes = message.fileChanges
            val createdOnly = changes.isNotEmpty() && changes.all { it.action == "add" }
            val singlePath = changes.singleOrNull()?.path?.substringAfterLast('/')
            when {
                singlePath != null && singlePath.length <= 60 -> stringResource(
                    if (createdOnly) R.string.session_tool_created_file else R.string.session_tool_changed_file,
                    singlePath,
                )
                createdOnly -> stringResource(R.string.session_tool_created_files)
                else -> stringResource(R.string.session_tool_changed_files)
            }
        }
        TimelineMessageKind.ToolCall -> when (message.contentKind) {
            "web_search" -> stringResource(
                R.string.session_tool_searched,
                message.subtitle.ifBlank { stringResource(R.string.session_tool_web_fallback) },
            )
            else -> listOf(message.title.ifBlank { message.text }, message.subtitle)
                .filter(String::isNotBlank)
                .distinct()
                .joinToString(" ")
        }
        else -> message.subtitle.ifBlank { message.text }.ifBlank { message.title }
    }
}

@Composable
private fun ToolActivityDetailCard(
    message: TimelineMessage,
    darkMode: Boolean,
    onOpenFile: (String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val muted = LocalAAColors.current.muted

    Column(
        modifier = modifier.padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        when (message.kind) {
            TimelineMessageKind.Command -> {
                CommandPreview(
                    command = message.command.ifBlank { message.detail.ifBlank { message.subtitle } },
                    output = message.output.ifBlank { message.body },
                    darkMode = darkMode,
                )
            }
            TimelineMessageKind.FileChange -> {
                message.fileChanges.ifEmpty {
                    listOf(com.agentsanywhere.app.feature.sessiondetail.TimelineFileChange(message.title, message.detail, message.body))
                }.forEach { change ->
                    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                imageVector = Lucide.FilePenLine,
                                contentDescription = null,
                                tint = muted,
                                modifier = Modifier.size(16.dp),
                            )
                            Text(
                                text = listOf(fileChangeActionLabel(change.action), change.path)
                                    .filter(String::isNotBlank)
                                    .joinToString(" "),
                                color = muted,
                                fontSize = 12.sp,
                                lineHeight = 17.sp,
                                fontWeight = FontWeight.Medium,
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                        if (change.diff.isNotBlank()) {
                            DiffPreview(diff = change.diff, path = change.path, darkMode = darkMode)
                        }
                    }
                }
            }
            TimelineMessageKind.ToolCall -> {
                ToolCallPreview(message = message, darkMode = darkMode)
            }
            TimelineMessageKind.Artifact -> {
                if (message.detail.isNotBlank()) {
                    Text(
                        text = message.detail,
                        color = muted,
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.noRippleClickable { onOpenFile(message.detail) },
                    )
                }
                if (message.rawContent.isNotBlank()) {
                    SoraCodeBlock(text = message.rawContent, languageHint = "json", darkMode = darkMode)
                }
            }
            else -> Unit
        }
    }
}

@Composable
private fun fileChangeActionLabel(action: String): String = when (action) {
    "add" -> stringResource(R.string.session_file_change_added)
    "delete" -> stringResource(R.string.session_file_change_deleted)
    "rename" -> stringResource(R.string.session_file_change_renamed)
    "update" -> stringResource(R.string.session_file_change_modified)
    else -> stringResource(R.string.session_file_change_changed)
}

internal fun TimelineMessage.toolSummaryTarget(): String {
    return if (kind == TimelineMessageKind.ToolCall) {
        listOf(title.ifBlank { text }, subtitle)
            .filter(String::isNotBlank)
            .joinToString(" ")
    } else {
        subtitle.ifBlank { text }.ifBlank { title }
    }
}

@Composable
private fun ToolCallPreview(message: TimelineMessage, darkMode: Boolean) {
    val input = message.input.ifBlank { message.detail }
    val output = message.output
    val error = message.toolError
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (input.isNotBlank()) {
            CommandPreviewSection(
                label = stringResource(R.string.session_input),
                text = input,
                languageHint = null,
                darkMode = darkMode,
            )
        }
        if (output.isNotBlank()) {
            CommandPreviewSection(
                label = stringResource(R.string.session_output),
                text = output,
                languageHint = null,
                darkMode = darkMode,
            )
        }
        if (error.isNotBlank()) {
            CommandPreviewSection(
                label = stringResource(R.string.session_error),
                text = error,
                languageHint = null,
                darkMode = darkMode,
            )
        }
    }
}

private val TimelineMessage.hasToolCallDetail: Boolean
    get() = input.isNotBlank() || output.isNotBlank() || toolError.isNotBlank() ||
        detail.isNotBlank() || body.isNotBlank()

@Composable
private fun CommandPreview(command: String, output: String, darkMode: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        CommandLineBar(command = command.ifBlank { stringResource(R.string.session_command_fallback) }, darkMode = darkMode)
        if (output.isNotBlank()) {
            CommandPreviewSection(
                label = stringResource(R.string.session_output),
                text = output,
                languageHint = null,
                darkMode = darkMode,
            )
        }
    }
}

@Composable
private fun CommandLineBar(command: String, darkMode: Boolean) {
    val colors = LocalAAColors.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.session_command),
                color = colors.muted,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
            CopyToolValueButton(value = command, darkMode = darkMode)
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(colors.sessionCodeSurface)
                .border(1.dp, colors.border, RoundedCornerShape(14.dp))
                .padding(horizontal = 10.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                text = "$",
                color = colors.muted,
                fontSize = 13.sp,
                lineHeight = 18.sp,
                fontWeight = FontWeight.ExtraBold,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                text = command,
                color = colors.inkSoft,
                fontSize = 13.sp,
                lineHeight = 18.sp,
                fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.Monospace,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                style = TextStyle(letterSpacing = 0.sp),
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun CommandPreviewSection(
    label: String,
    text: String,
    languageHint: String?,
    darkMode: Boolean,
) {
    val muted = LocalAAColors.current.muted
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = label,
                color = muted,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
            CopyToolValueButton(value = text, darkMode = darkMode)
        }
        SoraCodeBlock(text = text, languageHint = languageHint, darkMode = darkMode)
    }
}

@Composable
private fun CopyToolValueButton(value: String, darkMode: Boolean) {
    val clipboard = LocalClipboardManager.current
    MessageCopyButton(
        darkMode = darkMode,
        onClick = { clipboard.setText(AnnotatedString(value)) },
    )
}

@Composable
private fun DiffPreview(diff: String, path: String, darkMode: Boolean) {
    val preview = remember(diff) { diffPreview(diff) }
    val muted = LocalAAColors.current.muted
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.session_diff),
                color = muted,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
            )
            CopyToolValueButton(value = diff, darkMode = darkMode)
        }
        SoraCodeBlock(
            text = preview.text.ifBlank { stringResource(R.string.session_no_preview) },
            languageHint = path,
            darkMode = darkMode,
            diffHighlights = preview.highlights,
        )
    }
}

@Composable
private fun ToolActivityIcon(
    kind: TimelineMessageKind,
    failed: Boolean,
) {
    val colors = LocalAAColors.current
    val imageVector = when (kind) {
        TimelineMessageKind.Command -> Lucide.SquareTerminal
        TimelineMessageKind.FileChange,
        TimelineMessageKind.Artifact -> Lucide.FilePenLine
        else -> Lucide.Hammer
    }
    Icon(
        imageVector = imageVector,
        contentDescription = null,
        tint = if (failed) colors.errorIcon else colors.muted,
        modifier = Modifier.size(16.dp),
    )
}

@Composable
private fun TimelineChevron(expanded: Boolean, tint: Color) {
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 0f else -90f,
        animationSpec = tween(durationMillis = 200),
        label = "timeline-chevron-rotation",
    )
    Icon(
        imageVector = Lucide.ChevronDown,
        contentDescription = null,
        tint = tint,
        modifier = Modifier
            .size(16.dp)
            .rotate(rotation),
    )
}

@Composable
private fun CompactStatusPill(label: String, destructive: Boolean = false) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .height(20.dp)
            .widthIn(min = 40.dp)
            .clip(CircleShape)
            .background(
                if (destructive) colors.errorSurface
                else colors.sessionStatusNeutralSurface,
            )
            .padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            color = if (destructive) colors.errorText
            else colors.sessionStatusNeutralText,
            fontSize = 11.sp,
            lineHeight = 11.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

@Composable
private fun ToolPlaceholder(
    message: TimelineMessage,
    darkMode: Boolean,
    onCopyMessage: ((String) -> Unit)? = null,
) {
    val destructive = message.kind == TimelineMessageKind.Error ||
        message.status in setOf("failed", "cancelled", "interrupted")
    val compact = message.contentKind == "compact" || message.title == "compact"
    val displayText = when {
        compact -> when {
            destructive -> stringResource(R.string.session_conversation_compaction_failed)
            message.status in setOf("pending", "running") -> stringResource(R.string.session_conversation_compacting)
            else -> stringResource(R.string.session_conversation_compacted)
        }
        message.kind == TimelineMessageKind.Diagnostic -> stringResource(
            R.string.session_timeline_unknown_item,
            listOf(message.type, message.contentKind).filter(String::isNotBlank).joinToString(" / "),
        )
        else -> message.text.ifBlank { message.type }
    }
    val active = compact && message.status in setOf("pending", "running")
    val expandable = !compact && message.rawContent.isNotBlank()
    var expanded by remember(message.id) { mutableStateOf(false) }
    val colors = LocalAAColors.current
    val muted = if (destructive) colors.errorIcon else colors.muted
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier
                .padding(horizontal = 4.dp)
                .then(if (active) Modifier.shimmer() else Modifier)
                .then(if (expandable) Modifier.noRippleClickable { expanded = !expanded } else Modifier),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!compact) {
                if (expandable) {
                    TimelineChevron(expanded = expanded, tint = muted)
                }
                Icon(
                    imageVector = if (destructive) Lucide.CircleAlert else Lucide.Clock,
                    contentDescription = null,
                    tint = muted,
                    modifier = Modifier.size(16.dp),
                )
            }
            Text(
                text = displayText,
                modifier = Modifier.weight(1f, fill = false),
                color = muted,
                fontSize = 13.sp,
                fontWeight = if (message.kind == TimelineMessageKind.Diagnostic) FontWeight.Medium else FontWeight.Bold,
            )
            if (message.kind == TimelineMessageKind.Diagnostic && onCopyMessage != null) {
                MessageCopyButton(
                    darkMode = darkMode,
                    onClick = { onCopyMessage(diagnosticTimelineText(message)) },
                )
            }
            if (!compact && message.kind in setOf(
                    TimelineMessageKind.Marker,
                    TimelineMessageKind.Error,
                    TimelineMessageKind.System,
                )
            ) {
                CompactStatusPill(label = message.status, destructive = destructive)
            }
        }
        if (expanded && expandable) {
            SoraCodeBlock(text = message.rawContent, languageHint = "json", darkMode = darkMode)
        }
    }
}

@Composable
internal fun EmptyDetailMessage(message: String) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = message,
            color = LocalAAColors.current.muted,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
internal fun SessionWelcomeMessage() {
    val colors = LocalAAColors.current
    val titles = listOf(
        stringResource(R.string.session_welcome_1),
        stringResource(R.string.session_welcome_2),
        stringResource(R.string.session_welcome_3),
        stringResource(R.string.session_welcome_4),
        stringResource(R.string.session_welcome_5),
        stringResource(R.string.session_welcome_6),
        stringResource(R.string.session_welcome_7),
        stringResource(R.string.session_welcome_8),
        stringResource(R.string.session_welcome_9),
        stringResource(R.string.session_welcome_10),
        stringResource(R.string.session_welcome_11),
        stringResource(R.string.session_welcome_12),
        stringResource(R.string.session_welcome_13),
        stringResource(R.string.session_welcome_14),
        stringResource(R.string.session_welcome_15),
        stringResource(R.string.session_welcome_16),
    )
    var titleIndex by remember { mutableStateOf(0) }
    var typedTitle by remember { mutableStateOf("") }

    LaunchedEffect(titleIndex, titles) {
        val title = titles[titleIndex % titles.size]
        for (count in 0..title.length) {
            typedTitle = title.take(count)
            if (count < title.length) delay(SESSION_WELCOME_WRITE_MS)
        }
        delay(SESSION_WELCOME_HOLD_MS)
        for (count in title.length downTo 0) {
            typedTitle = title.take(count)
            if (count > 0) delay(SESSION_WELCOME_ERASE_MS)
        }
        titleIndex = (titleIndex + 1) % titles.size
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 30.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = typedTitle,
            color = colors.ink,
            fontSize = 32.sp,
            fontWeight = FontWeight(650),
            fontFamily = SessionWelcomeFontFamily,
            lineHeight = 34.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.width(310.dp),
        )
    }
}
