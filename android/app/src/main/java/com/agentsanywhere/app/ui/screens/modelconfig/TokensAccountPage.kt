package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.RemoteTokensAccount
import com.agentsanywhere.app.api.RemoteTokensUsage
import com.agentsanywhere.app.feature.modelconfig.DailyCost
import com.agentsanywhere.app.feature.modelconfig.ModelConfigController
import com.agentsanywhere.app.feature.modelconfig.ModelUsage
import com.agentsanywhere.app.feature.modelconfig.TokensAccountTab
import com.agentsanywhere.app.feature.modelconfig.TokensModel
import com.agentsanywhere.app.feature.modelconfig.VendorGroup
import com.agentsanywhere.app.feature.modelconfig.amountUnits
import com.agentsanywhere.app.feature.modelconfig.changeCount
import com.agentsanywhere.app.feature.modelconfig.cleanPreferences
import com.agentsanywhere.app.feature.modelconfig.formatCompactCount
import com.agentsanywhere.app.feature.modelconfig.formatCount
import com.agentsanywhere.app.feature.modelconfig.formatTokenWindow
import com.agentsanywhere.app.feature.modelconfig.formatYuan
import com.agentsanywhere.app.feature.modelconfig.renamedTo
import com.agentsanywhere.app.feature.modelconfig.samePreferences
import com.agentsanywhere.app.feature.modelconfig.shortDate
import com.agentsanywhere.app.feature.modelconfig.summarizeUsage
import com.agentsanywhere.app.feature.modelconfig.tokensModels
import com.agentsanywhere.app.feature.modelconfig.usageModelIds
import com.agentsanywhere.app.feature.modelconfig.vendorGroups
import com.agentsanywhere.app.feature.modelconfig.withEnabled
import com.agentsanywhere.app.feature.modelconfig.withName
import com.agentsanywhere.app.model.ModelPreferences
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.model.TokensLinkStatus
import com.agentsanywhere.app.ui.designsystem.AADropdownMenu
import com.agentsanywhere.app.ui.designsystem.AADropdownMenuItem
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.profile.ProfileCard
import com.agentsanywhere.app.ui.screens.profile.ProfileDialog
import com.agentsanywhere.app.ui.screens.profile.ProfileDialogButton
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.ExternalLink
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.RefreshCw
import com.composables.icons.lucide.RotateCcw
import kotlinx.coroutines.launch

/** Unsaved model changes; shown pinned to the bottom of the screen so it stays in reach. */
internal class PendingModelsBar(
    val count: Int,
    /** Every model is off: saving is blocked. */
    val blocked: Boolean,
    val saving: Boolean,
    val canSave: Boolean,
    val onDiscard: () -> Unit,
    val onSave: () -> Unit,
)

/** Where the account page puts its [PendingModelsBar] for the screen to draw. */
@Stable
internal class PendingModelsBarSlot {
    var bar by mutableStateOf<PendingModelsBar?>(null)
}

/**
 * The linked Tokens Anywhere account: who it is, its balance, which of its
 * models runtimes get and under which names, and what it has spent. Which
 * runtimes use it shows under the current channel.
 */
