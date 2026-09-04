package com.agentsanywhere.app.ui.screens.home

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.AuthMeResponse
import com.agentsanywhere.app.feature.devices.DeviceAgentPreviews
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.update.AppUpdateViewModel
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.AAWordmark
import com.agentsanywhere.app.ui.designsystem.AuthErrorNotice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.common.AppEmptyState
import com.agentsanywhere.app.ui.screens.profile.ProfileSettingsDrawer
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Monitor
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.Terminal
import com.composables.icons.lucide.UserRound
import kotlinx.coroutines.launch

enum class HomeTab { Active, Archived, Devices }


@Composable
fun HomeScreen(
    navigate: (AppDestination) -> Unit,
    state: SessionsState,
    selectedTab: HomeTab,
    isRefreshing: Boolean,
    userId: String,
    role: String,
    serverUrl: String,
    appearanceMode: String,
    languageMode: String,
    sidebarViewMode: String,
    appUpdateViewModel: AppUpdateViewModel,
    projectSessionsById: Map<String, List<AgentSession>>,
    loadingProjectIds: Set<String>,
    onRefresh: () -> Unit,
    onLoadMore: (HomeTab) -> Unit,
    onTabSelected: (HomeTab) -> Unit,
    onAppearanceModeChange: (String) -> Unit,
    onLanguageModeChange: (String) -> Unit,
    onSidebarViewModeChange: (String) -> Unit,
    onOpenArchivedSessions: () -> Unit,
    onLoadAccount: suspend () -> Result<AuthMeResponse>,
    onUpdateAvatar: suspend (String) -> Result<AuthMeResponse>,
    onClearAvatar: suspend () -> Result<AuthMeResponse>,
    onChangePassword: suspend (String) -> Result<Unit>,
    onSignOut: () -> Unit,
    onRenameSession: suspend (String, String) -> Result<AgentSession>,
    onSetSessionPinned: suspend (String, Boolean) -> Result<AgentSession>,
    onSetSessionArchived: suspend (String, Boolean) -> Result<AgentSession>,
    onLoadProjectSessions: (String) -> Unit,
    onUpdateProject: suspend (String, String?, Boolean?) -> Result<AgentProject>,
    onArchiveProjectSessions: suspend (String) -> Result<List<AgentSession>>,
    onNewSessionInProject: (AgentProject) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
    deviceAgentPreviews: DeviceAgentPreviews,
    onPairDevice: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    var actionMenu by remember { mutableStateOf<HomeSessionActionMenu?>(null) }
    var renamingSession by remember { mutableStateOf<AgentSession?>(null) }
    var renameErrorMessage by remember { mutableStateOf<String?>(null) }
    var renameBusy by remember { mutableStateOf(false) }
    var profileOpen by remember { mutableStateOf(false) }
    var projectActionMenu by remember { mutableStateOf<HomeProjectActionMenu?>(null) }
    var expandedProjectIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var editingProject by remember { mutableStateOf<AgentProject?>(null) }
    var projectEditBusy by remember { mutableStateOf(false) }
    var projectEditError by remember { mutableStateOf<String?>(null) }
    var projectToArchive by remember { mutableStateOf<AgentProject?>(null) }
    var projectArchiveBusy by remember { mutableStateOf(false) }

    fun showToast(message: String, isError: Boolean = false) {
        scope.launch {
            snackbarHostState.showSnackbar(
                AAToastVisuals(
                    message = message,
                    isError = isError,
                    duration = if (isError) SnackbarDuration.Long else SnackbarDuration.Short,
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
                .padding(innerPadding)
                .background(LocalAAColors.current.canvas),
        ) {
            HomeContent(
                navigate = navigate,
                state = state,
                selectedTab = selectedTab,
                sidebarViewMode = sidebarViewMode,
                isRefreshing = isRefreshing,
                projectSessionsById = projectSessionsById,
                loadingProjectIds = loadingProjectIds,
                expandedProjectIds = expandedProjectIds,
                onRefresh = onRefresh,
                onLoadMore = onLoadMore,
                onTabSelected = onTabSelected,
                onProfile = { profileOpen = true },
                onSearch = { showToast(context.getString(R.string.home_search_coming_soon)) },
                onSessionLongPress = { session, bounds -> actionMenu = HomeSessionActionMenu(session, bounds) },
                onProjectLongPress = { project, bounds -> projectActionMenu = HomeProjectActionMenu(project, bounds) },
                onProjectExpandedChange = { project, expanded ->
                    expandedProjectIds = if (expanded) {
                        expandedProjectIds + project.id
                    } else {
                        expandedProjectIds - project.id
                    }
                    if (expanded) onLoadProjectSessions(project.id)
                },
                onNewSessionInProject = onNewSessionInProject,
                onOpenSession = onOpenSession,
                onOpenDevice = onOpenDevice,
                deviceAgentPreviews = deviceAgentPreviews,
                onPairDevice = onPairDevice,
            )
            actionMenu?.let { menu ->
                HomeSessionActionOverlay(
                    menu = menu,
                    onDismiss = { actionMenu = null },
                    onRename = {
                        actionMenu = null
                        renameErrorMessage = null
                        renamingSession = menu.session
                    },
                    onTogglePinned = {
                        val session = menu.session
                        actionMenu = null
                        scope.launch {
                            onSetSessionPinned(session.id, !session.pinned)
                                .onSuccess { showToast(context.getString(if (it.pinned) R.string.home_session_pinned else R.string.home_session_unpinned)) }
                                .onFailure { showToast(it.message ?: context.getString(R.string.home_pin_update_failed), isError = true) }
                        }
                    },
                    onToggleArchived = {
                        val session = menu.session
                        actionMenu = null
                        scope.launch {
                            onSetSessionArchived(session.id, !session.archived)
                                .onSuccess {
                                    showToast(context.getString(if (it.archived) R.string.home_session_archived else R.string.home_session_restored))
                                }
                                .onFailure {
                                    showToast(
                                        it.message ?: context.getString(if (session.archived) R.string.home_restore_failed else R.string.home_archive_failed),
                                        isError = true,
                                    )
                                }
                        }
                    },
                )
            }
            projectActionMenu?.let { menu ->
                HomeProjectActionOverlay(
                    menu = menu,
                    onDismiss = { projectActionMenu = null },
                    onEdit = {
                        projectActionMenu = null
                        projectEditError = null
                        editingProject = menu.project
                    },
                    onTogglePinned = {
                        val project = menu.project
                        projectActionMenu = null
                        scope.launch {
                            onUpdateProject(project.id, null, !project.pinned)
                                .onSuccess {
                                    showToast(
                                        context.getString(
                                            if (it.pinned) R.string.home_project_pinned else R.string.home_project_unpinned,
                                        ),
                                    )
                                }
                                .onFailure {
                                    showToast(
                                        it.message ?: context.getString(R.string.home_project_update_failed),
                                        isError = true,
                                    )
                                }
                        }
                    },
                    onArchive = {
                        projectActionMenu = null
                        projectToArchive = menu.project
                    },
                )
            }
            ProfileSettingsDrawer(
                open = profileOpen,
                userId = userId,
                role = role,
                serverUrl = serverUrl,
                appearanceMode = appearanceMode,
                languageMode = languageMode,
                sidebarViewMode = sidebarViewMode,
                appUpdateViewModel = appUpdateViewModel,
                onAppearanceModeChange = onAppearanceModeChange,
                onLanguageModeChange = onLanguageModeChange,
                onSidebarViewModeChange = onSidebarViewModeChange,
                onLoadAccount = onLoadAccount,
                onUpdateAvatar = onUpdateAvatar,
                onClearAvatar = onClearAvatar,
                onChangePassword = onChangePassword,
                onOpenArchivedSessions = onOpenArchivedSessions,
                onSignOut = onSignOut,
                onClose = { profileOpen = false },
                onNotice = ::showToast,
            )
            AAToastHost(
                hostState = snackbarHostState,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 86.dp, start = 22.dp, end = 22.dp),
            )
        }
    }

    renamingSession?.let { session ->
        HomeRenameSessionDialog(
            session = session,
            errorMessage = renameErrorMessage,
            busy = renameBusy,
            onDismiss = {
                if (!renameBusy) {
                    renamingSession = null
                    renameErrorMessage = null
                }
            },
            onSave = { title ->
                if (!renameBusy) {
                    renameBusy = true
                    renameErrorMessage = null
                    scope.launch {
                        onRenameSession(session.id, title)
                            .onSuccess {
                                renamingSession = null
                                renameErrorMessage = null
                                showToast(context.getString(R.string.home_session_renamed))
                            }
                            .onFailure {
                                renameErrorMessage = it.message ?: context.getString(R.string.home_rename_failed)
                            }
                        renameBusy = false
                    }
                }
            },
        )
    }

    editingProject?.let { project ->
        HomeProjectEditSheet(
            project = project,
            deviceName = state.devices.firstOrNull { it.id == project.connectorId }?.name ?: project.connectorId,
            busy = projectEditBusy,
            errorMessage = projectEditError,
            onDismiss = {
                if (!projectEditBusy) {
                    editingProject = null
                    projectEditError = null
                }
            },
            onSave = { name ->
                if (!projectEditBusy) {
                    projectEditBusy = true
                    projectEditError = null
                    scope.launch {
                        onUpdateProject(project.id, name, null)
                            .onSuccess {
                                editingProject = null
                                showToast(context.getString(R.string.home_project_updated))
                            }
                            .onFailure {
                                projectEditError = it.message ?: context.getString(R.string.home_project_update_failed)
                            }
                        projectEditBusy = false
                    }
                }
            },
        )
    }

    projectToArchive?.let { project ->
        HomeArchiveProjectDialog(
            project = project,
            busy = projectArchiveBusy,
            onDismiss = { if (!projectArchiveBusy) projectToArchive = null },
            onConfirm = {
                if (!projectArchiveBusy) {
                    projectArchiveBusy = true
                    scope.launch {
                        onArchiveProjectSessions(project.id)
                            .onSuccess {
                                expandedProjectIds = expandedProjectIds - project.id
                                projectToArchive = null
                                showToast(context.getString(R.string.home_project_archived))
                            }
                            .onFailure {
                                showToast(
                                    it.message ?: context.getString(R.string.home_project_archive_failed),
                                    isError = true,
                                )
                            }
                        projectArchiveBusy = false
                    }
                }
            },
        )
    }
}


@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeContent(
    navigate: (AppDestination) -> Unit,
    state: SessionsState,
    selectedTab: HomeTab,
    sidebarViewMode: String,
    isRefreshing: Boolean,
    projectSessionsById: Map<String, List<AgentSession>>,
    loadingProjectIds: Set<String>,
    expandedProjectIds: Set<String>,
    onRefresh: () -> Unit,
    onLoadMore: (HomeTab) -> Unit,
    onTabSelected: (HomeTab) -> Unit,
    onProfile: () -> Unit,
    onSearch: () -> Unit,
    onSessionLongPress: (AgentSession, Rect) -> Unit,
    onProjectLongPress: (AgentProject, Rect) -> Unit,
    onProjectExpandedChange: (AgentProject, Boolean) -> Unit,
    onNewSessionInProject: (AgentProject) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
    deviceAgentPreviews: DeviceAgentPreviews,
    onPairDevice: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val refreshState = rememberPullToRefreshState()
    val indicatorContainer = if (darkMode) Color(0xFF27272A) else Color(0xFFF2F2F2)
    val indicatorColor = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF8E8E93)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(start = 18.dp, top = 6.dp, end = 18.dp),
        verticalArrangement = Arrangement.spacedBy(15.dp),
    ) {
        HomeHeader(onProfile = onProfile, onSearch = onSearch)
        QuickEntries(
            onDevicesClick = { navigate(AppDestination.Devices) },
            onTerminalClick = { navigate(AppDestination.Terminal) },
            onFilesClick = { navigate(AppDestination.Files) },
        )
        if (sidebarViewMode == HomeSidebarViewMode.Session) {
            HomeTabs(selectedTab = selectedTab, onTabSelected = onTabSelected)
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
                    containerColor = indicatorContainer,
                    color = indicatorColor,
                )
            },
        ) {
            if (sidebarViewMode == HomeSidebarViewMode.Project) {
                HomeProjectModeList(
                    state = state,
                    projectSessionsById = projectSessionsById,
                    loadingProjectIds = loadingProjectIds,
                    expandedProjectIds = expandedProjectIds,
                    onProjectExpandedChange = onProjectExpandedChange,
                    onProjectLongPress = onProjectLongPress,
                    onNewSessionInProject = onNewSessionInProject,
                    onSessionLongPress = onSessionLongPress,
                    onOpenSession = onOpenSession,
                    onPairDevice = onPairDevice,
                )
            } else {
                HomeList(
                    state = state,
                    tab = selectedTab,
                    darkMode = darkMode,
                    onSessionLongPress = onSessionLongPress,
                    onOpenSession = onOpenSession,
                    onOpenDevice = onOpenDevice,
                    deviceAgentPreviews = deviceAgentPreviews,
                    onCreateSession = { navigate(AppDestination.NewSession) },
                    onPairDevice = onPairDevice,
                    onLoadMore = onLoadMore,
                )
            }
        }
    }

    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.BottomEnd,
    ) {
        FloatingHomeButton(
            onClick = { navigate(AppDestination.NewSession) },
            modifier = Modifier.padding(end = 18.dp, bottom = 32.dp),
        )
    }
}

