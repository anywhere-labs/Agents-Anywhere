package com.agentsanywhere.app.ui.screens.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
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
    onListDirectory: suspend (String, String, String) -> Result<NewSessionDirectory>,
    onListRuntimes: suspend (String) -> Result<DeviceRuntimeList>,
    onLoadRuntimeCapabilities: suspend (String, String) -> Result<NewSessionRuntimeCapabilities>,
    onLoadModelCatalog: suspend (String, String) -> Result<NewSessionModelCatalog>,
    onLoadPermissionCatalog: suspend (String, String) -> Result<NewSessionPermissionCatalog>,
    onPrepareSession: (NewSessionDraft) -> Unit,
    initialProjectId: String? = null,
    onCreateProject: suspend (String, String, String) -> Result<AgentProject> = { _, _, _ ->
        Result.failure(IllegalStateException("Project creation is not connected."))
    },
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val context = LocalContext.current
    val preferenceStore = remember(context) { NewSessionPreferenceStore(context) }
    val initialPreference = remember(preferenceStore) { preferenceStore.read() }
    val defaultTitle = stringResource(R.string.new_session_title)
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val focusRequester = remember { FocusRequester() }
    val devices = remember(sessionsState.devices) {
        sessionsState.devices.filter { it.online }
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
    var title by rememberSaveable { mutableStateOf(defaultTitle) }
    var editingTitle by rememberSaveable { mutableStateOf(false) }
    var selectedProjectId by rememberSaveable(initialProjectId) { mutableStateOf(initialProjectId) }
    var pendingInitialProjectId by rememberSaveable(initialProjectId) { mutableStateOf(initialProjectId) }
    var selectedDeviceId by rememberSaveable { mutableStateOf(initialPreference?.connectorId) }
    var runtimeSelection by remember {
        mutableStateOf(
            NewSessionRuntimeSelectionState(
                connectorId = initialPreference?.connectorId,
                selectedRuntimeId = initialPreference?.runtimeId,
                selectionHints = initialPreference?.selections.orEmpty(),
            ),
        )
    }
    var selectedWorkspacePath by rememberSaveable { mutableStateOf("~") }
    var homePath by rememberSaveable { mutableStateOf<String?>(null) }
    var choosePath by rememberSaveable { mutableStateOf(false) }
    var currentPath by rememberSaveable { mutableStateOf("~") }
    var pathEntries by remember { mutableStateOf<List<NewSessionPathEntry>>(emptyList()) }
    var pathLoading by remember { mutableStateOf(false) }
    var pathError by remember { mutableStateOf<String?>(null) }
    var expandedConfiguration by remember { mutableStateOf<NewSessionConfigurationKey?>(null) }
    var projectListExpanded by rememberSaveable { mutableStateOf(true) }
    var creatingProject by rememberSaveable { mutableStateOf(false) }
    var projectName by rememberSaveable { mutableStateOf("") }
    var projectCreating by remember { mutableStateOf(false) }
    var projectCreateError by remember { mutableStateOf<String?>(null) }
    val selectedProject = projects.firstOrNull { it.id == selectedProjectId }

    BackHandler {
        when {
            choosePath -> choosePath = false
            creatingProject -> {
                creatingProject = false
                projectCreateError = null
            }
            else -> navigate(AppDestination.Sessions)
        }
    }

    LaunchedEffect(projects, sessionsState.hasLoaded) {
        val requested = pendingInitialProjectId?.let { id -> projects.firstOrNull { it.id == id } }
        val current = projects.firstOrNull { it.id == selectedProjectId }
        val next = requested ?: current ?: projects.firstOrNull()
        if (next?.id != selectedProjectId) {
            selectedProjectId = next?.id
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

    LaunchedEffect(devices, sessionsState.hasLoaded, creatingProject, selectedProject?.id) {
        if (!creatingProject && selectedProject != null) {
            selectedDeviceId = selectedProject.connectorId
        } else if (devices.isNotEmpty() && devices.none { it.id == selectedDeviceId }) {
            selectedDeviceId = devices.firstOrNull()?.id
        } else if (devices.isEmpty() && sessionsState.hasLoaded) {
            selectedDeviceId = null
        }
    }

    val selectedDevice = devices.firstOrNull { it.id == selectedDeviceId }
    val selectedDeviceOs = selectedDevice?.deviceOs
    val isWindowsDevice = isWindowsDeviceOs(selectedDeviceOs)
    val selectedRuntime = runtimeSelection.selectedRuntime

    suspend fun loadRuntimeInventory(connectorId: String) {
        runtimeSelection = runtimeSelection.beginRuntimeInventory(connectorId)
        onListRuntimes(connectorId)
            .onSuccess { result ->
                runtimeSelection = runtimeSelection.replaceRuntimeInventory(result)
            }
            .onFailure { error ->
                runtimeSelection = runtimeSelection.failRuntimeInventory(
                    connectorId,
                    error.message ?: context.getString(R.string.new_session_runtime_load_failed),
                )
            }
    }

    suspend fun loadRuntimeDetails() {
        val connectorId = runtimeSelection.connectorId ?: return
        val runtimeId = runtimeSelection.selectedRuntimeId ?: return
        runtimeSelection = runtimeSelection.beginRuntimeDetails()
        val requestKey = runtimeSelection.requestKey ?: return
        val capabilities = onLoadRuntimeCapabilities(connectorId, runtimeId).getOrElse {
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

    LaunchedEffect(selectedDevice?.id, sessionsState.hasLoaded) {
        val connectorId = selectedDevice?.id
        if (connectorId == null) {
            if (sessionsState.hasLoaded) {
                runtimeSelection = NewSessionRuntimeSelectionState()
            }
        } else {
            loadRuntimeInventory(connectorId)
        }
    }

    LaunchedEffect(selectedDevice?.id, selectedRuntime?.id) {
        if (selectedDevice != null && selectedRuntime != null) {
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
        pathLoading = true
        pathError = null
        onListDirectory(device.id, request.root, request.path)
            .onSuccess { directory ->
                val nextPath = canonicalRemoteDirectoryPath(
                    request = request,
                    returnedPath = directory.path,
                    deviceOs = device.deviceOs,
                )
                currentPath = nextPath
                pathEntries = directory.entries.map { entry ->
                    entry.copy(path = normalizeRemotePath(entry.path))
                }
                if (request.root == "~" && homePath == null && nextPath.isNotBlank()) {
                    homePath = nextPath
                }
                if (select && isSelectableRemoteDirectory(nextPath, device.deviceOs)) {
                    selectedWorkspacePath = nextPath
                }
            }
            .onFailure { error ->
                pathEntries = emptyList()
                pathError = error.message ?: context.getString(R.string.new_session_load_directory_failed)
            }
        pathLoading = false
    }

    LaunchedEffect(selectedDevice?.id, creatingProject, selectedProject?.id) {
        if (selectedDevice == null) {
            homePath = null
            pathEntries = emptyList()
            return@LaunchedEffect
        }
        if (!creatingProject && selectedProject != null) {
            homePath = null
            pathEntries = emptyList()
            currentPath = selectedProject.workspacePath
            selectedWorkspacePath = selectedProject.workspacePath
            return@LaunchedEffect
        }
        homePath = null
        currentPath = "~"
        selectedWorkspacePath = "~"
        loadDirectory(targetPath = ".", fallbackRoot = "~", select = true)
    }

    LaunchedEffect(editingTitle) {
        if (editingTitle) {
            focusRequester.requestFocus()
            keyboard?.show()
        }
    }

    val selectedProjectDevice = sessionsState.devices.firstOrNull { it.id == selectedProject?.connectorId }
    val selectedProjectTitle = selectedProject?.name ?: stringResource(R.string.new_session_choose_project)
    val selectedProjectDetail = selectedProject?.workspacePath ?: stringResource(R.string.new_session_no_project)
    val canUseCurrentPath = isSelectableRemoteDirectory(currentPath, selectedDeviceOs)
    val effectiveWorkspacePath = selectedProject?.workspacePath.orEmpty()
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
                value = if (creatingProject) {
                    selectedDevice?.name ?: stringResource(R.string.new_session_no_device)
                } else {
                    selectedProjectDevice?.name ?: stringResource(R.string.new_session_no_device)
                },
                selectedId = if (creatingProject) selectedDevice?.id else selectedProject?.connectorId,
                options = devices.map { device ->
                    NewSessionConfigurationOption(id = device.id, label = device.name)
                },
                enabled = creatingProject && devices.isNotEmpty() && !projectCreating,
            ),
        )
        if (!creatingProject) add(
            NewSessionConfigurationField(
                key = NewSessionConfigurationKey.Agent,
                label = stringResource(R.string.new_session_agent),
                value = selectedRuntime?.labels?.primary ?: stringResource(R.string.new_session_no_agent),
                selectedId = selectedRuntime?.id,
                options = runtimeSelection.runtimes.map { runtime ->
                    NewSessionConfigurationOption(
                        id = runtime.id,
                        label = runtime.labels.primary,
                        description = runtime.labels.secondary,
                    )
                },
                enabled = selectedDevice != null && runtimeSelection.runtimes.isNotEmpty(),
                loading = selectedDevice != null && runtimeSelection.runtimesLoading,
            ),
        )
        if (!creatingProject && showModelConfiguration) {
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
                    enabled = runtimeSelection.modelCatalog.fresh,
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
                    enabled = runtimeSelection.modelCatalog.fresh && reasoningOptions.isNotEmpty(),
                    loading = catalogsLoading,
                ),
            )
        }
        if (!creatingProject && showPermissionConfiguration) {
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
                    enabled = runtimeSelection.permissionCatalog.fresh,
                    loading = catalogsLoading,
                ),
            )
        }
    }
    val projectDeviceMatches = selectedProject != null &&
        selectedDevice?.id == selectedProject.connectorId
    val canStart = selectedProject != null &&
        projectDeviceMatches &&
        selectedRuntime != null &&
        runtimeSelection.readyForCreate &&
        effectiveWorkspacePath.isNotBlank() &&
        !creatingProject

    fun submitTitle() {
        title = title.trim().ifBlank { defaultTitle }
        editingTitle = false
        keyboard?.hide()
    }

    fun startSession() {
        val project = selectedProject ?: return
        val device = selectedDevice ?: return
        val runtime = selectedRuntime ?: return
        if (!canStart || device.id != project.connectorId) return
        preferenceStore.save(
            connectorId = device.id,
            runtimeId = runtime.id,
            selections = runtimeSelection.selections,
        )
        onPrepareSession(
            NewSessionDraft(
                connectorId = device.id,
                projectId = project.id,
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
        projectName = ""
        projectCreateError = null
        projectCreating = false
        choosePath = false
        creatingProject = true
        expandedConfiguration = null
        val preferredDeviceId = selectedProject?.connectorId
            ?.takeIf { id -> devices.any { it.id == id } }
            ?: initialPreference?.connectorId?.takeIf { id -> devices.any { it.id == id } }
            ?: devices.firstOrNull()?.id
        selectedDeviceId = preferredDeviceId
    }

    fun createProject() {
        val device = selectedDevice ?: return
        val cleanName = projectName.trim()
        val cleanPath = selectedWorkspacePath.trim()
        if (cleanName.isBlank() || cleanPath.isBlank() || projectCreating) return
        projectCreating = true
        projectCreateError = null
        scope.launch {
            onCreateProject(cleanName, device.id, cleanPath)
                .onSuccess { project ->
                    localProject = project
                    selectedProjectId = project.id
                    selectedDeviceId = project.connectorId
                    selectedWorkspacePath = project.workspacePath
                    currentPath = project.workspacePath
                    projectListExpanded = false
                    creatingProject = false
                    choosePath = false
                }
                .onFailure { error ->
                    projectCreateError = error.message ?: context.getString(R.string.new_session_project_create_failed)
                }
            projectCreating = false
        }
    }

    ScreenScaffold {
        Column(
            modifier = Modifier.fillMaxSize(),
        ) {
            NewSessionHeader(
                title = title,
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
                        if (key == NewSessionConfigurationKey.Agent) {
                            selectedDevice?.id?.let { connectorId ->
                                scope.launch { loadRuntimeInventory(connectorId) }
                            }
                        }
                    },
                    onDismiss = { expandedConfiguration = null },
                    onSelect = { key, id ->
                        when (key) {
                            NewSessionConfigurationKey.Device -> {
                                if (creatingProject) {
                                    selectedDeviceId = id
                                    projectCreateError = null
                                    choosePath = false
                                }
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
                                choosePath = false
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
                } else if (creatingProject) {
                    CreateProjectSection(
                        name = projectName,
                        workspacePath = selectedWorkspacePath,
                        canBrowse = selectedDevice != null && !projectCreating,
                        canCreate = projectName.isNotBlank() &&
                            selectedDevice != null &&
                            selectedWorkspacePath.isNotBlank() &&
                            !projectCreating,
                        creating = projectCreating,
                        error = projectCreateError,
                        darkMode = darkMode,
                        modifier = Modifier.weight(1f),
                        onNameChange = {
                            projectName = it
                            projectCreateError = null
                        },
                        onChooseDirectory = {
                            if (selectedDevice != null) {
                                choosePath = true
                                val startPath = if (isWindowsDevice) "" else selectedWorkspacePath
                                scope.launch {
                                    loadDirectory(
                                        targetPath = startPath,
                                        fallbackRoot = selectedWorkspacePath,
                                    )
                                }
                            }
                        },
                        onCancel = {
                            creatingProject = false
                            projectCreateError = null
                        },
                        onCreate = ::createProject,
                    )
                } else {
                    ProjectSection(
                        selectedTitle = selectedProjectTitle,
                        selectedDetail = selectedProjectDetail,
                        projects = projects,
                        selectedProjectId = selectedProjectId,
                        expanded = projectListExpanded,
                        darkMode = darkMode,
                        modifier = Modifier.weight(1f),
                        onCreateProject = ::beginProjectCreation,
                        onToggleExpanded = { projectListExpanded = !projectListExpanded },
                        onSelectProject = { project ->
                            selectedProjectId = project.id
                            selectedDeviceId = project.connectorId
                            selectedWorkspacePath = project.workspacePath
                            currentPath = project.workspacePath
                            projectListExpanded = false
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
                    devices.isEmpty() -> stringResource(R.string.new_session_no_online_agent)
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
                        if (selectedDevice != null) {
                            Text(
                                text = stringResource(R.string.common_retry),
                                color = colors.primaryAction,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.noRippleClickable {
                                    scope.launch {
                                        if (runtimeSelection.runtimesErrorMessage != null ||
                                            runtimeSelection.runtimes.isEmpty()
                                        ) {
                                            loadRuntimeInventory(selectedDevice.id)
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
