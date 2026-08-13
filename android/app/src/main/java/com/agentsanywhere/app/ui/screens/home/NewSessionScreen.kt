package com.agentsanywhere.app.ui.screens.home

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
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
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeList
import com.agentsanywhere.app.feature.devices.DeviceRuntimeStatus
import com.agentsanywhere.app.feature.sessions.NewSessionDirectory
import com.agentsanywhere.app.feature.sessions.NewSessionAttachmentPart
import com.agentsanywhere.app.feature.sessions.NewSessionCreateDraft
import com.agentsanywhere.app.feature.sessions.NewSessionCreateOutcome
import com.agentsanywhere.app.feature.sessions.NewSessionModelCatalog
import com.agentsanywhere.app.feature.sessions.NewSessionPathEntry
import com.agentsanywhere.app.feature.sessions.NewSessionPermissionCatalog
import com.agentsanywhere.app.feature.sessions.NewSessionRuntimeCapabilities
import com.agentsanywhere.app.feature.sessions.NewSessionRuntimeSelectionState
import com.agentsanywhere.app.feature.sessions.NewSessionSubmissionState
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.sessions.MODEL_CATALOG_CAPABILITY
import com.agentsanywhere.app.feature.sessions.PERMISSION_CATALOG_CAPABILITY
import com.agentsanywhere.app.feature.sessions.workspaceOptionsFor
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.BackGlyph
import com.agentsanywhere.app.ui.designsystem.CheckGlyph
import com.agentsanywhere.app.ui.designsystem.CloseGlyph
import com.agentsanywhere.app.ui.designsystem.DownGlyph
import com.agentsanywhere.app.ui.designsystem.ForwardGlyph
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.agentsanywhere.app.ui.designsystem.SearchGlyph
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.designsystem.runtimePermissionLocalizer
import com.composables.icons.lucide.Bot
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.ChevronUp
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Monitor
import com.composables.icons.lucide.Pencil
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