@Composable
internal fun TokensAccountPage(
    tokens: TokensLinkStatus,
    profile: ModelProfile?,
    controller: ModelConfigController,
    applying: Boolean,
    syncing: Boolean,
    onSync: () -> Unit,
    pendingBar: PendingModelsBarSlot,
    onNotice: (String) -> Unit,
    onError: (Throwable) -> Unit,
    action: @Composable () -> Unit,
    header: @Composable () -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(TokensAccountTab.Models) }
    var info by remember { mutableStateOf<RemoteTokensAccount?>(null) }
    var infoFailed by remember { mutableStateOf(false) }
    var infoVersion by remember { mutableIntStateOf(0) }

    // Back from topping up in the browser, the balance should already show it.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) infoVersion += 1 }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(infoVersion, tokens.link?.accountId) {
        info = null
        infoFailed = false
        controller.tokensAccount()
            .onSuccess { info = it }
            .onFailure { infoFailed = info == null }
    }

    fun open(url: String?) {
        if (url == null || !openExternalLink(context, url)) onError(IllegalStateException("No browser"))
    }

    // Models: the saved choice, and the edits on top of it until they are saved or discarded.
    val models = remember(profile) { profile?.let(::tokensModels).orEmpty() }
    val groups = remember(models) { vendorGroups(models) }
    val profilePreferences = profile?.preferences ?: ModelPreferences.EMPTY
    var saved by remember(profilePreferences) { mutableStateOf(profilePreferences) }
    var draft by remember(saved) { mutableStateOf(saved) }
    var saving by remember { mutableStateOf(false) }
    val enabledCount = models.count { it.id !in draft.disabled }
    val next = cleanPreferences(draft, models)
    val savedClean = cleanPreferences(saved, models)
    val changes = changeCount(savedClean, next)

    fun save(preferences: ModelPreferences) {
        if (saving) return
        saving = true
        scope.launch {
            controller.saveTokensModels(preferences)
                .onSuccess { runtimesUpdating ->
                    saved = preferences
                    onNotice(
                        context.getString(
                            if (runtimesUpdating) R.string.model_config_account_saved else R.string.model_config_account_saved_no_runtimes,
                        ),
                    )
                }
                .onFailure(onError)
            saving = false
        }
    }

    val bar = if (changes > 0) {
        PendingModelsBar(
            count = changes,
            blocked = enabledCount == 0,
            saving = saving,
            canSave = !saving && !applying && enabledCount > 0,
            onDiscard = { draft = saved },
            onSave = { save(next) },
        )
    } else {
        null
    }
    SideEffect { pendingBar.bar = bar }
    DisposableEffect(pendingBar) { onDispose { pendingBar.bar = null } }

    Section(
        title = stringResource(R.string.model_config_account_title),
        badge = stringResource(R.string.runtime_maturity_beta),
        description = if (applying) stringResource(R.string.model_config_account_applying) else null,
        descriptionLoading = applying,
        action = action,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            header()
            AccountCard(
                name = info?.label ?: tokens.link?.accountLabel.orEmpty(),
                email = info?.email ?: tokens.link?.accountEmail,
                consoleUrl = info?.consoleUrl,
                onOpen = ::open,
            )
            BalanceCard(
                info = info,
                failed = infoFailed,
                onRetry = { infoVersion += 1 },
                onViewUsage = { tab = TokensAccountTab.Usage },
                onOpen = ::open,
            )
            Segmented(
                options = listOf(
                    TokensAccountTab.Models to stringResource(R.string.model_config_account_tab_models),
                    TokensAccountTab.Usage to stringResource(R.string.model_config_account_tab_usage),
                ),
                selected = tab,
                onSelect = { tab = it },
                modifier = Modifier.fillMaxWidth(),
                fill = true,
                role = Role.Tab,
            )
            when (tab) {
                TokensAccountTab.Models -> ModelsTab(
                    models = models,
                    groups = groups,
                    draft = draft,
                    enabledCount = enabledCount,
                    canRestore = !saving && !applying && !samePreferences(savedClean, ModelPreferences.EMPTY),
                    syncing = syncing,
                    onSync = onSync,
                    onRestore = { save(ModelPreferences.EMPTY) },
                    onDraft = { draft = it(draft) },
                )
                TokensAccountTab.Usage -> UsageTab(controller = controller, detailsUrl = info?.usageUrl, onOpen = ::open)
            }
        }
    }
}

