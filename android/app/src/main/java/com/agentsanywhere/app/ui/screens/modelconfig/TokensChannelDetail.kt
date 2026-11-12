package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.modelconfig.ModelConfigController
import com.agentsanywhere.app.feature.modelconfig.activeTokensProfile
import com.agentsanywhere.app.feature.modelconfig.modelConfigErrorCode
import com.agentsanywhere.app.feature.modelconfig.updating
import com.agentsanywhere.app.feature.modelconfig.usedBy
import com.agentsanywhere.app.feature.modelconfig.usersOf
import com.agentsanywhere.app.model.CHANNEL_NATIVE
import com.agentsanywhere.app.model.CHANNEL_TOKENS
import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.model.TokensLinkStatus
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.profile.ProfileCard
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Copy
import com.composables.icons.lucide.Link2
import com.composables.icons.lucide.LogOut
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.RefreshCw
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The Tokens Anywhere channel: link an account first, then its account, models and connection, and runtimes. */
@Composable
internal fun TokensChannelDetail(
    tokens: TokensLinkStatus,
    overview: ModelConfigOverview,
    channel: ModelChannelState?,
    controller: ModelConfigController,
    pendingBar: PendingModelsBarSlot,
    runtimesBlock: @Composable (Boolean) -> Unit,
    exiting: Boolean,
    exited: Boolean,
    exitPhase: ModelConfigController.ExitPhase,
    onExit: () -> Unit,
    onNotice: (String) -> Unit,
    onError: (Throwable) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var confirmingExit by remember { mutableStateOf(false) }
    val profile = overview.activeTokensProfile()
    val usedBy = profile?.let { channel?.usersOf(CHANNEL_TOKENS) ?: overview.usedBy(it.id) } ?: 0

    if (confirmingExit) {
        val applied = channel?.channel
        ConfirmActionDialog(
            title = stringResource(R.string.model_config_sign_out_title),
            description = stringResource(
                R.string.model_config_sign_out_description,
                channelLabel(if (applied != null && applied != CHANNEL_TOKENS) applied else CHANNEL_NATIVE, overview),
            ),
            confirmLabel = stringResource(R.string.model_config_sign_out),
            onDismiss = { confirmingExit = false },
            onConfirm = {
                confirmingExit = false
                onExit()
            },
        )
    }

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

    if (!tokens.linked || exited) {
        MutedText(stringResource(R.string.model_config_channel_description), Modifier.padding(horizontal = 4.dp))
        if (tokens.link != null && !exited) {
            MutedText(stringResource(R.string.model_config_tokens_reauth), Modifier.padding(horizontal = 4.dp))
        }
        SmallButton(
            label = stringResource(if (tokens.link != null && !exited) R.string.model_config_relink else R.string.model_config_channel_link),
            icon = Lucide.Link2,
            primary = true,
            enabled = tokens.secretConfigured && !busy,
            loading = busy,
            onClick = { link() },
        )
        // A lapsed link keeps the connection runtimes still use.
        if (profile != null && !exited) {
            TokensConnectionBlock(profile, usedBy, controller, onNotice, onError)
        }
        return
    }

    key(tokens.link?.accountId, tokens.link?.linkedAt) {
        TokensAccountPage(
            tokens = tokens,
            profile = profile,
            controller = controller,
            applying = exiting || channel?.updating(CHANNEL_TOKENS) == true,
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
                    label = stringResource(R.string.model_config_sign_out),
                    icon = Lucide.LogOut,
                    enabled = !busy && !exiting,
                    loading = exiting,
                    onClick = { confirmingExit = true },
                )
            },
            header = {
                if (exiting || exitPhase == ModelConfigController.ExitPhase.Failed) {
                    NoticeText(
                        stringResource(
                            when (exitPhase) {
                                ModelConfigController.ExitPhase.WaitingOnline -> R.string.model_config_exit_waiting_online
                                ModelConfigController.ExitPhase.Waiting -> R.string.model_config_exit_waiting
                                ModelConfigController.ExitPhase.Failed -> R.string.model_config_exit_failed
                                else -> R.string.model_config_exit_switching
                            },
                        ),
                    )
                }
                if (tokens.link?.relinkSoon == true) NoticeText(stringResource(R.string.model_config_relink_soon))
            },
            connection = {
                if (profile != null && !exiting) TokensConnectionBlock(profile, usedBy, controller, onNotice, onError)
            },
            protocolAddresses = { profile?.let { ProtocolAddresses(it) } },
            runtimes = { runtimesBlock(false) },
        )
    }
}