@Composable
fun NewSessionScreen(
    navigate: (AppDestination) -> Unit,
    sessionsState: SessionsState,
    onCreateSession: suspend (NewSessionCreateDraft) -> NewSessionCreateOutcome,
    onListDirectory: suspend (String, String, String) -> Result<NewSessionDirectory>,
    onListRuntimes: suspend (String) -> Result<DeviceRuntimeList>,
    onLoadRuntimeCapabilities: suspend (String, String) -> Result<NewSessionRuntimeCapabilities>,
    onLoadModelCatalog: suspend (String, String) -> Result<NewSessionModelCatalog>,
    onLoadPermissionCatalog: suspend (String, String) -> Result<NewSessionPermissionCatalog>,
    onOpenSession: (AgentSession) -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val context = LocalContext.current
    val defaultTitle = stringResource(R.string.new_session_title)
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val focusRequester = remember { FocusRequester() }
    val devices = remember(sessionsState.devices) {
        sessionsState.devices.filter { it.online }
    }
    var title by rememberSaveable { mutableStateOf(defaultTitle) }
    var editingTitle by rememberSaveable { mutableStateOf(false) }
    var selectedDeviceId by rememberSaveable { mutableStateOf<String?>(null) }
    var runtimeSelection by remember { mutableStateOf(NewSessionRuntimeSelectionState()) }
    var selectedWorkspacePath by rememberSaveable { mutableStateOf("~") }
    var homePath by rememberSaveable { mutableStateOf<String?>(null) }
    var choosePath by rememberSaveable { mutableStateOf(false) }
    var currentPath by rememberSaveable { mutableStateOf("~") }
    var pathEntries by remember { mutableStateOf<List<NewSessionPathEntry>>(emptyList()) }
    var pathLoading by remember { mutableStateOf(false) }
    var pathError by remember { mutableStateOf<String?>(null) }
    var prompt by rememberSaveable { mutableStateOf("") }
    var pendingAttachments by rememberSaveable(stateSaver = NewSessionPendingAttachmentsSaver) {
        mutableStateOf(emptyList())
    }
    var submissionState by rememberSaveable(stateSaver = NewSessionSubmissionStateSaver) {
        mutableStateOf(NewSessionSubmissionState())
    }
    var sheet by remember { mutableStateOf<NewSessionSheet?>(null) }
    var workspaceListExpanded by rememberSaveable { mutableStateOf(true) }
    val creating = submissionState.inFlight

    LaunchedEffect(Unit) {
        submissionState = submissionState.interrupted(
            context.getString(R.string.new_session_create_interrupted),
        )
    }

    BackHandler(enabled = !creating) { navigate(AppDestination.Sessions) }

    LaunchedEffect(devices) {
        if (devices.none { it.id == selectedDeviceId }) {
            selectedDeviceId = devices.firstOrNull()?.id
        }
    }

    val selectedDevice = devices.firstOrNull { it.id == selectedDeviceId }
    val selectedDeviceOs = selectedDevice?.deviceOs
    val isWindowsDevice = isWindowsDeviceOs(selectedDeviceOs)
    val selectedRuntime = runtimeSelection.selectedRuntime

    suspend fun loadRuntimeDetails(connectorId: String, runtimeId: String) {
        runtimeSelection = runtimeSelection.beginRuntimeDetails()
        val requestKey = runtimeSelection.requestKey ?: return
        val capabilitiesResult = onLoadRuntimeCapabilities(connectorId, runtimeId)
        val capabilities = capabilitiesResult.getOrNull()
        if (capabilities == null) {
            val error = capabilitiesResult.exceptionOrNull()
            runtimeSelection = runtimeSelection.failCapabilities(
                requestKey,
                error?.message ?: context.getString(R.string.new_session_capabilities_failed),
            )
            return
        }
        runtimeSelection = runtimeSelection.applyCapabilities(requestKey, capabilities)
        if (runtimeSelection.requestKey != requestKey) return

        val modelUsable = capabilities.find(MODEL_CATALOG_CAPABILITY, runtimeId)?.usable == true
        val permissionUsable = capabilities.find(PERMISSION_CATALOG_CAPABILITY, runtimeId)?.usable == true
        coroutineScope {
            val modelRequest = if (modelUsable) {
                async { onLoadModelCatalog(connectorId, runtimeId) }
            } else {
                null
            }
            val permissionRequest = if (permissionUsable) {
                async { onLoadPermissionCatalog(connectorId, runtimeId) }
            } else {
                null
            }
            modelRequest?.await()?.let { result ->
                runtimeSelection = result.fold(
                    onSuccess = { runtimeSelection.applyModelCatalog(requestKey, it) },
                    onFailure = {
                        runtimeSelection.failModelCatalog(
                            requestKey,
                            it.message ?: context.getString(R.string.new_session_model_catalog_failed),
                        )
                    },
                )
            }
            permissionRequest?.await()?.let { result ->
                runtimeSelection = result.fold(
                    onSuccess = { runtimeSelection.applyPermissionCatalog(requestKey, it) },
                    onFailure = {
                        runtimeSelection.failPermissionCatalog(
                            requestKey,
                            it.message ?: context.getString(R.string.new_session_permission_catalog_failed),
                        )
                    },
                )
            }
        }
    }

    suspend fun loadRuntimeInventory(connectorId: String, refreshDetails: Boolean = false) {
        runtimeSelection = runtimeSelection.beginRuntimeInventory(connectorId)
        onListRuntimes(connectorId)
            .onSuccess { result ->
                runtimeSelection = runtimeSelection.replaceRuntimeInventory(result)
                if (refreshDetails) {
                    runtimeSelection.selectedRuntimeId?.let { runtimeId ->
                        loadRuntimeDetails(connectorId, runtimeId)
                    }
                }
            }
            .onFailure { error ->
                runtimeSelection = runtimeSelection.failRuntimeInventory(
                    connectorId,
                    error.message ?: context.getString(R.string.new_session_runtime_load_failed),
                )
            }
    }

    LaunchedEffect(selectedDevice?.id) {
        val connectorId = selectedDevice?.id
        if (connectorId == null) {
            runtimeSelection = NewSessionRuntimeSelectionState()
        } else {
            loadRuntimeInventory(connectorId)
        }
    }

    LaunchedEffect(runtimeSelection.connectorId, runtimeSelection.selectedRuntimeId) {
        val connectorId = runtimeSelection.connectorId ?: return@LaunchedEffect
        val runtimeId = runtimeSelection.selectedRuntimeId ?: return@LaunchedEffect
        if (runtimeSelection.requestKey?.connectorId == connectorId &&
            runtimeSelection.requestKey?.runtimeId == runtimeId
        ) {
            return@LaunchedEffect
        }
        loadRuntimeDetails(connectorId, runtimeId)
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

    LaunchedEffect(selectedDevice?.id) {
        if (selectedDevice == null) {
            homePath = null
            pathEntries = emptyList()
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

    val workspaceSessions = remember(sessionsState.sessions, sessionsState.archivedSessions) {
        sessionsState.sessions + sessionsState.archivedSessions
    }
    val workspaces = remember(workspaceSessions, selectedDevice?.id, homePath) {
        workspaceOptionsFor(workspaceSessions, selectedDevice?.id, homePath)
    }
    val selectedWorkspace = workspaces.firstOrNull { it.path == selectedWorkspacePath }
    val selectedWorkspaceTitle = selectedWorkspace?.title?.localizedWorkspaceTitle()
        ?: pathTitle(selectedWorkspacePath, stringResource(R.string.new_session_home_directory))
    val selectedWorkspaceDetail = selectedWorkspace?.detail ?: selectedWorkspacePath
    val canUseCurrentPath = isSelectableRemoteDirectory(currentPath, selectedDeviceOs)
    val effectiveWorkspacePath = if (choosePath) currentPath else selectedWorkspacePath
    val modelOptions = runtimeSelection.modelCatalog.data?.models
        ?.filter { model ->
            model.id.isNotBlank() && (
                model.selectionId?.isNotBlank() == true ||
                    model.reasoningItems.any { it.id.isNotBlank() && it.selectionId.isNotBlank() }
                )
        }
        .orEmpty()
    val permissionLocalizer = runtimePermissionLocalizer()
    val permissionOptions = runtimeSelection.permissionCatalog.data?.permissions
        ?.filter { it.id.isNotBlank() && it.selectionId.isNotBlank() }
        ?.map { permission ->
            val localized = permissionLocalizer.localize(
                runtime = runtimeSelection.permissionCatalog.data?.runtime ?: selectedRuntime?.id,
                permissionId = permission.id,
                label = permission.displayName.ifBlank { permission.id },
                description = permission.description,
                metadata = permission.metadata,
            )
            permission.copy(displayName = localized.label, description = localized.description)
        }
        .orEmpty()
    val catalogLoading = runtimeSelection.capabilities.loading ||
        runtimeSelection.modelCatalog.loading ||
        runtimeSelection.permissionCatalog.loading
    val canStart = selectedDevice != null &&
        selectedRuntime != null &&
        runtimeSelection.readyForCreate &&
        effectiveWorkspacePath.isNotBlank() &&
        (prompt.isNotBlank() || pendingAttachments.isNotEmpty()) &&
        !creating &&
        !submissionState.outcomeUnknown &&
        (!choosePath || (!pathLoading && canUseCurrentPath))

    val filePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        uris.forEach { uri ->
            runCatching {
                context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
        val remaining = MAX_NEW_SESSION_ATTACHMENTS - pendingAttachments.size
        if (remaining <= 0) {
            submissionState = submissionState.fail(
                context.getString(R.string.new_session_attachment_limit, MAX_NEW_SESSION_ATTACHMENTS),
                outcomeUnknown = false,
            )
            return@rememberLauncherForActivityResult
        }
        val selected = uris.mapNotNull(context::newSessionPendingAttachment)
        if (selected.size > remaining) {
            submissionState = submissionState.fail(
                context.getString(R.string.new_session_attachment_limit, MAX_NEW_SESSION_ATTACHMENTS),
                outcomeUnknown = false,
            )
        }
        val accepted = selected.filter { attachment ->
            if (attachment.size > MAX_NEW_SESSION_ATTACHMENT_BYTES) {
                submissionState = submissionState.fail(
                    context.getString(R.string.new_session_attachment_too_large, attachment.name),
                    outcomeUnknown = false,
                )
                false
            } else {
                true
            }
        }.take(remaining)
        pendingAttachments = pendingAttachments + accepted
    }

    fun submitTitle() {
        title = title.trim().ifBlank { defaultTitle }
        editingTitle = false
        keyboard?.hide()
    }

    fun startSession() {
        val device = selectedDevice ?: return
        val runtime = selectedRuntime ?: return
        if (!canStart) return
        val start = submissionState.begin { "msg_${UUID.randomUUID()}" } ?: return
        submissionState = start.state
        val frozenTitle = title.trim().takeIf(String::isNotBlank)
        val frozenCwd = effectiveWorkspacePath.trim().takeIf(String::isNotBlank)
        val frozenContent = prompt.trim()
        val frozenSelections = runtimeSelection.selections
        val frozenAttachments = pendingAttachments.toList()
        val frozenRequestKey = runtimeSelection.requestKey
        val knownSessionIds = (sessionsState.sessions + sessionsState.archivedSessions).mapTo(mutableSetOf()) { it.id }
        scope.launch {
            val attachments = try {
                withContext(Dispatchers.IO) {
                    frozenAttachments.map { context.readNewSessionAttachment(it) }
                }
            } catch (error: Exception) {
                submissionState = submissionState.fail(
                    error.message ?: context.getString(R.string.new_session_attachment_read_failed),
                    outcomeUnknown = false,
                )
                return@launch
            }
            if (runtimeSelection.requestKey != frozenRequestKey || !runtimeSelection.readyForCreate) {
                submissionState = submissionState.fail(
                    context.getString(R.string.new_session_runtime_changed),
                    outcomeUnknown = false,
                )
                return@launch
            }
            when (
                val outcome = onCreateSession(
                    NewSessionCreateDraft(
                        connectorId = device.id,
                        runtime = runtime.id,
                        title = frozenTitle,
                        cwd = frozenCwd,
                        content = frozenContent,
                        selections = frozenSelections,
                        attachments = attachments,
                        clientMessageId = start.clientMessageId,
                        knownSessionIds = knownSessionIds,
                    ),
                )
            ) {
                is NewSessionCreateOutcome.Created -> onOpenSession(outcome.session)
                is NewSessionCreateOutcome.Failed -> {
                    submissionState = submissionState.fail(
                        outcome.error.message ?: context.getString(R.string.new_session_create_failed),
                        outcomeUnknown = outcome.outcomeUnknown,
                    )
                }
            }
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
                onClose = { if (!creating) navigate(AppDestination.Sessions) },
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
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(58.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    RuntimeSelectPill(
                        label = stringResource(R.string.new_session_device),
                        value = selectedDevice?.name ?: stringResource(R.string.new_session_no_device),
                        icon = Lucide.Monitor,
                        darkMode = darkMode,
                        modifier = Modifier.weight(1f),
                        enabled = !creating,
                        onClick = { sheet = NewSessionSheet.Device },
                    )
                    RuntimeSelectPill(
                        label = stringResource(R.string.new_session_agent),
                        value = selectedRuntime?.displayName ?: stringResource(R.string.new_session_no_agent),
                        icon = Lucide.Bot,
                        darkMode = darkMode,
                        modifier = Modifier.weight(1f),
                        enabled = selectedDevice != null && !creating,
                        onClick = {
                            sheet = NewSessionSheet.Agent
                            selectedDevice?.id?.let { connectorId ->
                                scope.launch { loadRuntimeInventory(connectorId, refreshDetails = true) }
                            }
                        },
                    )
                }

                if (selectedRuntime != null) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        RuntimeSelectPill(
                            label = stringResource(R.string.new_session_model),
                            value = when {
                                catalogLoading -> stringResource(R.string.new_session_catalog_loading)
                                runtimeSelection.selectedModel != null -> runtimeSelection.selectedModel!!.displayName
                                else -> stringResource(R.string.new_session_catalog_unavailable)
                            },
                            icon = Lucide.Bot,
                            darkMode = darkMode,
                            modifier = Modifier.weight(1f),
                            enabled = runtimeSelection.canUseModelCatalog &&
                                runtimeSelection.modelCatalog.fresh && modelOptions.isNotEmpty(),
                            onClick = { sheet = NewSessionSheet.Model },
                        )
                        RuntimeSelectPill(
                            label = stringResource(R.string.new_session_permission),
                            value = when {
                                catalogLoading -> stringResource(R.string.new_session_catalog_loading)
                                runtimeSelection.selectedPermission != null -> permissionOptions
                                    .firstOrNull { it.id == runtimeSelection.selectedPermissionId }
                                    ?.displayName
                                    ?: runtimeSelection.selectedPermission!!.displayName
                                else -> stringResource(R.string.new_session_catalog_unavailable)
                            },
                            icon = Lucide.Pencil,
                            darkMode = darkMode,
                            modifier = Modifier.weight(1f),
                            enabled = runtimeSelection.canUsePermissionCatalog &&
                                runtimeSelection.permissionCatalog.fresh && permissionOptions.isNotEmpty(),
                            onClick = { sheet = NewSessionSheet.Permission },
                        )
                    }
                    if (runtimeSelection.reasoningOptions.isNotEmpty()) {
                        RuntimeSelectPill(
                            label = stringResource(R.string.new_session_reasoning),
                            value = runtimeSelection.selectedReasoning?.displayName
                                ?: stringResource(R.string.new_session_catalog_unavailable),
                            icon = Lucide.Bot,
                            darkMode = darkMode,
                            enabled = runtimeSelection.modelCatalog.fresh,
                            onClick = { sheet = NewSessionSheet.Reasoning },
                        )
                    }
                    val catalogNote = runtimeSelection.catalogStatusMessage()
                    catalogNote?.let {
                        Text(
                            text = it,
                            color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777),
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            lineHeight = 16.sp,
                            modifier = Modifier.padding(horizontal = 4.dp),
                        )
                    }
                }

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
                                workspaceListExpanded = false
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
                        selectedTitle = selectedWorkspaceTitle,
                        selectedDetail = selectedWorkspaceDetail,
                        workspaces = workspaces,
                        expanded = workspaceListExpanded,
                        darkMode = darkMode,
                        modifier = Modifier.weight(1f),
                        onChoosePath = {
                            choosePath = true
                            val startPath = if (isWindowsDevice) "" else selectedWorkspacePath
                            scope.launch {
                                loadDirectory(
                                    targetPath = startPath,
                                    fallbackRoot = selectedWorkspacePath,
                                )
                            }
                        },
                        onToggleExpanded = { workspaceListExpanded = !workspaceListExpanded },
                        onSelectWorkspace = {
                            selectedWorkspacePath = it.path
                            workspaceListExpanded = false
                        },
                    )
                }
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .windowInsetsPadding(WindowInsets.navigationBars)
                    .imePadding()
                    .padding(start = 18.dp, end = 18.dp, bottom = 10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                NewSessionPromptComposer(
                    prompt = prompt,
                    attachments = pendingAttachments,
                    darkMode = darkMode,
                    enabled = !creating && !submissionState.outcomeUnknown,
                    onPromptChange = { prompt = it },
                    onAttach = {
                        runCatching { filePicker.launch(arrayOf("*/*")) }
                            .onFailure {
                                submissionState = submissionState.fail(
                                    context.getString(R.string.new_session_attachment_picker_failed),
                                    outcomeUnknown = false,
                                )
                            }
                    },
                    onRemoveAttachment = { attachment ->
                        pendingAttachments = pendingAttachments.filterNot { it.uri == attachment.uri }
                    },
                )
                val runtimeError = when {
                    devices.isEmpty() -> stringResource(R.string.new_session_no_online_agent)
                    runtimeSelection.runtimesErrorMessage != null -> runtimeSelection.runtimesErrorMessage
                    !runtimeSelection.runtimesLoading && runtimeSelection.runtimes.isEmpty() ->
                        stringResource(R.string.new_session_no_attached_agents)
                    selectedRuntime?.present == false -> stringResource(R.string.device_runtime_not_present)
                    selectedRuntime?.configured == false -> stringResource(R.string.device_runtime_not_configured)
                    selectedRuntime?.active == false -> stringResource(R.string.new_session_runtime_inactive)
                    selectedRuntime?.detailMessage != null -> selectedRuntime.detailMessage
                    runtimeSelection.capabilities.errorMessage != null -> runtimeSelection.capabilities.errorMessage
                    runtimeSelection.modelCatalog.errorMessage != null -> runtimeSelection.modelCatalog.errorMessage
                    runtimeSelection.permissionCatalog.errorMessage != null -> runtimeSelection.permissionCatalog.errorMessage
                    else -> null
                }
                val error = submissionState.errorMessage ?: runtimeError
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
                        if (submissionState.errorMessage == null && selectedDevice != null) {
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
                                            loadRuntimeInventory(selectedDevice.id, refreshDetails = true)
                                        } else {
                                            runtimeSelection.selectedRuntimeId?.let { runtimeId ->
                                                loadRuntimeDetails(selectedDevice.id, runtimeId)
                                            }
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
                StartChatButton(
                    label = if (creating) stringResource(R.string.new_session_starting) else stringResource(R.string.new_session_start_chat),
                    enabled = canStart,
                    onClick = ::startSession,
                )
            }
        }
    }

    when (sheet) {
        NewSessionSheet.Device -> DevicePickerSheet(
            devices = devices,
            selectedDeviceId = selectedDevice?.id,
            darkMode = darkMode,
            onDismiss = { sheet = null },
            onSelect = {
                selectedDeviceId = it.id
                sheet = null
            },
        )
        NewSessionSheet.Agent -> RuntimePickerSheet(
            runtimes = runtimeSelection.runtimes,
            loading = runtimeSelection.runtimesLoading,
            errorMessage = runtimeSelection.runtimesErrorMessage,
            selectedRuntimeId = selectedRuntime?.id,
            darkMode = darkMode,
            onDismiss = { sheet = null },
            onRetry = {
                selectedDevice?.id?.let { connectorId ->
                    scope.launch { loadRuntimeInventory(connectorId, refreshDetails = true) }
                }
            },
            onSelect = { runtime ->
                runtimeSelection = runtimeSelection.selectRuntime(runtime.id)
                sheet = null
            },
        )
        NewSessionSheet.Model -> CatalogPickerSheet(
            title = stringResource(R.string.new_session_choose_model),
            items = modelOptions.map {
                CatalogPickerItem(it.id, it.displayName, it.description.orEmpty())
            },
            selectedId = runtimeSelection.selectedModelId,
            darkMode = darkMode,
            onDismiss = { sheet = null },
            onSelect = {
                runtimeSelection = runtimeSelection.selectModel(it)
                sheet = null
            },
        )
        NewSessionSheet.Reasoning -> CatalogPickerSheet(
            title = stringResource(R.string.new_session_choose_reasoning),
            items = runtimeSelection.reasoningOptions.map {
                CatalogPickerItem(it.id, it.displayName, it.description.orEmpty())
            },
            selectedId = runtimeSelection.selectedReasoningId,
            darkMode = darkMode,
            onDismiss = { sheet = null },
            onSelect = {
                runtimeSelection = runtimeSelection.selectReasoning(it)
                sheet = null
            },
        )
        NewSessionSheet.Permission -> CatalogPickerSheet(
            title = stringResource(R.string.new_session_choose_permission),
            items = permissionOptions.map {
                CatalogPickerItem(it.id, it.displayName, it.description.orEmpty())
            },
            selectedId = runtimeSelection.selectedPermissionId,
            darkMode = darkMode,
            onDismiss = { sheet = null },
            onSelect = {
                runtimeSelection = runtimeSelection.selectPermission(it)
                sheet = null
            },
        )
        null -> Unit
    }
}

