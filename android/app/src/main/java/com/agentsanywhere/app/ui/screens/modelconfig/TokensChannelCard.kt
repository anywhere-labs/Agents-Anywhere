package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.modelconfig.ModelConfigController
import com.agentsanywhere.app.feature.modelconfig.ModelStatusTone
import com.agentsanywhere.app.feature.modelconfig.activeTokensProfile
import com.agentsanywhere.app.feature.modelconfig.updating
import com.agentsanywhere.app.model.CHANNEL_TOKENS
import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.model.TokensLinkStatus
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.profile.ProfileCard
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Link2
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.RefreshCw
import kotlinx.coroutines.launch

/**
 * Anywhere: link the Tokens Anywhere account, then make it the current channel.
 * Which runtimes use it, and how far they got, shows under the current channel.
 */
@Composable
internal fun TokensChannelCard(
    tokens: TokensLinkStatus,
    overview: ModelConfigOverview,
    channel: ModelChannelState?,
    controller: ModelConfigController,
    pendingBar: PendingModelsBarSlot,
    settingCurrent: Boolean,
    onSetCurrent: () -> Unit,
    onNotice: (String) -> Unit,
    onError: (Throwable) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }

    fun link() {
        if (busy) return
        busy = true
        scope.launch {
            controller.beginTokensLink()
                .onSuccess { url ->
                    if (!openTokensLinkStart(context, url)) onError(IllegalStateException("No browser"))
                }
                .onFailure(onError)
            busy = false
        }
    }

    if (!tokens.linked) {
        Section(
            title = stringResource(R.string.model_config_channel_title),
            description = stringResource(R.string.model_config_channel_description),
        ) {
            ProfileCard {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (tokens.link?.status == "reauth_required") {
                        MutedText(stringResource(R.string.model_config_tokens_reauth))
                    }
                    SmallButton(
                        label = stringResource(R.string.model_config_channel_link),
                        icon = Lucide.Link2,
                        primary = true,
                        enabled = tokens.secretConfigured && !busy,
                        loading = busy,
                        onClick = { link() },
                    )
                }
            }
        }
        return
    }

    val current = channel?.channel == CHANNEL_TOKENS
    TokensAccountPage(
        tokens = tokens,
        profile = overview.activeTokensProfile(),
        controller = controller,
        applying = channel?.updating(CHANNEL_TOKENS) == true,
        syncing = busy,
        onSync = {
            busy = true
            scope.launch {
                controller.syncTokens().onSuccess { onNotice(context.getString(R.string.model_config_synced)) }.onFailure(onError)
                busy = false
            }
        },
        pendingBar = pendingBar,
        onNotice = onNotice,
        onError = onError,
        action = {
            SmallButton(
                label = stringResource(R.string.model_config_switch_account),
                icon = Lucide.RefreshCw,
                enabled = !busy,
                loading = busy,
                onClick = { link() },
            )
        },
        header = {
            ProfileCard {
                Row(
                    Modifier.fillMaxWidth().padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            stringResource(R.string.model_config_channel_title),
                            color = LocalAAColors.current.ink,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        MutedText(
                            stringResource(
                                if (current) R.string.model_config_anywhere_current_hint else R.string.model_config_anywhere_not_current_hint,
                            ),
                        )
                        if (tokens.link?.relinkSoon == true) MutedText(stringResource(R.string.model_config_relink_soon))
                    }
                    if (current) {
                        StatusPill(stringResource(R.string.model_config_channel_current), ModelStatusTone.Ok)
                    } else {
                        SmallButton(
                            label = stringResource(R.string.model_config_channel_set_current),
                            icon = Lucide.Check,
                            primary = true,
                            enabled = !settingCurrent && overview.activeTokensProfile() != null,
                            loading = settingCurrent,
                            onClick = onSetCurrent,
                        )
                    }
                }
            }
        },
    )
}
