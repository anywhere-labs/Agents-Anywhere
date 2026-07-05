package com.agentsanywhere.app.ui.screens.home

import android.graphics.Typeface
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.AuthMeResponse
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.sessions.pinnedSessions
import com.agentsanywhere.app.feature.sessions.recentSessions
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.AAWordmark
import com.agentsanywhere.app.ui.designsystem.AuthErrorNotice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.common.AppEmptyState
import com.agentsanywhere.app.ui.screens.devices.DeviceRow
import com.agentsanywhere.app.ui.screens.devices.sortedForDevicesPage
import com.agentsanywhere.app.ui.screens.profile.ProfileSettingsDrawer
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.List as ListIcon
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Monitor
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.Terminal
import com.composables.icons.lucide.UserRound
import com.valentinilk.shimmer.shimmer
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

enum class HomeTab { Active, Archived, Devices }

private data class HomeSessionActionMenu(
    val session: AgentSession,
    val rowBounds: Rect,
)

private const val SESSION_TITLE_DISPLAY_MAX_CHARS = 15

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
    onRefresh: () -> Unit,
    onTabSelected: (HomeTab) -> Unit,
    onAppearanceModeChange: (String) -> Unit,
    onLanguageModeChange: (String) -> Unit,
    onLoadAccount: suspend () -> Result<AuthMeResponse>,
    onUpdateAvatar: suspend (String) -> Result<AuthMeResponse>,
    onClearAvatar: suspend () -> Result<AuthMeResponse>,
    onChangePassword: suspend (String) -> Result<Unit>,
    onSignOut: () -> Unit,
    onRenameSession: suspend (String, String) -> Result<AgentSession>,
    onSetSessionPinned: suspend (String, Boolean) -> Result<AgentSession>,
    onSetSessionArchived: suspend (String, Boolean) -> Result<AgentSession>,
    onOpenSession: (AgentSession) -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
    onPairDevice: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    var actionMenu by remember { mutableStateOf<HomeSessionActionMenu?>(null) }
    var renamingSession by remember { mutableStateOf<AgentSession?>(null) }
    var profileOpen by remember { mutableStateOf(false) }

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
                isRefreshing = isRefreshing,
                onRefresh = onRefresh,
                onTabSelected = onTabSelected,
                onProfile = { profileOpen = true },
                onSearch = { showToast(context.getString(R.string.home_search_coming_soon)) },
                onSessionLongPress = { session, bounds -> actionMenu = HomeSessionActionMenu(session, bounds) },
                onOpenSession = onOpenSession,
                onOpenDevice = onOpenDevice,
                onPairDevice = onPairDevice,
            )
            actionMenu?.let { menu ->
                HomeSessionActionOverlay(
                    menu = menu,
                    onDismiss = { actionMenu = null },
                    onRename = {
                        actionMenu = null
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
            ProfileSettingsDrawer(
                open = profileOpen,
                userId = userId,
                role = role,
                serverUrl = serverUrl,
                appearanceMode = appearanceMode,
                languageMode = languageMode,
                onAppearanceModeChange = onAppearanceModeChange,
                onLanguageModeChange = onLanguageModeChange,
                onLoadAccount = onLoadAccount,
                onUpdateAvatar = onUpdateAvatar,
                onClearAvatar = onClearAvatar,
                onChangePassword = onChangePassword,
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
            onDismiss = { renamingSession = null },
            onSave = { title ->
                scope.launch {
                    onRenameSession(session.id, title)
                        .onSuccess {
                            renamingSession = null
                            showToast(context.getString(R.string.home_session_renamed))
                        }
                        .onFailure { showToast(it.message ?: context.getString(R.string.home_rename_failed), isError = true) }
                }
            },
        )
    }
}

@Composable
private fun HomeSessionActionOverlay(
    menu: HomeSessionActionMenu,
    onDismiss: () -> Unit,
    onRename: () -> Unit,
    onTogglePinned: () -> Unit,
    onToggleArchived: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val density = LocalDensity.current
    val row = menu.rowBounds
    val menuWidth = 252.dp
    val menuHeight = 168.dp
    val gap = 10.dp
    val margin = 18.dp
    val menuWidthPx = with(density) { menuWidth.toPx() }
    val menuHeightPx = with(density) { menuHeight.toPx() }
    val gapPx = with(density) { gap.toPx() }
    val marginPx = with(density) { margin.toPx() }
    val highlightShape = RoundedCornerShape(15.dp)
    val highlightSurface = if (darkMode) Color(0xFF202020) else Color.White

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxSize()
            .background(if (darkMode) Color(0x99000000) else Color(0x66000000))
            .pointerInput(Unit) { detectTapGestures(onTap = { onDismiss() }) },
    ) {
        val screenWidthPx = with(density) { maxWidth.toPx() }
        val screenHeightPx = with(density) { maxHeight.toPx() }
        val menuX = (row.left + 120f).coerceIn(marginPx, screenWidthPx - menuWidthPx - marginPx)
        val belowY = row.bottom + gapPx
        val aboveY = row.top - menuHeightPx - gapPx
        val menuY = if (belowY + menuHeightPx + marginPx <= screenHeightPx) {
            belowY
        } else {
            aboveY.coerceAtLeast(marginPx)
        }

        Box(
            modifier = Modifier
                .offset { IntOffset(row.left.roundToInt(), row.top.roundToInt()) }
                .width(with(density) { row.width.toDp() })
                .height(with(density) { row.height.toDp() })
                .shadow(18.dp, highlightShape, ambientColor = Color(0x22000000), spotColor = Color(0x22000000))
                .clip(highlightShape)
                .background(highlightSurface),
        ) {
            HomeSessionHighlightRow(session = menu.session, darkMode = darkMode)
        }
        HomeSessionActionMenuCard(
            session = menu.session,
            modifier = Modifier.offset { IntOffset(menuX.roundToInt(), menuY.roundToInt()) },
            onRename = onRename,
            onTogglePinned = onTogglePinned,
            onToggleArchived = onToggleArchived,
        )
    }
}

