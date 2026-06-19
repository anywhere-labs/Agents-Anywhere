package com.agentsanywhere.app.ui.screens.sessions

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.feature.sessions.NewSessionAgent
import com.agentsanywhere.app.feature.sessions.NewSessionDirectory
import com.agentsanywhere.app.feature.sessions.NewSessionPathEntry
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.sessions.newSessionAgents
import com.agentsanywhere.app.feature.sessions.parentPath
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
import com.composables.icons.lucide.Bot
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.ChevronUp
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Monitor
import com.composables.icons.lucide.Pencil
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun NewSessionScreen(
    navigate: (AppDestination) -> Unit,
    sessionsState: SessionsState,
    onCreateSession: suspend (String, String, String, String) -> Result<AgentSession>,
    onListDirectory: suspend (String, String, String) -> Result<NewSessionDirectory>,
    onOpenSession: (AgentSession) -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val focusRequester = remember { FocusRequester() }
    val devices = remember(sessionsState.devices) {
        sessionsState.devices.filter { it.online && it.attachedRuntimes.isNotEmpty() }
    }
    var title by rememberSaveable { mutableStateOf("New Session") }
    var editingTitle by rememberSaveable { mutableStateOf(false) }
    var selectedDeviceId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedRuntime by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedWorkspacePath by rememberSaveable { mutableStateOf("~") }
    var homePath by rememberSaveable { mutableStateOf<String?>(null) }
    var choosePath by rememberSaveable { mutableStateOf(false) }
    var currentPath by rememberSaveable { mutableStateOf("~") }
    var pathEntries by remember { mutableStateOf<List<NewSessionPathEntry>>(emptyList()) }
    var pathLoading by remember { mutableStateOf(false) }
    var pathError by remember { mutableStateOf<String?>(null) }
    var createError by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf<NewSessionSheet?>(null) }
    var workspaceListExpanded by rememberSaveable { mutableStateOf(true) }

    BackHandler { navigate(AppDestination.Sessions) }

    LaunchedEffect(devices) {
        if (devices.none { it.id == selectedDeviceId }) {
            selectedDeviceId = devices.firstOrNull()?.id
        }
    }

    val selectedDevice = devices.firstOrNull { it.id == selectedDeviceId }
    val agents = remember(selectedDevice) { selectedDevice?.newSessionAgents().orEmpty() }

    LaunchedEffect(agents) {
        if (agents.none { it.runtime == selectedRuntime }) {
            selectedRuntime = agents.firstOrNull()?.runtime
        }
    }

    suspend fun loadDirectory(root: String, path: String = ".", select: Boolean = false) {
        val device = selectedDevice ?: return
        pathLoading = true
        pathError = null
        onListDirectory(device.id, root, path)
            .onSuccess { directory ->
                currentPath = directory.path
                pathEntries = directory.entries
                if (root == "~" && homePath == null) homePath = directory.path
                if (select) selectedWorkspacePath = directory.path
            }
            .onFailure { error ->
                pathEntries = emptyList()
                pathError = error.message ?: "Could not load this directory."
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
        loadDirectory(root = "~", select = true)
    }

    LaunchedEffect(editingTitle) {
        if (editingTitle) {
            focusRequester.requestFocus()
            keyboard?.show()
        }
    }

    val workspaces = remember(sessionsState.sessions, selectedDevice?.id, homePath) {
        workspaceOptionsFor(sessionsState.sessions, selectedDevice?.id, homePath)
    }
    val selectedWorkspace = workspaces.firstOrNull { it.path == selectedWorkspacePath }
    val selectedWorkspaceTitle = selectedWorkspace?.title ?: pathTitle(selectedWorkspacePath)
    val selectedWorkspaceDetail = selectedWorkspace?.detail ?: selectedWorkspacePath
    val selectedAgent = agents.firstOrNull { it.runtime == selectedRuntime }
    val canStart = selectedDevice != null && selectedAgent != null && selectedWorkspacePath.isNotBlank() && !creating

    fun submitTitle() {
        title = title.trim().ifBlank { "New Session" }
        editingTitle = false
        keyboard?.hide()
    }

    fun startSession() {
        val device = selectedDevice ?: return
        val agent = selectedAgent ?: return
        if (!canStart) return
        scope.launch {
            creating = true
            createError = null
            onCreateSession(title, device.id, agent.runtime, selectedWorkspacePath)
                .onSuccess { session ->
                    creating = false
                    onOpenSession(session)
                }
                .onFailure { error ->
                    creating = false
                    createError = error.message ?: "Could not create session."
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
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(58.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    RuntimeSelectPill(
                        label = "Device",
                        value = selectedDevice?.name ?: "No device",
                        icon = Lucide.Monitor,
                        darkMode = darkMode,
                        modifier = Modifier.weight(1f),
                        onClick = { sheet = NewSessionSheet.Device },
                    )
                    RuntimeSelectPill(
                        label = "Agent",
                        value = selectedAgent?.label ?: "No agent",
                        icon = Lucide.Bot,
                        darkMode = darkMode,
                        modifier = Modifier.weight(1f),
                        onClick = { sheet = NewSessionSheet.Agent },
                    )
                }

                if (choosePath) {
                    ChoosePathSection(
                        currentPath = currentPath,
                        entries = pathEntries,
                        loading = pathLoading,
                        error = pathError,
                        darkMode = darkMode,
                        modifier = Modifier.weight(1f),
                        onBack = { choosePath = false },
                        onParent = {
                            val parent = parentPath(currentPath)
                            if (parent.isNotBlank()) {
                                scope.launch { loadDirectory(root = parent) }
                            }
                        },
                        onUseCurrent = {
                            selectedWorkspacePath = currentPath
                            choosePath = false
                            workspaceListExpanded = false
                        },
                        onOpenEntry = { entry ->
                            scope.launch { loadDirectory(root = entry.path) }
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
                        onChoosePath = { choosePath = true },
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
                    .padding(start = 18.dp, end = 18.dp, bottom = 10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                val error = createError ?: if (devices.isEmpty()) {
                    "No online device with an attached agent."
                } else {
                    null
                }
                error?.let {
                    Text(
                        text = it,
                        color = colors.errorText,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        lineHeight = 17.sp,
                        modifier = Modifier.padding(horizontal = 4.dp),
                    )
                }
                StartChatButton(
                    label = if (creating) "Starting..." else "Start chat",
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
        NewSessionSheet.Agent -> AgentPickerSheet(
            agents = agents,
            selectedRuntime = selectedRuntime,
            darkMode = darkMode,
            onDismiss = { sheet = null },
            onSelect = {
                selectedRuntime = it.runtime
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
                    value = title,
                    onValueChange = onTitleChange,
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
            .noRippleClickable(onClick = onClick)
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
        DownGlyph(color = if (darkMode) Color(0xFF71717A) else Color(0xFFAAAAAA))
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
                text = "Workspace",
                color = LocalAAColors.current.ink,
                fontSize = 17.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 21.sp,
            )
            SmallPill(darkMode = darkMode, onClick = onChoosePath) {
                SearchGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555))
                Text(
                    text = "Choose path",
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
    entries: List<NewSessionPathEntry>,
    loading: Boolean,
    error: String?,
    darkMode: Boolean,
    modifier: Modifier,
    onBack: () -> Unit,
    onParent: () -> Unit,
    onUseCurrent: () -> Unit,
    onOpenEntry: (NewSessionPathEntry) -> Unit,
) {
    val parent = parentPath(currentPath)
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
                text = "Choose path",
                color = LocalAAColors.current.ink,
                fontSize = 17.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 21.sp,
            )
            SmallPill(darkMode = darkMode, onClick = onBack) {
                BackGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555))
                Text(
                    text = "Back",
                    color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.ExtraBold,
                    maxLines = 1,
                )
            }
        }
        CurrentDirectoryBar(
            currentPath = currentPath,
            darkMode = darkMode,
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
                        PathMessage("Loading directory...", darkMode)
                    }
                    error != null -> item {
                        PathMessage(error, darkMode)
                    }
                    else -> {
                        if (parent.isNotBlank()) {
                            item(key = "$currentPath/..") {
                                PathRow(name = "..", icon = Lucide.Folder, darkMode = darkMode, onClick = onParent)
                            }
                        }
                        if (entries.isEmpty()) {
                            item { PathMessage("This directory is empty.", darkMode) }
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
        CircleMiniButton(darkMode = darkMode, onClick = onParent) {
            BackGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777))
        }
        CircleMiniButton(
            darkMode = darkMode,
            selected = !darkMode,
            onClick = onUseCurrent,
        ) {
            CheckGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF16A34A))
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
            .noRippleClickable(onClick = onClick),
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
    PickerSheet(title = "Choose device", darkMode = darkMode, onDismiss = onDismiss) {
        if (devices.isEmpty()) {
            SheetEmptyText("No online devices with attached agents.", darkMode)
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
private fun AgentPickerSheet(
    agents: List<NewSessionAgent>,
    selectedRuntime: String?,
    darkMode: Boolean,
    onDismiss: () -> Unit,
    onSelect: (NewSessionAgent) -> Unit,
) {
    PickerSheet(title = "Choose agent", darkMode = darkMode, onDismiss = onDismiss) {
        if (agents.isEmpty()) {
            SheetEmptyText("No attached agents on this device.", darkMode)
        } else {
            LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                items(agents, key = { it.runtime }) { agent ->
                    SheetChoiceRow(
                        title = agent.label,
                        subtitle = agent.runtime,
                        selected = agent.runtime == selectedRuntime,
                        darkMode = darkMode,
                        icon = Lucide.Bot,
                        onClick = { onSelect(agent) },
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
            Text(
                text = subtitle,
                color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
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

private enum class NewSessionSheet {
    Device,
    Agent,
}

private fun pathTitle(path: String): String {
    val clean = path.trim().trimEnd('/').ifBlank { path }
    if (clean == "~") return "Home directory"
    return clean.substringAfterLast('/').ifBlank { clean }
}
