package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.modelconfig.ChannelOption
import com.agentsanywhere.app.feature.modelconfig.ChannelPhase
import com.agentsanywhere.app.feature.modelconfig.ChannelProgress
import com.agentsanywhere.app.feature.modelconfig.ChannelRuntimeRow
import com.agentsanywhere.app.feature.modelconfig.ModelConfigController
import com.agentsanywhere.app.feature.modelconfig.ModelStatusTone
import com.agentsanywhere.app.feature.modelconfig.channelGroups
import com.agentsanywhere.app.feature.modelconfig.channelOptions
import com.agentsanywhere.app.feature.modelconfig.channelProgress
import com.agentsanywhere.app.feature.modelconfig.rowsFor
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.ui.designsystem.AADropdownMenu
import com.agentsanywhere.app.ui.designsystem.AADropdownMenuItem
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.profile.ProfileCard
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.RefreshCw
import kotlinx.coroutines.launch

/**
 * The runtimes that should use one channel, by device, with how far each got.
 * A runtime's own channel is a quiet choice at the end of its row; the desktop
 * has no such control yet, and this is the only client way to confirm a
 * runtime whose global settings would be rewritten.
 */
@Composable
internal fun ChannelRuntimesBlock(
    channelId: String,
    overview: ModelConfigOverview,
    channel: ModelChannelState,
    runtimes: List<DeviceRuntime>,
    devices: List<AgentDevice>,
    controller: ModelConfigController,
    /** Off under a tab that already says 「Runtime」. */
    showTitle: Boolean = true,
    onChannelState: (ModelChannelState) -> Unit,
    onError: (Throwable) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val rows = channel.rowsFor(channelId)
    val progress = channelProgress(rows)
    val groups = channelGroups(channel.copy(runtimes = rows), runtimes, devices)
    val options = overview.channelOptions()
    var busy by remember { mutableStateOf<String?>(null) }
    var confirmNativeGlobal by remember { mutableStateOf<Pair<ChannelRuntimeRow, String>?>(null) }

    fun run(key: String, block: suspend () -> Result<ModelChannelState>) {
        if (busy != null) return
        busy = key
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
        run(row.key) { controller.setRuntimeChannel(row.item.connectorId, row.item.runtimeId, value) }
    }

    confirmNativeGlobal?.let { (row, value) ->
        ConfirmActionDialog(
            title = stringResource(R.string.model_config_channel_native_global_title),
            description = stringResource(R.string.model_config_channel_native_global_description, row.name, channelLabel(value, overview)),
            confirmLabel = stringResource(R.string.model_config_channel_native_global_confirm),
            onDismiss = { confirmNativeGlobal = null },
            onConfirm = {
                confirmNativeGlobal = null
                run(row.key) {
                    controller.setRuntimeChannel(row.item.connectorId, row.item.runtimeId, value, confirmNativeGlobal = true)
                }
            },
        )
    }

    val rowContent: @Composable (ChannelRuntimeRow, Boolean) -> Unit = { row, showDevice ->
        RuntimeRow(
            row = row,
            showDevice = showDevice,
            channelId = channelId,
            overview = overview,
            options = options,
            working = busy == row.key,
            enabled = busy == null,
            onOverride = { setOverride(row, it) },
            onRetry = { run(row.key) { controller.retryChannel(row.item.connectorId, row.item.runtimeId) } },
        )
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                if (showTitle) Text(stringResource(R.string.model_config_runtimes_title), color = LocalAAColors.current.ink, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                ProgressStatus(rows.isEmpty(), progress)
            }
            if (progress.phase == ChannelPhase.Attention) {
                SmallButton(
                    label = stringResource(R.string.model_config_channel_retry),
                    icon = Lucide.RefreshCw,
                    loading = busy == RETRY_ALL,
                    enabled = busy == null,
                    onClick = { run(RETRY_ALL) { controller.retryChannel() } },
                )
            }
        }
        if (progress.phase == ChannelPhase.Running) {
            LinearProgressIndicator(
                progress = { progress.applied.toFloat() / progress.total },
                modifier = Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)),
                color = LocalAAColors.current.runtimeTransitioning,
                trackColor = LocalAAColors.current.border,
                drawStopIndicator = {},
            )
        }
        groups.devices.forEach { group ->
            val device = devices.firstOrNull { it.id == group.connectorId }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                DeviceHeading(group.deviceName, online = device?.online)
                ProfileCard {
                    group.rows.forEachIndexed { index, row ->
                        if (index > 0) RowDivider()
                        rowContent(row, false)
                    }
                }
            }
        }
        if (groups.unsupported.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                MutedText(
                    pluralStringResource(R.plurals.model_config_channel_unsupported, groups.unsupported.size, groups.unsupported.size),
                    Modifier.padding(start = 4.dp),
                )
                ProfileCard {
                    groups.unsupported.forEachIndexed { index, row ->
                        if (index > 0) RowDivider()
                        rowContent(row, true)
                    }
                }
            }
        }
    }
}

private const val RETRY_ALL = "retry-all"

