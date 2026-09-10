package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.ui.designsystem.AAAnchoredDropdownMenu
import com.agentsanywhere.app.ui.designsystem.AADropdownMenuItem
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
    val filterDescription = stringResource(R.string.archive_filter_label)
    val expandedDescription = stringResource(if (expanded) R.string.archive_filter_expanded else R.string.archive_filter_collapsed)
    Surface(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().semantics {
            contentDescription = filterDescription
            stateDescription = expandedDescription
        },
        shape = RoundedCornerShape(18.dp),
        color = colors.raisedSurface,
        border = if (colors.isDark) null else BorderStroke(1.dp, Color(0xFFE7E6E2)),
    ) {
        Row(
            modifier = Modifier.heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(Lucide.Folder, null, tint = archiveSecondaryInk(), modifier = Modifier.size(21.dp))
            Text(
                project?.name ?: stringResource(R.string.archived_all_projects),
                modifier = Modifier.weight(1f),
                color = colors.ink,
                fontSize = 15.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
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
    val width = with(LocalDensity.current) { anchorBounds.width.toDp() }
    val maxHeight = minOf(328.dp, LocalConfiguration.current.screenHeightDp.dp * 0.5f)
    AAAnchoredDropdownMenu(anchorBounds = anchorBounds, onDismissRequest = onDismiss, width = width, maxHeight = maxHeight) {
        item("all") {
            AADropdownMenuItem(
                text = stringResource(R.string.archived_all_projects),
                icon = Lucide.Folder,
                selected = selectedId == null,
                onClick = { onSelect(null) },
            )
        }
        items(projects, key = { "project:${it.id}" }) { project ->
            AADropdownMenuItem(
                text = project.name,
                icon = Lucide.Folder,
                supportingText = project.workspacePath,
                supportingTextMaxLines = 1,
                selected = selectedId == project.id,
                onClick = { onSelect(project.id) },
            )
        }
    }
}
