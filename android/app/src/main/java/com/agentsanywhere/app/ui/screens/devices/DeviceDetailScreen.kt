package com.agentsanywhere.app.ui.screens.devices

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.feature.devices.DeviceDetailAgent
import com.agentsanywhere.app.feature.devices.DeviceDetailState
import com.agentsanywhere.app.feature.devices.DeviceDetailWorkspace
import com.agentsanywhere.app.feature.devices.deviceDetailState
import com.agentsanywhere.app.feature.sessions.DeviceSetupCredential
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.KeyRound
import com.composables.icons.lucide.List as ListIcon
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Settings
import com.composables.icons.lucide.Trash2
import kotlinx.coroutines.launch

@Composable
fun DeviceDetailScreen(
    navigate: (AppDestination) -> Unit,
    state: SessionsState,
    selectedDeviceId: String?,
    onRenameDevice: suspend (String, String) -> Result<AgentDevice>,
    onDeleteDevice: suspend (String) -> Result<Unit>,
    onPrepareDeviceSetup: suspend (String) -> Result<DeviceSetupCredential>,
    onClaimDevicePairCode: suspend (DeviceSetupCredential, String) -> Result<AgentDevice>,
    onDeleteDeviceAgent: suspend (String, String) -> Result<List<String>>,
) {
    val detail = remember(state, selectedDeviceId) { state.deviceDetailState(selectedDeviceId) }
    val scope = rememberCoroutineScope()
    val focusRequester = remember { FocusRequester() }
    var editingName by remember(detail.device?.id) { mutableStateOf(false) }
    var draftName by remember(detail.device?.id) { mutableStateOf(detail.device?.name.orEmpty()) }
    var renameBusy by remember { mutableStateOf(false) }
    var confirmAction by remember { mutableStateOf<DeviceConfirmAction?>(null) }
    var actionBusy by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var setupSheetOpen by remember { mutableStateOf(false) }
    var setupCredential by remember { mutableStateOf<DeviceSetupCredential?>(null) }
    var setupBusy by remember { mutableStateOf(false) }
    var setupError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(editingName) {
        if (editingName) focusRequester.requestFocus()
    }

    LaunchedEffect(detail.device?.name) {
        if (!editingName) draftName = detail.device?.name.orEmpty()
    }

    fun submitRename() {
        val device = detail.device ?: return
        val next = draftName.trim()
        if (renameBusy) return
        if (next.isBlank() || next == device.name) {
            draftName = device.name
            editingName = false
            return
        }
        renameBusy = true
        actionError = null
        scope.launch {
            onRenameDevice(device.id, next)
                .onSuccess {
                    editingName = false
                }
                .onFailure { error ->
                    actionError = error.message ?: "Could not rename device."
                    draftName = device.name
                }
            renameBusy = false
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
                    setupError = error.message ?: "Could not prepare device setup."
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
                            actionError = error.message ?: "Could not delete device."
                        }
                }
                is DeviceConfirmAction.RevokeDevice -> {
                    onPrepareDeviceSetup(device.id)
                        .onSuccess {
                            confirmAction = null
                            actionError = null
                        }
                        .onFailure { error ->
                            actionError = error.message ?: "Could not revoke device token."
                        }
                }
                is DeviceConfirmAction.DeleteAgent -> {
                    onDeleteDeviceAgent(device.id, action.agent.runtime)
                        .onSuccess {
                            confirmAction = null
                            actionError = null
                        }
                        .onFailure { error ->
                            actionError = error.message ?: "Could not remove agent."
                        }
                }
            }
            actionBusy = false
        }
    }

    BackHandler {
        navigate(AppDestination.Devices)
    }

    ScreenScaffold {
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(horizontal = 24.dp),
            contentPadding = PaddingValues(top = 24.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            if (detail.device == null) {
                item("missing") {
                    MissingDevice()
                }
            } else {
                item("header") {
                    DeviceDetailHeader(
                        device = detail.device,
                        editing = editingName,
                        draftName = draftName,
                        renameBusy = renameBusy,
                        focusRequester = focusRequester,
                        onDraftNameChange = { draftName = it },
                        onSubmitRename = { submitRename() },
                        onEditName = {
                            if (editingName) submitRename() else editingName = true
                        },
                        onDeleteDevice = {
                            actionError = null
                            confirmAction = DeviceConfirmAction.DeleteDevice
                        },
                        onTokenAction = {
                            if (detail.device.online) {
                                actionError = null
                                confirmAction = DeviceConfirmAction.RevokeDevice(detail.device.name)
                            } else {
                                startSetup(detail.device)
                            }
                        },
                    )
                }
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
                        detail = detail,
                        onDeleteAgent = { agent ->
                            actionError = null
                            confirmAction = DeviceConfirmAction.DeleteAgent(agent)
                        },
                    )
                }
                item("workspaces") {
                    WorkspacesSection(workspaces = detail.workspaces)
                }
                item("sessions") {
                    SessionsSection(sessions = detail.activeSessions)
                }
            }
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
}

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
            text = "Device not found",
            color = colors.ink,
            fontSize = 24.sp,
            fontWeight = FontWeight.ExtraBold,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = "Refresh devices and try again.",
            color = colors.muted,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun DeviceDetailHeader(
    device: AgentDevice,
    editing: Boolean,
    draftName: String,
    renameBusy: Boolean,
    focusRequester: FocusRequester,
    onDraftNameChange: (String) -> Unit,
    onSubmitRename: () -> Unit,
    onEditName: () -> Unit,
    onDeleteDevice: () -> Unit,
    onTokenAction: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(64.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (editing) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
            ) {
                BasicTextField(
                    value = draftName,
                    onValueChange = onDraftNameChange,
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focusRequester),
                    textStyle = TextStyle(
                        color = colors.ink,
                        fontSize = 24.sp,
                        fontWeight = FontWeight.ExtraBold,
                        fontFamily = FontFamily.SansSerif,
                    ),
                    cursorBrush = SolidColor(colors.ink),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { onSubmitRename() }),
                )
                Box(
                    modifier = Modifier
                        .fillMaxWidth(0.72f)
                        .height(1.5.dp)
                        .clip(CircleShape)
                        .background(if (darkMode) Color(0xFF71717A) else Color(0xFFBDBDBD)),
                )
            }
        } else {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(5.dp, Alignment.CenterVertically),
            ) {
                DeviceStatusTag(online = device.online, darkMode = darkMode)
                Text(
                    text = device.name,
                    color = colors.ink,
                    fontSize = 25.sp,
                    fontWeight = FontWeight.ExtraBold,
                    lineHeight = 29.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        RoundIconAction(
            icon = if (editing) Lucide.Check else Lucide.Pencil,
            contentDescription = "Rename device",
            danger = false,
            enabled = !renameBusy,
            onClick = onEditName,
        )
        TextIconAction(
            icon = Lucide.KeyRound,
            label = if (device.online) "Revoke" else "Setup",
            darkMode = darkMode,
            onClick = onTokenAction,
        )
        RoundIconAction(
            icon = Lucide.Trash2,
            contentDescription = "Delete device",
            danger = true,
            onClick = onDeleteDevice,
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
            .height(20.dp)
            .clip(CircleShape)
            .background(background)
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (online) "Online" else "Offline",
            color = content,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

@Composable
private fun AgentsSection(
    detail: DeviceDetailState,
    onDeleteAgent: (DeviceDetailAgent) -> Unit,
) {
    SectionBlock(
        title = "AGENTS",
        action = {
            SmallActionButton(
                icon = Lucide.Plus,
                label = "Add agent",
                danger = false,
                onClick = {},
            )
        },
    ) {
        if (detail.agents.isEmpty()) {
            EmptyText("No agents attached to this device.")
        } else {
            detail.agents.forEachIndexed { index, agent ->
                AgentRow(
                    agent = agent,
                    onDelete = { onDeleteAgent(agent) },
                )
                if (index != detail.agents.lastIndex) DetailDivider()
            }
        }
    }
}

@Composable
private fun AgentRow(
    agent: DeviceDetailAgent,
    onDelete: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .padding(vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = agent.label,
            modifier = Modifier.weight(1f),
            color = LocalAAColors.current.ink,
            fontSize = 16.5.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        AgentIconButton(
            icon = Lucide.Settings,
            contentDescription = "Agent settings",
            danger = false,
            onClick = {},
        )
        AgentIconButton(
            icon = Lucide.Trash2,
            contentDescription = "Remove agent",
            danger = true,
            onClick = onDelete,
        )
    }
}

@Composable
private fun WorkspacesSection(workspaces: kotlin.collections.List<DeviceDetailWorkspace>) {
    val visible = workspaces.take(3)

    SectionBlock(title = "WORKSPACES") {
        if (visible.isEmpty()) {
            EmptyText("No workspaces yet.")
        } else {
            visible.forEachIndexed { index, workspace ->
                WorkspaceDetailRow(workspace = workspace)
                if (index != visible.lastIndex) DetailDivider()
            }
            if (workspaces.size > visible.size) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(42.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .noRippleClickable(onClick = {}),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Show all workspaces",
                        color = LocalAAColors.current.ink,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.width(5.dp))
                    Icon(
                        imageVector = Lucide.ChevronRight,
                        contentDescription = null,
                        tint = LocalAAColors.current.ink,
                        modifier = Modifier.size(17.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun WorkspaceDetailRow(workspace: DeviceDetailWorkspace) {
    val colors = LocalAAColors.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(68.dp)
            .clip(RoundedCornerShape(6.dp))
            .noRippleClickable(onClick = {})
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
        ) {
            Text(
                text = workspace.title,
                color = colors.ink,
                fontSize = 16.8.sp,
                fontWeight = FontWeight.Bold,
                lineHeight = 20.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = workspace.detail,
                color = colors.muted,
                fontSize = 12.8.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 16.sp,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
        }
        Text(
            text = "${workspace.sessionCount}",
            color = colors.faint,
            fontSize = 13.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
        )
        Icon(
            imageVector = Lucide.ChevronRight,
            contentDescription = null,
            tint = colors.faint,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun SessionsSection(sessions: kotlin.collections.List<AgentSession>) {
    SectionBlock(title = "SESSIONS") {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(44.dp)
                .padding(start = 4.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            FilterTag(label = "Active", selected = true)
            FilterTag(label = "Archived", selected = false)
            FilterTag(label = "All", selected = false)
        }
        if (sessions.isEmpty()) {
            EmptyText("No active sessions on this device.")
        } else {
            sessions.forEach { session ->
                SessionDetailRow(session = session)
            }
        }
    }
}

@Composable
private fun SessionDetailRow(session: AgentSession) {
    val colors = LocalAAColors.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(50.dp)
            .clip(RoundedCornerShape(6.dp))
            .noRippleClickable(onClick = {})
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            imageVector = Lucide.ListIcon,
            contentDescription = null,
            tint = colors.faint,
            modifier = Modifier.size(17.dp),
        )
        Text(
            text = session.title,
            modifier = Modifier.weight(1f),
            color = colors.ink,
            fontSize = 16.5.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 20.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = session.updatedAtLabel.ifBlank { "now" },
            color = colors.muted,
            fontSize = 13.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
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
private fun FilterTag(label: String, selected: Boolean) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val shape = CircleShape
    val surface = when {
        selected && darkMode -> Color(0xFF18181B)
        selected -> Color.White
        else -> Color.Transparent
    }
    val border = if (selected) colors.border else Color.Transparent

    Box(
        modifier = Modifier
            .height(28.dp)
            .widthIn(min = 72.dp)
            .clip(shape)
            .background(surface)
            .border(1.dp, border, shape)
            .noRippleClickable(onClick = {})
            .padding(horizontal = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = if (selected) colors.ink else colors.faint,
            fontSize = 15.5.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.SemiBold,
        )
    }
}

@Composable
private fun RoundIconAction(
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
        danger -> Color(0xFFFFF5F5)
        darkMode -> Color(0xFF18181B)
        else -> Color.White
    }
    val border = when {
        danger && darkMode -> Color(0xFF4A1C24)
        danger -> Color(0xFFF0D7D7)
        else -> colors.border
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
            .border(1.dp, border, CircleShape)
            .noRippleClickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = tint.copy(alpha = if (enabled) 1f else 0.45f),
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun TextIconAction(
    icon: ImageVector,
    label: String,
    darkMode: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .height(38.dp)
            .widthIn(min = 92.dp)
            .clip(CircleShape)
            .background(if (darkMode) Color(0xFF18181B) else Color(0xFFF4F4F2))
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (darkMode) Color(0xFFD4D4D8) else Color(0xFF3A3A3C),
            modifier = Modifier.size(15.dp),
        )
        Spacer(Modifier.width(4.dp))
        Text(
            text = label,
            color = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF2C2C2E),
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

@Composable
private fun SmallActionButton(
    icon: ImageVector,
    label: String,
    danger: Boolean,
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
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(15.dp),
        )
        Spacer(Modifier.width(5.dp))
        Text(
            text = label,
            color = tint,
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
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = tint,
            modifier = Modifier.size(17.dp),
        )
    }
}