@Composable
private fun HomeSessionHighlightRow(session: AgentSession, darkMode: Boolean) {
    val subtitle = listOf(session.runtimeLabel, session.workspaceLabel)
        .filter { it.isNotBlank() }
        .joinToString("  ·  ")
    val title = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF1F201D)
    val meta = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF8E918A)

    Row(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Lucide.ListIcon, contentDescription = null, tint = meta, modifier = Modifier.size(14.dp))
        if (session.pinned) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = session.title.sessionDisplayTitle(),
                    color = title,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                    lineHeight = 20.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = subtitle,
                    color = meta,
                    fontSize = 11.2.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        } else {
            Text(
                text = session.title.sessionDisplayTitle(),
                modifier = Modifier.weight(1f),
                color = title,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                lineHeight = 20.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            text = session.updatedAtLabel.ifBlank { "now" },
            color = meta,
            fontSize = 10.8.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun HomeSessionActionMenuCard(
    session: AgentSession,
    modifier: Modifier = Modifier,
    onRename: () -> Unit,
    onTogglePinned: () -> Unit,
    onToggleArchived: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val surface = if (darkMode) Color(0xFF181818) else Color.White
    val border = if (darkMode) Color(0xFF2D2D2F) else Color(0xFFEFEDE9)
    val shadow = if (darkMode) Color(0x80000000) else Color(0x1A000000)
    val text = if (darkMode) Color(0xFFF4F4F5) else Color(0xFF2F302D)

    Column(
        modifier = modifier
            .width(252.dp)
            .height(168.dp)
            .shadow(34.dp, RoundedCornerShape(22.dp), ambientColor = shadow, spotColor = shadow)
            .clip(RoundedCornerShape(22.dp))
            .background(surface)
            .border(1.dp, border, RoundedCornerShape(22.dp))
            .padding(vertical = 7.dp),
    ) {
        HomeSessionActionMenuRow(
            label = stringResource(R.string.home_rename),
            iconRes = if (darkMode) R.drawable.ic_session_action_rename_white else R.drawable.ic_session_action_rename_black,
            textColor = text,
            onClick = onRename,
        )
        HomeSessionActionMenuRow(
            label = stringResource(if (session.archived) R.string.home_unarchive else R.string.home_archive),
            iconRes = if (darkMode) R.drawable.ic_session_action_archive_white else R.drawable.ic_session_action_archive_black,
            textColor = text,
            onClick = onToggleArchived,
        )
        HomeSessionActionMenuRow(
            label = stringResource(if (session.pinned) R.string.home_unpin else R.string.home_pin),
            iconRes = if (darkMode) R.drawable.ic_session_action_unpin_white else R.drawable.ic_session_action_unpin_black,
            textColor = text,
            onClick = onTogglePinned,
        )
    }
}

@Composable
private fun HomeSessionActionMenuRow(
    label: String,
    iconRes: Int,
    textColor: Color,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(50.dp)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 20.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            color = textColor,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 20.sp,
        )
        Image(
            painter = androidx.compose.ui.res.painterResource(iconRes),
            contentDescription = null,
            modifier = Modifier.size(22.dp),
        )
    }
}

