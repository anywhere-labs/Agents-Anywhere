package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.RuntimeConfigField
import com.agentsanywhere.app.feature.sessiondetail.RuntimeSettingsState
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

private enum class RuntimeSheetPage {
    Model,
    ModeEffort,
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionRuntimeSettingsSheet(
    session: AgentSession,
    state: RuntimeSettingsState,
    darkMode: Boolean,
    onDismiss: () -> Unit,
    onPatch: (String, String?) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var page by remember(session.id) { mutableStateOf(RuntimeSheetPage.Model) }
    val palette = runtimeSheetPalette(darkMode)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
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
            verticalArrangement = Arrangement.spacedBy(if (page == RuntimeSheetPage.Model) 8.dp else 11.dp),
        ) {
            SheetHandle(color = palette.handle)
            if (state.isLoading) {
                SheetLoading(palette = palette)
            } else if (state.errorMessage != null && state.schema == null) {
                SheetError(message = state.errorMessage, palette = palette)
            } else {
                when (page) {
                    RuntimeSheetPage.Model -> ModelPage(
                        state = state,
                        palette = palette,
                        onDismiss = onDismiss,
                        onOpenModeEffort = { page = RuntimeSheetPage.ModeEffort },
                        onPatch = onPatch,
                    )
                    RuntimeSheetPage.ModeEffort -> ModeEffortPage(
                        session = session,
                        state = state,
                        palette = palette,
                        onBack = { page = RuntimeSheetPage.Model },
                        onPatch = onPatch,
                    )
                }
            }
            SheetHomeIndicator(color = palette.home)
        }
    }
}

@Composable
private fun ModelPage(
    state: RuntimeSettingsState,
    palette: RuntimeSheetPalette,
    onDismiss: () -> Unit,
    onOpenModeEffort: () -> Unit,
    onPatch: (String, String?) -> Unit,
) {
    val modelField = state.sessionField("model")
    val modeField = state.sessionField("permissionMode")
    val effortField = state.filteredEffortField()

    SheetHeader(
        title = stringResource(R.string.session_runtime_select_model),
        palette = palette,
        leading = { IconButtonMini(onClick = onDismiss) { CloseGlyph(palette.icon) } },
        trailing = { Spacer(Modifier.size(38.dp)) },
    )

    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        modelField?.let { field ->
            field.options.forEach { option ->
                val selected = state.value(field.key, field) == option.value
                OptionRow(
                    title = option.label.ifBlank { option.value },
                    subtitle = localizedRuntimeOptionDescription(field, option),
                    selected = selected,
                    palette = palette,
                    rowHeight = 48.dp,
                    corner = 14.dp,
                    onClick = { onPatch(field.key, option.value) },
                )
            }
        }
    }

    DividerLine(palette.divider)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(50.dp)
            .noRippleClickable(onClick = onOpenModeEffort),
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
                text = listOfNotNull(
                    modeField?.let { labelFor(it, state.value(it.key, it)) },
                    effortField?.let { labelFor(it, state.value(it.key, it)) },
                ).joinToString(" · ").ifBlank { stringResource(R.string.session_runtime_no_settings) },
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
private fun ModeEffortPage(
    session: AgentSession,
    state: RuntimeSettingsState,
    palette: RuntimeSheetPalette,
    onBack: () -> Unit,
    onPatch: (String, String?) -> Unit,
) {
    val modelField = state.sessionField("model")
    val modeField = state.sessionField("permissionMode")
    val effortField = state.filteredEffortField()
    val modelLabel = modelField?.let { labelFor(it, state.value(it.key, it)) }
        ?: session.runtimeLabel

    SheetHeader(
        title = stringResource(R.string.session_runtime_mode_effort),
        palette = palette,
        leading = { IconButtonMini(onClick = onBack) { BackGlyph(palette.icon) } },
        trailing = {
            Box(
                modifier = Modifier
                    .height(28.dp)
                    .width(78.dp)
                    .clip(CircleShape)
                    .background(palette.pill),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = modelLabel,
                    color = palette.pillText,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 8.dp),
                )
            }
        },
    )

    modeField?.let { field ->
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            SectionLabel(stringResource(R.string.session_runtime_permission_mode), palette)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                field.options.forEach { option ->
                    OptionRow(
                        title = localizedRuntimeOptionLabel(field, option),
                        subtitle = localizedRuntimeOptionDescription(field, option),
                        selected = state.value(field.key, field) == option.value,
                        palette = palette,
                        rowHeight = 50.dp,
                        corner = 13.dp,
                        onClick = { onPatch(field.key, option.value) },
                    )
                }
            }
        }
    }

    if (modeField != null && effortField != null) DividerLine(palette.divider)

    effortField?.let { field ->
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionLabel(stringResource(R.string.session_runtime_effort_for, modelLabel), palette)
            EffortSegments(
                field = field,
                selected = state.value(field.key, field),
                palette = palette,
                onPatch = onPatch,
            )
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
    palette: RuntimeSheetPalette,
    rowHeight: androidx.compose.ui.unit.Dp,
    corner: androidx.compose.ui.unit.Dp,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(rowHeight)
            .clip(RoundedCornerShape(corner))
            .background(if (selected) palette.selectedRow else Color.Transparent)
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                title,
                color = if (selected) palette.selectedText else palette.primaryText,
                fontSize = 14.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            subtitle?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    color = if (selected) palette.selectedSubtitle else palette.secondaryText,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (selected) CheckGlyph(palette.check) else CircleGlyph(palette.circle)
    }
}

