package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.modelconfig.ModelConfigController
import com.agentsanywhere.app.feature.modelconfig.ModelConfigDeviceRow
import com.agentsanywhere.app.feature.modelconfig.ModelConfigState
import com.agentsanywhere.app.feature.modelconfig.ModelStatusTone
import com.agentsanywhere.app.feature.modelconfig.activeTokensProfile
import com.agentsanywhere.app.feature.modelconfig.assignmentStatusTone
import com.agentsanywhere.app.feature.modelconfig.canDelete
import com.agentsanywhere.app.feature.modelconfig.connectionStateTone
import com.agentsanywhere.app.feature.modelconfig.modelConfigDeviceRows
import com.agentsanywhere.app.feature.modelconfig.modelConfigErrorCode
import com.agentsanywhere.app.feature.modelconfig.modelCount
import com.agentsanywhere.app.feature.modelconfig.newIdempotencyKey
import com.agentsanywhere.app.feature.modelconfig.summary
import com.agentsanywhere.app.feature.modelconfig.usedBy
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.model.TokensLinkStatus
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.BackIconButton
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.screens.profile.ProfileCard
import com.agentsanywhere.app.ui.screens.profile.profilePageBackground
import com.composables.icons.lucide.Link2
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.RefreshCw
import com.composables.icons.lucide.RotateCcw
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.Unlink
import com.composables.icons.lucide.Upload
import kotlinx.coroutines.launch

/** 「配置管理」: Tokens Anywhere, model profiles and the runtimes that take a model connection. */
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
    var applyProfile by remember { mutableStateOf<ModelProfile?>(null) }
    BackHandler(onBack = onBack)

    fun notify(message: String, error: Boolean = false) {
        scope.launch { toastHostState.showSnackbar(AAToastVisuals(message = message, isError = error)) }
    }
    val notifyError: (Throwable) -> Unit = { error ->
        notify(context.getString(modelConfigErrorRes(modelConfigErrorCode(error))), error = true)
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
                val rows = modelConfigDeviceRows(state.runtimes, overview.assignments)
                LazyColumn(
                    modifier = Modifier.fillMaxSize().navigationBarsPadding().padding(horizontal = 18.dp),
                    contentPadding = PaddingValues(top = 8.dp, bottom = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (!overview.secretConfigured) {
                        item("secret") { NoticeText(stringResource(R.string.model_config_secret_missing)) }
                    }
                    overview.tokens?.takeIf { it.available }?.let { tokens ->
                        item("tokens") {
                            TokensSection(
                                tokens = tokens,
                                overview = overview,
                                controller = controller,
                                onNotice = { notify(it) },
                                onError = notifyError,
                            )
                        }
                    }
                    item("profiles") {
                        ProfilesSection(
                            overview = overview,
                            controller = controller,
                            onAdd = { creating = true },
                            onApply = { applyProfile = it },
                            onNotice = { message, error -> notify(message, error) },
                            onError = notifyError,
                        )
                    }
                    item("devices") {
                        DevicesSection(
                            rows = rows,
                            devices = devices,
                            overview = overview,
                            controller = controller,
                            onNotice = { notify(it) },
                            onError = notifyError,
                        )
                    }
                }
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
                    .onFailure(notifyError)
            },
        )
    }
    applyProfile?.let { profile ->
        ApplyProfileDialog(
            profile = profile,
            devices = devices,
            controller = controller,
            onDismiss = { applyProfile = null },
            onApplied = { operation ->
                applyProfile = null
                val summary = operation.summary()
                if (summary.other == 0) {
                    notify(context.resources.getQuantityString(R.plurals.model_config_applied_count, summary.applied, summary.applied))
                } else {
                    notify(context.getString(R.string.model_config_applied_partially, summary.applied, summary.other), error = true)
                }
            },
            onError = { error ->
                notifyError(error)
            },
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
private fun TokensSection(
    tokens: TokensLinkStatus,
    overview: ModelConfigOverview,
    controller: ModelConfigController,
    onNotice: (String) -> Unit,
    onError: (Throwable) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf<String?>(null) }
    var confirmUnlink by remember { mutableStateOf(false) }
    val link = tokens.link
    val tokensProfile = overview.activeTokensProfile()
    val usedBy = tokensProfile?.let { overview.usedBy(it.id) } ?: 0

    fun run(kind: String, action: suspend () -> Unit) {
        if (busy != null) return
        busy = kind
        scope.launch {
            try {
                action()
            } finally {
                busy = null
            }
        }
    }

    Section(
        title = stringResource(R.string.model_config_tokens_title),
        description = when {
            link == null -> stringResource(R.string.model_config_tokens_description)
            link.linked -> stringResource(R.string.model_config_tokens_linked, link.accountLabel)
            else -> stringResource(R.string.model_config_tokens_reauth)
        },
    ) {
        ProfileCard {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (link?.relinkSoon == true) {
                    NoticeText(stringResource(R.string.model_config_relink_soon))
                }
                if (link != null && tokensProfile == null) {
                    MutedText(stringResource(R.string.model_config_tokens_not_synced))
                }
                ActionRow {
                    if (link == null || !link.linked) {
                        SmallButton(
                            label = stringResource(if (link == null) R.string.model_config_link else R.string.model_config_relink),
                            icon = Lucide.Link2,
                            primary = true,
                            loading = busy == "link",
                            enabled = busy == null && tokens.secretConfigured,
                            onClick = {
                                run("link") {
                                    controller.beginTokensLink()
                                        .onSuccess { startUrl ->
                                            if (openTokensLinkStart(context, startUrl)) {
                                                onNotice(context.getString(R.string.model_config_link_opened))
                                            } else {
                                                onError(IllegalStateException("No browser"))
                                            }
                                        }
                                        .onFailure(onError)
                                }
                            },
                        )
                    } else {
                        SmallButton(
                            label = stringResource(R.string.model_config_sync),
                            icon = Lucide.RefreshCw,
                            loading = busy == "sync",
                            enabled = busy == null,
                            onClick = {
                                run("sync") {
                                    controller.syncTokens()
                                        .onSuccess { onNotice(context.getString(R.string.model_config_synced)) }
                                        .onFailure(onError)
                                }
                            },
                        )
                    }
                    if (link != null) {
                        SmallButton(
                            label = stringResource(R.string.model_config_unlink),
                            icon = Lucide.Unlink,
                            enabled = busy == null,
                            onClick = { confirmUnlink = true },
                        )
                    }
                }
            }
        }
    }

    if (confirmUnlink) {
        UnlinkTokensDialog(
            usedBy = usedBy,
            onDismiss = { confirmUnlink = false },
            onConfirm = { allowInterrupt ->
                controller.unlinkTokens(allowInterrupt)
                    .onSuccess { result ->
                        confirmUnlink = false
                        val failed = result.results.count { it.result != "restored" }
                        onNotice(
                            when {
                                failed > 0 -> context.resources.getQuantityString(
                                    R.plurals.model_config_unlinked_with_failures,
                                    failed,
                                    failed,
                                )
                                result.revoked -> context.getString(R.string.model_config_unlinked)
                                else -> context.getString(R.string.model_config_unlinked_not_revoked)
                            },
                        )
                    }
                    .onFailure(onError)
            },
        )
    }
}

