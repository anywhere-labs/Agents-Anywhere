package com.agentsanywhere.app.ui.screens.home

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceAgentPreviews
import com.agentsanywhere.app.feature.sessions.SessionListIndicator
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.sessions.listIndicator
import com.agentsanywhere.app.feature.sessions.pinnedSessions
import com.agentsanywhere.app.feature.sessions.recentSessions
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.AuthErrorNotice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.common.AppEmptyState
import com.agentsanywhere.app.ui.screens.devices.DeviceRow
import com.agentsanywhere.app.ui.screens.devices.sortedForDevicesPage
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.List as ListIcon
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Monitor
import com.composables.icons.lucide.Plus
import com.valentinilk.shimmer.shimmer

@Composable
internal fun HomeList(
    state: SessionsState,
    tab: HomeTab,
    darkMode: Boolean,
    onSessionLongPress: (AgentSession, Rect) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
    deviceAgentPreviews: DeviceAgentPreviews,
    onCreateSession: () -> Unit,
    onPairDevice: () -> Unit,
    onLoadMore: (HomeTab) -> Unit,
) {
    val devices = remember(state.devices) { state.devices.sortedForDevicesPage() }
    val sessions = if (tab == HomeTab.Active) state.sessions else state.archivedSessions
    val hasAnySessions = state.sessions.isNotEmpty() || state.archivedSessions.isNotEmpty()
    when {
        state.isLoading && !state.hasLoaded -> HomeLoadingState()
        state.errorMessage != null && !state.hasLoaded -> AuthErrorNotice(
            message = state.errorMessage,
            modifier = Modifier.padding(top = 10.dp),
        )
        tab == HomeTab.Devices && devices.isEmpty() -> AppEmptyState(
            message = stringResource(R.string.home_devices_empty),
            buttonLabel = stringResource(R.string.home_pair_new_device),
            buttonIcon = Lucide.Monitor,
            onButtonClick = onPairDevice,
            contentOffsetY = (-32).dp,
        )
        tab == HomeTab.Devices -> DeviceList(
            devices = devices,
            darkMode = darkMode,
            agentPreviews = deviceAgentPreviews,
            onOpenDevice = onOpenDevice,
        )
        devices.isEmpty() -> AppEmptyState(
            message = stringResource(R.string.home_pair_device_first),
            buttonLabel = stringResource(R.string.home_pair_new_device),
            buttonIcon = Lucide.Monitor,
            onButtonClick = onPairDevice,
            contentOffsetY = (-32).dp,
        )
        sessions.isEmpty() && !hasAnySessions -> AppEmptyState(
            message = stringResource(if (tab == HomeTab.Active) R.string.home_no_active_sessions_create else R.string.home_no_archived_sessions_yet),
            buttonLabel = stringResource(R.string.home_create_new_session),
            buttonIcon = Lucide.Plus,
            onButtonClick = onCreateSession,
        )
        sessions.isEmpty() -> EmptyListText(
            stringResource(if (tab == HomeTab.Active) R.string.home_no_active_sessions else R.string.home_no_archived_sessions)
        )
        else -> SessionList(
            sessions = sessions,
            hasMore = if (tab == HomeTab.Active) state.activeHasMore else state.archivedHasMore,
            isLoadingMore = if (tab == HomeTab.Active) state.isLoadingMoreActive else state.isLoadingMoreArchived,
            onLoadMore = { onLoadMore(tab) },
            onSessionLongPress = onSessionLongPress,
            onOpenSession = onOpenSession,
        )
    }
}

@Composable
internal fun HomeLoadingState() {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val baseColor = if (darkMode) Color(0xFF1E1E22) else Color(0xFFEDEBE6)

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .shimmer()
            .padding(top = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(bottom = 96.dp),
    ) {
        item(key = "loading-label") {
            SkeletonLine(
                modifier = Modifier
                    .padding(horizontal = 24.dp)
                    .width(84.dp)
                    .height(16.dp),
                baseColor = baseColor,
                shape = CircleShape,
            )
        }
        items(6, key = { "loading-session-$it" }) { index ->
            SessionRowSkeleton(
                index = index,
                baseColor = baseColor,
                modifier = Modifier.padding(horizontal = 24.dp),
            )
        }
    }
}

