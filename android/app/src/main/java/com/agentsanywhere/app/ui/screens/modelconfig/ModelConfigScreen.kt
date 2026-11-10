package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.modelconfig.ModelConfigController
import com.agentsanywhere.app.feature.modelconfig.ModelConfigState
import com.agentsanywhere.app.feature.modelconfig.ModelStatusTone
import com.agentsanywhere.app.feature.modelconfig.modelConfigErrorCode
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.CHANNEL_NATIVE
import com.agentsanywhere.app.model.CHANNEL_TOKENS
import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.BackIconButton
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.screens.profile.profilePageBackground
import kotlinx.coroutines.launch

/**
 * 「模型渠道」, as on the desktop: a list of channels, and one page per channel
 * with what it needs. Every channel is one tap away, so nothing piles up here.
 */
@Composable
fun ModelConfigScreen(
    state: ModelConfigState,
    devices: List<AgentDevice>,
    controller: ModelConfigController,
    onBack: () -> Unit,
) {
    val colors = LocalAAColors.current
    val toastHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var creating by remember { mutableStateOf(false) }
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var confirmingDiscard by remember { mutableStateOf(false) }
    val pendingBar = remember { PendingModelsBarSlot() }
    // A channel write answers with the new channel state; show it until the next snapshot.
    var localChannel by remember(state.overview?.channel) { mutableStateOf<ModelChannelState?>(null) }
    var settingChannel by remember { mutableStateOf<String?>(null) }

    fun notify(message: String, error: Boolean = false) {
        scope.launch { toastHostState.showSnackbar(AAToastVisuals(message = message, isError = error)) }
    }
    val notifyError: (Throwable) -> Unit = { error ->
        notify(context.getString(modelConfigErrorRes(modelConfigErrorCode(error))), error = true)
    }
    fun acceptChannel(next: ModelChannelState) {
        val currentRevision = maxOf(localChannel?.revision ?: -1L, state.overview?.channel?.revision ?: -1L)
        if (next.revision >= currentRevision) localChannel = next
    }
    fun setChannel(channel: String) {
        if (settingChannel != null) return
        settingChannel = channel
        scope.launch {
            controller.setChannel(channel)
                .onSuccess {
                    acceptChannel(it)
                    notify(context.getString(R.string.model_config_switched))
                }
                .onFailure(notifyError)
            settingChannel = null
        }
    }

    val overview = state.overview
    val channel = overview?.let { localChannel?.takeIf { local -> local.revision >= (it.channel?.revision ?: -1L) } ?: it.channel }
    // A channel can go away while its page is open (deleted elsewhere): back to the list.
    val current = selected?.takeIf { overview != null && it in overview.channelIds() }

    // Kept here, not on the channel's page: looking at another channel must not stop the exit.
    val link = overview?.tokens?.link
    var exiting by remember(link?.accountId, link?.linkedAt) { mutableStateOf(false) }
    var exited by remember(link?.accountId, link?.linkedAt) { mutableStateOf(false) }
    val exitPhase by controller.exitPhase.collectAsState()
    LaunchedEffect(link?.accountId, link?.linkedAt) { controller.resetExitFailure() }
    LaunchedEffect(channel) { channel?.let(controller::observeExitChannel) }
    LaunchedEffect(exiting, link?.accountId, link?.linkedAt) {
        if (exiting) {
            try {
                controller.exitTokens(state.runtimes, ::acceptChannel).onSuccess { revoked ->
                    exited = true
                    notify(context.getString(if (revoked) R.string.model_config_signed_out else R.string.model_config_not_revoked))
                }.onFailure(notifyError)
            } finally {
                exiting = false
            }
        }
    }

    fun goBack() {
        when {
            current == null -> onBack()
            pendingBar.bar != null -> confirmingDiscard = true
            else -> selected = null
        }
    }
    BackHandler(onBack = ::goBack)

    Scaffold(
        containerColor = profilePageBackground(colors),
        contentWindowInsets = WindowInsets(0),
        topBar = {
            ModelConfigHeader(
                title = when {
                    current != null && overview != null -> channelLabel(current, overview)
                    else -> stringResource(R.string.model_config_title)
                },
                onBack = ::goBack,
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (overview == null) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = colors.muted, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
                }
            } else {
                AnimatedContent(
                    targetState = current,
                    transitionSpec = {
                        val forward = targetState != null
                        (slideInHorizontally(tween(220)) { width -> if (forward) width / 5 else -width / 5 } + fadeIn(tween(220))) togetherWith
                            (slideOutHorizontally(tween(180)) { width -> if (forward) -width / 5 else width / 5 } + fadeOut(tween(180)))
                    },
                    label = "model-config-page",
                ) { page ->
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .navigationBarsPadding()
                            .padding(horizontal = 18.dp)
                            .padding(top = 8.dp, bottom = 28.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        if (page == null) {
                            ChannelListPage(
                                overview = overview,
                                channel = channel,
                                onOpen = { selected = it },
                                onAdd = { creating = true },
                            )
                        } else {
                            ChannelDetailPage(
                                channelId = page,
                                overview = overview,
                                channel = channel,
                                runtimes = state.runtimes,
                                devices = devices,
                                controller = controller,
                                pendingBar = pendingBar,
                                settingChannel = settingChannel,
                                onApply = ::setChannel,
                                exiting = exiting,
                                exited = exited,
                                exitPhase = exitPhase,
                                onExit = { exiting = true },
                                onChannelState = ::acceptChannel,
                                onNotice = { notify(it) },
                                onError = notifyError,
                            )
                            PendingBarSpacer(pendingBar)
                        }
                    }
                }
                PendingModelsBarHost(
                    slot = pendingBar,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .navigationBarsPadding()
                        .padding(horizontal = 18.dp, vertical = 12.dp),
                )
            }
            AAToastHost(
                hostState = toastHostState,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp, start = 22.dp, end = 22.dp),
            )
        }
    }

    if (creating) {
        ProfileFormDialog(
            onDismiss = { creating = false },
            onSave = { draft ->
                controller.createProfile(draft)
                    .onSuccess {
                        creating = false
                        notify(context.getString(R.string.model_config_profile_saved))
                    }
            },
            onError = notifyError,
        )
    }
    if (confirmingDiscard) {
        val count = pendingBar.bar?.count ?: 0
        ConfirmActionDialog(
            title = pluralStringResource(R.plurals.model_config_account_pending, count, count),
            description = stringResource(R.string.model_config_account_models_hint),
            confirmLabel = stringResource(R.string.model_config_account_discard),
            onDismiss = { confirmingDiscard = false },
            onConfirm = {
                confirmingDiscard = false
                selected = null
            },
        )
    }
}

