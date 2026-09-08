package com.agentsanywhere.app.ui.screens.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.files.canonicalRemoteDirectoryPath
import com.agentsanywhere.app.feature.files.displayRemotePath
import com.agentsanywhere.app.feature.files.isSelectableRemoteDirectory
import com.agentsanywhere.app.feature.files.isWindowsDeviceOs
import com.agentsanywhere.app.feature.files.normalizeRemotePath
import com.agentsanywhere.app.feature.files.remoteFileRequest
import com.agentsanywhere.app.feature.files.remoteParentPath
import com.agentsanywhere.app.feature.devices.DeviceRuntimeList
import com.agentsanywhere.app.feature.sessions.NewSessionDirectory
import com.agentsanywhere.app.feature.sessions.NewSessionDraft
import com.agentsanywhere.app.feature.sessions.NewSessionModelCatalog
import com.agentsanywhere.app.feature.sessions.NewSessionPathEntry
import com.agentsanywhere.app.feature.sessions.NewSessionPermissionCatalog
import com.agentsanywhere.app.feature.sessions.NewSessionPreferenceStore
import com.agentsanywhere.app.feature.sessions.NewSessionRuntimeCapabilities
import com.agentsanywhere.app.feature.sessions.NewSessionRuntimeSelectionState
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.feature.sessions.availableProjectName
import com.agentsanywhere.app.feature.sessions.activeNewSessionRuntimes
import com.agentsanywhere.app.feature.sessions.workspaceProject
import com.agentsanywhere.app.feature.sessions.workspaceProjectName
import com.agentsanywhere.app.feature.sessions.workspacePathKey
import com.agentsanywhere.app.api.ApiException
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeout
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.designsystem.runtimePermissionLocalizer
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

