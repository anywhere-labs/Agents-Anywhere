package com.agentsanywhere.app.ui.screens.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.feature.sessions.AllWorkspaceLabel
import com.agentsanywhere.app.feature.sessions.SessionFilterPage
import com.agentsanywhere.app.feature.sessions.SessionFilterState
import com.agentsanywhere.app.feature.sessions.SessionsEmptyKind
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.sessions.emptyKind
import com.agentsanywhere.app.feature.sessions.filteredBy
import com.agentsanywhere.app.feature.sessions.pinnedSessions
import com.agentsanywhere.app.feature.sessions.recentSessions
import com.agentsanywhere.app.feature.sessions.runtimeLabel
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.CloseGlyph
import com.agentsanywhere.app.ui.designsystem.HeaderPlusButton
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import kotlinx.coroutines.launch

@Composable
fun SessionsScreen(
    navigate: (AppDestination) -> Unit,
    state: SessionsState,
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    onRenameSession: suspend (String, String) -> Result<AgentSession>,
    onSetSessionPinned: suspend (String, Boolean) -> Result<AgentSession>,
    onSetSessionArchived: suspend (String, Boolean) -> Result<AgentSession>,
    onOpenSession: (AgentSession) -> Unit,
    onFilterGestureActiveChange: (Boolean) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    var actionSession by remember { mutableStateOf<AgentSession?>(null) }
    var renamingSession by remember { mutableStateOf<AgentSession?>(null) }
    var filterSheetPage by remember { mutableStateOf<SessionFilterPage?>(null) }
    var filters by remember { mutableStateOf(SessionFilterState()) }
    val filteredState = remember(state, filters) {
        state.copy(sessions = state.sessions.filteredBy(filters))
    }

    fun showStatus(message: String) {
        scope.launch {
            snackbarHostState.showSnackbar(
                AAToastVisuals(message = message),
            )
        }
    }

    fun showError(message: String) {
        scope.launch {
            snackbarHostState.showSnackbar(
                AAToastVisuals(
                    message = message,
                    isError = true,
                    duration = SnackbarDuration.Long,
                ),
            )
        }
    }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = Color.Transparent,
        contentWindowInsets = WindowInsets(0),
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            SessionsContent(
                state = filteredState,
                allSessions = state.sessions,
                filters = filters,
                navigate = navigate,
                isRefreshing = isRefreshing,
                onRefresh = onRefresh,
                onFilterClick = { page -> filterSheetPage = page },
                onClearFilters = { filters = SessionFilterState() },
                onFilterGestureActiveChange = onFilterGestureActiveChange,
                onSessionActionsClick = { session -> actionSession = session },
                onOpenSession = onOpenSession,
            )
//            if (state.sessions.isNotEmpty()) {
//                Box(
//                    modifier = Modifier
//                        .align(Alignment.BottomEnd)
//                        .padding(end = 7.dp, bottom = 16.dp),
//                ) {
//                    FloatingPlus(
//                        onClick = { navigate(AppDestination.NewSession) },
//                    )
//                }
//            }
            AAToastHost(
                hostState = snackbarHostState,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 86.dp, start = 22.dp, end = 22.dp),
            )
        }
    }

    actionSession?.let { session ->
        SessionActionsSheet(
            session = session,
            onDismiss = { actionSession = null },
            onRename = {
                actionSession = null
                renamingSession = session
            },
            onTogglePinned = {
                actionSession = null
                scope.launch {
                    onSetSessionPinned(session.id, !session.pinned)
                        .onSuccess { updated ->
                            showStatus(if (updated.pinned) "Session pinned." else "Session unpinned.")
                        }
                        .onFailure { error ->
                            showError(error.message ?: "Could not update pin state.")
                        }
                }
            },
            onArchive = {
                actionSession = null
                scope.launch {
                    onSetSessionArchived(session.id, true)
                        .onSuccess {
                            val result = snackbarHostState.showSnackbar(
                                AAToastVisuals(
                                    message = "Session archived.",
                                    actionLabel = "Undo",
                                    duration = SnackbarDuration.Long,
                                ),
                            )
                            if (result == SnackbarResult.ActionPerformed) {
                                onSetSessionArchived(session.id, false)
                                    .onSuccess {
                                        showStatus("Session restored.")
                                    }
                                    .onFailure { error ->
                                        showError(error.message ?: "Could not restore session.")
                                    }
                            }
                        }
                        .onFailure { error ->
                            showError(error.message ?: "Could not archive session.")
                        }
                }
            },
        )
    }

    renamingSession?.let { session ->
        RenameSessionSheet(
            session = session,
            onDismiss = { renamingSession = null },
            onSave = { title ->
                scope.launch {
                    onRenameSession(session.id, title)
                        .onSuccess {
                            renamingSession = null
                            showStatus("Session renamed.")
                        }
                        .onFailure { error ->
                            showError(error.message ?: "Could not rename session.")
                        }
                }
            },
        )
    }

    filterSheetPage?.let { page ->
        FilterBottomSheet(
            initialPage = page,
            sessions = state.sessions,
            devices = state.devices,
            filters = filters,
            onFiltersChange = { filters = it },
            onDismiss = { filterSheetPage = null },
        )
    }
}


