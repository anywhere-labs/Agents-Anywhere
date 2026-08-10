package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
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
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeConfigDraft
import com.agentsanywhere.app.feature.devices.RuntimeConfigValidationError
import com.agentsanywhere.app.feature.devices.RuntimeEnvironmentVariable
import com.agentsanywhere.app.feature.devices.toConfigDraft
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.X
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DeviceAgentSettingsSheet(
    device: AgentDevice,
    runtime: DeviceRuntime,
    onDismiss: () -> Unit,
    onSaveConfig: suspend (String, String, Map<String, Any?>) -> Result<DeviceRuntime>,
) {
    val colors = LocalAAColors.current
    val context = LocalContext.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val bodyMaxHeight = (LocalConfiguration.current.screenHeightDp * 0.58f).dp
    val scope = rememberCoroutineScope()
    var draft by remember(device.id, runtime.id, runtime.updatedAt) {
        mutableStateOf(runtime.toConfigDraft())
    }
    var saving by remember(device.id, runtime.id) { mutableStateOf(false) }
    var saveError by remember(device.id, runtime.id) { mutableStateOf<String?>(null) }
    val validationError = draft.validationError()

    fun save() {
        if (saving || validationError != null) return
        saving = true
        saveError = null
        scope.launch {
            onSaveConfig(device.id, runtime.id, draft.toConfig())
                .onSuccess { onDismiss() }
                .onFailure { error ->
                    saveError = error.message ?: context.getString(R.string.agent_settings_save_failed)
                }
            saving = false
        }
    }

    ModalBottomSheet(
        onDismissRequest = { if (!saving) onDismiss() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = if (darkMode) Color(0xFF18181B) else Color(0xFFFDFCFB),
        contentColor = colors.ink,
        dragHandle = null,
        scrimColor = if (darkMode) Color(0x99000000) else Color(0x66000000),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(start = 22.dp, end = 22.dp, top = 10.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .width(40.dp)
                        .height(4.dp)
                        .clip(CircleShape)
                        .background(if (darkMode) Color(0xFF3F3F46) else Color(0xFFD8D5CF)),
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.agent_settings_title),
                        color = colors.ink,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.ExtraBold,
                    )
                    Text(
                        text = runtime.displayName,
                        color = colors.muted,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                RoundIconAction(
                    icon = Lucide.X,
                    contentDescription = stringResource(R.string.common_close),
                    danger = false,
                    onClick = onDismiss,
                )
            }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = bodyMaxHeight)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                if (draft.fieldOrder.isEmpty()) {
                    Text(
                        text = stringResource(R.string.agent_settings_none),
                        color = colors.muted,
                        fontSize = 13.sp,
                    )
                }
                draft.fieldOrder.forEach { field ->
                    when (field) {
                        "executablePath" -> if (draft.supportsExecutablePath) {
                            RuntimePathField(
                                value = draft.executablePath,
                                enabled = !saving,
                                onValueChange = { draft = draft.copy(executablePath = it) },
                            )
                        }
                        "environment" -> if (draft.supportsEnvironment) {
                            RuntimeEnvironmentFields(
                                variables = draft.environment,
                                enabled = !saving,
                                onVariablesChange = { draft = draft.copy(environment = it) },
                            )
                        }
                    }
                }
                validationError?.let { RuntimeConfigError(validationErrorMessage(it)) }
                saveError?.let { RuntimeConfigError(it) }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                SheetTextButton(
                    label = stringResource(R.string.common_cancel),
                    enabled = !saving,
                    primary = false,
                    modifier = Modifier.weight(1f),
                    onClick = onDismiss,
                )
                SheetTextButton(
                    label = if (saving) {
                        stringResource(R.string.agent_settings_saving)
                    } else {
                        stringResource(R.string.agent_settings_save)
                    },
                    enabled = !saving && validationError == null,
                    primary = true,
                    modifier = Modifier.weight(1f),
                    onClick = ::save,
                )
            }
        }
    }
}

@Composable
private fun RuntimePathField(
    value: String,
    enabled: Boolean,
    onValueChange: (String) -> Unit,
) {
    RuntimeFieldLabel(
        title = stringResource(R.string.agent_settings_executable_path),
        description = stringResource(R.string.agent_settings_executable_path_description),
    )
    RuntimeTextInput(
        value = value,
        placeholder = stringResource(R.string.agent_settings_executable_path_placeholder),
        enabled = enabled,
        monospace = true,
        onValueChange = onValueChange,
    )
}

