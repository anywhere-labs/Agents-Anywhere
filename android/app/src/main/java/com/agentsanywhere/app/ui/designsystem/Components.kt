package com.agentsanywhere.app.ui.designsystem

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.ArrowLeft
import com.composables.icons.lucide.CircleAlert
import com.composables.icons.lucide.Lucide

@Composable
fun BackPill(label: String, onClick: () -> Unit) {
    val colors = LocalAAColors.current

    Row(
        modifier = Modifier
            .height(36.dp)
            .clip(CircleShape)
            .background(colors.raisedSurface)
            .border(1.2.dp, colors.border, CircleShape)
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Icon(
            imageVector = Lucide.ArrowLeft,
            contentDescription = null,
            tint = colors.onRaisedSurface,
            modifier = Modifier.size(16.dp),
        )
        Text(label, color = colors.onRaisedSurface, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun AuthErrorNotice(message: String, modifier: Modifier = Modifier) {
    val colors = LocalAAColors.current

    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(colors.errorSurface)
            .border(1.2.dp, colors.errorBorder, RoundedCornerShape(14.dp))
            .padding(horizontal = 14.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            imageVector = Lucide.CircleAlert,
            contentDescription = null,
            modifier = Modifier.size(20.dp),
            tint = colors.errorIcon,
        )
        Text(
            text = message,
            modifier = Modifier.weight(1f),
            color = colors.errorText,
            fontSize = 13.5.sp,
            lineHeight = 17.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
fun SectionLabel(
    label: String,
    expanded: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val haptic = LocalHapticFeedback.current

    Row(
        modifier = Modifier
            .height(24.dp)
            .noRippleClickable {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            }
            .padding(start = 0.dp, end = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = label,
            color = colors.faint,
            fontSize = 15.1.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 18.sp,
            letterSpacing = 0.sp,
        )
        SectionChevronDown(
            color = colors.faint.copy(alpha = 0.95f),
            modifier = Modifier.size(width = 8.dp, height = 6.dp),
            expanded = expanded,
        )
    }
}

@Composable
private fun SectionChevronDown(
    color: Color,
    modifier: Modifier = Modifier,
    strokeWidthDp: Float = 1.5f,
    expanded: Boolean = true,
) {
    Canvas(modifier = modifier) {
        if (expanded) {
            drawLine(
                color = color,
                start = Offset(size.width * 0.12f, size.height * 0.22f),
                end = Offset(size.width * 0.50f, size.height * 0.78f),
                strokeWidth = strokeWidthDp.dp.toPx(),
                cap = StrokeCap.Round,
            )
            drawLine(
                color = color,
                start = Offset(size.width * 0.50f, size.height * 0.78f),
                end = Offset(size.width * 0.88f, size.height * 0.22f),
                strokeWidth = strokeWidthDp.dp.toPx(),
                cap = StrokeCap.Round,
            )
        } else {
            drawLine(
                color = color,
                start = Offset(size.width * 0.22f, size.height * 0.12f),
                end = Offset(size.width * 0.78f, size.height * 0.50f),
                strokeWidth = strokeWidthDp.dp.toPx(),
                cap = StrokeCap.Round,
            )
            drawLine(
                color = color,
                start = Offset(size.width * 0.78f, size.height * 0.50f),
                end = Offset(size.width * 0.22f, size.height * 0.88f),
                strokeWidth = strokeWidthDp.dp.toPx(),
                cap = StrokeCap.Round,
            )
        }
    }
}