@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionsContent(
    state: SessionsState,
    allSessions: List<AgentSession>,
    filters: SessionFilterState,
    navigate: (AppDestination) -> Unit,
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    onFilterClick: (SessionFilterPage) -> Unit,
    onClearFilters: () -> Unit,
    onFilterGestureActiveChange: (Boolean) -> Unit,
    onSessionActionsClick: (AgentSession) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
) {
    var pinnedExpanded by remember(state.sessions) { mutableStateOf(true) }
    var recentExpanded by remember(state.sessions) { mutableStateOf(true) }
    val refreshState = rememberPullToRefreshState()
    val refreshIndicatorContainer = if (LocalAAColors.current.canvas == Color(0xFF09090B)) {
        Color(0xFF27272A)
    } else {
        Color(0xFFF2F2F2)
    }
    val refreshIndicatorColor = if (LocalAAColors.current.canvas == Color(0xFF09090B)) {
        Color(0xFFE4E4E7)
    } else {
        Color(0xFF8E8E93)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .fillMaxWidth()
            .padding(top = 20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SessionsHeader(
                onNewSession = { navigate(AppDestination.NewSession) },
            )
            SessionFilters(
                enabled = allSessions.isNotEmpty(),
                filters = filters,
                sessions = allSessions,
                onFilterClick = onFilterClick,
                onClearFilters = onClearFilters,
                onGestureActiveChange = onFilterGestureActiveChange,
            )
        }
        PullToRefreshBox(
            isRefreshing = isRefreshing,
            state = refreshState,
            onRefresh = onRefresh,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            indicator = {
                PullToRefreshDefaults.Indicator(
                    modifier = Modifier.align(Alignment.TopCenter),
                    isRefreshing = isRefreshing,
                    state = refreshState,
                    containerColor = refreshIndicatorContainer,
                    color = refreshIndicatorColor,
                )
            },
        ) {
            SessionRefreshContent(
                state = state,
                navigate = navigate,
                pinnedExpanded = pinnedExpanded,
                recentExpanded = recentExpanded,
                onPinnedExpandedChange = { pinnedExpanded = it },
                onRecentExpandedChange = { recentExpanded = it },
                onSessionActionsClick = onSessionActionsClick,
                onOpenSession = onOpenSession,
                filtersActive = filters.isActive,
                onClearFilters = onClearFilters,
            )
        }
    }
}