@Composable
private fun AccountCard(name: String, email: String?, consoleUrl: String?, onOpen: (String?) -> Unit) {
    val colors = LocalAAColors.current
    ProfileCard {
        Row(
            Modifier.fillMaxWidth().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier.size(40.dp).clip(CircleShape).background(colors.subtle),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    name.take(1).uppercase().ifEmpty { "?" },
                    color = colors.ink,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(name, color = colors.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (email != null && email != name) {
                    Text(email, color = colors.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (consoleUrl != null) {
                    LinkText(stringResource(R.string.model_config_account_more_info)) { onOpen(consoleUrl) }
                }
            }
        }
    }
}

@Composable
private fun BalanceCard(
    info: RemoteTokensAccount?,
    failed: Boolean,
    onRetry: () -> Unit,
    onViewUsage: () -> Unit,
    onOpen: (String?) -> Unit,
) {
    val colors = LocalAAColors.current
    ProfileCard {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                MutedText(stringResource(R.string.model_config_account_balance))
                when {
                    info != null -> {
                        Text(
                            formatYuan(amountUnits(info.balance.balance)),
                            color = colors.ink,
                            fontSize = 24.sp,
                            lineHeight = 30.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        MutedText(
                            stringResource(
                                R.string.model_config_account_balance_detail,
                                formatYuan(amountUnits(info.balance.available)),
                                formatYuan(amountUnits(info.balance.bonus)),
                            ),
                        )
                    }
                    failed -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            stringResource(R.string.model_config_account_load_failed),
                            color = colors.muted,
                            fontSize = 13.sp,
                            modifier = Modifier.weight(1f),
                        )
                        SmallButton(label = stringResource(R.string.common_retry), icon = Lucide.RefreshCw, onClick = onRetry)
                    }
                    else -> CircularProgressIndicator(
                        color = colors.muted,
                        strokeWidth = 2.dp,
                        modifier = Modifier.padding(vertical = 6.dp).size(20.dp),
                    )
                }
            }
            ActionRow {
                SmallButton(label = stringResource(R.string.model_config_account_view_usage), onClick = onViewUsage)
                SmallButton(
                    label = stringResource(R.string.model_config_account_top_up),
                    icon = Lucide.ExternalLink,
                    primary = true,
                    enabled = info?.billingUrl != null,
                    onClick = { onOpen(info?.billingUrl) },
                )
            }
        }
    }
}

@Composable
private fun ModelsTab(
    models: List<TokensModel>,
    groups: List<VendorGroup>,
    draft: ModelPreferences,
    enabledCount: Int,
    canRestore: Boolean,
    syncing: Boolean,
    onSync: () -> Unit,
    onRestore: () -> Unit,
    onDraft: ((ModelPreferences) -> ModelPreferences) -> Unit,
) {
    val refresh: @Composable () -> Unit = {
        SmallButton(
            label = stringResource(R.string.model_config_account_refresh),
            icon = Lucide.RefreshCw,
            loading = syncing,
            enabled = !syncing,
            onClick = onSync,
        )
    }
    if (models.isEmpty()) {
        ProfileCard {
            Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                MutedText(stringResource(R.string.model_config_account_no_models))
                ActionRow { refresh() }
            }
        }
        return
    }
    var expanded by remember { mutableStateOf<Set<String>?>(null) }
    val open = expanded ?: if (models.size <= 12) groups.mapTo(mutableSetOf()) { it.key } else emptySet()
    var renaming by remember { mutableStateOf<TokensModel?>(null) }
    val disabled = draft.disabled.toSet()

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                pluralStringResource(R.plurals.model_config_account_models_summary, models.size, models.size, enabledCount),
                color = LocalAAColors.current.ink,
                fontSize = 13.sp,
                lineHeight = 18.sp,
            )
            MutedText(stringResource(R.string.model_config_account_models_hint))
        }
        ActionRow {
            SmallButton(
                label = stringResource(R.string.model_config_account_restore_defaults),
                icon = Lucide.RotateCcw,
                enabled = canRestore,
                onClick = onRestore,
            )
            refresh()
        }
        ProfileCard {
            groups.forEachIndexed { index, group ->
                if (index > 0) RowDivider()
                val isOpen = group.key in open
                VendorGroupRow(
                    group = group,
                    on = group.models.count { it.id !in disabled },
                    open = isOpen,
                    onToggleOpen = { expanded = if (isOpen) open - group.key else open + group.key },
                    onEnabled = { value -> onDraft { it.withEnabled(group.models.map(TokensModel::id), value) } },
                )
                if (isOpen) {
                    Column(Modifier.fillMaxWidth().background(LocalAAColors.current.border.copy(alpha = 0.18f))) {
                        group.models.forEachIndexed { modelIndex, model ->
                            if (modelIndex > 0) RowDivider()
                            ModelRow(
                                model = model,
                                name = draft.names[model.id],
                                enabled = model.id !in disabled,
                                onEnabled = { value -> onDraft { it.withEnabled(listOf(model.id), value) } },
                                onRename = { renaming = model },
                            )
                        }
                    }
                }
            }
        }
    }

    renaming?.let { model ->
        RenameModelDialog(
            model = model,
            current = draft.names[model.id],
            onDismiss = { renaming = null },
            onRename = { name ->
                onDraft { it.withName(model.id, name) }
                renaming = null
            },
        )
    }
}

