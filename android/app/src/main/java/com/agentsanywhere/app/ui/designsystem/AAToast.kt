package com.agentsanywhere.app.ui.designsystem

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.SnackbarData
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarVisuals
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun AAToastHost(
    hostState: SnackbarHostState,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier.fillMaxWidth(),
        contentAlignment = Alignment.TopCenter,
    ) {
        SnackbarHost(hostState = hostState) { data ->
            AAToast(data)
        }
    }
}

@Composable
private fun AAToast(data: SnackbarData) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val visuals = data.visuals as? AAToastVisuals
    val isError = visuals?.isError == true
    val container = when {
        isError && darkMode -> colors.errorSurface
        isError -> Color(0xFFFFF4F1)
        darkMode -> Color(0xFF242426)
        else -> Color.White
    }
    val border = when {
        isError && darkMode -> colors.errorBorder
        isError -> Color(0xFFFFD3CB)
        darkMode -> Color(0xFF303033)
        else -> Color(0xFFEDEDED)
    }
    val content = when {
        isError && darkMode -> colors.errorText
        isError -> Color(0xFFB42318)
        darkMode -> Color(0xFFEDEDEF)
        else -> Color(0xFF2A2A2A)
    }
    val actionColor = if (isError) content else Color(0xFF4CAF50)
    val successColor = Color(0xFF4CAF50)

    Row(
        modifier = Modifier
            .widthIn(max = 340.dp)
            .shadow(14.dp, RoundedCornerShape(18.dp), ambientColor = Color(0x22000000), spotColor = Color(0x22000000))
            .clip(RoundedCornerShape(18.dp))
            .background(container)
            .border(1.dp, border, RoundedCornerShape(18.dp))
            .padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (!isError) {
            Box(
                modifier = Modifier
                    .size(22.dp)
                    .clip(CircleShape)
                    .border(2.dp, successColor, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                CheckGlyph(color = successColor)
            }
        }
        Text(
            text = data.visuals.message,
            color = content,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 19.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        data.visuals.actionLabel?.let { label ->
            Text(
                text = label,
                color = actionColor,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .noRippleClickable { data.performAction() }
                    .padding(horizontal = 4.dp, vertical = 2.dp),
            )
        }
    }
}

data class AAToastVisuals(
    override val message: String,
    override val actionLabel: String? = null,
    val isError: Boolean = false,
    override val withDismissAction: Boolean = false,
    override val duration: SnackbarDuration = SnackbarDuration.Short,
) : SnackbarVisuals
