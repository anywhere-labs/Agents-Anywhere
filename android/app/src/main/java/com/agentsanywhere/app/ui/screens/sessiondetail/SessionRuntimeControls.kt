package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.RuntimeCommand
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNotice
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNoticeAction
import com.agentsanywhere.app.feature.sessiondetail.coerceInput
import com.agentsanywhere.app.feature.sessiondetail.inputFields
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

@Composable
internal fun RuntimeCommandSuggestions(
    commands: List<RuntimeCommand>,
    query: String,
    loading: Boolean,
    errorMessage: String?,
    onRetry: () -> Unit,
    onSelect: (RuntimeCommand) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val matches = remember(commands, query) { commands.filter { it.matches(query) }.take(6) }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp)
            .background(colors.canvas.copy(alpha = 0.98f), RoundedCornerShape(18.dp))
            .border(1.dp, colors.border, RoundedCornerShape(18.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        when {
            loading -> Text(stringResource(R.string.session_commands_loading), color = colors.muted)
            errorMessage != null -> {
                Text(errorMessage, color = Color(0xFFDC2626), fontSize = 13.sp)
                TextButton(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
            }
            matches.isEmpty() -> Text(stringResource(R.string.session_commands_empty), color = colors.muted)
            else -> matches.forEach { command ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color.Transparent, RoundedCornerShape(10.dp))
                        .noRippleClickable { onSelect(command) }
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                ) {
                    Text(
                        text = "/${command.id}  ${command.title}",
                        color = colors.ink.copy(alpha = if (command.enabled) 1f else 0.45f),
                        fontWeight = FontWeight.SemiBold,
                    )
                    (command.disabledReason ?: command.description)?.takeIf(String::isNotBlank)?.let {
                        Text(it, color = colors.muted, fontSize = 12.sp)
                    }
                }
            }
        }
    }
}

@Composable
internal fun RuntimeNoticeDialog(
    notice: RuntimeNotice,
    busy: Boolean,
    errorMessage: String?,
    onRespond: (RuntimeNoticeAction, Map<String, Any?>?) -> Unit,
) {
    var selectedActionId by remember(notice.noticeId) { mutableStateOf<String?>(null) }
    var rawValues by remember(notice.noticeId, selectedActionId) { mutableStateOf(emptyMap<String, String>()) }
    var validationError by remember(notice.noticeId, selectedActionId) { mutableStateOf<String?>(null) }
    val selectedAction = notice.actions.firstOrNull { it.actionId == selectedActionId }
    val fields = selectedAction?.inputFields().orEmpty()

    fun submit(action: RuntimeNoticeAction) {
        action.coerceInput(rawValues)
            .onSuccess { input ->
                validationError = null
                onRespond(action, input)
            }
            .onFailure { validationError = it.message }
    }

    AlertDialog(
        onDismissRequest = {},
        title = { Text(notice.title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                notice.message?.takeIf(String::isNotBlank)?.let { Text(it) }
                errorMessage?.let { Text(it, color = Color(0xFFDC2626), fontSize = 13.sp) }
                notice.actions.forEach { action ->
                    val needsInput = action.inputFields().isNotEmpty()
                    TextButton(
                        onClick = {
                            if (needsInput) {
                                selectedActionId = action.actionId
                                validationError = null
                            } else {
                                submit(action)
                            }
                        },
                        enabled = !busy,
                    ) {
                        Text(
                            action.label.ifBlank { action.actionId },
                            color = if (action.style == "danger") Color(0xFFDC2626) else Color.Unspecified,
                        )
                    }
                }
                if (selectedAction != null) {
                    fields.forEach { field ->
                        OutlinedTextField(
                            value = rawValues[field.key].orEmpty(),
                            onValueChange = { rawValues = rawValues + (field.key to it) },
                            label = { Text(field.label) },
                            enabled = !busy,
                            singleLine = field.type != "string",
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    validationError?.let { Text(it, color = Color(0xFFDC2626), fontSize = 13.sp) }
                    TextButton(onClick = { submit(selectedAction) }, enabled = !busy) {
                        Text(stringResource(R.string.session_notice_submit))
                    }
                }
            }
        },
        confirmButton = {
            if (busy) CircularProgressIndicator(modifier = Modifier.widthIn(max = 24.dp))
        },
    )
}
