package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

@Composable
internal fun SheetTextButton(
    label: String,
    enabled: Boolean,
    primary: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val surface = when {
        primary && darkMode -> Color(0xFFE4E4E7)
        primary -> Color(0xFF181816)
        darkMode -> Color(0xFF111113)
        else -> Color(0xFFF7F7F5)
    }
    val content = when {
        primary && darkMode -> Color(0xFF181816)
        primary -> Color.White
        else -> colors.ink
    }

    Box(
        modifier = modifier
            .height(44.dp)
            .widthIn(min = 104.dp)
            .clip(CircleShape)
            .background(surface)
            .border(1.dp, if (primary) Color.Transparent else colors.border, CircleShape)
            .noRippleClickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 20.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = content.copy(alpha = if (enabled) 1f else 0.5f),
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

@Composable
internal fun RoundIconAction(
    icon: ImageVector,
    contentDescription: String,
    danger: Boolean,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val surface = when {
        danger && darkMode -> Color(0xFF2A1418)
        danger -> Color(0xFFFFF5F5)
        darkMode -> Color(0xFF18181B)
        else -> Color.White
    }
    val border = when {
        danger && darkMode -> Color(0xFF4A1C24)
        danger -> Color(0xFFF0D7D7)
        else -> colors.border
    }
    val tint = when {
        danger && darkMode -> Color(0xFFF87171)
        danger -> Color(0xFFB94848)
        else -> colors.ink
    }

    Box(
        modifier = Modifier
            .size(38.dp)
            .clip(CircleShape)
            .background(surface)
            .border(1.dp, border, CircleShape)
            .noRippleClickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = tint.copy(alpha = if (enabled) 1f else 0.45f),
            modifier = Modifier.size(16.dp),
        )
    }
}
