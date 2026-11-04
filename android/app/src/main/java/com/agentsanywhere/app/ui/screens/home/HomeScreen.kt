package com.agentsanywhere.app.ui.screens.home

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.draw.shadow
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
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.feature.devices.DeviceAgentPreviews
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.sessions.projectHasVisibleSessions
import com.agentsanywhere.app.feature.sessions.projectSessionMatchesStatus
import com.agentsanywhere.app.feature.sessions.ProjectDeviceAgentFilter
import com.agentsanywhere.app.feature.sessions.ProjectSessionLoadKey
import com.agentsanywhere.app.feature.sessions.ProjectSessionStatusFilter
import com.agentsanywhere.app.feature.sessions.sessionListComparator
import com.agentsanywhere.app.feature.sessions.availableProjectName
import androidx.compose.runtime.LaunchedEffect
import com.agentsanywhere.app.feature.update.AppUpdateViewModel
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.runtimeTypeLabel
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.AAWordmark
import com.agentsanywhere.app.ui.designsystem.AuthErrorNotice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.common.AppEmptyState
import com.agentsanywhere.app.ui.screens.devices.DeviceActionsSheet
import com.agentsanywhere.app.ui.screens.devices.DeviceConfirmAction
import com.agentsanywhere.app.ui.screens.devices.DeviceConfirmDialog
import com.agentsanywhere.app.ui.screens.profile.ProfileSettingsDrawer
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Menu
import com.composables.icons.lucide.Mic
import com.composables.icons.lucide.Monitor
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.SlidersHorizontal
import com.composables.icons.lucide.Terminal
import com.composables.icons.lucide.UserRound
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException

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
    loadingProjectRequests: Set<ProjectSessionLoadKey>,
    projectSessionErrors: Map<ProjectSessionLoadKey, String>,
    onRefresh: () -> Unit,
    onLoadMore: (HomeTab) -> Unit,
    onTabSelected: (HomeTab) -> Unit,
    onAppearanceModeChange: (String) -> Unit,
    onLanguageModeChange: (String) -> Unit,
    onSidebarViewModeChange: (String) -> Unit,
    profileOpen: Boolean,
    onProfileOpenChange: (Boolean) -> Unit,
    onOpenArchivedSessions: () -> Unit,
    onLoadAccount: suspend () -> Result<AuthMeResponse>,
    onLoadAccountAuthConfig: suspend () -> Result<com.agentsanywhere.app.api.AuthConfigResponse>,
    onUpdateDisplayName: suspend (String) -> Result<com.agentsanywhere.app.api.AuthMeResponse>,
    onSendEmailCode: suspend (String) -> Result<com.agentsanywhere.app.api.EmailCodeResponse>,
    onBindEmail: suspend (String, String?) -> Result<com.agentsanywhere.app.api.AuthMeResponse>,
    onUpdateAvatar: suspend (String) -> Result<AuthMeResponse>,
    onClearAvatar: suspend () -> Result<AuthMeResponse>,
    onChangePassword: suspend (String) -> Result<Unit>,
    onSignOut: () -> Unit,
    onRenameSession: suspend (String, String) -> Result<AgentSession>,
    onSetSessionPinned: suspend (String, Boolean) -> Result<AgentSession>,
    onSetSessionArchived: suspend (String, Boolean) -> Result<AgentSession>,
    onLoadProjects: suspend () -> Result<List<AgentProject>>,
    onLoadProjectSessions: (String, ProjectSessionStatusFilter) -> Unit,
    onUpdateProject: suspend (String, String?, Boolean?) -> Result<AgentProject>,
    onArchiveProjectSessions: suspend (String) -> Result<List<AgentSession>>,
    onNewSessionInProject: (AgentProject) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
    deviceAgentPreviews: DeviceAgentPreviews,
    onPairDevice: () -> Unit,
    onRenameDevice: suspend (String, String) -> Result<AgentDevice> = { _, _ -> Result.failure(IllegalStateException()) },
    onDeleteDevice: suspend (String) -> Result<Unit> = { Result.failure(IllegalStateException()) },
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    var actionMenu by remember { mutableStateOf<HomeSessionActionMenu?>(null) }
    var renamingSession by remember { mutableStateOf<AgentSession?>(null) }
    var renameErrorMessage by remember { mutableStateOf<String?>(null) }
    var renameBusy by remember { mutableStateOf(false) }
    var projectActionMenu by remember { mutableStateOf<HomeProjectActionMenu?>(null) }
    var actionsDevice by remember { mutableStateOf<AgentDevice?>(null) }
    var confirmDeviceAction by remember { mutableStateOf<Pair<AgentDevice, DeviceConfirmAction>?>(null) }
    var deviceActionBusy by remember { mutableStateOf(false) }
    var deviceActionError by remember { mutableStateOf<String?>(null) }
    val projectPreferences = rememberHomeProjectPreferences(serverUrl, userId)
    val projectSessionStatus = projectPreferences.sessionStatus
    val loadingProjectIds = loadingProjectRequests.filter { it.archived in projectSessionStatus.archiveStates }.mapTo(mutableSetOf()) { it.projectId }
    val projectErrors = projectSessionErrors.filterKeys { it.archived in projectSessionStatus.archiveStates }
        .entries.associate { it.key.projectId to it.value }
    val expandedProjectIds = remember(projectPreferences.expandedIds, state.projects) {
        if (projectPreferences.expandedIds.isEmpty() && state.projects.isNotEmpty()) {
            state.projects.map { it.id }.toSet()
        } else {
            projectPreferences.expandedIds
        }
    }
    val prefetchedProjectIds = remember(serverUrl, userId, projectSessionStatus) { mutableSetOf<String>() }
    val loadedSessions = remember(projectSessionsById, state.sessions, state.archivedSessions) {
        (projectSessionsById.values.flatten() + state.sessions + state.archivedSessions).associateBy { it.id }.values.toList()
    }
    LaunchedEffect(expandedProjectIds, state.projects, loadedSessions, state.hasLoaded, sidebarViewMode, projectSessionStatus) {
        val targets = if (sidebarViewMode == HomeSidebarViewMode.Project) {
            state.projects.filter { projectHasVisibleSessions(it, loadedSessions, projectSessionStatus) }
                .sortedWith(compareByDescending<AgentProject> { it.id in expandedProjectIds }.thenByDescending { it.pinned })
                .map { it.id }
        } else emptyList()
        prefetchedProjectIds.retainAll(targets.toSet())
        if (state.hasLoaded) targets.filterNot { it in prefetchedProjectIds }.forEach { id ->
            prefetchedProjectIds.add(id)
            onLoadProjectSessions(id, projectSessionStatus)
        }
    }
    var editingProject by remember { mutableStateOf<AgentProject?>(null) }
    var projectEditBusy by remember { mutableStateOf(false) }
    var projectEditError by remember { mutableStateOf<String?>(null) }
    var projectEditName by remember { mutableStateOf("") }
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
                projectPreferences = projectPreferences,
                projectSessionStatus = projectSessionStatus,
                onProjectSessionStatusChange = projectPreferences::selectSessionStatus,
                projectErrors = projectErrors,
                onRetryProject = { onLoadProjectSessions(it, projectSessionStatus) },
                onCreateProject = {
                    if (!projectPreferences.projectsExpanded) projectPreferences.toggleSection()
                    navigate(AppDestination.NewProject)
                },
                onRefresh = onRefresh,
                onLoadMore = onLoadMore,
                onTabSelected = onTabSelected,
                onProfile = { onProfileOpenChange(true) },
                onSearch = { navigate(AppDestination.Search) },
                onSessionLongPress = { session, bounds ->
                    actionMenu = HomeSessionActionMenu(
                        session = session,
                        rowBounds = bounds,
                        projectView = sidebarViewMode == HomeSidebarViewMode.Project,
                        contextLabel = session.sidebarContextLabel(
                            projectName = state.projects.firstOrNull { it.id == session.projectId }?.name,
                            deviceName = deviceContextLabel(state.devices, session.connectorId, session.deviceName),
                        ),
                    )
                },
                onProjectMenu = { projectActionMenu = it },
                onProjectExpandedChange = { project, expanded ->
                    projectPreferences.setProjectExpanded(project.id, expanded)
                    if (expanded) onLoadProjectSessions(project.id, projectSessionStatus)
                },
                onNewSessionInProject = onNewSessionInProject,
                onOpenSession = onOpenSession,
                onOpenDevice = onOpenDevice,
                onLongPressDevice = { actionsDevice = it },
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
                        projectEditName = menu.project.name
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
                onLoadAccountAuthConfig = onLoadAccountAuthConfig,
                onUpdateDisplayName = onUpdateDisplayName,
                onSendEmailCode = onSendEmailCode,
                onBindEmail = onBindEmail,
                onUpdateAvatar = onUpdateAvatar,
                onClearAvatar = onClearAvatar,
                onChangePassword = onChangePassword,
                onOpenArchivedSessions = onOpenArchivedSessions,
                onSignOut = onSignOut,
                onClose = { onProfileOpenChange(false) },
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
            name = projectEditName,
            onNameChange = { projectEditName = it; projectEditError = null },
            busy = projectEditBusy,
            errorMessage = projectEditError,
            onDismiss = {
                if (!projectEditBusy) {
                    editingProject = null
                    projectEditError = null
                }
            },
            onSave = {
                if (!projectEditBusy) {
                    projectEditBusy = true
                    projectEditError = null
                    val name = availableProjectName(projectEditName, state.projects, project.id)
                    projectEditName = name
                    scope.launch {
                        try {
                            onUpdateProject(project.id, name, null)
                                .onSuccess {
                                    editingProject = null
                                    showToast(context.getString(R.string.home_project_updated))
                                }
                                .onFailure { error ->
                                    if (error is CancellationException) throw error
                                    if (error is ApiException && error.errorCode == "project_name_conflict") {
                                        val latest = onLoadProjects().getOrDefault(state.projects)
                                        projectEditName = availableProjectName(name, latest, project.id, setOf(name))
                                        projectEditError = context.getString(R.string.project_name_adjusted)
                                    } else {
                                        projectEditError = error.message ?: context.getString(R.string.home_project_update_failed)
                                    }
                                }
                        } finally { projectEditBusy = false }
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
                                projectPreferences.setProjectExpanded(project.id, false)
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

    actionsDevice?.let { device ->
        DeviceActionsSheet(
            device = device,
            onDismiss = { actionsDevice = null },
            onRenameDevice = onRenameDevice,
            onRevokeDevice = {
                actionsDevice = null
                deviceActionError = null
                confirmDeviceAction = device to DeviceConfirmAction.RevokeDevice(device.name)
            },
            onDeleteDevice = {
                actionsDevice = null
                deviceActionError = null
                confirmDeviceAction = device to DeviceConfirmAction.DeleteDevice
            },
        )
    }

    confirmDeviceAction?.let { (device, action) ->
        DeviceConfirmDialog(
            action = action,
            busy = deviceActionBusy,
            errorMessage = deviceActionError,
            onDismiss = {
                confirmDeviceAction = null
                deviceActionError = null
            },
            onConfirm = {
                if (deviceActionBusy) return@DeviceConfirmDialog
                deviceActionBusy = true
                deviceActionError = null
                scope.launch {
                    val result = when (action) {
                        DeviceConfirmAction.DeleteDevice -> onDeleteDevice(device.id)
                        else -> Result.success(Unit)
                    }
                    deviceActionBusy = false
                    result.onSuccess {
                        confirmDeviceAction = null
                        deviceActionError = null
                        showToast(context.getString(R.string.common_delete) + " " + device.name)
                    }.onFailure { error ->
                        deviceActionError = error.message
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
    projectPreferences: HomeProjectPreferences,
    projectSessionStatus: ProjectSessionStatusFilter,
    onProjectSessionStatusChange: (ProjectSessionStatusFilter) -> Unit,
    projectErrors: Map<String, String>,
    onRetryProject: (String) -> Unit,
    onCreateProject: () -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: (HomeTab) -> Unit,
    onTabSelected: (HomeTab) -> Unit,
    onProfile: () -> Unit,
    onSearch: () -> Unit,
    onSessionLongPress: (AgentSession, Rect) -> Unit,
    onProjectMenu: (HomeProjectActionMenu) -> Unit,
    onProjectExpandedChange: (AgentProject, Boolean) -> Unit,
    onNewSessionInProject: (AgentProject) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
    onLongPressDevice: (AgentDevice) -> Unit = onOpenDevice,
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
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        HomeHeader(onProfile = onProfile, onSearch = onSearch)
        CodexDeviceChipsRow(
            devices = state.devices,
            selectedDeviceId = projectPreferences.selectedDeviceId,
            onSelectDevice = { projectPreferences.selectDevice(it) },
            onManageDevices = { navigate(AppDestination.Devices) },
            onLongPressDevice = onLongPressDevice,
        )
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
                    projectPreferences = projectPreferences,
                    projectSessionStatus = projectSessionStatus,
                    onProjectSessionStatusChange = onProjectSessionStatusChange,
                    projectErrors = projectErrors,
                    onRetryProject = onRetryProject,
                    onCreateProject = onCreateProject,
                    onProjectExpandedChange = onProjectExpandedChange,
                    onProjectMenu = onProjectMenu,
                    onNewSessionInProject = onNewSessionInProject,
                    onSessionLongPress = onSessionLongPress,
                    onOpenSession = onOpenSession,
                    onPairDevice = onPairDevice,
                )
            } else {
                HomeList(
                    state = state,
                    tab = HomeTab.Active,
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
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 18.dp, vertical = 24.dp),
        contentAlignment = Alignment.BottomCenter,
    ) {
        CodexBottomBar(
            onClick = { navigate(AppDestination.NewSession) },
        )
    }
}

@Composable
private fun HomeProjectModeList(
    state: SessionsState,
    projectSessionsById: Map<String, List<AgentSession>>,
    loadingProjectIds: Set<String>,
    expandedProjectIds: Set<String>,
    projectPreferences: HomeProjectPreferences,
    projectSessionStatus: ProjectSessionStatusFilter,
    onProjectSessionStatusChange: (ProjectSessionStatusFilter) -> Unit,
    projectErrors: Map<String, String>,
    onRetryProject: (String) -> Unit,
    onCreateProject: () -> Unit,
    onProjectExpandedChange: (AgentProject, Boolean) -> Unit,
    onProjectMenu: (HomeProjectActionMenu) -> Unit,
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
            val allSessions = remember(projectSessionsById, state.sessions, state.archivedSessions) {
                (projectSessionsById.values.flatten() + state.sessions + state.archivedSessions)
                    .associateBy { it.id }.values.toList()
            }
            val deviceAgentFilter = ProjectDeviceAgentFilter(
                connectorId = projectPreferences.selectedDeviceId,
                runtime = projectPreferences.selectedAgentRuntime,
            )
            val visibleSessions = remember(allSessions, projectSessionStatus, deviceAgentFilter) {
                allSessions.filter {
                    it.projectId != null && projectSessionMatchesStatus(it, projectSessionStatus) && deviceAgentFilter.matches(it)
                }
                    .groupBy { it.projectId.orEmpty() }
                    .mapValues { (_, sessions) -> sessions.sortedWith(sessionListComparator()) }
            }
            val filteredProjects = remember(state.projects, deviceAgentFilter.connectorId) {
                if (deviceAgentFilter.connectorId == null) {
                    state.projects
                } else {
                    state.projects.filter { it.connectorId == deviceAgentFilter.connectorId }
                }
            }
            HomeProjectList(
                projects = filteredProjects,
                devices = state.devices,
                agentRuntimes = remember(allSessions) {
                    allSessions.map(AgentSession::runtime).filter(String::isNotBlank).distinct().sortedBy(String::runtimeTypeLabel)
                },
                deviceAgentFilter = deviceAgentFilter,
                hasProjectsInOtherStatuses = state.projects.any { projectHasVisibleSessions(it, allSessions, ProjectSessionStatusFilter.All) },
                allSessions = allSessions,
                projectPreferences = projectPreferences,
                projectSessionStatus = projectSessionStatus,
                onProjectSessionStatusChange = onProjectSessionStatusChange,
                projectErrors = projectErrors,
                onRetryProject = onRetryProject,
                onCreateProject = onCreateProject,
                pinnedSessions = allSessions.filter { it.pinned && !it.archived && deviceAgentFilter.matches(it) }
                    .sortedWith(sessionListComparator()),
                sessionsByProject = visibleSessions,
                loadingProjectIds = loadingProjectIds,
                expandedProjectIds = expandedProjectIds,
                onProjectExpandedChange = onProjectExpandedChange,
                onProjectMenu = onProjectMenu,
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
            .height(44.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        RoundLucideButton(
            icon = Lucide.Menu,
            iconColor = icon,
            surface = colors.raisedSurface,
            border = if (darkMode) colors.border else Color(0xFFE7E6E2),
            onClick = onProfile,
        )
        RoundLucideButton(
            icon = Lucide.Search,
            iconColor = icon,
            surface = Color.Transparent,
            border = Color.Transparent,
            onClick = onSearch,
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CodexDeviceChipsRow(
    devices: List<AgentDevice>,
    selectedDeviceId: String?,
    onSelectDevice: (String?) -> Unit,
    onManageDevices: () -> Unit,
    onLongPressDevice: (AgentDevice) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val haptic = LocalHapticFeedback.current

    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 全部
        val allSelected = selectedDeviceId == null
        val allBg = when {
            allSelected && darkMode -> Color(0xFF27272A)
            allSelected -> Color(0xFFE5E5EA)
            else -> Color.Transparent
        }
        val allText = when {
            allSelected && darkMode -> Color(0xFFFAFAFA)
            allSelected -> Color(0xFF1C1C1E)
            else -> colors.muted
        }
        val allBorder = when {
            allSelected -> Color.Transparent
            darkMode -> Color(0xFF27272A)
            else -> Color(0xFFE5E5EA)
        }

        Box(
            modifier = Modifier
                .height(34.dp)
                .clip(RoundedCornerShape(17.dp))
                .background(allBg)
                .border(1.dp, allBorder, RoundedCornerShape(17.dp))
                .clickable {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    onSelectDevice(null)
                }
                .padding(horizontal = 14.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(R.string.common_all),
                color = allText,
                fontSize = 13.sp,
                fontWeight = if (allSelected) FontWeight.Bold else FontWeight.Medium,
            )
        }

        // 各设备（在线优先排在前面，对标 Codex）
        val sortedDevices = remember(devices) {
            devices.sortedWith(compareByDescending<AgentDevice> { it.online }.thenBy { it.name.lowercase() })
        }
        sortedDevices.forEach { device ->
            val isSelected = selectedDeviceId == device.id
            val bg = when {
                isSelected && darkMode -> Color(0xFF27272A)
                isSelected -> Color(0xFFE5E5EA)
                else -> Color.Transparent
            }
            val text = when {
                isSelected && darkMode -> Color(0xFFFAFAFA)
                isSelected -> Color(0xFF1C1C1E)
                else -> colors.inkSoft
            }
            val border = when {
                isSelected -> Color.Transparent
                darkMode -> Color(0xFF27272A)
                else -> Color(0xFFE5E5EA)
            }
            val statusDot = if (device.online) Color(0xFF10B981) else Color(0xFFA1A1AA)

            Row(
                modifier = Modifier
                    .height(34.dp)
                    .clip(RoundedCornerShape(17.dp))
                    .background(bg)
                    .border(1.dp, border, RoundedCornerShape(17.dp))
                    .combinedClickable(
                        onClick = {
                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                            onSelectDevice(device.id)
                        },
                        onLongClick = {
                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                            onLongPressDevice(device)
                        },
                    )
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(statusDot),
                )
                Icon(
                    imageVector = Lucide.Monitor,
                    contentDescription = null,
                    tint = text,
                    modifier = Modifier.size(13.dp),
                )
                Text(
                    text = device.name,
                    color = text,
                    fontSize = 13.sp,
                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
                    maxLines = 1,
                )
            }
        }

        // 管理设备
        Box(
            modifier = Modifier
                .height(34.dp)
                .clip(RoundedCornerShape(17.dp))
                .clickable {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    onManageDevices()
                }
                .padding(horizontal = 8.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Lucide.SlidersHorizontal,
                contentDescription = stringResource(R.string.devices_title),
                tint = colors.faint,
                modifier = Modifier.size(15.dp),
            )
        }
    }
}

@Composable
private fun CodexBottomBar(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val surface = if (darkMode) Color(0xFF1C1C1E) else Color(0xFFF7F7F8)
    val border = if (darkMode) Color(0xFF2C2C2E) else Color(0xFFE5E5EA)
    val text = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF8E8E93)
    val iconTint = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF1C1C1E)

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(50.dp)
            .shadow(16.dp, RoundedCornerShape(25.dp), ambientColor = Color(0x12000000), spotColor = Color(0x12000000))
            .clip(RoundedCornerShape(25.dp))
            .background(surface)
            .border(1.dp, border, RoundedCornerShape(25.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            imageVector = Lucide.Plus,
            contentDescription = null,
            tint = iconTint,
            modifier = Modifier.size(19.dp),
        )
        Text(
            text = stringResource(R.string.home_ask_codex_placeholder),
            color = text,
            fontSize = 15.sp,
            fontWeight = FontWeight.Normal,
            modifier = Modifier.weight(1f),
        )
        Icon(
            imageVector = Lucide.Mic,
            contentDescription = null,
            tint = iconTint,
            modifier = Modifier.size(18.dp),
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