@Composable
private fun SessionRefreshContent(
    state: SessionsState,
    navigate: (AppDestination) -> Unit,
    pinnedExpanded: Boolean,
    recentExpanded: Boolean,
    onPinnedExpandedChange: (Boolean) -> Unit,
    onRecentExpandedChange: (Boolean) -> Unit,
    onSessionActionsClick: (AgentSession) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    filtersActive: Boolean,
    onClearFilters: () -> Unit,
) {
    val colors = LocalAAColors.current

    when {
        state.isLoading -> LoadingState()
        state.errorMessage != null -> PullRefreshErrorNotice(
            message = state.errorMessage,
        )
        filtersActive && state.sessions.isEmpty() -> PullRefreshFilteredEmptyState(
            onClearFilters = onClearFilters,
        )
        state.emptyKind != null -> PullRefreshEmptyState(
            kind = state.emptyKind,
            onAction = {
                when (state.emptyKind) {
                    SessionsEmptyKind.NoDevice -> navigate(AppDestination.Devices)
                    SessionsEmptyKind.NoSession -> navigate(AppDestination.NewSession)
                    null -> Unit
                }
            },
        )
        else -> LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(top = 12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            val pinned = state.pinnedSessions
            val recent = state.recentSessions
            if (pinned.isNotEmpty()) {
                item(key = "pinned-label") {
                    Box(
                        modifier = Modifier.padding(horizontal = 24.dp),
                    ) {
                        SectionLabel(
                            label = "PINNED",
                            expanded = pinnedExpanded,
                            onClick = { onPinnedExpandedChange(!pinnedExpanded) },
                        )
                    }
                }
                if (pinnedExpanded) {
                    items(pinned, key = { "pinned-${it.id}" }) { session ->
                        SessionRow(
                            session = session,
                            onClick = { onOpenSession(session) },
                            onMoreClick = { onSessionActionsClick(session) },
                        )
                    }
                }
            }
            if (recent.isNotEmpty()) {
                item(key = "recent-label") {
                    Box(
                        modifier = Modifier.padding(horizontal = 24.dp),
                    ) {
                        SectionLabel(
                            label = "RECENTS",
                            expanded = recentExpanded,
                            onClick = { onRecentExpandedChange(!recentExpanded) },
                        )
                    }
                }
                if (recentExpanded) {
                    items(recent, key = { "recent-${it.id}" }) { session ->
                        SessionRow(
                            session = session,
                            onClick = { onOpenSession(session) },
                            onMoreClick = { onSessionActionsClick(session) },
                        )
                    }
                }
            }
            item(key = "bottom-space") {
                Spacer(
                    Modifier
                        .fillMaxWidth()
                        .height(18.dp)
                        .background(colors.canvas),
                    )
            }
        }
    }
}

@Composable
private fun SessionsHeader(
    onNewSession: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val titleColor = if (darkMode) Color(0xFFF4F4F5) else Color(0xFF151517)

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(58.dp),
    ) {
        Text(
            text = "Sessions",
            modifier = Modifier.align(Alignment.CenterStart),
            color = titleColor,
            fontSize = 30.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.sp,
            lineHeight = 34.sp,
        )
        HeaderPlusButton(
            onClick = onNewSession,
            contentDescription = "New session",
            modifier = Modifier.align(Alignment.CenterEnd),
        )
    }
}

@Composable
private fun SessionFilters(
    enabled: Boolean,
    filters: SessionFilterState,
    sessions: List<AgentSession>,
    onFilterClick: (SessionFilterPage) -> Unit,
    onClearFilters: () -> Unit,
    onGestureActiveChange: (Boolean) -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val haptic = LocalHapticFeedback.current
    val hasActiveFilters = filters != SessionFilterState()
    val agentLabel = filters.agentRuntime?.let { runtime ->
        sessions.firstOrNull { it.runtime == runtime }?.runtimeLabel ?: runtime.runtimeLabel()
    } ?: "All agents"
    val deviceLabel = filters.deviceId?.let { deviceId ->
        sessions.firstOrNull { it.connectorId == deviceId }?.deviceName ?: deviceId.take(8)
    } ?: "All devices"
    val workspaceLabel = filters.workspace?.takeIf { it != AllWorkspaceLabel } ?: "All workspaces"

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(36.dp)
            .pagerSwipeGuard(onGestureActiveChange)
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (hasActiveFilters) {
            ClearFiltersButton(
                enabled = enabled,
                darkMode = darkMode,
                onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    onClearFilters()
                },
            )
        }
        SessionFilterPill(
            label = agentLabel,
            enabled = enabled,
            active = filters.agentRuntime != null,
            onClick = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onFilterClick(SessionFilterPage.Agent)
            },
        )
        SessionFilterPill(
            label = deviceLabel,
            enabled = enabled,
            active = filters.deviceId != null,
            onClick = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onFilterClick(SessionFilterPage.Device)
            },
        )
        SessionFilterPill(
            label = workspaceLabel,
            enabled = enabled,
            active = filters.workspace != null,
            onClick = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onFilterClick(SessionFilterPage.Workspace)
            },
        )
    }
}

