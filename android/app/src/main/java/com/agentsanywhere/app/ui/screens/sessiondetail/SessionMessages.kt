package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.MessageAuthor
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessiondetail.TimelineAttachment
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessage
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessageKind
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.valentinilk.shimmer.shimmer
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlin.math.abs

private const val SESSION_WELCOME_WRITE_MS = 58L
private const val SESSION_WELCOME_ERASE_MS = 22L
private const val SESSION_WELCOME_HOLD_MS = 15_000L
private const val LOAD_OLDER_VISIBLE_THRESHOLD = 3
private val SessionWelcomeFontFamily = FontFamily(
    Font(R.font.newsreader_opsz_wght, FontWeight(650)),
)

private sealed interface TimelineRenderItem {
    val key: String

    data class Single(val message: TimelineMessage) : TimelineRenderItem {
        override val key: String = message.id
    }

    data class ToolRun(val messages: List<TimelineMessage>) : TimelineRenderItem {
        override val key: String = "tool-run:${messages.joinToString(":") { it.id }}"
    }
}

@Composable
internal fun SessionDetailLoadingState(darkMode: Boolean) {
    val baseColor = if (darkMode) Color(0xFF1E1E22) else Color(0xFFEDEBE6)

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
    pinLatestRequest: Int,
    workingLabel: String?,
    hasMore: Boolean,
    loadingOlder: Boolean,
    onLoadOlder: () -> Unit,
    onPreviewAttachment: (TimelineAttachment) -> Unit,
) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val timelineItems = remember(messages) { groupTimelineMessages(messages) }
    var showScrollToBottom by remember { mutableStateOf(false) }

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

    LaunchedEffect(pinLatestRequest) {
        if (pinLatestRequest > 0) {
            listState.scrollToItem(0)
        }
    }

    LaunchedEffect(listState, hasMore, loadingOlder, messages.size) {
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
                    .padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                item(key = "bottom-space") { Spacer(Modifier.height(168.dp)) }
                if (workingLabel != null) {
                    item(key = "working-indicator") {
                        DisableSelection {
                            WorkingIndicator(label = workingLabel, darkMode = darkMode)
                        }
                    }
                }
                items(timelineItems.asReversed(), key = { it.key }) { item ->
                    when (item) {
                        is TimelineRenderItem.Single -> TimelineMessageRow(
                            message = item.message,
                            darkMode = darkMode,
                            listState = listState,
                            sessionId = sessionId,
                            controller = controller,
                            onPreviewAttachment = onPreviewAttachment,
                        )
                        is TimelineRenderItem.ToolRun -> ToolRunGroup(
                            messages = item.messages,
                            darkMode = darkMode,
                            listState = listState,
                        )
                    }
                }
                if (loadingOlder) {
                    item(key = "loading-older") {
                        DisableSelection {
                            OlderMessagesLoadingIndicator(darkMode = darkMode)
                        }
                    }
                }
                item(key = "top-space") { Spacer(Modifier.height(74.dp)) }
            }
        }

        if (showScrollToBottom) {
            ScrollToBottomButton(
                darkMode = darkMode,
                onClick = {
                    scope.launch { listState.animateScrollToItem(0) }
                },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .imePadding()
                    .padding(bottom = 140.dp),
            )
        }
    }
}

private fun groupTimelineMessages(messages: List<TimelineMessage>): List<TimelineRenderItem> {
    val result = mutableListOf<TimelineRenderItem>()
    val pendingTools = mutableListOf<TimelineMessage>()

    fun flushTools() {
        when (pendingTools.size) {
            0 -> Unit
            1 -> result += TimelineRenderItem.Single(pendingTools.first())
            else -> result += TimelineRenderItem.ToolRun(pendingTools.toList())
        }
        pendingTools.clear()
    }

    for (message in messages) {
        if (message.isToolRunItem()) {
            pendingTools += message
        } else {
            flushTools()
            result += TimelineRenderItem.Single(message)
        }
    }
    flushTools()
    return result
}

