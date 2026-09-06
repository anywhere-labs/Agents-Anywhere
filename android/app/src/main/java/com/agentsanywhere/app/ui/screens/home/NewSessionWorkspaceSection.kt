package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.workspacePathKey
import com.agentsanywhere.app.feature.sessions.workspaceProject
import com.agentsanywhere.app.feature.sessions.workspaceProjectName
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.FolderOpen
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
    val recent = (sessions.filter { it.connectorId == connectorId }.mapNotNull { it.cwd } + available.map { it.workspacePath })
        .filter(String::isNotBlank).distinctBy { workspacePathKey(it, deviceOs) }
        .filterNot { workspacePathKey(it, deviceOs) == workspacePathKey(homePath.orEmpty(), deviceOs) }
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
            if (projectMode) item(key = "create-project") {
                WorkspaceActionRow(
                    title = stringResource(R.string.new_session_create_project),
                    icon = Lucide.Plus,
                    enabled = canCreateProject,
                    onClick = onCreate,
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
                item(key = "browse") {
                    WorkspaceActionRow(
                        title = stringResource(R.string.workspace_browse),
                        icon = Lucide.FolderOpen,
                        enabled = connectorId != null,
                        onClick = onBrowse,
                    )
                }
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
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Lucide.Folder, null, tint = colors.muted, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(title, color = colors.ink, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(path.ifBlank { stringResource(R.string.workspace_resolving_home) }, color = colors.muted, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (selected) Icon(Lucide.Check, stringResource(R.string.workspace_selected), tint = colors.ink, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun WorkspaceActionRow(title: String, icon: ImageVector, enabled: Boolean, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    val tint = colors.inkSoft.copy(alpha = if (enabled) 1f else 0.45f)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Text(title, color = tint, fontWeight = FontWeight.SemiBold)
    }
}