@Composable
private fun NewSessionHeader(
    title: String,
    editing: Boolean,
    darkMode: Boolean,
    focusRequester: FocusRequester,
    onTitleChange: (String) -> Unit,
    onSubmitTitle: () -> Unit,
    onClose: () -> Unit,
    onEditToggle: () -> Unit,
) {
    val colors = LocalAAColors.current
    val iconColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777)
    var titleField by remember { mutableStateOf(title.textFieldValueAtEnd()) }

    LaunchedEffect(editing) {
        if (editing) {
            titleField = title.textFieldValueAtEnd()
        }
    }

    LaunchedEffect(title, editing) {
        if (!editing && titleField.text != title) {
            titleField = title.textFieldValueAtEnd()
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(58.dp)
            .padding(horizontal = 18.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HeaderCircleButton(darkMode = darkMode, onClick = onClose) {
            CloseGlyph(color = iconColor, sizeDp = 17)
        }
        if (editing) {
            Column(
                modifier = Modifier.width(210.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                BasicTextField(
                    value = titleField,
                    onValueChange = {
                        titleField = it
                        onTitleChange(it.text)
                    },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focusRequester),
                    textStyle = TextStyle(
                        color = colors.ink,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.SansSerif,
                        textAlign = TextAlign.Center,
                    ),
                    cursorBrush = SolidColor(colors.ink),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { onSubmitTitle() }),
                    decorationBox = { inner ->
                        Box(contentAlignment = Alignment.Center) {
                            inner()
                        }
                    },
                )
                Box(
                    modifier = Modifier
                        .width(142.dp)
                        .height(1.5.dp)
                        .clip(CircleShape)
                        .background(if (darkMode) Color(0xFF71717A) else Color(0xFFBDBDBD)),
                )
            }
        } else {
            Text(
                text = title,
                color = colors.ink,
                fontSize = 20.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 24.sp,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 16.dp),
            )
        }
        HeaderCircleButton(darkMode = darkMode, onClick = onEditToggle) {
            if (editing) {
                CheckGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF333333))
            } else {
                Icon(
                    imageVector = Lucide.Pencil,
                    contentDescription = null,
                    tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

@Composable
private fun HeaderCircleButton(
    darkMode: Boolean,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(CircleShape)
            .background(if (darkMode) Color(0xFF18181B) else Color.White)
            .border(1.dp, if (darkMode) Color(0xFF27272A) else Color(0xFFE8E8E8), CircleShape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

@Composable
private fun RuntimeSelectPill(
    label: String,
    value: String,
    icon: ImageVector,
    darkMode: Boolean,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFECECEC)
    val surface = if (darkMode) Color(0xFF18181B) else Color(0xFFFBFBFB)
    val titleColor = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF2B2B2B)
    val labelColor = if (darkMode) Color(0xFF71717A) else Color(0xFFAAAAAA)
    val iconColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777)

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(58.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(surface)
            .border(1.dp, border, RoundedCornerShape(18.dp))
            .noRippleClickable {
                if (enabled) onClick()
            }
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = iconColor,
            modifier = Modifier.size(18.dp),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = label,
                color = labelColor,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                lineHeight = 14.sp,
                maxLines = 1,
            )
            Text(
                text = value,
                color = titleColor,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                lineHeight = 20.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        DownGlyph(
            color = if (enabled) {
                if (darkMode) Color(0xFF71717A) else Color(0xFFAAAAAA)
            } else {
                if (darkMode) Color(0xFF3F3F46) else Color(0xFFD4D4D4)
            },
        )
    }
}

@Composable
private fun WorkspaceSection(
    selectedTitle: String,
    selectedDetail: String,
    workspaces: List<com.agentsanywhere.app.feature.sessions.NewSessionWorkspace>,
    expanded: Boolean,
    darkMode: Boolean,
    modifier: Modifier,
    onChoosePath: () -> Unit,
    onToggleExpanded: () -> Unit,
    onSelectWorkspace: (com.agentsanywhere.app.feature.sessions.NewSessionWorkspace) -> Unit,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(32.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.new_session_workspace),
                color = LocalAAColors.current.ink,
                fontSize = 17.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 21.sp,
            )
            SmallPill(darkMode = darkMode, onClick = onChoosePath) {
                SearchGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555))
                Text(
                    text = stringResource(R.string.new_session_choose_path),
                    color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.ExtraBold,
                    maxLines = 1,
                )
            }
        }
        WorkspaceTrigger(
            title = selectedTitle,
            detail = selectedDetail,
            expanded = expanded,
            darkMode = darkMode,
            onToggleExpanded = onToggleExpanded,
        )
        if (expanded) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            ) {
                items(workspaces, key = { it.path }) { workspace ->
                    WorkspaceRow(
                        title = workspace.title,
                        detail = workspace.detail,
                        darkMode = darkMode,
                        onClick = { onSelectWorkspace(workspace) },
                    )
                }
            }
        }
    }
}

