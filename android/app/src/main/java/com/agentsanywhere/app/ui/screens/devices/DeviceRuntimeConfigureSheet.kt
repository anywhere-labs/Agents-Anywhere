package com.agentsanywhere.app.ui.screens.devices

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.RuntimeConfigField
import com.agentsanywhere.app.feature.devices.RuntimeConfigFieldKind
import com.agentsanywhere.app.feature.devices.RuntimeConfigForm
import com.agentsanywhere.app.feature.devices.RuntimeConfigInput
import com.agentsanywhere.app.feature.devices.RuntimeConfigIssue
import com.agentsanywhere.app.feature.devices.RuntimeConfigOption
import com.agentsanywhere.app.feature.devices.RuntimeConfigResult
import com.agentsanywhere.app.feature.devices.RuntimeCustomModelRow
import com.agentsanywhere.app.feature.devices.RuntimeEffortRow
import com.agentsanywhere.app.feature.devices.RuntimeEnvironmentRow
import com.agentsanywhere.app.feature.devices.RuntimeGatewayDraft
import com.agentsanywhere.app.ui.designsystem.AABottomSheetDefaults
import com.agentsanywhere.app.ui.designsystem.AADropdownMenu
import com.agentsanywhere.app.ui.designsystem.AADropdownMenuItem
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.Eye
import com.composables.icons.lucide.EyeOff
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.RotateCcw
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.WifiOff
import com.composables.icons.lucide.X
import kotlinx.coroutines.launch

