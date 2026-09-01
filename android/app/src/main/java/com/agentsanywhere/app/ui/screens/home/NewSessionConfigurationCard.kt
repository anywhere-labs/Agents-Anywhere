/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4 */
/* Hallmark · macrostructure: anchored configuration stack · modern-minimal · neutral palette */
package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.ui.designsystem.DownGlyph
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide

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
    val active = field.enabled && field.options.any(NewSessionConfigurationOption::enabled)
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
        NewSessionConfigurationMenu(
            expanded = expanded && active,
            options = field.options,
            selectedId = field.selectedId,
            onDismiss = onDismiss,
            onSelect = onSelect,
        )
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
    val colors = LocalAAColors.current
    val surface = colors.dialogSurface
    val shadow = colors.appShadow
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        offset = DpOffset(x = 10.dp, y = 4.dp),
        shape = RoundedCornerShape(18.dp),
        containerColor = surface,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
        modifier = Modifier
            .width(286.dp)
            .heightIn(max = 328.dp)
            .shadow(28.dp, RoundedCornerShape(18.dp), ambientColor = shadow, spotColor = shadow)
            .clip(RoundedCornerShape(18.dp))
            .background(surface),
    ) {
        Column(modifier = Modifier.padding(vertical = 6.dp)) {
            options.forEach { option ->
                val selected = option.id == selectedId
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .then(
                            if (option.enabled) {
                                Modifier.noRippleClickable {
                                    onSelect(option.id)
                                    onDismiss()
                                }
                            } else {
                                Modifier
                            },
                        )
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = option.label,
                            color = colors.ink.copy(alpha = if (option.enabled) 1f else 0.42f),
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        option.description?.takeIf(String::isNotBlank)?.let { description ->
                            Text(
                                text = description,
                                color = colors.inkSoft.copy(alpha = if (option.enabled) 0.72f else 0.42f),
                                fontSize = 11.sp,
                                lineHeight = 14.sp,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    if (selected) {
                        Icon(
                            imageVector = Lucide.Check,
                            contentDescription = null,
                            tint = colors.ink,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        }
    }
}
