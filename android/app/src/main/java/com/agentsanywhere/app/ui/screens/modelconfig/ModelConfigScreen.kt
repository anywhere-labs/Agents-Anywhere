package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
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
import com.agentsanywhere.app.feature.modelconfig.canDelete
import com.agentsanywhere.app.feature.modelconfig.modelConfigErrorCode
import com.agentsanywhere.app.feature.modelconfig.modelCount
import com.agentsanywhere.app.feature.modelconfig.uses
import com.agentsanywhere.app.feature.modelconfig.usedBy
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.CHANNEL_TOKENS
import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.BackIconButton
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.screens.profile.ProfileCard
import com.agentsanywhere.app.ui.screens.profile.profilePageBackground
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.RefreshCw
import com.composables.icons.lucide.Trash2
import kotlinx.coroutines.launch

/** 「配置管理」: the current channel and each runtime's progress, Tokens Anywhere and manual model services. */
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
    val pendingBar = remember { PendingModelsBarSlot() }
    // A channel write answers with the new channel state; show it until the next snapshot.
    var localChannel by remember(state.overview?.channel) { mutableStateOf<ModelChannelState?>(null) }
    var settingChannel by remember { mutableStateOf<String?>(null) }
    BackHandler(onBack = onBack)

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
            controller.setChannel(channel).onSuccess { acceptChannel(it) }.onFailure(notifyError)
            settingChannel = null
        }
    }

    Scaffold(
        containerColor = profilePageBackground(colors),
        contentWindowInsets = WindowInsets(0),
        topBar = { ModelConfigHeader(onBack = onBack) },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            val overview = state.overview
            if (overview == null) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = colors.muted, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
                }
            } else {
                val channel = localChannel?.takeIf { it.revision >= (overview.channel?.revision ?: -1L) } ?: overview.channel
                // A plain column keeps the Tokens card (its tab, edits and loaded
                // usage) alive while the rest of the page scrolls past it.
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .navigationBarsPadding()
                        .padding(horizontal = 18.dp)
                        .padding(top = 8.dp, bottom = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (!overview.secretConfigured) {
                        NoticeText(stringResource(R.string.model_config_secret_missing))
                    }
                    if (channel != null) {
                        ChannelSection(
                            overview = overview,
                            channel = channel,
                            runtimes = state.runtimes,
                            devices = devices,
                            controller = controller,
                            settingChannel = settingChannel != null,
                            onSetChannel = ::setChannel,
                            onChannelState = { acceptChannel(it) },
                            onError = notifyError,
                        )
                    }
                    overview.tokens?.takeIf { it.available }?.let { tokens ->
                        TokensChannelCard(
                            tokens = tokens,
                            overview = overview,
                            channel = channel,
                            controller = controller,
                            pendingBar = pendingBar,
                            settingCurrent = settingChannel == CHANNEL_TOKENS,
                            onSetCurrent = { setChannel(CHANNEL_TOKENS) },
                            onNotice = { notify(it) },
                            onError = notifyError,
                        )
                    }
                    ProfilesSection(
                        overview = overview,
                        channel = channel,
                        controller = controller,
                        settingChannel = settingChannel,
                        onAdd = { creating = true },
                        onSetCurrent = ::setChannel,
                        onNotice = { message, error -> notify(message, error) },
                        onError = notifyError,
                    )
                    PendingBarSpacer(pendingBar)
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
}

@Composable
private fun ModelConfigHeader(onBack: () -> Unit) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 18.dp).height(64.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BackIconButton(onClick = onBack)
        Text(
            stringResource(R.string.model_config_title),
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
private fun ProfilesSection(
    overview: ModelConfigOverview,
    channel: ModelChannelState?,
    controller: ModelConfigController,
    settingChannel: String?,
    onAdd: () -> Unit,
    onSetCurrent: (String) -> Unit,
    onNotice: (String, Boolean) -> Unit,
    onError: (Throwable) -> Unit,
) {
    Section(
        title = stringResource(R.string.model_config_profiles_title),
        description = stringResource(R.string.model_config_profiles_description),
        action = {
            SmallButton(
                label = stringResource(R.string.model_config_add_profile),
                icon = Lucide.Plus,
                enabled = overview.secretConfigured,
                onClick = onAdd,
            )
        },
    ) {
        ProfileCard {
            if (overview.profiles.isEmpty()) {
                MutedText(stringResource(R.string.model_config_no_profiles), Modifier.padding(14.dp))
            }
            overview.profiles.forEachIndexed { index, profile ->
                if (index > 0) RowDivider()
                ProfileItem(
                    profile = profile,
                    usedBy = overview.usedBy(profile.id),
                    // The Tokens profile is used through the "tokens" channel.
                    current = channel?.channel == (if (profile.isTokens) CHANNEL_TOKENS else profile.id),
                    inChannel = channel.uses(if (profile.isTokens) CHANNEL_TOKENS else profile.id),
                    canSetCurrent = channel != null && profile.isManual && profile.isActive,
                    settingCurrent = settingChannel == profile.id,
                    controller = controller,
                    onSetCurrent = { onSetCurrent(profile.id) },
                    onNotice = onNotice,
                    onError = onError,
                )
            }
        }
    }
}

@Composable
private fun ProfileItem(
    profile: ModelProfile,
    usedBy: Int,
    current: Boolean,
    inChannel: Boolean,
    canSetCurrent: Boolean,
    settingCurrent: Boolean,
    controller: ModelConfigController,
    onSetCurrent: () -> Unit,
    onNotice: (String, Boolean) -> Unit,
    onError: (Throwable) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember(profile.id) { mutableStateOf(false) }
    var confirmInterrupt by remember { mutableStateOf<(suspend () -> Unit)?>(null) }
    confirmInterrupt?.let { retry ->
        InterruptConfirmDialog(
            onDismiss = { confirmInterrupt = null },
            onConfirm = {
                retry()
                confirmInterrupt = null
            },
        )
    }
    var confirmRotation by remember(profile.id) { mutableStateOf(false) }
    fun rotateKey() {
        busy = true
        // A `busy` answer comes before anything rotates, so asking again is safe.
        suspend fun rotate(allowInterrupt: Boolean) {
            controller.rotateTokensKey(profile.id, allowInterrupt = allowInterrupt)
                .onSuccess { onNotice(context.getString(R.string.model_config_rotated), false) }
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
    if (confirmRotation) {
        RotateKeyConfirmDialog(
            onDismiss = { confirmRotation = false },
            onConfirm = {
                confirmRotation = false
                rotateKey()
            },
        )
    }
    val source = stringResource(if (profile.isTokens) R.string.model_config_source_tokens else R.string.model_config_source_manual)

    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TitleLine(
            title = profile.name,
            // The Tokens profile is already named after its source.
            tags = listOfNotNull(
                source.takeIf { it != profile.name },
                stringResource(R.string.model_config_detached).takeIf { !profile.isActive },
            ),
            currentTag = stringResource(R.string.model_config_channel_current).takeIf { current },
            wrapTitle = true,
        )
        ProfileDetails(profile, usedBy)
        ActionRow {
            if (canSetCurrent && !current) {
                SmallButton(
                    label = stringResource(R.string.model_config_channel_set_current),
                    icon = Lucide.Check,
                    primary = true,
                    loading = settingCurrent,
                    enabled = !busy && !settingCurrent,
                    onClick = onSetCurrent,
                )
            }
            if (profile.isTokens && profile.isActive) {
                SmallButton(
                    label = stringResource(R.string.model_config_rotate),
                    icon = Lucide.RefreshCw,
                    loading = busy,
                    enabled = !busy,
                    onClick = { confirmRotation = true },
                )
            }
            if (profile.isManual || !profile.isActive) {
                SmallButton(
                    label = stringResource(R.string.model_config_delete_profile),
                    icon = Lucide.Trash2,
                    danger = true,
                    enabled = !busy && profile.canDelete(usedBy, inChannel),
                    onClick = {
                        busy = true
                        scope.launch {
                            controller.deleteProfile(profile.id).onFailure(onError)
                            busy = false
                        }
                    },
                )
            }
        }
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TitleLine(
    title: String,
    subtitle: String? = null,
    maturity: String? = null,
    tags: List<String> = emptyList(),
    /** 「使用中」: shown in the OK tone so the current channel stands out. */
    currentTag: String? = null,
    wrapTitle: Boolean = false,
) {
    val colors = LocalAAColors.current
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            title,
            color = colors.ink,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = if (wrapTitle) Int.MAX_VALUE else 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.CenterVertically),
        )
        subtitle?.let {
            Text(it, color = colors.muted, fontSize = 13.sp, maxLines = 1, modifier = Modifier.align(Alignment.CenterVertically))
        }
        RuntimeMaturityBadge(maturity, Modifier.align(Alignment.CenterVertically))
        currentTag?.let { StatusPill(it, ModelStatusTone.Ok, Modifier.align(Alignment.CenterVertically)) }
        tags.forEach { StatusPill(it, ModelStatusTone.Neutral, Modifier.align(Alignment.CenterVertically)) }
    }
}

/** Every detail is labelled and wraps instead of being cut off. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProfileDetails(profile: ModelProfile, usedBy: Int) {
    val colors = LocalAAColors.current
    var expanded by remember(profile.id) { mutableStateOf(false) }
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
private fun DetailRow(label: String, value: @Composable () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, color = LocalAAColors.current.muted, fontSize = 12.sp, lineHeight = 17.sp, modifier = Modifier.width(64.dp))
        Box(Modifier.weight(1f)) { value() }
    }
}

@Composable
private fun DetailValue(text: String, monospace: Boolean = false) {
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