@Composable
private fun ProgressStatus(empty: Boolean, progress: ChannelProgress) {
    if (empty) {
        MutedText(stringResource(R.string.model_config_channel_no_runtimes))
        return
    }
    val headline = when (progress.phase) {
        ChannelPhase.None -> pluralStringResource(R.plurals.model_config_channel_unsupported, progress.unsupported, progress.unsupported)
        ChannelPhase.Done -> pluralStringResource(R.plurals.model_config_channel_progress_done, progress.total, progress.total)
        ChannelPhase.Running -> pluralStringResource(R.plurals.model_config_channel_progress_running, progress.total, progress.applied, progress.total)
        ChannelPhase.Attention -> stringResource(R.string.model_config_status_attention, progress.applied, progress.total)
    }
    val waiting = progress.offlineDevices.takeIf { it > 0 }
        ?.let { pluralStringResource(R.plurals.model_config_channel_waiting_online, it, it) }
    val notes = when (progress.phase) {
        ChannelPhase.Attention -> listOfNotNull(
            progress.restored.takeIf { it > 0 }?.let { pluralStringResource(R.plurals.model_config_channel_restored, it, it) },
            progress.failed.takeIf { it > 0 }?.let { pluralStringResource(R.plurals.model_config_channel_failed, it, it) },
            waiting,
        )
        ChannelPhase.Running -> listOfNotNull(waiting)
        else -> emptyList()
    }
    Text(
        (listOf(headline) + notes).joinToString(" · "),
        color = if (progress.phase == ChannelPhase.Attention) toneColor(ModelStatusTone.Warning) else LocalAAColors.current.muted,
        fontSize = 12.sp,
        lineHeight = 16.sp,
    )
}

@Composable
private fun DeviceHeading(name: String, online: Boolean?) {
    val colors = LocalAAColors.current
    val label = online?.let { stringResource(if (it) R.string.model_config_details_online else R.string.model_config_details_offline) }
    Row(
        Modifier.padding(start = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(if (online == true) toneColor(ModelStatusTone.Ok) else colors.muted.copy(alpha = 0.4f))
                .then(if (label != null) Modifier.semantics { contentDescription = label } else Modifier),
        )
        Text(name, color = colors.muted, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun RuntimeRow(
    row: ChannelRuntimeRow,
    showDevice: Boolean,
    channelId: String,
    overview: ModelConfigOverview,
    options: List<ChannelOption>,
    working: Boolean,
    enabled: Boolean,
    onOverride: (String?) -> Unit,
    onRetry: () -> Unit,
) {
    val colors = LocalAAColors.current
    val item = row.item
    val failed = row.canRetry
    val status = listOfNotNull(
        runtimeStateText(item.state, item.step),
        item.reason?.takeIf { failed || item.state == "unsupported" }?.let { stringResource(channelReasonRes(it)) },
        item.actual?.takeIf { item.state != "applied" }?.let { stringResource(R.string.model_config_channel_using, channelLabel(it, overview)) },
        // There is no hover on a phone to find the Runtime's own words in.
        item.message?.takeIf { failed },
    ).joinToString(" · ")

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 11.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        if (showDevice) "${row.name} · ${row.deviceName}" else row.name,
                        color = colors.ink,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    RuntimeMaturityBadge(row.maturity)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    if (item.state in UNDER_WAY) {
                        CircularProgressIndicator(
                            color = colors.muted,
                            strokeWidth = 1.2.dp,
                            modifier = Modifier.padding(top = 2.dp).size(11.dp),
                        )
                    }
                    Text(
                        status,
                        color = if (failed) toneColor(ModelStatusTone.Warning) else colors.muted,
                        fontSize = 12.sp,
                        lineHeight = 16.sp,
                    )
                }
            }
            RuntimeChannelChoice(
                row = row,
                channelId = channelId,
                overview = overview,
                options = options,
                working = working,
                enabled = enabled,
                onOverride = onOverride,
            )
        }
        if (failed) {
            SmallButton(
                label = stringResource(R.string.model_config_channel_retry),
                icon = Lucide.RefreshCw,
                enabled = enabled,
                onClick = onRetry,
            )
        }
    }
}

// Being worked on now; a runtime waiting for its device to come online is not.
private val UNDER_WAY = setOf("pending", "switching", "restoring")

/** Which channel this runtime is on the way to; tapping chooses another or goes back to following. */
@Composable
private fun RuntimeChannelChoice(
    row: ChannelRuntimeRow,
    channelId: String,
    overview: ModelConfigOverview,
    options: List<ChannelOption>,
    working: Boolean,
    enabled: Boolean,
    onOverride: (String?) -> Unit,
) {
    val colors = LocalAAColors.current
    val label = channelLabel(row.item.desired ?: channelId, overview)
    if (!row.canOverride) {
        Text(label, color = colors.muted, fontSize = 13.sp, maxLines = 1)
        return
    }
    var picking by remember(row.key) { mutableStateOf(false) }
    val description = stringResource(R.string.model_config_channel_for, row.name)
    Box {
        Row(
            Modifier
                .clip(RoundedCornerShape(8.dp))
                .clickable(enabled = enabled, role = Role.DropdownList) { picking = true }
                .semantics { contentDescription = description }
                .padding(start = 8.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            if (working) {
                CircularProgressIndicator(color = colors.muted, strokeWidth = 1.5.dp, modifier = Modifier.size(13.dp))
            }
            Text(label, color = colors.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(Lucide.ChevronDown, contentDescription = null, tint = colors.muted, modifier = Modifier.size(14.dp))
        }
        AADropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
            AADropdownMenuItem(
                text = stringResource(R.string.model_config_channel_follow),
                selected = row.item.override == null,
                onClick = {
                    picking = false
                    onOverride(null)
                },
            )
            options.forEach { option ->
                AADropdownMenuItem(
                    text = channelLabel(option.id, overview),
                    selected = row.item.override == option.id,
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

/** The state as the desktop names it; switching also says which step. */
@Composable
private fun runtimeStateText(state: String, step: String?): String {
    val label = channelStateRes(state)?.let { stringResource(it) } ?: state
    val stepLabel = if (state == "switching") channelStepRes(step)?.let { stringResource(it) } else null
    return if (stepLabel != null) "$label · $stepLabel" else label
}
