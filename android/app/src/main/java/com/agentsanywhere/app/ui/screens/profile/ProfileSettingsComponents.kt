package com.agentsanywhere.app.ui.screens.profile

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.AAAppearanceMode
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereColors
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.screens.home.HomeSidebarViewMode
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Circle
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.LogOut
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.List as ListIcon
import com.composables.icons.lucide.Moon
import com.composables.icons.lucide.Sun

@Composable
internal fun ProfileHeader(
    title: String? = null,
    onClose: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val iconSurface = colors.raisedSurface
    val iconBorder = if (darkMode) colors.border else Color(0xFFE7E6E2)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(64.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(iconSurface)
                .border(1.dp, iconBorder, CircleShape)
                .noRippleClickable(onClick = onClose),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Lucide.ChevronLeft, contentDescription = stringResource(R.string.common_back), tint = colors.ink, modifier = Modifier.size(22.dp))
        }
        Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.Center) {
            Text(
                text = title ?: stringResource(R.string.profile_settings),
                color = colors.ink,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 22.sp,
                maxLines = 1,
            )
        }
        Spacer(modifier = Modifier.width(40.dp))
    }
}

@Composable
internal fun ProfileCard(content: @Composable ColumnScope.() -> Unit) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(15.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(profileCardBackground(colors))
            .border(0.8.dp, profileCardBorder(colors), shape),
        content = content,
    )
}

