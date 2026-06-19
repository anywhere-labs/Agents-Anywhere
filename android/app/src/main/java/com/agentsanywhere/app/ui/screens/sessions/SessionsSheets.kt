package com.agentsanywhere.app.ui.screens.sessions

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.SessionFilterOption
import com.agentsanywhere.app.feature.sessions.SessionFilterPage
import com.agentsanywhere.app.feature.sessions.SessionFilterState
import com.agentsanywhere.app.feature.sessions.filterOptionsFor
import com.agentsanywhere.app.feature.sessions.updatedFor
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.CloseGlyph
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionActionsSheet(
    session: AgentSession,
    onDismiss: () -> Unit,
    onRename: () -> Unit,
    onTogglePinned: () -> Unit,
    onArchive: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val sheetColor = if (darkMode) Color(0xFF18181B) else Color.White
    val titleColor = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF111111)
    val metaColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF8A8A8A)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = sheetColor,
        contentColor = titleColor,
        scrimColor = if (darkMode) Color(0x66000000) else Color(0x30000000),
        dragHandle = {
            SheetHandle(color = if (darkMode) Color(0xFF3F3F46) else Color(0xFFD8D8D8))
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(start = 22.dp, end = 22.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp, vertical = 2.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    text = session.title,
                    color = titleColor,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.ExtraBold,
                    lineHeight = 22.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = session.metaLabel,
                    color = metaColor,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    lineHeight = 16.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                SessionActionRow(
                    label = "Rename",
                    color = titleColor,
                    onClick = onRename,
                    iconRes = if (darkMode) {
                        R.drawable.ic_session_action_rename_white
                    } else {
                        R.drawable.ic_session_action_rename_black
                    },
                )
                SessionActionRow(
                    label = if (session.pinned) "Unpin" else "Pin",
                    color = titleColor,
                    onClick = onTogglePinned,
                    iconRes = if (darkMode) {
                        R.drawable.ic_session_action_unpin_white
                    } else {
                        R.drawable.ic_session_action_unpin_black
                    },
                )
                SessionActionRow(
                    label = "Archive",
                    color = titleColor,
                    onClick = onArchive,
                    iconRes = if (darkMode) {
                        R.drawable.ic_session_action_archive_white
                    } else {
                        R.drawable.ic_session_action_archive_black
                    },
                )
            }
        }
    }
}

