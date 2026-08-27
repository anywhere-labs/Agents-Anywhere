package com.agentsanywhere.app.ui.screens.devices

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceDetailState
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeList
import com.agentsanywhere.app.feature.devices.DeviceRuntimeManagementState
import com.agentsanywhere.app.feature.devices.DeviceRuntimeSetupResult
import com.agentsanywhere.app.feature.devices.DeviceRuntimeStatus
import com.agentsanywhere.app.feature.devices.deviceDetailState
import com.agentsanywhere.app.feature.devices.DeviceSetupCredential
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.sessions.SessionBatchUpdate
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.List as ListIcon
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Ellipsis
import com.composables.icons.lucide.RefreshCw
import com.composables.icons.lucide.Trash2
import kotlinx.coroutines.launch

private enum class DeviceSessionsFilter { Active, Archived, All }

@Composable
fun DeviceDetailScreen(
    navigate: (AppDestination) -> Unit,
    state: SessionsState,
    selectedDeviceId: String?,
    backDestination: AppDestination = AppDestination.Devices,
    onOpenSession: (AgentSession) -> Unit,
    onRenameDevice: suspend (String, String) -> Result<AgentDevice>,
    onDeleteDevice: suspend (String) -> Result<Unit>,
    onPrepareDeviceSetup: suspend (String) -> Result<DeviceSetupCredential>,
    onClaimDevicePairCode: suspend (DeviceSetupCredential, String) -> Result<AgentDevice>,
    onListDeviceRuntimes: suspend (String) -> Result<DeviceRuntimeList>,
    onDiscoverDeviceRuntimes: suspend (String) -> Result<DeviceRuntimeList>,
    onConfigureAndStartDeviceRuntime: suspend (String, String, Map<String, Any?>) -> DeviceRuntimeSetupResult,
    onSetDeviceRuntimeActive: suspend (String, String, Boolean) -> Result<DeviceRuntime>,
    onDeleteDeviceRuntimeConfig: suspend (String, String) -> Result<DeviceRuntime>,
    onBulkSetSessionsArchived: suspend (List<String>, Boolean) -> Result<SessionBatchUpdate>,
    onArchiveAllDeviceSessions: suspend (String, Boolean, String) -> Result<List<AgentSession>>,
) {
    val context = LocalContext.current
    val detail = remember(state, selectedDeviceId) { state.deviceDetailState(selectedDeviceId) }
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    var confirmAction by remember { mutableStateOf<DeviceConfirmAction?>(null) }
    var actionBusy by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var setupSheetOpen by remember { mutableStateOf(false) }
    var setupCredential by remember { mutableStateOf<DeviceSetupCredential?>(null) }
    var setupBusy by remember { mutableStateOf(false) }
    var setupError by remember { mutableStateOf<String?>(null) }
    var actionsSheetOpen by remember { mutableStateOf(false) }
    var configureRuntimeId by remember(selectedDeviceId) { mutableStateOf<String?>(null) }
    var runtimeState by remember(selectedDeviceId) {
        mutableStateOf(
            DeviceRuntimeManagementState(
                connectorId = detail.device?.id,
                loading = detail.device != null,
            ),
        )
    }
    var sessionsFilter by remember(selectedDeviceId) { mutableStateOf(DeviceSessionsFilter.Active) }
    var sessionSelectMode by remember(selectedDeviceId) { mutableStateOf(false) }
    var selectedSessionIds by remember(selectedDeviceId) { mutableStateOf(setOf<String>()) }
    var sessionBulkBusy by remember { mutableStateOf(false) }
    var sessionBulkMessage by remember { mutableStateOf<String?>(null) }
    var pendingArchiveAll by remember { mutableStateOf<DeviceArchiveAllRequest?>(null) }

    LaunchedEffect(detail.device?.id) {
        val connectorId = detail.device?.id ?: run {
            runtimeState = DeviceRuntimeManagementState()
            return@LaunchedEffect
        }
        runtimeState = DeviceRuntimeManagementState(connectorId = connectorId, loading = true)
        onListDeviceRuntimes(connectorId)
            .onSuccess { result -> runtimeState = runtimeState.replace(result) }
            .onFailure {
                runtimeState = runtimeState.copy(
                    loading = false,
                    errorMessage = context.getString(R.string.device_runtime_load_failed),
                )
            }
    }

    suspend fun refreshRuntimesAfterFailure(
        connectorId: String,
        message: String,
    ) {
        val refreshed = onListDeviceRuntimes(connectorId)
        if (runtimeState.connectorId != connectorId) return
        runtimeState = refreshed.fold(
            onSuccess = { runtimeState.replace(it).copy(errorMessage = message) },
            onFailure = {
                runtimeState.copy(
                    loading = false,
                    pendingRuntimeId = null,
                    errorMessage = message,
                )
            },
        )
    }

    fun reloadRuntimes() {
        val connectorId = detail.device?.id ?: return
        if (runtimeState.loading) return
        runtimeState = runtimeState.copy(loading = true, errorMessage = null)
        scope.launch {
            onListDeviceRuntimes(connectorId)
                .onSuccess { result -> runtimeState = runtimeState.replace(result) }
                .onFailure {
                    runtimeState = runtimeState.copy(
                        loading = false,
                        errorMessage = context.getString(R.string.device_runtime_load_failed),
                    )
                }
        }
    }

    fun discoverRuntimes() {
        val device = detail.device ?: return
        if (!device.online || runtimeState.loading || runtimeState.discovering || runtimeState.pendingRuntimeId != null) return
        val connectorId = device.id
        runtimeState = runtimeState.copy(discovering = true, errorMessage = null)
        scope.launch {
            onDiscoverDeviceRuntimes(connectorId)
                .onSuccess { result ->
                    if (runtimeState.connectorId == connectorId) {
                        runtimeState = runtimeState.replace(result)
                    }
                }
                .onFailure {
                    if (runtimeState.connectorId == connectorId) {
                        runtimeState = runtimeState.discoveryFailed(
                            context.getString(R.string.device_runtime_discover_failed),
                        )
                    }
                }
        }
    }

    fun setRuntimeActive(runtime: DeviceRuntime, active: Boolean) {
        if (runtimeState.pendingRuntimeId != null) return
        runtimeState = runtimeState.copy(pendingRuntimeId = runtime.id, errorMessage = null)
        scope.launch {
            onSetDeviceRuntimeActive(runtime.connectorId, runtime.id, active)
                .onSuccess { updated ->
                    runtimeState = runtimeState.replace(updated).copy(pendingRuntimeId = null)
                }
                .onFailure {
                    refreshRuntimesAfterFailure(
                        connectorId = runtime.connectorId,
                        message = context.getString(R.string.device_runtime_update_failed),
                    )
                }
        }
    }

    fun showToast(message: String) {
        scope.launch {
            snackbarHostState.showSnackbar(AAToastVisuals(message = message))
        }
    }

    fun startSetup(device: AgentDevice) {
        if (setupBusy) return
        setupSheetOpen = true
        setupCredential = null
        setupError = null
        setupBusy = true
        scope.launch {
            onPrepareDeviceSetup(device.id)
                .onSuccess { credential ->
                    setupCredential = credential
                }
                .onFailure { error ->
                    setupError = error.message ?: context.getString(R.string.device_detail_prepare_setup_failed)
                }
            setupBusy = false
        }
    }

    fun confirmCurrentAction() {
        val action = confirmAction ?: return
        val device = detail.device ?: return
        if (actionBusy) return
        actionBusy = true
        actionError = null
        scope.launch {
            when (action) {
                DeviceConfirmAction.DeleteDevice -> {
                    onDeleteDevice(device.id)
                        .onSuccess {
                            confirmAction = null
                            actionError = null
                        }
                        .onFailure { error ->
                            actionError = error.message ?: context.getString(R.string.device_detail_delete_failed)
                        }
                }
                is DeviceConfirmAction.RevokeDevice -> {
                    onPrepareDeviceSetup(device.id)
                        .onSuccess {
                            confirmAction = null
                            actionError = null
                        }
                        .onFailure { error ->
                            actionError = error.message ?: context.getString(R.string.device_detail_revoke_failed)
                        }
                }
                is DeviceConfirmAction.DeleteRuntimeConfig -> {
                    onDeleteDeviceRuntimeConfig(device.id, action.runtime.id)
                        .onSuccess { updated ->
                            runtimeState = runtimeState.replace(updated).copy(pendingRuntimeId = null)
                            configureRuntimeId = null
                            confirmAction = null
                            actionError = null
                        }
                        .onFailure {
                            val message = context.getString(R.string.device_runtime_delete_failed)
                            refreshRuntimesAfterFailure(device.id, message)
                            actionError = message
                        }
                }
                is DeviceConfirmAction.ArchiveAllSessions -> {
                    val request = pendingArchiveAll ?: return@launch
                    onArchiveAllDeviceSessions(device.id, request.archived, request.scope)
                        .onSuccess { sessions ->
                            confirmAction = null
                            pendingArchiveAll = null
                            actionError = null
                            sessionSelectMode = false
                            selectedSessionIds = emptySet()
                            sessionBulkMessage = null
                            showToast(
                                context.getString(
                                    if (request.archived) R.string.device_detail_archived_sessions_toast else R.string.device_detail_unarchived_sessions_toast,
                                    sessions.size,
                                ),
                            )
                        }
                        .onFailure { error ->
                            actionError = error.message ?: context.getString(R.string.device_detail_update_sessions_failed)
                        }
                }
            }
            actionBusy = false
        }
    }

    BackHandler {
        navigate(backDestination)
    }

    ScreenScaffold {
        detail.device?.let { device ->
            DeviceDetailHeader(
                device = device,
                onBack = { navigate(backDestination) },
                onMore = { actionsSheetOpen = true },
                modifier = Modifier.padding(horizontal = 24.dp),
            )
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        ) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
                contentPadding = PaddingValues(top = if (detail.device == null) 24.dp else 8.dp, bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                if (detail.device == null) {
                    item("missing") {
                        MissingDevice()
                    }
                } else {
                    if (actionError != null && confirmAction == null) {
                        item("action-error") {
                            Text(
                                text = actionError.orEmpty(),
                                color = LocalAAColors.current.errorText,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold,
                                lineHeight = 17.sp,
                            )
                        }
                    }
                    item("agents") {
                        AgentsSection(
                            state = runtimeState,
                            deviceOnline = detail.device.online,
                            onDiscover = ::discoverRuntimes,
                            onRetry = ::reloadRuntimes,
                            onConfigure = { runtime -> configureRuntimeId = runtime.id },
                            onSetActive = ::setRuntimeActive,
                            onDeleteConfig = { runtime ->
                                actionError = null
                                confirmAction = DeviceConfirmAction.DeleteRuntimeConfig(runtime)
                            },
                        )
                    }
                    item("sessions") {
                        SessionsSection(
                            detail = detail,
                            selectedFilter = sessionsFilter,
                            selectMode = sessionSelectMode,
                            selectedIds = selectedSessionIds,
                            busy = sessionBulkBusy,
                            message = sessionBulkMessage,
                            onFilterSelected = {
                                sessionsFilter = it
                                selectedSessionIds = emptySet()
                                sessionBulkMessage = null
                            },
                            onToggleSelectMode = {
                                sessionSelectMode = !sessionSelectMode
                                selectedSessionIds = emptySet()
                                sessionBulkMessage = null
                            },
                            onToggleSession = { sessionId ->
                                selectedSessionIds = if (sessionId in selectedSessionIds) {
                                    selectedSessionIds - sessionId
                                } else {
                                    selectedSessionIds + sessionId
                                }
                            },
                            onSelectAll = { visibleSessions ->
                                selectedSessionIds = if (visibleSessions.isNotEmpty() && visibleSessions.all { it.id in selectedSessionIds }) {
                                    emptySet()
                                } else {
                                    visibleSessions.map { it.id }.toSet()
                                }
                            },
                            onOpenSession = onOpenSession,
                            onBulkArchive = { visibleSessions ->
                                if (sessionBulkBusy || selectedSessionIds.isEmpty()) return@SessionsSection
                                val targetArchived = targetArchivedForSelection(sessionsFilter, visibleSessions, selectedSessionIds)
                                sessionBulkBusy = true
                                sessionBulkMessage = null
                                scope.launch {
                                    onBulkSetSessionsArchived(selectedSessionIds.toList(), targetArchived)
                                        .onSuccess { update ->
                                            sessionSelectMode = false
                                            selectedSessionIds = emptySet()
                                            sessionBulkMessage = update.notFound.takeIf { it.isNotEmpty() }?.let {
                                                context.getString(R.string.device_detail_sessions_not_found, it.size)
                                            }
                                            showToast(
                                                context.getString(
                                                    if (targetArchived) R.string.device_detail_archived_sessions_toast else R.string.device_detail_unarchived_sessions_toast,
                                                    update.sessions.size,
                                                ),
                                            )
                                        }
                                        .onFailure { error ->
                                            sessionBulkMessage = error.message ?: context.getString(R.string.device_detail_update_sessions_failed)
                                        }
                                    sessionBulkBusy = false
                                }
                            },
                            onArchiveAll = { visibleSessions ->
                                if (visibleSessions.isEmpty() || sessionBulkBusy) return@SessionsSection
                                val archived = sessionsFilter != DeviceSessionsFilter.Archived
                                val scope = sessionsFilter.archiveScope()
                                val scopeLabel = context.getString(sessionsFilter.archiveScopeLabelRes())
                                pendingArchiveAll = DeviceArchiveAllRequest(archived = archived, scope = scope)
                                actionError = null
                                confirmAction = DeviceConfirmAction.ArchiveAllSessions(
                                    deviceName = detail.device?.name.orEmpty(),
                                    archived = archived,
                                    scopeLabel = scopeLabel,
                                )
                            },
                        )
                    }
                }
            }
            AAToastHost(
                hostState = snackbarHostState,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 12.dp, start = 22.dp, end = 22.dp),
            )
        }
    }

    confirmAction?.let { action ->
        DeviceConfirmDialog(
            action = action,
            busy = actionBusy,
            errorMessage = actionError,
            onDismiss = {
                if (!actionBusy) {
                    confirmAction = null
                    actionError = null
                }
            },
            onConfirm = { confirmCurrentAction() },
        )
    }

    if (actionsSheetOpen && detail.device != null) {
        DeviceActionsSheet(
            device = detail.device,
            onDismiss = { actionsSheetOpen = false },
            onRenameDevice = onRenameDevice,
            onTokenAction = {
                actionsSheetOpen = false
                if (detail.device.online) {
                    actionError = null
                    confirmAction = DeviceConfirmAction.RevokeDevice(detail.device.name)
                } else {
                    startSetup(detail.device)
                }
            },
            onDeleteDevice = {
                actionsSheetOpen = false
                actionError = null
                confirmAction = DeviceConfirmAction.DeleteDevice
            },
        )
    }

    if (setupSheetOpen) {
        DeviceSetupSheet(
            device = detail.device ?: setupCredential?.device,
            credential = setupCredential,
            busy = setupBusy,
            errorMessage = setupError,
            onDismiss = {
                setupSheetOpen = false
                setupError = null
            },
            onClaimPairCode = onClaimDevicePairCode,
        )
    }

    val selectedConfigureRuntime = runtimeState.discoveredUnconfiguredRuntimes
        .firstOrNull { it.id == configureRuntimeId }
    if (selectedConfigureRuntime != null && detail.device != null) {
        DeviceRuntimeConfigureSheet(
            runtime = selectedConfigureRuntime,
            onDismiss = { configureRuntimeId = null },
            onConfigureAndStart = { config ->
                val connectorId = selectedConfigureRuntime.connectorId
                val runtimeId = selectedConfigureRuntime.id
                runtimeState = runtimeState.copy(pendingRuntimeId = runtimeId, errorMessage = null)
                val result = onConfigureAndStartDeviceRuntime(connectorId, runtimeId, config)
                if (runtimeState.connectorId == connectorId) {
                    runtimeState = when (result) {
                        is DeviceRuntimeSetupResult.Success -> runtimeState
                            .replace(result.runtime)
                            .copy(pendingRuntimeId = null)
                        is DeviceRuntimeSetupResult.StartFailed -> runtimeState
                            .replace(result.configuredRuntime)
                            .copy(pendingRuntimeId = null)
                        is DeviceRuntimeSetupResult.SaveFailed -> runtimeState.copy(pendingRuntimeId = null)
                    }
                    if (result is DeviceRuntimeSetupResult.StartFailed) {
                        showToast(context.getString(R.string.configure_agent_start_failed))
                    }
                }
                result
            },
        )
    }
}