private fun Modifier.pagerSwipeGuard(
    onGestureActiveChange: (Boolean) -> Unit,
): Modifier = pointerInput(onGestureActiveChange) {
    awaitPointerEventScope {
        while (true) {
            awaitPointerEvent(PointerEventPass.Initial)
                .changes
                .firstOrNull { it.pressed }
                ?: continue
            onGestureActiveChange(true)

            var pointerStillDown = true
            while (pointerStillDown) {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                pointerStillDown = event.changes.any { it.pressed }
            }

            onGestureActiveChange(false)
        }
    }
}

@Composable
private fun ClearFiltersButton(
    enabled: Boolean,
    darkMode: Boolean,
    onClick: () -> Unit,
) {
    val alpha = if (enabled) 1f else 0.72f
    val background = if (darkMode) Color(0xFF18181B) else Color(0xFFF5F5F5)
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE5E5E5)
    val iconColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF8A8A8A)

    Box(
        modifier = Modifier
            .size(36.dp)
            .shadow(4.dp, CircleShape, ambientColor = Color(0x0D000000), spotColor = Color(0x0D000000))
            .clip(CircleShape)
            .background(background.copy(alpha = alpha))
            .border(1.dp, border.copy(alpha = alpha), CircleShape)
            .noRippleClickable {
                if (enabled) onClick()
            },
        contentAlignment = Alignment.Center,
    ) {
        CloseGlyph(
            color = iconColor.copy(alpha = alpha),
            sizeDp = 16,
        )
    }
}

@Composable
private fun SessionFilterPill(
    label: String,
    enabled: Boolean,
    active: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val alpha = if (enabled) 1f else 0.72f
    val background = when {
        active && darkMode -> Color(0xFF18181B)
        active -> Color(0xFFF7F7F7)
        else -> colors.raisedSurface
    }
    val foreground = when {
        active && darkMode -> Color(0xFFFAFAFA)
        active -> Color(0xFF1C1C1E)
        else -> colors.muted
    }
    val border = when {
        active && darkMode -> Color(0xFF3F3F46)
        active -> Color(0xFFDADADA)
        else -> colors.border
    }
    val chevronColor = when {
        active && darkMode -> Color(0xFF71717A)
        active -> Color(0xFF9A9A9A)
        else -> if (darkMode) Color(0xFF71717A) else Color(0xFFB0B0B0)
    }

    Row(
        modifier = Modifier
            .height(36.dp)
            .widthIn(min = 96.dp)
            .shadow(4.dp, CircleShape, ambientColor = Color(0x0D000000), spotColor = Color(0x0D000000))
            .clip(CircleShape)
            .background(background.copy(alpha = alpha))
            .border(if (active) 1.5.dp else 1.dp, border.copy(alpha = alpha), CircleShape)
            .noRippleClickable {
                if (enabled) onClick()
            }
            .padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            color = foreground.copy(alpha = alpha),
            fontSize = 13.5.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
        Spacer(Modifier.width(6.dp))
        Box(
            modifier = Modifier.width(8.dp),
            contentAlignment = Alignment.Center,
        ) {
            ChevronDown(
                color = chevronColor.copy(alpha = alpha),
                modifier = Modifier.size(width = 8.dp, height = 6.dp),
                strokeWidthDp = 1.5f,
            )
        }
    }
}
