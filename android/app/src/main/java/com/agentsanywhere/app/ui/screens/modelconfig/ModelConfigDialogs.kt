package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.RemoteModelOperation
import com.agentsanywhere.app.api.RemoteModelPreviewTarget
import com.agentsanywhere.app.feature.modelconfig.ApplySelection
import com.agentsanywhere.app.feature.modelconfig.MODEL_PROTOCOLS
import com.agentsanywhere.app.feature.modelconfig.ManualProfileDraft
import com.agentsanywhere.app.feature.modelconfig.ModelConfigController
import com.agentsanywhere.app.feature.modelconfig.newIdempotencyKey
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.profile.ProfileDialog
import com.agentsanywhere.app.ui.screens.profile.ProfileDialogButton
import kotlinx.coroutines.launch

/** Adds a manual profile. The key field is write-only: it is never filled from the Server. */
@Composable
internal fun ProfileFormDialog(
    onDismiss: () -> Unit,
    onSave: suspend (ManualProfileDraft) -> Unit,
) {
    val colors = LocalAAColors.current
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf(ManualProfileDraft()) }
    var saving by remember { mutableStateOf(false) }
    ProfileDialog(title = stringResource(R.string.model_config_add_profile), onDismiss = { if (!saving) onDismiss() }) {
        Column(
            modifier = Modifier.fillMaxWidth().heightIn(max = 460.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            MutedText(stringResource(R.string.model_config_add_profile_description))
            FieldLabel(stringResource(R.string.model_config_profile_name))
            FormField(value = draft.name, placeholder = "", onValueChange = { draft = draft.copy(name = it.take(64)) })
            FieldLabel(stringResource(R.string.model_config_api_key))
            FormField(value = draft.apiKey, placeholder = "", secret = true, onValueChange = { draft = draft.copy(apiKey = it) })
            MutedText(stringResource(R.string.model_config_api_key_write_only))
            MODEL_PROTOCOLS.forEach { protocol ->
                val offer = draft.offers[protocol] ?: return@forEach
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .border(1.dp, colors.border, RoundedCornerShape(12.dp))
                        .padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    CheckRow(
                        label = protocolLabel(protocol),
                        checked = offer.enabled,
                        onCheckedChange = { checked -> draft = draft.withOffer(protocol) { it.copy(enabled = checked) } },
                    )
                    if (offer.enabled) {
                        FormField(
                            value = offer.baseUrl,
                            placeholder = stringResource(R.string.model_config_base_url_placeholder),
                            keyboardType = KeyboardType.Uri,
                            onValueChange = { value -> draft = draft.withOffer(protocol) { it.copy(baseUrl = value) } },
                        )
                        FormField(
                            value = offer.models,
                            placeholder = stringResource(R.string.model_config_models_placeholder),
                            singleLine = false,
                            monospace = true,
                            onValueChange = { value -> draft = draft.withOffer(protocol) { it.copy(models = value) } },
                        )
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProfileDialogButton(
                label = stringResource(R.string.common_cancel),
                enabled = !saving,
                modifier = Modifier.weight(1f),
                onClick = onDismiss,
            )
            ProfileDialogButton(
                label = stringResource(if (saving) R.string.common_saving else R.string.common_save),
                primary = true,
                enabled = draft.valid && !saving,
                modifier = Modifier.weight(1f),
                onClick = {
                    saving = true
                    scope.launch {
                        try {
                            onSave(draft)
                        } finally {
                            saving = false
                        }
                    }
                },
            )
        }
    }
}

/**
 * Previews where a profile can go, then applies it to the chosen runtimes. One
 * idempotency key per dialog, so a retried tap does not apply twice.
 */
@Composable
internal fun ApplyProfileDialog(
    profile: ModelProfile,
    devices: List<AgentDevice>,
    controller: ModelConfigController,
    onDismiss: () -> Unit,
    onApplied: (RemoteModelOperation) -> Unit,
    onError: (Throwable) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val idempotencyKey = remember(profile.id) { newIdempotencyKey() }
    var selection by remember(profile.id) { mutableStateOf<ApplySelection?>(null) }
    var allowInterrupt by remember(profile.id) { mutableStateOf(false) }
    var confirmGlobal by remember(profile.id) { mutableStateOf(false) }
    var applying by remember(profile.id) { mutableStateOf(false) }
    val dismiss by rememberUpdatedState(onDismiss)
    val reportError by rememberUpdatedState(onError)

    LaunchedEffect(profile.id) {
        controller.preview(profile.id)
            .onSuccess { selection = ApplySelection.initial(it) }
            .onFailure {
                reportError(it)
                dismiss()
            }
    }

    ProfileDialog(title = stringResource(R.string.model_config_apply_title, profile.name), onDismiss = { if (!applying) onDismiss() }) {
        MutedText(stringResource(R.string.model_config_apply_description))
        val current = selection
        when {
            current == null -> Box(Modifier.fillMaxWidth().padding(vertical = 20.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = LocalAAColors.current.muted, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
            }
            current.targets.isEmpty() -> MutedText(stringResource(R.string.model_config_no_targets))
            else -> Column(
                modifier = Modifier.fillMaxWidth().heightIn(max = 340.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                current.targets.forEach { target ->
                    PreviewTargetRow(
                        target = target,
                        deviceName = devices.firstOrNull { it.id == target.connectorId }?.name ?: target.connectorId,
                        checked = target.key in current.selected,
                        enabled = current.selectable(target) && !applying,
                        onCheckedChange = { selection = current.toggle(target, it) },
                    )
                }
            }
        }
        if (current != null && current.runningSessions > 0) {
            SwitchRow(
                label = stringResource(R.string.model_config_allow_interrupt),
                description = pluralStringResource(
                    R.plurals.model_config_allow_interrupt_description,
                    current.runningSessions,
                    current.runningSessions,
                ),
                checked = allowInterrupt,
                onCheckedChange = { allowInterrupt = it },
            )
        }
        if (current?.needsNativeGlobalConfirmation == true) {
            CheckRow(
                label = stringResource(R.string.model_config_confirm_native_global),
                checked = confirmGlobal,
                onCheckedChange = { confirmGlobal = it },
            )
        }
        val chosenCount = current?.chosen?.size ?: 0
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProfileDialogButton(
                label = stringResource(R.string.common_cancel),
                enabled = !applying,
                modifier = Modifier.weight(1f),
                onClick = onDismiss,
            )
            ProfileDialogButton(
                label = pluralStringResource(R.plurals.model_config_apply_count, chosenCount, chosenCount),
                primary = true,
                enabled = !applying && current?.canSubmit(confirmGlobal) == true,
                modifier = Modifier.weight(1f),
                onClick = {
                    val chosen = current?.chosen ?: return@ProfileDialogButton
                    applying = true
                    scope.launch {
                        controller.apply(
                            profileId = profile.id,
                            targets = chosen,
                            allowInterrupt = allowInterrupt,
                            confirmNativeGlobal = confirmGlobal,
                            idempotencyKey = idempotencyKey,
                        ).onSuccess(onApplied).onFailure(onError)
                        applying = false
                    }
                },
            )
        }
    }
}

@Composable
private fun PreviewTargetRow(
    target: RemoteModelPreviewTarget,
    deviceName: String,
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    val colors = LocalAAColors.current
    val details = if (target.canApply) {
        listOfNotNull(
            target.offerFormat?.let { protocolLabel(it) },
            effectLabelRes(target.effect)?.let { stringResource(it) },
            stringResource(R.string.model_config_scope_native_global).takeIf { target.scope == "native_global" },
            target.replacesHost?.let { stringResource(R.string.model_config_replaces, it) },
            target.runningSessions.takeIf { it > 0 && target.effect == "restart" }
                ?.let { pluralStringResource(R.plurals.model_config_running_sessions, it, it) },
            stringResource(R.string.model_config_too_many_models, target.modelLimit ?: 64).takeIf { target.tooManyModels },
        ).joinToString(" · ")
    } else {
        stringResource(skipReasonRes(target.reason))
    }
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Checkbox(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
        Column(Modifier.weight(1f).padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    target.name ?: target.runtimeId,
                    color = colors.ink,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Text(deviceName, color = colors.muted, fontSize = 12.sp, maxLines = 1, modifier = Modifier.weight(1f, fill = false))
                RuntimeMaturityBadge(target.capabilityMaturity ?: target.maturity)
            }
            if (details.isNotBlank()) MutedText(details)
        }
    }
}

@Composable
internal fun UnlinkTokensDialog(
    usedBy: Int,
    onDismiss: () -> Unit,
    onConfirm: suspend (allowInterrupt: Boolean) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var allowInterrupt by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    ProfileDialog(title = stringResource(R.string.model_config_unlink_title), onDismiss = { if (!busy) onDismiss() }) {
        MutedText(pluralStringResource(R.plurals.model_config_unlink_description, usedBy, usedBy))
        if (usedBy > 0) {
            SwitchRow(
                label = stringResource(R.string.model_config_allow_interrupt),
                description = null,
                checked = allowInterrupt,
                onCheckedChange = { allowInterrupt = it },
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProfileDialogButton(
                label = stringResource(R.string.common_cancel),
                enabled = !busy,
                modifier = Modifier.weight(1f),
                onClick = onDismiss,
            )
            ProfileDialogButton(
                label = stringResource(R.string.model_config_unlink),
                primary = true,
                enabled = !busy,
                modifier = Modifier.weight(1f),
                onClick = {
                    busy = true
                    scope.launch {
                        try {
                            onConfirm(allowInterrupt)
                        } finally {
                            busy = false
                        }
                    }
                },
            )
        }
    }
}

@Composable
internal fun RotateKeyConfirmDialog(
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    ProfileDialog(title = stringResource(R.string.model_config_rotate), onDismiss = onDismiss) {
        MutedText(stringResource(R.string.model_config_rotate_description))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProfileDialogButton(
                label = stringResource(R.string.common_cancel),
                modifier = Modifier.weight(1f),
                onClick = onDismiss,
            )
            ProfileDialogButton(
                label = stringResource(R.string.model_config_rotate),
                primary = true,
                modifier = Modifier.weight(1f),
                onClick = onConfirm,
            )
        }
    }
}

/** Asked only after the Server answered `busy`: continuing interrupts running tasks. */
@Composable
internal fun InterruptConfirmDialog(
    onDismiss: () -> Unit,
    onConfirm: suspend () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    ProfileDialog(title = stringResource(R.string.model_config_interrupt_title), onDismiss = { if (!busy) onDismiss() }) {
        MutedText(stringResource(R.string.model_config_interrupt_description))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProfileDialogButton(
                label = stringResource(R.string.common_cancel),
                enabled = !busy,
                modifier = Modifier.weight(1f),
                onClick = onDismiss,
            )
            ProfileDialogButton(
                label = stringResource(R.string.model_config_interrupt_continue),
                primary = true,
                enabled = !busy,
                modifier = Modifier.weight(1f),
                onClick = {
                    busy = true
                    scope.launch {
                        try {
                            onConfirm()
                        } finally {
                            busy = false
                        }
                    }
                },
            )
        }
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(text, color = LocalAAColors.current.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun CheckRow(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = onCheckedChange)
        Text(label, color = LocalAAColors.current.ink, fontSize = 13.5.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun SwitchRow(label: String, description: String?, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, color = LocalAAColors.current.ink, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
            description?.let { MutedText(it) }
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
internal fun FormField(
    value: String,
    placeholder: String,
    secret: Boolean = false,
    singleLine: Boolean = true,
    monospace: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    onValueChange: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val family = if (monospace) FontFamily.Monospace else FontFamily.Default
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = singleLine,
        minLines = if (singleLine) 1 else 3,
        textStyle = TextStyle(color = colors.ink, fontSize = 14.sp, fontFamily = family),
        cursorBrush = SolidColor(colors.ink),
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            keyboardType = if (secret) KeyboardType.Password else keyboardType,
            autoCorrectEnabled = false,
        ),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(colors.subtle)
            .border(1.dp, colors.border, RoundedCornerShape(12.dp))
            .padding(horizontal = 12.dp, vertical = 12.dp),
        decorationBox = { inner ->
            Box(contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty() && placeholder.isNotEmpty()) {
                    Text(placeholder, color = colors.faint, fontSize = 13.sp, fontFamily = family)
                }
                inner()
            }
        },
    )
}
