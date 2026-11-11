package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.modelconfig.ChannelPhase
import com.agentsanywhere.app.feature.modelconfig.ChannelKind
import com.agentsanywhere.app.feature.modelconfig.ModelStatusTone
import com.agentsanywhere.app.feature.modelconfig.channelKind
import com.agentsanywhere.app.feature.modelconfig.channelProgress
import com.agentsanywhere.app.feature.modelconfig.rowsFor
import com.agentsanywhere.app.model.CHANNEL_TOKENS
import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.profile.ProfileCard
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus

/** Every channel, in the desktop's order; each row says which is applied and how many runtimes should use it. */
@Composable
internal fun ChannelListPage(
    overview: ModelConfigOverview,
    channel: ModelChannelState?,
    onOpen: (String) -> Unit,
    onAdd: () -> Unit,
) {
    if (!overview.secretConfigured) NoticeText(stringResource(R.string.model_config_secret_missing))
    val listed = overview.profiles.filterNot { it.isTokens && it.isActive }
    val enabled = listed.filter { it.isActive }
    val detached = listed.filterNot { it.isActive }

    val row: @Composable (String) -> Unit = { id ->
        ChannelRow(
            name = channelLabel(id, overview),
            applied = channel?.channel == id,
            channel = channel,
            channelId = id,
            onClick = { onOpen(id) },
        )
    }
    // The device's own configuration is not listed: signing out of Tokens Anywhere switches back to it.
    if (overview.tokens?.available == true) ChannelGroup(title = null, ids = listOf(CHANNEL_TOKENS), row = row)
    if (enabled.isNotEmpty()) {
        ChannelGroup(stringResource(R.string.model_config_channels_manual), enabled.map { it.id }, row)
    }
    if (detached.isNotEmpty()) {
        ChannelGroup(stringResource(R.string.model_config_detached), detached.map { it.id }, row)
    }
    AddProfileRow(enabled = overview.secretConfigured, onClick = onAdd)
}

@Composable
private fun ChannelGroup(title: String?, ids: List<String>, row: @Composable (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        title?.let {
            Text(it, color = LocalAAColors.current.muted, fontSize = 12.sp, modifier = Modifier.padding(start = 4.dp))
        }
        ProfileCard {
            ids.forEachIndexed { index, id ->
                if (index > 0) RowDivider()
                row(id)
            }
        }
    }
}

@Composable
private fun ChannelRow(
    name: String,
    applied: Boolean,
    channel: ModelChannelState?,
    channelId: String,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 54.dp)
            .clickable(onClick = onClick)
            .padding(start = 14.dp, end = 10.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            Modifier.weight(1f),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                name,
                color = colors.ink,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (applied) StatusPill(stringResource(R.string.model_config_channel_current), ModelStatusTone.Ok)
        }
        ChannelMark(channel, channelId)
        Icon(Lucide.ChevronRight, contentDescription = null, tint = colors.muted, modifier = Modifier.size(17.dp))
    }
}

/** How many runtimes should use a channel, and whether they got there. */
@Composable
private fun ChannelMark(channel: ModelChannelState?, channelId: String) {
    val progress = channelProgress(channel.rowsFor(channelId))
    if (progress.phase == ChannelPhase.None) return
    val colors = LocalAAColors.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        when (progress.phase) {
            ChannelPhase.Running -> {
                val label = stringResource(R.string.model_config_runtimes_switching)
                CircularProgressIndicator(
                    color = colors.muted,
                    strokeWidth = 1.5.dp,
                    modifier = Modifier.size(12.dp).semantics { contentDescription = label },
                )
            }
            ChannelPhase.Attention -> {
                val label = stringResource(R.string.model_config_runtimes_attention)
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(toneColor(ModelStatusTone.Warning))
                        .semantics { contentDescription = label },
                )
            }
            else -> Unit
        }
        Text(progress.total.toString(), color = colors.muted, fontSize = 13.sp)
    }
}

@Composable
private fun AddProfileRow(enabled: Boolean, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    val tint = if (enabled) colors.muted else colors.muted.copy(alpha = 0.5f)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Lucide.Plus, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
        Text(stringResource(R.string.model_config_add_profile), color = tint, fontSize = 14.sp)
    }
}

/** 「设备自带配置」, 「Tokens Anywhere」 or the manual service's name. */
@Composable
internal fun channelLabel(channel: String, overview: ModelConfigOverview): String = when (channelKind(channel)) {
    ChannelKind.Native -> stringResource(R.string.model_config_channel_native)
    ChannelKind.Tokens -> stringResource(R.string.model_config_channel_tokens)
    ChannelKind.Manual -> overview.profiles.firstOrNull { it.id == channel }?.name ?: channel
}
