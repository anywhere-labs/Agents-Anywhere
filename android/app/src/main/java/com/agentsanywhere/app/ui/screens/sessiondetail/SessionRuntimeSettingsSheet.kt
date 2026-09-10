package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.RuntimeSelectionOption
import com.agentsanywhere.app.ui.designsystem.AABottomSheet
import com.agentsanywhere.app.ui.designsystem.AABottomSheetColors
import com.agentsanywhere.app.ui.designsystem.AABottomSheetDefaults
import com.agentsanywhere.app.ui.designsystem.AABottomSheetItem
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

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
    onDismiss: () -> Unit,
    onRetryModels: () -> Unit,
    onRetryPermissions: () -> Unit,
    onSelectModel: (String) -> Unit,
    onSelectPermission: (String) -> Unit,
) {
    var page by remember(runtimeLabel) { mutableStateOf(RuntimeSettingsPage.Model) }
    val palette = AABottomSheetDefaults.colors()
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

    AABottomSheet(
        title = stringResource(
            if (page == RuntimeSettingsPage.Model) R.string.session_runtime_select_model else R.string.session_runtime_mode_effort,
        ),
        onDismissRequest = onDismiss,
        dismissEnabled = !busy,
        onBack = if (page == RuntimeSettingsPage.ModeEffort) ({ page = RuntimeSettingsPage.Model }) else null,
    ) {
        when (page) {
            RuntimeSettingsPage.Model -> ModelPage(
                groups = groupedModels,
                selectedId = selectedModelId,
                permissionLabel = selectedPermissionLabel,
                effortLabel = selectedEffortLabel,
                loading = modelLoading,
                errorMessage = modelErrorMessage,
                busy = busy,
                palette = palette,
                onRetry = onRetryModels,
                onOpenModeEffort = { page = RuntimeSettingsPage.ModeEffort },
                onSelect = onSelectModel,
            )
            RuntimeSettingsPage.ModeEffort -> ModeEffortPage(
                runtimeLabel = runtimeLabel,
                selectedModelGroup = selectedModelGroup,
                selectedModelId = selectedModelId,
                permissionOptions = permissionOptions,
                selectedPermissionId = selectedPermissionId,
                modelLoading = modelLoading,
                permissionLoading = permissionLoading,
                permissionErrorMessage = permissionErrorMessage,
                busy = busy,
                palette = palette,
                onRetryPermissions = onRetryPermissions,
                onSelectModel = onSelectModel,
                onSelectPermission = onSelectPermission,
            )
        }
    }
}

@Composable
private fun ModelPage(
    groups: List<ModelOptionGroup>,
    selectedId: String?,
    permissionLabel: String?,
    effortLabel: String?,
    loading: Boolean,
    errorMessage: String?,
    busy: Boolean,
    palette: AABottomSheetColors,
    onRetry: () -> Unit,
    onOpenModeEffort: () -> Unit,
    onSelect: (String) -> Unit,
) {
    ModelOptions(
        groups = groups,
        selectedId = selectedId,
        loading = loading,
        errorMessage = errorMessage,
        busy = busy,
        palette = palette,
        onRetry = onRetry,
        onSelect = onSelect,
    )

    DividerLine(palette.divider)
    AABottomSheetItem(
        text = stringResource(R.string.session_runtime_mode_effort),
        supportingText = listOfNotNull(permissionLabel, effortLabel).joinToString(" · ")
            .ifBlank { stringResource(R.string.session_runtime_no_settings) },
        enabled = !busy,
        showChevron = true,
        onClick = onOpenModeEffort,
    )
}

