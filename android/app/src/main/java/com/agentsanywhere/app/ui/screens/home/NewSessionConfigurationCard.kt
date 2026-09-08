package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.ui.designsystem.AADropdownMenu
import com.agentsanywhere.app.ui.designsystem.AADropdownMenuItem
import com.agentsanywhere.app.ui.designsystem.DownGlyph
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.valentinilk.shimmer.shimmer

internal enum class NewSessionConfigurationKey {
    Device,
    Agent,
    Model,
    Effort,
    Permission,
}

internal data class NewSessionConfigurationOption(
    val id: String,
    val label: String,
    val description: String? = null,
    val enabled: Boolean = true,
)

internal data class NewSessionConfigurationField(
    val key: NewSessionConfigurationKey,
    val label: String,
    val value: String,
    val selectedId: String?,
    val options: List<NewSessionConfigurationOption>,
    val enabled: Boolean,
    val loading: Boolean = false,
)

@Composable
internal fun NewSessionConfigurationCard(
    fields: List<NewSessionConfigurationField>,
    expanded: NewSessionConfigurationKey?,
    onToggle: (NewSessionConfigurationKey) -> Unit,
    onDismiss: () -> Unit,
    onSelect: (NewSessionConfigurationKey, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (fields.isEmpty()) return
    val colors = LocalAAColors.current
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(colors.raisedSurface),
    ) {
        fields.forEachIndexed { index, field ->
            NewSessionConfigurationRow(
                field = field,
                expanded = expanded == field.key,
                onToggle = { onToggle(field.key) },
                onDismiss = onDismiss,
                onSelect = { onSelect(field.key, it) },
            )
            if (index < fields.lastIndex) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 16.dp, end = 14.dp)
                        .height(1.dp)
                        .background(colors.ink.copy(alpha = if (colors.isDark) 0.09f else 0.07f)),
                )
            }
        }
    }
}

@Composable
private fun NewSessionConfigurationRow(
    field: NewSessionConfigurationField,
    expanded: Boolean,
    onToggle: () -> Unit,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val active = !field.loading && field.enabled && field.options.any(NewSessionConfigurationOption::enabled)
    Box(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
                .then(if (active) Modifier.noRippleClickable(onClick = onToggle) else Modifier)
                .padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = field.label,
                color = colors.inkSoft.copy(alpha = 0.72f),
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
            )
            if (field.loading) {
                Box(
                    modifier = Modifier.weight(1f),
                    contentAlignment = Alignment.CenterEnd,
                ) {
                    Box(
                        modifier = Modifier
                            .width(96.dp)
                            .height(16.dp)
                            .shimmer()
                            .clip(RoundedCornerShape(6.dp))
                            .background(colors.ink.copy(alpha = if (colors.isDark) 0.12f else 0.08f)),
                    )
                }
                Spacer(Modifier.width(12.dp))
            } else {
                Text(
                    text = field.value,
                    color = colors.ink.copy(alpha = if (active) 1f else 0.5f),
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.End,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                DownGlyph(
                    color = colors.muted.copy(alpha = if (active) 1f else 0.38f),
                )
            }
        }
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .width(1.dp)
                .height(48.dp),
        ) {
            NewSessionConfigurationMenu(
                expanded = expanded && active,
                options = field.options,
                selectedId = field.selectedId,
                onDismiss = onDismiss,
                onSelect = onSelect,
            )
        }
    }
}

@Composable
private fun NewSessionConfigurationMenu(
    expanded: Boolean,
    options: List<NewSessionConfigurationOption>,
    selectedId: String?,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit,
) {
    AADropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
    ) {
        options.forEach { option ->
            AADropdownMenuItem(
                text = option.label,
                selected = option.id == selectedId,
                enabled = option.enabled,
                supportingText = option.description,
                onClick = { onSelect(option.id); onDismiss() },
            )
        }
    }
}
