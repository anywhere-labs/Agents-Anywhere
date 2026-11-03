package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.RemoteModelPreviewTarget
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.modelconfig.ModelConfigController
import com.agentsanywhere.app.feature.modelconfig.ModelStatusTone
import com.agentsanywhere.app.feature.modelconfig.QuickAssigned
import com.agentsanywhere.app.feature.modelconfig.QuickCandidateNote
import com.agentsanywhere.app.feature.modelconfig.QuickSetupPhase
import com.agentsanywhere.app.feature.modelconfig.QuickStepStatus
import com.agentsanywhere.app.feature.modelconfig.activeTokensProfile
import com.agentsanywhere.app.feature.modelconfig.defaultQuickSelection
import com.agentsanywhere.app.feature.modelconfig.initialTokensAccountTab
import com.agentsanywhere.app.feature.modelconfig.newQuickCandidates
import com.agentsanywhere.app.feature.modelconfig.quickCandidateNote
import com.agentsanywhere.app.feature.modelconfig.quickSetupPhase
import com.agentsanywhere.app.feature.modelconfig.quickSetupRequest
import com.agentsanywhere.app.feature.modelconfig.quickSetupRunning
import com.agentsanywhere.app.feature.modelconfig.quickSetupSteps
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.model.QuickSetupRequest
import com.agentsanywhere.app.model.TokensLinkStatus
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.profile.ProfileCard
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Circle
import com.composables.icons.lucide.Link2
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.RefreshCw
import com.composables.icons.lucide.Unlink
import com.composables.icons.lucide.X
import kotlinx.coroutines.launch

/**
 * One-click Tokens Anywhere setup: tick the runtimes, confirm once in the
 * browser, and the Server syncs the models and applies them. Progress comes
 * with the snapshot, so every client shows the same steps.
 */