@Composable
private fun ModelOptions(
    groups: List<ModelOptionGroup>,
    selectedId: String?,
    loading: Boolean,
    errorMessage: String?,
    busy: Boolean,
    palette: AABottomSheetColors,
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
    val selectedIds = groups
        .firstOrNull { group -> group.options.any { option -> option.selectionId == selectedId } }
        ?.options
        ?.mapTo(mutableSetOf()) { it.selectionId }
        .orEmpty()

    when {
        loading && options.isEmpty() -> SheetLoading(palette = palette)
        errorMessage != null && options.isEmpty() -> SheetError(
            message = errorMessage,
            retryEnabled = !busy && !loading,
            onRetry = onRetry,
        )
        options.isEmpty() -> SheetEmpty(palette = palette)
        else -> Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            options.forEach { option ->
                AABottomSheetItem(
                    text = option.label,
                    supportingText = option.disabledReason,
                    selected = option.selectionId == selectedId || option.selectionId in selectedIds,
                    enabled = !busy && !loading && option.enabled,
                    onClick = { onSelect(option.selectionId) },
                )
            }
        }
    }
}

@Composable
private fun ModeEffortPage(
    runtimeLabel: String,
    selectedModelGroup: ModelOptionGroup?,
    selectedModelId: String?,
    permissionOptions: List<RuntimeSelectionOption>,
    selectedPermissionId: String?,
    modelLoading: Boolean,
    permissionLoading: Boolean,
    permissionErrorMessage: String?,
    busy: Boolean,
    palette: AABottomSheetColors,
    onRetryPermissions: () -> Unit,
    onSelectModel: (String) -> Unit,
    onSelectPermission: (String) -> Unit,
) {
    val modelLabel = selectedModelGroup?.label ?: runtimeLabel
    val effortOptions = selectedModelGroup?.options.orEmpty().takeIf { it.size > 1 }

    PermissionSection(
        options = permissionOptions,
        selectedId = selectedPermissionId,
        loading = permissionLoading,
        errorMessage = permissionErrorMessage,
        busy = busy,
        palette = palette,
        onRetry = onRetryPermissions,
        onSelect = onSelectPermission,
    )

    if (effortOptions != null) {
        DividerLine(palette.divider)
        EffortSelectionSection(
            modelLabel = modelLabel,
            options = effortOptions,
            selectedId = selectedModelId,
            enabled = !busy && !modelLoading,
            palette = palette,
            onSelect = onSelectModel,
        )
    }
}

@Composable
private fun PermissionSection(
    options: List<RuntimeSelectionOption>,
    selectedId: String?,
    loading: Boolean,
    errorMessage: String?,
    busy: Boolean,
    palette: AABottomSheetColors,
    onRetry: () -> Unit,
    onSelect: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionLabel(stringResource(R.string.session_runtime_permission_mode), palette)
        when {
            loading && options.isEmpty() -> SheetLoading(palette = palette, height = 72.dp)
            errorMessage != null && options.isEmpty() -> SheetError(
                message = errorMessage,
                height = 96.dp,
                retryEnabled = !busy && !loading,
                onRetry = onRetry,
            )
            options.isEmpty() -> SheetEmpty(palette = palette)
            else -> Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                options.forEach { option ->
                    AABottomSheetItem(
                        text = option.label,
                        supportingText = option.disabledReason ?: option.description,
                        selected = option.selectionId == selectedId,
                        enabled = !busy && !loading && option.enabled,
                        onClick = { onSelect(option.selectionId) },
                    )
                }
            }
        }
    }
}

@Composable
private fun EffortSelectionSection(
    modelLabel: String,
    options: List<RuntimeSelectionOption>,
    selectedId: String?,
    enabled: Boolean,
    palette: AABottomSheetColors,
    onSelect: (String) -> Unit,
) {
    val defaultEffortLabel = stringResource(R.string.session_runtime_effort_default)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SectionLabel(stringResource(R.string.session_runtime_effort_for, modelLabel), palette)
        EffortSegments(
            options = options,
            selectedId = selectedId,
            enabled = enabled,
            defaultEffortLabel = defaultEffortLabel,
            palette = palette,
            onSelect = onSelect,
        )
        options.filter { !it.enabled }.forEach { option ->
            option.disabledReason?.takeIf(String::isNotBlank)?.let { reason ->
                Text(
                    text = "${option.effortDisplayLabel(defaultEffortLabel)}: $reason",
                    color = palette.secondaryContent,
                    fontSize = 11.5.sp,
                )
            }
        }
    }
}