@Composable
private fun ProfilesSection(
    overview: ModelConfigOverview,
    controller: ModelConfigController,
    onAdd: () -> Unit,
    onApply: (ModelProfile) -> Unit,
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
                    controller = controller,
                    onApply = { onApply(profile) },
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
    controller: ModelConfigController,
    onApply: () -> Unit,
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
    val details = listOfNotNull(
        profile.originHost.takeIf(String::isNotBlank),
        profile.offers.map { protocolLabel(it.format) }.takeIf { it.isNotEmpty() }?.joinToString(" / "),
        pluralStringResource(R.plurals.model_config_model_count, profile.modelCount(), profile.modelCount()),
        profile.keyHint?.let { stringResource(R.string.model_config_key_hint, it) },
        usedBy.takeIf { it > 0 }?.let { pluralStringResource(R.plurals.model_config_used_by, it, it) },
    ).joinToString(" · ")

    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TitleLine(
            title = profile.name,
            tags = listOfNotNull(
                stringResource(if (profile.isTokens) R.string.model_config_source_tokens else R.string.model_config_source_manual),
                stringResource(R.string.model_config_detached).takeIf { !profile.isActive },
            ),
        )
        MutedText(details)
        ActionRow {
            SmallButton(
                label = stringResource(R.string.model_config_apply),
                icon = Lucide.Upload,
                primary = true,
                enabled = !busy && profile.isActive,
                onClick = onApply,
            )
            if (profile.isTokens && profile.isActive) {
                SmallButton(
                    label = stringResource(R.string.model_config_rotate),
                    icon = Lucide.RefreshCw,
                    loading = busy,
                    enabled = !busy,
                    onClick = {
                        busy = true
                        // One key for both attempts: a `busy` answer comes before anything rotates.
                        val key = newIdempotencyKey()
                        suspend fun rotate(allowInterrupt: Boolean) {
                            controller.rotateTokensKey(profile.id, allowInterrupt = allowInterrupt, idempotencyKey = key)
                                .onSuccess { operation ->
                                    val summary = operation.summary()
                                    if (summary.other == 0) {
                                        onNotice(context.resources.getQuantityString(R.plurals.model_config_applied_count, summary.applied, summary.applied), false)
                                    } else {
                                        onNotice(context.getString(R.string.model_config_applied_partially, summary.applied, summary.other), true)
                                    }
                                }
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
                    },
                )
            }
            if (profile.isManual || !profile.isActive) {
                SmallButton(
                    label = stringResource(R.string.model_config_delete_profile),
                    icon = Lucide.Trash2,
                    danger = true,
                    enabled = !busy && profile.canDelete(usedBy),
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DevicesSection(
    rows: List<ModelConfigDeviceRow>,
    devices: List<AgentDevice>,
    overview: ModelConfigOverview,
    controller: ModelConfigController,
    onNotice: (String) -> Unit,
    onError: (Throwable) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var restoring by remember { mutableStateOf<String?>(null) }
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
    Section(
        title = stringResource(R.string.model_config_devices_title),
        description = stringResource(R.string.model_config_devices_description),
    ) {
        ProfileCard {
            if (rows.isEmpty()) {
                MutedText(stringResource(R.string.model_config_no_devices), Modifier.padding(14.dp))
            }
            rows.forEachIndexed { index, row ->
                if (index > 0) RowDivider()
                val assignment = row.assignment
                val status = row.status
                val profileName = assignment?.let { item ->
                    overview.profiles.firstOrNull { it.id == item.profileId }?.name ?: item.profileId
                }
                Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    TitleLine(
                        title = row.runtime.labels.primary,
                        subtitle = devices.firstOrNull { it.id == row.runtime.connectorId }?.name,
                        maturity = row.maturity,
                        tags = listOfNotNull(stringResource(R.string.model_config_managed_instance).takeIf { row.managedHere }),
                    )
                    MutedText(
                        listOfNotNull(
                            if (profileName != null) {
                                stringResource(R.string.model_config_assigned_profile, profileName)
                            } else {
                                stringResource(R.string.model_config_not_assigned)
                            },
                            status?.reason,
                        ).joinToString(" · "),
                    )
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        if (assignment != null && assignment.status != "applied") {
                            assignmentStatusRes(assignment.status)?.let {
                                StatusPill(stringResource(it), assignmentStatusTone(assignment.status), Modifier.align(Alignment.CenterVertically))
                            }
                        }
                        if (status != null) {
                            connectionStateRes(status.state)?.let {
                                StatusPill(stringResource(it), connectionStateTone(status.state), Modifier.align(Alignment.CenterVertically))
                            }
                        }
                        Spacer(Modifier.weight(1f))
                        if (assignment != null) {
                            SmallButton(
                                label = stringResource(R.string.model_config_restore),
                                icon = Lucide.RotateCcw,
                                loading = restoring == row.key,
                                enabled = restoring == null,
                                onClick = {
                                    restoring = row.key
                                    suspend fun restore(allowInterrupt: Boolean) {
                                        controller.restore(assignment.connectorId, assignment.runtimeId, allowInterrupt = allowInterrupt)
                                            .onSuccess { onNotice(context.getString(R.string.model_config_restored)) }
                                            .onFailure { error ->
                                                if (!allowInterrupt && modelConfigErrorCode(error) == "busy") {
                                                    confirmInterrupt = { restore(allowInterrupt = true) }
                                                } else {
                                                    onError(error)
                                                }
                                            }
                                    }
                                    scope.launch {
                                        restore(allowInterrupt = false)
                                        restoring = null
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Section(
    title: String,
    description: String,
    action: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val colors = LocalAAColors.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, color = colors.ink, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Text(description, color = colors.muted, fontSize = 12.sp, lineHeight = 16.sp)
            }
            action?.invoke()
        }
        content()
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TitleLine(
    title: String,
    subtitle: String? = null,
    maturity: String? = null,
    tags: List<String> = emptyList(),
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
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.CenterVertically),
        )
        subtitle?.let {
            Text(it, color = colors.muted, fontSize = 13.sp, maxLines = 1, modifier = Modifier.align(Alignment.CenterVertically))
        }
        RuntimeMaturityBadge(maturity, Modifier.align(Alignment.CenterVertically))
        tags.forEach { StatusPill(it, ModelStatusTone.Neutral, Modifier.align(Alignment.CenterVertically)) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ActionRow(content: @Composable () -> Unit) {
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
private fun NoticeText(text: String) {
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
private fun RowDivider() {
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
