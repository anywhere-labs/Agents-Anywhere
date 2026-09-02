package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.RuntimeSelectionOption
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
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var page by remember(runtimeLabel) { mutableStateOf(RuntimeSettingsPage.Model) }
    val palette = runtimeSheetPalette(darkMode)
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
        containerColor = palette.sheet,
        contentColor = palette.title,
        scrimColor = if (darkMode) Color(0x99000000) else Color(0x1F000000),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        dragHandle = null,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(start = 22.dp, end = 22.dp, top = 9.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(if (page == RuntimeSettingsPage.Model) 8.dp else 11.dp),
        ) {
            SheetHandle(color = palette.handle)
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
                    onDismiss = onDismiss,
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
                    onBack = { page = RuntimeSettingsPage.Model },
                    onRetryPermissions = onRetryPermissions,
                    onSelectModel = onSelectModel,
                    onSelectPermission = onSelectPermission,
                )
            }
            SheetHomeIndicator(color = palette.home)
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
    palette: RuntimeSheetPalette,
    onDismiss: () -> Unit,
    onRetry: () -> Unit,
    onOpenModeEffort: () -> Unit,
    onSelect: (String) -> Unit,
) {
    SheetHeader(
        title = stringResource(R.string.session_runtime_select_model),
        palette = palette,
        leading = {
            IconButtonMini(onClick = onDismiss, enabled = !busy) {
                CloseGlyph(palette.icon)
            }
        },
        trailing = { Spacer(Modifier.size(38.dp)) },
    )

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
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(50.dp)
            .noRippleClickable(enabled = !busy, onClick = onOpenModeEffort),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                stringResource(R.string.session_runtime_mode_effort),
                color = palette.primaryText,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = listOfNotNull(permissionLabel, effortLabel)
                    .joinToString(" · ")
                    .ifBlank { stringResource(R.string.session_runtime_no_settings) },
                color = palette.secondaryText,
                fontSize = 11.5.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        SheetChevronRightGlyph(palette.secondaryText)
    }
}

@Composable
private fun ModelOptions(
    groups: List<ModelOptionGroup>,
    selectedId: String?,
    loading: Boolean,
    errorMessage: String?,
    busy: Boolean,
    palette: RuntimeSheetPalette,
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
            palette = palette,
            retryEnabled = !busy && !loading,
            onRetry = onRetry,
        )
        options.isEmpty() -> SheetEmpty(palette = palette)
        else -> Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            options.forEach { option ->
                OptionRow(
                    title = option.label,
                    subtitle = null,
                    selected = option.selectionId == selectedId || option.selectionId in selectedIds,
                    enabled = !busy && !loading && option.enabled,
                    dimmed = !option.enabled,
                    palette = palette,
                    rowHeight = 48.dp,
                    corner = 14.dp,
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
    palette: RuntimeSheetPalette,
    onBack: () -> Unit,
    onRetryPermissions: () -> Unit,
    onSelectModel: (String) -> Unit,
    onSelectPermission: (String) -> Unit,
) {
    val modelLabel = selectedModelGroup?.label ?: runtimeLabel
    val effortOptions = selectedModelGroup?.options.orEmpty().takeIf { it.size > 1 }

    SheetHeader(
        title = stringResource(R.string.session_runtime_mode_effort),
        palette = palette,
        leading = {
            IconButtonMini(onClick = onBack, enabled = !busy) {
                BackGlyph(palette.icon)
            }
        },
        trailing = {
            Spacer(Modifier.size(38.dp))
        },
    )

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
    palette: RuntimeSheetPalette,
    onRetry: () -> Unit,
    onSelect: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionLabel(stringResource(R.string.session_runtime_permission_mode), palette)
        when {
            loading && options.isEmpty() -> SheetLoading(palette = palette, height = 72.dp)
            errorMessage != null && options.isEmpty() -> SheetError(
                message = errorMessage,
                palette = palette,
                height = 96.dp,
                retryEnabled = !busy && !loading,
                onRetry = onRetry,
            )
            options.isEmpty() -> SheetEmpty(palette = palette)
            else -> Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                options.forEach { option ->
                    OptionRow(
                        title = option.label,
                        subtitle = option.disabledReason ?: option.description,
                        selected = option.selectionId == selectedId,
                        enabled = !busy && !loading && option.enabled,
                        dimmed = !option.enabled,
                        palette = palette,
                        rowHeight = 62.dp,
                        corner = 13.dp,
                        subtitleMaxLines = 2,
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
    palette: RuntimeSheetPalette,
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
                    color = palette.secondaryText,
                    fontSize = 11.5.sp,
                )
            }
        }
    }
}