@Composable
private fun RuntimeEnvironmentFields(
    variables: List<RuntimeEnvironmentVariable>,
    enabled: Boolean,
    onVariablesChange: (List<RuntimeEnvironmentVariable>) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        RuntimeFieldLabel(
            title = stringResource(R.string.agent_settings_environment),
            description = stringResource(R.string.agent_settings_environment_description),
        )
        variables.forEachIndexed { index, variable ->
            EnvironmentVariableEditor(
                variable = variable,
                enabled = enabled,
                onChange = { updated ->
                    onVariablesChange(variables.mapIndexed { currentIndex, current ->
                        if (currentIndex == index) updated else current
                    })
                },
                onDelete = { onVariablesChange(variables.filterIndexed { currentIndex, _ -> currentIndex != index }) },
            )
        }
        SheetTextButton(
            label = stringResource(R.string.agent_settings_add_variable),
            enabled = enabled,
            primary = false,
            modifier = Modifier.fillMaxWidth(),
            onClick = { onVariablesChange(variables + RuntimeEnvironmentVariable("", "")) },
        )
    }
}

@Composable
private fun EnvironmentVariableEditor(
    variable: RuntimeEnvironmentVariable,
    enabled: Boolean,
    onChange: (RuntimeEnvironmentVariable) -> Unit,
    onDelete: () -> Unit,
) {
    val colors = LocalAAColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(colors.subtle)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            RuntimeTextInput(
                value = variable.key,
                placeholder = stringResource(R.string.agent_settings_environment_name),
                enabled = enabled,
                monospace = true,
                modifier = Modifier.weight(1f),
                onValueChange = { onChange(variable.copy(key = it)) },
            )
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(CircleShape)
                    .background(colors.errorText.copy(alpha = 0.1f))
                    .noRippleClickable(enabled = enabled, onClick = onDelete),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Lucide.Trash2,
                    contentDescription = stringResource(R.string.common_delete),
                    tint = colors.errorText.copy(alpha = if (enabled) 1f else 0.4f),
                    modifier = Modifier.size(17.dp),
                )
            }
        }
        RuntimeTextInput(
            value = variable.value,
            placeholder = stringResource(R.string.agent_settings_environment_value),
            enabled = enabled && !variable.removeInheritedValue,
            monospace = true,
            onValueChange = { onChange(variable.copy(value = it)) },
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = stringResource(R.string.agent_settings_environment_unset),
                color = colors.muted,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Switch(
                checked = variable.removeInheritedValue,
                onCheckedChange = { onChange(variable.copy(removeInheritedValue = it)) },
                enabled = enabled,
            )
        }
    }
}

@Composable
private fun RuntimeFieldLabel(title: String, description: String) {
    val colors = LocalAAColors.current
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            text = title,
            color = colors.ink,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
        )
        Text(
            text = description,
            color = colors.muted,
            fontSize = 12.sp,
            lineHeight = 16.sp,
        )
    }
}

@Composable
private fun RuntimeTextInput(
    value: String,
    placeholder: String,
    enabled: Boolean,
    monospace: Boolean,
    modifier: Modifier = Modifier,
    onValueChange: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        singleLine = true,
        textStyle = TextStyle(
            color = colors.ink.copy(alpha = if (enabled) 1f else 0.45f),
            fontSize = 13.5.sp,
            fontWeight = FontWeight.Medium,
            fontFamily = if (monospace) FontFamily.Monospace else FontFamily.Default,
        ),
        cursorBrush = SolidColor(colors.ink),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        modifier = modifier
            .fillMaxWidth()
            .height(44.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(colors.raisedSurface)
            .border(1.dp, colors.border, RoundedCornerShape(12.dp))
            .padding(horizontal = 12.dp),
        decorationBox = { inner ->
            Box(contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) {
                    Text(
                        text = placeholder,
                        color = colors.faint,
                        fontSize = 13.sp,
                        fontFamily = if (monospace) FontFamily.Monospace else FontFamily.Default,
                    )
                }
                inner()
            }
        },
    )
}

@Composable
private fun validationErrorMessage(error: RuntimeConfigValidationError): String {
    return stringResource(
        when (error) {
            RuntimeConfigValidationError.BlankName -> R.string.agent_settings_environment_blank_name
            RuntimeConfigValidationError.InvalidName -> R.string.agent_settings_environment_invalid_name
            RuntimeConfigValidationError.DuplicateName -> R.string.agent_settings_environment_duplicate_name
        },
    )
}

@Composable
private fun RuntimeConfigError(message: String) {
    Text(
        text = message,
        color = LocalAAColors.current.errorText,
        fontSize = 12.5.sp,
        fontWeight = FontWeight.SemiBold,
        lineHeight = 17.sp,
    )
}