private fun TimelineMessage.isToolRunItem(): Boolean {
    return kind == TimelineMessageKind.Command ||
        kind == TimelineMessageKind.FileChange ||
        kind == TimelineMessageKind.ToolCall
}

@Composable
private fun OlderMessagesLoadingIndicator(darkMode: Boolean) {
    val color = if (darkMode) Color(0xFFEDEDEF) else Color(0xFF2F2F33)
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
) {
    val primary = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF2B2C29)
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76)
    val surface = if (darkMode) Color(0x1018181B) else Color(0x14F1F0ED)
    val haptic = LocalHapticFeedback.current
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
                .noRippleClickable(onClick = ::toggleExpanded)
                .padding(horizontal = 6.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ChevronRightGlyph(muted)
            PngToolIcon(
                lightRes = R.drawable.ic_tool_call_light,
                darkRes = R.drawable.ic_tool_call_dark,
                darkMode = darkMode,
                sizeDp = 16,
            )
            Text(
                text = toolRunSummary(messages),
                modifier = Modifier.weight(1f),
                color = muted,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            CompactStatusPill(label = toolRunStatus(messages), darkMode = darkMode)
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
            ChevronDownGlyph(muted)
            Text(
                text = toolRunSummary(messages),
                modifier = Modifier.weight(1f),
                color = primary,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            CompactStatusPill(label = toolRunStatus(messages), darkMode = darkMode)
        }
        messages.forEach { message ->
            ToolActivityCard(
                message = message,
                darkMode = darkMode,
                listState = listState,
                embedded = true,
            )
        }
    }
}

@Composable
private fun toolRunSummary(messages: List<TimelineMessage>): String {
    val commands = messages.count { it.kind == TimelineMessageKind.Command }
    val fileChanges = messages.count { it.kind == TimelineMessageKind.FileChange && it.title != "Added" }
    val createdFiles = messages.count { it.kind == TimelineMessageKind.FileChange && it.title == "Added" }
    val tools = messages.count { it.kind == TimelineMessageKind.ToolCall }
    val parts = buildList {
        if (commands > 0) add(stringResource(R.string.session_tool_summary_commands, commands))
        if (fileChanges > 0) add(stringResource(R.string.session_tool_summary_changed_files, fileChanges))
        if (createdFiles > 0) add(stringResource(R.string.session_tool_summary_created_files, createdFiles))
        if (tools > 0) add(stringResource(R.string.session_tool_summary_items, tools))
    }
    return parts.joinToString(", ").ifBlank {
        stringResource(R.string.session_tool_summary_items, messages.size)
    }
}

private fun toolRunStatus(messages: List<TimelineMessage>): String {
    return when {
        messages.any { it.status == "failed" } -> "Failed"
        messages.any { it.status == "running" } -> "Running"
        messages.any { it.status == "pending" } -> "Pending"
        messages.any { it.status == "waiting_approval" } -> "Approval"
        messages.any { it.status == "cancelled" } -> "Cancelled"
        messages.any { it.status == "interrupted" } -> "Stopped"
        else -> "Done"
    }
}

