package com.agentsanywhere.app.ui.screens.sessiondetail

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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.RuntimeSelectionOption
import com.agentsanywhere.app.ui.designsystem.CheckGlyph
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionRuntimeSettingsSheet(
    runtimeLabel: String,
    modelOptions: List<RuntimeSelectionOption>,
    permissionOptions: List<RuntimeSelectionOption>,
    selectedModelId: String?,
    selectedPermissionId: String?,
    modelLoading: Boolean,
    permissionLoading: Boolean,
    modelErrorMessage: String?,
    permissionErrorMessage: String?,
    busy: Boolean,
    darkMode: Boolean,
    onDismiss: () -> Unit,
    onRetryModels: () -> Unit,
    onRetryPermissions: () -> Unit,
    onSelectModel: (String) -> Unit,
    onSelectPermission: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var page by remember { mutableStateOf(RuntimeSettingsPage.Model) }
    val groupedModels = remember(modelOptions) { modelOptions.groupByModelLabel() }
    val selectedModelGroup = groupedModels.firstOrNull { group ->
        group.options.any { it.selectionId == selectedModelId }
    } ?: groupedModels.firstOrNull()
    val selectedPermissionLabel = permissionOptions
        .firstOrNull { it.selectionId == selectedPermissionId }
        ?.label
    val defaultEffortLabel = stringResource(R.string.session_runtime_effort_default)
    val selectedModelOption = selectedModelGroup
        ?.options
        ?.firstOrNull { it.selectionId == selectedModelId }
    val selectedEffortLabel = selectedModelOption?.effortDisplayLabel(defaultEffortLabel)
    ModalBottomSheet(
        onDismissRequest = { if (!busy) onDismiss() },
        sheetState = sheetState,
        containerColor = if (darkMode) colors.raisedSurface else Color(0xFFFFFEFC),
        contentColor = colors.ink,
        scrimColor = if (darkMode) Color(0x99000000) else Color(0x1F000000),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        dragHandle = {
            Box(
                modifier = Modifier
                    .padding(top = 11.dp, bottom = 8.dp)
                    .width(42.dp)
                    .height(5.dp)
                    .clip(CircleShape)
                    .background(if (darkMode) Color(0xFF3F3F46) else Color(0xFFD5D2CC)),
            )
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(start = 22.dp, end = 22.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when (page) {
                RuntimeSettingsPage.Model -> {
                    RuntimeSheetHeader(
                        title = stringResource(R.string.session_runtime_select_model),
                        subtitle = runtimeLabel,
                        onClose = onDismiss,
                        busy = busy,
                    )
                    ModelSelectionSection(
                        groups = groupedModels,
                        selectedId = selectedModelId,
                        loading = modelLoading,
                        errorMessage = modelErrorMessage,
                        busy = busy,
                        darkMode = darkMode,
                        onRetry = onRetryModels,
                        onSelect = onSelectModel,
                    )
                    ModeEffortTrigger(
                        detail = listOfNotNull(selectedPermissionLabel, selectedEffortLabel)
                            .joinToString(" · ")
                            .ifBlank { stringResource(R.string.session_runtime_no_settings) },
                        darkMode = darkMode,
                        enabled = !busy,
                        onClick = { page = RuntimeSettingsPage.ModeEffort },
                    )
                }
                RuntimeSettingsPage.ModeEffort -> {
                    RuntimeSheetHeader(
                        title = stringResource(R.string.session_runtime_mode_effort),
                        subtitle = selectedModelGroup?.label ?: runtimeLabel,
                        onClose = { page = RuntimeSettingsPage.Model },
                        busy = busy,
                    )
                    RuntimeSettingsSection(
                        title = stringResource(R.string.session_runtime_permission_mode),
                        options = permissionOptions,
                        selectedId = selectedPermissionId,
                        loading = permissionLoading,
                        errorMessage = permissionErrorMessage,
                        busy = busy,
                        darkMode = darkMode,
                        onRetry = onRetryPermissions,
                        onSelect = onSelectPermission,
                    )
                    selectedModelGroup?.takeIf { it.options.size > 1 }?.let { group ->
                        EffortSelectionSection(
                            modelLabel = group.label,
                            options = group.options,
                            selectedId = selectedModelId,
                            enabled = !busy && !modelLoading,
                            darkMode = darkMode,
                            onSelect = onSelectModel,
                        )
                    }
                }
            }
        }
    }
}

private enum class RuntimeSettingsPage {
    Model,
    ModeEffort,
}

private data class ModelOptionGroup(
    val label: String,
    val options: List<RuntimeSelectionOption>,
)

private val RuntimeSelectionOption.modelLabel: String
    get() = label.substringBefore(" · ").ifBlank { label }

private val RuntimeSelectionOption.effortLabel: String?
    get() = label.substringAfter(" · ", "").takeIf(String::isNotBlank)

internal fun RuntimeSelectionOption.effortDisplayLabel(defaultLabel: String): String =
    effortLabel ?: defaultLabel

private fun List<RuntimeSelectionOption>.groupByModelLabel(): List<ModelOptionGroup> =
    groupBy(RuntimeSelectionOption::modelLabel).map { (label, options) -> ModelOptionGroup(label, options) }

@Composable
private fun RuntimeSheetHeader(
    title: String,
    subtitle: String,
    onClose: () -> Unit,
    busy: Boolean,
) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, color = colors.ink, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
            subtitle.takeIf(String::isNotBlank)?.let {
                Text(it, color = colors.muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        TextButton(onClick = onClose, enabled = !busy) {
            Text(stringResource(R.string.common_close))
        }
    }
}

@Composable
private fun ModelSelectionSection(
    groups: List<ModelOptionGroup>,
    selectedId: String?,
    loading: Boolean,
    errorMessage: String?,
    busy: Boolean,
    darkMode: Boolean,
    onRetry: () -> Unit,
    onSelect: (String) -> Unit,
) {
    val options = groups.map { group ->
        val current = group.options.firstOrNull { it.selectionId == selectedId }
        current
            ?: group.options.firstOrNull { it.enabled && it.default }
            ?: group.options.firstOrNull { it.enabled }
            ?: group.options.first()
    }.map { option -> option.copy(label = option.modelLabel) }
    RuntimeSettingsSection(
        title = stringResource(R.string.session_runtime_settings_title),
        options = options,
        selectedId = selectedId,
        selectedIds = groups.firstOrNull { it.options.any { option -> option.selectionId == selectedId } }
            ?.options
            ?.mapTo(mutableSetOf()) { it.selectionId }
            .orEmpty(),
        loading = loading,
        errorMessage = errorMessage,
        busy = busy,
        darkMode = darkMode,
        onRetry = onRetry,
        onSelect = onSelect,
    )
}

@Composable
private fun ModeEffortTrigger(
    detail: String,
    darkMode: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .border(1.dp, colors.border, RoundedCornerShape(14.dp))
            .noRippleClickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                stringResource(R.string.session_runtime_mode_effort),
                color = colors.ink,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(detail, color = colors.muted, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text("›", color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777), fontSize = 24.sp)
    }
}