@Composable
private fun WorkspaceTrigger(
    title: String,
    detail: String,
    expanded: Boolean,
    darkMode: Boolean,
    onToggleExpanded: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(if (darkMode) Color(0xFF18181B) else Color(0xFFF7F7F7))
            .border(1.dp, if (darkMode) Color(0xFF27272A) else Color(0xFFE8E8E8), RoundedCornerShape(18.dp))
            .padding(horizontal = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            imageVector = Lucide.Folder,
            contentDescription = null,
            tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
            modifier = Modifier.size(20.dp),
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = title,
                color = LocalAAColors.current.ink,
                fontSize = 16.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 20.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = detail,
                color = if (darkMode) Color(0xFF71717A) else Color(0xFF8A8A8A),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 16.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(if (darkMode) Color.White.copy(alpha = 0.04f) else Color.Black.copy(alpha = 0.04f))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onToggleExpanded,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = if (expanded) Lucide.ChevronUp else Lucide.ChevronDown,
                contentDescription = null,
                tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun WorkspaceRow(
    title: String,
    detail: String,
    darkMode: Boolean,
    onClick: () -> Unit,
) {
    val feedbackScope = rememberCoroutineScope()
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    var flash by remember { mutableStateOf(false) }
    val active = pressed || flash
    val rowShape = RoundedCornerShape(16.dp)
    val pressedSurface = if (darkMode) Color(0xFF18181B) else Color(0xFFEDEBE6)
    val shadowColor = if (darkMode) Color(0x77000000) else Color(0x30000000)
    val elevation by animateDpAsState(
        targetValue = if (active) 14.dp else 0.dp,
        label = "new-session-workspace-row-elevation",
    )
    val surfaceAlpha by animateFloatAsState(
        targetValue = if (active) 1f else 0f,
        label = "new-session-workspace-row-surface-alpha",
    )
    val titleColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF4A4A4A)
    val detailColor = if (darkMode) Color(0xFF71717A) else Color(0xFF888888)
    val iconColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(58.dp)
            .shadow(
                elevation = elevation,
                shape = rowShape,
                clip = false,
                ambientColor = shadowColor,
                spotColor = shadowColor,
            )
            .clip(rowShape)
            .background(pressedSurface.copy(alpha = surfaceAlpha))
            .clickable(
                interactionSource = interactionSource,
                indication = null,
            ) {
                flash = true
                feedbackScope.launch {
                    delay(160)
                    onClick()
                    flash = false
                }
            }
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            imageVector = Lucide.Folder,
            contentDescription = null,
            tint = iconColor,
            modifier = Modifier.size(20.dp),
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = title,
                color = titleColor,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 20.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = detail,
                color = detailColor,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 16.sp,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.StartEllipsis,
            )
        }
    }
}

