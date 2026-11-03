package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.modelconfig.ChannelKind
import com.agentsanywhere.app.feature.modelconfig.ChannelOption
import com.agentsanywhere.app.feature.modelconfig.ChannelPhase
import com.agentsanywhere.app.feature.modelconfig.ChannelProgress
import com.agentsanywhere.app.feature.modelconfig.ChannelRuntimeRow
import com.agentsanywhere.app.feature.modelconfig.ModelConfigController
import com.agentsanywhere.app.feature.modelconfig.ModelStatusTone
import com.agentsanywhere.app.feature.modelconfig.channelGroups
import com.agentsanywhere.app.feature.modelconfig.channelKind
import com.agentsanywhere.app.feature.modelconfig.channelOptions
import com.agentsanywhere.app.feature.modelconfig.channelStateTone
import com.agentsanywhere.app.feature.modelconfig.progress
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.ui.designsystem.AADropdownMenu
import com.agentsanywhere.app.ui.designsystem.AADropdownMenuItem
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.profile.ProfileCard
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.RotateCcw
import com.composables.icons.lucide.SlidersHorizontal
import com.composables.icons.lucide.Zap
import kotlinx.coroutines.launch

/**
 * 「当前渠道」: the channel every runtime follows, how far the switch to it got,
 * and per runtime its state, its own channel and what can be done about it.
 */
