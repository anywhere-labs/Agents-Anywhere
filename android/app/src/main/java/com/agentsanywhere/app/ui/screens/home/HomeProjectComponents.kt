package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentsanywhere.app.R
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.Archive
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.Pin
import kotlin.math.roundToInt

internal data class HomeProjectActionMenu(
    val project: AgentProject,
    val rowBounds: Rect,
)

@Composable
internal fun HomeProjectList(
    projects: List<AgentProject>,
    pinnedSessions: List<AgentSession>,
    sessionsByProject: Map<String, List<AgentSession>>,
    loadingProjectIds: Set<String>,
    expandedProjectIds: Set<String>,
    onProjectExpandedChange: (AgentProject, Boolean) -> Unit,
    onProjectLongPress: (AgentProject, Rect) -> Unit,
    onNewSession: (AgentProject) -> Unit,
    onSessionLongPress: (AgentSession, Rect) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
) {
    var pinnedExpanded by remember { mutableStateOf(true) }
    var projectsExpanded by remember { mutableStateOf(true) }
    val pinnedProjects = remember(projects) {
        projects.filter(AgentProject::pinned).sortedWith(projectComparator())
    }
    val regularProjects = remember(projects) {
        projects.filterNot(AgentProject::pinned)
            .sortedWith(compareByDescending<AgentProject> { it.createdAt }.thenBy { it.name.lowercase() })
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 96.dp),
    ) {
        if (pinnedProjects.isNotEmpty() || pinnedSessions.isNotEmpty()) {
            item("project-pinned-title") {
                HomeProjectSectionHeader(
                    label = stringResource(R.string.home_pinned),
                    expanded = pinnedExpanded,
                    onClick = { pinnedExpanded = !pinnedExpanded },
                )
            }
            if (pinnedExpanded) {
                items(pinnedProjects, key = { "pinned-project-${it.id}" }) { project ->
                    HomeProjectTreeItem(
                        project = project,
                        sessions = sessionsByProject[project.id].orEmpty().filterNot(AgentSession::pinned),
                        expanded = project.id in expandedProjectIds,
                        loading = project.id in loadingProjectIds,
                        onExpandedChange = { onProjectExpandedChange(project, it) },
                        onLongPress = { onProjectLongPress(project, it) },
                        onNewSession = { onNewSession(project) },
                        onSessionLongPress = onSessionLongPress,
                        onOpenSession = onOpenSession,
                    )
                }
                items(pinnedSessions, key = { "pinned-session-${it.id}" }) { session ->
                    HomePinnedSessionRow(
                        session = session,
                        showDivider = true,
                        onClick = { onOpenSession(session) },
                        onLongPress = { onSessionLongPress(session, it) },
                    )
                }
            }
        }

        item("projects-title") {
            HomeProjectSectionHeader(
                label = stringResource(R.string.home_projects),
                expanded = projectsExpanded,
                onClick = { projectsExpanded = !projectsExpanded },
            )
        }
        if (projectsExpanded) {
            if (regularProjects.isEmpty()) {
                item("projects-empty") {
                    HomeProjectEmptyText(stringResource(R.string.home_no_projects))
                }
            } else {
                items(regularProjects, key = { "project-${it.id}" }) { project ->
                    HomeProjectTreeItem(
                        project = project,
                        sessions = sessionsByProject[project.id].orEmpty().filterNot(AgentSession::pinned),
                        expanded = project.id in expandedProjectIds,
                        loading = project.id in loadingProjectIds,
                        onExpandedChange = { onProjectExpandedChange(project, it) },
                        onLongPress = { onProjectLongPress(project, it) },
                        onNewSession = { onNewSession(project) },
                        onSessionLongPress = onSessionLongPress,
                        onOpenSession = onOpenSession,
                    )
                }
            }
        }
    }
}

private fun projectComparator(): Comparator<AgentProject> =
    compareByDescending<AgentProject> { it.pinnedAt.orEmpty() }
        .thenByDescending { it.lastActivityAt.orEmpty() }
        .thenBy { it.name.lowercase() }

@Composable
private fun HomeProjectTreeItem(
    project: AgentProject,
    sessions: List<AgentSession>,
    expanded: Boolean,
    loading: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onLongPress: (Rect) -> Unit,
    onNewSession: () -> Unit,
    onSessionLongPress: (AgentSession, Rect) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
) {
    HomeProjectRow(
        project = project,
        expanded = expanded,
        onClick = { onExpandedChange(!expanded) },
        onLongPress = onLongPress,
        onNewSession = onNewSession,
    )
    if (expanded) {
        when {
            loading -> Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp)
                    .padding(start = 38.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    color = LocalAAColors.current.muted,
                    strokeWidth = 2.dp,
                )
            }

            sessions.isEmpty() -> Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(42.dp)
                    .padding(start = 38.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(
                    text = stringResource(R.string.home_project_no_sessions),
                    color = LocalAAColors.current.faint,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }

            else -> sessions.forEach { session ->
                Box(modifier = Modifier.padding(start = 34.dp)) {
                    HomeRecentSessionRow(
                        session = session,
                        onClick = { onOpenSession(session) },
                        onLongPress = { onSessionLongPress(session, it) },
                    )
                }
            }
        }
    }
}