@Composable
private fun ChoosePathSection(
    currentPath: String,
    currentPathLabel: String,
    parentPath: String?,
    entries: List<NewSessionPathEntry>,
    loading: Boolean,
    error: String?,
    darkMode: Boolean,
    canUseCurrent: Boolean,
    modifier: Modifier,
    onBack: () -> Unit,
    onParent: () -> Unit,
    onUseCurrent: () -> Unit,
    onOpenEntry: (NewSessionPathEntry) -> Unit,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(32.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.new_session_choose_path),
                color = LocalAAColors.current.ink,
                fontSize = 17.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 21.sp,
            )
            SmallPill(darkMode = darkMode, onClick = onBack) {
                BackGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555))
                Text(
                    text = stringResource(R.string.common_back),
                    color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.ExtraBold,
                    maxLines = 1,
                )
            }
        }
        CurrentDirectoryBar(
            currentPath = currentPathLabel,
            darkMode = darkMode,
            canGoParent = parentPath != null,
            canUseCurrent = canUseCurrent,
            onParent = onParent,
            onUseCurrent = onUseCurrent,
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        ) {
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                when {
                    loading -> item {
                        PathMessage(stringResource(R.string.new_session_loading_directory), darkMode)
                    }
                    error != null -> item {
                        PathMessage(error, darkMode)
                    }
                    else -> {
                        if (parentPath != null) {
                            item(key = "$currentPath/..") {
                                PathRow(name = "..", icon = Lucide.Folder, darkMode = darkMode, onClick = onParent)
                            }
                        }
                        if (entries.isEmpty()) {
                            item { PathMessage(stringResource(R.string.new_session_empty_directory), darkMode) }
                        }
                        items(entries, key = { it.path }) { entry ->
                            PathRow(name = entry.name, icon = Lucide.Folder, darkMode = darkMode, onClick = { onOpenEntry(entry) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CurrentDirectoryBar(
    currentPath: String,
    darkMode: Boolean,
    canGoParent: Boolean,
    canUseCurrent: Boolean,
    onParent: () -> Unit,
    onUseCurrent: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(if (darkMode) Color(0xFF18181B) else Color(0xFFF7F7F7))
            .border(1.dp, if (darkMode) Color(0xFF27272A) else Color(0xFFE8E8E8), RoundedCornerShape(18.dp))
            .padding(start = 13.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            imageVector = Lucide.Folder,
            contentDescription = null,
            tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
            modifier = Modifier.size(20.dp),
        )
        Text(
            text = currentPath,
            modifier = Modifier.weight(1f),
            color = LocalAAColors.current.ink,
            fontSize = 15.sp,
            fontWeight = FontWeight.ExtraBold,
            lineHeight = 20.sp,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.MiddleEllipsis,
        )
        if (canGoParent) {
            CircleMiniButton(darkMode = darkMode, onClick = onParent) {
                BackGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777))
            }
        }
        CircleMiniButton(
            darkMode = darkMode,
            selected = !darkMode && canUseCurrent,
            enabled = canUseCurrent,
            onClick = onUseCurrent,
        ) {
            val checkColor = when {
                !canUseCurrent -> if (darkMode) Color(0xFF52525B) else Color(0xFFBDBDBD)
                darkMode -> Color(0xFFA1A1AA)
                else -> Color(0xFF16A34A)
            }
            CheckGlyph(color = checkColor)
        }
    }
}

@Composable
private fun PathRow(
    name: String,
    icon: ImageVector,
    darkMode: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(58.dp)
            .clip(RoundedCornerShape(12.dp))
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777),
            modifier = Modifier.size(20.dp),
        )
        Text(
            text = name,
            color = LocalAAColors.current.ink,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 20.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Icon(
            imageVector = Lucide.ChevronRight,
            contentDescription = null,
            tint = if (darkMode) Color(0xFF71717A) else Color(0xFFA8A6A0),
            modifier = Modifier.size(20.dp),
        )
    }
}

@Composable
private fun PathMessage(message: String, darkMode: Boolean) {
    Text(
        text = message,
        color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777),
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 18.dp, start = 4.dp),
    )
}