@Composable
private fun VendorGroupRow(
    group: VendorGroup,
    on: Int,
    open: Boolean,
    onToggleOpen: () -> Unit,
    onEnabled: (Boolean) -> Unit,
) {
    val colors = LocalAAColors.current
    val label = group.label ?: stringResource(R.string.model_config_account_other_vendor)
    val description = stringResource(R.string.model_config_account_toggle_group, label)
    Row(
        Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(8.dp))
                .clickable(onClick = onToggleOpen)
                .padding(horizontal = 8.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                if (open) Lucide.ChevronDown else Lucide.ChevronRight,
                contentDescription = null,
                tint = colors.muted,
                modifier = Modifier.size(16.dp),
            )
            Text(
                label,
                color = colors.ink,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Text("$on/${group.models.size}", color = colors.muted, fontSize = 12.sp)
        }
        Switch(
            checked = on == group.models.size,
            onCheckedChange = onEnabled,
            modifier = Modifier.semantics { contentDescription = description },
        )
    }
}

@Composable
private fun ModelRow(
    model: TokensModel,
    name: String?,
    enabled: Boolean,
    onEnabled: (Boolean) -> Unit,
    onRename: () -> Unit,
) {
    val colors = LocalAAColors.current
    val shown = name ?: model.originalName
    val meta = listOfNotNull(
        model.id.takeIf { it != shown },
        model.contextWindow?.takeIf { it > 0 }?.let { stringResource(R.string.model_config_account_context, formatTokenWindow(it)) },
        model.maxOutputTokens?.takeIf { it > 0 }?.let { stringResource(R.string.model_config_account_output, formatTokenWindow(it)) },
        stringResource(R.string.model_config_account_image).takeIf { model.image },
    ).joinToString(" · ")
    val toggleDescription = stringResource(R.string.model_config_account_toggle_model, shown)
    val renameDescription = stringResource(R.string.model_config_account_rename)
    Row(
        Modifier.fillMaxWidth().padding(start = 36.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    shown,
                    color = if (enabled) colors.ink else colors.muted,
                    fontSize = 13.5.sp,
                    lineHeight = 18.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Box(
                    Modifier
                        .size(32.dp)
                        .clip(CircleShape)
                        .clickable(onClick = onRename)
                        .semantics { contentDescription = renameDescription },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Lucide.Pencil, contentDescription = null, tint = colors.muted, modifier = Modifier.size(13.dp))
                }
            }
            if (meta.isNotEmpty()) {
                Text(meta, color = colors.muted, fontSize = 11.5.sp, lineHeight = 15.sp)
            }
            // The ID is already in the line above when the original name is the ID.
            if (name != null && model.originalName != model.id) {
                Text(
                    stringResource(R.string.model_config_account_original_name, model.originalName),
                    color = colors.muted,
                    fontSize = 11.5.sp,
                    lineHeight = 15.sp,
                )
            }
        }
        Switch(
            checked = enabled,
            onCheckedChange = onEnabled,
            modifier = Modifier.semantics { contentDescription = toggleDescription },
        )
    }
}

