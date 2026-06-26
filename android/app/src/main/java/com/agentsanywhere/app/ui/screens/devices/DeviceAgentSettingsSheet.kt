package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceDetailAgent
import com.agentsanywhere.app.feature.sessiondetail.RuntimeConfigField
import com.agentsanywhere.app.feature.sessiondetail.RuntimeSettingsState
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.screens.sessiondetail.localizedRuntimeOptionDescription
import com.agentsanywhere.app.ui.screens.sessiondetail.localizedRuntimeOptionLabel
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DeviceAgentSettingsSheet(
    device: AgentDevice,
    agent: DeviceDetailAgent,
    onDismiss: () -> Unit,
    onLoadSettings: suspend (String, String) -> Result<RuntimeSettingsState>,
    onPatchSettings: suspend (String, String, Map<String, Any?>) -> Result<RuntimeSettingsState>,
) {
    val colors = LocalAAColors.current
    val context = LocalContext.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val palette = agentSettingsPalette(darkMode)
    val bodyMaxHeight = (LocalConfiguration.current.screenHeightDp * 0.58f).dp
    val scope = rememberCoroutineScope()
    var state by remember(device.id, agent.runtime) {
        mutableStateOf(RuntimeSettingsState(isLoading = true))
    }
    var savingKey by remember(device.id, agent.runtime) { mutableStateOf<String?>(null) }
    var savingValue by remember(device.id, agent.runtime) { mutableStateOf<String?>(null) }
    var saveError by remember(device.id, agent.runtime) { mutableStateOf<String?>(null) }

    LaunchedEffect(device.id, agent.runtime) {
        state = RuntimeSettingsState(isLoading = true)
        saveError = null
        onLoadSettings(device.id, agent.runtime)
            .onSuccess { state = it }
            .onFailure { error ->
                state = RuntimeSettingsState(
                    isLoading = false,
                    errorMessage = error.message ?: context.getString(R.string.agent_settings_load_failed),
                )
            }
    }

    fun patch(key: String, value: String?) {
        if (savingKey != null || key in hiddenMobileAgentSettingKeys) return
        val currentSchema = state.schema
        savingKey = key
        savingValue = value
        saveError = null
        state = state.copy(savingKey = key)
        scope.launch {
            onPatchSettings(device.id, agent.runtime, mapOf(key to value))
                .onSuccess { next ->
                    state = next.copy(schema = currentSchema ?: next.schema, savingKey = null)
                }
                .onFailure { error ->
                    saveError = error.message ?: context.getString(R.string.agent_settings_save_failed)
                    state = state.copy(savingKey = null)
                }
            savingKey = null
            savingValue = null
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = palette.sheet,
        contentColor = palette.title,
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
            AgentSettingsHandle(palette.handle)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.agent_settings_title),
                        color = palette.title,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.ExtraBold,
                        lineHeight = 24.sp,
                        maxLines = 1,
                    )
                    Text(
                        text = agent.label,
                        color = palette.secondaryText,
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
            when {
                state.isLoading -> AgentSettingsLoading(palette)
                state.errorMessage != null && state.schema == null -> {
                    AgentSettingsMessage(state.errorMessage.orEmpty(), palette)
                }
                else -> {
                    AgentSettingsBody(
                        state = state,
                        palette = palette,
                        savingKey = savingKey,
                        savingValue = savingValue,
                        saveError = saveError,
                        modifier = Modifier.heightIn(max = bodyMaxHeight),
                        onPatch = ::patch,
                    )
                    SheetTextButton(
                        label = if (savingKey == null) stringResource(R.string.common_done) else stringResource(R.string.common_saving),
                        enabled = savingKey == null,
                        primary = true,
                        modifier = Modifier.fillMaxWidth(),
                        onClick = onDismiss,
                    )
                }
            }
        }
    }
}

@Composable
private fun AgentSettingsBody(
    state: RuntimeSettingsState,
    palette: AgentSettingsPalette,
    savingKey: String?,
    savingValue: String?,
    saveError: String?,
    modifier: Modifier = Modifier,
    onPatch: (String, String?) -> Unit,
) {
    val permissionField = state.mobileAgentField("permissionMode")
    val modelField = state.mobileAgentField("model")
    val effortField = state.filteredEffortField()
    val fieldsCount = listOfNotNull(permissionField, modelField, effortField).size

    if (fieldsCount == 0) {
        AgentSettingsMessage(stringResource(R.string.agent_settings_none), palette)
    } else {
        Column(
            modifier = modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            permissionField?.let { field ->
                AgentSettingsSectionLabel(stringResource(R.string.agent_settings_default_permission_mode), palette)
                AgentSettingsOptionList(
                    state = state,
                    field = field,
                    savingKey = savingKey,
                    savingValue = savingValue,
                    palette = palette,
                    onPatch = onPatch,
                )
            }
            if (permissionField != null && (modelField != null || effortField != null)) {
                AgentSettingsDivider(palette.divider)
            }
            modelField?.let { field ->
                AgentSettingsSectionLabel(stringResource(R.string.agent_settings_default_model), palette)
                AgentSettingsOptionList(
                    state = state,
                    field = field,
                    savingKey = savingKey,
                    savingValue = savingValue,
                    palette = palette,
                    onPatch = onPatch,
                )
            }
            if (modelField != null && effortField != null) AgentSettingsDivider(palette.divider)
            effortField?.let { field ->
                AgentSettingsSectionLabel(stringResource(R.string.agent_settings_default_effort), palette)
                AgentSettingsSegments(
                    field = field,
                    selected = state.value(field.key, field),
                    savingValue = if (savingKey == field.key) savingValue else null,
                    enabled = savingKey == null,
                    palette = palette,
                    onPatch = onPatch,
                )
            }
            saveError?.let { AgentSettingsError(it, palette) }
        }
    }
}

