package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.workspacePathKey
import com.agentsanywhere.app.feature.sessions.workspaceProject
import com.agentsanywhere.app.feature.sessions.workspaceProjectName
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.*

internal data class WorkspaceChoice(val path: String, val projectId: String? = null)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WorkspaceSection(
    selectedTitle: String,
    path: String,
    connectorId: String?,
    deviceOs: String?,
    homePath: String?,
    projectMode: Boolean,
    projects: List<AgentProject>,
    sessions: List<AgentSession>,
    open: Boolean,
    onOpen: () -> Unit,
    onDismiss: () -> Unit,
    onSelect: (WorkspaceChoice) -> Unit,
    onCreate: () -> Unit,
    onBrowse: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(if (projectMode) R.string.home_projects else R.string.new_session_workspace), color = colors.ink, fontWeight = FontWeight.SemiBold)
        Surface(shape = MaterialTheme.shapes.medium, color = colors.raisedSurface, modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.clickable(enabled = connectorId != null, onClick = onOpen).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Lucide.Folder, null, tint = colors.muted)
                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(selectedTitle, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(path.ifBlank { stringResource(R.string.workspace_resolving_home) }, style = MaterialTheme.typography.bodySmall, color = colors.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Icon(Lucide.ChevronDown, null, tint = colors.muted)
            }
        }
    }
    if (!open) return
    val available = projects.filter { it.connectorId == connectorId }
    val homeProject = workspaceProject(available, connectorId.orEmpty(), homePath.orEmpty(), deviceOs)
    val recent = (sessions.filter { it.connectorId == connectorId }.mapNotNull { it.cwd } + available.map { it.workspacePath })
        .filter(String::isNotBlank).distinctBy { workspacePathKey(it, deviceOs) }
        .filterNot { workspacePathKey(it, deviceOs) == workspacePathKey(homePath.orEmpty(), deviceOs) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = colors.canvas) {
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 520.dp), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = 24.dp)) {
            item {
                Text(stringResource(if (projectMode) R.string.new_session_choose_project else R.string.new_session_workspace), modifier = Modifier.padding(vertical = 12.dp), style = MaterialTheme.typography.titleLarge, color = colors.ink)
            }
            if (!projectMode || homeProject == null) item {
                WorkspaceOptionRow(stringResource(R.string.workspace_home), homePath.orEmpty(), homePath != null && workspacePathKey(path, deviceOs) == workspacePathKey(homePath, deviceOs), enabled = !homePath.isNullOrBlank()) {
                    onSelect(WorkspaceChoice(homePath.orEmpty(), homeProject?.id))
                }
            }
            if (projectMode) {
                items(available, key = { it.id }) { project ->
                    WorkspaceOptionRow(project.name, project.workspacePath, workspacePathKey(path, deviceOs) == workspacePathKey(project.workspacePath, deviceOs)) {
                        onSelect(WorkspaceChoice(project.workspacePath, project.id))
                    }
                }
                if (available.isEmpty()) item { Text(stringResource(R.string.new_session_no_projects), modifier = Modifier.padding(vertical = 16.dp), color = colors.muted) }
                item { TextButton(onClick = onCreate, modifier = Modifier.fillMaxWidth()) { Icon(Lucide.Plus, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.new_session_create_project)) } }
            } else {
                item { TextButton(onClick = onBrowse, modifier = Modifier.fillMaxWidth()) { Icon(Lucide.FolderOpen, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.workspace_browse)) } }
                items(recent, key = { workspacePathKey(it, deviceOs) }) { directory ->
                    WorkspaceOptionRow(workspaceProjectName(directory), directory, workspacePathKey(path, deviceOs) == workspacePathKey(directory, deviceOs)) { onSelect(WorkspaceChoice(directory)) }
                }
            }
        }
    }
}

@Composable
private fun WorkspaceOptionRow(title: String, path: String, selected: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Lucide.Folder, null, tint = colors.muted, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(title, color = colors.ink, fontWeight = FontWeight.Medium)
            Text(path.ifBlank { stringResource(R.string.workspace_resolving_home) }, color = colors.muted, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (selected) Icon(Lucide.Check, stringResource(R.string.workspace_selected), tint = colors.ink, modifier = Modifier.size(20.dp))
    }
}
