package com.agentsanywhere.app.ui.screens.home

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.recentWorkspacePaths
import com.agentsanywhere.app.feature.sessions.workspacePathKey
import com.agentsanywhere.app.feature.sessions.workspaceProject
import com.agentsanywhere.app.feature.sessions.workspaceProjectName
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus

internal data class WorkspaceChoice(val path: String, val projectId: String? = null)

@Composable
internal fun WorkspaceSection(
    path: String,
    connectorId: String?,
    deviceOs: String?,
    homePath: String?,
    projectMode: Boolean,
    projects: List<AgentProject>,
    sessions: List<AgentSession>,
    listState: LazyListState,
    canCreateProject: Boolean,
    onSelect: (WorkspaceChoice) -> Unit,
    onCreate: () -> Unit,
    onBrowse: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val available = projects.filter { it.connectorId == connectorId }
    val homeProject = workspaceProject(available, connectorId.orEmpty(), homePath.orEmpty(), deviceOs)
    val recent = remember(projectMode, connectorId, deviceOs, homePath, sessions, projects) {
        if (projectMode) emptyList() else recentWorkspacePaths(connectorId, deviceOs, homePath, sessions, projects)
    }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            text = stringResource(if (projectMode) R.string.home_projects else R.string.new_session_workspace),
            color = colors.ink,
            fontSize = 17.sp,
            fontWeight = FontWeight.SemiBold,
        )
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth().weight(1f),
            contentPadding = PaddingValues(bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            item(key = if (projectMode) "create-project" else "browse") {
                WorkspaceActionRow(
                    title = stringResource(if (projectMode) R.string.new_session_create_project else R.string.workspace_browse),
                    icon = Lucide.Plus,
                    enabled = if (projectMode) canCreateProject else connectorId != null,
                    raised = true,
                    onClick = if (projectMode) onCreate else onBrowse,
                )
            }
            if (!projectMode || homeProject == null) item(key = "home") {
                WorkspaceOptionRow(stringResource(R.string.workspace_home), homePath.orEmpty(), homePath != null && workspacePathKey(path, deviceOs) == workspacePathKey(homePath, deviceOs), enabled = !homePath.isNullOrBlank()) {
                    onSelect(WorkspaceChoice(homePath.orEmpty(), homeProject?.id))
                }
            }
            if (projectMode) {
                items(available, key = { "project:${it.id}" }) { project ->
                    WorkspaceOptionRow(project.name, project.workspacePath, workspacePathKey(path, deviceOs) == workspacePathKey(project.workspacePath, deviceOs)) {
                        onSelect(WorkspaceChoice(project.workspacePath, project.id))
                    }
                }
                if (available.isEmpty()) item { Text(stringResource(R.string.new_session_no_projects), modifier = Modifier.padding(vertical = 16.dp), color = colors.muted) }
            } else {
                items(recent, key = { "directory:${workspacePathKey(it, deviceOs)}" }) { directory ->
                    WorkspaceOptionRow(workspaceProjectName(directory), directory, workspacePathKey(path, deviceOs) == workspacePathKey(directory, deviceOs)) { onSelect(WorkspaceChoice(directory)) }
                }
            }
        }
    }
}

@Composable
private fun WorkspaceOptionRow(title: String, path: String, selected: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(if (selected) colors.raisedSurface else Color.Transparent)
            .then(if (selected && !colors.isDark) Modifier.border(1.dp, Color(0xFFE7E6E2), RoundedCornerShape(16.dp)) else Modifier)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Lucide.Folder, null, tint = colors.muted, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(title, color = colors.ink, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            WorkspaceMarqueeText(
                text = path.ifBlank { stringResource(R.string.workspace_resolving_home) },
                selected = selected,
                style = MaterialTheme.typography.bodySmall.copy(color = colors.muted),
            )
        }
        if (selected) Icon(Lucide.Check, stringResource(R.string.workspace_selected), tint = colors.ink, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun WorkspaceActionRow(title: String, icon: ImageVector, enabled: Boolean, raised: Boolean = false, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    val tint = colors.inkSoft.copy(alpha = if (enabled) 1f else 0.45f)
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val elevation by animateDpAsState(
        targetValue = if (!raised || !enabled) 0.dp else if (pressed) 3.dp else 10.dp,
        label = "create-project-shadow",
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = if (raised) 6.dp else 0.dp)
            .shadow(elevation, RoundedCornerShape(16.dp), ambientColor = colors.appShadow, spotColor = colors.appShadow)
            .clip(RoundedCornerShape(16.dp))
            .background(if (raised) colors.raisedSurface else Color.Transparent)
            .then(if (raised && !colors.isDark) Modifier.border(1.dp, Color(0xFFE7E6E2), RoundedCornerShape(16.dp)) else Modifier)
            .clickable(enabled = enabled, interactionSource = interactionSource, indication = null, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Text(title, color = tint, fontWeight = FontWeight.SemiBold)
    }
}
