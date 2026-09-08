/* Hallmark · component: bottom sheet · genre: modern-minimal · theme: native AA
 * Pre-emit critique: P4 H4 E4 S4 R5 V3
 * States: default, hover, focus, pressed, disabled, loading, error, selected success.
 */
package com.agentsanywhere.app.ui.designsystem

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.CircleAlert
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X

@Immutable
data class AABottomSheetColors(
    val container: Color,
    val content: Color,
    val secondaryContent: Color,
    val selectedContainer: Color,
    val divider: Color,
    val handle: Color,
    val scrim: Color,
    val error: Color,
    val shadow: Color,
)

object AABottomSheetDefaults {
    @Composable
    fun colors(): AABottomSheetColors {
        val colors = LocalAAColors.current
        return AABottomSheetColors(
            container = colors.raisedSurface,
            content = colors.ink,
            secondaryContent = colors.inkSoft.copy(alpha = 0.8f).compositeOver(colors.raisedSurface),
            selectedContainer = colors.subtle,
            divider = colors.ink.copy(alpha = 0.08f),
            handle = colors.ink.copy(alpha = 0.22f),
            scrim = Color.Black.copy(alpha = if (colors.isDark) 0.56f else 0.28f),
            error = colors.errorText,
            shadow = colors.appShadow,
        )
    }
}

/** Shared native sheet: one surface, header, dismissal policy and scrollable content area. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AABottomSheet(
    title: String,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    dismissEnabled: Boolean = true,
    onBack: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = AABottomSheetDefaults.colors()
    val canDismiss by rememberUpdatedState(dismissEnabled)
    val sheetState = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        confirmValueChange = { it != SheetValue.Hidden || canDismiss },
    )
    ModalBottomSheet(
        onDismissRequest = { if (canDismiss) onDismissRequest() },
        modifier = modifier,
        sheetState = sheetState,
        sheetMaxWidth = 560.dp,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = colors.container,
        contentColor = colors.content,
        tonalElevation = 0.dp,
        scrimColor = colors.scrim,
        dragHandle = null,
    ) {
        AABottomSheetContent(title, onDismissRequest, dismissEnabled, onBack, content = content)
    }
}

@Composable
internal fun AABottomSheetContent(
    title: String,
    onDismissRequest: () -> Unit,
    dismissEnabled: Boolean = true,
    onBack: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = AABottomSheetDefaults.colors()
    Column(
        Modifier.fillMaxWidth()
            .heightIn(max = LocalConfiguration.current.screenHeightDp.dp * 0.9f)
            .background(colors.container),
    ) {
        Box(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 8.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.size(width = 36.dp, height = 4.dp).clip(CircleShape).background(colors.handle))
        }
        Row(
            Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(start = if (onBack == null) 24.dp else 12.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onBack != null) IconButton(onClick = onBack, enabled = dismissEnabled) {
                Icon(Lucide.ChevronLeft, stringResource(R.string.common_back), tint = colors.content, modifier = Modifier.size(22.dp))
            }
            Text(
                title,
                modifier = Modifier.weight(1f).padding(vertical = 8.dp).semantics { heading() },
                color = colors.content,
                fontSize = 18.sp,
                lineHeight = 24.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            IconButton(onClick = onDismissRequest, enabled = dismissEnabled) {
                Icon(Lucide.X, stringResource(R.string.common_close),
                    tint = colors.secondaryContent.copy(alpha = if (dismissEnabled) 1f else 0.38f), modifier = Modifier.size(20.dp))
            }
        }
        Column(
            Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            content = content,
        )
    }
}

/** Pass selected for a choice row; leave it null for an action or navigation row. */
@Composable
fun AABottomSheetItem(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    supportingText: String? = null,
    selected: Boolean? = null,
    enabled: Boolean = true,
    loading: Boolean = false,
    danger: Boolean = false,
    errorMessage: String? = null,
    showChevron: Boolean = false,
    interactionSource: MutableInteractionSource = remember { MutableInteractionSource() },
) {
    val colors = AABottomSheetDefaults.colors()
    val pressed by interactionSource.collectIsPressedAsState()
    val hovered by interactionSource.collectIsHoveredAsState()
    val focused by interactionSource.collectIsFocusedAsState()
    val interactive = enabled && !loading
    val contentAlpha = if (enabled || loading) 1f else 0.4f
    val tint = (if (danger || errorMessage != null) colors.error else colors.content).copy(alpha = contentAlpha)
    val base = if (selected == true) colors.selectedContainer else Color.Transparent
    val background = when {
        interactive && pressed -> colors.content.copy(alpha = 0.1f).compositeOver(base)
        interactive && hovered -> colors.content.copy(alpha = 0.05f).compositeOver(base)
        else -> base
    }
    val interactionModifier = if (selected != null) Modifier.selectable(
        selected = selected, enabled = interactive, role = Role.RadioButton,
        interactionSource = interactionSource, indication = null, onClick = onClick,
    ) else Modifier.clickable(
        enabled = interactive, role = Role.Button,
        interactionSource = interactionSource, indication = null, onClick = onClick,
    )
    Row(
        modifier.fillMaxWidth().heightIn(min = 52.dp).clip(RoundedCornerShape(14.dp))
            .background(background)
            .border(1.dp, if (focused && interactive) colors.content.copy(alpha = 0.65f) else Color.Transparent, RoundedCornerShape(14.dp))
            .then(interactionModifier)
            .semantics {
                if (loading) progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
                if (errorMessage != null) error(errorMessage)
            }
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (icon != null) Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(text, color = tint, fontSize = 15.sp, lineHeight = 21.sp,
                fontWeight = if (selected == true) FontWeight.SemiBold else FontWeight.Medium,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            (errorMessage ?: supportingText)?.takeIf(String::isNotBlank)?.let { description ->
                Text(description, color = (if (errorMessage != null) colors.error else colors.secondaryContent).copy(alpha = contentAlpha),
                    fontSize = 12.sp, lineHeight = 17.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        when {
            loading -> CircularProgressIndicator(Modifier.size(20.dp), color = tint, strokeWidth = 2.dp)
            errorMessage != null -> Icon(Lucide.CircleAlert, null, tint = tint, modifier = Modifier.size(20.dp))
            selected == true -> Icon(Lucide.Check, null, tint = tint, modifier = Modifier.size(20.dp))
            showChevron -> Icon(Lucide.ChevronRight, null, tint = colors.secondaryContent, modifier = Modifier.size(20.dp))
            selected != null -> Spacer(Modifier.size(20.dp))
        }
    }
}