@Composable
private fun EffortSegments(
    field: RuntimeConfigField,
    selected: String,
    palette: RuntimeSheetPalette,
    onPatch: (String, String?) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(42.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(palette.segmentTrack)
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        field.options.forEach { option ->
            val on = selected == option.value
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .shadow(if (on) 3.dp else 0.dp, RoundedCornerShape(12.dp), ambientColor = palette.segmentShadow, spotColor = palette.segmentShadow)
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (on) palette.segmentSelected else Color.Transparent)
                    .noRippleClickable { onPatch(field.key, option.value) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = localizedRuntimeOptionLabel(field, option),
                    color = if (on) palette.segmentSelectedText else palette.segmentText,
                    fontSize = 12.sp,
                    fontWeight = if (on) FontWeight.Bold else FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun SheetLoading(palette: RuntimeSheetPalette) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(210.dp),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(color = palette.primaryText, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
    }
}

@Composable
private fun SheetError(message: String, palette: RuntimeSheetPalette) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(210.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(message, color = palette.secondaryText, fontSize = 13.sp)
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
private fun IconButtonMini(onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .size(38.dp)
            .clip(CircleShape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

@Composable
private fun CloseGlyph(color: Color) = Canvas(modifier = Modifier.size(21.dp)) {
    drawLine(color, Offset(size.width * 0.30f, size.height * 0.30f), Offset(size.width * 0.70f, size.height * 0.70f), strokeWidth = 1.7.dp.toPx(), cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.70f, size.height * 0.30f), Offset(size.width * 0.30f, size.height * 0.70f), strokeWidth = 1.7.dp.toPx(), cap = StrokeCap.Round)
}

@Composable
private fun BackGlyph(color: Color) = Canvas(modifier = Modifier.size(20.dp)) {
    drawLine(color, Offset(size.width * 0.72f, size.height * 0.50f), Offset(size.width * 0.26f, size.height * 0.50f), strokeWidth = 1.8.dp.toPx(), cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.26f, size.height * 0.50f), Offset(size.width * 0.45f, size.height * 0.31f), strokeWidth = 1.8.dp.toPx(), cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.26f, size.height * 0.50f), Offset(size.width * 0.45f, size.height * 0.69f), strokeWidth = 1.8.dp.toPx(), cap = StrokeCap.Round)
}

@Composable
private fun CheckGlyph(color: Color) = Canvas(modifier = Modifier.size(18.dp)) {
    drawLine(color, Offset(size.width * 0.25f, size.height * 0.52f), Offset(size.width * 0.43f, size.height * 0.68f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.43f, size.height * 0.68f), Offset(size.width * 0.76f, size.height * 0.32f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
}

@Composable
private fun CircleGlyph(color: Color) = Canvas(modifier = Modifier.size(10.dp)) {
    drawCircle(color = color, radius = size.minDimension * 0.38f, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.2.dp.toPx()))
}

@Composable
private fun SheetChevronRightGlyph(color: Color) = Canvas(modifier = Modifier.size(21.dp)) {
    drawLine(color, Offset(size.width * 0.42f, size.height * 0.30f), Offset(size.width * 0.62f, size.height * 0.50f), strokeWidth = 1.8.dp.toPx(), cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.62f, size.height * 0.50f), Offset(size.width * 0.42f, size.height * 0.70f), strokeWidth = 1.8.dp.toPx(), cap = StrokeCap.Round)
}

private fun RuntimeSettingsState.sessionField(key: String): RuntimeConfigField? {
    return schema?.fields
        ?.filter { it.allowSessionOverride && !it.hidden && it.type == "enum" && visible(it) }
        ?.firstOrNull { it.key == key && it.options.isNotEmpty() }
}

private fun RuntimeSettingsState.filteredEffortField(): RuntimeConfigField? {
    val field = sessionField("effort") ?: return null
    val model = settings["model"] as? String
    if (schema?.runtime != "claude") return field
    val allowed = claudeEffortValuesForModel(model)
    if (allowed.isEmpty()) return null
    return field.copy(options = field.options.filter { it.value in allowed })
        .takeIf { it.options.isNotEmpty() }
}

private fun RuntimeSettingsState.visible(field: RuntimeConfigField): Boolean {
    if (field.visibleWhen.isEmpty()) return true
    return field.visibleWhen.all { (key, expected) -> settings[key]?.toString() == expected?.toString() }
}

private fun RuntimeSettingsState.value(key: String, field: RuntimeConfigField): String {
    return (settings[key] as? String)
        ?: field.options.firstOrNull { it.value.isNotBlank() }?.value
        ?: ""
}

@Composable
private fun labelFor(field: RuntimeConfigField, value: String): String {
    val option = field.options.firstOrNull { it.value == value }
    return if (option != null) {
        localizedRuntimeOptionLabel(field, option)
    } else {
        value.ifBlank { field.options.firstOrNull()?.let { localizedRuntimeOptionLabel(field, it) }.orEmpty() }
    }
}

private fun claudeEffortValuesForModel(model: String?): Set<String> {
    val key = model.orEmpty()
    if (key == "claude-haiku-4-5") return emptySet()
    if (key.startsWith("claude-opus-4-8") || key.startsWith("claude-opus-4-7")) {
        return setOf("low", "medium", "high", "xhigh", "max")
    }
    if (key.startsWith("claude-opus-4-6") || key.startsWith("claude-sonnet-4-6")) {
        return setOf("low", "medium", "high", "max")
    }
    return setOf("low", "medium", "high", "max")
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
    val pill: Color,
    val pillText: Color,
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
            pill = Color(0xFF27272A),
            pillText = Color(0xFFA1A1AA),
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
            pill = Color(0xFFF5F3EE),
            pillText = Color(0xFF746F67),
            segmentTrack = Color(0xFFF5F3EE),
            segmentSelected = Color.White,
            segmentText = Color(0xFF8B877F),
            segmentSelectedText = Color(0xFF34342F),
            segmentShadow = Color(0x10000000),
            home = Color(0xFFC7C7C7),
        )
    }
}