@Composable
internal fun TokensQuickSetupCard(
    tokens: TokensLinkStatus,
    overview: ModelConfigOverview,
    runtimes: List<DeviceRuntime>,
    devices: List<AgentDevice>,
    controller: ModelConfigController,
    pendingBar: PendingModelsBarSlot,
    onNotice: (String) -> Unit,
    onError: (Throwable) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var candidates by remember { mutableStateOf<List<RemoteModelPreviewTarget>?>(null) }
    var selected by remember { mutableStateOf<Set<String>?>(null) }
    var authorizing by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var choosing by remember { mutableStateOf(false) }
    var confirmUnlink by remember { mutableStateOf(false) }
    val tokensProfile = overview.activeTokensProfile()
    val tokenAssignments = tokensProfile?.let { profile -> overview.assignments.filter { it.profileId == profile.id } }.orEmpty()
    val runtimeKey = runtimes.joinToString("|") { "${it.connectorId}/${it.id}:${it.status}:${it.configured}" }

    // The authorization this screen opened ends once the link shows up in the snapshot.
    LaunchedEffect(tokens.linked) { if (tokens.linked) authorizing = false }
    LaunchedEffect(runtimeKey, tokensProfile?.id) {
        controller.quickSetupCandidates()
            .onSuccess { candidates = it }
            .onFailure { candidates = emptyList() }
    }

    fun runtimeFor(connectorId: String, runtimeId: String) =
        runtimes.firstOrNull { it.connectorId == connectorId && it.id == runtimeId }
    fun deviceName(connectorId: String) = devices.firstOrNull { it.id == connectorId }?.name ?: connectorId
    fun targetLabel(connectorId: String, runtimeId: String, name: String? = null) =
        "${deviceName(connectorId)} · ${name ?: runtimeFor(connectorId, runtimeId)?.labels?.primary ?: runtimeId}"

    val assigned = tokenAssignments.map {
        QuickAssigned(it.connectorId, it.runtimeId, runtimeFor(it.connectorId, it.runtimeId)?.type, it.createdRuntime)
    }
    val fresh = candidates?.let { newQuickCandidates(it, assigned) }.orEmpty()
    val phase = quickSetupPhase(tokens, tokenAssignments.isNotEmpty(), authorizing)
    val selection = selected ?: candidates?.let(::defaultQuickSelection).orEmpty()

    fun start(request: QuickSetupRequest?) {
        val payload = request ?: quickSetupRequest(candidates.orEmpty(), selection)
        if (payload.targets.isEmpty() || busy) return
        busy = true
        scope.launch {
            controller.startQuickSetup(payload)
                .onSuccess { response ->
                    choosing = false
                    response.startUrl?.let { url ->
                        authorizing = true
                        if (!openTokensLinkStart(context, url)) {
                            authorizing = false
                            onError(IllegalStateException("No browser"))
                        }
                    }
                }
                .onFailure(onError)
            busy = false
        }
    }

    val unlinkButton: @Composable () -> Unit = {
        if (tokens.link != null) {
            SmallButton(
                label = stringResource(R.string.model_config_unlink),
                icon = Lucide.Unlink,
                enabled = !busy,
                onClick = { confirmUnlink = true },
            )
        }
    }

    val choices: @Composable () -> Unit = {
        MutedText(stringResource(R.string.model_config_quick_will_configure))
        val list = candidates
        when {
            list == null -> Box(Modifier.fillMaxWidth().padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = LocalAAColors.current.muted, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
            }
            list.isEmpty() -> MutedText(stringResource(R.string.model_config_no_devices))
            else -> list.forEach { item ->
                CandidateRow(
                    item = item,
                    label = targetLabel(item.connectorId, item.runtimeId, item.name),
                    checked = item.canApply && item.key in selection,
                    onCheckedChange = { checked ->
                        selected = if (checked) selection + item.key else selection - item.key
                    },
                )
            }
        }
    }
    val startButtons: @Composable () -> Unit = {
        SmallButton(
            label = stringResource(R.string.model_config_quick_start),
            icon = Lucide.Link2,
            primary = true,
            loading = busy,
            enabled = !busy && tokens.secretConfigured &&
                candidates.orEmpty().any { it.canApply && it.key in selection },
            onClick = { start(null) },
        )
        if (choosing) {
            SmallButton(label = stringResource(R.string.common_cancel), onClick = { choosing = false })
        }
    }

    when (phase) {
        QuickSetupPhase.Setup -> Section(
            title = stringResource(R.string.model_config_quick_title),
            description = stringResource(
                if (tokens.link?.linked == false) R.string.model_config_tokens_reauth else R.string.model_config_quick_description,
            ),
        ) {
            ProfileCard {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    choices()
                    ActionRow {
                        startButtons()
                        unlinkButton()
                    }
                }
            }
        }
        QuickSetupPhase.Progress -> QuickSetupProgressCard(
            tokens = tokens,
            authorizing = authorizing,
            busy = busy,
            onRetry = { start(tokens.quickSetup?.request) },
            onCancel = { authorizing = false },
        )
        QuickSetupPhase.Done -> TokensAccountPage(
            tokens = tokens,
            profile = tokensProfile,
            controller = controller,
            applying = quickSetupRunning(tokens),
            initialTab = initialTokensAccountTab(configured = tokenAssignments.isNotEmpty()),
            syncing = busy,
            onSync = {
                busy = true
                scope.launch {
                    controller.syncTokens()
                        .onSuccess { onNotice(context.getString(R.string.model_config_synced)) }
                        .onFailure(onError)
                    busy = false
                }
            },
            pendingBar = pendingBar,
            onNotice = onNotice,
            onError = onError,
            action = unlinkButton,
        ) {
            if (choosing || tokenAssignments.isEmpty()) {
                choices()
                ActionRow { startButtons() }
            } else {
                if (fresh.isNotEmpty()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(toneColor(ModelStatusTone.Progress).copy(alpha = 0.08f))
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            pluralStringResource(R.plurals.model_config_quick_new_runtimes, fresh.size, fresh.size),
                            color = LocalAAColors.current.ink,
                            fontSize = 13.sp,
                            modifier = Modifier.weight(1f),
                        )
                        SmallButton(
                            label = stringResource(R.string.model_config_quick_configure_new),
                            onClick = {
                                selected = fresh.filterNot { it.requiresConfirmation }.mapTo(mutableSetOf()) { it.key }
                                choosing = true
                            },
                        )
                    }
                }
                if (tokens.link?.relinkSoon == true) NoticeText(stringResource(R.string.model_config_relink_soon))
                tokenAssignments.forEach { item ->
                    val status = if (item.status == "deferred") {
                        stringResource(R.string.model_config_quick_applies_when_idle)
                    } else {
                        val label = assignmentStatusRes(item.status)?.let { stringResource(it) } ?: item.status
                        if (item.createdRuntime) label + stringResource(R.string.model_config_quick_via_managed_instance) else label
                    }
                    ResultLine(targetLabel(item.connectorId, item.runtimeId), status, warning = false)
                }
                val results = tokens.quickSetup?.results.orEmpty()
                results.filter { it.result == "skipped" || it.result == "failed" }.forEach { item ->
                    ResultLine(targetLabel(item.connectorId, item.runtimeId), stringResource(reasonRes(item.reason)), warning = true)
                }
                if (results.any { it.modelsTrimmed > 0 }) MutedText(stringResource(R.string.model_config_quick_models_trimmed))
            }
        }
    }

    if (confirmUnlink) {
        UnlinkTokensDialog(
            usedBy = tokenAssignments.size,
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
private fun CandidateRow(
    item: RemoteModelPreviewTarget,
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    val colors = LocalAAColors.current
    val note = when (val value = quickCandidateNote(item)) {
        is QuickCandidateNote.Skipped -> stringResource(reasonRes(value.reason))
        QuickCandidateNote.ChangesOwnSettings -> stringResource(R.string.model_config_quick_changes_own_settings)
        QuickCandidateNote.ManagedInstance -> stringResource(R.string.model_config_quick_managed_instance)
        QuickCandidateNote.AppliesWhenIdle -> stringResource(R.string.model_config_quick_applies_when_idle)
        is QuickCandidateNote.Effect -> effectLabelRes(value.effect)?.let { stringResource(it) }.orEmpty()
    }
    Row(
        modifier = Modifier.fillMaxWidth().alpha(if (item.canApply) 1f else 0.6f),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Checkbox(checked = checked, onCheckedChange = onCheckedChange, enabled = item.canApply)
        Column(Modifier.weight(1f).padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    label,
                    color = colors.ink,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    modifier = Modifier.weight(1f, fill = false),
                )
                RuntimeMaturityBadge(item.capabilityMaturity ?: item.maturity)
            }
            if (note.isNotBlank()) MutedText(note)
        }
    }
}