@Composable
private fun HomeProjectModeList(
    state: SessionsState,
    projectSessionsById: Map<String, List<AgentSession>>,
    loadingProjectIds: Set<String>,
    expandedProjectIds: Set<String>,
    onProjectExpandedChange: (AgentProject, Boolean) -> Unit,
    onProjectLongPress: (AgentProject, Rect) -> Unit,
    onNewSessionInProject: (AgentProject) -> Unit,
    onSessionLongPress: (AgentSession, Rect) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    onPairDevice: () -> Unit,
) {
    when {
        state.isLoading && !state.hasLoaded -> HomeLoadingState()
        state.errorMessage != null && !state.hasLoaded -> AuthErrorNotice(
            message = state.errorMessage,
            modifier = Modifier.padding(top = 10.dp),
        )
        state.devices.isEmpty() -> AppEmptyState(
            message = stringResource(R.string.home_pair_device_first),
            buttonLabel = stringResource(R.string.home_pair_new_device),
            buttonIcon = Lucide.Monitor,
            onButtonClick = onPairDevice,
            contentOffsetY = (-32).dp,
        )
        else -> {
            val fallbackSessions = remember(state.sessions) {
                state.sessions.filter { it.projectId != null }.groupBy { it.projectId.orEmpty() }
            }
            val visibleSessions = remember(projectSessionsById, state.sessions, state.archivedSessions) {
                val activeById = state.sessions.associateBy(AgentSession::id)
                val archivedIds = state.archivedSessions.mapTo(mutableSetOf(), AgentSession::id)
                (fallbackSessions.keys + projectSessionsById.keys).associateWith { projectId ->
                    val cached = projectSessionsById[projectId].orEmpty()
                        .mapNotNull { session ->
                            val current = activeById[session.id]
                            when {
                                current != null -> current.takeIf { it.projectId == projectId }
                                session.id !in archivedIds && !session.archived -> {
                                    session.takeIf { it.projectId == projectId }
                                }
                                else -> null
                            }
                        }
                    (cached + fallbackSessions[projectId].orEmpty())
                        .distinctBy(AgentSession::id)
                        .sortedByDescending(AgentSession::sortKey)
                }
            }
            HomeProjectList(
                projects = state.projects,
                pinnedSessions = state.sessions.filter(AgentSession::pinned),
                sessionsByProject = visibleSessions,
                loadingProjectIds = loadingProjectIds,
                expandedProjectIds = expandedProjectIds,
                onProjectExpandedChange = onProjectExpandedChange,
                onProjectLongPress = onProjectLongPress,
                onNewSession = onNewSessionInProject,
                onSessionLongPress = onSessionLongPress,
                onOpenSession = onOpenSession,
            )
        }
    }
}