/** Every channel the page lists; the active Tokens profile belongs to the Tokens Anywhere channel. */
private fun ModelConfigOverview.channelIds(): Set<String> = buildSet {
    add(CHANNEL_NATIVE)
    if (tokens?.available == true) add(CHANNEL_TOKENS)
    profiles.filterNot { it.isTokens && it.isActive }.forEach { add(it.id) }
}

@Composable
private fun ModelConfigHeader(title: String, onBack: () -> Unit) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 18.dp).height(64.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BackIconButton(onClick = onBack)
        Text(
            title,
            modifier = Modifier.weight(1f).padding(horizontal = 12.dp).semantics { heading() },
            color = colors.ink,
            fontSize = 17.sp,
            lineHeight = 22.sp,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.width(40.dp))
    }
}

@Composable
internal fun Section(
    title: String,
    description: String?,
    badge: String? = null,
    descriptionLoading: Boolean = false,
    action: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val colors = LocalAAColors.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(title, color = colors.ink, fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() })
                    badge?.let { StatusPill(it, ModelStatusTone.Neutral) }
                }
                if (description != null) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (descriptionLoading) {
                            CircularProgressIndicator(color = colors.muted, strokeWidth = 1.5.dp, modifier = Modifier.size(11.dp))
                        }
                        Text(description, color = colors.muted, fontSize = 12.sp, lineHeight = 16.sp)
                    }
                }
            }
            action?.invoke()
        }
        content()
    }
}

