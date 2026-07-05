package com.agentsanywhere.app.ui.screens.sessiondetail

import android.graphics.Typeface
import android.util.TypedValue
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Popup
import androidx.compose.ui.zIndex
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.files.FileEntry
import com.agentsanywhere.app.feature.files.FilesController
import com.agentsanywhere.app.feature.files.FilesDirectory
import com.agentsanywhere.app.feature.files.TextFile
import com.agentsanywhere.app.feature.terminal.RemoteTerminalController
import com.agentsanywhere.app.feature.terminal.RemoteTerminalStatus
import com.agentsanywhere.app.feature.terminal.TerminalShortcut
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.AuthErrorNotice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Braces
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.ChevronUp
import com.composables.icons.lucide.Copy
import com.composables.icons.lucide.FileCode
import com.composables.icons.lucide.FileText
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.KeyRound
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.Terminal
import com.termux.terminal.TextStyle as TermuxTextStyle
import com.termux.view.RemoteTerminalView
import com.termux.view.RemoteTerminalViewClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

@Composable
internal fun SessionAgentFilesScreen(
    session: AgentSession?,
    filesController: FilesController,
    terminalController: RemoteTerminalController,
    darkMode: Boolean,
    onTerminalVerticalDragChange: (Boolean) -> Unit = {},
    onBack: () -> Unit,
) {
    val colors = LocalAAColors.current
    val scope = rememberCoroutineScope()
    var directory by remember(session?.id) { mutableStateOf(FilesDirectory(path = ".")) }
    var loading by remember(session?.id) { mutableStateOf(false) }
    var error by remember(session?.id) { mutableStateOf<String?>(null) }
    var openActionPath by remember(session?.id) { mutableStateOf<String?>(null) }
    var selectedFile by remember(session?.id) { mutableStateOf<FileEntry?>(null) }
    var preview by remember(session?.id) { mutableStateOf<TextFile?>(null) }
    var previewLoading by remember(session?.id) { mutableStateOf(false) }
    var previewError by remember(session?.id) { mutableStateOf<String?>(null) }
    var searchOpen by remember(session?.id) { mutableStateOf(false) }
    var searchQuery by remember(session?.id) { mutableStateOf("") }
    var searchResult by remember(session?.id) { mutableStateOf(SoraFileSearchResult()) }
    var pushView by remember(session?.id) { mutableStateOf(PushView.Files) }
    val searchController = remember(selectedFile?.path) { SoraFileSearchController() }
    val noWorkspaceMessage = stringResource(R.string.files_session_no_workspace)
    val loadFilesFailedMessage = stringResource(R.string.files_load_failed)
    val openFileFailedMessage = stringResource(R.string.files_open_failed)

    DisposableEffect(Unit) {
        onDispose { onTerminalVerticalDragChange(false) }
    }

    fun load(path: String) {
        val current = session
        val root = current?.cwd?.takeIf { it.isNotBlank() }
        if (current == null || root == null) {
            error = noWorkspaceMessage
            return
        }
        loading = true
        error = null
        scope.launch {
            filesController.listFiles(
                connectorId = current.connectorId,
                root = root,
                path = path,
            )
                .onSuccess { directory = it.normalizedRemotePaths() }
                .onFailure { failure -> error = failure.message ?: loadFilesFailedMessage }
            loading = false
        }
    }

    LaunchedEffect(session?.id, session?.cwd) {
        selectedFile = null
        preview = null
        previewError = null
        searchOpen = false
        searchQuery = ""
        searchResult = SoraFileSearchResult()
        directory = FilesDirectory(path = ".")
        if (session?.cwd.isNullOrBlank()) {
            error = noWorkspaceMessage
        } else {
            load(".")
        }
    }

    LaunchedEffect(session?.id, session?.cwd, selectedFile?.path) {
        val file = selectedFile
        if (file == null) return@LaunchedEffect
        val current = session
        val root = current?.cwd?.takeIf { it.isNotBlank() }
        if (current == null || root == null) {
            preview = null
            previewLoading = false
            previewError = noWorkspaceMessage
            return@LaunchedEffect
        }
        preview = null
        previewLoading = true
        previewError = null
        searchQuery = ""
        searchResult = SoraFileSearchResult()
        filesController.readTextFile(
            connectorId = current.connectorId,
            root = root,
            path = file.path,
        )
            .onSuccess { preview = it }
            .onFailure { failure -> previewError = failure.message ?: openFileFailedMessage }
        previewLoading = false
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.canvas),
    ) {
        SessionAgentFilesHeader(
            darkMode = darkMode,
            view = pushView,
            onSelectView = { pushView = it },
            onBack = onBack,
        )
        if (pushView == PushView.Terminal) {
            TerminalContent(
                terminalController = terminalController,
                darkMode = darkMode,
                terminalKey = session?.id,
                canReconnect = session != null,
                onStart = {
                    val current = session ?: return@TerminalContent
                    terminalController.ensureStarted(current)
                },
                onRestart = {
                    val current = session ?: return@TerminalContent
                    terminalController.restart(current)
                },
                onVerticalDragChange = onTerminalVerticalDragChange,
                modifier = Modifier.weight(1f),
            )
        } else {
            val file = selectedFile
            if (file == null) {
                FileListContent(
                    rootPath = session?.cwd,
                    directory = directory,
                    loading = loading,
                    error = error,
                    openActionPath = openActionPath,
                    darkMode = darkMode,
                    onOpenActionPath = { openActionPath = it },
                    onDismissMenu = { openActionPath = null },
                    onOpenDirectory = { load(it) },
                    onOpenFile = {
                        openActionPath = null
                        selectedFile = it
                        searchOpen = false
                    },
                )
            } else {
                FilePreviewContent(
                    rootPath = session?.cwd,
                    file = file,
                    preview = preview,
                    loading = previewLoading,
                    error = previewError,
                    darkMode = darkMode,
                    searchOpen = searchOpen,
                    searchQuery = searchQuery,
                    searchResult = searchResult,
                    searchController = searchController,
                    onBackToFiles = {
                        selectedFile = null
                        preview = null
                        previewError = null
                        searchOpen = false
                        searchQuery = ""
                        searchResult = SoraFileSearchResult()
                    },
                    onToggleSearch = { searchOpen = !searchOpen },
                    onSearchQueryChange = { searchQuery = it },
                    onSearchResult = { searchResult = it },
                )
            }
        }
    }
}