@Composable
fun NewSessionScreen(
    navigate: (AppDestination) -> Unit,
    sessionsState: SessionsState,
    projectSessionsById: Map<String, List<AgentSession>>,
    serverUrl: String,
    userId: String,
    sidebarViewMode: String = HomeSidebarViewMode.Project,
    onLoadProjects: suspend () -> Result<List<AgentProject>> = { Result.success(sessionsState.projects) },
    onListDirectory: suspend (String, String, String) -> Result<NewSessionDirectory>,
    onListRuntimes: suspend (String) -> Result<DeviceRuntimeList>,
    onLoadRuntimeCapabilities: suspend (String, String) -> Result<NewSessionRuntimeCapabilities>,
    onLoadModelCatalog: suspend (String, String) -> Result<NewSessionModelCatalog>,
    onLoadPermissionCatalog: suspend (String, String) -> Result<NewSessionPermissionCatalog>,
    onPrepareSession: (NewSessionDraft) -> Unit,
    onRefreshDevices: () -> Unit,
    devicesRefreshing: Boolean,
    initialProjectId: String? = null,
    projectOnly: Boolean = false,
    onCreateProject: suspend (String, String, String) -> Result<AgentProject> = { _, _, _ ->
        Result.failure(IllegalStateException("Project creation is not connected."))
    },
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val context = LocalContext.current
    val preferenceStore = remember(context, serverUrl, userId) { NewSessionPreferenceStore(context, serverUrl, userId) }
    val initialPreference = remember(preferenceStore) { preferenceStore.read() }
    var preference by remember(preferenceStore) { mutableStateOf(initialPreference) }
    val defaultTitle = stringResource(if (projectOnly) R.string.new_session_create_project else R.string.new_session_title)
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val focusManager = LocalFocusManager.current
    val focusRequester = remember { FocusRequester() }
    val onlineDevices = remember(sessionsState.devices) {
        sessionsState.devices.filter { it.online }
    }
    val inventory = rememberNewSessionRuntimeInventory(
        connectorIds = if (projectOnly) emptyList() else onlineDevices.map { it.id },
        onLoad = onListRuntimes,
        loadError = stringResource(R.string.new_session_runtime_load_failed),
    )
    LaunchedEffect(Unit) {
        if (!projectOnly) onRefreshDevices()
    }
    var localProject by remember { mutableStateOf<AgentProject?>(null) }
    val projects = remember(sessionsState.projects, localProject) {
        val local = localProject
        if (local == null || sessionsState.projects.any { it.id == local.id }) {
            sessionsState.projects
        } else {
            sessionsState.projects + local
        }
    }
    val workspaceSessions = remember(projectSessionsById, sessionsState.sessions, sessionsState.archivedSessions) {
        projectSessionsById.values.flatten() + sessionsState.sessions + sessionsState.archivedSessions
    }
    var title by rememberSaveable { mutableStateOf(defaultTitle) }
    var editingTitle by rememberSaveable { mutableStateOf(false) }
    var selectedProjectId by rememberSaveable(initialProjectId) { mutableStateOf(initialProjectId) }
    var pendingInitialProjectId by rememberSaveable(initialProjectId) { mutableStateOf(initialProjectId) }
    var selectedDeviceId by rememberSaveable {
        mutableStateOf(
            sessionsState.projects.firstOrNull { it.id == initialProjectId }?.connectorId
                ?: initialPreference?.connectorId?.takeIf { id -> onlineDevices.any { it.id == id } }
                ?: onlineDevices.firstOrNull()?.id,
        )
    }
    var runtimeSelection by remember {
        mutableStateOf(
            NewSessionRuntimeSelectionState(
                connectorId = initialPreference?.connectorId,
                selectedRuntimeId = initialPreference?.runtimeId,
                selectionHints = initialPreference?.selections.orEmpty(),
            ),
        )
    }
    var selectedWorkspacePath by rememberSaveable { mutableStateOf("") }
    var homePath by rememberSaveable { mutableStateOf<String?>(null) }
    var choosePath by rememberSaveable { mutableStateOf(false) }
    var currentPath by rememberSaveable { mutableStateOf("~") }
    var pathEntries by remember { mutableStateOf<List<NewSessionPathEntry>>(emptyList()) }
    var pathLoading by remember { mutableStateOf(false) }
    var pathError by remember { mutableStateOf<String?>(null) }
    var expandedConfiguration by remember { mutableStateOf<NewSessionConfigurationKey?>(null) }
    val workspaceListState = rememberLazyListState()
    var creatingProject by rememberSaveable { mutableStateOf(projectOnly) }
    val devices = if (creatingProject) onlineDevices else onlineDevices.filter { device ->
        device.id !in inventory.errors && activeNewSessionRuntimes(inventory.results[device.id]?.runtimes.orEmpty()).isNotEmpty()
    }
    var projectName by rememberSaveable { mutableStateOf("") }
    var projectCreating by remember { mutableStateOf(false) }
    var projectCreateError by remember { mutableStateOf<String?>(null) }
    var nameEdited by rememberSaveable { mutableStateOf(false) }
    var workspaceConflict by remember { mutableStateOf<AgentProject?>(null) }
    var previousDeviceId by rememberSaveable { mutableStateOf<String?>(null) }
    var previousProjectId by rememberSaveable { mutableStateOf<String?>(null) }
    var previousPath by rememberSaveable { mutableStateOf("") }
    var previousRuntimeSelection by remember { mutableStateOf<NewSessionRuntimeSelectionState?>(null) }
    var retryDirectoryPath by rememberSaveable { mutableStateOf("~") }
    var directoryRequestId by remember { mutableStateOf(0L) }
    val selectedProject = projects.firstOrNull { it.id == selectedProjectId && (selectedDeviceId == null || it.connectorId == selectedDeviceId) }

    fun persistSelection(key: NewSessionConfigurationKey) {
        val connectorId = runtimeSelection.connectorId?.takeIf { it == selectedDeviceId } ?: return
        val runtimeId = runtimeSelection.selectedRuntime?.id ?: return
        preference = when (key) {
            NewSessionConfigurationKey.Device, NewSessionConfigurationKey.Agent ->
                preferenceStore.saveTarget(connectorId, runtimeId)
            NewSessionConfigurationKey.Model, NewSessionConfigurationKey.Effort ->
                runtimeSelection.selectedModelSelectionId?.takeIf { runtimeSelection.modelCatalog.fresh }?.let {
                    preferenceStore.saveModel(connectorId, runtimeId, it)
                }
            NewSessionConfigurationKey.Permission ->
                runtimeSelection.selectedPermissionSelectionId?.takeIf { runtimeSelection.permissionCatalog.fresh }?.let {
                    preferenceStore.savePermission(connectorId, runtimeId, it)
                }
        } ?: preference
    }

    fun selectDevice(id: String?, persist: Boolean = false) {
        if (selectedDeviceId != id) {
            selectedDeviceId = id
            selectedProjectId = null
            selectedWorkspacePath = ""
            currentPath = ""
            homePath = null
            directoryRequestId++
            pathEntries = emptyList()
            pathLoading = false
            projectCreateError = null
            choosePath = false
        }
        if (id != null) {
            val next = runtimeSelection.beginRuntimeInventory(id)
            runtimeSelection = inventory.results[id]?.let {
                next.replaceRuntimeInventory(it, preference?.runtimeId?.takeIf { preference?.connectorId == id })
            } ?: next
            if (persist) persistSelection(NewSessionConfigurationKey.Device)
        }
    }

    fun cancelProjectCreation() {
        if (projectCreating) return
        focusManager.clearFocus()
        keyboard?.hide()
        if (projectOnly) {
            navigate(AppDestination.Sessions)
            return
        }
        selectedDeviceId = previousDeviceId
        selectedProjectId = previousProjectId
        selectedWorkspacePath = previousPath
        currentPath = previousPath
        previousRuntimeSelection?.let { runtimeSelection = it }
        expandedConfiguration = null
        creatingProject = false
        projectCreateError = null
        workspaceConflict = null
    }

    BackHandler {
        when {
            choosePath -> choosePath = false
            creatingProject -> {
                cancelProjectCreation()
            }
            else -> navigate(AppDestination.Sessions)
        }
    }

    LaunchedEffect(projects, sessionsState.hasLoaded) {
        val requested = pendingInitialProjectId?.let { id -> projects.firstOrNull { it.id == id } }
        val current = projects.firstOrNull { it.id == selectedProjectId }
        val next = requested ?: current
        if (requested != null) selectedDeviceId = requested.connectorId
        if (next?.id != selectedProjectId) {
            selectedProjectId = next?.id
            if (next == null && !creatingProject) {
                selectedWorkspacePath = homePath.orEmpty()
                currentPath = selectedWorkspacePath
            }
        }
        if (requested != null || sessionsState.hasLoaded) {
            pendingInitialProjectId = null
        }
    }

    LaunchedEffect(selectedProject?.id, selectedProject?.connectorId, selectedProject?.workspacePath, creatingProject) {
        if (!creatingProject && selectedProject != null) {
            selectedDeviceId = selectedProject.connectorId
            selectedWorkspacePath = selectedProject.workspacePath
            currentPath = selectedProject.workspacePath
        }
    }

    LaunchedEffect(devices, onlineDevices, sessionsState.hasLoaded, inventory.hasLoaded, creatingProject, selectedProject?.id, preference?.connectorId) {
        val projectTarget = projects.firstOrNull { it.id == selectedProjectId }
        if (!creatingProject && projectTarget != null) {
            selectedDeviceId = projectTarget.connectorId
        } else {
            val preferred = preference?.connectorId?.takeIf { id -> devices.any { it.id == id } }
            val current = selectedDeviceId?.takeIf { id -> devices.any { it.id == id } }
            val next = (if (creatingProject) current ?: preferred else preferred ?: current)
                ?: devices.firstOrNull()?.id
                // A connected device can load its directories while Agent availability is still unknown.
                ?: selectedDeviceId?.takeIf { id -> onlineDevices.any { it.id == id } }
                ?: preference?.connectorId?.takeIf { id -> onlineDevices.any { it.id == id } }
                ?: onlineDevices.firstOrNull()?.id
            if (next != selectedDeviceId && (next != null || (sessionsState.hasLoaded && inventory.hasLoaded))) {
                selectDevice(next)
            }
        }
    }

    val selectedDevice = onlineDevices.firstOrNull { it.id == selectedDeviceId }
    val selectedDeviceOs = selectedDevice?.deviceOs
    val isWindowsDevice = isWindowsDeviceOs(selectedDeviceOs)
    val selectedRuntime = runtimeSelection.selectedRuntime
    val hasAvailableSelectedRuntime = selectedDevice != null && selectedDevice.id !in inventory.errors &&
        runtimeSelection.connectorId == selectedDevice.id &&
        !runtimeSelection.runtimesLoading && runtimeSelection.runtimesErrorMessage == null &&
        activeNewSessionRuntimes(inventory.results[selectedDevice.id]?.runtimes.orEmpty()).any { it.id == selectedRuntime?.id }
    val setupState = if (creatingProject) null else newSessionSetupState(
        sessions = sessionsState,
        inventory = inventory,
        projectConnectorId = selectedProject?.connectorId,
        selectedConnectorId = selectedDeviceId,
        hasSelectedRuntime = hasAvailableSelectedRuntime,
    )
    val checkingDevices = setupState?.reason == NewSessionSetupReason.CheckingDevices
    val checkingAgents = setupState?.reason == NewSessionSetupReason.CheckingAgents
    val setupPageState = setupState?.takeUnless { checkingDevices || checkingAgents }
    LaunchedEffect(setupPageState?.reason) {
        if (setupPageState != null) {
            editingTitle = false
            choosePath = false
            expandedConfiguration = null
            focusManager.clearFocus()
            keyboard?.hide()
        }
    }

    suspend fun loadRuntimeDetails() {
        val connectorId = runtimeSelection.connectorId ?: return
        val runtimeId = runtimeSelection.selectedRuntimeId ?: return
        runtimeSelection = runtimeSelection.beginRuntimeDetails()
        val requestKey = runtimeSelection.requestKey ?: return
        val capabilities = onLoadRuntimeCapabilities(connectorId, runtimeId).getOrElse {
            if (it is CancellationException) throw it
            runtimeSelection = runtimeSelection.failCapabilities(
                requestKey,
                context.getString(R.string.new_session_capabilities_failed),
            )
            return
        }
        runtimeSelection = runtimeSelection.applyCapabilities(requestKey, capabilities)
        if (runtimeSelection.requestKey != requestKey) return

        coroutineScope {
            val modelRequest = if (runtimeSelection.canUseModelCatalog) {
                async { onLoadModelCatalog(connectorId, runtimeId) }
            } else {
                null
            }
            val permissionRequest = if (runtimeSelection.canUsePermissionCatalog) {
                async { onLoadPermissionCatalog(connectorId, runtimeId) }
            } else {
                null
            }
            modelRequest?.await()
                ?.onSuccess { catalog ->
                    runtimeSelection = runtimeSelection.applyModelCatalog(requestKey, catalog)
                }
                ?.onFailure {
                    runtimeSelection = runtimeSelection.failModelCatalog(
                        requestKey,
                        context.getString(R.string.new_session_model_catalog_failed),
                    )
                }
            permissionRequest?.await()
                ?.onSuccess { catalog ->
                    runtimeSelection = runtimeSelection.applyPermissionCatalog(requestKey, catalog)
                }
                ?.onFailure {
                    runtimeSelection = runtimeSelection.failPermissionCatalog(
                        requestKey,
                        context.getString(R.string.new_session_permission_catalog_failed),
                    )
                }
        }
    }

    LaunchedEffect(selectedDevice?.id, inventory.results[selectedDevice?.id], inventory.errors[selectedDevice?.id], preference?.connectorId, preference?.runtimeId, creatingProject) {
        if (creatingProject) return@LaunchedEffect
        val connectorId = selectedDevice?.id
        if (connectorId == null) {
            runtimeSelection = NewSessionRuntimeSelectionState(
                generation = runtimeSelection.generation,
                selectionHints = runtimeSelection.selectionHints,
            )
        } else {
            val next = runtimeSelection.beginRuntimeInventory(connectorId)
            runtimeSelection = inventory.results[connectorId]?.let {
                next.replaceRuntimeInventory(it, preference?.runtimeId?.takeIf { preference?.connectorId == connectorId })
            } ?: next
            inventory.errors[connectorId]?.let {
                runtimeSelection = runtimeSelection.failRuntimeInventory(connectorId, it)
            }
        }
    }

    LaunchedEffect(selectedDevice?.id, runtimeSelection.connectorId, selectedRuntime?.id, selectedRuntime?.type, creatingProject, setupState?.reason) {
        if (!creatingProject && setupState == null && selectedDevice != null && selectedRuntime != null && runtimeSelection.connectorId == selectedDevice.id) {
            loadRuntimeDetails()
        }
    }

    suspend fun loadDirectory(
        targetPath: String,
        fallbackRoot: String? = selectedWorkspacePath,
        select: Boolean = false,
    ) {
        val device = selectedDevice ?: return
        val request = remoteFileRequest(
            targetPath = targetPath,
            deviceOs = device.deviceOs,
            fallbackRoot = fallbackRoot,
        )
        val requestId = ++directoryRequestId
        retryDirectoryPath = targetPath
        pathLoading = true
        pathError = null
        val result = try {
            withTimeout(8_000) { onListDirectory(device.id, request.root, request.path) }
        } catch (error: kotlinx.coroutines.TimeoutCancellationException) {
            Result.failure(IllegalStateException(context.getString(R.string.new_session_load_directory_failed), error))
        }
        result
            .onSuccess { directory ->
                if (requestId != directoryRequestId || selectedDeviceId != device.id) return@onSuccess
                val nextPath = canonicalRemoteDirectoryPath(
                    request = request,
                    returnedPath = directory.path,
                    deviceOs = device.deviceOs,
                )
                currentPath = nextPath
                pathEntries = directory.entries.map { entry ->
                    entry.copy(path = normalizeRemotePath(entry.path))
                }
                if (select && isSelectableRemoteDirectory(nextPath, device.deviceOs)) {
                    selectedWorkspacePath = nextPath
                }
            }
            .onFailure { error ->
                if (error is CancellationException) throw error
                if (requestId != directoryRequestId || selectedDeviceId != device.id) return@onFailure
                pathEntries = emptyList()
                pathError = error.message ?: context.getString(R.string.new_session_load_directory_failed)
            }
        if (requestId == directoryRequestId && selectedDeviceId == device.id) pathLoading = false
    }

    LaunchedEffect(selectedDevice?.id, creatingProject) {
        val deviceId = selectedDevice?.id
        val startPath = currentPath.ifBlank { homePath ?: "~" }
        homePath = null
        directoryRequestId++
        pathEntries = emptyList()
        pathLoading = false
        if (deviceId == null) return@LaunchedEffect
        if (creatingProject) {
            // The embedded browser's current directory is the project target.
            loadDirectory(startPath, fallbackRoot = selectedWorkspacePath, select = true)
            return@LaunchedEffect
        }
        val result = try {
            withTimeout(8_000) { onListDirectory(deviceId, "~", ".") }
        } catch (error: kotlinx.coroutines.TimeoutCancellationException) {
            Result.failure(error)
        }
        if (selectedDeviceId != deviceId) return@LaunchedEffect
        val resolved = result.getOrNull()?.path?.takeIf(String::isNotBlank) ?: "~"
        homePath = resolved
    }

    LaunchedEffect(homePath, selectedDevice?.id, hasAvailableSelectedRuntime, creatingProject, choosePath) {
        val deviceId = selectedDevice?.id ?: return@LaunchedEffect
        val resolved = homePath ?: return@LaunchedEffect
        // Do not lock onto a home-directory project before an available Agent determines the device.
        if (!creatingProject && !choosePath && hasAvailableSelectedRuntime && selectedWorkspacePath.isBlank()) {
            val project = workspaceProject(projects, deviceId, resolved, selectedDeviceOs)
            selectedProjectId = project?.id
            selectedWorkspacePath = project?.workspacePath ?: resolved
            currentPath = selectedWorkspacePath
        }
    }

    LaunchedEffect(selectedWorkspacePath, selectedDeviceId, projects, creatingProject) {
        if (!creatingProject || nameEdited) return@LaunchedEffect
        val existing = workspaceProject(projects, selectedDeviceId.orEmpty(), selectedWorkspacePath, selectedDeviceOs)
        projectName = if (selectedWorkspacePath.isBlank()) "" else availableProjectName(
            existing?.name ?: workspaceProjectName(selectedWorkspacePath), projects, existing?.id,
        )
    }

    LaunchedEffect(editingTitle) {
        if (editingTitle) {
            focusRequester.requestFocus()
            keyboard?.show()
        }
    }

    val canUseCurrentPath = isSelectableRemoteDirectory(currentPath, selectedDeviceOs)
    val effectiveWorkspacePath = if (choosePath) currentPath else selectedWorkspacePath
    val workspaceReady = if (choosePath) {
        canUseCurrentPath && !pathLoading && pathError == null
    } else {
        effectiveWorkspacePath.isNotBlank()
    }
    val catalogsLoading = selectedRuntime != null && (
        !runtimeSelection.capabilities.loaded ||
            runtimeSelection.capabilities.loading ||
            runtimeSelection.modelCatalog.loading ||
            runtimeSelection.permissionCatalog.loading
        )
    val loadingLabel = stringResource(R.string.new_session_catalog_loading)
    val unavailableLabel = stringResource(R.string.new_session_catalog_unavailable)
    val selectedModel = runtimeSelection.selectedModel
    val selectedReasoning = runtimeSelection.selectedReasoning
    val selectedPermission = runtimeSelection.selectedPermission
    val modelOptions = runtimeSelection.modelCatalog.data?.models.orEmpty()
    val reasoningOptions = selectedModel?.reasoningItems.orEmpty()
    val permissionOptions = runtimeSelection.permissionCatalog.data?.permissions.orEmpty()
    val permissionLocalizer = runtimePermissionLocalizer()
    val permissionRuntime = runtimeSelection.permissionCatalog.data?.runtime ?: selectedRuntime?.type
    val localizedPermissions = permissionOptions.associate { permission ->
        permission.id to permissionLocalizer.localize(
            runtime = permissionRuntime,
            permissionId = permission.id,
            label = permission.displayName,
            description = permission.description,
            metadata = permission.metadata,
        )
    }
    val showModelConfiguration = selectedRuntime != null && (
        catalogsLoading || runtimeSelection.canUseModelCatalog || runtimeSelection.modelCatalog.data != null
        )
    val showPermissionConfiguration = selectedRuntime != null && (
        catalogsLoading || runtimeSelection.canUsePermissionCatalog || runtimeSelection.permissionCatalog.data != null
        )
    val configurationFields = buildList {
        add(
            NewSessionConfigurationField(
                key = NewSessionConfigurationKey.Device,
                label = stringResource(R.string.new_session_device),
                value = selectedDevice?.name ?: stringResource(R.string.new_session_no_device),
                selectedId = selectedDevice?.id,
                options = devices.map { device ->
                    NewSessionConfigurationOption(id = device.id, label = device.name)
                },
                enabled = devices.isNotEmpty() && !projectCreating,
                loading = checkingDevices,
            ),
        )
        if (!projectOnly) add(
            NewSessionConfigurationField(
                key = NewSessionConfigurationKey.Agent,
                label = stringResource(R.string.new_session_agent),
                value = selectedRuntime?.labels?.primary ?: stringResource(R.string.new_session_no_agent),
                selectedId = selectedRuntime?.id,
                options = runtimeSelection.runtimes.map { runtime ->
                    NewSessionConfigurationOption(
                        id = runtime.id,
                        label = runtime.labels.primary,
                    )
                },
                enabled = !creatingProject && selectedDevice != null && runtimeSelection.runtimes.isNotEmpty(),
                loading = checkingDevices || checkingAgents || (selectedDevice != null && runtimeSelection.runtimesLoading),
            ),
        )
        if (!projectOnly && showModelConfiguration) {
            add(
                NewSessionConfigurationField(
                    key = NewSessionConfigurationKey.Model,
                    label = stringResource(R.string.new_session_model),
                    value = if (catalogsLoading) loadingLabel else selectedModel?.displayName ?: unavailableLabel,
                    selectedId = selectedModel?.id,
                    options = modelOptions.map { model ->
                        val enabled = model.enabled && (
                            model.selectionId?.isNotBlank() == true ||
                                model.reasoningItems.any { it.enabled && it.selectionId.isNotBlank() }
                            )
                        NewSessionConfigurationOption(
                            id = model.id,
                            label = model.displayName,
                            enabled = enabled,
                        )
                    },
                    enabled = !creatingProject && runtimeSelection.modelCatalog.fresh,
                    loading = catalogsLoading,
                ),
            )
            add(
                NewSessionConfigurationField(
                    key = NewSessionConfigurationKey.Effort,
                    label = stringResource(R.string.new_session_reasoning),
                    value = when {
                        catalogsLoading -> loadingLabel
                        selectedReasoning != null -> selectedReasoning.displayName
                        reasoningOptions.isEmpty() -> stringResource(R.string.session_runtime_effort_default)
                        else -> unavailableLabel
                    },
                    selectedId = selectedReasoning?.id,
                    options = reasoningOptions.map { effort ->
                        NewSessionConfigurationOption(
                            id = effort.id,
                            label = effort.displayName,
                            description = if (effort.enabled) effort.description else effort.disabledReason,
                            enabled = effort.enabled && effort.id.isNotBlank() && effort.selectionId.isNotBlank(),
                        )
                    },
                    enabled = !creatingProject && runtimeSelection.modelCatalog.fresh && reasoningOptions.isNotEmpty(),
                    loading = catalogsLoading,
                ),
            )
        }
        if (!projectOnly && showPermissionConfiguration) {
            add(
                NewSessionConfigurationField(
                    key = NewSessionConfigurationKey.Permission,
                    label = stringResource(R.string.session_runtime_permission_mode),
                    value = if (catalogsLoading) {
                        loadingLabel
                    } else {
                        selectedPermission?.let { permission ->
                            localizedPermissions[permission.id]?.label ?: permission.displayName
                        } ?: unavailableLabel
                    },
                    selectedId = selectedPermission?.id,
                    options = permissionOptions.map { permission ->
                        val localized = localizedPermissions[permission.id]
                        NewSessionConfigurationOption(
                            id = permission.id,
                            label = localized?.label ?: permission.displayName,
                            description = if (permission.enabled) {
                                localized?.description ?: permission.description
                            } else {
                                permission.disabledReason
                            },
                            enabled = permission.enabled && permission.id.isNotBlank() && permission.selectionId.isNotBlank(),
                        )
                    },
                    enabled = !creatingProject && runtimeSelection.permissionCatalog.fresh,
                    loading = catalogsLoading,
                ),
            )
        }
    }
    val canStart = setupState == null && selectedDevice != null &&
        runtimeSelection.connectorId == selectedDevice.id &&
        selectedRuntime != null &&
        runtimeSelection.readyForCreate &&
        workspaceReady &&
        !creatingProject

    fun submitTitle() {
        title = title.trim().ifBlank { defaultTitle }
        editingTitle = false
        keyboard?.hide()
    }

    fun startSession() {
        val device = selectedDevice ?: return
        val runtime = selectedRuntime ?: return
        if (!canStart) return
        val project = if (choosePath) {
            workspaceProject(projects, device.id, effectiveWorkspacePath, device.deviceOs)
        } else {
            selectedProject
        }
        preferenceStore.save(
            connectorId = device.id,
            runtimeId = runtime.id,
            selections = runtimeSelection.selections,
        )
        onPrepareSession(
            NewSessionDraft(
                connectorId = device.id,
                projectId = project?.id.orEmpty(),
                runtime = runtime.type,
                title = title.trim().takeIf(String::isNotBlank),
                cwd = effectiveWorkspacePath.trim().takeIf(String::isNotBlank),
                deviceName = device.name,
                runtimeLabel = runtime.labels.primary,
                knownSessionIds = (sessionsState.sessions + sessionsState.archivedSessions)
                    .mapTo(mutableSetOf()) { it.id },
                runtimeId = runtime.id,
                runtimeType = runtime.type,
                runtimeName = runtime.name,
                selections = runtimeSelection.selections,
                attachmentsEnabled = runtimeSelection.canUseAttachments,
            ),
        )
    }

    fun beginProjectCreation() {
        focusManager.clearFocus()
        keyboard?.hide()
        editingTitle = false
        previousDeviceId = selectedDeviceId
        previousProjectId = selectedProjectId
        previousPath = selectedWorkspacePath
        previousRuntimeSelection = runtimeSelection
        currentPath = homePath ?: "~"
        directoryRequestId++
        pathEntries = emptyList()
        pathError = null
        selectedWorkspacePath = ""
        nameEdited = false
        projectName = ""
        projectCreateError = null
        projectCreating = false
        choosePath = false
        creatingProject = true
        expandedConfiguration = null
        val preferredDeviceId = selectedDeviceId
            ?.takeIf { id -> onlineDevices.any { it.id == id } }
            ?: preference?.connectorId?.takeIf { id -> onlineDevices.any { it.id == id } }
            ?: onlineDevices.firstOrNull()?.id
        selectedDeviceId = preferredDeviceId
    }

    fun createProject(confirmRename: Boolean = false) {
        val device = selectedDevice ?: return
        val inputPath = selectedWorkspacePath.trim()
        val inputName = projectName.trim()
        val useDirectoryName = !nameEdited
        if (projectCreating || inputPath.isBlank() || inputName.isBlank()) return
        focusManager.clearFocus()
        keyboard?.hide()
        projectCreating = true
        projectCreateError = null
        scope.launch {
            var attemptedName = inputName
            var existingProjectId: String? = null
            try {
                val path = if (inputPath.startsWith("~")) {
                    onListDirectory(device.id, inputPath, ".").getOrThrow().path.also {
                        require(it.isNotBlank() && !it.startsWith("~")) {
                            context.getString(R.string.workspace_resolve_failed)
                        }
                    }
                } else inputPath
                // Refresh before checking the workspace so another client's project is not silently renamed.
                val latest = onLoadProjects().getOrThrow()
                val existing = workspaceProject(latest, device.id, path, device.deviceOs)
                existingProjectId = existing?.id
                attemptedName = availableProjectName(
                    if (useDirectoryName) existing?.name ?: workspaceProjectName(path) else inputName,
                    latest, existingProjectId,
                )
                selectedWorkspacePath = path
                projectName = attemptedName
                if (!confirmRename && existing != null && existing.name != attemptedName) {
                    workspaceConflict = existing
                    return@launch
                }
                val project = onCreateProject(attemptedName, device.id, path).getOrThrow()
                localProject = project
                selectDevice(project.connectorId, persist = true)
                selectedProjectId = project.id
                selectedDeviceId = project.connectorId
                selectedWorkspacePath = project.workspacePath
                currentPath = project.workspacePath
                expandedConfiguration = null
                if (projectOnly) navigate(AppDestination.Sessions) else creatingProject = false
                choosePath = false
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (error is ApiException && error.errorCode == "project_name_conflict") {
                    val latest = onLoadProjects().getOrDefault(projects)
                    projectName = availableProjectName(attemptedName, latest, existingProjectId, setOf(attemptedName))
                    nameEdited = true
                    projectCreateError = context.getString(R.string.project_name_adjusted)
                } else {
                    projectCreateError = error.message ?: context.getString(R.string.new_session_project_create_failed)
                }
            } finally { projectCreating = false }
        }
    }

    workspaceConflict?.let { project ->
        AlertDialog(
            onDismissRequest = { workspaceConflict = null },
            title = { Text(stringResource(R.string.project_workspace_conflict_title)) },
            text = { Text(stringResource(R.string.project_workspace_conflict_message, project.name, projectName)) },
            confirmButton = { TextButton(onClick = { workspaceConflict = null; createProject(confirmRename = true) }) { Text(stringResource(R.string.project_rename_existing)) } },
            dismissButton = { TextButton(onClick = { workspaceConflict = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }

    if (creatingProject) {
        val parent = remoteParentPath(currentPath, selectedDeviceOs, allowWindowsDriveOverview = isWindowsDevice)
        val currentPathLabel = displayRemotePath(
            root = selectedWorkspacePath,
            rawPath = currentPath,
            deviceOs = selectedDeviceOs,
            windowsDriveOverviewLabel = stringResource(R.string.files_windows_drives),
        )
        val directorySelected = selectedWorkspacePath.isNotBlank() &&
            workspacePathKey(selectedWorkspacePath, selectedDeviceOs) == workspacePathKey(currentPath, selectedDeviceOs)
        val directoryReady = selectedDevice != null && canUseCurrentPath && !pathLoading && pathError == null
        fun browseDirectory(path: String) {
            if (projectCreating) return
            focusManager.clearFocus()
            keyboard?.hide()
            selectedWorkspacePath = ""
            projectCreateError = null
            scope.launch { loadDirectory(path, fallbackRoot = currentPath, select = true) }
        }
        NewProjectScreen(
            deviceField = configurationFields.first { it.key == NewSessionConfigurationKey.Device },
            deviceMenuExpanded = expandedConfiguration == NewSessionConfigurationKey.Device,
            onToggleDevice = {
                focusManager.clearFocus()
                expandedConfiguration = if (expandedConfiguration == NewSessionConfigurationKey.Device) null else NewSessionConfigurationKey.Device
            },
            onDismissDevice = { expandedConfiguration = null },
            onSelectDevice = { selectDevice(it) },
            name = projectName,
            onNameChange = {
                nameEdited = true
                projectName = it
                projectCreateError = null
            },
            creating = projectCreating,
            canCreate = projectName.isNotBlank() && directoryReady && directorySelected && !projectCreating,
            error = projectCreateError,
            onBack = ::cancelProjectCreation,
            onCreate = { createProject() },
        ) {
            ChoosePathSection(
                title = stringResource(R.string.new_session_project_directory),
                currentPath = currentPath,
                currentPathLabel = currentPathLabel,
                parentPath = parent,
                entries = pathEntries,
                loading = pathLoading,
                error = pathError,
                darkMode = darkMode,
                canUseCurrent = directoryReady,
                collapsible = true,
                directoryBorderColor = Color(0xFFE7E6E2).takeUnless { darkMode },
                enabled = selectedDevice != null && !projectCreating,
                modifier = Modifier.weight(1f),
                onBack = null,
                onParent = { parent?.let(::browseDirectory) },
                onOpenEntry = { browseDirectory(it.path) },
                onRetry = { browseDirectory(retryDirectoryPath) },
            )
        }
        return
    }

    if (setupPageState != null) {
        ScreenScaffold {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.navigationBars)) {
                NewSessionHeader(
                    title = defaultTitle,
                    editable = false,
                    editing = false,
                    darkMode = darkMode,
                    focusRequester = focusRequester,
                    onTitleChange = {},
                    onSubmitTitle = {},
                    onClose = { navigate(AppDestination.Sessions) },
                    onEditToggle = {},
                )
                NewSessionSetupPanel(
                    state = setupPageState,
                    refreshing = devicesRefreshing || inventory.pendingInitial.isNotEmpty(),
                    onOpenDevices = { navigate(AppDestination.Devices) },
                    onRetry = {
                        onRefreshDevices()
                        inventory.refresh()
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
        return
    }

    ScreenScaffold {
        Column(
            modifier = Modifier.fillMaxSize().imePadding(),
        ) {
            NewSessionHeader(
                title = title,
                editable = !projectOnly,
                editing = editingTitle,
                darkMode = darkMode,
                focusRequester = focusRequester,
                onTitleChange = { title = it },
                onSubmitTitle = ::submitTitle,
                onClose = { navigate(AppDestination.Sessions) },
                onEditToggle = {
                    if (editingTitle) submitTitle() else editingTitle = true
                },
            )
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .padding(start = 18.dp, top = 12.dp, end = 18.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                NewSessionConfigurationCard(
                    fields = configurationFields,
                    expanded = expandedConfiguration,
                    onToggle = { key ->
                        expandedConfiguration = if (expandedConfiguration == key) null else key
                    },
                    onDismiss = { expandedConfiguration = null },
                    onSelect = { key, id ->
                        when (key) {
                            NewSessionConfigurationKey.Device -> {
                                selectDevice(id, persist = !creatingProject)
                            }
                            NewSessionConfigurationKey.Agent -> {
                                runtimeSelection = runtimeSelection.selectRuntime(id)
                            }
                            NewSessionConfigurationKey.Model -> {
                                runtimeSelection = runtimeSelection.selectModel(id)
                            }
                            NewSessionConfigurationKey.Effort -> {
                                runtimeSelection = runtimeSelection.selectReasoning(id)
                            }
                            NewSessionConfigurationKey.Permission -> {
                                runtimeSelection = runtimeSelection.selectPermission(id)
                            }
                        }
                        if (key != NewSessionConfigurationKey.Device) persistSelection(key)
                    },
                )

                if (choosePath) {
                    val parent = remoteParentPath(
                        rawPath = currentPath,
                        deviceOs = selectedDeviceOs,
                        allowWindowsDriveOverview = isWindowsDevice,
                    )
                    val currentPathLabel = displayRemotePath(
                        root = selectedWorkspacePath,
                        rawPath = currentPath,
                        deviceOs = selectedDeviceOs,
                        windowsDriveOverviewLabel = stringResource(R.string.files_windows_drives),
                    )
                    ChoosePathSection(
                        currentPath = currentPath,
                        currentPathLabel = currentPathLabel,
                        parentPath = parent,
                        entries = pathEntries,
                        loading = pathLoading,
                        error = pathError,
                        darkMode = darkMode,
                        canUseCurrent = canUseCurrentPath,
                        modifier = Modifier.weight(1f),
                        onBack = { choosePath = false },
                        onParent = {
                            if (parent != null) {
                                scope.launch {
                                    loadDirectory(
                                        targetPath = parent,
                                        fallbackRoot = currentPath.ifBlank { selectedWorkspacePath },
                                    )
                                }
                            }
                        },
                        onUseCurrent = {
                            if (canUseCurrentPath) {
                                selectedWorkspacePath = currentPath
                                projectCreateError = null
                                if (!creatingProject) selectedProjectId = workspaceProject(projects, selectedDeviceId.orEmpty(), currentPath, selectedDeviceOs)?.id
                            }
                        },
                        onOpenEntry = { entry ->
                            scope.launch {
                                loadDirectory(
                                    targetPath = entry.path,
                                    fallbackRoot = currentPath.ifBlank { selectedWorkspacePath },
                                )
                            }
                        },
                    )
                } else {
                    WorkspaceSection(
                        path = selectedWorkspacePath,
                        connectorId = selectedDeviceId,
                        deviceOs = selectedDeviceOs,
                        homePath = homePath,
                        projectMode = sidebarViewMode == HomeSidebarViewMode.Project,
                        projects = projects,
                        sessions = workspaceSessions,
                        listState = workspaceListState,
                        canCreateProject = onlineDevices.isNotEmpty(),
                        modifier = Modifier.weight(1f),
                        onCreate = ::beginProjectCreation,
                        onBrowse = {
                            val home = homePath?.takeIf(String::isNotBlank) ?: "~"
                            choosePath = true
                            scope.launch {
                                loadDirectory(
                                    targetPath = if (home == "~") "." else home,
                                    fallbackRoot = home,
                                )
                            }
                        },
                        onSelect = { choice ->
                            selectedProjectId = choice.projectId
                            selectedWorkspacePath = choice.path
                            currentPath = choice.path
                        },
                    )
                }
            }

            if (!creatingProject) Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .windowInsetsPadding(WindowInsets.navigationBars)
                        .padding(start = 18.dp, end = 18.dp, bottom = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                val runtimeError = when {
                    checkingDevices || checkingAgents || inventory.loading -> null
                    onlineDevices.isEmpty() -> stringResource(R.string.new_session_no_online_agent)
                    devices.isEmpty() -> inventory.errors.values.firstOrNull()
                        ?: stringResource(R.string.new_session_no_attached_agents)
                    runtimeSelection.runtimesErrorMessage != null -> runtimeSelection.runtimesErrorMessage
                    !runtimeSelection.runtimesLoading && runtimeSelection.runtimes.isEmpty() ->
                        stringResource(R.string.new_session_no_attached_agents)
                    selectedRuntime?.present == false -> stringResource(R.string.device_runtime_not_present)
                    selectedRuntime?.configured == false -> stringResource(R.string.device_runtime_not_configured)
                    selectedRuntime?.active == false -> stringResource(R.string.new_session_runtime_inactive)
                    selectedRuntime?.detailMessage != null -> selectedRuntime.detailMessage
                    runtimeSelection.capabilities.errorMessage != null ->
                        stringResource(R.string.new_session_capabilities_failed)
                    runtimeSelection.modelCatalog.errorMessage != null ->
                        stringResource(R.string.new_session_model_catalog_failed)
                    runtimeSelection.permissionCatalog.errorMessage != null ->
                        stringResource(R.string.new_session_permission_catalog_failed)
                    runtimeSelection.modelCatalog.stale || runtimeSelection.permissionCatalog.stale ->
                        stringResource(R.string.new_session_catalog_stale)
                    else -> null
                }
                val error = runtimeError
                error?.let {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(
                            text = it,
                            color = colors.errorText,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold,
                            lineHeight = 17.sp,
                            modifier = Modifier.weight(1f),
                        )
                        if (onlineDevices.isNotEmpty()) {
                            Text(
                                text = stringResource(R.string.common_retry),
                                color = colors.primaryAction,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.noRippleClickable {
                                    scope.launch {
                                        if (selectedDevice == null || runtimeSelection.runtimesErrorMessage != null ||
                                            runtimeSelection.runtimes.isEmpty()
                                        ) {
                                            inventory.refresh()
                                        } else if (
                                            runtimeSelection.capabilities.errorMessage != null ||
                                            runtimeSelection.modelCatalog.errorMessage != null ||
                                            runtimeSelection.permissionCatalog.errorMessage != null ||
                                            runtimeSelection.modelCatalog.stale ||
                                            runtimeSelection.permissionCatalog.stale
                                        ) {
                                            loadRuntimeDetails()
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
                StartChatButton(
                    label = stringResource(R.string.new_session_start_chat),
                    enabled = canStart,
                    onClick = ::startSession,
                )
                }
        }
    }

}