@Composable
private fun HomeHeader(onProfile: () -> Unit, onSearch: () -> Unit) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val icon = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF1C1C1E)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(46.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        RoundLucideButton(
            icon = Lucide.UserRound,
            iconColor = icon,
            surface = colors.raisedSurface,
            border = if (darkMode) colors.border else Color(0xFFE7E6E2),
            onClick = onProfile,
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .height(40.dp),
            contentAlignment = Alignment.Center,
        ) {
            AAWordmark(
                color = colors.ink,
                fontSize = 31.sp,
                lineHeight = 40.sp,
            )
        }
        RoundLucideButton(
            icon = Lucide.Search,
            iconColor = icon,
            surface = Color.Transparent,
            border = Color.Transparent,
            onClick = onSearch,
        )
    }
}

@Composable
private fun QuickEntries(
    onDevicesClick: () -> Unit,
    onTerminalClick: () -> Unit,
    onFilesClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(76.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        QuickEntryCard(
            title = stringResource(R.string.devices_title),
            icon = Lucide.Monitor,
            modifier = Modifier.weight(1f),
            onClick = onDevicesClick,
        )
        QuickEntryCard(
            title = stringResource(R.string.common_terminal),
            icon = Lucide.Terminal,
            modifier = Modifier.weight(1f),
            onClick = onTerminalClick,
        )
        QuickEntryCard(
            title = stringResource(R.string.common_files),
            icon = Lucide.Folder,
            modifier = Modifier.weight(1f),
            onClick = onFilesClick,
        )
    }
}

