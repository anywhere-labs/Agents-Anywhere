package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceAgentsState
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeStatus
import com.agentsanywhere.app.feature.devices.DeviceRuntimeType
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.designsystem.runtimeErrorText
import com.composables.icons.lucide.Ellipsis
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.RefreshCw
import com.composables.icons.lucide.WifiOff

/** Errors that mean "not running yet", not "something is broken". */
private val notRunningErrorCodes = setOf("runtime_unavailable", "runtime_not_started", "runtime_not_configured", "connector_offline")

/** Configured instances, then the types the device can still add. */
@Composable
internal fun DeviceAgentsSection(
    state: DeviceAgentsState,
    online: Boolean,
    onDiscover: () -> Unit,
    onRetry: () -> Unit,
    onQuickAdd: (DeviceRuntimeType) -> Unit,
    onConfigureType: (DeviceRuntimeType) -> Unit,
    onConfigure: (DeviceRuntime) -> Unit,
    onMore: (DeviceRuntime) -> Unit,
    onSetActive: (DeviceRuntime, Boolean) -> Unit,
) {
    val idle = !state.busy && !state.loading && !state.discovering
    SectionBlock(
        title = stringResource(R.string.device_detail_agents_section),
        action = {
            AgentDiscoverButton(
                discovering = state.discovering,
                enabled = online && idle,
                onClick = onDiscover,
            )
        },
    ) {
        if (!online) AgentOfflineNotice()
        when {
            !state.loaded && state.loadFailed -> {
                Text(
                    text = state.loadErrorMessage ?: stringResource(R.string.device_runtime_load_failed),
                    color = LocalAAColors.current.errorText,
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    lineHeight = 17.sp,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
                SmallActionButton(
                    icon = Lucide.RefreshCw,
                    label = stringResource(R.string.common_retry),
                    danger = false,
                    enabled = !state.loading,
                    onClick = onRetry,
                )
            }
            !state.loaded -> {
                Row(
                    modifier = Modifier.fillMaxWidth().height(56.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    EmptyText(
                        stringResource(if (state.discovering) R.string.device_agents_discovering else R.string.device_runtime_loading),
                    )
                }
            }
            else -> {
                val configured = state.configuredRuntimes
                if (configured.isEmpty()) {
                    EmptyText(stringResource(R.string.device_runtime_no_configured))
                } else {
                    configured.forEachIndexed { index, runtime ->
                        ConfiguredAgentRow(
                            runtime = runtime,
                            pending = state.busyId == runtime.id,
                            enabled = idle,
                            online = online,
                            onConfigure = { onConfigure(runtime) },
                            onMore = { onMore(runtime) },
                            onSetActive = { active -> onSetActive(runtime, active) },
                        )
                        if (index != configured.lastIndex) DetailDivider()
                    }
                }
                AvailableAgents(
                    state = state,
                    enabled = online && idle,
                    onQuickAdd = onQuickAdd,
                    onConfigure = onConfigureType,
                )
            }
        }
    }
}

@Composable
private fun AvailableAgents(
    state: DeviceAgentsState,
    enabled: Boolean,
    onQuickAdd: (DeviceRuntimeType) -> Unit,
    onConfigure: (DeviceRuntimeType) -> Unit,
) {
    val addable = state.addableTypes
    Text(
        text = stringResource(R.string.device_agents_available),
        color = LocalAAColors.current.muted,
        fontSize = 12.5.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(top = 14.dp, bottom = 2.dp),
    )
    if (addable.isEmpty()) {
        EmptyText(
            stringResource(
                if (state.inventory.knownTypes.isEmpty()) R.string.device_agents_none_found else R.string.device_agents_all_added,
            ),
        )
        return
    }
    addable.forEachIndexed { index, type ->
        AddableAgentRow(
            type = type,
            adding = state.busyId == type.type,
            enabled = enabled,
            onQuickAdd = { onQuickAdd(type) },
            onConfigure = { onConfigure(type) },
        )
        if (index != addable.lastIndex) DetailDivider()
    }
}

@Composable
private fun ConfiguredAgentRow(
    runtime: DeviceRuntime,
    pending: Boolean,
    enabled: Boolean,
    online: Boolean,
    onConfigure: () -> Unit,
    onMore: () -> Unit,
    onSetActive: (Boolean) -> Unit,
) {
    val colors = LocalAAColors.current
    val context = LocalContext.current
    val problem = runtime.error != null &&
        runtime.status != DeviceRuntimeStatus.Starting &&
        runtime.status != DeviceRuntimeStatus.Running
    val reason = if (problem) runtimeErrorText(context, runtime.errorCode, runtime.errorMessage) else null
    val warning = runtime.errorCode in notRunningErrorCodes
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .noRippleClickable(enabled = enabled && online, onClick = onConfigure)
            .padding(vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        RuntimeStatusIndicator(runtime = runtime, pending = pending)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = runtime.labels.primary,
                color = colors.ink,
                fontSize = 16.5.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = listOfNotNull(
                    runtime.labels.secondary,
                    runtimeStatusLabel(runtime),
                    runtime.phaseMessage?.takeIf { runtime.status == DeviceRuntimeStatus.Starting },
                ).joinToString(" · "),
                color = if (runtime.status == DeviceRuntimeStatus.Error && !warning) colors.errorText else colors.muted,
                fontSize = 11.5.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            reason?.let {
                Text(
                    text = it,
                    color = if (warning) colors.muted else colors.errorText,
                    fontSize = 11.5.sp,
                    lineHeight = 15.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AgentSwitch(
                checked = runtime.active,
                onCheckedChange = onSetActive,
                // Starting needs the device; stopping is recorded even while it is offline.
                enabled = !pending && enabled && (runtime.active || (runtime.canActivate && online)),
            )
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .semantics { contentDescription = context.getString(R.string.device_agents_more_actions, runtime.labels.primary) }
                    .noRippleClickable(enabled = !pending && enabled, onClick = onMore),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Lucide.Ellipsis,
                    contentDescription = null,
                    tint = colors.muted.copy(alpha = if (!pending && enabled) 1f else 0.5f),
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

@Composable
private fun AddableAgentRow(
    type: DeviceRuntimeType,
    adding: Boolean,
    enabled: Boolean,
    onQuickAdd: () -> Unit,
    onConfigure: () -> Unit,
) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = type.displayName,
                    color = colors.ink,
                    fontSize = 15.5.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (type.recommended) {
                    Text(
                        text = stringResource(R.string.device_agents_recommended),
                        color = colors.muted,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(colors.subtle)
                            .padding(horizontal = 7.dp, vertical = 2.dp),
                    )
                }
            }
            (type.reason ?: type.description)?.let { detail ->
                Text(
                    text = detail,
                    color = colors.muted,
                    fontSize = 11.5.sp,
                    lineHeight = 15.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        AgentPillButton(
            label = stringResource(R.string.device_agents_configure),
            primary = false,
            enabled = enabled,
            onClick = onConfigure,
        )
        AgentPillButton(
            label = stringResource(R.string.device_agents_quick_add),
            primary = true,
            enabled = enabled,
            loading = adding,
            onClick = onQuickAdd,
        )
    }
}

@Composable
private fun AgentOfflineNotice() {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 2.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Lucide.WifiOff, contentDescription = null, tint = colors.muted, modifier = Modifier.size(15.dp))
        Text(
            text = stringResource(R.string.device_agents_offline),
            color = colors.muted,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.Medium,
            lineHeight = 17.sp,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun AgentDiscoverButton(
    discovering: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val description = stringResource(if (discovering) R.string.device_agents_discovering else R.string.device_agents_discover)
    Box(
        modifier = Modifier
            .size(34.dp)
            .clip(CircleShape)
            .semantics { contentDescription = description }
            .noRippleClickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (discovering) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), color = colors.muted, strokeWidth = 2.dp)
        } else {
            Icon(
                imageVector = Lucide.RefreshCw,
                contentDescription = null,
                tint = colors.muted.copy(alpha = if (enabled) 1f else 0.45f),
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

@Composable
internal fun AgentPillButton(
    label: String,
    primary: Boolean,
    enabled: Boolean,
    loading: Boolean = false,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val surface = when {
        primary && colors.isDark -> Color(0xFFE4E4E7)
        primary -> Color(0xFF181816)
        colors.isDark -> colors.subtle
        else -> Color(0xFFECECE9)
    }
    val content = when {
        primary && colors.isDark -> Color(0xFF181816)
        primary -> Color.White
        else -> colors.ink
    }
    Box(
        modifier = Modifier
            .height(32.dp)
            .clip(CircleShape)
            .background(surface.copy(alpha = if (enabled || loading) 1f else 0.45f))
            .noRippleClickable(enabled = enabled && !loading, onClick = onClick)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(modifier = Modifier.size(14.dp), color = content, strokeWidth = 1.6.dp)
        } else {
            Text(
                text = label,
                color = content.copy(alpha = if (enabled) 1f else 0.6f),
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun RuntimeStatusIndicator(runtime: DeviceRuntime, pending: Boolean) {
    val colors = LocalAAColors.current
    Box(modifier = Modifier.size(14.dp), contentAlignment = Alignment.Center) {
        if (pending) {
            CircularProgressIndicator(
                modifier = Modifier.size(14.dp),
                color = colors.muted,
                strokeWidth = 1.5.dp,
            )
        } else {
            val color = when {
                runtime.status == DeviceRuntimeStatus.Running -> colors.runtimeRunning
                runtime.status == DeviceRuntimeStatus.Error -> colors.errorIcon
                runtime.status == DeviceRuntimeStatus.Starting || runtime.status == DeviceRuntimeStatus.Stopping -> colors.runtimeTransitioning
                runtime.active -> colors.runtimeActive
                else -> colors.runtimeInactive
            }
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(color),
            )
        }
    }
}

@Composable
internal fun AgentSwitch(
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    val colors = LocalAAColors.current
    val animation = tween<Color>(durationMillis = 150)
    val trackColor by animateColorAsState(
        targetValue = if (checked) colors.runtimeSwitchCheckedTrack else colors.runtimeSwitchUncheckedTrack,
        animationSpec = animation,
        label = "runtime-switch-track",
    )
    val borderColor by animateColorAsState(
        targetValue = if (checked) colors.runtimeSwitchCheckedTrack else Color.Transparent,
        animationSpec = animation,
        label = "runtime-switch-border",
    )
    val thumbColor by animateColorAsState(
        targetValue = if (checked) colors.runtimeSwitchCheckedThumb else colors.runtimeSwitchUncheckedThumb,
        animationSpec = animation,
        label = "runtime-switch-thumb",
    )
    val thumbOffset by animateDpAsState(
        targetValue = if (checked) 14.dp else 2.dp,
        animationSpec = tween(durationMillis = 150),
        label = "runtime-switch-thumb-offset",
    )
    val shape = RoundedCornerShape(16.dp)

    Box(
        modifier = Modifier
            .size(width = 32.dp, height = 20.dp)
            .alpha(if (enabled) 1f else 0.5f)
            .clip(shape)
            .background(trackColor)
            .border(2.dp, borderColor, shape)
            .toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Switch,
                onValueChange = onCheckedChange,
            ),
    ) {
        Box(
            modifier = Modifier
                .offset { IntOffset(thumbOffset.roundToPx(), 2.dp.roundToPx()) }
                .size(16.dp)
                .shadow(1.dp, CircleShape)
                .clip(CircleShape)
                .background(thumbColor),
        )
    }
}

@Composable
private fun runtimeStatusLabel(runtime: DeviceRuntime): String {
    return when {
        !runtime.present -> stringResource(R.string.device_runtime_not_present)
        !runtime.configured -> stringResource(R.string.device_runtime_not_configured)
        !runtime.active -> stringResource(R.string.device_agents_not_started)
        runtime.status == DeviceRuntimeStatus.Stopped -> stringResource(R.string.device_runtime_stopped)
        runtime.status == DeviceRuntimeStatus.Discovering -> stringResource(R.string.device_runtime_discovering)
        runtime.status == DeviceRuntimeStatus.Available -> stringResource(R.string.device_runtime_available)
        runtime.status == DeviceRuntimeStatus.Unavailable -> stringResource(R.string.device_runtime_unavailable)
        runtime.status == DeviceRuntimeStatus.Validating -> stringResource(R.string.device_runtime_validating)
        runtime.status == DeviceRuntimeStatus.Starting -> stringResource(R.string.device_runtime_starting)
        runtime.status == DeviceRuntimeStatus.Running -> stringResource(R.string.device_runtime_running)
        runtime.status == DeviceRuntimeStatus.Stopping -> stringResource(R.string.device_runtime_stopping)
        runtime.status == DeviceRuntimeStatus.Error -> stringResource(R.string.device_runtime_error)
        else -> stringResource(R.string.device_runtime_unknown)
    }
}