@Composable
private fun SheetHeader(
    title: String,
    palette: RuntimeSheetPalette,
    leading: @Composable () -> Unit,
    trailing: @Composable () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(38.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Text(title, color = palette.title, fontSize = 17.sp, fontWeight = FontWeight.Bold)
        trailing()
    }
}

@Composable
private fun OptionRow(
    title: String,
    subtitle: String?,
    selected: Boolean,
    enabled: Boolean,
    dimmed: Boolean,
    palette: RuntimeSheetPalette,
    rowHeight: Dp,
    corner: Dp,
    subtitleMaxLines: Int = 1,
    onClick: () -> Unit,
) {
    val contentAlpha = if (dimmed && !selected) 0.45f else 1f
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(rowHeight)
            .clip(RoundedCornerShape(corner))
            .background(if (selected) palette.selectedRow else Color.Transparent)
            .noRippleClickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                title,
                color = (if (selected) palette.selectedText else palette.primaryText).copy(alpha = contentAlpha),
                fontSize = 14.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            subtitle?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    color = (if (selected) palette.selectedSubtitle else palette.secondaryText)
                        .copy(alpha = contentAlpha),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = subtitleMaxLines,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (selected) {
            SheetCheckGlyph(palette.check.copy(alpha = contentAlpha))
        } else {
            CircleGlyph(palette.circle.copy(alpha = contentAlpha))
        }
    }
}

@Composable
private fun EffortSegments(
    options: List<RuntimeSelectionOption>,
    selectedId: String?,
    enabled: Boolean,
    defaultEffortLabel: String,
    palette: RuntimeSheetPalette,
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
            .background(palette.segmentTrack)
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
                        ambientColor = palette.segmentShadow,
                        spotColor = palette.segmentShadow,
                    )
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (selected) palette.segmentSelected else Color.Transparent)
                    .noRippleClickable(enabled = optionEnabled) { onSelect(option.selectionId) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = option.effortDisplayLabel(defaultEffortLabel),
                    color = (if (selected) palette.segmentSelectedText else palette.segmentText)
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
    palette: RuntimeSheetPalette,
    height: Dp = 210.dp,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(height),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(
            color = palette.primaryText,
            strokeWidth = 2.dp,
            modifier = Modifier.size(24.dp),
        )
    }
}

@Composable
private fun SheetError(
    message: String,
    palette: RuntimeSheetPalette,
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
        Text(message, color = palette.secondaryText, fontSize = 13.sp)
        Text(
            text = stringResource(R.string.common_retry),
            color = palette.primaryText.copy(alpha = if (retryEnabled) 1f else 0.45f),
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .clip(CircleShape)
                .noRippleClickable(enabled = retryEnabled, onClick = onRetry)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun SheetEmpty(palette: RuntimeSheetPalette) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(72.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = stringResource(R.string.session_runtime_no_settings),
            color = palette.secondaryText,
            fontSize = 13.sp,
        )
    }
}

@Composable
private fun SheetHandle(color: Color) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .width(42.dp)
                .height(5.dp)
                .clip(CircleShape)
                .background(color),
        )
    }
}

@Composable
private fun SheetHomeIndicator(color: Color) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .width(134.dp)
                .height(5.dp)
                .clip(CircleShape)
                .background(color),
        )
    }
}

