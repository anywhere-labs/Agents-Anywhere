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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.modelconfig.GATEWAY_ERROR_CODES
import com.agentsanywhere.app.feature.modelconfig.GATEWAY_MANUAL_FALLBACK_CODES
import com.agentsanywhere.app.feature.modelconfig.MODEL_PROTOCOLS
import com.agentsanywhere.app.feature.modelconfig.ManualProfileDraft
import com.agentsanywhere.app.feature.modelconfig.modelConfigErrorCode
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.profile.ProfileDialog
import com.agentsanywhere.app.ui.screens.profile.ProfileDialogButton
import kotlinx.coroutines.launch

/**
 * Adds a manual profile. The key field is write-only: it is never filled from the Server.
 *
 * Saving first asks the Server to detect the protocols and models at the address. When it
 * cannot, the form switches to entering them per protocol. [onSave] errors without a detection
 * code go to [onError]; detection errors show in the form.
 */
@Composable
internal fun ProfileFormDialog(
    onDismiss: () -> Unit,
    onSave: suspend (ManualProfileDraft) -> Result<*>,
    onError: (Throwable) -> Unit,
) {
    val colors = LocalAAColors.current
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf(ManualProfileDraft()) }
    var saving by remember { mutableStateOf(false) }
    var errorCode by remember { mutableStateOf<String?>(null) }
    val editable = !saving
    ProfileDialog(title = stringResource(R.string.model_config_add_profile), onDismiss = { if (!saving) onDismiss() }) {
        Column(
            modifier = Modifier.fillMaxWidth().heightIn(max = 460.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            MutedText(stringResource(R.string.model_config_add_profile_description))
            FieldLabel(stringResource(R.string.model_config_profile_name))
            FormField(value = draft.name, placeholder = "", enabled = editable, onValueChange = { draft = draft.copy(name = it.take(64)) })
            if (!draft.manual) {
                FieldLabel(stringResource(R.string.model_config_address))
                FormField(
                    value = draft.baseUrl,
                    placeholder = stringResource(R.string.model_config_detect_address_placeholder),
                    keyboardType = KeyboardType.Uri,
                    enabled = editable,
                    onValueChange = { draft = draft.copy(baseUrl = it) },
                )
            }
            FieldLabel(stringResource(R.string.model_config_api_key))
            FormField(
                value = draft.apiKey,
                placeholder = "",
                secret = true,
                enabled = editable,
                onValueChange = { draft = draft.copy(apiKey = it) },
            )
            MutedText(stringResource(R.string.model_config_api_key_write_only))
            errorCode?.let { code ->
                Text(
                    stringResource(modelConfigErrorRes(code)),
                    color = colors.errorText,
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                )
            }
            if (draft.manual) {
                MutedText(stringResource(R.string.model_config_manual_fallback_hint))
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
                            enabled = editable,
                            onCheckedChange = { checked -> draft = draft.withOffer(protocol) { it.copy(enabled = checked) } },
                        )
                        if (offer.enabled) {
                            FormField(
                                value = offer.baseUrl,
                                placeholder = stringResource(R.string.model_config_base_url_placeholder),
                                keyboardType = KeyboardType.Uri,
                                enabled = editable,
                                onValueChange = { value -> draft = draft.withOffer(protocol) { it.copy(baseUrl = value) } },
                            )
                            FormField(
                                value = offer.models,
                                placeholder = stringResource(R.string.model_config_models_placeholder),
                                singleLine = false,
                                monospace = true,
                                enabled = editable,
                                onValueChange = { value -> draft = draft.withOffer(protocol) { it.copy(models = value) } },
                            )
                        }
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
                label = stringResource(
                    when {
                        !saving -> R.string.common_save
                        draft.manual -> R.string.common_saving
                        else -> R.string.model_config_detecting
                    },
                ),
                primary = true,
                enabled = draft.valid && !saving,
                loading = saving,
                modifier = Modifier.weight(1f),
                onClick = {
                    saving = true
                    errorCode = null
                    val submitted = draft
                    scope.launch {
                        try {
                            onSave(submitted).onFailure { error ->
                                val code = modelConfigErrorCode(error)
                                when {
                                    code !in GATEWAY_ERROR_CODES -> onError(error)
                                    !submitted.manual && code in GATEWAY_MANUAL_FALLBACK_CODES -> {
                                        errorCode = code
                                        draft = draft.toManual()
                                    }
                                    else -> errorCode = code
                                }
                            }
                        } finally {
                            saving = false
                        }
                    }
                },
            )
        }
    }
}

/** Asks before an action that cannot wait for the user to change their mind. */
@Composable
internal fun ConfirmActionDialog(
    title: String,
    description: String,
    confirmLabel: String,
    onDismiss: () -> Unit,
    onConfirm: suspend () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    ProfileDialog(title = title, onDismiss = { if (!busy) onDismiss() }) {
        MutedText(description)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProfileDialogButton(
                label = stringResource(R.string.common_cancel),
                enabled = !busy,
                modifier = Modifier.weight(1f),
                onClick = onDismiss,
            )
            ProfileDialogButton(
                label = confirmLabel,
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
internal fun RotateKeyConfirmDialog(
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    ConfirmActionDialog(
        title = stringResource(R.string.model_config_rotate),
        description = stringResource(R.string.model_config_rotate_description),
        confirmLabel = stringResource(R.string.model_config_rotate),
        onDismiss = onDismiss,
        onConfirm = { onConfirm() },
    )
}

/** Asked only after the Server answered `busy`: continuing interrupts running tasks. */
@Composable
internal fun InterruptConfirmDialog(
    onDismiss: () -> Unit,
    onConfirm: suspend () -> Unit,
) {
    ConfirmActionDialog(
        title = stringResource(R.string.model_config_interrupt_title),
        description = stringResource(R.string.model_config_interrupt_description),
        confirmLabel = stringResource(R.string.model_config_interrupt_continue),
        onDismiss = onDismiss,
        onConfirm = onConfirm,
    )
}

@Composable
private fun FieldLabel(text: String) {
    Text(text, color = LocalAAColors.current.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun CheckRow(label: String, checked: Boolean, enabled: Boolean = true, onCheckedChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
        Text(label, color = LocalAAColors.current.ink, fontSize = 13.5.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium)
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
    enabled: Boolean = true,
    onValueChange: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val family = if (monospace) FontFamily.Monospace else FontFamily.Default
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
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