@Composable
internal fun DeviceFilesContent(
    device: AgentDevice?,
    controller: FilesController,
    darkMode: Boolean,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var directory by remember(device?.id) { mutableStateOf(FilesDirectory(path = ".")) }
    var resolvedRoot by remember(device?.id) { mutableStateOf<String?>(null) }
    var loading by remember(device?.id) { mutableStateOf(false) }
    var error by remember(device?.id) { mutableStateOf<String?>(null) }
    var openActionPath by remember(device?.id) { mutableStateOf<String?>(null) }
    var selectedFile by remember(device?.id) { mutableStateOf<FileEntry?>(null) }
    var preview by remember(device?.id) { mutableStateOf<TextFile?>(null) }
    var previewLoading by remember(device?.id) { mutableStateOf(false) }
    var previewError by remember(device?.id) { mutableStateOf<String?>(null) }
    var searchOpen by remember(device?.id) { mutableStateOf(false) }
    var searchQuery by remember(device?.id) { mutableStateOf("") }
    var searchResult by remember(device?.id) { mutableStateOf(SoraFileSearchResult()) }
    val searchController = remember(selectedFile?.path) { SoraFileSearchController() }
    val deviceOfflineMessage = stringResource(R.string.files_device_offline)
    val selectDeviceMessage = stringResource(R.string.files_select_device)
    val loadFilesFailedMessage = stringResource(R.string.files_load_failed)
    val openFileFailedMessage = stringResource(R.string.files_open_failed)

    fun load(path: String) {
        val current = device ?: return
        val root = resolvedRoot?.takeIf { it.isNotBlank() } ?: "~"
        if (!current.online) {
            error = deviceOfflineMessage
            return
        }
        loading = true
        error = null
        scope.launch {
            controller.listFiles(
                connectorId = current.id,
                root = root,
                path = normalizeWindowsDrivePath(path),
            )
                .onSuccess {
                    val nextDirectory = it.normalizedRemotePaths()
                    directory = nextDirectory
                    if (root == "~") {
                        resolvedRoot = nextDirectory.path.takeIf { path -> path.isNotBlank() }
                    }
                }
                .onFailure { failure -> error = failure.message ?: loadFilesFailedMessage }
            loading = false
        }
    }

    LaunchedEffect(device?.id, device?.online) {
        selectedFile = null
        preview = null
        previewError = null
        searchOpen = false
        searchQuery = ""
        searchResult = SoraFileSearchResult()
        resolvedRoot = null
        directory = FilesDirectory(path = ".")
        error = when {
            device == null -> selectDeviceMessage
            !device.online -> deviceOfflineMessage
            else -> null
        }
        if (device?.online == true) load(".")
    }

    LaunchedEffect(device?.id, selectedFile?.path) {
        val file = selectedFile ?: return@LaunchedEffect
        val current = device ?: return@LaunchedEffect
        if (!current.online) {
            preview = null
            previewLoading = false
            previewError = deviceOfflineMessage
            return@LaunchedEffect
        }
        preview = null
        previewLoading = true
        previewError = null
        searchQuery = ""
        searchResult = SoraFileSearchResult()
        controller.readTextFile(
            connectorId = current.id,
            root = resolvedRoot?.takeIf { it.isNotBlank() } ?: "~",
            path = normalizeWindowsDrivePath(file.path),
        )
            .onSuccess { preview = it }
            .onFailure { failure -> previewError = failure.message ?: openFileFailedMessage }
        previewLoading = false
    }

    Box(modifier = modifier.fillMaxSize()) {
        val file = selectedFile
        val rootPath = resolvedRoot ?: "~"
        if (file == null) {
            FileListContent(
                rootPath = rootPath,
                directory = directory,
                loading = loading,
                error = error,
                openActionPath = openActionPath,
                darkMode = darkMode,
                onOpenActionPath = { openActionPath = it },
                onDismissMenu = { openActionPath = null },
                onOpenDirectory = { load(it) },
                onOpenFile = {
                    openActionPath = null
                    selectedFile = it
                    searchOpen = false
                },
            )
        } else {
            FilePreviewContent(
                rootPath = rootPath,
                file = file,
                preview = preview,
                loading = previewLoading,
                error = previewError,
                darkMode = darkMode,
                searchOpen = searchOpen,
                searchQuery = searchQuery,
                searchResult = searchResult,
                searchController = searchController,
                onBackToFiles = {
                    selectedFile = null
                    preview = null
                    previewError = null
                    searchOpen = false
                    searchQuery = ""
                    searchResult = SoraFileSearchResult()
                },
                onToggleSearch = { searchOpen = !searchOpen },
                onSearchQueryChange = { searchQuery = it },
                onSearchResult = { searchResult = it },
            )
        }
    }
}