@Composable
internal fun ProfileRow(
    icon: ImageVector,
    title: String,
    subtitle: String? = null,
    trailing: String? = null,
    trailingTag: String? = null,
    trailingIcon: ImageVector? = null,
    enabled: Boolean = true,
    showChevron: Boolean = true,
    onClick: (() -> Unit)? = null,
) {
    val colors = LocalAAColors.current
    val alpha = if (enabled) 1f else 0.5f
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(if (subtitle == null) 56.dp else 62.dp)
            .then(if (onClick != null) Modifier.noRippleClickable(enabled = enabled, onClick = onClick) else Modifier)
            .padding(start = 12.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        SettingIcon(icon = icon, alpha = alpha)
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                text = title,
                color = colors.ink.copy(alpha = alpha),
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 20.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) {
                Text(
                    text = subtitle,
                    color = colors.muted.copy(alpha = alpha),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 15.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (trailing != null) {
            Text(
                text = trailing,
                color = colors.muted.copy(alpha = alpha),
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (trailingTag != null) {
            Text(
                text = trailingTag,
                modifier = Modifier
                    .clip(CircleShape)
                    .background(colors.errorSurface.copy(alpha = alpha))
                    .border(1.dp, colors.errorBorder.copy(alpha = alpha), CircleShape)
                    .padding(horizontal = 10.dp, vertical = 4.dp),
                color = colors.errorText.copy(alpha = alpha),
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 14.sp,
                maxLines = 1,
            )
        }
        if (trailingIcon != null) {
            Icon(
                trailingIcon,
                contentDescription = null,
                tint = colors.faint.copy(alpha = alpha),
                modifier = Modifier.size(20.dp),
            )
        }
        if (showChevron) {
            Icon(Lucide.ChevronRight, contentDescription = null, tint = colors.faint.copy(alpha = alpha), modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
internal fun AppearancePopup(
    open: Boolean,
    selectedMode: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalAAColors.current
    if (!open) return
    Popup(
        alignment = Alignment.TopEnd,
        offset = androidx.compose.ui.unit.IntOffset(x = 0, y = 48),
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
    ) {
        AnimatedVisibility(
            visible = true,
            enter = fadeIn() + slideInVertically(initialOffsetY = { -10 }),
            exit = fadeOut() + slideOutVertically(targetOffsetY = { -10 }),
        ) {
            Column(
                modifier = Modifier
                    .width(204.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(colors.raisedSurface)
                    .border(1.dp, colors.border, RoundedCornerShape(14.dp)),
            ) {
                AppearanceMenuRow(
                    title = stringResource(R.string.profile_follow_system),
                    icon = Lucide.Circle,
                    selected = selectedMode == AAAppearanceMode.System,
                    onClick = { onSelect(AAAppearanceMode.System) },
                )
                ProfileDivider(start = 0.dp, end = 0.dp)
                AppearanceMenuRow(
                    title = stringResource(R.string.profile_light),
                    icon = Lucide.Sun,
                    selected = selectedMode == AAAppearanceMode.Light,
                    onClick = { onSelect(AAAppearanceMode.Light) },
                )
                ProfileDivider(start = 0.dp, end = 0.dp)
                AppearanceMenuRow(
                    title = stringResource(R.string.profile_dark),
                    icon = Lucide.Moon,
                    selected = selectedMode == AAAppearanceMode.Dark,
                    onClick = { onSelect(AAAppearanceMode.Dark) },
                )
            }
        }
    }
}

@Composable
internal fun SidebarViewPopup(
    open: Boolean,
    selectedMode: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalAAColors.current
    if (!open) return
    Popup(
        alignment = Alignment.TopEnd,
        offset = androidx.compose.ui.unit.IntOffset(x = 0, y = 48),
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
    ) {
        AnimatedVisibility(
            visible = true,
            enter = fadeIn() + slideInVertically(initialOffsetY = { -10 }),
            exit = fadeOut() + slideOutVertically(targetOffsetY = { -10 }),
        ) {
            Column(
                modifier = Modifier
                    .width(204.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(colors.raisedSurface)
                    .border(1.dp, colors.border, RoundedCornerShape(14.dp)),
            ) {
                AppearanceMenuRow(
                    title = stringResource(R.string.profile_project_view),
                    icon = Lucide.Folder,
                    selected = selectedMode == HomeSidebarViewMode.Project,
                    onClick = { onSelect(HomeSidebarViewMode.Project) },
                )
                ProfileDivider(start = 0.dp, end = 0.dp)
                AppearanceMenuRow(
                    title = stringResource(R.string.profile_session_view),
                    icon = Lucide.ListIcon,
                    selected = selectedMode == HomeSidebarViewMode.Session,
                    onClick = { onSelect(HomeSidebarViewMode.Session) },
                )
            }
        }
    }
}

@Composable
private fun AppearanceMenuRow(
    title: String,
    icon: ImageVector,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp)
            .noRippleClickable(onClick = onClick)
            .padding(start = 12.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (selected) {
            Icon(Lucide.Check, contentDescription = null, tint = colors.ink, modifier = Modifier.size(18.dp))
        } else {
            Spacer(Modifier.width(18.dp))
        }
        Spacer(Modifier.width(10.dp))
        Text(
            text = title,
            modifier = Modifier.weight(1f),
            color = colors.ink,
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
            lineHeight = 19.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Icon(icon, contentDescription = null, tint = colors.inkSoft, modifier = Modifier.size(20.dp))
    }
}

@Composable
internal fun SettingIcon(icon: ImageVector, alpha: Float = 1f, tint: Color? = null) {
    val colors = LocalAAColors.current
    val iconTint = tint ?: colors.inkSoft
    Box(
        modifier = Modifier.size(34.dp),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = iconTint.copy(alpha = alpha),
            modifier = Modifier.size(22.dp),
        )
    }
}

@Composable
internal fun ProfileDivider(start: Dp = 57.dp, end: Dp = 12.dp) {
    val colors = LocalAAColors.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = start, end = end)
            .height(1.dp)
            .background(profileDividerColor(colors)),
    )
}

@Composable
internal fun SignOutCard(onClick: () -> Unit) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(15.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .clip(shape)
            .background(profileCardBackground(colors))
            .border(0.8.dp, profileCardBorder(colors), shape)
            .noRippleClickable(onClick = onClick)
            .padding(start = 12.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        SettingIcon(icon = Lucide.LogOut, tint = colors.errorText)
        Text(
            text = stringResource(R.string.profile_sign_out),
            modifier = Modifier.weight(1f),
            color = colors.errorText,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 20.sp,
            maxLines = 1,
        )
    }
}

private fun isProfileDark(colors: AgentsAnywhereColors): Boolean =
    colors.canvas == Color(0xFF09090B)

internal fun profilePageBackground(colors: AgentsAnywhereColors): Color =
    if (isProfileDark(colors)) colors.canvas else Color(0xFFF4F3EF)

private fun profileCardBackground(colors: AgentsAnywhereColors): Color =
    if (isProfileDark(colors)) colors.raisedSurface else Color.White

private fun profileCardBorder(colors: AgentsAnywhereColors): Color =
    if (isProfileDark(colors)) colors.border else Color(0xFFEAE8E2).copy(alpha = 0.72f)

private fun profileDividerColor(colors: AgentsAnywhereColors): Color =
    if (isProfileDark(colors)) colors.border else Color(0xFFE7E5DF).copy(alpha = 0.78f)