@Composable
private fun RenameModelDialog(
    model: TokensModel,
    current: String?,
    onDismiss: () -> Unit,
    onRename: (String?) -> Unit,
) {
    var value by remember(model.id) { mutableStateOf(current ?: model.originalName) }
    ProfileDialog(title = stringResource(R.string.model_config_account_rename), onDismiss = onDismiss) {
        MutedText(model.id)
        FormField(
            value = value,
            placeholder = stringResource(R.string.model_config_account_rename_placeholder),
            onValueChange = { value = it.take(128) },
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProfileDialogButton(
                label = stringResource(R.string.common_cancel),
                modifier = Modifier.weight(1f),
                onClick = onDismiss,
            )
            ProfileDialogButton(
                label = stringResource(R.string.common_save),
                primary = true,
                modifier = Modifier.weight(1f),
                onClick = { onRename(renamedTo(model, value)) },
            )
        }
    }
}

@Composable
private fun UsageTab(controller: ModelConfigController, detailsUrl: String?, onOpen: (String?) -> Unit) {
    val colors = LocalAAColors.current
    var days by remember { mutableIntStateOf(7) }
    var model by remember { mutableStateOf<String?>(null) }
    var usage by remember { mutableStateOf<RemoteTokensUsage?>(null) }
    var failed by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    var choosingModel by remember { mutableStateOf(false) }

    LaunchedEffect(days, attempt) {
        failed = false
        usage = null
        controller.tokensUsage(days)
            .onSuccess { usage = it }
            .onFailure { failed = true }
    }
    val summary = remember(usage, model) { usage?.let { summarizeUsage(it, model) } }
    val modelIds = remember(usage) { usage?.let(::usageModelIds).orEmpty() }
    val allModels = stringResource(R.string.model_config_account_all_models)

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Segmented(
                options = listOf(
                    7 to stringResource(R.string.model_config_account_days7),
                    30 to stringResource(R.string.model_config_account_days30),
                ),
                selected = days,
                onSelect = { days = it },
            )
            Spacer(Modifier.weight(1f))
            Box {
                SmallButton(
                    label = model ?: allModels,
                    icon = Lucide.ChevronDown,
                    onClick = { choosingModel = true },
                )
                AADropdownMenu(expanded = choosingModel, onDismissRequest = { choosingModel = false }) {
                    AADropdownMenuItem(text = allModels, selected = model == null, onClick = {
                        model = null
                        choosingModel = false
                    })
                    (modelIds + listOfNotNull(model?.takeIf { it !in modelIds })).forEach { id ->
                        AADropdownMenuItem(text = id, selected = model == id, onClick = {
                            model = id
                            choosingModel = false
                        })
                    }
                }
            }
        }
        when {
            failed -> ProfileCard {
                Row(
                    Modifier.fillMaxWidth().padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        stringResource(R.string.model_config_account_usage_failed),
                        color = colors.muted,
                        fontSize = 13.sp,
                        modifier = Modifier.weight(1f),
                    )
                    SmallButton(label = stringResource(R.string.common_retry), icon = Lucide.RefreshCw, onClick = { attempt += 1 })
                }
            }
            summary == null -> Box(Modifier.fillMaxWidth().padding(vertical = 32.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = colors.muted, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
            }
            else -> {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatTile(stringResource(R.string.model_config_account_cost), formatYuan(summary.cost), Modifier.weight(1f))
                    StatTile(stringResource(R.string.model_config_account_requests), formatCount(summary.requests), Modifier.weight(1f))
                    StatTile(stringResource(R.string.model_config_account_tokens), formatCompactCount(summary.tokens), Modifier.weight(1f))
                }
                ProfileCard {
                    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        MutedText(stringResource(R.string.model_config_account_daily_cost))
                        if (summary.cost == 0L) {
                            Box(Modifier.fillMaxWidth().height(120.dp), contentAlignment = Alignment.Center) {
                                MutedText(stringResource(R.string.model_config_account_no_usage))
                            }
                        } else {
                            DailyCostChart(summary.daily)
                        }
                    }
                }
                if (summary.models.isNotEmpty()) ModelUsageTable(summary.models)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (detailsUrl != null) {
                LinkText(stringResource(R.string.model_config_account_usage_details)) { onOpen(detailsUrl) }
            }
        }
    }
}