@Composable
private fun HomeRenameSessionDialog(
    session: AgentSession,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val shape = RoundedCornerShape(26.dp)
    val surface = if (darkMode) Color(0xFF18181B) else Color.White
    val fieldColor = if (darkMode) Color(0xFF09090B) else Color(0xFFF7F7F7)
    val secondaryButton = if (darkMode) Color(0xFF27272A) else Color(0xFFF3F3F3)
    var name by remember(session.id) { mutableStateOf(session.title) }
    val trimmed = name.trim()
    val canSave = trimmed.isNotEmpty() && trimmed != session.title.trim()

    fun submit() {
        if (canSave) onSave(trimmed)
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 22.dp)
                .widthIn(max = 380.dp)
                .shadow(34.dp, shape, ambientColor = Color(0x33000000), spotColor = Color(0x33000000))
                .clip(shape)
                .background(surface)
                .border(1.dp, colors.border, shape)
                .padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text(
                text = stringResource(R.string.home_rename_session),
                color = colors.ink,
                fontSize = 24.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 29.sp,
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(fieldColor)
                    .border(1.dp, colors.border, RoundedCornerShape(16.dp))
                    .padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AndroidView(
                    factory = { viewContext ->
                        EditText(viewContext).apply {
                            configureRenameInput(colors.ink, onDone = { submit() })
                            setText(name)
                            setSelection(text.length)
                            addTextChangedListener(
                                object : TextWatcher {
                                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                                    override fun afterTextChanged(s: Editable?) {
                                        val next = s?.toString().orEmpty()
                                        if (next != name) name = next
                                    }
                                },
                            )
                            post { focusAtTextEnd(viewContext) }
                            postDelayed({ focusAtTextEnd(viewContext, forceKeyboard = true) }, 180L)
                        }
                    },
                    update = { input ->
                        input.configureRenameInput(colors.ink, onDone = { submit() })
                        if (input.text.toString() != name) {
                            input.setText(name)
                            input.setSelection(input.text.length)
                            input.bringPointIntoView(input.selectionEnd)
                        }
                    },
                    modifier = Modifier.weight(1f),
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                HomeDialogButton(
                    label = stringResource(R.string.common_cancel),
                    background = secondaryButton,
                    content = colors.ink,
                    modifier = Modifier.weight(1f),
                    onClick = onDismiss,
                )
                HomeDialogButton(
                    label = stringResource(R.string.common_save),
                    background = colors.primaryAction.copy(alpha = if (canSave) 1f else 0.38f),
                    content = colors.onPrimaryAction,
                    modifier = Modifier.weight(1f),
                    onClick = { submit() },
                )
            }
        }
    }
}

private fun String.sessionDisplayTitle(): String {
    if (length <= SESSION_TITLE_DISPLAY_MAX_CHARS) return this
    return "${take(SESSION_TITLE_DISPLAY_MAX_CHARS).trimEnd()}..."
}

private fun EditText.configureRenameInput(
    textColor: Color,
    onDone: () -> Unit,
) {
    isFocusable = true
    isFocusableInTouchMode = true
    setSingleLine(true)
    setHorizontallyScrolling(true)
    setBackgroundColor(android.graphics.Color.TRANSPARENT)
    setTextColor(textColor.toArgb())
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    gravity = Gravity.CENTER_VERTICAL
    includeFontPadding = false
    minHeight = 0
    minimumHeight = 0
    setPadding(0, 0, 0, 0)
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    imeOptions = EditorInfo.IME_ACTION_DONE
    setOnEditorActionListener { _, actionId, _ ->
        if (actionId == EditorInfo.IME_ACTION_DONE) {
            onDone()
            true
        } else {
            false
        }
    }
}

@Suppress("DEPRECATION")
private fun EditText.focusAtTextEnd(
    context: android.content.Context,
    forceKeyboard: Boolean = false,
) {
    requestFocus()
    setSelection(text.length)
    post {
        setSelection(text.length)
        bringPointIntoView(selectionEnd)
        context.getSystemService(InputMethodManager::class.java)?.showSoftInput(
            this,
            if (forceKeyboard) InputMethodManager.SHOW_FORCED else InputMethodManager.SHOW_IMPLICIT,
        )
    }
}

