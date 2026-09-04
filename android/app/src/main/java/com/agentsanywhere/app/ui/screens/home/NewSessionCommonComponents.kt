package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.ui.designsystem.ForwardGlyph
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

@Composable
internal fun SmallPill(
    darkMode: Boolean,
    onClick: () -> Unit,
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = Modifier
            .height(30.dp)
            .clip(CircleShape)
            .background(if (darkMode) LocalAAColors.current.subtle else Color(0xFFFBFBFB))
            .border(1.dp, if (darkMode) Color(0xFF27272A) else Color(0xFFECECEC), CircleShape)
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        content = content,
    )
}

@Composable
internal fun CircleMiniButton(
    darkMode: Boolean,
    selected: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    val background = when {
        selected -> Color(0xFFEFFBF4)
        darkMode -> LocalAAColors.current.subtle
        else -> Color.White
    }
    val border = when {
        selected -> Color(0xFFBAE7C8)
        darkMode -> Color(0xFF27272A)
        else -> Color(0xFFE8E8E8)
    }
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(background)
            .border(1.dp, border, CircleShape)
            .noRippleClickable {
                if (enabled) onClick()
            },
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

@Composable
internal fun StartChatButton(
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val alpha = if (enabled) 1f else 0.45f
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(54.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(colors.primaryAction.copy(alpha = alpha))
            .noRippleClickable {
                if (enabled) onClick()
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(
            text = label,
            color = colors.onPrimaryAction,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 20.sp,
        )
        Spacer(Modifier.width(8.dp))
        ForwardGlyph(color = colors.onPrimaryAction)
    }
}