@Composable
private fun SectionLabel(text: String, palette: RuntimeSheetPalette) {
    Text(text, color = palette.section, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
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

@Composable
private fun IconButtonMini(
    onClick: () -> Unit,
    enabled: Boolean,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(38.dp)
            .clip(CircleShape)
            .noRippleClickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

@Composable
private fun CloseGlyph(color: Color) = Canvas(modifier = Modifier.size(21.dp)) {
    drawLine(
        color,
        Offset(size.width * 0.30f, size.height * 0.30f),
        Offset(size.width * 0.70f, size.height * 0.70f),
        strokeWidth = 1.7.dp.toPx(),
        cap = StrokeCap.Round,
    )
    drawLine(
        color,
        Offset(size.width * 0.70f, size.height * 0.30f),
        Offset(size.width * 0.30f, size.height * 0.70f),
        strokeWidth = 1.7.dp.toPx(),
        cap = StrokeCap.Round,
    )
}

@Composable
private fun BackGlyph(color: Color) = Canvas(modifier = Modifier.size(20.dp)) {
    drawLine(
        color,
        Offset(size.width * 0.72f, size.height * 0.50f),
        Offset(size.width * 0.26f, size.height * 0.50f),
        strokeWidth = 1.8.dp.toPx(),
        cap = StrokeCap.Round,
    )
    drawLine(
        color,
        Offset(size.width * 0.26f, size.height * 0.50f),
        Offset(size.width * 0.45f, size.height * 0.31f),
        strokeWidth = 1.8.dp.toPx(),
        cap = StrokeCap.Round,
    )
    drawLine(
        color,
        Offset(size.width * 0.26f, size.height * 0.50f),
        Offset(size.width * 0.45f, size.height * 0.69f),
        strokeWidth = 1.8.dp.toPx(),
        cap = StrokeCap.Round,
    )
}

@Composable
private fun SheetCheckGlyph(color: Color) = Canvas(modifier = Modifier.size(18.dp)) {
    drawLine(
        color,
        Offset(size.width * 0.25f, size.height * 0.52f),
        Offset(size.width * 0.43f, size.height * 0.68f),
        strokeWidth = 2.dp.toPx(),
        cap = StrokeCap.Round,
    )
    drawLine(
        color,
        Offset(size.width * 0.43f, size.height * 0.68f),
        Offset(size.width * 0.76f, size.height * 0.32f),
        strokeWidth = 2.dp.toPx(),
        cap = StrokeCap.Round,
    )
}

@Composable
private fun CircleGlyph(color: Color) = Canvas(modifier = Modifier.size(10.dp)) {
    drawCircle(
        color = color,
        radius = size.minDimension * 0.38f,
        style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.2.dp.toPx()),
    )
}

@Composable
private fun SheetChevronRightGlyph(color: Color) = Canvas(modifier = Modifier.size(21.dp)) {
    drawLine(
        color,
        Offset(size.width * 0.42f, size.height * 0.30f),
        Offset(size.width * 0.62f, size.height * 0.50f),
        strokeWidth = 1.8.dp.toPx(),
        cap = StrokeCap.Round,
    )
    drawLine(
        color,
        Offset(size.width * 0.62f, size.height * 0.50f),
        Offset(size.width * 0.42f, size.height * 0.70f),
        strokeWidth = 1.8.dp.toPx(),
        cap = StrokeCap.Round,
    )
}

private data class RuntimeSheetPalette(
    val sheet: Color,
    val handle: Color,
    val title: Color,
    val icon: Color,
    val primaryText: Color,
    val secondaryText: Color,
    val section: Color,
    val selectedRow: Color,
    val selectedText: Color,
    val selectedSubtitle: Color,
    val check: Color,
    val circle: Color,
    val divider: Color,
    val segmentTrack: Color,
    val segmentSelected: Color,
    val segmentText: Color,
    val segmentSelectedText: Color,
    val segmentShadow: Color,
    val home: Color,
)

private fun runtimeSheetPalette(darkMode: Boolean): RuntimeSheetPalette {
    return if (darkMode) {
        RuntimeSheetPalette(
            sheet = Color(0xFF18181B),
            handle = Color(0xFF3F3F46),
            title = Color(0xFFFAFAFA),
            icon = Color(0xFFA1A1AA),
            primaryText = Color(0xFFA1A1AA),
            secondaryText = Color(0xFF71717A),
            section = Color(0xFF71717A),
            selectedRow = Color(0xFF27272A),
            selectedText = Color(0xFFFAFAFA),
            selectedSubtitle = Color(0xFF71717A),
            check = Color(0xFFFAFAFA),
            circle = Color(0xFF71717A),
            divider = Color(0xFF27272A),
            segmentTrack = Color(0xFF09090B),
            segmentSelected = Color(0xFF27272A),
            segmentText = Color(0xFFA1A1AA),
            segmentSelectedText = Color(0xFFFAFAFA),
            segmentShadow = Color(0x66000000),
            home = Color(0xFF3F3F46),
        )
    } else {
        RuntimeSheetPalette(
            sheet = Color(0xFFFFFEFC),
            handle = Color(0xFFD5D2CC),
            title = Color(0xFF242520),
            icon = Color(0xFF56534D),
            primaryText = Color(0xFF34342F),
            secondaryText = Color(0xFF918E87),
            section = Color(0xFF8B877F),
            selectedRow = Color(0xFFF6F4EF),
            selectedText = Color(0xFF2F302D),
            selectedSubtitle = Color(0xFF706D66),
            check = Color(0xFF2F302D),
            circle = Color(0xFFD6D2CB),
            divider = Color(0xFFE8E5DE),
            segmentTrack = Color(0xFFF5F3EE),
            segmentSelected = Color.White,
            segmentText = Color(0xFF8B877F),
            segmentSelectedText = Color(0xFF34342F),
            segmentShadow = Color(0x10000000),
            home = Color(0xFFC7C7C7),
        )
    }
}
