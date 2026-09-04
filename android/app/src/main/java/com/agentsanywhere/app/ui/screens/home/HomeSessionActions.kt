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
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.listIndicator
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import kotlin.math.roundToInt

internal data class HomeSessionActionMenu(
    val session: AgentSession,
    val rowBounds: Rect,
)

private const val SESSION_TITLE_DISPLAY_MAX_CHARS = 15

@Composable
internal fun HomeSessionActionOverlay(
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
internal fun HomeSessionHighlightRow(session: AgentSession, darkMode: Boolean) {
    val indicator = session.listIndicator()
    val subtitle = listOf(session.runtimeContextLabel, session.workspaceLabel)
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
        SessionRowLeading(indicator = indicator)
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
        SessionRowTrailing(session = session, indicator = indicator, timeColor = meta)
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
internal fun HomeRenameSessionDialog(
    session: AgentSession,
    errorMessage: String?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val shape = RoundedCornerShape(26.dp)
    val surface = colors.dialogSurface
    val fieldColor = if (darkMode) Color(0xFF09090B) else Color(0xFFF7F7F7)
    val secondaryButton = colors.secondaryActionSurface
    var name by remember(session.id) { mutableStateOf(session.title) }
    var fieldError by remember(session.id, errorMessage) { mutableStateOf(errorMessage) }
    val titleRequired = stringResource(R.string.home_title_required)
    val canSave = name != session.title && !busy

    fun submit() {
        when {
            busy || name == session.title -> Unit
            name.isEmpty() -> fieldError = titleRequired
            else -> onSave(name)
        }
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
                                        if (next != name) {
                                            name = next
                                            fieldError = null
                                        }
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
            fieldError?.let { message ->
                Text(
                    text = message,
                    color = colors.errorText,
                    fontSize = 13.sp,
                    lineHeight = 17.sp,
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

internal fun String.sessionDisplayTitle(): String {
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
