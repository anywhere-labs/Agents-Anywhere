package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

@Composable
internal fun SessionDetailHeader(
    title: String,
    darkMode: Boolean,
    onLeftClick: () -> Unit,
    onRightClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val surface = if (darkMode) Color(0xF218181B) else Color(0xF2FFFFFF)
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE8E5DE)
    val text = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF2F302D)

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(58.dp)
            .padding(horizontal = 18.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HeaderImageButton(
            resId = if (darkMode) {
                R.drawable.ic_session_runtime_settings_dark
            } else {
                R.drawable.ic_session_runtime_settings_light
            },
            darkMode = darkMode,
            onClick = onLeftClick,
        )
        Row(
            modifier = Modifier
                .width(224.dp)
                .height(42.dp)
                .shadow(18.dp, CircleShape, ambientColor = Color(0x0A000000), spotColor = Color(0x0A000000))
                .clip(CircleShape)
                .background(surface)
                .border(1.dp, border, CircleShape)
                .padding(horizontal = 18.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = title,
                color = text,
                fontSize = 15.5.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        HeaderImageButton(
            resId = if (darkMode) {
                R.drawable.ic_session_agent_button_dark
            } else {
                R.drawable.ic_session_agent_button_light
            },
            darkMode = darkMode,
            onClick = onRightClick,
        )
    }
}

@Composable
internal fun HeaderVeil(
    darkMode: Boolean,
    modifier: Modifier = Modifier,
) {
    val base = if (darkMode) Color(0xFF09090B) else Color(0xFFFDFCFB)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(88.dp)
            .background(
                Brush.verticalGradient(
                    0f to base.copy(alpha = 0.90f),
                    0.46f to base.copy(alpha = 0.72f),
                    1f to base.copy(alpha = 0f),
                ),
            ),
    )
}

@Composable
private fun HeaderImageButton(
    resId: Int,
    darkMode: Boolean,
    onClick: () -> Unit,
) {
    val surface = if (darkMode) Color(0xF218181B) else Color(0xF2FFFFFF)
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE8E5DE)
    Box(
        modifier = Modifier
            .size(44.dp)
            .shadow(14.dp, CircleShape, ambientColor = Color(0x0A000000), spotColor = Color(0x0A000000))
            .clip(CircleShape)
            .background(surface)
            .border(1.dp, border, CircleShape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painterResource(resId),
            contentDescription = null,
            modifier = Modifier.size(20.dp),
            contentScale = ContentScale.Fit,
        )
    }
}
