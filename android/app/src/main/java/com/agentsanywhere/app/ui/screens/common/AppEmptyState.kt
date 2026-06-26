package com.agentsanywhere.app.ui.screens.common

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

@Composable
fun AppEmptyState(
    message: String,
    buttonLabel: String? = null,
    buttonIcon: ImageVector? = null,
    onButtonClick: (() -> Unit)? = null,
    contentOffsetY: Dp = 0.dp,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current

    Column(
        modifier = modifier
            .fillMaxSize()
            .offset(y = contentOffsetY)
            .padding(horizontal = 18.dp, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        EmptyStateIllustration()
        Spacer(Modifier.height(22.dp))
        Text(
            text = message,
            modifier = Modifier.widthIn(max = 294.dp),
            color = colors.inkSoft,
            fontSize = 16.sp,
            fontWeight = FontWeight.Medium,
            lineHeight = 21.5.sp,
            textAlign = TextAlign.Center,
        )
        if (buttonLabel != null && onButtonClick != null) {
            Spacer(Modifier.height(18.dp))
            Row(
                modifier = Modifier
                    .height(44.dp)
                    .shadow(8.dp, CircleShape, ambientColor = Color(0x22000000), spotColor = Color(0x22000000))
                    .clip(CircleShape)
                    .background(colors.primaryAction)
                    .noRippleClickable(onClick = onButtonClick)
                    .padding(horizontal = 18.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                if (buttonIcon != null) {
                    Icon(
                        imageVector = buttonIcon,
                        contentDescription = null,
                        tint = colors.onPrimaryAction,
                        modifier = Modifier.size(17.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    text = buttonLabel,
                    color = colors.onPrimaryAction,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

@Composable
private fun EmptyStateIllustration() {
    Image(
        painter = painterResource(R.drawable.ic_sessions_empty),
        contentDescription = null,
        modifier = Modifier
            .width(188.dp)
            .height(156.dp),
    )
}