private enum class PushView {
    Files,
    Terminal,
}

@Composable
internal fun TerminalContent(
    terminalController: RemoteTerminalController,
    darkMode: Boolean,
    terminalKey: Any?,
    canReconnect: Boolean,
    onStart: suspend () -> Unit,
    onRestart: suspend () -> Unit,
    onVerticalDragChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val terminalState by terminalController.state.collectAsState()
    val modifierState by terminalController.modifierState.collectAsState()
    val density = LocalDensity.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val imeBottomPx = WindowInsets.ime.getBottom(density)
    val imeBottom = with(density) { imeBottomPx.toDp() }
    val shortcutsVisible = imeBottomPx > 0
    val terminalBottomInset = 24.dp + if (shortcutsVisible) imeBottom + 88.dp else 0.dp
    val background = if (darkMode) Color(0xFF09090B) else Color(0xFFFEFDFB)
    val statusText = when (terminalState.status) {
        RemoteTerminalStatus.Idle -> null
        RemoteTerminalStatus.Connecting -> stringResource(R.string.files_terminal_connecting)
        RemoteTerminalStatus.Open -> null
        RemoteTerminalStatus.Closed -> terminalState.message ?: stringResource(R.string.files_terminal_disconnected)
        RemoteTerminalStatus.Exited -> terminalState.message ?: stringResource(R.string.files_terminal_exited)
        RemoteTerminalStatus.Error -> terminalState.message ?: stringResource(R.string.files_terminal_error)
    }
    val reconnectable = canReconnect && (
        terminalState.status == RemoteTerminalStatus.Closed ||
        terminalState.status == RemoteTerminalStatus.Exited ||
        terminalState.status == RemoteTerminalStatus.Error
        )
    val emphasizedStatus = terminalState.status == RemoteTerminalStatus.Closed ||
        terminalState.status == RemoteTerminalStatus.Exited ||
        terminalState.status == RemoteTerminalStatus.Error

    LaunchedEffect(terminalKey) {
        if (terminalKey != null) onStart()
    }

    val terminalClient = remember(terminalController, onVerticalDragChange) {
        remoteTerminalViewClient(terminalController, onVerticalDragChange)
    }
    val terminalView = remember(terminalController, context) {
        RemoteTerminalView(context, null).apply {
            setTextSize(
                TypedValue.applyDimension(
                    TypedValue.COMPLEX_UNIT_SP,
                    12f,
                    context.resources.displayMetrics,
                ).roundToInt(),
            )
            setTypeface(Typeface.MONOSPACE)
            setRemoteTerminalViewClient(terminalClient)
            attachSession(terminalController)
            applyTerminalColors(terminalController, darkMode)
        }
    }

    DisposableEffect(terminalView, terminalController) {
        val redraw: () -> Unit = {
            terminalView.post {
                if (terminalView.currentSession === terminalController) {
                    terminalView.onScreenUpdated()
                }
            }
        }
        terminalController.onRedraw = redraw
        terminalView.post {
            if (terminalView.currentSession === terminalController) {
                terminalView.onScreenUpdated()
            }
        }
        onDispose {
            if (terminalController.onRedraw === redraw) {
                terminalController.onRedraw = null
            }
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .clipToBounds()
            .background(background),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(start = 16.dp, end = 16.dp, bottom = terminalBottomInset),
        ) {
            if (statusText != null) {
                val statusModifier = Modifier
                    .padding(vertical = 10.dp)
                    .then(
                        if (reconnectable) {
                            Modifier.noRippleClickable {
                                scope.launch { onRestart() }
                            }
                        } else {
                            Modifier
                        },
                    )
                if (emphasizedStatus) {
                    AuthErrorNotice(
                        message = statusText,
                        modifier = statusModifier,
                    )
                } else {
                    Text(
                        text = statusText,
                        color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF6F706A),
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.SemiBold,
                        modifier = statusModifier.padding(horizontal = 14.dp),
                    )
                }
            }
            AndroidView(
                factory = { terminalView },
                update = {
                    it.setRemoteTerminalViewClient(terminalClient)
                    it.attachSession(terminalController)
                    applyTerminalColors(terminalController, darkMode)
                    it.invalidate()
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            )
        }
        if (shortcutsVisible) {
            TerminalShortcutDeck(
                darkMode = darkMode,
                ctrlLatched = modifierState.ctrl,
                altLatched = modifierState.alt,
                onShortcut = terminalController::sendShortcut,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = imeBottom),
            )
        }
    }
}

private fun applyTerminalColors(controller: RemoteTerminalController, darkMode: Boolean) {
    val colors = controller.emulator.mColors.mCurrentColors
    colors[TermuxTextStyle.COLOR_INDEX_BACKGROUND] = if (darkMode) 0xFF09090B.toInt() else 0xFFFEFDFB.toInt()
    colors[TermuxTextStyle.COLOR_INDEX_FOREGROUND] = if (darkMode) 0xFFFAFAFA.toInt() else 0xFF20211E.toInt()
    colors[TermuxTextStyle.COLOR_INDEX_CURSOR] = if (darkMode) 0xFFFAFAFA.toInt() else 0xFF20211E.toInt()
}