@Composable
private fun EffortSelectionSection(
    modelLabel: String,
    options: List<RuntimeSelectionOption>,
    selectedId: String?,
    enabled: Boolean,
    darkMode: Boolean,
    onSelect: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val defaultEffortLabel = stringResource(R.string.session_runtime_effort_default)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(R.string.session_runtime_effort_for, modelLabel),
            color = colors.muted,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(if (darkMode) Color(0xFF09090B) else Color(0xFFF5F3EE))
                .padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            options.forEach { option ->
                val selected = option.selectionId == selectedId
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(11.dp))
                        .background(
                            if (selected) {
                                if (darkMode) Color(0xFF27272A) else Color.White
                            } else {
                                Color.Transparent
                            },
                        )
                        .noRippleClickable(enabled = enabled && option.enabled) { onSelect(option.selectionId) }
                        .padding(horizontal = 4.dp, vertical = 9.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        option.effortDisplayLabel(defaultEffortLabel),
                        color = when {
                            !option.enabled -> colors.muted.copy(alpha = 0.45f)
                            selected -> colors.ink
                            else -> colors.muted
                        },
                        fontSize = 11.5.sp,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        options.filter { !it.enabled }.forEach { option ->
            option.disabledReason?.takeIf(String::isNotBlank)?.let { reason ->
                Text(
                    text = "${option.effortDisplayLabel(defaultEffortLabel)}: $reason",
                    color = colors.muted,
                    fontSize = 11.5.sp,
                )
            }
        }
    }
}

@Composable
private fun RuntimeSettingsSection(
    title: String,
    options: List<RuntimeSelectionOption>,
    selectedId: String?,
    selectedIds: Set<String> = emptySet(),
    loading: Boolean,
    errorMessage: String?,
    busy: Boolean,
    darkMode: Boolean,
    onRetry: () -> Unit,
    onSelect: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = title,
            color = colors.muted,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 260.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            when {
                loading && options.isEmpty() -> Box(
                    modifier = Modifier.fillMaxWidth().height(72.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(22.dp),
                        color = colors.ink,
                        strokeWidth = 2.dp,
                    )
                }
                errorMessage != null && options.isEmpty() -> Column {
                    Text(errorMessage, color = colors.errorText, fontSize = 13.sp)
                    TextButton(onClick = onRetry, enabled = !loading && !busy) {
                        Text(stringResource(R.string.common_retry))
                    }
                }
                options.isEmpty() -> Text(
                    text = stringResource(R.string.session_runtime_no_settings),
                    color = colors.muted,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(vertical = 12.dp),
                )
                else -> options.forEach { option ->
                    val selected = option.selectionId == selectedId || option.selectionId in selectedIds
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(14.dp))
                            .background(
                                if (selected) {
                                    if (darkMode) Color(0xFF27272A) else Color(0xFFF6F4EF)
                                } else {
                                    Color.Transparent
                                },
                            )
                            .border(
                                width = 1.dp,
                                color = if (selected) colors.border else Color.Transparent,
                                shape = RoundedCornerShape(14.dp),
                            )
                            .noRippleClickable(enabled = !busy && !loading && option.enabled) {
                                onSelect(option.selectionId)
                            }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = option.label,
                                color = colors.ink.copy(alpha = if (option.enabled) 1f else 0.45f),
                                fontSize = 14.sp,
                                fontWeight = if (selected) FontWeight.Bold else FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            (option.disabledReason ?: option.description)?.takeIf(String::isNotBlank)?.let {
                                Text(
                                    text = it,
                                    color = colors.muted,
                                    fontSize = 11.5.sp,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        if (selected) CheckGlyph(color = colors.ink)
                    }
                }
            }
        }
    }
}