/**
 * Edits a runtime configuration from its schema. Swipe and outside taps never discard
 * edits; closing with changes asks first. [onSubmit] returns an error to show, or null
 * once the owner has accepted the configuration.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DeviceRuntimeConfigureSheet(
    title: String,
    form: RuntimeConfigForm,
    config: Map<String, Any?>?,
    submitLabel: String,
    online: Boolean,
    onDismiss: () -> Unit,
    onSubmit: suspend (name: String?, config: Map<String, Any?>) -> String?,
    instanceName: String? = null,
    validateName: (String) -> String? = { null },
) {
    val colors = LocalAAColors.current
    val sheetColors = AABottomSheetDefaults.colors()
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    var draft by remember(form) { mutableStateOf(form.draft(config)) }
    var name by remember(form) { mutableStateOf(instanceName.orEmpty()) }
    var nameIssue by remember(form) { mutableStateOf<String?>(null) }
    var saving by remember(form) { mutableStateOf(false) }
    var error by remember(form) { mutableStateOf<String?>(null) }
    var confirmDiscard by remember(form) { mutableStateOf(false) }
    val reviewMessage = stringResource(R.string.runtime_config_review)
    val nameRequired = stringResource(R.string.device_agents_name_required)
    val changed = draft.hasChanges || (instanceName != null && name != instanceName)
    val dismissible by rememberUpdatedState(!saving && !changed)
    val sheetState = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        confirmValueChange = { it != SheetValue.Hidden || dismissible },
    )

    fun requestDismiss() {
        if (saving) return
        if (changed) confirmDiscard = true else onDismiss()
    }

    fun submit() {
        if (saving || !online) return
        focus.clearFocus()
        val trimmed = name.trim()
        val nameProblem = when {
            instanceName == null -> null
            trimmed.isEmpty() -> nameRequired
            else -> validateName(trimmed)
        }
        nameIssue = nameProblem
        when (val result = draft.result()) {
            is RuntimeConfigResult.Invalid -> {
                draft = draft.withIssues(result.issues)
                error = reviewMessage
            }
            is RuntimeConfigResult.Valid -> {
                error = null
                if (nameProblem != null) return
                saving = true
                scope.launch {
                    error = onSubmit(trimmed.takeIf { instanceName != null }, result.config)
                    saving = false
                }
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = { if (dismissible) onDismiss() },
        sheetState = sheetState,
        sheetMaxWidth = 640.dp,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = sheetColors.container,
        contentColor = sheetColors.content,
        tonalElevation = 0.dp,
        scrimColor = sheetColors.scrim,
        dragHandle = null,
        // Material hides the sheet on Back before asking; edits must be confirmed first.
        properties = ModalBottomSheetProperties(shouldDismissOnBackPress = false),
    ) {
        BackHandler {
            when {
                saving -> Unit
                changed -> confirmDiscard = true
                else -> scope.launch { sheetState.hide() }.invokeOnCompletion {
                    if (!sheetState.isVisible) onDismiss()
                }
            }
        }
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = LocalConfiguration.current.screenHeightDp.dp * 0.92f),
        ) {
            Box(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 8.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.size(width = 36.dp, height = 4.dp).clip(CircleShape).background(sheetColors.handle))
            }
            Row(
                Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(start = 24.dp, end = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = title,
                    modifier = Modifier.weight(1f).padding(vertical = 8.dp).semantics { heading() },
                    color = sheetColors.content,
                    fontSize = 18.sp,
                    lineHeight = 24.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                IconButton(onClick = ::requestDismiss, enabled = !saving) {
                    Icon(
                        Lucide.X,
                        stringResource(R.string.common_close),
                        tint = sheetColors.secondaryContent.copy(alpha = if (saving) 0.38f else 1f),
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            Column(
                modifier = Modifier
                    .weight(1f, fill = false)
                    .verticalScroll(rememberScrollState())
                    .padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(22.dp),
            ) {
                if (instanceName != null) {
                    ConfigFieldFrame(
                        title = stringResource(R.string.runtime_config_instance_name),
                        description = null,
                        required = true,
                        issue = nameIssue,
                    ) {
                        RuntimeTextInput(
                            value = name,
                            placeholder = stringResource(R.string.runtime_config_instance_name_placeholder),
                            enabled = !saving,
                            onValueChange = {
                                name = it
                                nameIssue = null
                            },
                        )
                    }
                }
                form.fields.forEach { field ->
                    key(field.id) {
                        RuntimeConfigFieldEditor(
                            field = field,
                            input = draft.inputs[field.id],
                            issue = draft.issues[field.id],
                            enabled = !saving,
                            onChange = { draft = draft.update(field.id, it) },
                        )
                    }
                }
                if (form.fields.isNotEmpty()) {
                    Row(
                        modifier = Modifier
                            .clip(CircleShape)
                            .noRippleClickable(enabled = !saving) { draft = draft.resetToDefaults() }
                            .padding(vertical = 6.dp, horizontal = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Icon(Lucide.RotateCcw, contentDescription = null, tint = colors.muted, modifier = Modifier.size(15.dp))
                        Text(
                            text = stringResource(R.string.runtime_config_reset),
                            color = colors.muted,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
                if (!online) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(Lucide.WifiOff, contentDescription = null, tint = colors.muted, modifier = Modifier.size(15.dp))
                        Text(
                            text = stringResource(R.string.runtime_config_offline),
                            color = colors.muted,
                            fontSize = 12.5.sp,
                            lineHeight = 17.sp,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                error?.let { ConfigErrorText(it) }
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                SheetTextButton(
                    label = stringResource(R.string.common_cancel),
                    enabled = !saving,
                    primary = false,
                    modifier = Modifier.weight(1f),
                    onClick = ::requestDismiss,
                )
                SheetTextButton(
                    label = if (saving) stringResource(R.string.common_saving) else submitLabel,
                    enabled = !saving && online,
                    primary = true,
                    modifier = Modifier.weight(1f),
                    onClick = ::submit,
                )
            }
        }
    }

    if (confirmDiscard) {
        DeviceConfirmDialog(
            title = stringResource(R.string.runtime_config_discard_title),
            body = stringResource(R.string.runtime_config_discard_body),
            confirmLabel = stringResource(R.string.runtime_config_discard),
            dismissLabel = stringResource(R.string.runtime_config_keep_editing),
            danger = true,
            onDismiss = { confirmDiscard = false },
            onConfirm = {
                confirmDiscard = false
                onDismiss()
            },
        )
    }
}

@Composable
private fun RuntimeConfigFieldEditor(
    field: RuntimeConfigField,
    input: RuntimeConfigInput?,
    issue: RuntimeConfigIssue?,
    enabled: Boolean,
    onChange: (RuntimeConfigInput) -> Unit,
) {
    val title = runtimeConfigTitle(field)
    val description = runtimeConfigDescription(field)
    val issueText = issue?.let { stringResource(runtimeConfigIssueRes(it)) }
    when (val kind = field.kind) {
        RuntimeConfigFieldKind.Toggle -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    ConfigLabel(title, field.required)
                    description?.let { ConfigDescription(it) }
                }
                AgentSwitch(
                    checked = (input as? RuntimeConfigInput.Toggle)?.value == true,
                    enabled = enabled,
                    onCheckedChange = { onChange(RuntimeConfigInput.Toggle(it)) },
                )
            }
            issueText?.let { ConfigErrorText(it) }
        }
        is RuntimeConfigFieldKind.Text -> ConfigFieldFrame(title, description, field.required, issueText) {
            RuntimeTextInput(
                value = (input as? RuntimeConfigInput.Text)?.value.orEmpty(),
                placeholder = field.defaultValue as? String ?: "",
                enabled = enabled,
                monospace = kind.path,
                secure = kind.secure,
                onValueChange = { onChange(RuntimeConfigInput.Text(it)) },
            )
        }
        is RuntimeConfigFieldKind.Number -> ConfigFieldFrame(title, description, field.required, issueText) {
            RuntimeTextInput(
                value = (input as? RuntimeConfigInput.Text)?.value.orEmpty(),
                placeholder = (field.defaultValue as? Number)?.toString().orEmpty(),
                enabled = enabled,
                keyboardType = if (kind.integer) KeyboardType.Number else KeyboardType.Decimal,
                onValueChange = { onChange(RuntimeConfigInput.Text(it)) },
            )
        }
        is RuntimeConfigFieldKind.Choice -> {
            val value = (input as? RuntimeConfigInput.Choice)?.value
            val current = kind.options.firstOrNull { sameJsonValue(it.value, value) }
            ConfigFieldFrame(
                title = title,
                description = listOfNotNull(description, current?.disabledReason ?: current?.description).joinToString("\n").ifEmpty { null },
                required = field.required,
                issue = issueText,
            ) {
                ChoiceInput(
                    options = kind.options,
                    value = value,
                    current = current,
                    enabled = enabled,
                    onSelect = { onChange(RuntimeConfigInput.Choice(it)) },
                )
            }
        }
        RuntimeConfigFieldKind.KeyValue -> ConfigFieldFrame(title, description, field.required, issueText) {
            EnvironmentEditor(
                rows = (input as? RuntimeConfigInput.Environment)?.rows.orEmpty(),
                enabled = enabled,
                onChange = { onChange(RuntimeConfigInput.Environment(it)) },
            )
        }
        is RuntimeConfigFieldKind.ModelGateway -> ConfigFieldFrame(title, description, field.required, issueText) {
            ModelGatewayEditor(
                kind = kind,
                value = (input as? RuntimeConfigInput.Gateway)?.value ?: RuntimeGatewayDraft(),
                required = field.required,
                enabled = enabled,
                onChange = { onChange(RuntimeConfigInput.Gateway(it)) },
            )
        }
        RuntimeConfigFieldKind.CustomModels -> ConfigFieldFrame(title, description, field.required, issueText) {
            CustomModelsEditor(
                rows = (input as? RuntimeConfigInput.Models)?.rows.orEmpty(),
                enabled = enabled,
                onChange = { onChange(RuntimeConfigInput.Models(it)) },
            )
        }
        RuntimeConfigFieldKind.Json -> ConfigFieldFrame(title, description, field.required, issueText) {
            RuntimeTextInput(
                value = (input as? RuntimeConfigInput.Text)?.value.orEmpty(),
                placeholder = if (field.schema["type"] == "array") "[]" else "{}",
                enabled = enabled,
                monospace = true,
                singleLine = false,
                onValueChange = { onChange(RuntimeConfigInput.Text(it)) },
            )
        }
    }
}

@Composable
private fun ConfigFieldFrame(
    title: String,
    description: String?,
    required: Boolean,
    issue: String?,
    content: @Composable () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ConfigLabel(title, required)
        content()
        description?.let { ConfigDescription(it) }
        issue?.let { ConfigErrorText(it) }
    }
}

@Composable
private fun ConfigLabel(title: String, required: Boolean) {
    Text(
        text = if (required) "$title *" else title,
        color = LocalAAColors.current.ink,
        fontSize = 14.sp,
        lineHeight = 19.sp,
        fontWeight = FontWeight.Bold,
    )
}

@Composable
private fun ConfigDescription(text: String) {
    Text(text = text, color = LocalAAColors.current.muted, fontSize = 12.sp, lineHeight = 16.5.sp)
}

@Composable
private fun ConfigErrorText(text: String) {
    Text(
        text = text,
        color = LocalAAColors.current.errorText,
        fontSize = 12.5.sp,
        fontWeight = FontWeight.SemiBold,
        lineHeight = 17.sp,
    )
}

@Composable
private fun ChoiceInput(
    options: List<RuntimeConfigOption>,
    value: Any?,
    current: RuntimeConfigOption?,
    enabled: Boolean,
    onSelect: (Any?) -> Unit,
) {
    val colors = LocalAAColors.current
    var expanded by remember { mutableStateOf(false) }
    val unavailable = stringResource(R.string.runtime_config_unavailable)
    val label = when {
        current != null -> current.label
        value != null -> stringResource(R.string.runtime_config_option_unavailable, value.toString())
        options.isEmpty() -> unavailable
        else -> stringResource(R.string.runtime_config_choose_option)
    }
    val open = enabled && options.isNotEmpty()
    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(46.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(colors.raisedSurface)
                .border(1.dp, colors.border, RoundedCornerShape(12.dp))
                .noRippleClickable(enabled = open) { expanded = true }
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = label,
                modifier = Modifier.weight(1f),
                color = if (current != null) colors.ink else colors.muted,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Icon(Lucide.ChevronDown, contentDescription = null, tint = colors.muted.copy(alpha = if (open) 1f else 0.45f), modifier = Modifier.size(16.dp))
        }
        AADropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { option ->
                AADropdownMenuItem(
                    text = if (option.disabled) stringResource(R.string.runtime_config_option_unavailable, option.label) else option.label,
                    selected = option == current,
                    enabled = !option.disabled,
                    supportingText = option.disabledReason ?: option.description,
                    onClick = {
                        expanded = false
                        onSelect(option.value)
                    },
                )
            }
        }
    }
}

@Composable
private fun EnvironmentEditor(
    rows: List<RuntimeEnvironmentRow>,
    enabled: Boolean,
    onChange: (List<RuntimeEnvironmentRow>) -> Unit,
) {
    val colors = LocalAAColors.current
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (rows.isEmpty()) ConfigDescription(stringResource(R.string.runtime_config_no_variables))
        rows.forEach { row ->
            key(row.id) {
                fun update(next: RuntimeEnvironmentRow) = onChange(rows.map { if (it.id == row.id) next else it })
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(colors.subtle)
                        .padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RuntimeTextInput(
                            value = row.key,
                            placeholder = stringResource(R.string.runtime_config_variable_name),
                            enabled = enabled,
                            monospace = true,
                            modifier = Modifier.weight(1f),
                            onValueChange = { update(row.copy(key = it)) },
                        )
                        RemoveRowButton(
                            description = stringResource(R.string.runtime_config_remove_variable),
                            enabled = enabled,
                            onClick = { onChange(rows.filterNot { it.id == row.id }) },
                        )
                    }
                    RuntimeTextInput(
                        value = row.value,
                        placeholder = stringResource(
                            if (row.removesInherited) R.string.runtime_config_remove_inherited else R.string.runtime_config_variable_value,
                        ),
                        enabled = enabled && !row.removesInherited,
                        monospace = true,
                        onValueChange = { update(row.copy(value = it)) },
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = stringResource(R.string.runtime_config_remove_inherited),
                            modifier = Modifier.weight(1f),
                            color = colors.muted,
                            fontSize = 12.5.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        AgentSwitch(
                            checked = row.removesInherited,
                            enabled = enabled,
                            onCheckedChange = { update(row.copy(removesInherited = it)) },
                        )
                    }
                }
            }
        }
        AddRowButton(stringResource(R.string.runtime_config_add_variable), enabled) { onChange(rows + RuntimeEnvironmentRow()) }
    }
}

@Composable
private fun ModelGatewayEditor(
    kind: RuntimeConfigFieldKind.ModelGateway,
    value: RuntimeGatewayDraft,
    required: Boolean,
    enabled: Boolean,
    onChange: (RuntimeGatewayDraft) -> Unit,
) {
    val colors = LocalAAColors.current
    val (urlTitle, urlDescription) = runtimeConfigText(kind.baseUrl, R.string.runtime_config_gateway_url)
    val (keyTitle, keyDescription) = runtimeConfigText(kind.apiKey, R.string.runtime_config_gateway_key)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .border(1.dp, colors.border, RoundedCornerShape(14.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SubLabel(if (required) "$urlTitle *" else urlTitle)
        RuntimeTextInput(
            value = value.baseUrl,
            placeholder = "https://",
            enabled = enabled,
            monospace = true,
            keyboardType = KeyboardType.Uri,
            onValueChange = { onChange(value.copy(baseUrl = it)) },
        )
        urlDescription?.let { ConfigDescription(it) }
        SubLabel(if (required) "$keyTitle *" else keyTitle, Modifier.padding(top = 6.dp))
        RuntimeTextInput(
            value = value.apiKey,
            placeholder = "",
            enabled = enabled,
            monospace = true,
            secure = true,
            onValueChange = { onChange(value.copy(apiKey = it)) },
        )
        keyDescription?.let { ConfigDescription(it) }
    }
}

@Composable
private fun CustomModelsEditor(
    rows: List<RuntimeCustomModelRow>,
    enabled: Boolean,
    onChange: (List<RuntimeCustomModelRow>) -> Unit,
) {
    val colors = LocalAAColors.current
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (rows.isEmpty()) ConfigDescription(stringResource(R.string.runtime_config_no_models))
        rows.forEach { row ->
            key(row.id) {
                fun update(next: RuntimeCustomModelRow) = onChange(rows.map { if (it.id == row.id) next else it })
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(colors.subtle)
                        .padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RuntimeTextInput(
                            value = row.modelId,
                            placeholder = stringResource(R.string.runtime_config_model_id),
                            enabled = enabled,
                            monospace = true,
                            modifier = Modifier.weight(1f),
                            onValueChange = { update(row.copy(modelId = it)) },
                        )
                        RemoveRowButton(
                            description = stringResource(R.string.runtime_config_remove_model),
                            enabled = enabled,
                            onClick = { onChange(rows.filterNot { it.id == row.id }) },
                        )
                    }
                    RuntimeTextInput(
                        value = row.displayName,
                        placeholder = stringResource(R.string.runtime_config_model_name),
                        enabled = enabled,
                        onValueChange = { update(row.copy(displayName = it)) },
                    )
                    SubLabel(stringResource(R.string.runtime_config_efforts), Modifier.padding(top = 4.dp))
                    if (row.efforts.isEmpty()) ConfigDescription(stringResource(R.string.runtime_config_no_efforts))
                    row.efforts.forEach { effort ->
                        key(effort.id) {
                            fun updateEffort(next: RuntimeEffortRow) =
                                update(row.copy(efforts = row.efforts.map { if (it.id == effort.id) next else it }))
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                RuntimeTextInput(
                                    value = effort.effortId,
                                    placeholder = stringResource(R.string.runtime_config_effort_id),
                                    enabled = enabled,
                                    monospace = true,
                                    modifier = Modifier.weight(1f),
                                    onValueChange = { updateEffort(effort.copy(effortId = it)) },
                                )
                                RuntimeTextInput(
                                    value = effort.displayName,
                                    placeholder = stringResource(R.string.runtime_config_effort_name),
                                    enabled = enabled,
                                    modifier = Modifier.weight(1f),
                                    onValueChange = { updateEffort(effort.copy(displayName = it)) },
                                )
                                RemoveRowButton(
                                    description = stringResource(R.string.runtime_config_remove_effort),
                                    enabled = enabled,
                                    onClick = { update(row.copy(efforts = row.efforts.filterNot { it.id == effort.id })) },
                                )
                            }
                        }
                    }
                    AddRowButton(stringResource(R.string.runtime_config_add_effort), enabled) {
                        update(row.copy(efforts = row.efforts + RuntimeEffortRow()))
                    }
                }
            }
        }
        AddRowButton(stringResource(R.string.runtime_config_add_model), enabled) { onChange(rows + RuntimeCustomModelRow()) }
    }
}

@Composable
private fun SubLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier,
        color = LocalAAColors.current.inkSoft,
        fontSize = 12.5.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

@Composable
private fun AddRowButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .height(36.dp)
            .clip(CircleShape)
            .border(1.dp, colors.border, CircleShape)
            .noRippleClickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(Lucide.Plus, contentDescription = null, tint = colors.ink.copy(alpha = if (enabled) 1f else 0.45f), modifier = Modifier.size(15.dp))
        Text(
            text = label,
            color = colors.ink.copy(alpha = if (enabled) 1f else 0.45f),
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun RemoveRowButton(description: String, enabled: Boolean, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(CircleShape)
            .background(colors.errorText.copy(alpha = 0.1f))
            .semantics { contentDescription = description }
            .noRippleClickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Lucide.Trash2,
            contentDescription = null,
            tint = colors.errorText.copy(alpha = if (enabled) 1f else 0.4f),
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
internal fun RuntimeTextInput(
    value: String,
    placeholder: String,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    monospace: Boolean = false,
    secure: Boolean = false,
    singleLine: Boolean = true,
    keyboardType: KeyboardType = KeyboardType.Text,
    onValueChange: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    var revealed by remember { mutableStateOf(false) }
    val family = if (monospace) FontFamily.Monospace else FontFamily.Default
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        singleLine = singleLine,
        minLines = if (singleLine) 1 else 4,
        textStyle = TextStyle(
            color = colors.ink.copy(alpha = if (enabled) 1f else 0.45f),
            fontSize = 13.5.sp,
            lineHeight = 19.sp,
            fontWeight = FontWeight.Medium,
            fontFamily = family,
        ),
        cursorBrush = SolidColor(colors.ink),
        visualTransformation = if (secure && !revealed) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            autoCorrectEnabled = false,
            keyboardType = if (secure) KeyboardType.Password else keyboardType,
            imeAction = if (singleLine) ImeAction.Done else ImeAction.Default,
        ),
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(colors.raisedSurface)
            .border(1.dp, colors.border, RoundedCornerShape(12.dp)),
        decorationBox = { inner ->
            Row(
                modifier = Modifier.padding(start = 12.dp, end = if (secure) 4.dp else 12.dp, top = 11.dp, bottom = 11.dp),
                verticalAlignment = if (singleLine) Alignment.CenterVertically else Alignment.Top,
            ) {
                Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty() && placeholder.isNotEmpty()) {
                        Text(text = placeholder, color = colors.faint, fontSize = 13.sp, fontFamily = family, maxLines = 1)
                    }
                    inner()
                }
                if (secure) {
                    Box(
                        modifier = Modifier
                            .padding(start = 4.dp)
                            .size(width = 36.dp, height = 22.dp)
                            .noRippleClickable { revealed = !revealed },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = if (revealed) Lucide.EyeOff else Lucide.Eye,
                            contentDescription = stringResource(
                                if (revealed) R.string.runtime_config_hide_key else R.string.runtime_config_show_key,
                            ),
                            tint = colors.muted,
                            modifier = Modifier.size(17.dp),
                        )
                    }
                }
            }
        },
    )
}

private fun sameJsonValue(left: Any?, right: Any?): Boolean =
    if (left is Number && right is Number) left.toDouble() == right.toDouble() else left == right