@Composable
private fun HomeDialogButton(
    label: String,
    background: Color,
    content: Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .height(50.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(background)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = content,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 19.sp,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeContent(
    navigate: (AppDestination) -> Unit,
    state: SessionsState,
    selectedTab: HomeTab,
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    onTabSelected: (HomeTab) -> Unit,
    onProfile: () -> Unit,
    onSearch: () -> Unit,
    onSessionLongPress: (AgentSession, Rect) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
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
        HomeTabs(selectedTab = selectedTab, onTabSelected = onTabSelected)
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
            HomeList(
                state = state,
                tab = selectedTab,
                darkMode = darkMode,
                onSessionLongPress = onSessionLongPress,
                onOpenSession = onOpenSession,
                onOpenDevice = onOpenDevice,
                onCreateSession = { navigate(AppDestination.NewSession) },
                onPairDevice = onPairDevice,
            )
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
            surface = if (darkMode) Color(0xFF18181B) else Color.White,
            border = if (darkMode) Color(0xFF27272A) else Color(0xFFE7E6E2),
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
    val surface = if (darkMode) Color(0xFF18181B) else Color.White
    val border = if (darkMode) Color.White.copy(alpha = 0.12f) else Color(0xFFE7E6E2)

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
private fun HomeList(
    state: SessionsState,
    tab: HomeTab,
    darkMode: Boolean,
    onSessionLongPress: (AgentSession, Rect) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
    onCreateSession: () -> Unit,
    onPairDevice: () -> Unit,
) {
    val devices = remember(state.devices) { state.devices.sortedForDevicesPage() }
    val sessions = if (tab == HomeTab.Active) state.sessions else state.archivedSessions
    val hasAnySessions = state.sessions.isNotEmpty() || state.archivedSessions.isNotEmpty()
    when {
        state.isLoading && !state.hasLoaded -> HomeLoadingState()
        state.errorMessage != null && !state.hasLoaded -> AuthErrorNotice(
            message = state.errorMessage,
            modifier = Modifier.padding(top = 10.dp),
        )
        tab == HomeTab.Devices && devices.isEmpty() -> AppEmptyState(
            message = stringResource(R.string.home_devices_empty),
            buttonLabel = stringResource(R.string.home_pair_new_device),
            buttonIcon = Lucide.Monitor,
            onButtonClick = onPairDevice,
            contentOffsetY = (-32).dp,
        )
        tab == HomeTab.Devices -> DeviceList(devices = devices, darkMode = darkMode, onOpenDevice = onOpenDevice)
        devices.isEmpty() -> AppEmptyState(
            message = stringResource(R.string.home_pair_device_first),
            buttonLabel = stringResource(R.string.home_pair_new_device),
            buttonIcon = Lucide.Monitor,
            onButtonClick = onPairDevice,
            contentOffsetY = (-32).dp,
        )
        sessions.isEmpty() && !hasAnySessions -> AppEmptyState(
            message = stringResource(if (tab == HomeTab.Active) R.string.home_no_active_sessions_create else R.string.home_no_archived_sessions_yet),
            buttonLabel = stringResource(R.string.home_create_new_session),
            buttonIcon = Lucide.Plus,
            onButtonClick = onCreateSession,
        )
        sessions.isEmpty() -> EmptyListText(
            stringResource(if (tab == HomeTab.Active) R.string.home_no_active_sessions else R.string.home_no_archived_sessions)
        )
        else -> SessionList(
            sessions = sessions,
            onSessionLongPress = onSessionLongPress,
            onOpenSession = onOpenSession,
        )
    }
}

@Composable
private fun HomeLoadingState() {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val baseColor = if (darkMode) Color(0xFF1E1E22) else Color(0xFFEDEBE6)

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .shimmer()
            .padding(top = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(bottom = 96.dp),
    ) {
        item(key = "loading-label") {
            SkeletonLine(
                modifier = Modifier
                    .padding(horizontal = 24.dp)
                    .width(84.dp)
                    .height(16.dp),
                baseColor = baseColor,
                shape = CircleShape,
            )
        }
        items(6, key = { "loading-session-$it" }) { index ->
            SessionRowSkeleton(
                index = index,
                baseColor = baseColor,
                modifier = Modifier.padding(horizontal = 24.dp),
            )
        }
    }
}

@Composable
private fun SessionRowSkeleton(
    index: Int,
    baseColor: Color,
    modifier: Modifier = Modifier,
) {
    val titleWidth = listOf(0.78f, 0.62f, 0.84f, 0.70f, 0.58f, 0.76f)[index % 6]
    val summaryWidth = listOf(0.92f, 0.84f, 0.74f, 0.88f, 0.80f, 0.68f)[index % 6]
    val metaWidth = listOf(0.50f, 0.42f, 0.56f, 0.46f, 0.38f, 0.52f)[index % 6]

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(82.dp),
    ) {
        SkeletonLine(
            modifier = Modifier
                .align(Alignment.TopStart)
                .fillMaxWidth(titleWidth)
                .height(20.dp),
            baseColor = baseColor,
            shape = RoundedCornerShape(8.dp),
        )
        SkeletonLine(
            modifier = Modifier
                .align(Alignment.TopStart)
                .offset(y = 34.dp)
                .fillMaxWidth(summaryWidth)
                .height(15.dp),
            baseColor = baseColor,
            shape = RoundedCornerShape(7.dp),
        )
        SkeletonLine(
            modifier = Modifier
                .align(Alignment.TopStart)
                .offset(y = 62.dp)
                .fillMaxWidth(metaWidth)
                .height(13.dp),
            baseColor = baseColor,
            shape = RoundedCornerShape(7.dp),
        )
    }
}

@Composable
private fun SkeletonLine(
    modifier: Modifier,
    baseColor: Color,
    shape: androidx.compose.ui.graphics.Shape,
) {
    Box(
        modifier = modifier
            .clip(shape)
            .background(baseColor),
    )
}

@Composable
private fun SessionList(
    sessions: List<AgentSession>,
    onSessionLongPress: (AgentSession, Rect) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
) {
    var pinnedExpanded by remember(sessions) { mutableStateOf(true) }
    var recentExpanded by remember(sessions) { mutableStateOf(true) }
    val pinned = remember(sessions) { SessionsState(sessions = sessions).pinnedSessions }
    val recent = remember(sessions) { SessionsState(sessions = sessions).recentSessions }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 96.dp),
    ) {
        if (sessions.isEmpty()) {
            item("empty") { EmptyListText(stringResource(R.string.home_no_sessions_yet)) }
        }
        item("pinned-title") {
            HomeSectionHeader(
                label = stringResource(R.string.home_pinned),
                expanded = pinnedExpanded,
                onClick = { pinnedExpanded = !pinnedExpanded },
            )
        }
        if (pinnedExpanded) {
            if (pinned.isEmpty()) {
                item("pinned-empty") { SectionEmptyText(stringResource(R.string.home_no_pinned_sessions)) }
            } else {
                items(pinned, key = { "pinned-${it.id}" }) { session ->
                    HomePinnedSessionRow(
                        session = session,
                        showDivider = session.id != pinned.lastOrNull()?.id,
                        onClick = { onOpenSession(session) },
                        onLongPress = { bounds -> onSessionLongPress(session, bounds) },
                    )
                }
            }
        }
        item("recent-title") {
            HomeSectionHeader(
                label = stringResource(R.string.home_recents),
                expanded = recentExpanded,
                onClick = { recentExpanded = !recentExpanded },
            )
        }
        if (recentExpanded) {
            if (recent.isEmpty()) {
                item("recent-empty") { SectionEmptyText(stringResource(R.string.home_no_recent_sessions)) }
            } else {
                items(recent, key = { "recent-${it.id}" }) { session ->
                    HomeRecentSessionRow(
                        session = session,
                        onClick = { onOpenSession(session) },
                        onLongPress = { bounds -> onSessionLongPress(session, bounds) },
                    )
                }
            }
        }
    }
}