@Composable
private fun WorkingIndicator(label: String, darkMode: Boolean) {
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76)
    val pulse by rememberInfiniteTransition(label = "working-indicator-pulse").animateFloat(
        initialValue = 0.35f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 760),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "working-indicator-alpha",
    )
    Row(
        modifier = Modifier
            .padding(horizontal = 4.dp)
            .alpha(pulse),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PngToolIcon(
            lightRes = R.drawable.ic_reasoning_sparkles_light,
            darkRes = R.drawable.ic_reasoning_sparkles_dark,
            darkMode = darkMode,
            sizeDp = 14,
        )
        Text(
            text = label,
            color = muted,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun ScrollToBottomButton(
    darkMode: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val surface = if (darkMode) Color(0xFF2A2A2D) else Color.White
    val border = if (darkMode) Color(0xFF3F3F46) else Color(0xFFE8E8E8)
    val icon = if (darkMode) Color(0xFFEDEDEF) else Color.Black

    Box(
        modifier = modifier
            .size(48.dp)
            .shadow(10.dp, CircleShape, ambientColor = Color(0x22000000), spotColor = Color(0x2A000000))
            .clip(CircleShape)
            .background(surface)
            .border(1.dp, border, CircleShape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        ArrowDownGlyph(icon, sizeDp = 23)
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
) {
    when (message.kind) {
        TimelineMessageKind.Reasoning -> ReasoningSection(message, darkMode)
        TimelineMessageKind.Command,
        TimelineMessageKind.FileChange,
        TimelineMessageKind.ToolCall -> ToolActivityCard(message, darkMode, listState)
        TimelineMessageKind.System -> ToolPlaceholder(message, darkMode)
        TimelineMessageKind.Text -> when (message.author) {
            MessageAuthor.User -> UserBubble(message, darkMode, sessionId, controller, onPreviewAttachment)
            MessageAuthor.Agent -> AgentMarkdownText(message.text, darkMode)
            MessageAuthor.Tool -> ToolPlaceholder(message, darkMode)
        }
    }
}

@Composable
private fun UserBubble(
    message: TimelineMessage,
    darkMode: Boolean,
    sessionId: String,
    controller: SessionDetailController,
    onPreviewAttachment: (TimelineAttachment) -> Unit,
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
                )
                if (text.isNotBlank()) {
                    Box(
                        modifier = Modifier
                            .widthIn(max = maxBubbleWidth)
                            .clip(RoundedCornerShape(22.dp))
                            .background(if (darkMode) Color(0xFF2A2A2D) else Color(0xFFF1F0ED))
                            .padding(horizontal = 17.dp, vertical = 13.dp),
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                            Text(
                                text = text,
                                color = if (darkMode) Color(0xFFF4F4F5) else Color(0xFF242522),
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
                                        color = Color(0xFFEAB308),
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Bold,
                                        modifier = Modifier.noRippleClickable { expanded = !expanded },
                                    )
                                }
                            }
                        }
                    }
                }
                if (meta.isNotBlank()) {
                    DisableSelection {
                        Text(
                            text = meta,
                            color = if (message.status == "failed") Color(0xFFF87171) else if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76),
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
private fun UserAttachmentStrip(
    attachments: List<TimelineAttachment>,
    darkMode: Boolean,
    sessionId: String,
    controller: SessionDetailController,
    onPreviewAttachment: (TimelineAttachment) -> Unit,
) {
    if (attachments.isEmpty()) return
    Column(
        horizontalAlignment = Alignment.End,
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
                )
            }
        }
    }
}