private fun remoteTerminalViewClient(
    controller: RemoteTerminalController,
    onVerticalDragChange: (Boolean) -> Unit,
) = object : RemoteTerminalViewClient {
    override fun onScale(scale: Float): Float = scale

    override fun onSingleTapUp(e: MotionEvent?) = Unit

    override fun shouldBackButtonBeMappedToEscape(): Boolean = false
    override fun shouldEnforceCharBasedInput(): Boolean = true
    override fun shouldUseCtrlSpaceWorkaround(): Boolean = false
    override fun isTerminalViewSelected(): Boolean = true
    override fun copyModeChanged(copyMode: Boolean) = Unit
    override fun verticalScrollChanged(active: Boolean) = onVerticalDragChange(active)
    override fun onKeyDown(keyCode: Int, e: KeyEvent?, session: RemoteTerminalController?): Boolean = false
    override fun onKeyUp(keyCode: Int, e: KeyEvent?): Boolean = false
    override fun onLongPress(event: MotionEvent?): Boolean = false
    override fun readControlKey(): Boolean = controller.isCtrlLatched
    override fun readAltKey(): Boolean = controller.isAltLatched
    override fun readShiftKey(): Boolean = false
    override fun readFnKey(): Boolean = false
    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: RemoteTerminalController?): Boolean = false
    override fun onEmulatorSet() = Unit
    override fun logError(tag: String?, message: String?) = Unit
    override fun logWarn(tag: String?, message: String?) = Unit
    override fun logInfo(tag: String?, message: String?) = Unit
    override fun logDebug(tag: String?, message: String?) = Unit
    override fun logVerbose(tag: String?, message: String?) = Unit
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) = Unit
    override fun logStackTrace(tag: String?, e: Exception?) = Unit
}

