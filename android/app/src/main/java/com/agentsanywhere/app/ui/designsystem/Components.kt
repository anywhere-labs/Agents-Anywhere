package com.agentsanywhere.app.ui.designsystem

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.navigation.AppTab

@Composable
fun PrimaryButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = LocalAAColors.current

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(62.dp)
            .clip(RoundedCornerShape(17.dp))
            .background(colors.primaryAction)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = colors.onPrimaryAction,
            fontSize = 15.3.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 18.sp,
        )
    }
}

@Composable
fun SecondaryButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(17.dp)

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(62.dp)
            .clip(shape)
            .background(colors.raisedSurface)
            .border(1.2.dp, colors.border, shape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = colors.onRaisedSurface,
            fontSize = 15.3.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 18.sp,
        )
    }
}

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
        BackGlyph(color = colors.onRaisedSurface)
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
            painter = painterResource(R.drawable.ic_error_alert),
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
fun RoundIconButton(onClick: () -> Unit, content: @Composable () -> Unit) {
    val colors = LocalAAColors.current

    Box(
        modifier = Modifier
            .size(42.dp)
            .clip(CircleShape)
            .background(colors.raisedSurface)
            .border(1.dp, colors.border, CircleShape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

@Composable
fun FloatingPlus(modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    val iconRes = if (colors.canvas == Color(0xFF09090B)) {
        R.drawable.ic_new_session_floating_light
    } else {
        R.drawable.ic_new_session_floating_dark
    }

    Box(
        modifier = modifier
            .size(94.dp)
            .clip(CircleShape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painterResource(iconRes),
            contentDescription = "New session",
            modifier = Modifier.size(94.dp),
            contentScale = ContentScale.Fit,
        )
    }
}

@Composable
fun BrandMark() {
    Box(
        modifier = Modifier
            .size(58.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(AAColor.Ink),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.size(32.dp)) {
            drawCircle(Color.White, radius = size.minDimension * 0.16f, center = Offset(size.width * 0.28f, size.height * 0.28f))
            drawCircle(Color.White, radius = size.minDimension * 0.16f, center = Offset(size.width * 0.72f, size.height * 0.28f))
            drawCircle(Color.White, radius = size.minDimension * 0.16f, center = Offset(size.width * 0.50f, size.height * 0.72f))
            drawLine(Color.White, Offset(size.width * 0.28f, size.height * 0.28f), Offset(size.width * 0.72f, size.height * 0.28f), strokeWidth = 3.5f, cap = StrokeCap.Round)
            drawLine(Color.White, Offset(size.width * 0.28f, size.height * 0.28f), Offset(size.width * 0.50f, size.height * 0.72f), strokeWidth = 3.5f, cap = StrokeCap.Round)
            drawLine(Color.White, Offset(size.width * 0.72f, size.height * 0.28f), Offset(size.width * 0.50f, size.height * 0.72f), strokeWidth = 3.5f, cap = StrokeCap.Round)
        }
    }
}

@Composable
fun HomeIndicator() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .width(114.dp)
                .height(4.dp)
                .clip(CircleShape)
                .background(AAColor.Ink.copy(alpha = 0.78f)),
        )
    }
}

@Composable
fun FilterPill(label: String, selected: Boolean = false) {
    Box(
        modifier = Modifier
            .height(36.dp)
            .clip(CircleShape)
            .background(if (selected) AAColor.Ink else Color.White)
            .border(1.dp, if (selected) AAColor.Ink else AAColor.Border, CircleShape)
            .padding(horizontal = 15.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = if (selected) Color.White else AAColor.Ink,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
fun MetaPill(label: String) {
    Box(
        modifier = Modifier
            .height(24.dp)
            .clip(CircleShape)
            .background(AAColor.Subtle)
            .padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = AAColor.Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun Chip(label: String) {
    Box(
        modifier = Modifier
            .height(28.dp)
            .clip(CircleShape)
            .background(AAColor.Subtle)
            .padding(horizontal = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = AAColor.Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun DonePill() {
    Box(
        modifier = Modifier
            .height(24.dp)
            .clip(CircleShape)
            .background(AAColor.Done)
            .padding(horizontal = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text("Done", color = AAColor.Ink, fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun BottomNavigationBar(
    selected: AppTab,
    navigate: (AppDestination) -> Unit,
) {
    val colors = LocalAAColors.current
    val darkTheme = colors.canvas == Color(0xFF09090B)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(62.dp)
            .windowInsetsPadding(WindowInsets.navigationBars)
            .padding(start = 22.dp, top = 0.dp, end = 22.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BottomNavItem(
            label = "Sessions",
            selected = selected == AppTab.Sessions,
            darkTheme = darkTheme,
            selectedLightIcon = R.drawable.ic_sessions_black,
            selectedDarkIcon = R.drawable.ic_sessions_white,
            unselectedIcon = R.drawable.ic_sessions_gray,
            onClick = { navigate(AppTab.Sessions.destination) },
        )
        BottomNavItem(
            label = "Devices",
            selected = selected == AppTab.Devices,
            darkTheme = darkTheme,
            selectedLightIcon = R.drawable.ic_devices_black,
            selectedDarkIcon = R.drawable.ic_devices_white,
            unselectedIcon = R.drawable.ic_devices_gray,
            iconSize = 29.dp,
            onClick = { navigate(AppTab.Devices.destination) },
        )
        BottomNavItem(
            label = "Profile",
            selected = selected == AppTab.Profile,
            darkTheme = darkTheme,
            selectedLightIcon = R.drawable.ic_profile_black,
            selectedDarkIcon = R.drawable.ic_profile_white,
            unselectedIcon = R.drawable.ic_profile_gray,
            onClick = { navigate(AppTab.Profile.destination) },
        )
    }
}

@Composable
private fun BottomNavItem(
    label: String,
    selected: Boolean,
    darkTheme: Boolean,
    selectedLightIcon: Int,
    selectedDarkIcon: Int,
    unselectedIcon: Int,
    iconSize: Dp = 32.dp,
    onClick: () -> Unit,
) {
    val iconRes = when {
        selected && darkTheme -> selectedDarkIcon
        selected -> selectedLightIcon
        else -> unselectedIcon
    }

    Column(
        modifier = Modifier
            .width(84.dp)
            .height(44.dp)
            .clip(CircleShape)
            .noRippleClickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Bottom,
    ) {
        Image(
            painter = painterResource(iconRes),
            contentDescription = label,
            modifier = Modifier
                .padding(bottom = 3.dp)
                .size(iconSize),
            contentScale = ContentScale.Fit,
        )
    }
}

@Composable
fun PlaceholderScreen(
    title: String,
    subtitle: String,
    primaryActionLabel: String? = null,
    onPrimaryAction: (() -> Unit)? = null,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            title,
            color = AAColor.Ink,
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            subtitle,
            color = AAColor.Muted,
            fontSize = 15.sp,
            lineHeight = 21.sp,
            textAlign = TextAlign.Center,
        )
        if (primaryActionLabel != null && onPrimaryAction != null) {
            Spacer(Modifier.height(22.dp))
            PrimaryButton(primaryActionLabel, onClick = onPrimaryAction)
        }
    }
}

@Composable
fun TextLink(label: String, onClick: () -> Unit) {
    Text(
        modifier = Modifier
            .clip(CircleShape)
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        text = label,
        color = LocalAAColors.current.ink,
        fontWeight = FontWeight.SemiBold,
    )
}