@Composable
private fun SessionRowSkeleton(
    index: Int,
    baseColor: Color,
    modifier: Modifier = Modifier,
) {
    val titleWidth = listOf(0.78f, 0.62f, 0.84f, 0.70f, 0.58f, 0.76f)[index % 6]
    val summaryWidth = listOf(0.92f, 0.84f, 0.74f, 0.88f, 0.80f, 0.68f)[index % 6]
    val metaWidth = listOf(0.50f, 0.42f, 0.56f, 0.46f, 0.38f, 0.52f)[index % 6]

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(82.dp),
    ) {
        SkeletonLine(
            modifier = Modifier
                .align(Alignment.TopStart)
                .fillMaxWidth(titleWidth)
                .height(20.dp),
            baseColor = baseColor,
            shape = RoundedCornerShape(8.dp),
        )
        SkeletonLine(
            modifier = Modifier
                .align(Alignment.TopStart)
                .offset(y = 34.dp)
                .fillMaxWidth(summaryWidth)
                .height(15.dp),
            baseColor = baseColor,
            shape = RoundedCornerShape(7.dp),
        )
        SkeletonLine(
            modifier = Modifier
                .align(Alignment.TopStart)
                .offset(y = 62.dp)
                .fillMaxWidth(metaWidth)
                .height(13.dp),
            baseColor = baseColor,
            shape = RoundedCornerShape(7.dp),
        )
    }
}

@Composable
private fun SkeletonLine(
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
private fun SessionList(
    sessions: List<AgentSession>,
    hasMore: Boolean,
    isLoadingMore: Boolean,
    onLoadMore: () -> Unit,
    onSessionLongPress: (AgentSession, Rect) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
) {
    var pinnedExpanded by remember(sessions) { mutableStateOf(true) }
    var recentExpanded by remember(sessions) { mutableStateOf(true) }
    val pinned = remember(sessions) { SessionsState(sessions = sessions).pinnedSessions }
    val recent = remember(sessions) { SessionsState(sessions = sessions).recentSessions }
    val listState = rememberLazyListState()
    val shouldLoadMore by remember(listState, hasMore, isLoadingMore) {
        derivedStateOf {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
            hasMore && !isLoadingMore && lastVisible >= listState.layoutInfo.totalItemsCount - 4
        }
    }

    LaunchedEffect(shouldLoadMore) {
        if (shouldLoadMore) onLoadMore()
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 96.dp),
    ) {
        if (sessions.isEmpty()) {
            item("empty") { EmptyListText(stringResource(R.string.home_no_sessions_yet)) }
        }
        item("pinned-title") {
            HomeSectionHeader(
                label = stringResource(R.string.home_pinned),
                expanded = pinnedExpanded,
                onClick = { pinnedExpanded = !pinnedExpanded },
            )
        }
        if (pinnedExpanded) {
            if (pinned.isEmpty()) {
                item("pinned-empty") { SectionEmptyText(stringResource(R.string.home_no_pinned_sessions)) }
            } else {
                items(pinned, key = { "pinned-${it.id}" }) { session ->
                    HomePinnedSessionRow(
                        session = session,
                        showDivider = session.id != pinned.lastOrNull()?.id,
                        onClick = { onOpenSession(session) },
                        onLongPress = { bounds -> onSessionLongPress(session, bounds) },
                    )
                }
            }
        }
        item("recent-title") {
            HomeSectionHeader(
                label = stringResource(R.string.home_recents),
                expanded = recentExpanded,
                onClick = { recentExpanded = !recentExpanded },
            )
        }
        if (recentExpanded) {
            if (recent.isEmpty()) {
                item("recent-empty") { SectionEmptyText(stringResource(R.string.home_no_recent_sessions)) }
            } else {
                items(recent, key = { "recent-${it.id}" }) { session ->
                    HomeRecentSessionRow(
                        session = session,
                        onClick = { onOpenSession(session) },
                        onLongPress = { bounds -> onSessionLongPress(session, bounds) },
                    )
                }
            }
        }
        if (isLoadingMore) {
            item("loading-more") {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        color = LocalAAColors.current.muted,
                        strokeWidth = 2.dp,
                    )
                }
            }
        }
    }
}