@Composable
private fun TerminalShortcutDeck(
    darkMode: Boolean,
    ctrlLatched: Boolean,
    altLatched: Boolean,
    onShortcut: (TerminalShortcut) -> Unit,
    modifier: Modifier = Modifier,
) {
    val background = if (darkMode) Color(0xFF09090B) else Color(0xFFFEFDFB)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .height(88.dp)
            .background(background)
            .padding(horizontal = 14.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        TerminalShortcutRow(
            shortcuts = listOf(
                TerminalShortcut.Esc,
                TerminalShortcut.Slash,
                TerminalShortcut.Dash,
                TerminalShortcut.Home,
                TerminalShortcut.Up,
                TerminalShortcut.End,
                TerminalShortcut.PageUp,
            ),
            darkMode = darkMode,
            ctrlLatched = ctrlLatched,
            altLatched = altLatched,
            onShortcut = onShortcut,
            modifier = Modifier.weight(1f),
        )
        TerminalShortcutRow(
            shortcuts = listOf(
                TerminalShortcut.Tab,
                TerminalShortcut.Ctrl,
                TerminalShortcut.Alt,
                TerminalShortcut.Left,
                TerminalShortcut.Down,
                TerminalShortcut.Right,
                TerminalShortcut.PageDown,
            ),
            darkMode = darkMode,
            ctrlLatched = ctrlLatched,
            altLatched = altLatched,
            onShortcut = onShortcut,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun TerminalShortcutRow(
    shortcuts: List<TerminalShortcut>,
    darkMode: Boolean,
    ctrlLatched: Boolean,
    altLatched: Boolean,
    onShortcut: (TerminalShortcut) -> Unit,
    modifier: Modifier = Modifier,
) {
    val haptic = LocalHapticFeedback.current
    val text = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF151515)
    val activeText = if (darkMode) Color(0xFF67E8F9) else Color(0xFF0891B2)
    val activeBackground = if (darkMode) Color(0x1A67E8F9) else Color(0x1A0891B2)
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        shortcuts.forEach { shortcut ->
            val active = (shortcut == TerminalShortcut.Ctrl && ctrlLatched) ||
                (shortcut == TerminalShortcut.Alt && altLatched)
            Box(
                modifier = Modifier
                    .height(34.dp)
                    .weight(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (active) activeBackground else Color.Transparent)
                    .noRippleClickable {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        onShortcut(shortcut)
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = shortcut.label,
                    color = if (active) activeText else text,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun FileListContent(
    rootPath: String?,
    directory: FilesDirectory,
    loading: Boolean,
    error: String?,
    openActionPath: String?,
    darkMode: Boolean,
    onOpenActionPath: (String) -> Unit,
    onDismissMenu: () -> Unit,
    onOpenDirectory: (String) -> Unit,
    onOpenFile: (FileEntry) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(start = 16.dp, end = 16.dp, top = 6.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        PathBar(
            path = displayPath(rootPath, directory.path),
            darkMode = darkMode,
        )
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(1.dp),
        ) {
            when {
                loading && directory.entries.isEmpty() -> item { FilesMessage(stringResource(R.string.files_loading), darkMode) }
                error != null && directory.entries.isEmpty() -> item { FilesMessage(error.orEmpty(), darkMode) }
                !loading && directory.entries.isEmpty() -> item { FilesMessage(stringResource(R.string.files_empty_directory), darkMode) }
            }
            val parent = parentPath(directory.path)
            if (parent.isNotBlank()) {
                item("..") {
                    FolderRow(
                        name = "..",
                        copyPath = displayPath(rootPath, parent),
                        darkMode = darkMode,
                        menuOpen = openActionPath == parent,
                        onOpenMenu = { onOpenActionPath(parent) },
                        onDismissMenu = onDismissMenu,
                        onClick = { onOpenDirectory(parent) },
                    )
                }
            }
            items(directory.entries, key = { it.path }) { entry ->
                if (entry.isDirectory) {
                    FolderRow(
                        name = entry.name,
                        copyPath = displayPath(rootPath, entry.path),
                        darkMode = darkMode,
                        menuOpen = openActionPath == entry.path,
                        onOpenMenu = { onOpenActionPath(entry.path) },
                        onDismissMenu = onDismissMenu,
                        onClick = { onOpenDirectory(entry.path) },
                    )
                } else {
                    FileRow(
                        entry = entry,
                        copyPath = displayPath(rootPath, entry.path),
                        darkMode = darkMode,
                        menuOpen = openActionPath == entry.path,
                        onOpenMenu = { onOpenActionPath(entry.path) },
                        onDismissMenu = onDismissMenu,
                        onClick = { onOpenFile(entry) },
                    )
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun FilePreviewContent(
    rootPath: String?,
    file: FileEntry,
    preview: TextFile?,
    loading: Boolean,
    error: String?,
    darkMode: Boolean,
    searchOpen: Boolean,
    searchQuery: String,
    searchResult: SoraFileSearchResult,
    searchController: SoraFileSearchController,
    onBackToFiles: () -> Unit,
    onToggleSearch: () -> Unit,
    onSearchQueryChange: (String) -> Unit,
    onSearchResult: (SoraFileSearchResult) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        PreviewBreadcrumb(
            path = displayPath(rootPath, file.path),
            darkMode = darkMode,
            onBackToFiles = onBackToFiles,
        )
        PreviewCard(
            file = file,
            preview = preview,
            loading = loading,
            error = error,
            darkMode = darkMode,
            searchOpen = searchOpen,
            searchQuery = searchQuery,
            searchResult = searchResult,
            searchController = searchController,
            onToggleSearch = onToggleSearch,
            onSearchQueryChange = onSearchQueryChange,
            onSearchResult = onSearchResult,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun PreviewBreadcrumb(
    path: String,
    darkMode: Boolean,
    onBackToFiles: () -> Unit,
) {
    val chipBackground = if (darkMode) Color(0xFF18181B) else Color(0xFFF1F0ED)
    val chipText = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF444540)
    val pathText = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF686862)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(30.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier
                .height(28.dp)
                .clip(CircleShape)
                .background(chipBackground)
                .noRippleClickable(onClick = onBackToFiles)
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Icon(Lucide.ChevronLeft, contentDescription = null, tint = chipText, modifier = Modifier.size(13.dp))
            Text(stringResource(R.string.common_files), color = chipText, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
        Text("/", color = if (darkMode) Color(0xFF71717A) else Color(0xFFA8A6A0), fontSize = 11.sp, fontWeight = FontWeight.Bold)
        Text(
            text = path,
            color = pathText,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.MiddleEllipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun PreviewCard(
    file: FileEntry,
    preview: TextFile?,
    loading: Boolean,
    error: String?,
    darkMode: Boolean,
    searchOpen: Boolean,
    searchQuery: String,
    searchResult: SoraFileSearchResult,
    searchController: SoraFileSearchController,
    onToggleSearch: () -> Unit,
    onSearchQueryChange: (String) -> Unit,
    onSearchResult: (SoraFileSearchResult) -> Unit,
    modifier: Modifier = Modifier,
) {
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var copied by remember(file.path) { mutableStateOf(false) }
    val cardBackground = if (darkMode) Color(0xFF09090B) else Color.White
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE7E5E0)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(cardBackground)
            .border(1.2.dp, border, RoundedCornerShape(16.dp)),
    ) {
        PreviewCardHeader(
            fileName = file.name,
            darkMode = darkMode,
            copied = copied,
            copyEnabled = preview?.let { !it.binary && it.content.isNotBlank() } == true,
            onToggleSearch = onToggleSearch,
            onCopy = {
                val content = preview?.content.orEmpty()
                if (content.isNotBlank()) {
                    clipboard.setText(AnnotatedString(content))
                    copied = true
                    scope.launch {
                        delay(1100)
                        copied = false
                    }
                }
            },
        )
        if (searchOpen) {
            InlineFileSearchControls(
                query = searchQuery,
                result = searchResult,
                darkMode = darkMode,
                onQueryChange = onSearchQueryChange,
                onPrevious = { searchController.previous() },
                onNext = { searchController.next() },
            )
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            contentAlignment = Alignment.TopStart,
        ) {
            when {
                loading -> PreviewMessage(stringResource(R.string.files_loading_file), darkMode)
                error != null -> PreviewMessage(error, darkMode)
                preview?.binary == true -> PreviewMessage(stringResource(R.string.files_binary_preview_unavailable), darkMode)
                preview == null -> PreviewMessage(stringResource(R.string.files_open_file_to_preview), darkMode)
                else -> SoraFilePreview(
                    text = preview.content,
                    languageHint = preview.name.ifBlank { file.name },
                    darkMode = darkMode,
                    searchQuery = if (searchOpen) searchQuery else "",
                    searchController = searchController,
                    onSearchResult = onSearchResult,
                    editorBackground = cardBackground,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

@Composable
private fun PreviewCardHeader(
    fileName: String,
    darkMode: Boolean,
    copied: Boolean,
    copyEnabled: Boolean,
    onToggleSearch: () -> Unit,
    onCopy: () -> Unit,
) {
    val background = if (darkMode) Color(0xFF18181B) else Color.White
    val text = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF111111)
    val buttonBackground = if (darkMode) Color(0xFF27272A) else Color(0xFFF5F4F0)
    val buttonBorder = if (darkMode) Color(0xFF3F3F46) else Color(0xFFE5E2DC)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(44.dp)
            .background(background)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = fileName,
            color = text,
            fontSize = 15.sp,
            fontWeight = FontWeight.ExtraBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        PreviewIconButton(
            icon = Lucide.Search,
            darkMode = darkMode,
            background = buttonBackground,
            border = buttonBorder,
            enabled = true,
            contentDescription = stringResource(R.string.files_search_in_file),
            onClick = onToggleSearch,
        )
        PreviewIconButton(
            icon = if (copied) Lucide.Check else Lucide.Copy,
            darkMode = darkMode,
            background = buttonBackground,
            border = buttonBorder,
            enabled = copyEnabled,
            contentDescription = if (copied) {
                stringResource(R.string.files_copied_code)
            } else {
                stringResource(R.string.files_copy_code)
            },
            onClick = onCopy,
        )
    }
}

@Composable
private fun InlineFileSearchControls(
    query: String,
    result: SoraFileSearchResult,
    darkMode: Boolean,
    onQueryChange: (String) -> Unit,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
) {
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val background = if (darkMode) Color(0xFF111113) else Color(0xFFF8F7F4)
    val inputBackground = if (darkMode) Color(0xFF18181B) else Color.White
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE1DED7)
    val text = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF111111)
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF686862)
    LaunchedEffect(query, result.total) {
        focusRequester.requestFocus()
        keyboard?.show()
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(46.dp)
            .background(background)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier
                .weight(1f)
                .height(34.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(inputBackground)
                .border(1.dp, border, RoundedCornerShape(12.dp))
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Icon(Lucide.Search, contentDescription = null, tint = muted, modifier = Modifier.size(14.dp))
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                singleLine = true,
                textStyle = TextStyle(
                    color = text,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                ),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { onNext() }),
                modifier = Modifier
                    .weight(1f)
                    .focusRequester(focusRequester),
                decorationBox = { innerTextField ->
                    if (query.isBlank()) {
                        Text(
                            text = stringResource(R.string.files_search),
                            color = muted,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                        )
                    }
                    innerTextField()
                },
            )
        }
        Text(
            text = "${result.current}/${result.total}",
            color = muted,
            fontSize = 11.sp,
            fontWeight = FontWeight.ExtraBold,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
        )
        SearchStepButton(icon = Lucide.ChevronUp, darkMode = darkMode, onClick = onPrevious)
        SearchStepButton(icon = Lucide.ChevronDown, darkMode = darkMode, onClick = onNext)
    }
}

@Composable
private fun SearchStepButton(
    icon: ImageVector,
    darkMode: Boolean,
    onClick: () -> Unit,
) {
    val background = if (darkMode) Color(0xFF18181B) else Color.White
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE1DED7)
    val content = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF444540)
    Box(
        modifier = Modifier
            .size(30.dp)
            .clip(CircleShape)
            .background(background)
            .border(1.dp, border, CircleShape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(15.dp))
    }
}

@Composable
private fun PreviewIconButton(
    icon: ImageVector,
    darkMode: Boolean,
    background: Color,
    border: Color,
    enabled: Boolean,
    contentDescription: String,
    onClick: () -> Unit,
) {
    val content = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF545550)
    Box(
        modifier = Modifier
            .size(34.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(background)
            .border(1.dp, border, RoundedCornerShape(12.dp))
            .then(if (enabled) Modifier.noRippleClickable(onClick = onClick) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = contentDescription, tint = content.copy(alpha = if (enabled) 1f else 0.38f), modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun PreviewMessage(
    message: String,
    darkMode: Boolean,
) {
    Text(
        text = message,
        color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777),
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 16.dp),
    )
}

@Composable
private fun SessionAgentFilesHeader(
    darkMode: Boolean,
    view: PushView,
    onSelectView: (PushView) -> Unit,
    onBack: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(58.dp)
            .zIndex(1f)
            .background(if (darkMode) Color(0xFF09090B) else Color(0xFFFDFCFB))
            .padding(horizontal = 18.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BackChip(darkMode = darkMode, onClick = onBack)
        PushSwitcher(
            darkMode = darkMode,
            view = view,
            onSelectView = onSelectView,
        )
    }
}

@Composable
private fun BackChip(
    darkMode: Boolean,
    onClick: () -> Unit,
) {
    val background = if (darkMode) Color(0xFF18181B) else Color.White
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE7E5E0)
    val content = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF111111)
    Row(
        modifier = Modifier
            .height(36.dp)
            .clip(CircleShape)
            .background(background)
            .border(1.2.dp, border, CircleShape)
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Icon(Lucide.ChevronLeft, contentDescription = null, tint = content, modifier = Modifier.size(14.dp))
        Text(stringResource(R.string.common_back), color = content, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun PushSwitcher(
    darkMode: Boolean,
    view: PushView,
    onSelectView: (PushView) -> Unit,
) {
    val background = if (darkMode) Color(0xFF18181B) else Color(0xFFF1F0ED)
    val selected = if (darkMode) Color(0xFF27272A) else Color.White
    val selectedText = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF242521)
    val muted = if (darkMode) Color(0xFF71717A) else Color(0xFF8B8983)
    val tabWidth = 92.dp
    val gap = 4.dp
    val indicatorOffset by animateDpAsState(
        targetValue = if (view == PushView.Files) 0.dp else tabWidth + gap,
        label = "session-files-switcher-indicator",
    )
    Box(
        modifier = Modifier
            .width(196.dp)
            .height(42.dp)
            .clip(CircleShape)
            .background(background)
            .border(1.dp, if (darkMode) Color(0xFF27272A) else Color.Transparent, CircleShape)
            .padding(4.dp),
    ) {
        Box(
            modifier = Modifier
                .offset(x = indicatorOffset)
                .width(tabWidth)
                .fillMaxHeight()
                .shadow(
                    6.dp,
                    CircleShape,
                    ambientColor = if (darkMode) Color(0x66000000) else Color(0x22000000),
                    spotColor = if (darkMode) Color(0x66000000) else Color(0x22000000),
                )
                .clip(CircleShape)
                .background(selected),
        )
        Row(
            modifier = Modifier.fillMaxSize(),
            horizontalArrangement = Arrangement.spacedBy(gap),
            verticalAlignment = Alignment.CenterVertically,
        ) {
        val filesSelected = view == PushView.Files
        SwitcherTab(
            label = stringResource(R.string.common_files),
            icon = Lucide.Folder,
            background = Color.Transparent,
            content = if (filesSelected) selectedText else muted,
            onClick = { onSelectView(PushView.Files) },
            modifier = Modifier
                .weight(1f)
                .fillMaxSize(),
        )
        val terminalSelected = view == PushView.Terminal
        SwitcherTab(
            label = stringResource(R.string.common_terminal),
            icon = Lucide.Terminal,
            background = Color.Transparent,
            content = if (terminalSelected) selectedText else muted,
            onClick = { onSelectView(PushView.Terminal) },
            modifier = Modifier
                .weight(1f)
                .fillMaxSize(),
        )
        }
    }
}

@Composable
private fun SwitcherTab(
    label: String,
    icon: ImageVector,
    background: Color,
    content: Color,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    Row(
        modifier = modifier
            .clip(CircleShape)
            .background(background)
            .noRippleClickable(onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(15.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, color = content, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}

@Composable
private fun PathBar(
    path: String,
    darkMode: Boolean,
) {
    val clipboard = LocalClipboardManager.current
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(13.dp)
    val background = if (darkMode) Color(0xFF18181B) else Color(0xFFF1F0ED)
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE0DED8)
    val textColor = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF242521)
    val iconBackground = if (darkMode) Color(0xFF18181B) else Color(0xFFF1F0ED)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .height(52.dp)
                .clip(shape)
                .background(background)
                .border(1.2.dp, border, shape)
                .padding(horizontal = 13.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text(
                text = path.ifBlank { "." },
                color = textColor,
                fontSize = 15.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight.ExtraBold,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
                softWrap = false,
            )
        }
        Box(
            modifier = Modifier
                .size(52.dp)
                .clip(shape)
                .background(iconBackground)
                .border(1.2.dp, border, shape)
                .noRippleClickable {
                    clipboard.setText(AnnotatedString(path))
                    copied = true
                    scope.launch {
                        delay(1100)
                        copied = false
                    }
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (copied) Lucide.Check else Lucide.Copy,
                contentDescription = if (copied) {
                    stringResource(R.string.files_copied_path)
                } else {
                    stringResource(R.string.files_copy_path)
                },
                tint = textColor,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
private fun FolderRow(
    name: String,
    copyPath: String,
    darkMode: Boolean,
    menuOpen: Boolean,
    onOpenMenu: () -> Unit,
    onDismissMenu: () -> Unit,
    onClick: () -> Unit,
) {
    FileListRow(
        name = name,
        icon = Lucide.Folder,
        copyPath = copyPath,
        darkMode = darkMode,
        menuOpen = menuOpen,
        onOpenMenu = onOpenMenu,
        onDismissMenu = onDismissMenu,
        trailing = {
            Icon(
                Lucide.ChevronRight,
                contentDescription = null,
                tint = if (darkMode) Color(0xFF71717A) else Color(0xFFA8A6A0),
                modifier = Modifier.size(20.dp),
            )
        },
        onClick = onClick,
    )
}

@Composable
private fun FileRow(
    entry: FileEntry,
    copyPath: String,
    darkMode: Boolean,
    menuOpen: Boolean,
    onOpenMenu: () -> Unit,
    onDismissMenu: () -> Unit,
    onClick: () -> Unit,
) {
    val icon = fileIconFor(entry.name, SoraTextMate.hasLanguageSpec(entry.name))
    FileListRow(
        name = entry.name,
        icon = icon,
        copyPath = copyPath,
        darkMode = darkMode,
        menuOpen = menuOpen,
        onOpenMenu = onOpenMenu,
        onDismissMenu = onDismissMenu,
        trailing = null,
        onClick = onClick,
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FileListRow(
    name: String,
    icon: ImageVector,
    copyPath: String,
    darkMode: Boolean,
    menuOpen: Boolean,
    onOpenMenu: () -> Unit,
    onDismissMenu: () -> Unit,
    trailing: (@Composable () -> Unit)?,
    onClick: () -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    val haptic = LocalHapticFeedback.current
    val feedbackScope = rememberCoroutineScope()
    val menuOffset = with(LocalDensity.current) { IntOffset(54.dp.roundToPx(), 56.dp.roundToPx()) }
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    var flash by remember { mutableStateOf(false) }
    val active = pressed || flash
    val rowShape = RoundedCornerShape(16.dp)
    val elevation by animateDpAsState(
        targetValue = if (active) 14.dp else 0.dp,
        label = "session-files-row-elevation",
    )
    val surfaceAlpha by animateFloatAsState(
        targetValue = if (active) 1f else 0f,
        label = "session-files-row-surface-alpha",
    )
    val pressedSurface = if (darkMode) Color(0xFF18181B) else Color(0xFFEDEBE6)
    val iconColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF2F302D)
    val textColor = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF242521)
    val shadowColor = if (darkMode) Color(0x77000000) else Color(0x30000000)
    Box(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(60.dp)
                .shadow(elevation, rowShape, clip = false, ambientColor = shadowColor, spotColor = shadowColor)
                .clip(rowShape)
                .background(pressedSurface.copy(alpha = surfaceAlpha))
                .combinedClickable(
                    interactionSource = interactionSource,
                    indication = null,
                    onClick = {
                        onDismissMenu()
                        flash = true
                        feedbackScope.launch {
                            delay(180)
                            flash = false
                        }
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        onClick()
                    },
                    onLongClick = {
                        onOpenMenu()
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    },
                )
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color.Transparent),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = iconColor, modifier = Modifier.size(22.dp))
            }
            Text(
                text = name,
                color = textColor,
                fontSize = 15.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            trailing?.invoke()
        }
        if (menuOpen) {
            Popup(
                alignment = Alignment.TopStart,
                offset = menuOffset,
                onDismissRequest = onDismissMenu,
            ) {
                FileActionMenu(
                    darkMode = darkMode,
                    onCopyPath = {
                        clipboard.setText(AnnotatedString(copyPath))
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        onDismissMenu()
                    },
                )
            }
        }
    }
}

@Composable
private fun FileActionMenu(
    darkMode: Boolean,
    onCopyPath: () -> Unit,
) {
    val surface = if (darkMode) Color(0xFF202023) else Color.White
    val border = if (darkMode) Color(0xFF38383C) else Color(0xFFEFEDE9)
    val shadow = if (darkMode) Color(0x80000000) else Color(0x1A000000)
    val text = if (darkMode) Color(0xFFF4F4F5) else Color(0xFF2F302D)
    val iconSurface = if (darkMode) Color(0xFF3A3A3D) else Color(0xFFF1F1EF)
    Row(
        modifier = Modifier
            .width(188.dp)
            .height(54.dp)
            .shadow(24.dp, RoundedCornerShape(16.dp), ambientColor = shadow, spotColor = shadow)
            .clip(RoundedCornerShape(16.dp))
            .background(surface)
            .border(1.dp, border, RoundedCornerShape(16.dp))
            .noRippleClickable(onClick = onCopyPath)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(CircleShape)
                .background(iconSurface),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Lucide.Copy, contentDescription = null, tint = text, modifier = Modifier.size(17.dp))
        }
        Text(
            text = stringResource(R.string.files_copy_path),
            color = text,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun FilesMessage(
    message: String,
    darkMode: Boolean,
) {
    Text(
        text = message,
        color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777),
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(horizontal = 8.dp, vertical = 16.dp),
    )
}

private fun fileIconFor(name: String, knownCode: Boolean): ImageVector {
    val lower = name.lowercase()
    return when {
        lower == ".env" || lower.startsWith(".env.") || lower.contains("secret") -> Lucide.KeyRound
        lower.endsWith(".json") || lower.endsWith(".jsonc") -> Lucide.Braces
        lower.endsWith(".md") || lower.endsWith(".markdown") -> Lucide.FileText
        lower.endsWith(".txt") -> Lucide.FileText
        knownCode -> Lucide.FileCode
        else -> Lucide.FileText
    }
}

private fun displayPath(root: String?, rawPath: String): String {
    val base = root.orEmpty().trim().trimEnd('/', '\\')
    val path = normalizeWindowsDrivePath(rawPath).trim().replace('\\', '/')
    if (path.isBlank() || path == "." || path == "/") return base.ifBlank { "." }
    if (path.startsWith("/") || Regex("^[A-Za-z]:/.*").matches(path)) return path
    return if (base.isBlank()) path else "$base/${path.trimStart('/')}"
}

private fun parentPath(rawPath: String): String {
    val clean = normalizeWindowsDrivePath(rawPath).trim().trimEnd('/', '\\').ifBlank { "." }
    if (clean == "." || clean == "/" || Regex("^[A-Za-z]:[\\\\/]?$").matches(clean)) return ""
    val normalized = clean.replace('\\', '/')
    val slash = normalized.lastIndexOf("/")
    val parent = when {
        slash < 0 -> "."
        slash == 0 -> "/"
        else -> normalized.take(slash)
    }
    return if (clean.contains('\\') && Regex("^[A-Za-z]:/").containsMatchIn(parent)) {
        parent.replace('/', '\\')
    } else {
        parent
    }
}

private fun FilesDirectory.normalizedRemotePaths(): FilesDirectory {
    return copy(
        path = normalizeWindowsDrivePath(path),
        entries = entries.map { entry -> entry.copy(path = normalizeWindowsDrivePath(entry.path)) },
    )
}

private fun normalizeWindowsDrivePath(rawPath: String): String {
    return rawPath.replace(Regex("^/([A-Za-z]:)(?=$|[\\\\/])"), "$1")
}