/** Where runtimes reach Tokens Anywhere and with which key. */
@Composable
private fun TokensConnectionBlock(
    profile: ModelProfile,
    usedBy: Int,
    controller: ModelConfigController,
    onNotice: (String) -> Unit,
    onError: (Throwable) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember(profile.id) { mutableStateOf(false) }
    var confirmRotation by remember(profile.id) { mutableStateOf(false) }
    var confirmInterrupt by remember { mutableStateOf<(suspend () -> Unit)?>(null) }

    fun rotateKey() {
        busy = true
        // A `busy` answer comes before anything rotates, so asking again is safe.
        suspend fun rotate(allowInterrupt: Boolean) {
            controller.rotateTokensKey(profile.id, allowInterrupt = allowInterrupt)
                .onSuccess { onNotice(context.getString(R.string.model_config_rotated)) }
                .onFailure { error ->
                    if (!allowInterrupt && modelConfigErrorCode(error) == "busy") {
                        confirmInterrupt = { rotate(allowInterrupt = true) }
                    } else {
                        onError(error)
                    }
                }
        }
        scope.launch {
            rotate(allowInterrupt = false)
            busy = false
        }
    }
    confirmInterrupt?.let { retry ->
        InterruptConfirmDialog(
            onDismiss = { confirmInterrupt = null },
            onConfirm = {
                retry()
                confirmInterrupt = null
            },
        )
    }
    if (confirmRotation) {
        RotateKeyConfirmDialog(
            onDismiss = { confirmRotation = false },
            onConfirm = {
                confirmRotation = false
                rotateKey()
            },
        )
    }

    Section(
        title = stringResource(R.string.model_config_connection),
        description = null,
        action = {
            SmallButton(
                label = stringResource(R.string.model_config_rotate),
                icon = Lucide.RefreshCw,
                loading = busy,
                enabled = !busy,
                onClick = { confirmRotation = true },
            )
        },
    ) {
        ProfileCard {
            ConnectionRow(stringResource(R.string.model_config_address), profile.originHost, copyable = true)
            profile.keyHint?.let { hint ->
                RowDivider()
                // Only the ends of the key are kept, so there is nothing to copy.
                ConnectionRow(stringResource(R.string.model_config_api_key), hint, monospace = true)
            }
            RowDivider()
            ConnectionRow(
                stringResource(R.string.model_config_usage),
                if (usedBy > 0) {
                    androidx.compose.ui.res.pluralStringResource(R.plurals.model_config_used_by, usedBy, usedBy)
                } else {
                    stringResource(R.string.model_config_unused)
                },
            )
        }
    }
}

@Composable
private fun ConnectionRow(label: String, value: String, monospace: Boolean = false, copyable: Boolean = false) {
    val colors = LocalAAColors.current
    Row(
        Modifier.fillMaxWidth().padding(start = 14.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(label, color = colors.muted, fontSize = 13.sp, modifier = Modifier.width(64.dp))
        Text(
            value,
            color = colors.ink,
            fontSize = 13.sp,
            lineHeight = 18.sp,
            fontFamily = if (monospace) FontFamily.Monospace else null,
            modifier = Modifier.weight(1f).padding(vertical = 4.dp),
        )
        if (copyable) CopyAction(value)
    }
}

@Composable
private fun ProtocolAddresses(profile: ModelProfile) {
    val colors = LocalAAColors.current
    var open by remember(profile.id) { mutableStateOf(false) }
    if (profile.offers.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            Modifier
                .clip(RoundedCornerShape(6.dp))
                .clickable { open = !open }
                .padding(vertical = 4.dp, horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(if (open) Lucide.ChevronDown else Lucide.ChevronRight, contentDescription = null, tint = colors.muted, modifier = Modifier.size(15.dp))
            Text(stringResource(R.string.model_config_account_protocol_addresses), color = colors.muted, fontSize = 13.sp)
        }
        if (open) {
            ProfileCard {
                profile.offers.forEachIndexed { index, offer ->
                    if (index > 0) RowDivider()
                    Row(
                        Modifier.fillMaxWidth().padding(start = 14.dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            MutedText(protocolLabel(offer.format))
                            Text(offer.baseUrl, color = colors.ink, fontSize = 12.sp, lineHeight = 16.sp, fontFamily = FontFamily.Monospace)
                        }
                        CopyAction(offer.baseUrl)
                    }
                }
            }
        }
    }
}

@Composable
private fun CopyAction(value: String) {
    val context = LocalContext.current
    val colors = LocalAAColors.current
    var copied by remember(value) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }
    Box(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable {
                val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText("", value))
                copied = true
            }
            .padding(horizontal = 8.dp, vertical = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(if (copied) Lucide.Check else Lucide.Copy, contentDescription = null, tint = colors.muted, modifier = Modifier.size(13.dp))
            Text(
                stringResource(if (copied) R.string.model_config_copied else R.string.common_copy),
                color = colors.muted,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}