@Composable
private fun DeviceList(
    devices: List<AgentDevice>,
    darkMode: Boolean,
    agentPreviews: DeviceAgentPreviews,
    onOpenDevice: (AgentDevice) -> Unit,
) {
    val onlineDevices = remember(devices) { devices.filter { it.online } }
    val offlineDevices = remember(devices) { devices.filterNot { it.online } }
    var onlineExpanded by remember(devices) { mutableStateOf(true) }
    var offlineExpanded by remember(devices) { mutableStateOf(true) }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = PaddingValues(bottom = 96.dp),
    ) {
        if (onlineDevices.isNotEmpty()) {
            item("online-title") {
                HomeSectionHeader(
                    label = stringResource(R.string.home_online),
                    expanded = onlineExpanded,
                    onClick = { onlineExpanded = !onlineExpanded },
                )
            }
            if (onlineExpanded) {
                items(onlineDevices, key = { "online-${it.id}" }) { device ->
                    DeviceRow(
                        device = device,
                        agentPreview = agentPreviews.byDeviceId[device.id],
                        darkMode = darkMode,
                        onClick = { onOpenDevice(device) },
                    )
                }
            }
        }
        if (offlineDevices.isNotEmpty()) {
            item("offline-title") {
                HomeSectionHeader(
                    label = stringResource(R.string.home_offline),
                    expanded = offlineExpanded,
                    onClick = { offlineExpanded = !offlineExpanded },
                )
            }
            if (offlineExpanded) {
                items(offlineDevices, key = { "offline-${it.id}" }) { device ->
                    DeviceRow(
                        device = device,
                        agentPreview = null,
                        darkMode = darkMode,
                        onClick = { onOpenDevice(device) },
                    )
                }
            }
        }
    }
}

@Composable
private fun HomeSectionHeader(
    label: String,
    expanded: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val haptic = LocalHapticFeedback.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(41.dp)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            modifier = Modifier.weight(1f),
            color = colors.faint,
            fontSize = 13.2.sp,
            fontWeight = FontWeight.ExtraBold,
            maxLines = 1,
        )
        Icon(
            imageVector = Lucide.ChevronDown,
            contentDescription = null,
            tint = colors.faint,
            modifier = Modifier
                .size(16.dp)
                .graphicsLayer { rotationZ = if (expanded) 0f else -90f },
        )
    }
}

@Composable
internal fun HomePinnedSessionRow(
    session: AgentSession,
    showDivider: Boolean,
    onClick: () -> Unit,
    onLongPress: (Rect) -> Unit,
) {
    val indicator = session.listIndicator()
    val subtitle = listOf(session.runtimeContextLabel, session.workspaceLabel)
        .filter { it.isNotBlank() }
        .joinToString("  ·  ")

    HomeSessionRowShell(
        height = 66.dp,
        showDivider = showDivider,
        onClick = onClick,
        onLongPress = onLongPress,
    ) {
        SessionRowLeading(indicator = indicator)
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = session.title.sessionDisplayTitle(),
                color = LocalAAColors.current.inkSoft,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                lineHeight = 20.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = subtitle,
                color = LocalAAColors.current.faint,
                fontSize = 11.2.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        SessionRowTrailing(session = session, indicator = indicator, timeColor = LocalAAColors.current.faint)
    }
}