@Composable
private fun HomeProjectRow(
    project: AgentProject,
    expanded: Boolean,
    onClick: () -> Unit,
    onLongPress: (Rect) -> Unit,
    onNewSession: () -> Unit,
) {
    val colors = LocalAAColors.current
    val haptic = LocalHapticFeedback.current
    var bounds by remember { mutableStateOf(Rect.Zero) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
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
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            imageVector = Lucide.Folder,
            contentDescription = null,
            tint = colors.faint,
            modifier = Modifier.size(21.dp),
        )
        Text(
            text = project.name,
            modifier = Modifier.weight(1f),
            color = colors.inkSoft,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Icon(
            imageVector = Lucide.ChevronDown,
            contentDescription = null,
            tint = colors.faint,
            modifier = Modifier
                .size(16.dp)
                .graphicsLayer { rotationZ = if (expanded) 0f else -90f },
        )
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onNewSession,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Lucide.Pencil,
                contentDescription = stringResource(R.string.home_new_session_in_project, project.name),
                tint = colors.faint,
                modifier = Modifier.size(19.dp),
            )
        }
    }
}

@Composable
private fun HomeProjectSectionHeader(
    label: String,
    expanded: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(41.dp)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            ),
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
private fun HomeProjectEmptyText(message: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(110.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = message,
            color = LocalAAColors.current.faint,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
internal fun HomeProjectActionOverlay(
    menu: HomeProjectActionMenu,
    onDismiss: () -> Unit,
    onEdit: () -> Unit,
    onTogglePinned: () -> Unit,
    onArchive: () -> Unit,
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
        val menuY = if (belowY + menuHeightPx + marginPx <= screenHeightPx) belowY else aboveY.coerceAtLeast(marginPx)

        Box(
            modifier = Modifier
                .offset { IntOffset(row.left.roundToInt(), row.top.roundToInt()) }
                .width(with(density) { row.width.toDp() })
                .height(with(density) { row.height.toDp() })
                .shadow(18.dp, highlightShape)
                .clip(highlightShape)
                .background(if (darkMode) Color(0xFF202020) else Color.White),
        ) {
            HomeProjectHighlightRow(menu.project)
        }
        HomeProjectActionCard(
            project = menu.project,
            modifier = Modifier.offset { IntOffset(menuX.roundToInt(), menuY.roundToInt()) },
            onEdit = onEdit,
            onTogglePinned = onTogglePinned,
            onArchive = onArchive,
        )
    }
}

@Composable
private fun HomeProjectHighlightRow(project: AgentProject) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(Lucide.Folder, contentDescription = null, tint = colors.faint, modifier = Modifier.size(21.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = project.name,
                color = colors.inkSoft,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = project.workspacePath,
                color = colors.faint,
                fontSize = 11.2.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun HomeProjectActionCard(
    project: AgentProject,
    modifier: Modifier,
    onEdit: () -> Unit,
    onTogglePinned: () -> Unit,
    onArchive: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val surface = if (darkMode) Color(0xFF181818) else Color.White
    val border = if (darkMode) Color(0xFF2D2D2F) else Color(0xFFEFEDE9)
    Column(
        modifier = modifier
            .width(252.dp)
            .height(168.dp)
            .shadow(34.dp, RoundedCornerShape(22.dp))
            .clip(RoundedCornerShape(22.dp))
            .background(surface)
            .border(1.dp, border, RoundedCornerShape(22.dp))
            .padding(vertical = 7.dp),
    ) {
        HomeProjectActionRow(Lucide.Pencil, stringResource(R.string.home_project_edit), false, onEdit)
        HomeProjectActionRow(
            Lucide.Pin,
            stringResource(if (project.pinned) R.string.home_project_unpin else R.string.home_project_pin),
            false,
            onTogglePinned,
        )
        HomeProjectActionRow(Lucide.Archive, stringResource(R.string.home_project_archive), true, onArchive)
    }
}

@Composable
private fun HomeProjectActionRow(
    icon: ImageVector,
    label: String,
    danger: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val tint = if (danger) {
        if (darkMode) Color(0xFFF87171) else Color(0xFFB94848)
    } else {
        colors.ink
    }
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
        Text(label, color = tint, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(21.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HomeProjectEditSheet(
    project: AgentProject,
    deviceName: String,
    busy: Boolean,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    var name by remember(project.id, project.name) { mutableStateOf(project.name) }
    val canSave = !busy && name.trim().isNotEmpty() && name.trim() != project.name

    ModalBottomSheet(
        onDismissRequest = { if (!busy) onDismiss() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = colors.raisedSurface,
        contentColor = colors.ink,
        dragHandle = null,
        scrimColor = if (darkMode) Color(0x99000000) else Color(0x66000000),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(start = 22.dp, end = 22.dp, top = 12.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(modifier = Modifier.fillMaxWidth().height(12.dp), contentAlignment = Alignment.Center) {
                Box(
                    modifier = Modifier
                        .width(40.dp)
                        .height(4.dp)
                        .clip(CircleShape)
                        .background(if (darkMode) Color(0xFF3F3F46) else Color(0xFFD8D6D0)),
                )
            }
            Text(
                text = stringResource(R.string.home_project_edit_title),
                color = colors.ink,
                fontSize = 22.sp,
                fontWeight = FontWeight.ExtraBold,
            )
            ProjectFieldLabel(stringResource(R.string.home_project_name))
            BasicTextField(
                value = name,
                onValueChange = { if (it.length <= 255) name = it },
                enabled = !busy,
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(50.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (darkMode) Color(0xFF111113) else Color(0xFFF7F7F5))
                    .border(1.dp, colors.border, RoundedCornerShape(12.dp))
                    .padding(horizontal = 14.dp),
                textStyle = TextStyle(color = colors.ink, fontSize = 16.sp, fontWeight = FontWeight.Bold),
                cursorBrush = SolidColor(colors.ink),
                decorationBox = { inner -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.CenterStart) { inner() } },
            )
            ProjectFieldLabel(stringResource(R.string.home_project_device))
            ProjectReadOnlyField(deviceName)
            ProjectFieldLabel(stringResource(R.string.home_project_path))
            ProjectReadOnlyField(project.workspacePath, monospace = true)
            Text(
                text = stringResource(R.string.home_project_path_immutable),
                color = colors.faint,
                fontSize = 12.5.sp,
                lineHeight = 17.sp,
            )
            errorMessage?.let {
                Text(it, color = colors.errorText, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                ProjectSheetButton(
                    label = stringResource(R.string.common_cancel),
                    enabled = !busy,
                    primary = false,
                    modifier = Modifier.weight(1f),
                    onClick = onDismiss,
                )
                ProjectSheetButton(
                    label = if (busy) stringResource(R.string.common_saving) else stringResource(R.string.common_save),
                    enabled = canSave,
                    primary = true,
                    modifier = Modifier.weight(1f),
                    onClick = { onSave(name.trim()) },
                )
            }
        }
    }
}

@Composable
private fun ProjectFieldLabel(label: String) {
    Text(label, color = LocalAAColors.current.inkSoft, fontSize = 13.sp, fontWeight = FontWeight.Bold)
}

@Composable
private fun ProjectReadOnlyField(value: String, monospace: Boolean = false) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(50.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (darkMode) Color(0xFF111113) else Color(0xFFF7F7F5))
            .border(1.dp, colors.border, RoundedCornerShape(12.dp))
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            text = value,
            color = colors.faint,
            fontSize = if (monospace) 13.sp else 15.sp,
            fontFamily = if (monospace) FontFamily.Monospace else FontFamily.Default,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ProjectSheetButton(
    label: String,
    enabled: Boolean,
    primary: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val background = if (primary) colors.primaryAction else colors.secondaryActionSurface
    val content = if (primary) colors.onPrimaryAction else colors.ink
    Box(
        modifier = modifier
            .height(50.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(background.copy(alpha = if (enabled) 1f else 0.38f))
            .clickable(
                enabled = enabled,
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = content, fontSize = 15.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
internal fun HomeArchiveProjectDialog(
    project: AgentProject,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(26.dp)
    Dialog(
        onDismissRequest = { if (!busy) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 22.dp)
                .widthIn(max = 380.dp)
                .shadow(34.dp, shape)
                .clip(shape)
                .background(colors.dialogSurface)
                .border(1.dp, colors.border, shape)
                .padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = stringResource(R.string.home_project_archive_title),
                color = colors.ink,
                fontSize = 22.sp,
                fontWeight = FontWeight.ExtraBold,
            )
            Text(
                text = stringResource(R.string.home_project_archive_description, project.name),
                color = colors.muted,
                fontSize = 14.sp,
                lineHeight = 20.sp,
            )
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ProjectSheetButton(
                    label = stringResource(R.string.common_cancel),
                    enabled = !busy,
                    primary = false,
                    modifier = Modifier.weight(1f),
                    onClick = onDismiss,
                )
                ProjectSheetButton(
                    label = stringResource(R.string.home_project_archive),
                    enabled = !busy,
                    primary = true,
                    modifier = Modifier.weight(1f),
                    onClick = onConfirm,
                )
            }
        }
    }
}
