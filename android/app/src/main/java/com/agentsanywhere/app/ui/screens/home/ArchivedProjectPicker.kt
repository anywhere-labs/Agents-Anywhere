package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.*

@Composable
internal fun ArchivedProjectSelector(
    project: AgentProject?,
    expanded: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val expandedDescription = stringResource(if (expanded) R.string.archive_filter_expanded else R.string.archive_filter_collapsed)
    Surface(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().semantics { stateDescription = expandedDescription },
        shape = RoundedCornerShape(18.dp),
        color = colors.raisedSurface,
        border = androidx.compose.foundation.BorderStroke(1.dp, colors.border),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(Lucide.Folder, null, tint = archiveSecondaryInk(), modifier = Modifier.size(21.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.archive_filter_label), color = archiveSecondaryInk(), fontSize = 11.sp)
                Text(project?.name ?: stringResource(R.string.archived_all_projects), color = colors.ink,
                    fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(if (expanded) Lucide.ChevronUp else Lucide.ChevronDown, null, tint = archiveSecondaryInk(), modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
internal fun ArchivedProjectPicker(
    projects: List<AgentProject>,
    selectedId: String?,
    anchorBounds: Rect,
    onDismiss: () -> Unit,
    onSelect: (String?) -> Unit,
) {
    val colors = LocalAAColors.current
    val width = with(LocalDensity.current) { anchorBounds.width.toDp() }
    val maxHeight = minOf(380.dp, LocalConfiguration.current.screenHeightDp.dp * 0.5f)
    val shape = RoundedCornerShape(20.dp)
    val popupColor = if (colors.isDark) colors.ink.copy(alpha = 0.08f).compositeOver(colors.raisedSurface) else colors.raisedSurface
    HomeProjectAnchoredPopup(anchorBounds, onDismiss) {
        LazyColumn(
            modifier = Modifier.width(width).heightIn(max = maxHeight)
                .shadow(24.dp, shape, ambientColor = colors.appShadow, spotColor = colors.appShadow)
                .clip(shape).background(popupColor)
                .border(1.dp, colors.ink.copy(alpha = 0.12f), shape).selectableGroup(),
            contentPadding = PaddingValues(8.dp),
        ) {
            item("all") {
                ArchivedProjectOption(
                    name = stringResource(R.string.archived_all_projects),
                    path = null,
                    selected = selectedId == null,
                    onSelect = { onSelect(null) },
                )
            }
            items(projects, key = { "project:${it.id}" }) { project ->
                ArchivedProjectOption(name = project.name, path = project.workspacePath, selected = selectedId == project.id, onSelect = { onSelect(project.id) })
            }
        }
    }
}

@Composable
private fun ArchivedProjectOption(name: String, path: String?, selected: Boolean, onSelect: () -> Unit) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(RoundedCornerShape(12.dp))
            .background(if (selected) colors.ink.copy(alpha = 0.08f) else Color.Transparent)
            .selectable(selected, role = Role.RadioButton, onClick = onSelect)
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(Lucide.Folder, null, tint = if (selected) colors.inkSoft else archiveSecondaryInk(), modifier = Modifier.size(19.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(name, color = colors.ink, fontSize = 14.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            path?.takeIf { it.isNotBlank() }?.let {
                Text(it, color = if (selected) colors.inkSoft else archiveSecondaryInk(), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Box(Modifier.size(18.dp)) {
            if (selected) Icon(Lucide.Check, null, tint = colors.ink, modifier = Modifier.fillMaxSize())
        }
    }
}
