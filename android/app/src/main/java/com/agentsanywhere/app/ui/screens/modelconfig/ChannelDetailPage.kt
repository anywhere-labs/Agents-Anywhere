package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.modelconfig.ChannelKind
import com.agentsanywhere.app.feature.modelconfig.ModelConfigController
import com.agentsanywhere.app.feature.modelconfig.ModelStatusTone
import com.agentsanywhere.app.feature.modelconfig.canDelete
import com.agentsanywhere.app.feature.modelconfig.channelKind
import com.agentsanywhere.app.feature.modelconfig.rowsFor
import com.agentsanywhere.app.feature.modelconfig.usedBy
import com.agentsanywhere.app.feature.modelconfig.usersOf
import com.agentsanywhere.app.feature.modelconfig.uses
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.profile.ProfileCard
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Trash2
import kotlinx.coroutines.launch

/** One channel's page: whether it is applied, what it is, and the runtimes that should use it. */
@Composable
internal fun ChannelDetailPage(
    channelId: String,
    overview: ModelConfigOverview,
    channel: ModelChannelState?,
    runtimes: List<DeviceRuntime>,
    devices: List<AgentDevice>,
    controller: ModelConfigController,
    pendingBar: PendingModelsBarSlot,
    settingChannel: String?,
    onApply: (String) -> Unit,
    exiting: Boolean,
    exited: Boolean,
    exitPhase: ModelConfigController.ExitPhase,
    onExit: () -> Unit,
    onChannelState: (ModelChannelState) -> Unit,
    onNotice: (String) -> Unit,
    onError: (Throwable) -> Unit,
) {
    val runtimesBlock: @Composable (Boolean) -> Unit = { showTitle ->
        if (channel != null) {
            ChannelRuntimesBlock(
                channelId = channelId,
                overview = overview,
                channel = channel,
                runtimes = runtimes,
                devices = devices,
                controller = controller,
                showTitle = showTitle,
                onChannelState = onChannelState,
                onError = onError,
            )
        }
    }
    val applyCard: @Composable (Boolean) -> Unit = { available ->
        ApplyCard(
            channelId = channelId,
            channel = channel,
            available = available && overview.secretConfigured,
            applying = settingChannel == channelId,
            busy = settingChannel != null,
            onApply = onApply,
        )
    }
    when (channelKind(channelId)) {
        // Not listed, so never opened: signing out of Tokens Anywhere switches back to it.
        ChannelKind.Native -> Unit
        ChannelKind.Tokens -> overview.tokens?.let { tokens ->
            TokensChannelDetail(
                tokens = tokens,
                overview = overview,
                channel = channel,
                controller = controller,
                pendingBar = pendingBar,
                runtimesBlock = runtimesBlock,
                exiting = exiting,
                exited = exited,
                exitPhase = exitPhase,
                onExit = onExit,
                onNotice = onNotice,
                onError = onError,
            )
        }
        ChannelKind.Manual -> overview.profiles.firstOrNull { it.id == channelId }?.let { profile ->
            MutedText(stringResource(R.string.model_config_profiles_description), Modifier.padding(horizontal = 4.dp))
            if (profile.isManual && profile.isActive) applyCard(true)
            ProfileCard {
                Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (!profile.isActive) {
                        StatusPill(stringResource(R.string.model_config_detached), ModelStatusTone.Warning)
                    }
                    ProfileDetails(profile, channel?.usersOf(profile.id) ?: overview.usedBy(profile.id))
                }
            }
            if (channel.rowsFor(channelId).isNotEmpty()) runtimesBlock(true)
            DeleteProfile(
                profile = profile,
                canDelete = profile.canDelete(overview.usedBy(profile.id), channel.uses(profile.id)),
                controller = controller,
                onError = onError,
            )
        }
    }
}

/** The channel is applied, or the one action that applies it and what that does. */
@Composable
internal fun ApplyCard(
    channelId: String,
    channel: ModelChannelState?,
    available: Boolean,
    applying: Boolean,
    busy: Boolean,
    onApply: (String) -> Unit,
) {
    if (channel == null) return
    val colors = LocalAAColors.current
    val applied = channel.channel == channelId
    ProfileCard {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (applied) {
                Icon(Lucide.Check, contentDescription = null, tint = toneColor(ModelStatusTone.Ok), modifier = Modifier.size(16.dp))
                Text(
                    stringResource(R.string.model_config_channel_current),
                    color = colors.ink,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                )
            } else {
                MutedText(stringResource(R.string.model_config_apply_description), Modifier.weight(1f))
                SmallButton(
                    label = stringResource(R.string.model_config_channel_set_current),
                    primary = true,
                    loading = applying,
                    enabled = available && !busy,
                    onClick = { onApply(channelId) },
                )
            }
        }
    }
}

@Composable
private fun DeleteProfile(
    profile: ModelProfile,
    canDelete: Boolean,
    controller: ModelConfigController,
    onError: (Throwable) -> Unit,
) {
    val colors = LocalAAColors.current
    val scope = rememberCoroutineScope()
    var busy by remember(profile.id) { mutableStateOf(false) }
    val enabled = canDelete && !busy
    val tint = if (enabled) colors.errorText else colors.muted.copy(alpha = 0.6f)
    ProfileCard {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = enabled) {
                    busy = true
                    scope.launch {
                        controller.deleteProfile(profile.id).onFailure(onError)
                        busy = false
                    }
                }
                .padding(horizontal = 14.dp, vertical = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Lucide.Trash2, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
            Text(stringResource(R.string.model_config_delete_profile), color = tint, fontSize = 14.sp, fontWeight = FontWeight.Medium)
        }
    }
    if (!canDelete) MutedText(stringResource(R.string.model_config_delete_in_use), Modifier.padding(horizontal = 4.dp))
}