@Composable
private fun DeviceList(
    devices: List<AgentDevice>,
    darkMode: Boolean,
    onOpenDevice: (AgentDevice) -> Unit,
) {
    val onlineDevices = remember(devices) { devices.filter { it.online } }
    val offlineDevices = remember(devices) { devices.filterNot { it.online } }
    var onlineExpanded by remember(devices) { mutableStateOf(true) }
    var offlineExpanded by remember(devices) { mutableStateOf(true) }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = PaddingValues(bottom = 96.dp),
    ) {
        if (onlineDevices.isNotEmpty()) {
            item("online-title") {
                HomeSectionHeader(
                    label = stringResource(R.string.home_online),
                    expanded = onlineExpanded,
                    onClick = { onlineExpanded = !onlineExpanded },
                )
            }
            if (onlineExpanded) {
                items(onlineDevices, key = { "online-${it.id}" }) { device ->
                    DeviceRow(
                        device = device,
                        darkMode = darkMode,
                        onClick = { onOpenDevice(device) },
                    )
                }
            }
        }
        if (offlineDevices.isNotEmpty()) {
            item("offline-title") {
                HomeSectionHeader(
                    label = stringResource(R.string.home_offline),
                    expanded = offlineExpanded,
                    onClick = { offlineExpanded = !offlineExpanded },
                )
            }
            if (offlineExpanded) {
                items(offlineDevices, key = { "offline-${it.id}" }) { device ->
                    DeviceRow(
                        device = device,
                        darkMode = darkMode,
                        onClick = { onOpenDevice(device) },
                    )
                }
            }
        }
    }
}