@Composable
private fun UserFileAttachmentCard(
    attachment: TimelineAttachment,
    darkMode: Boolean,
) {
    val surface = if (darkMode) Color(0xFF2A2A2D) else Color(0xFFF1F0ED)
    val iconSurface = if (darkMode) Color(0xFF18181B) else Color.White.copy(alpha = 0.86f)
    val text = if (darkMode) Color(0xFFF4F4F5) else Color(0xFF242522)
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76)
    val iconRes = if (darkMode) R.drawable.ic_attachment_file_white else R.drawable.ic_attachment_file_black

    Row(
        modifier = Modifier
            .width(224.dp)
            .height(72.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(surface)
            .padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(42.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(iconSurface),
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
                color = text,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = formatBytes(attachment.size),
                color = muted,
                fontSize = 11.sp,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun ReasoningSection(message: TimelineMessage, darkMode: Boolean) {
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PngToolIcon(
                lightRes = R.drawable.ic_reasoning_sparkles_light,
                darkRes = R.drawable.ic_reasoning_sparkles_dark,
                darkMode = darkMode,
                sizeDp = 14,
            )
            Text(
                text = message.title.ifBlank { stringResource(R.string.session_reasoning) },
                color = muted,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
            )
        }
        if (message.text.isNotBlank()) {
            Text(
                text = message.text,
                color = muted,
                fontSize = 14.sp,
                lineHeight = 21.sp,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

@Composable
private fun ToolActivityCard(
    message: TimelineMessage,
    darkMode: Boolean,
    listState: LazyListState,
    embedded: Boolean = false,
) {
    val surface = if (darkMode) Color(0xFF18181B) else Color(0xFFF1F0ED)
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE4E1DB)
    val primary = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF2B2C29)
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76)
    val collapsedSurface = if (darkMode) Color(0x1018181B) else Color(0x12F1F0ED)
    val expandable = message.kind == TimelineMessageKind.Command ||
        message.kind == TimelineMessageKind.FileChange ||
        (message.kind == TimelineMessageKind.ToolCall && message.hasToolCallDetail)
    val haptic = LocalHapticFeedback.current
    var expanded by remember(message.id) { mutableStateOf(false) }
    var cardTop by remember(message.id) { mutableStateOf<Float?>(null) }
    var lockedTop by remember(message.id) { mutableStateOf<Float?>(null) }
    fun toggleExpanded() {
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        lockedTop = cardTop
        expanded = !expanded
    }
    val target = message.toolSummaryTarget()
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
                .then(if (expandable) Modifier.noRippleClickable { toggleExpanded() } else Modifier)
                .padding(horizontal = 6.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (expandable) {
                if (expanded) {
                    ChevronDownGlyph(muted)
                } else {
                    ChevronRightGlyph(muted)
                }
            } else {
                Spacer(Modifier.width(18.dp))
            }
            ToolActivityIcon(kind = message.kind, darkMode = darkMode, expanded = false, sizeDp = 16)
            if (message.kind != TimelineMessageKind.ToolCall) {
                Text(
                    text = message.title,
                    color = muted,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                )
            }
            Text(
                text = target,
                modifier = Modifier.weight(1f),
                color = primary,
                fontSize = if (message.kind == TimelineMessageKind.FileChange) 13.sp else 12.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = if (message.kind == TimelineMessageKind.FileChange) FontFamily.SansSerif else FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            CompactStatusPill(label = message.badge.ifBlank { message.status }, darkMode = darkMode)
        }
        if (expanded && expandable) {
            DisableSelection {
                ToolActivityDetailCard(
                    message = message,
                    darkMode = darkMode,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(surface)
                        .border(1.dp, border, RoundedCornerShape(14.dp)),
                )
            }
        }
    }
}

@Composable
private fun ToolActivityDetailCard(
    message: TimelineMessage,
    darkMode: Boolean,
    modifier: Modifier = Modifier,
) {
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76)

    Column(
        modifier = modifier.padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (message.kind == TimelineMessageKind.FileChange && message.detail.isNotBlank()) {
            Text(
                text = message.detail,
                color = muted,
                fontSize = 12.sp,
                lineHeight = 17.sp,
                fontWeight = FontWeight.Medium,
                fontFamily = FontFamily.Monospace,
            )
        }
        when (message.kind) {
            TimelineMessageKind.Command -> {
                CommandPreview(command = message.detail.ifBlank { message.subtitle }, output = message.body, darkMode = darkMode)
            }
            TimelineMessageKind.FileChange -> {
                DiffPreview(diff = message.body, path = message.detail.ifBlank { message.subtitle }, darkMode = darkMode)
            }
            TimelineMessageKind.ToolCall -> {
                ToolCallPreview(message = message, darkMode = darkMode)
            }
            else -> Unit
        }
    }
}

private fun TimelineMessage.toolSummaryTarget(): String {
    return if (kind == TimelineMessageKind.ToolCall) {
        title.ifBlank { text }
    } else {
        subtitle.ifBlank { text }.ifBlank { title }
    }
}

@Composable
private fun ToolCallPreview(message: TimelineMessage, darkMode: Boolean) {
    val details = listOf(
        message.subtitle,
        message.detail,
        message.body,
    ).filter { it.isNotBlank() }
    if (details.isEmpty()) return
    CommandPreviewSection(
        label = message.title.ifBlank { message.text.ifBlank { "tool" } },
        text = details.joinToString("\n"),
        languageHint = null,
        darkMode = darkMode,
    )
}

private val TimelineMessage.hasToolCallDetail: Boolean
    get() = subtitle.isNotBlank() || detail.isNotBlank() || body.isNotBlank()

@Composable
private fun CommandPreview(command: String, output: String, darkMode: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        CommandLineBar(command = command.ifBlank { stringResource(R.string.session_command_fallback) }, darkMode = darkMode)
        CommandPreviewSection(
            label = stringResource(R.string.session_output),
            text = output.ifBlank { stringResource(R.string.session_no_output) },
            languageHint = null,
            darkMode = darkMode,
        )
    }
}