@Composable
internal fun HomeRecentSessionRow(
    session: AgentSession,
    onClick: () -> Unit,
    onLongPress: (Rect) -> Unit,
) {
    val indicator = session.listIndicator()
    HomeSessionRowShell(height = 52.dp, onClick = onClick, onLongPress = onLongPress) {
        SessionRowLeading(indicator = indicator)
        Text(
            text = session.title.sessionDisplayTitle(),
            modifier = Modifier.weight(1f),
            color = LocalAAColors.current.inkSoft,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 20.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        SessionRowTrailing(session = session, indicator = indicator, timeColor = LocalAAColors.current.faint)
    }
}

@Composable
internal fun SessionRowLeading(indicator: SessionListIndicator) {
    Box(
        modifier = Modifier.size(20.dp),
        contentAlignment = Alignment.Center,
    ) {
        when (indicator) {
            SessionListIndicator.Busy,
            SessionListIndicator.Unread -> SessionStatusIndicator(indicator = indicator)

            SessionListIndicator.WaitingApproval,
            SessionListIndicator.None -> Icon(
                imageVector = Lucide.ListIcon,
                contentDescription = null,
                tint = LocalAAColors.current.faint,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

@Composable
internal fun SessionRowTrailing(
    session: AgentSession,
    indicator: SessionListIndicator,
    timeColor: Color,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (indicator == SessionListIndicator.WaitingApproval) {
            SessionStatusIndicator(indicator = indicator)
        } else {
            Text(
                text = session.updatedAtLabel.ifBlank { "now" },
                color = timeColor,
                fontSize = 10.8.sp,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
        }
    }
}

@Composable
internal fun SessionStatusIndicator(indicator: SessionListIndicator) {
    val colors = LocalAAColors.current

    when (indicator) {
        SessionListIndicator.WaitingApproval -> {
            val label = stringResource(R.string.home_session_status_waiting_approval)
            Text(
                text = label,
                modifier = Modifier
                    .clip(CircleShape)
                    .background(colors.raisedSurface)
                    .padding(horizontal = 12.dp, vertical = 5.dp),
                color = colors.inkSoft,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 18.sp,
                maxLines = 1,
            )
        }

        SessionListIndicator.Busy -> SessionBusyIndicator(
            description = stringResource(R.string.home_session_status_running),
        )

        SessionListIndicator.Unread -> SessionUnreadIndicator(
            color = colors.sessionStatusAccent,
            description = stringResource(R.string.home_session_status_unread),
        )

        SessionListIndicator.None -> Unit
    }
}

@Composable
private fun SessionBusyIndicator(description: String) {
    val colors = LocalAAColors.current
    val transition = rememberInfiniteTransition(label = "session-status")
    val rotation by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1_200, easing = LinearEasing),
        ),
        label = "session-status-rotation",
    )

    Canvas(
        modifier = Modifier
            .size(20.dp)
            .semantics { contentDescription = description }
            .graphicsLayer { rotationZ = rotation },
    ) {
        val strokeWidth = 2.2.dp.toPx()
        drawCircle(
            color = colors.ink.copy(alpha = 0.16f),
            style = Stroke(width = strokeWidth),
        )
        drawArc(
            color = colors.inkSoft.copy(alpha = 0.78f),
            startAngle = -90f,
            sweepAngle = 100f,
            useCenter = false,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )
    }
}

@Composable
private fun SessionUnreadIndicator(
    color: Color,
    description: String,
) {
    Box(
        modifier = Modifier
            .size(18.dp)
            .clip(CircleShape)
            .background(color.copy(alpha = 0.14f))
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(9.dp)
                .clip(CircleShape)
                .background(color),
        )
    }
}

@Composable
private fun HomeSessionRowShell(
    height: androidx.compose.ui.unit.Dp,
    showDivider: Boolean = true,
    onClick: () -> Unit,
    onLongPress: (Rect) -> Unit,
    content: @Composable RowScope.() -> Unit,
) {
    val colors = LocalAAColors.current
    val haptic = LocalHapticFeedback.current
    var bounds by remember { mutableStateOf(Rect.Zero) }

    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(height)
                .onGloballyPositioned { bounds = it.boundsInRoot() }
                .pointerInput(onClick, onLongPress, bounds) {
                    detectTapGestures(
                        onTap = { onClick() },
                        onLongPress = {
                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                            onLongPress(bounds)
                        },
                    )
                }
                .padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
        if (showDivider) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(if (colors.canvas == Color(0xFF09090B)) Color(0xFF27272A) else Color(0xFFE9E8E5)),
            )
        }
    }
}

@Composable
private fun EmptyListText(message: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(180.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = message,
            color = LocalAAColors.current.faint,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun SectionEmptyText(message: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(42.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            text = message,
            color = LocalAAColors.current.faint,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}