@Composable
private fun EffortSegments(
    options: List<RuntimeSelectionOption>,
    selectedId: String?,
    enabled: Boolean,
    defaultEffortLabel: String,
    palette: AABottomSheetColors,
    onSelect: (String) -> Unit,
) {
    var trackWidthPx by remember { mutableFloatStateOf(0f) }
    var dragPositionPx by remember { mutableFloatStateOf(0f) }
    var dragSelectionId by remember { mutableStateOf<String?>(null) }

    fun selectAt(positionPx: Float) {
        if (!enabled || trackWidthPx <= 0f || options.isEmpty()) return
        val index = ((positionPx / trackWidthPx) * options.size)
            .toInt()
            .coerceIn(0, options.lastIndex)
        val option = options[index]
        if (option.enabled) dragSelectionId = option.selectionId
    }

    val dragState = rememberDraggableState { delta ->
        dragPositionPx = (dragPositionPx + delta).coerceIn(0f, trackWidthPx)
        selectAt(dragPositionPx)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(palette.selectedContainer)
            .onSizeChanged { trackWidthPx = it.width.toFloat() }
            .draggable(
                state = dragState,
                orientation = Orientation.Horizontal,
                enabled = enabled,
                onDragStarted = { position ->
                    dragPositionPx = position.x.coerceIn(0f, trackWidthPx)
                    dragSelectionId = null
                    selectAt(dragPositionPx)
                },
                onDragStopped = {
                    val selection = dragSelectionId
                    dragSelectionId = null
                    if (selection != null && selection != selectedId) onSelect(selection)
                },
            )
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        options.forEach { option ->
            val selected = (dragSelectionId ?: selectedId) == option.selectionId
            val optionEnabled = enabled && option.enabled
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .shadow(
                        elevation = if (selected) 3.dp else 0.dp,
                        shape = RoundedCornerShape(12.dp),
                        ambientColor = palette.shadow,
                        spotColor = palette.shadow,
                    )
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (selected) palette.container else Color.Transparent)
                    .noRippleClickable(enabled = optionEnabled) { onSelect(option.selectionId) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = option.effortDisplayLabel(defaultEffortLabel),
                    color = (if (selected) palette.content else palette.secondaryContent)
                        .copy(alpha = if (option.enabled || selected) 1f else 0.45f),
                    fontSize = 10.sp,
                    lineHeight = 11.sp,
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                    maxLines = 2,
                )
            }
        }
    }
}

@Composable
private fun SheetLoading(
    palette: AABottomSheetColors,
    height: Dp = 210.dp,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(height),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(
            color = palette.content,
            strokeWidth = 2.dp,
            modifier = Modifier.size(24.dp),
        )
    }
}

@Composable
private fun SheetError(
    message: String,
    height: Dp = 210.dp,
    retryEnabled: Boolean,
    onRetry: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .height(height),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        AABottomSheetItem(
            text = stringResource(R.string.common_retry),
            errorMessage = message,
            enabled = retryEnabled,
            onClick = onRetry,
        )
    }
}

@Composable
private fun SheetEmpty(palette: AABottomSheetColors) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(72.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = stringResource(R.string.session_runtime_no_settings),
            color = palette.secondaryContent,
            fontSize = 13.sp,
        )
    }
}

@Composable
private fun SectionLabel(text: String, palette: AABottomSheetColors) {
    Text(text, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        color = palette.secondaryContent, fontSize = 12.sp, fontWeight = FontWeight.Medium)
}

@Composable
private fun DividerLine(color: Color) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(color),
    )
}