private data class DeviceArchiveAllRequest(
    val archived: Boolean,
    val scope: String,
)

@Composable
private fun MissingDevice() {
    val colors = LocalAAColors.current

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 120.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.device_detail_not_found),
            color = colors.ink,
            fontSize = 24.sp,
            fontWeight = FontWeight.ExtraBold,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.device_detail_refresh_try_again),
            color = colors.muted,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun DeviceDetailHeader(
    device: AgentDevice,
    onBack: () -> Unit,
    onMore: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(64.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        RoundIconAction(
            icon = Lucide.ChevronLeft,
            contentDescription = stringResource(R.string.common_back),
            danger = false,
            onClick = onBack,
        )
        Row(
            modifier = Modifier.weight(1f),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Text(
                text = device.name,
                modifier = Modifier.weight(1f, fill = false),
                color = colors.ink,
                fontSize = 25.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 29.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            DeviceStatusTag(online = device.online, darkMode = darkMode)
        }
        RoundIconAction(
            icon = Lucide.Ellipsis,
            contentDescription = stringResource(R.string.device_detail_device_actions),
            danger = false,
            onClick = onMore,
        )
    }
}

@Composable
private fun DeviceStatusTag(online: Boolean, darkMode: Boolean) {
    val background = when {
        online && darkMode -> Color(0xFF102419)
        online -> Color(0xFFEAF7EF)
        darkMode -> Color(0xFF27272A)
        else -> Color(0xFFF1F0ED)
    }
    val content = when {
        online && darkMode -> Color(0xFF7DD3A8)
        online -> Color(0xFF2F8F5B)
        darkMode -> Color(0xFFA1A1AA)
        else -> Color(0xFF777777)
    }

    Box(
        modifier = Modifier
            .height(22.dp)
            .clip(CircleShape)
            .background(background)
            .padding(horizontal = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (online) stringResource(R.string.devices_online) else stringResource(R.string.devices_offline),
            color = content,
            fontSize = 11.sp,
            lineHeight = 11.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

@Composable
internal fun AgentsSection(
    state: DeviceRuntimeManagementState,
    deviceOnline: Boolean,
    onDiscover: () -> Unit,
    onRetry: () -> Unit,
    onConfigure: (DeviceRuntime) -> Unit,
    onSetActive: (DeviceRuntime, Boolean) -> Unit,
    onDeleteConfig: (DeviceRuntime) -> Unit,
) {
    SectionBlock(
        title = stringResource(R.string.device_detail_agents_section),
        action = {
            SmallActionButton(
                icon = Lucide.RefreshCw,
                label = if (state.discovering) {
                    stringResource(R.string.device_runtime_discovering_action)
                } else {
                    stringResource(R.string.device_runtime_discover_action)
                },
                danger = false,
                enabled = deviceOnline && !state.loading && !state.discovering && state.pendingRuntimeId == null,
                loading = state.discovering,
                contentDescription = stringResource(
                    if (state.discovering) R.string.device_runtime_discovering_description
                    else R.string.device_runtime_discover_description,
                ),
                onClick = onDiscover,
            )
        },
    ) {
        when {
            state.loading && state.runtimes.isEmpty() -> {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    EmptyText(stringResource(R.string.device_runtime_loading))
                }
            }
            else -> {
                state.errorMessage?.let { message ->
                    Text(
                        text = message,
                        color = LocalAAColors.current.errorText,
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        lineHeight = 17.sp,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                }
                RuntimeSubsectionTitle(stringResource(R.string.device_runtime_configured_section))
                if (state.configuredRuntimes.isEmpty()) {
                    EmptyText(stringResource(R.string.device_runtime_no_configured))
                } else {
                    state.configuredRuntimes.forEachIndexed { index, runtime ->
                        ConfiguredAgentRow(
                            runtime = runtime,
                            pending = state.pendingRuntimeId == runtime.id,
                            operationsEnabled = state.pendingRuntimeId == null && !state.discovering,
                            onSetActive = { active -> onSetActive(runtime, active) },
                            onDeleteConfig = { onDeleteConfig(runtime) },
                        )
                        if (index != state.configuredRuntimes.lastIndex) DetailDivider()
                    }
                }

                Spacer(Modifier.height(12.dp))
                DetailDivider()
                Spacer(Modifier.height(12.dp))

                RuntimeSubsectionTitle(stringResource(R.string.device_runtime_discovered_section))
                if (state.discoveredUnconfiguredRuntimes.isEmpty()) {
                    EmptyText(stringResource(R.string.device_runtime_no_discovered))
                } else {
                    state.discoveredUnconfiguredRuntimes.forEachIndexed { index, runtime ->
                        DiscoveredAgentRow(
                            runtime = runtime,
                            pending = state.pendingRuntimeId == runtime.id,
                            enabled = deviceOnline && state.pendingRuntimeId == null && !state.discovering,
                            onConfigure = { onConfigure(runtime) },
                        )
                        if (index != state.discoveredUnconfiguredRuntimes.lastIndex) DetailDivider()
                    }
                }

                if (state.errorMessage != null) {
                    SmallActionButton(
                        icon = Lucide.RefreshCw,
                        label = stringResource(R.string.common_retry),
                        danger = false,
                        enabled = !state.loading && !state.discovering && (!state.errorFromDiscovery || deviceOnline),
                        loading = false,
                        contentDescription = stringResource(R.string.common_retry),
                        onClick = if (state.errorFromDiscovery) onDiscover else onRetry,
                    )
                }
            }
        }
    }
}

@Composable
private fun RuntimeSubsectionTitle(title: String) {
    Text(
        text = title,
        color = LocalAAColors.current.muted,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(bottom = 4.dp),
    )
}

@Composable
private fun ConfiguredAgentRow(
    runtime: DeviceRuntime,
    pending: Boolean,
    operationsEnabled: Boolean,
    onSetActive: (Boolean) -> Unit,
    onDeleteConfig: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .padding(vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = runtime.displayName,
                color = LocalAAColors.current.ink,
                fontSize = 16.5.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = runtimeStatusLabel(runtime),
                color = if (runtime.status == DeviceRuntimeStatus.Error) {
                    LocalAAColors.current.errorText
                } else {
                    LocalAAColors.current.muted
                },
                fontSize = 11.5.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (pending) {
            CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
        } else {
            Switch(
                checked = runtime.active,
                onCheckedChange = onSetActive,
                enabled = operationsEnabled && (runtime.active || runtime.canActivate),
            )
        }
        AgentIconButton(
            icon = Lucide.Trash2,
            contentDescription = stringResource(R.string.device_detail_remove_agent),
            danger = true,
            enabled = operationsEnabled && runtime.configured,
            onClick = onDeleteConfig,
        )
    }
}

@Composable
private fun DiscoveredAgentRow(
    runtime: DeviceRuntime,
    pending: Boolean,
    enabled: Boolean,
    onConfigure: () -> Unit,
) {
    val colors = LocalAAColors.current
    val status = if (runtime.discoveryAvailable) {
        stringResource(R.string.device_runtime_discovered)
    } else {
        stringResource(R.string.device_runtime_executable_not_found)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(64.dp)
            .padding(vertical = 5.dp)
            .semantics { stateDescription = status },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(if (runtime.discoveryAvailable) colors.muted.copy(alpha = 0.55f) else Color(0xFFF59E0B)),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = runtime.displayName,
                color = colors.ink,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = status,
                color = colors.muted,
                fontSize = 11.5.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
            )
        }
        if (pending) {
            CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
        } else {
            ConfigureRuntimeButton(
                label = stringResource(R.string.configure_agent_action),
                contentDescription = stringResource(R.string.configure_agent_description, runtime.displayName),
                enabled = enabled,
                onClick = onConfigure,
            )
        }
    }
}

@Composable
private fun ConfigureRuntimeButton(
    label: String,
    contentDescription: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    Box(
        modifier = Modifier
            .height(34.dp)
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, colors.border, RoundedCornerShape(8.dp))
            .semantics { this.contentDescription = contentDescription }
            .noRippleClickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = colors.ink.copy(alpha = if (enabled) 1f else 0.4f),
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun runtimeStatusLabel(runtime: DeviceRuntime): String {
    return when {
        !runtime.present -> stringResource(R.string.device_runtime_not_present)
        !runtime.configured -> stringResource(R.string.device_runtime_not_configured)
        runtime.status == DeviceRuntimeStatus.Stopped -> stringResource(R.string.device_runtime_stopped)
        runtime.status == DeviceRuntimeStatus.Discovering -> stringResource(R.string.device_runtime_discovering)
        runtime.status == DeviceRuntimeStatus.Available -> stringResource(R.string.device_runtime_available)
        runtime.status == DeviceRuntimeStatus.Unavailable -> stringResource(R.string.device_runtime_unavailable)
        runtime.status == DeviceRuntimeStatus.Validating -> stringResource(R.string.device_runtime_validating)
        runtime.status == DeviceRuntimeStatus.Starting -> stringResource(R.string.device_runtime_starting)
        runtime.status == DeviceRuntimeStatus.Running -> stringResource(R.string.device_runtime_running)
        runtime.status == DeviceRuntimeStatus.Stopping -> stringResource(R.string.device_runtime_stopping)
        runtime.status == DeviceRuntimeStatus.Error -> stringResource(R.string.device_runtime_error)
        else -> stringResource(R.string.device_runtime_unknown)
    }
}

@Composable
private fun SessionsSection(
    detail: DeviceDetailState,
    selectedFilter: DeviceSessionsFilter,
    selectMode: Boolean,
    selectedIds: Set<String>,
    busy: Boolean,
    message: String?,
    onFilterSelected: (DeviceSessionsFilter) -> Unit,
    onToggleSelectMode: () -> Unit,
    onToggleSession: (String) -> Unit,
    onSelectAll: (List<AgentSession>) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    onBulkArchive: (List<AgentSession>) -> Unit,
    onArchiveAll: (List<AgentSession>) -> Unit,
) {
    val sessions = remember(detail.activeSessions, detail.archivedSessions, selectedFilter) {
        when (selectedFilter) {
            DeviceSessionsFilter.Active -> detail.activeSessions
            DeviceSessionsFilter.Archived -> detail.archivedSessions
            DeviceSessionsFilter.All -> (detail.activeSessions + detail.archivedSessions).sortedByDescending { it.sortKey }
        }
    }
    val selectedCount = sessions.count { it.id in selectedIds }
    val allSelected = sessions.isNotEmpty() && sessions.all { it.id in selectedIds }

    SectionBlock(
        title = stringResource(R.string.device_detail_sessions_section),
        action = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MiniTextAction(
                    label = if (selectMode) stringResource(R.string.common_cancel) else stringResource(R.string.common_select),
                    enabled = sessions.isNotEmpty() && !busy,
                    onClick = onToggleSelectMode,
                )
                if (!selectMode) {
                    MiniTextAction(
                        label = if (selectedFilter == DeviceSessionsFilter.Archived) {
                            stringResource(R.string.device_detail_unarchive_all)
                        } else {
                            stringResource(R.string.device_detail_archive_all)
                        },
                        enabled = sessions.isNotEmpty() && !busy,
                        onClick = { onArchiveAll(sessions) },
                    )
                }
            }
        },
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(44.dp)
                .padding(bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            DeviceSessionFilterTag(
                label = stringResource(R.string.home_tab_active),
                selected = selectedFilter == DeviceSessionsFilter.Active,
                onClick = { onFilterSelected(DeviceSessionsFilter.Active) },
            )
            DeviceSessionFilterTag(
                label = stringResource(R.string.home_tab_archived),
                selected = selectedFilter == DeviceSessionsFilter.Archived,
                onClick = { onFilterSelected(DeviceSessionsFilter.Archived) },
            )
            DeviceSessionFilterTag(
                label = stringResource(R.string.common_all),
                selected = selectedFilter == DeviceSessionsFilter.All,
                onClick = { onFilterSelected(DeviceSessionsFilter.All) },
            )
        }
        if (selectMode) {
            SessionBulkBar(
                allSelected = allSelected,
                selectedCount = selectedCount,
                actionLabel = bulkActionLabel(selectedFilter, sessions, selectedIds),
                busy = busy,
                enabled = selectedCount > 0,
                onSelectAll = { onSelectAll(sessions) },
                onAction = { onBulkArchive(sessions) },
            )
        }
        message?.let {
            Text(
                text = it,
                color = LocalAAColors.current.muted,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 16.sp,
                modifier = Modifier.padding(top = 2.dp, bottom = 2.dp),
            )
        }
        if (sessions.isEmpty()) {
            EmptyText(
                when (selectedFilter) {
                    DeviceSessionsFilter.Active -> stringResource(R.string.device_detail_no_active_sessions)
                    DeviceSessionsFilter.Archived -> stringResource(R.string.device_detail_no_archived_sessions)
                    DeviceSessionsFilter.All -> stringResource(R.string.device_detail_no_sessions)
                },
            )
        } else {
            sessions.forEachIndexed { index, session ->
                SessionDetailRow(
                    session = session,
                    selectMode = selectMode,
                    selected = session.id in selectedIds,
                    onClick = {
                        if (selectMode) onToggleSession(session.id) else onOpenSession(session)
                    },
                )
                if (index != sessions.lastIndex) SessionDivider()
            }
        }
    }
}

@Composable
private fun SessionBulkBar(
    allSelected: Boolean,
    selectedCount: Int,
    actionLabel: String,
    busy: Boolean,
    enabled: Boolean,
    onSelectAll: () -> Unit,
    onAction: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(44.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (darkMode) Color(0xFF18181B) else Color(0xFFF6F6F4))
            .border(1.dp, colors.border, RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            modifier = Modifier.noRippleClickable(enabled = !busy, onClick = onSelectAll),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            SelectionCircle(selected = allSelected)
            Text(stringResource(R.string.common_all), color = colors.muted, fontSize = 12.5.sp, fontWeight = FontWeight.Bold)
        }
        Text(
            text = stringResource(R.string.device_detail_selected_count, selectedCount),
            modifier = Modifier.weight(1f),
            color = colors.faint,
            fontSize = 11.5.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
        MiniTextAction(
            label = if (busy) stringResource(R.string.common_working) else actionLabel,
            enabled = enabled && !busy,
            primary = true,
            onClick = onAction,
        )
    }
}

@Composable
private fun SessionDetailRow(
    session: AgentSession,
    selectMode: Boolean,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .noRippleClickable(onClick = onClick)
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (selectMode) {
            SelectionCircle(selected = selected)
        }
        Icon(
            imageVector = Lucide.ListIcon,
            contentDescription = null,
            tint = colors.faint,
            modifier = Modifier.size(14.dp),
        )
        Text(
            text = session.title,
            modifier = Modifier.weight(1f),
            color = colors.inkSoft,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 20.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = session.updatedAtLabel.ifBlank { stringResource(R.string.common_now) },
            color = colors.faint,
            fontSize = 10.8.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun SelectionCircle(selected: Boolean) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val fill = when {
        selected && darkMode -> Color(0xFFE4E4E7)
        selected -> Color(0xFF181816)
        else -> Color.Transparent
    }
    val border = if (selected) fill else colors.border

    Box(
        modifier = Modifier
            .size(20.dp)
            .clip(CircleShape)
            .background(fill)
            .border(1.dp, border, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) {
            Icon(
                imageVector = Lucide.Check,
                contentDescription = null,
                tint = if (darkMode) Color(0xFF181816) else Color.White,
                modifier = Modifier.size(13.dp),
            )
        }
    }
}

@Composable
private fun SessionDivider() {
    val colors = LocalAAColors.current

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(if (colors.canvas == Color(0xFF09090B)) Color(0xFF27272A) else Color(0xFFE9E8E5)),
    )
}

@Composable
private fun SectionBlock(
    title: String,
    action: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(34.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            SectionTitle(title)
            action?.invoke()
        }
        content()
    }
}