@Composable
private fun CommandLineBar(command: String, darkMode: Boolean) {
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76)
    val text = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF2B2C29)
    val surface = if (darkMode) Color(0xFF111113) else Color.White.copy(alpha = 0.72f)
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE0DED8)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = stringResource(R.string.session_command),
            color = muted,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(surface)
                .border(1.dp, border, RoundedCornerShape(14.dp))
                .padding(horizontal = 10.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                text = "$",
                color = muted,
                fontSize = 13.sp,
                lineHeight = 18.sp,
                fontWeight = FontWeight.ExtraBold,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                text = command,
                color = text,
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
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = label,
            color = muted,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
        SoraCodeBlock(text = text, languageHint = languageHint, darkMode = darkMode)
    }
}

@Composable
private fun DiffPreview(diff: String, path: String, darkMode: Boolean) {
    val preview = remember(diff) { diffPreview(diff) }
    SoraCodeBlock(
        text = preview.text.ifBlank { stringResource(R.string.session_no_preview) },
        languageHint = path,
        darkMode = darkMode,
        diffHighlights = preview.highlights,
    )
}

@Composable
private fun ToolActivityIcon(
    kind: TimelineMessageKind,
    darkMode: Boolean,
    expanded: Boolean,
    sizeDp: Int = 20,
) {
    when (kind) {
        TimelineMessageKind.Command -> PngToolIcon(
            lightRes = if (expanded) R.drawable.ic_ran_expanded_light else R.drawable.ic_terminal_command_light,
            darkRes = if (expanded) R.drawable.ic_ran_expanded_dark else R.drawable.ic_terminal_command_dark,
            darkMode = darkMode,
            sizeDp = sizeDp,
        )
        TimelineMessageKind.FileChange -> PngToolIcon(
            lightRes = if (expanded) R.drawable.ic_edited_expanded_light else R.drawable.ic_edited_file_light,
            darkRes = if (expanded) R.drawable.ic_edited_expanded_dark else R.drawable.ic_edited_file_dark,
            darkMode = darkMode,
            sizeDp = sizeDp,
        )
        else -> PngToolIcon(
            lightRes = R.drawable.ic_tool_call_light,
            darkRes = R.drawable.ic_tool_call_dark,
            darkMode = darkMode,
            sizeDp = sizeDp,
        )
    }
}

@Composable
private fun PngToolIcon(
    lightRes: Int,
    darkRes: Int,
    darkMode: Boolean,
    sizeDp: Int = 20,
) {
    Image(
        painter = painterResource(if (darkMode) darkRes else lightRes),
        contentDescription = null,
        modifier = Modifier.size(sizeDp.dp),
    )
}

@Composable
private fun CompactStatusPill(label: String, darkMode: Boolean) {
    Row(
        modifier = Modifier
            .height(20.dp)
            .widthIn(min = 40.dp)
            .clip(CircleShape)
            .background(if (darkMode) Color(0xFF27272A) else Color(0xFFE4E2DD))
            .padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            color = if (darkMode) Color(0xFFD4D4D8) else Color(0xFF6F6E69),
            fontSize = 11.sp,
            lineHeight = 11.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

@Composable
private fun ToolPlaceholder(message: TimelineMessage, darkMode: Boolean) {
    Row(
        modifier = Modifier.padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SparklesGlyph(if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76))
        Text(
            text = message.text.ifBlank { message.type },
            color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76),
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
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
internal fun SessionWelcomeMessage(darkMode: Boolean) {
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
            color = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF3E403A),
            fontSize = 32.sp,
            fontWeight = FontWeight(650),
            fontFamily = SessionWelcomeFontFamily,
            lineHeight = 34.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.width(310.dp),
        )
    }
}