@Composable
private fun QuickEntryCard(
    title: String,
    icon: ImageVector,
    modifier: Modifier = Modifier,
    onClick: () -> Unit = {},
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val haptic = LocalHapticFeedback.current
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.975f else 1f, label = "quick-entry-scale")
    val shape = RoundedCornerShape(18.dp)
    val surface = colors.raisedSurface
    val border = if (darkMode) Color.Transparent else Color(0xFFE7E6E2)

    Column(
        modifier = modifier
            .fillMaxSize()
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clip(shape)
            .background(surface)
            .border(1.dp, border, shape)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
            ) {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            }
            .padding(horizontal = 12.dp, vertical = 13.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (darkMode) Color(0xFF9A9A9A) else Color(0xFF8E8E8E),
            modifier = Modifier.size(22.dp),
        )
        Text(
            text = title,
            color = colors.ink,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 17.sp,
            maxLines = 1,
        )
    }
}

@Composable
private fun HomeTabs(
    selectedTab: HomeTab,
    onTabSelected: (HomeTab) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(42.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        HomeTab.entries.forEach { tab ->
            HomeTabPill(
                label = homeTabLabel(tab),
                selected = tab == selectedTab,
                onClick = { onTabSelected(tab) },
            )
        }
    }
}

@Composable
private fun HomeTabPill(label: String, selected: Boolean, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val haptic = LocalHapticFeedback.current
    val shape = CircleShape
    val background = when {
        selected && darkMode -> Color(0xFF27272A)
        selected -> Color(0xFFECECE9)
        else -> Color.Transparent
    }

    Box(
        modifier = Modifier
            .height(34.dp)
            .clip(shape)
            .background(background)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            }
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = when {
                selected -> colors.ink
                darkMode -> Color(0xFFA1A1AA)
                else -> Color(0xFF8A8A88)
            },
            fontSize = 14.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun homeTabLabel(tab: HomeTab): String = stringResource(
    when (tab) {
        HomeTab.Active -> R.string.home_tab_active
        HomeTab.Archived -> R.string.home_tab_archived
        HomeTab.Devices -> R.string.home_tab_devices
    },
)


@Composable
private fun RoundLucideButton(
    icon: ImageVector,
    iconColor: Color,
    surface: Color,
    border: Color,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(42.dp)
            .clip(CircleShape)
            .background(surface)
            .border(1.dp, border, CircleShape)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = iconColor, modifier = Modifier.size(if (icon == Lucide.Search) 24.dp else 21.dp))
    }
}

@Composable
private fun FloatingHomeButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val haptic = LocalHapticFeedback.current
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.94f else 1f, label = "home-fab-scale")

    Box(
        modifier = modifier
            .size(54.dp)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clip(CircleShape)
            .background(colors.primaryAction)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
            ) {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(Lucide.Plus, contentDescription = stringResource(R.string.home_new_session), tint = colors.onPrimaryAction, modifier = Modifier.size(24.dp))
    }
}