@Composable
private fun SectionTitle(title: String) {
    Text(
        text = title,
        color = LocalAAColors.current.faint,
        fontSize = 14.sp,
        fontWeight = FontWeight.Bold,
        maxLines = 1,
    )
}

@Composable
private fun EmptyText(text: String) {
    Text(
        text = text,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 14.dp),
        color = LocalAAColors.current.muted,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        lineHeight = 17.sp,
    )
}

@Composable
private fun DetailDivider() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(LocalAAColors.current.border),
    )
}

@Composable
private fun DeviceSessionFilterTag(label: String, selected: Boolean, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
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
            .noRippleClickable(onClick = onClick)
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
private fun MiniTextAction(
    label: String,
    enabled: Boolean,
    primary: Boolean = false,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val surface = when {
        primary && darkMode -> Color(0xFFE4E4E7)
        primary -> Color(0xFF181816)
        darkMode -> Color(0xFF18181B)
        else -> Color(0xFFECECE9)
    }
    val content = when {
        primary && darkMode -> Color(0xFF181816)
        primary -> Color.White
        else -> colors.ink
    }

    Box(
        modifier = Modifier
            .height(30.dp)
            .clip(CircleShape)
            .background(surface.copy(alpha = if (enabled) 1f else 0.45f))
            .noRippleClickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = content.copy(alpha = if (enabled) 1f else 0.6f),
            fontSize = 12.5.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

private fun targetArchivedForSelection(
    filter: DeviceSessionsFilter,
    sessions: List<AgentSession>,
    selectedIds: Set<String>,
): Boolean {
    if (filter == DeviceSessionsFilter.Archived) return false
    if (filter == DeviceSessionsFilter.Active) return true
    return sessions.any { it.id in selectedIds && !it.archived }
}

@Composable
private fun bulkActionLabel(
    filter: DeviceSessionsFilter,
    sessions: List<AgentSession>,
    selectedIds: Set<String>,
): String {
    return if (targetArchivedForSelection(filter, sessions, selectedIds)) {
        stringResource(R.string.device_detail_archive_selected)
    } else {
        stringResource(R.string.device_detail_unarchive_selected)
    }
}

private fun DeviceSessionsFilter.archiveScope(): String {
    return when (this) {
        DeviceSessionsFilter.Active -> "active"
        DeviceSessionsFilter.Archived -> "archived"
        DeviceSessionsFilter.All -> "all"
    }
}

private fun DeviceSessionsFilter.archiveScopeLabelRes(): Int {
    return when (this) {
        DeviceSessionsFilter.Active -> R.string.device_detail_all_active_sessions
        DeviceSessionsFilter.Archived -> R.string.device_detail_all_archived_sessions
        DeviceSessionsFilter.All -> R.string.device_detail_all_sessions
    }
}

@Composable
private fun SmallActionButton(
    icon: ImageVector,
    label: String,
    danger: Boolean,
    enabled: Boolean = true,
    loading: Boolean = false,
    contentDescription: String = label,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val surface = when {
        danger && darkMode -> Color(0xFF2A1418)
        danger -> Color(0xFFFFF3F3)
        darkMode -> Color(0xFF18181B)
        else -> Color(0xFFF4F4F2)
    }
    val tint = when {
        danger && darkMode -> Color(0xFFF87171)
        danger -> Color(0xFFB94848)
        else -> colors.ink
    }

    Row(
        modifier = Modifier
            .height(34.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(surface)
            .semantics { this.contentDescription = contentDescription }
            .noRippleClickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(
                color = tint,
                strokeWidth = 2.dp,
                modifier = Modifier.size(15.dp),
            )
        } else {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = tint.copy(alpha = if (enabled) 1f else 0.4f),
                modifier = Modifier.size(15.dp),
            )
        }
        Spacer(Modifier.width(5.dp))
        Text(
            text = label,
            color = tint.copy(alpha = if (enabled) 1f else 0.4f),
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

@Composable
private fun AgentIconButton(
    icon: ImageVector,
    contentDescription: String,
    danger: Boolean,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val surface = when {
        danger && darkMode -> Color(0xFF2A1418)
        danger -> Color(0xFFFFF3F3)
        darkMode -> Color(0xFF18181B)
        else -> Color(0xFFF4F4F2)
    }
    val tint = when {
        danger && darkMode -> Color(0xFFF87171)
        danger -> Color(0xFFB94848)
        else -> colors.ink
    }

    Box(
        modifier = Modifier
            .size(38.dp)
            .clip(CircleShape)
            .background(surface)
            .noRippleClickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = tint.copy(alpha = if (enabled) 1f else 0.35f),
            modifier = Modifier.size(17.dp),
        )
    }
}
