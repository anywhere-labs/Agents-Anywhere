package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Lucide

@Composable
internal fun SessionDetailHeader(
    title: String,
    darkMode: Boolean,
    onRightClick: () -> Unit,
    modifier: Modifier = Modifier,
    sidebarCollapsed: Boolean = false,
    onToggleSidebar: (() -> Unit)? = null,
) {
    val colors = LocalAAColors.current
    val surface = if (darkMode) colors.raisedSurface else Color(0xF2FFFFFF)
    val border = if (darkMode) colors.border else Color(0xFFE8E5DE)
    val text = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF2F302D)

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(58.dp)
            .padding(horizontal = 18.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            modifier = Modifier
                .width(224.dp)
                .height(42.dp)
                .shadow(18.dp, CircleShape, ambientColor = Color(0x0A000000), spotColor = Color(0x0A000000))
                .clip(CircleShape)
                .background(surface)
                .border(1.dp, border, CircleShape)
                .padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = title,
                color = text,
                fontSize = 14.5.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (onToggleSidebar != null) {
            HeaderIconButton(
                imageVector = if (sidebarCollapsed) Lucide.ChevronRight else Lucide.ChevronLeft,
                contentDescription = stringResource(
                    if (sidebarCollapsed) R.string.workspace_sidebar_expand else R.string.workspace_sidebar_collapse,
                ),
                darkMode = darkMode,
                onClick = onToggleSidebar,
                modifier = Modifier.align(Alignment.CenterStart),
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
            modifier = Modifier.align(Alignment.CenterEnd),
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
internal fun HeaderIconButton(
    imageVector: androidx.compose.ui.graphics.vector.ImageVector,
    contentDescription: String,
    darkMode: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val surface = if (darkMode) colors.raisedSurface else Color(0xF2FFFFFF)
    val border = if (darkMode) colors.border else Color(0xFFE8E5DE)
    val tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF2D2E2B)
    Box(
        modifier = modifier
            .size(44.dp)
            .shadow(14.dp, CircleShape, ambientColor = Color(0x0A000000), spotColor = Color(0x0A000000))
            .clip(CircleShape)
            .background(surface)
            .border(1.dp, border, CircleShape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = imageVector,
            contentDescription = contentDescription,
            tint = tint,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun HeaderImageButton(
    resId: Int,
    darkMode: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val surface = if (darkMode) colors.raisedSurface else Color(0xF2FFFFFF)
    val border = if (darkMode) colors.border else Color(0xFFE8E5DE)
    Box(
        modifier = modifier
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
