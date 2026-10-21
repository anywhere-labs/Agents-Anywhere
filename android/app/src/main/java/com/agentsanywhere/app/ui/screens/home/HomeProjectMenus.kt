package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.ProjectDeviceAgentFilter
import com.agentsanywhere.app.feature.sessions.ProjectSessionStatusFilter
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.runtimeTypeLabel
import com.agentsanywhere.app.ui.designsystem.AAAnchoredDropdownMenu
import com.agentsanywhere.app.ui.designsystem.AAAnchoredPopup
import com.agentsanywhere.app.ui.designsystem.AADropdownMenuItem
import com.agentsanywhere.app.ui.designsystem.AADropdownMenuLabel
import com.agentsanywhere.app.ui.designsystem.LocalAAColors

@Composable
internal fun HomeProjectAnchoredPopup(
    anchorBounds: Rect,
    onDismiss: () -> Unit,
    content: @Composable () -> Unit,
) {
    AAAnchoredPopup(anchorBounds = anchorBounds, onDismissRequest = onDismiss, content = content)
}

@Composable
internal fun HomeProjectFilterMenu(
    anchorBounds: Rect,
    selected: ProjectSessionStatusFilter,
    deviceAgentFilter: ProjectDeviceAgentFilter,
    devices: List<AgentDevice>,
    agentRuntimes: List<String>,
    onDismiss: () -> Unit,
    onSelectStatus: (ProjectSessionStatusFilter) -> Unit,
    onSelectDevice: (String?) -> Unit,
    onSelectAgent: (String?) -> Unit,
    onClearFilters: () -> Unit,
) {
    AAAnchoredDropdownMenu(anchorBounds = anchorBounds, onDismissRequest = onDismiss) {
        item("filter-header") {
            Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 16.dp, end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.home_project_session_status),
                    modifier = Modifier.weight(1f),
                    color = LocalAAColors.current.inkSoft.copy(alpha = 0.72f),
                    fontSize = 12.sp,
                )
                if (deviceAgentFilter.active || selected != ProjectSessionStatusFilter.Active) {
                    TextButton(
                        onClick = onClearFilters,
                    ) {
                        Text(stringResource(R.string.home_project_filter_clear))
                    }
                }
            }
        }
        items(ProjectSessionStatusFilter.entries, key = { "status-${it.name}" }) { status ->
            val label = when (status) {
                ProjectSessionStatusFilter.Active -> R.string.home_project_filter_active
                ProjectSessionStatusFilter.Archived -> R.string.home_project_filter_archived
                ProjectSessionStatusFilter.All -> R.string.home_project_filter_all
            }
            AADropdownMenuItem(
                text = stringResource(label),
                selected = selected == status,
                onClick = { onSelectStatus(status) },
            )
        }
        item("status-device-divider") { HomeProjectFilterDivider() }
        item("devices-label") { AADropdownMenuLabel(stringResource(R.string.home_project_filter_devices)) }
        item("all-devices") {
            AADropdownMenuItem(
                text = stringResource(R.string.home_project_filter_all_devices),
                selected = deviceAgentFilter.connectorId == null,
                onClick = { onSelectDevice(null) },
            )
        }
        items(devices, key = { "device-${it.id}" }) { device ->
            AADropdownMenuItem(
                text = device.name.trim().ifBlank { device.id },
                selected = deviceAgentFilter.connectorId == device.id,
                onClick = { onSelectDevice(device.id) },
            )
        }
        item("device-agent-divider") { HomeProjectFilterDivider() }
        item("agents-label") { AADropdownMenuLabel(stringResource(R.string.home_project_filter_agents)) }
        item("all-agents") {
            AADropdownMenuItem(
                text = stringResource(R.string.home_project_filter_all_agents),
                selected = deviceAgentFilter.runtime == null,
                onClick = { onSelectAgent(null) },
            )
        }
        items(agentRuntimes, key = { "agent-$it" }) { runtime ->
            AADropdownMenuItem(
                text = runtime.runtimeTypeLabel(),
                selected = deviceAgentFilter.runtime == runtime,
                onClick = { onSelectAgent(runtime) },
            )
        }
    }
}

@Composable
private fun HomeProjectFilterDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(vertical = 8.dp),
        thickness = 1.dp,
        color = LocalAAColors.current.ink.copy(alpha = 0.10f),
    )
}