@Composable
private fun SessionActionRow(
    label: String,
    color: Color,
    onClick: () -> Unit,
    iconRes: Int,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .clip(RoundedCornerShape(14.dp))
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Image(
            painter = painterResource(iconRes),
            contentDescription = null,
            modifier = Modifier.size(22.dp),
        )
        Text(
            text = label,
            color = color,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 20.sp,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RenameSessionSheet(
    session: AgentSession,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val sheetColor = if (darkMode) Color(0xFF18181B) else Color.White
    val titleColor = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF111111)
    val fieldColor = if (darkMode) Color(0xFF09090B) else Color(0xFFF7F7F7)
    val secondaryButtonColor = if (darkMode) Color(0xFF27272A) else Color(0xFFF3F3F3)
    var name by remember(session.id) { mutableStateOf(session.title) }
    val trimmed = name.trim()
    val canSave = trimmed.isNotEmpty() && trimmed != session.title.trim()

    fun submit() {
        if (canSave) onSave(trimmed)
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = sheetColor,
        contentColor = titleColor,
        scrimColor = if (darkMode) Color(0x66000000) else Color(0x30000000),
        dragHandle = {
            SheetHandle(color = if (darkMode) Color(0xFF3F3F46) else Color(0xFFD8D8D8))
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(start = 22.dp, end = 22.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 4.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    text = "Rename session",
                    color = titleColor,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.ExtraBold,
                    lineHeight = 24.sp,
                )
                Text(
                    text = "Update the name shown in your sessions list.",
                    color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 16.sp,
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(58.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(fieldColor)
                    .border(1.dp, colors.border, RoundedCornerShape(16.dp))
                    .padding(start = 14.dp, end = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                BasicTextField(
                    value = name,
                    onValueChange = { name = it },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    textStyle = androidx.compose.ui.text.TextStyle(
                        color = titleColor,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                    ),
                    cursorBrush = SolidColor(titleColor),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { submit() }),
                )
                if (name.isNotEmpty()) {
                    Box(
                        modifier = Modifier
                            .size(30.dp)
                            .clip(CircleShape)
                            .background(if (darkMode) Color(0xFF27272A) else Color(0xFFE8E8E8))
                            .noRippleClickable { name = "" },
                        contentAlignment = Alignment.Center,
                    ) {
                        CloseGlyph(
                            color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF666666),
                            sizeDp = 15,
                        )
                    }
                }
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                SheetButton(
                    label = "Cancel",
                    modifier = Modifier.weight(1f),
                    background = secondaryButtonColor,
                    content = titleColor,
                    onClick = onDismiss,
                )
                SheetButton(
                    label = "Save",
                    modifier = Modifier.weight(1f),
                    background = if (canSave) colors.primaryAction else colors.primaryAction.copy(alpha = 0.38f),
                    content = colors.onPrimaryAction,
                    onClick = {
                        if (canSave) submit()
                    },
                )
            }
        }
    }
}

@Composable
private fun SheetButton(
    label: String,
    modifier: Modifier,
    background: Color,
    content: Color,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(52.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(background)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = content,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 20.sp,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun FilterBottomSheet(
    initialPage: SessionFilterPage,
    sessions: List<AgentSession>,
    devices: List<AgentDevice>,
    filters: SessionFilterState,
    onFiltersChange: (SessionFilterState) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val sheetColor = if (darkMode) Color(0xFF18181B) else Color.White
    var pageIndex by remember(initialPage) { mutableIntStateOf(initialPage.ordinal) }
    val page = SessionFilterPage.entries[pageIndex]
    val options = remember(page, sessions, devices, filters) {
        filterOptionsFor(page, sessions, devices, filters)
    }
    fun previousPage() {
        pageIndex = (pageIndex + SessionFilterPage.entries.lastIndex) % SessionFilterPage.entries.size
    }
    fun nextPage() {
        pageIndex = (pageIndex + 1) % SessionFilterPage.entries.size
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = sheetColor,
        contentColor = colors.ink,
        scrimColor = if (darkMode) Color(0x66000000) else Color(0x30000000),
        dragHandle = {
            SheetHandle(color = if (darkMode) Color(0xFF3F3F46) else Color(0xFFD8D8D8))
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(start = 22.dp, end = 22.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            FilterSheetNavigation(
                page = page,
                onPrevious = ::previousPage,
                onNext = ::nextPage,
            )
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 360.dp),
                verticalArrangement = Arrangement.spacedBy(1.dp),
            ) {
                items(options, key = { it.value ?: "all-${page.name}" }) { option ->
                    FilterOptionRow(
                        option = option,
                        page = page,
                        onClick = {
                            if (option.enabled) {
                                onFiltersChange(filters.updatedFor(page, option.value))
                            }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun SheetHandle(color: Color) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(20.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .width(42.dp)
                .height(4.dp)
                .clip(CircleShape)
                .background(color),
        )
    }
}

@Composable
private fun FilterSheetNavigation(
    page: SessionFilterPage,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
) {
    val colors = LocalAAColors.current
    val haptic = LocalHapticFeedback.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val titleColor = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF111111)
    val iconColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFFB6B6B6)
    val inactiveDot = if (darkMode) Color(0xFF3F3F46) else Color(0xFFD3D3D3)
    val activeDot = if (darkMode) titleColor else Color(0xFF34342F)

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(50.dp),
    ) {
        Box(
            modifier = Modifier
                .align(Alignment.TopStart)
                .size(44.dp)
                .noRippleClickable {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    onPrevious()
                },
            contentAlignment = Alignment.CenterStart,
        ) {
            ChevronSide(color = iconColor, forward = false)
        }
        Text(
            text = page.title,
            modifier = Modifier.align(Alignment.TopCenter),
            color = titleColor,
            fontSize = 18.sp,
            fontWeight = FontWeight.ExtraBold,
            lineHeight = 22.sp,
        )
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .size(44.dp)
                .noRippleClickable {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    onNext()
                },
            contentAlignment = Alignment.CenterEnd,
        ) {
            ChevronSide(color = iconColor, forward = true)
        }
        Row(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .height(10.dp),
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SessionFilterPage.entries.forEach { dotPage ->
                val active = dotPage == page
                Box(
                    modifier = Modifier
                        .width(if (active) 18.dp else 6.dp)
                        .height(6.dp)
                        .clip(CircleShape)
                        .background(if (active) activeDot else inactiveDot),
                )
            }
        }
    }
}

@Composable
private fun FilterOptionRow(
    option: SessionFilterOption,
    page: SessionFilterPage,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val selectedColor = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF111111)
    val normalColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF77736C)
    val disabledColor = if (darkMode) Color(0xFF52525B) else Color(0xFFB8B8B8)
    val textColor = when {
        !option.enabled -> disabledColor
        option.selected -> selectedColor
        else -> normalColor
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(42.dp)
            .clip(RoundedCornerShape(12.dp))
            .noRippleClickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            FilterRadio(selected = option.selected, enabled = option.enabled)
            Text(
                text = option.label,
                color = textColor,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 20.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun FilterRadio(
    selected: Boolean,
    enabled: Boolean,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val borderColor = when {
        selected && darkMode -> Color(0xFFA1A1AA)
        selected -> Color(0xFF6E6A62)
        darkMode -> Color(0xFF3F3F46)
        else -> Color(0xFFE0E0E0)
    }.copy(alpha = if (enabled) 1f else 0.75f)
    val fillColor = if (darkMode) Color(0xFF18181B) else Color.White
    val selectedFill = if (darkMode) Color(0xFFD4D4D8) else Color(0xFF6E6A62)
    val selectedBackground = if (darkMode) Color(0xFF18181B) else Color.White

    Box(
        modifier = Modifier
            .size(28.dp)
            .clip(CircleShape)
            .background(if (selected) selectedBackground else fillColor)
            .border(2.dp, borderColor, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(selectedFill),
            )
        }
    }
}

@Composable
private fun ChevronSide(
    color: Color,
    forward: Boolean,
) {
    Canvas(modifier = Modifier.size(22.dp)) {
        val x1 = if (forward) size.width * 0.36f else size.width * 0.64f
        val x2 = if (forward) size.width * 0.64f else size.width * 0.36f
        drawLine(
            color = color,
            start = Offset(x1, size.height * 0.24f),
            end = Offset(x2, size.height * 0.50f),
            strokeWidth = 2.5.dp.toPx(),
            cap = StrokeCap.Round,
        )
        drawLine(
            color = color,
            start = Offset(x2, size.height * 0.50f),
            end = Offset(x1, size.height * 0.76f),
            strokeWidth = 2.5.dp.toPx(),
            cap = StrokeCap.Round,
        )
    }
}