@Composable
private fun AgentSettingsOptionList(
    state: RuntimeSettingsState,
    field: RuntimeConfigField,
    savingKey: String?,
    savingValue: String?,
    palette: AgentSettingsPalette,
    onPatch: (String, String?) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        field.options.forEach { option ->
            val selected = state.value(field.key, field) == option.value
            val busy = savingKey == field.key && savingValue == option.value
            AgentSettingsOptionRow(
                title = localizedRuntimeOptionLabel(field, option),
                subtitle = localizedRuntimeOptionDescription(field, option),
                selected = selected,
                busy = busy,
                enabled = savingKey == null || selected || busy,
                palette = palette,
                onClick = { onPatch(field.key, option.value) },
            )
        }
    }
}

@Composable
private fun AgentSettingsOptionRow(
    title: String,
    subtitle: String?,
    selected: Boolean,
    busy: Boolean,
    enabled: Boolean,
    palette: AgentSettingsPalette,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(50.dp)
            .clip(RoundedCornerShape(13.dp))
            .background(if (selected) palette.selectedRow else Color.Transparent)
            .noRippleClickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                text = title,
                color = if (selected) palette.selectedText else palette.primaryText,
                fontSize = 14.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            subtitle?.takeIf { it.isNotBlank() }?.let {
                Text(
                    text = it,
                    color = if (selected) palette.selectedSubtitle else palette.secondaryText,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        when {
            busy -> CircularProgressIndicator(
                color = palette.check,
                strokeWidth = 1.8.dp,
                modifier = Modifier.size(16.dp),
            )
            selected -> CheckGlyph(palette.check)
            else -> CircleGlyph(palette.circle)
        }
    }
}

@Composable
private fun AgentSettingsSegments(
    field: RuntimeConfigField,
    selected: String,
    savingValue: String?,
    enabled: Boolean,
    palette: AgentSettingsPalette,
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
            val saving = savingValue == option.value
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .shadow(
                        if (on) 3.dp else 0.dp,
                        RoundedCornerShape(12.dp),
                        ambientColor = palette.segmentShadow,
                        spotColor = palette.segmentShadow,
                    )
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (on) palette.segmentSelected else Color.Transparent)
                    .noRippleClickable(enabled = enabled || on) { onPatch(field.key, option.value) },
                contentAlignment = Alignment.Center,
            ) {
                if (saving) {
                    CircularProgressIndicator(
                        color = palette.segmentSelectedText,
                        strokeWidth = 1.7.dp,
                        modifier = Modifier.size(15.dp),
                    )
                } else {
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
}

@Composable
private fun AgentSettingsLoading(palette: AgentSettingsPalette) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(220.dp),
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
private fun AgentSettingsMessage(message: String, palette: AgentSettingsPalette) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(180.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = message,
            color = palette.secondaryText,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            lineHeight = 18.sp,
        )
    }
}

@Composable
private fun AgentSettingsError(message: String, palette: AgentSettingsPalette) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(44.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(palette.errorSurface)
            .border(1.dp, palette.errorBorder, RoundedCornerShape(10.dp))
            .padding(horizontal = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(palette.errorText),
        )
        Text(
            text = message,
            modifier = Modifier.weight(1f),
            color = palette.errorText,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun AgentSettingsHandle(color: Color) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(12.dp),
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
private fun AgentSettingsSectionLabel(text: String, palette: AgentSettingsPalette) {
    Text(
        text = text,
        color = palette.section,
        fontSize = 11.2.sp,
        fontWeight = FontWeight.ExtraBold,
        maxLines = 1,
    )
}

@Composable
private fun AgentSettingsDivider(color: Color) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(color),
    )
}

@Composable
private fun CheckGlyph(color: Color) = Canvas(modifier = Modifier.size(18.dp)) {
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

private fun RuntimeSettingsState.mobileAgentField(key: String): RuntimeConfigField? {
    return schema?.fields
        ?.filter { !it.hidden && it.type == "enum" && visible(it) && it.key !in hiddenMobileAgentSettingKeys }
        ?.firstOrNull { it.key == key && it.options.isNotEmpty() }
}

private fun RuntimeSettingsState.filteredEffortField(): RuntimeConfigField? {
    val field = mobileAgentField("effort") ?: return null
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

private data class AgentSettingsPalette(
    val sheet: Color,
    val handle: Color,
    val title: Color,
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
    val errorSurface: Color,
    val errorBorder: Color,
    val errorText: Color,
)

private fun agentSettingsPalette(darkMode: Boolean): AgentSettingsPalette {
    return if (darkMode) {
        AgentSettingsPalette(
            sheet = Color(0xFF18181B),
            handle = Color(0xFF3F3F46),
            title = Color(0xFFFAFAFA),
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
            errorSurface = Color(0xFF2A1418),
            errorBorder = Color(0xFF4A1C24),
            errorText = Color(0xFFF87171),
        )
    } else {
        AgentSettingsPalette(
            sheet = Color(0xFFFFFEFC),
            handle = Color(0xFFD5D2CC),
            title = Color(0xFF242520),
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
            errorSurface = Color(0xFFFFF5F5),
            errorBorder = Color(0xFFF0D7D7),
            errorText = Color(0xFFB94848),
        )
    }
}

private val hiddenMobileAgentSettingKeys = setOf("runMode")