@Composable
private fun ResultLine(label: String, status: String, warning: Boolean) {
    val colors = LocalAAColors.current
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, color = colors.ink, fontSize = 13.sp, modifier = Modifier.weight(1f))
        Text(
            status,
            color = if (warning) toneColor(ModelStatusTone.Warning) else colors.muted,
            fontSize = 12.sp,
        )
    }
}

@Composable
private fun QuickSetupProgressCard(
    tokens: TokensLinkStatus,
    authorizing: Boolean,
    busy: Boolean,
    onRetry: () -> Unit,
    onCancel: () -> Unit,
) {
    val steps = quickSetupSteps(tokens, authorizing)
    val progress = tokens.quickSetup
    val count = progress?.request?.targets?.size ?: 0
    val failure = stringResource(modelConfigErrorRes(progress?.code))
    Section(
        title = stringResource(R.string.model_config_quick_title),
        description = stringResource(R.string.model_config_quick_in_progress),
    ) {
        ProfileCard {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                QuickStep(
                    status = steps.authorize,
                    label = stringResource(R.string.model_config_quick_step_authorize),
                    detail = if (steps.authorize == QuickStepStatus.Done) {
                        stringResource(R.string.model_config_tokens_linked, tokens.link?.accountLabel.orEmpty())
                    } else {
                        stringResource(R.string.model_config_quick_authorize_hint)
                    },
                )
                QuickStep(
                    status = steps.sync,
                    label = stringResource(R.string.model_config_quick_step_sync),
                    detail = when (steps.sync) {
                        QuickStepStatus.Active -> stringResource(R.string.model_config_quick_syncing)
                        QuickStepStatus.Failed -> failure
                        else -> null
                    },
                )
                QuickStep(
                    status = steps.apply,
                    label = pluralStringResource(R.plurals.model_config_quick_step_apply, count, count),
                    detail = when (steps.apply) {
                        QuickStepStatus.Active -> stringResource(R.string.model_config_quick_applying)
                        QuickStepStatus.Failed -> failure
                        else -> null
                    },
                )
                if (progress?.state == "failed") {
                    ActionRow {
                        SmallButton(
                            label = stringResource(R.string.common_retry),
                            icon = Lucide.RefreshCw,
                            primary = true,
                            loading = busy,
                            enabled = !busy,
                            onClick = onRetry,
                        )
                    }
                } else if (steps.authorize == QuickStepStatus.Active) {
                    ActionRow { SmallButton(label = stringResource(R.string.common_cancel), onClick = onCancel) }
                }
            }
        }
    }
}

@Composable
private fun QuickStep(status: QuickStepStatus, label: String, detail: String?) {
    val colors = LocalAAColors.current
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
            when (status) {
                QuickStepStatus.Done -> Icon(Lucide.Check, null, tint = toneColor(ModelStatusTone.Ok), modifier = Modifier.size(16.dp))
                QuickStepStatus.Active -> CircularProgressIndicator(color = colors.muted, strokeWidth = 1.5.dp, modifier = Modifier.size(15.dp))
                QuickStepStatus.Failed -> Icon(Lucide.X, null, tint = colors.errorText, modifier = Modifier.size(16.dp))
                QuickStepStatus.Pending -> Icon(Lucide.Circle, null, tint = colors.faint, modifier = Modifier.size(13.dp))
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                label,
                color = if (status == QuickStepStatus.Pending) colors.muted else colors.ink,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
            )
            detail?.let {
                Text(it, color = if (status == QuickStepStatus.Failed) colors.errorText else colors.muted, fontSize = 12.sp, lineHeight = 16.sp)
            }
        }
    }
}