/** Every detail is labelled and wraps instead of being cut off. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ProfileDetails(profile: ModelProfile, usedBy: Int) {
    val colors = LocalAAColors.current
    var expanded by remember(profile.id) { mutableStateOf(true) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        DetailRow(stringResource(R.string.model_config_address)) {
            DetailValue(profile.originHost)
        }
        profile.keyHint?.let { hint ->
            DetailRow(stringResource(R.string.model_config_api_key)) {
                DetailValue(hint, monospace = true)
            }
        }
        DetailRow(stringResource(R.string.model_config_usage)) {
            DetailValue(
                if (usedBy > 0) pluralStringResource(R.plurals.model_config_used_by, usedBy, usedBy)
                else stringResource(R.string.model_config_unused),
            )
        }
        DetailRow(stringResource(R.string.model_config_protocols_label)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                profile.offers.forEach { offer ->
                    val count = offer.models.size
                    StatusPill(
                        "${protocolShortLabel(offer.format)}  " + if (count > 0) {
                            pluralStringResource(R.plurals.model_config_model_count, count, count)
                        } else {
                            stringResource(R.string.model_config_models_discovered)
                        },
                        ModelStatusTone.Neutral,
                    )
                }
            }
        }
        Text(
            text = (if (expanded) "▾ " else "▸ ") + stringResource(
                if (expanded) R.string.model_config_hide_models else R.string.model_config_show_models,
            ),
            color = colors.muted,
            fontSize = 12.sp,
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .clickable { expanded = !expanded }
                .padding(vertical = 4.dp),
        )
        if (expanded) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(colors.border.copy(alpha = 0.25f))
                    .padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                profile.offers.forEach { offer ->
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(protocolLabel(offer.format), color = colors.ink, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
                        DetailRow(stringResource(R.string.model_config_address)) { DetailValue(offer.baseUrl) }
                        DetailRow(stringResource(R.string.model_config_models)) {
                            if (offer.models.isEmpty()) {
                                MutedText(stringResource(R.string.model_config_models_discovered_description))
                            } else {
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    offer.models.forEach { model ->
                                        val label = model.name?.takeIf { it != model.id }?.let { "$it  ${model.id}" } ?: model.id
                                        StatusPill(label, ModelStatusTone.Neutral)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun DetailRow(label: String, value: @Composable () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, color = LocalAAColors.current.muted, fontSize = 12.sp, lineHeight = 17.sp, modifier = Modifier.width(64.dp))
        Box(Modifier.weight(1f)) { value() }
    }
}

@Composable
internal fun DetailValue(text: String, monospace: Boolean = false) {
    Text(
        text,
        color = LocalAAColors.current.ink,
        fontSize = 12.sp,
        lineHeight = 17.sp,
        fontFamily = if (monospace) FontFamily.Monospace else null,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ActionRow(content: @Composable () -> Unit) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}

@Composable
internal fun MutedText(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier = modifier, color = LocalAAColors.current.muted, fontSize = 12.sp, lineHeight = 16.sp)
}

@Composable
internal fun NoticeText(text: String) {
    val colors = LocalAAColors.current
    Text(
        text,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(colors.noticeWarning.copy(alpha = 0.1f))
            .padding(12.dp),
        color = colors.ink,
        fontSize = 12.5.sp,
        lineHeight = 17.sp,
    )
}

@Composable
internal fun RowDivider() {
    Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp).height(1.dp).background(LocalAAColors.current.border))
}

@Composable
internal fun SmallButton(
    label: String,
    icon: ImageVector? = null,
    primary: Boolean = false,
    danger: Boolean = false,
    loading: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(10.dp)
    val alpha = if (enabled) 1f else 0.42f
    val content = when {
        primary -> colors.onPrimaryAction
        danger -> colors.errorText
        else -> colors.ink
    }
    Row(
        modifier = Modifier
            .heightIn(min = 34.dp)
            .clip(shape)
            .background(if (primary) colors.primaryAction.copy(alpha = alpha) else colors.secondaryActionSurface.copy(alpha = alpha))
            .noRippleClickable(enabled = enabled && !loading, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (loading) {
            CircularProgressIndicator(color = content, strokeWidth = 1.5.dp, modifier = Modifier.size(14.dp))
        } else if (icon != null) {
            Icon(icon, contentDescription = null, tint = content.copy(alpha = if (enabled) 1f else 0.6f), modifier = Modifier.size(15.dp))
        }
        Text(label, color = content.copy(alpha = if (enabled) 1f else 0.6f), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}