@Composable
private fun HomeSectionHeader(
    label: String,
    expanded: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val haptic = LocalHapticFeedback.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(41.dp)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            modifier = Modifier.weight(1f),
            color = colors.faint,
            fontSize = 13.2.sp,
            fontWeight = FontWeight.ExtraBold,
            maxLines = 1,
        )
        Icon(
            imageVector = Lucide.ChevronDown,
            contentDescription = null,
            tint = colors.faint,
            modifier = Modifier
                .size(16.dp)
                .graphicsLayer { rotationZ = if (expanded) 0f else -90f },
        )
    }
}

@Composable
private fun HomePinnedSessionRow(
    session: AgentSession,
    showDivider: Boolean,
    onClick: () -> Unit,
    onLongPress: (Rect) -> Unit,
) {
    val subtitle = listOf(session.runtimeLabel, session.workspaceLabel)
        .filter { it.isNotBlank() }
        .joinToString("  ·  ")

    HomeSessionRowShell(
        height = 66.dp,
        showDivider = showDivider,
        onClick = onClick,
        onLongPress = onLongPress,
    ) {
        Icon(Lucide.ListIcon, contentDescription = null, tint = LocalAAColors.current.faint, modifier = Modifier.size(14.dp))
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = session.title.sessionDisplayTitle(),
                color = LocalAAColors.current.inkSoft,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                lineHeight = 20.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = subtitle,
                color = LocalAAColors.current.faint,
                fontSize = 11.2.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            text = session.updatedAtLabel.ifBlank { "now" },
            color = LocalAAColors.current.faint,
            fontSize = 10.8.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun HomeRecentSessionRow(
    session: AgentSession,
    onClick: () -> Unit,
    onLongPress: (Rect) -> Unit,
) {
    HomeSessionRowShell(height = 52.dp, onClick = onClick, onLongPress = onLongPress) {
        Icon(Lucide.ListIcon, contentDescription = null, tint = LocalAAColors.current.faint, modifier = Modifier.size(14.dp))
        Text(
            text = session.title.sessionDisplayTitle(),
            modifier = Modifier.weight(1f),
            color = LocalAAColors.current.inkSoft,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 20.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = session.updatedAtLabel.ifBlank { "now" },
            color = LocalAAColors.current.faint,
            fontSize = 10.8.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun HomeSessionRowShell(
    height: androidx.compose.ui.unit.Dp,
    showDivider: Boolean = true,
    onClick: () -> Unit,
    onLongPress: (Rect) -> Unit,
    content: @Composable RowScope.() -> Unit,
) {
    val colors = LocalAAColors.current
    val haptic = LocalHapticFeedback.current
    var bounds by remember { mutableStateOf(Rect.Zero) }

    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(height)
                .onGloballyPositioned { bounds = it.boundsInRoot() }
                .pointerInput(onClick, onLongPress, bounds) {
                    detectTapGestures(
                        onTap = { onClick() },
                        onLongPress = {
                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                            onLongPress(bounds)
                        },
                    )
                }
                .padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
        if (showDivider) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(if (colors.canvas == Color(0xFF09090B)) Color(0xFF27272A) else Color(0xFFE9E8E5)),
            )
        }
    }
}

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

@Composable
private fun EmptyListText(message: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(180.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = message,
            color = LocalAAColors.current.faint,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun SectionEmptyText(message: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(42.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            text = message,
            color = LocalAAColors.current.faint,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}