@Composable
internal fun ChannelSection(
    overview: ModelConfigOverview,
    channel: ModelChannelState,
    runtimes: List<DeviceRuntime>,
    devices: List<AgentDevice>,
    controller: ModelConfigController,
    settingChannel: Boolean,
    onSetChannel: (String) -> Unit,
    onChannelState: (ModelChannelState) -> Unit,
    onError: (Throwable) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val options = overview.channelOptions()
    val progress = channel.progress()
    val groups = channelGroups(channel, runtimes, devices)
    var expanded by remember { mutableStateOf(false) }
    var unsupportedExpanded by remember { mutableStateOf(false) }
    // Which runtime is being written to, and by which action.
    var busy by remember { mutableStateOf<Pair<String, RowAction>?>(null) }
    var retryingAll by remember { mutableStateOf(false) }
    var confirmNativeGlobal by remember { mutableStateOf<Pair<ChannelRuntimeRow, String>?>(null) }

    fun runFor(row: ChannelRuntimeRow, action: RowAction, block: suspend () -> Result<ModelChannelState>) {
        if (busy != null) return
        busy = row.key to action
        scope.launch {
            block().onSuccess(onChannelState).onFailure(onError)
            busy = null
        }
    }

    fun setOverride(row: ChannelRuntimeRow, value: String?) {
        if (value == row.item.override) return
        if (row.needsNativeGlobalConfirmation(value)) {
            confirmNativeGlobal = row to value!!
            return
        }
        runFor(row, RowAction.Override) { controller.setRuntimeChannel(row.item.connectorId, row.item.runtimeId, value) }
    }

    confirmNativeGlobal?.let { (row, value) ->
        ConfirmActionDialog(
            title = stringResource(R.string.model_config_channel_native_global_title),
            description = stringResource(R.string.model_config_channel_native_global_description, row.name),
            confirmLabel = stringResource(R.string.model_config_channel_native_global_confirm),
            onDismiss = { confirmNativeGlobal = null },
            onConfirm = {
                confirmNativeGlobal = null
                runFor(row, RowAction.Override) {
                    controller.setRuntimeChannel(row.item.connectorId, row.item.runtimeId, value, confirmNativeGlobal = true)
                }
            },
        )
    }

    Section(
        title = stringResource(R.string.model_config_current_title),
        description = stringResource(R.string.model_config_current_description),
    ) {
        ProfileCard {
            Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                ChannelPicker(
                    current = channel.channel,
                    overview = overview,
                    options = options,
                    loading = settingChannel,
                    onSelect = { if (it != channel.channel) onSetChannel(it) },
                )
                ProgressSummary(
                    progress = progress,
                    retrying = retryingAll,
                    onRetry = {
                        retryingAll = true
                        scope.launch {
                            controller.retryChannel().onSuccess(onChannelState).onFailure(onError)
                            retryingAll = false
                        }
                    },
                )
                if (channel.runtimes.isNotEmpty()) {
                    Disclosure(
                        label = stringResource(
                            if (expanded) R.string.model_config_channel_hide_details else R.string.model_config_channel_show_details,
                        ),
                        expanded = expanded,
                        onToggle = { expanded = !expanded },
                    )
                }
                if (expanded) {
                    groups.devices.forEach { group ->
                        Text(
                            group.deviceName,
                            color = LocalAAColors.current.muted,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                        group.rows.forEach { row ->
                            ChannelRuntimeItem(
                                row = row,
                                showDevice = false,
                                overview = overview,
                                options = options,
                                busy = busy?.takeIf { it.first == row.key }?.second,
                                enabled = busy == null,
                                onOverride = { setOverride(row, it) },
                                onRetry = {
                                    runFor(row, RowAction.Retry) { controller.retryChannel(row.item.connectorId, row.item.runtimeId) }
                                },
                            )
                        }
                    }
                    if (groups.unsupported.isNotEmpty()) {
                        Disclosure(
                            label = pluralStringResource(
                                R.plurals.model_config_channel_unsupported,
                                groups.unsupported.size,
                                groups.unsupported.size,
                            ),
                            expanded = unsupportedExpanded,
                            onToggle = { unsupportedExpanded = !unsupportedExpanded },
                        )
                        if (unsupportedExpanded) {
                            groups.unsupported.forEach { row ->
                                ChannelRuntimeItem(
                                    row = row,
                                    showDevice = true,
                                    overview = overview,
                                    options = options,
                                    busy = busy?.takeIf { it.first == row.key }?.second,
                                    enabled = busy == null,
                                    onOverride = { setOverride(row, it) },
                                    onRetry = {},
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

private enum class RowAction { Override, Retry }

@Composable
private fun ChannelPicker(
    current: String,
    overview: ModelConfigOverview,
    options: List<ChannelOption>,
    loading: Boolean,
    onSelect: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    var open by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(12.dp)
    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 52.dp)
                .clip(shape)
                .background(colors.subtle)
                .border(1.dp, colors.border, shape)
                .clickable(enabled = !loading, role = Role.DropdownList) { open = true }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    channelLabel(current, overview),
                    color = colors.ink,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                channelHint(current, overview)?.let { MutedText(it) }
            }
            if (loading) {
                CircularProgressIndicator(color = colors.muted, strokeWidth = 1.5.dp, modifier = Modifier.size(16.dp))
            } else {
                Icon(Lucide.ChevronDown, contentDescription = null, tint = colors.muted, modifier = Modifier.size(18.dp))
            }
        }
        AADropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { option ->
                AADropdownMenuItem(
                    text = channelLabel(option.id, overview),
                    selected = option.id == current,
                    supportingText = channelHint(option.id, overview),
                    onClick = {
                        open = false
                        onSelect(option.id)
                    },
                )
            }
        }
    }
}

@Composable
private fun ProgressSummary(progress: ChannelProgress, retrying: Boolean, onRetry: () -> Unit) {
    val colors = LocalAAColors.current
    when (progress.phase) {
        ChannelPhase.Running -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            StatusText(
                pluralStringResource(
                    R.plurals.model_config_channel_progress_running,
                    progress.total,
                    progress.finished,
                    progress.total,
                ),
                ModelStatusTone.Progress,
            )
            LinearProgressIndicator(
                progress = { if (progress.total == 0) 0f else progress.finished.toFloat() / progress.total },
                modifier = Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)),
                color = colors.runtimeTransitioning,
                trackColor = colors.border,
                drawStopIndicator = {},
            )
            val waiting = listOfNotNull(
                progress.waitingOnline.takeIf { it > 0 }
                    ?.let { pluralStringResource(R.plurals.model_config_channel_waiting_online, it, it) },
            )
            if (waiting.isNotEmpty()) MutedText(waiting.joinToString(" · "))
        }
        ChannelPhase.Done -> StatusText(
            pluralStringResource(R.plurals.model_config_channel_progress_done, progress.applied, progress.applied),
            ModelStatusTone.Ok,
        )
        ChannelPhase.Attention -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (progress.restored > 0) {
                StatusText(
                    pluralStringResource(R.plurals.model_config_channel_restored, progress.restored, progress.restored),
                    ModelStatusTone.Warning,
                )
            }
            if (progress.failed > 0) {
                StatusText(
                    pluralStringResource(R.plurals.model_config_channel_failed, progress.failed, progress.failed),
                    ModelStatusTone.Error,
                )
            }
            if (progress.restored + progress.failed > 0) {
                SmallButton(
                    label = stringResource(R.string.model_config_channel_retry),
                    icon = Lucide.RotateCcw,
                    loading = retrying,
                    enabled = !retrying,
                    onClick = onRetry,
                )
            }
        }
        ChannelPhase.Idle -> if (progress.total == 0) MutedText(stringResource(R.string.model_config_channel_no_runtimes))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChannelRuntimeItem(
    row: ChannelRuntimeRow,
    showDevice: Boolean,
    overview: ModelConfigOverview,
    options: List<ChannelOption>,
    busy: RowAction?,
    enabled: Boolean,
    onOverride: (String?) -> Unit,
    onRetry: () -> Unit,
) {
    val colors = LocalAAColors.current
    val item = row.item
    var picking by remember(row.key) { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .border(1.dp, colors.border, RoundedCornerShape(10.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                row.name,
                color = colors.ink,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.align(Alignment.CenterVertically),
            )
            if (showDevice) {
                Text(row.deviceName, color = colors.muted, fontSize = 12.sp, maxLines = 1, modifier = Modifier.align(Alignment.CenterVertically))
            }
            RuntimeMaturityBadge(row.maturity, Modifier.align(Alignment.CenterVertically))
            StatusPill(channelStateLabel(item.state, item.step), channelStateTone(item.state), Modifier.align(Alignment.CenterVertically))
        }
        val details = listOfNotNull(
            item.actual?.let { stringResource(R.string.model_config_channel_using, channelLabel(it, overview)) },
            item.desired?.takeIf { it != item.actual && row.supported }
                ?.let { stringResource(R.string.model_config_channel_target, channelLabel(it, overview)) },
        )
        if (details.isNotEmpty()) MutedText(details.joinToString(" · "))
        val reason = listOfNotNull(item.reason?.let { stringResource(channelReasonRes(it)) }, item.message).distinct()
        if (reason.isNotEmpty()) {
            Text(
                reason.joinToString(" · "),
                color = if (row.canRetry) toneColor(channelStateTone(item.state)) else colors.muted,
                fontSize = 12.sp,
                lineHeight = 16.sp,
            )
        }
        if (row.canOverride || row.canRetry) {
            ActionRow {
                if (row.canOverride) {
                    Box {
                        SmallButton(
                            label = item.override?.let { stringResource(R.string.model_config_channel_override, channelLabel(it, overview)) }
                                ?: stringResource(R.string.model_config_channel_follow),
                            icon = Lucide.SlidersHorizontal,
                            loading = busy == RowAction.Override,
                            enabled = enabled,
                            onClick = { picking = true },
                        )
                        AADropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
                            AADropdownMenuItem(
                                text = stringResource(R.string.model_config_channel_follow),
                                selected = item.override == null,
                                onClick = {
                                    picking = false
                                    onOverride(null)
                                },
                            )
                            options.forEach { option ->
                                AADropdownMenuItem(
                                    text = channelLabel(option.id, overview),
                                    selected = item.override == option.id,
                                    supportingText = stringResource(R.string.model_config_scope_native_global)
                                        .takeIf { row.needsNativeGlobalConfirmation(option.id) },
                                    onClick = {
                                        picking = false
                                        onOverride(option.id)
                                    },
                                )
                            }
                        }
                    }
                }
                if (row.canRetry) {
                    SmallButton(
                        label = stringResource(R.string.model_config_channel_retry),
                        icon = Lucide.RotateCcw,
                        loading = busy == RowAction.Retry,
                        enabled = enabled,
                        onClick = onRetry,
                    )
                }
            }
        }
    }
}

@Composable
private fun Disclosure(label: String, expanded: Boolean, onToggle: () -> Unit) {
    Text(
        text = (if (expanded) "▾ " else "▸ ") + label,
        color = LocalAAColors.current.muted,
        fontSize = 12.sp,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .clickable(onClick = onToggle)
            .padding(vertical = 4.dp),
    )
}

@Composable
private fun StatusText(text: String, tone: ModelStatusTone) {
    Text(text, color = toneColor(tone), fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold)
}

/** 「设备自带配置」, 「Anywhere」 or the manual service's name. */
@Composable
internal fun channelLabel(channel: String, overview: ModelConfigOverview): String = when (channelKind(channel)) {
    ChannelKind.Native -> stringResource(R.string.model_config_channel_native)
    ChannelKind.Tokens -> stringResource(R.string.model_config_channel_tokens)
    ChannelKind.Manual -> overview.profiles.firstOrNull { it.id == channel }?.name ?: channel
}

@Composable
private fun channelHint(channel: String, overview: ModelConfigOverview): String? = when (channelKind(channel)) {
    ChannelKind.Native -> stringResource(R.string.model_config_channel_native_hint)
    ChannelKind.Tokens -> stringResource(R.string.model_config_channel_tokens_hint)
    ChannelKind.Manual -> overview.profiles.firstOrNull { it.id == channel }?.originHost?.takeIf { it.isNotBlank() }
}

/** The state as the doc's client column names it; switching also says which step. */
@Composable
private fun channelStateLabel(state: String, step: String?): String {
    val label = channelStateRes(state)?.let { stringResource(it) } ?: state
    val stepLabel = if (state == "switching") channelStepRes(step)?.let { stringResource(it) } else null
    return if (stepLabel != null) "$label · $stepLabel" else label
}