@Composable
private fun SmallPill(
    darkMode: Boolean,
    onClick: () -> Unit,
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = Modifier
            .height(30.dp)
            .clip(CircleShape)
            .background(if (darkMode) Color(0xFF18181B) else Color(0xFFFBFBFB))
            .border(1.dp, if (darkMode) Color(0xFF27272A) else Color(0xFFECECEC), CircleShape)
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        content = content,
    )
}

@Composable
private fun CircleMiniButton(
    darkMode: Boolean,
    selected: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    val background = when {
        selected -> Color(0xFFEFFBF4)
        darkMode -> Color(0xFF18181B)
        else -> Color.White
    }
    val border = when {
        selected -> Color(0xFFBAE7C8)
        darkMode -> Color(0xFF27272A)
        else -> Color(0xFFE8E8E8)
    }
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(background)
            .border(1.dp, border, CircleShape)
            .noRippleClickable {
                if (enabled) onClick()
            },
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

@Composable
private fun StartChatButton(
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val alpha = if (enabled) 1f else 0.45f
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(54.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(colors.primaryAction.copy(alpha = alpha))
            .noRippleClickable {
                if (enabled) onClick()
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(
            text = label,
            color = colors.onPrimaryAction,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 20.sp,
        )
        Spacer(Modifier.width(8.dp))
        ForwardGlyph(color = colors.onPrimaryAction)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DevicePickerSheet(
    devices: List<AgentDevice>,
    selectedDeviceId: String?,
    darkMode: Boolean,
    onDismiss: () -> Unit,
    onSelect: (AgentDevice) -> Unit,
) {
    PickerSheet(title = stringResource(R.string.new_session_choose_device), darkMode = darkMode, onDismiss = onDismiss) {
        if (devices.isEmpty()) {
            SheetEmptyText(stringResource(R.string.new_session_no_online_agents), darkMode)
        } else {
            LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                items(devices, key = { it.id }) { device ->
                    SheetChoiceRow(
                        title = device.name,
                        subtitle = device.subtitle,
                        selected = device.id == selectedDeviceId,
                        darkMode = darkMode,
                        icon = Lucide.Monitor,
                        onClick = { onSelect(device) },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RuntimePickerSheet(
    runtimes: List<DeviceRuntime>,
    loading: Boolean,
    errorMessage: String?,
    selectedRuntimeId: String?,
    darkMode: Boolean,
    onDismiss: () -> Unit,
    onRetry: () -> Unit,
    onSelect: (DeviceRuntime) -> Unit,
) {
    PickerSheet(title = stringResource(R.string.new_session_choose_agent), darkMode = darkMode, onDismiss = onDismiss) {
        if (loading && runtimes.isEmpty()) {
            SheetEmptyText(stringResource(R.string.device_runtime_loading), darkMode)
        } else if (runtimes.isEmpty()) {
            SheetEmptyText(
                errorMessage ?: stringResource(R.string.new_session_no_attached_agents),
                darkMode,
            )
            Text(
                text = stringResource(R.string.common_retry),
                color = LocalAAColors.current.primaryAction,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(horizontal = 4.dp).noRippleClickable(onClick = onRetry),
            )
        } else {
            LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                items(runtimes, key = { it.id }) { runtime ->
                    SheetChoiceRow(
                        title = runtime.displayName,
                        subtitle = runtime.pickerSubtitle(),
                        selected = runtime.id == selectedRuntimeId,
                        darkMode = darkMode,
                        icon = Lucide.Bot,
                        onClick = { onSelect(runtime) },
                    )
                }
            }
            if (loading) {
                SheetEmptyText(stringResource(R.string.device_runtime_loading), darkMode)
            }
        }
    }
}

private data class CatalogPickerItem(
    val id: String,
    val title: String,
    val subtitle: String,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CatalogPickerSheet(
    title: String,
    items: List<CatalogPickerItem>,
    selectedId: String?,
    darkMode: Boolean,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit,
) {
    PickerSheet(title = title, darkMode = darkMode, onDismiss = onDismiss) {
        if (items.isEmpty()) {
            SheetEmptyText(stringResource(R.string.new_session_catalog_unavailable), darkMode)
        } else {
            LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                items(items, key = { it.id }) { item ->
                    SheetChoiceRow(
                        title = item.title,
                        subtitle = item.subtitle,
                        selected = item.id == selectedId,
                        darkMode = darkMode,
                        icon = Lucide.Bot,
                        onClick = { onSelect(item.id) },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PickerSheet(
    title: String,
    darkMode: Boolean,
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = if (darkMode) Color(0xFF18181B) else Color.White,
        contentColor = LocalAAColors.current.ink,
        scrimColor = if (darkMode) Color(0x66000000) else Color(0x30000000),
        dragHandle = {
            Box(
                modifier = Modifier
                    .padding(top = 11.dp, bottom = 10.dp)
                    .width(42.dp)
                    .height(4.dp)
                    .clip(CircleShape)
                    .background(if (darkMode) Color(0xFF3F3F46) else Color(0xFFD8D8D8)),
            )
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(start = 22.dp, end = 22.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = title,
                color = LocalAAColors.current.ink,
                fontSize = 20.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 24.sp,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
            content()
        }
    }
}

@Composable
private fun SheetChoiceRow(
    title: String,
    subtitle: String,
    selected: Boolean,
    darkMode: Boolean,
    icon: ImageVector,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .clip(RoundedCornerShape(14.dp))
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777),
            modifier = Modifier.size(20.dp),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                color = LocalAAColors.current.ink,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle.isNotBlank()) {
                Text(
                    text = subtitle,
                    color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (selected) {
            CheckGlyph(color = Color(0xFF22C55E))
        }
    }
}

@Composable
private fun SheetEmptyText(message: String, darkMode: Boolean) {
    Text(
        text = message,
        color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777),
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 16.dp),
    )
}

@Composable
private fun NewSessionPromptComposer(
    prompt: String,
    attachments: List<NewSessionPendingAttachment>,
    darkMode: Boolean,
    enabled: Boolean,
    onPromptChange: (String) -> Unit,
    onAttach: () -> Unit,
    onRemoveAttachment: (NewSessionPendingAttachment) -> Unit,
) {
    val ink = if (darkMode) Color(0xFFEDEDEF) else Color(0xFF252622)
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777)
    val surface = if (darkMode) Color(0xFF18181B) else Color.White
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE9E6E1)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(surface)
            .border(1.dp, border, RoundedCornerShape(18.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        if (attachments.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                attachments.forEach { attachment ->
                    Row(
                        modifier = Modifier
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (darkMode) Color(0xFF27272A) else Color(0xFFF3F1ED))
                            .padding(start = 10.dp, top = 7.dp, end = 8.dp, bottom = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = attachment.name,
                            color = ink,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.width(120.dp),
                        )
                        Box(
                            modifier = Modifier
                                .size(18.dp)
                                .noRippleClickable(enabled = enabled) { onRemoveAttachment(attachment) },
                            contentAlignment = Alignment.Center,
                        ) {
                            CloseGlyph(color = muted)
                        }
                    }
                }
            }
        }
        BasicTextField(
            value = prompt,
            onValueChange = onPromptChange,
            enabled = enabled,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp, max = 104.dp),
            textStyle = TextStyle(
                color = ink,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 20.sp,
            ),
            cursorBrush = SolidColor(ink),
            maxLines = 5,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.TopStart) {
                    if (prompt.isEmpty()) {
                        Text(
                            text = stringResource(R.string.new_session_message_placeholder),
                            color = muted,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                    inner()
                }
            },
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.new_session_attach_files),
                color = if (enabled) LocalAAColors.current.primaryAction else muted,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.noRippleClickable(enabled = enabled, onClick = onAttach),
            )
            Spacer(modifier = Modifier.weight(1f))
            Text(
                text = "${attachments.size}/$MAX_NEW_SESSION_ATTACHMENTS",
                color = muted,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

private data class NewSessionPendingAttachment(
    val uri: String,
    val name: String,
    val mediaType: String,
    val size: Long,
)

private fun Context.newSessionPendingAttachment(uri: Uri): NewSessionPendingAttachment? {
    val resolver = contentResolver
    var name = uri.lastPathSegment?.substringAfterLast('/').orEmpty().ifBlank { "attachment" }
    var size = 0L
    resolver.query(uri, null, null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
            if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
        }
    }
    if (name.isBlank()) return null
    return NewSessionPendingAttachment(
        uri = uri.toString(),
        name = name,
        mediaType = resolver.getType(uri).orEmpty(),
        size = size,
    )
}

private fun Context.readNewSessionAttachment(attachment: NewSessionPendingAttachment): NewSessionAttachmentPart {
    val bytes = contentResolver.openInputStream(Uri.parse(attachment.uri))?.use { it.readBytes() }
        ?: throw IllegalStateException(getString(R.string.new_session_attachment_read_failed))
    if (bytes.isEmpty()) {
        throw IllegalStateException(getString(R.string.new_session_attachment_empty, attachment.name))
    }
    if (bytes.size > MAX_NEW_SESSION_ATTACHMENT_BYTES) {
        throw IllegalStateException(getString(R.string.new_session_attachment_too_large, attachment.name))
    }
    return NewSessionAttachmentPart(
        name = attachment.name,
        mediaType = attachment.mediaType,
        bytes = bytes,
    )
}

private val NewSessionPendingAttachmentsSaver = listSaver<List<NewSessionPendingAttachment>, Any>(
    save = { attachments ->
        attachments.flatMap { attachment ->
            listOf(attachment.uri, attachment.name, attachment.mediaType, attachment.size)
        }
    },
    restore = { values ->
        values.chunked(4).mapNotNull { attachment ->
            if (attachment.size != 4) return@mapNotNull null
            NewSessionPendingAttachment(
                uri = attachment[0] as String,
                name = attachment[1] as String,
                mediaType = attachment[2] as String,
                size = attachment[3] as Long,
            )
        }
    },
)

private val NewSessionSubmissionStateSaver = listSaver<NewSessionSubmissionState, Any>(
    save = { state ->
        listOf(
            state.inFlight,
            state.clientMessageId.orEmpty(),
            state.outcomeUnknown,
            state.errorMessage.orEmpty(),
        )
    },
    restore = { values ->
        NewSessionSubmissionState(
            inFlight = values[0] as Boolean,
            clientMessageId = (values[1] as String).takeIf(String::isNotBlank),
            outcomeUnknown = values[2] as Boolean,
            errorMessage = (values[3] as String).takeIf(String::isNotBlank),
        )
    },
)

private const val MAX_NEW_SESSION_ATTACHMENTS = 10
private const val MAX_NEW_SESSION_ATTACHMENT_BYTES = 25 * 1024 * 1024

private enum class NewSessionSheet {
    Device,
    Agent,
    Model,
    Reasoning,
    Permission,
}

@Composable
private fun DeviceRuntime.pickerSubtitle(): String {
    val readiness = when {
        !present -> stringResource(R.string.device_runtime_not_present)
        !configured -> stringResource(R.string.device_runtime_not_configured)
        !active -> stringResource(R.string.new_session_runtime_inactive)
        else -> when (status) {
            DeviceRuntimeStatus.Stopped -> stringResource(R.string.device_runtime_stopped)
            DeviceRuntimeStatus.Discovering -> stringResource(R.string.device_runtime_discovering)
            DeviceRuntimeStatus.Available -> stringResource(R.string.device_runtime_available)
            DeviceRuntimeStatus.Unavailable -> stringResource(R.string.device_runtime_unavailable)
            DeviceRuntimeStatus.Validating -> stringResource(R.string.device_runtime_validating)
            DeviceRuntimeStatus.Starting -> stringResource(R.string.device_runtime_starting)
            DeviceRuntimeStatus.Running -> stringResource(R.string.device_runtime_running)
            DeviceRuntimeStatus.Stopping -> stringResource(R.string.device_runtime_stopping)
            DeviceRuntimeStatus.Error -> stringResource(R.string.device_runtime_error)
            DeviceRuntimeStatus.Unknown -> stringResource(R.string.device_runtime_unknown)
        }
    }
    return listOfNotNull(id, readiness, detailMessage).joinToString(" · ")
}

@Composable
private fun NewSessionRuntimeSelectionState.catalogStatusMessage(): String? {
    if (capabilities.loading || modelCatalog.loading || permissionCatalog.loading) {
        return stringResource(R.string.new_session_catalog_loading)
    }
    val messages = buildList {
        if (capabilities.fresh && !canUseModelCatalog) {
            add(
                modelCapability?.unavailableReason
                    ?: stringResource(R.string.new_session_model_catalog_unavailable),
            )
        }
        if (capabilities.fresh && !canUsePermissionCatalog) {
            add(
                permissionCapability?.unavailableReason
                    ?: stringResource(R.string.new_session_permission_catalog_unavailable),
            )
        }
        if (modelCatalog.stale || permissionCatalog.stale) {
            add(stringResource(R.string.new_session_catalog_stale))
        }
    }
    return messages.distinct().joinToString(" · ").takeIf(String::isNotBlank)
}

private fun pathTitle(path: String, homeDirectory: String): String {
    val clean = path.trim().trimEnd('/').ifBlank { path }
    if (clean == "~") return homeDirectory
    return clean.substringAfterLast('/').ifBlank { clean }
}

private fun String.textFieldValueAtEnd(): TextFieldValue {
    return TextFieldValue(text = this, selection = TextRange(length))
}

@Composable
private fun String.localizedWorkspaceTitle(): String {
    return if (this == "Home directory") stringResource(R.string.new_session_home_directory) else this
}