@Composable
private fun StatTile(label: String, value: String, modifier: Modifier = Modifier) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(12.dp)
    Column(
        modifier
            .clip(shape)
            .border(0.8.dp, colors.border, shape)
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(label, color = colors.muted, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(value, color = colors.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A bar per day; tap a bar to read its date and cost. */
@Composable
private fun DailyCostChart(daily: List<DailyCost>) {
    if (daily.isEmpty()) return
    val colors = LocalAAColors.current
    var selected by remember(daily) { mutableStateOf<Int?>(null) }
    val max = daily.maxOf { it.cost }.coerceAtLeast(1)
    val title = stringResource(R.string.model_config_account_daily_cost)
    val barColor = colors.primaryAction
    val gridColor = colors.border
    val picked = selected?.let(daily::getOrNull)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 16.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(formatYuan(max), color = colors.muted, fontSize = 10.5.sp)
            if (picked != null) {
                Text(
                    "${shortDate(picked.date)}  ${formatYuan(picked.cost)}",
                    color = colors.ink,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(140.dp)
                .semantics { contentDescription = title }
                .pointerInput(daily) {
                    detectTapGestures { offset ->
                        val index = (offset.x / (size.width.toFloat() / daily.size)).toInt().coerceIn(0, daily.lastIndex)
                        selected = if (selected == index) null else index
                    }
                },
        ) {
            val height = size.height
            listOf(0f, 0.5f, 1f).forEach { fraction ->
                val y = height - height * fraction
                drawLine(gridColor, Offset(0f, y), Offset(size.width, y), strokeWidth = 1.dp.toPx())
            }
            val slot = size.width / daily.size
            val barWidth = minOf(slot * 0.7f, 28.dp.toPx())
            val radius = 3.dp.toPx()
            daily.forEachIndexed { index, day ->
                if (day.cost <= 0) return@forEachIndexed
                val barHeight = (height * day.cost.toFloat() / max.toFloat()).coerceAtLeast(1.dp.toPx())
                drawRoundRect(
                    color = if (selected == null || selected == index) barColor else barColor.copy(alpha = 0.35f),
                    topLeft = Offset(index * slot + (slot - barWidth) / 2, height - barHeight),
                    size = Size(barWidth, barHeight),
                    cornerRadius = CornerRadius(radius, radius),
                )
            }
        }
        Row(Modifier.fillMaxWidth()) {
            Text(shortDate(daily.first().date), color = colors.muted, fontSize = 10.5.sp, modifier = Modifier.weight(1f))
            if (daily.size > 2) {
                Text(
                    shortDate(daily[daily.size / 2].date),
                    color = colors.muted,
                    fontSize = 10.5.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f),
                )
            }
            Text(
                shortDate(daily.last().date),
                color = colors.muted,
                fontSize = 10.5.sp,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun ModelUsageTable(rows: List<ModelUsage>) {
    val colors = LocalAAColors.current
    val unknown = stringResource(R.string.model_config_account_unknown_model)
    ProfileCard {
        UsageTableRow(
            model = stringResource(R.string.model_config_account_model),
            requests = stringResource(R.string.model_config_account_requests),
            tokens = stringResource(R.string.model_config_account_tokens),
            cost = stringResource(R.string.model_config_account_cost),
            header = true,
        )
        rows.forEach { row ->
            Box(Modifier.fillMaxWidth().height(1.dp).background(colors.border))
            UsageTableRow(
                model = row.model.ifEmpty { unknown },
                requests = formatCount(row.requests),
                tokens = formatCompactCount(row.tokens),
                cost = formatYuan(row.cost),
                header = false,
            )
        }
    }
}

@Composable
private fun UsageTableRow(model: String, requests: String, tokens: String, cost: String, header: Boolean) {
    val colors = LocalAAColors.current
    val color = if (header) colors.muted else colors.ink
    val size = if (header) 11.5.sp else 12.5.sp
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = if (header) 8.dp else 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(model, color = color, fontSize = size, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(requests, color = color, fontSize = size, maxLines = 1, textAlign = TextAlign.End, modifier = Modifier.width(52.dp))
        Text(tokens, color = color, fontSize = size, maxLines = 1, textAlign = TextAlign.End, modifier = Modifier.width(52.dp))
        Text(cost, color = color, fontSize = size, maxLines = 1, textAlign = TextAlign.End, modifier = Modifier.width(76.dp))
    }
}

@Composable
private fun LinkText(label: String, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    Row(
        Modifier.clip(RoundedCornerShape(6.dp)).clickable(onClick = onClick).padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(label, color = colors.muted, fontSize = 12.sp, textDecoration = TextDecoration.Underline)
        Icon(Lucide.ExternalLink, contentDescription = null, tint = colors.muted, modifier = Modifier.size(12.dp))
    }
}

/** A row of mutually exclusive choices: tabs, or a period. */
@Composable
private fun <T> Segmented(
    options: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    fill: Boolean = false,
    role: Role = Role.RadioButton,
) {
    val colors = LocalAAColors.current
    Row(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(colors.secondaryActionSurface)
            .padding(3.dp)
            .selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        options.forEach { (value, label) ->
            val isSelected = value == selected
            Box(
                (if (fill) Modifier.weight(1f) else Modifier)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (isSelected) colors.raisedSurface else colors.secondaryActionSurface)
                    .selectable(selected = isSelected, role = role, onClick = { onSelect(value) })
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    color = if (isSelected) colors.ink else colors.muted,
                    fontSize = 13.sp,
                    fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
                    maxLines = 1,
                )
            }
        }
    }
}

/** Unsaved model changes, pinned to the bottom of the screen. */
@Composable
internal fun PendingModelsBarHost(slot: PendingModelsBarSlot, modifier: Modifier = Modifier) {
    val bar = slot.bar ?: return
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(14.dp)
    val latest by rememberUpdatedState(bar)
    Row(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(colors.raisedSurface)
            .border(1.dp, colors.border, shape)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            if (bar.blocked) {
                stringResource(R.string.model_config_account_need_one_model)
            } else {
                pluralStringResource(R.plurals.model_config_account_pending, bar.count, bar.count)
            },
            color = if (bar.blocked) colors.errorText else colors.ink,
            fontSize = 13.sp,
            lineHeight = 17.sp,
            modifier = Modifier.weight(1f),
        )
        SmallButton(
            label = stringResource(R.string.model_config_account_discard),
            enabled = !bar.saving,
            onClick = { latest.onDiscard() },
        )
        SmallButton(
            label = stringResource(R.string.model_config_account_save_apply),
            primary = true,
            loading = bar.saving,
            enabled = bar.canSave,
            onClick = { latest.onSave() },
        )
    }
}

/** Room at the end of the page so the pinned bar never covers the last row. */
@Composable
internal fun PendingBarSpacer(slot: PendingModelsBarSlot) {
    if (slot.bar != null) Spacer(Modifier.height(64.dp))
}
