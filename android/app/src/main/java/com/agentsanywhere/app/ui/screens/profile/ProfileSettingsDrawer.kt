package com.agentsanywhere.app.ui.screens.profile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import coil3.compose.AsyncImage
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.AuthMeResponse
import com.agentsanywhere.app.ui.designsystem.AAAppearanceMode
import com.agentsanywhere.app.ui.designsystem.AALanguageMode
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereColors
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.ChevronsUpDown
import com.composables.icons.lucide.Circle
import com.composables.icons.lucide.Globe
import com.composables.icons.lucide.KeyRound
import com.composables.icons.lucide.LogOut
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Moon
import com.composables.icons.lucide.PackageCheck
import com.composables.icons.lucide.Server
import com.composables.icons.lucide.Sun
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

private enum class ProfileDetailPage { None, Account, Language, Updates }

@Composable
private fun ProfileDetailPage.titleLabel(): String = when (this) {
    ProfileDetailPage.Account -> stringResource(R.string.profile_account)
    ProfileDetailPage.Language -> stringResource(R.string.profile_language)
    ProfileDetailPage.Updates -> stringResource(R.string.profile_updates)
    ProfileDetailPage.None -> ""
}

@Composable
fun ProfileSettingsDrawer(
    open: Boolean,
    userId: String,
    role: String,
    serverUrl: String,
    appearanceMode: String,
    languageMode: String,
    onAppearanceModeChange: (String) -> Unit,
    onLanguageModeChange: (String) -> Unit,
    onLoadAccount: suspend () -> Result<AuthMeResponse>,
    onUpdateAvatar: suspend (String) -> Result<AuthMeResponse>,
    onClearAvatar: suspend () -> Result<AuthMeResponse>,
    onChangePassword: suspend (String) -> Result<Unit>,
    onSignOut: () -> Unit,
    onClose: () -> Unit,
    onNotice: (String, Boolean) -> Unit,
) {
    val context = LocalContext.current
    val colors = LocalAAColors.current
    val scope = rememberCoroutineScope()
    var account by remember(userId, role) {
        mutableStateOf(
            AuthMeResponse(
                userId = userId,
                role = role.ifBlank { "member" },
                disabled = false,
                avatar = null,
                serverTime = "",
            ),
        )
    }
    var avatarBusy by remember { mutableStateOf(false) }
    var detailPage by remember { mutableStateOf(ProfileDetailPage.None) }
    var appearanceMenuOpen by remember { mutableStateOf(false) }
    var passwordOpen by remember { mutableStateOf(false) }
    var signOutOpen by remember { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        if (uri == null || avatarBusy) return@rememberLauncherForActivityResult
        scope.launch {
            avatarBusy = true
            runCatching { context.avatarDataUrl(uri) }
                .getOrNull()
                ?.let { dataUrl ->
                    onUpdateAvatar(dataUrl)
                        .onSuccess {
                            account = it
                            onNotice(context.getString(R.string.profile_avatar_updated), false)
                        }
                        .onFailure { error ->
                            onNotice(error.message ?: context.getString(R.string.profile_avatar_update_failed), true)
                        }
                }
                ?: onNotice(context.getString(R.string.profile_avatar_read_failed), true)
            avatarBusy = false
        }
    }

    BackHandler(enabled = open) {
        if (detailPage != ProfileDetailPage.None) detailPage = ProfileDetailPage.None else onClose()
    }

    LaunchedEffect(open) {
        if (!open) {
            detailPage = ProfileDetailPage.None
            appearanceMenuOpen = false
            return@LaunchedEffect
        }
        onLoadAccount()
            .onSuccess { account = it }
            .onFailure { onNotice(it.message ?: context.getString(R.string.profile_account_load_failed), true) }
    }

    AnimatedVisibility(
        visible = open,
        enter = slideInHorizontally(initialOffsetX = { -it }) + fadeIn(),
        exit = slideOutHorizontally(targetOffsetX = { -it }) + fadeOut(),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(profilePageBackground(colors)),
        ) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .padding(horizontal = 18.dp),
                contentPadding = PaddingValues(top = 0.dp, bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (detailPage != ProfileDetailPage.None) {
                    item("account-detail-header") {
                        ProfileHeader(title = detailPage.titleLabel(), onClose = { detailPage = ProfileDetailPage.None })
                    }
                    when (detailPage) {
                        ProfileDetailPage.Account -> item("account-detail") {
                            AccountDetailPage(
                                account = account,
                                avatarBusy = avatarBusy,
                                onChangeAvatar = {
                                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                },
                                onChangePassword = { passwordOpen = true },
                                onSignOut = { signOutOpen = true },
                            )
                        }
                        ProfileDetailPage.Language -> item("language-detail") {
                            LanguageDetailPage(
                                selectedMode = languageMode,
                                onSelect = onLanguageModeChange,
                            )
                        }
                        ProfileDetailPage.Updates -> item("updates-detail") {
                            ComingSoonDetail(message = stringResource(R.string.profile_updates_coming_soon))
                        }
                        ProfileDetailPage.None -> Unit
                    }
                } else {
                    item("header") {
                        ProfileHeader(title = stringResource(R.string.profile_settings), onClose = onClose)
                    }
                    item("identity") {
                        IdentityCard(
                            account = account,
                            onClick = { detailPage = ProfileDetailPage.Account },
                        )
                    }
                    item("appearance") {
                        ProfileCard {
                            ProfileRow(
                                icon = Lucide.Moon,
                                title = stringResource(R.string.profile_appearance),
                                trailing = appearanceMode.labelForAppearance(),
                                trailingIcon = Lucide.ChevronsUpDown,
                                showChevron = false,
                                onClick = { appearanceMenuOpen = true },
                            )
                            AppearancePopup(
                                open = appearanceMenuOpen,
                                selectedMode = appearanceMode,
                                onSelect = {
                                    onAppearanceModeChange(it)
                                    appearanceMenuOpen = false
                                },
                                onDismiss = { appearanceMenuOpen = false },
                            )
                        }
                    }
                    item("language") {
                        ProfileCard {
                            ProfileRow(
                                icon = Lucide.Globe,
                                title = stringResource(R.string.profile_language),
                                trailing = languageMode.labelForLanguage(),
                                onClick = { detailPage = ProfileDetailPage.Language },
                            )
                        }
                    }
                    item("version") {
                        ProfileCard {
                            ProfileRow(
                                icon = Lucide.PackageCheck,
                                title = stringResource(R.string.profile_version),
                                trailing = "v${context.appVersionName()}",
                                showChevron = false,
                            )
                            ProfileDivider()
                            ProfileRow(
                                icon = Lucide.Server,
                                title = stringResource(R.string.profile_check_updates),
                                onClick = { detailPage = ProfileDetailPage.Updates },
                            )
                        }
                    }
                    item("sign-out") {
                        SignOutCard(onClick = { signOutOpen = true })
                    }
                }
            }
        }
    }

    if (passwordOpen) {
        ChangePasswordDialog(
            onDismiss = { passwordOpen = false },
            onSave = { password ->
                onChangePassword(password)
                    .onSuccess {
                        passwordOpen = false
                        onNotice(context.getString(R.string.profile_password_updated), false)
                    }
                    .onFailure { onNotice(it.message ?: context.getString(R.string.profile_password_update_failed), true) }
            },
        )
    }

    if (signOutOpen) {
        ConfirmSignOutDialog(
            onDismiss = { signOutOpen = false },
            onConfirm = {
                signOutOpen = false
                onSignOut()
            },
        )
    }
}

@Composable
private fun ProfileHeader(
    title: String? = null,
    onClose: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val iconSurface = if (darkMode) Color(0xFF18181B) else Color.White
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
private fun IdentityCard(
    account: AuthMeResponse,
    onClick: (() -> Unit)? = null,
) {
    val colors = LocalAAColors.current
    ProfileCard {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(72.dp)
                .then(if (onClick != null) Modifier.noRippleClickable(onClick = onClick) else Modifier)
                .padding(start = 12.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(11.dp),
        ) {
            ProfileAvatar(account = account, size = 42)
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    text = account.userId.ifBlank { stringResource(R.string.profile_account_fallback) },
                    color = colors.ink,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    lineHeight = 21.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = stringResource(R.string.profile_self_hosted),
                    color = colors.muted,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 16.sp,
                    maxLines = 1,
                )
            }
            if (onClick != null) {
                Icon(
                    imageVector = Lucide.ChevronRight,
                    contentDescription = null,
                    tint = colors.faint,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}

@Composable
private fun AccountDetailPage(
    account: AuthMeResponse,
    avatarBusy: Boolean,
    onChangeAvatar: () -> Unit,
    onChangePassword: () -> Unit,
    onSignOut: () -> Unit,
) {
    val colors = LocalAAColors.current
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(24.dp))
        Box(
            modifier = Modifier.noRippleClickable(enabled = !avatarBusy, onClick = onChangeAvatar),
        ) {
            ProfileAvatar(account = account, size = 86)
        }
        Text(
            text = if (avatarBusy) stringResource(R.string.profile_avatar_updating) else stringResource(R.string.profile_avatar_change),
            modifier = Modifier
                .padding(top = 15.dp)
                .noRippleClickable(enabled = !avatarBusy, onClick = onChangeAvatar),
            color = colors.muted,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 20.sp,
            maxLines = 1,
        )
        Spacer(Modifier.height(28.dp))
        ProfileCard {
            AccountInfoRow(
                label = stringResource(R.string.profile_account_id),
                value = account.userId.ifBlank { stringResource(R.string.profile_account_fallback) },
            )
            ProfileDivider(start = 12.dp, end = 12.dp)
            AccountInfoRow(label = stringResource(R.string.profile_role), value = account.role.ifBlank { "member" }.prettyRole())
        }
        Spacer(Modifier.height(24.dp))
        ProfileCard {
            AccountActionRow(icon = Lucide.KeyRound, text = stringResource(R.string.profile_change_password), onClick = onChangePassword)
        }
        Spacer(Modifier.height(18.dp))
        ProfileCard {
            AccountActionRow(icon = Lucide.LogOut, text = stringResource(R.string.profile_sign_out), tint = colors.errorText, onClick = onSignOut)
        }
    }
}

@Composable
private fun LanguageDetailPage(
    selectedMode: String,
    onSelect: (String) -> Unit,
) {
    ProfileCard {
        LanguageRow(
            title = stringResource(R.string.profile_language_follow_system),
            selected = selectedMode == AALanguageMode.System,
            onClick = { onSelect(AALanguageMode.System) },
        )
        ProfileDivider(start = 12.dp, end = 12.dp)
        LanguageRow(
            title = stringResource(R.string.profile_english),
            selected = selectedMode == AALanguageMode.English,
            onClick = { onSelect(AALanguageMode.English) },
        )
        ProfileDivider(start = 12.dp, end = 12.dp)
        LanguageRow(
            title = stringResource(R.string.profile_simplified_chinese),
            selected = selectedMode == AALanguageMode.SimplifiedChinese,
            onClick = { onSelect(AALanguageMode.SimplifiedChinese) },
        )
    }
}

@Composable
private fun LanguageRow(
    title: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .noRippleClickable(onClick = onClick)
            .padding(start = 16.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            modifier = Modifier.weight(1f),
            color = colors.ink,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 20.sp,
            maxLines = 1,
        )
        if (selected) {
            Icon(Lucide.Check, contentDescription = null, tint = colors.ink, modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
private fun ComingSoonDetail(message: String) {
    val colors = LocalAAColors.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(260.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = message,
            color = colors.muted,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 21.sp,
            maxLines = 2,
        )
    }
}

@Composable
private fun AccountInfoRow(
    label: String,
    value: String,
    showChevron: Boolean = false,
) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .padding(start = 16.dp, end = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            modifier = Modifier.weight(1f),
            color = colors.ink,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 20.sp,
            maxLines = 1,
        )
        Text(
            text = value,
            color = colors.muted,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 19.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (showChevron) {
            Spacer(Modifier.width(8.dp))
            Icon(Lucide.ChevronRight, contentDescription = null, tint = colors.faint, modifier = Modifier.size(19.dp))
        }
    }
}

@Composable
private fun AccountActionRow(
    icon: ImageVector,
    text: String,
    tint: Color? = null,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val contentColor = tint ?: colors.ink
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .noRippleClickable(onClick = onClick)
            .padding(start = 12.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        SettingIcon(icon = icon, tint = contentColor)
        Text(
            text = text,
            color = contentColor,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 20.sp,
            maxLines = 1,
        )
    }
}

@Composable
private fun ProfileAvatar(account: AuthMeResponse, size: Int) {
    val colors = LocalAAColors.current
    val letter = account.userId.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "A"
    Box(
        modifier = Modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(Color(0xFF7857D8)),
        contentAlignment = Alignment.Center,
    ) {
        if (!account.avatar.isNullOrBlank()) {
            AsyncImage(
                model = account.avatar,
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
            )
        } else {
            Text(
                text = letter,
                color = Color.White,
                fontSize = (size * 0.52f).sp,
                fontWeight = FontWeight.Medium,
            )
        }
        if (account.disabled) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(colors.canvas.copy(alpha = 0.55f)),
            )
        }
    }
}

@Composable
private fun ProfileCard(content: @Composable ColumnScope.() -> Unit) {
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
private fun ProfileRow(
    icon: ImageVector,
    title: String,
    subtitle: String? = null,
    trailing: String? = null,
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
        if (trailingIcon != null) {
            Icon(trailingIcon, contentDescription = null, tint = colors.faint.copy(alpha = alpha), modifier = Modifier.size(20.dp))
        }
        if (showChevron) {
            Icon(Lucide.ChevronRight, contentDescription = null, tint = colors.faint.copy(alpha = alpha), modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
private fun AppearancePopup(
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
private fun SettingIcon(icon: ImageVector, alpha: Float = 1f, tint: Color? = null) {
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
private fun ProfileDivider(start: Dp = 57.dp, end: Dp = 12.dp) {
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
private fun SignOutCard(onClick: () -> Unit) {
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

private fun profilePageBackground(colors: AgentsAnywhereColors): Color =
    if (isProfileDark(colors)) colors.canvas else Color(0xFFF4F3EF)

private fun profileCardBackground(colors: AgentsAnywhereColors): Color =
    if (isProfileDark(colors)) colors.raisedSurface else Color.White

private fun profileCardBorder(colors: AgentsAnywhereColors): Color =
    if (isProfileDark(colors)) colors.border else Color(0xFFEAE8E2).copy(alpha = 0.72f)

private fun profileDividerColor(colors: AgentsAnywhereColors): Color =
    if (isProfileDark(colors)) colors.border else Color(0xFFE7E5DF).copy(alpha = 0.78f)

@Composable
private fun ChangePasswordDialog(
    onDismiss: () -> Unit,
    onSave: suspend (String) -> Unit,
) {
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val canSave = password.length >= 8 && password == confirm && !saving
    ProfileDialog(title = stringResource(R.string.profile_change_password), onDismiss = onDismiss) {
        ProfilePasswordField(value = password, placeholder = stringResource(R.string.profile_new_password), onValueChange = { password = it })
        ProfilePasswordField(value = confirm, placeholder = stringResource(R.string.profile_confirm_password), onValueChange = { confirm = it })
        if (password.isNotEmpty() && password.length < 8) {
            ProfileDialogHint(stringResource(R.string.profile_password_min_length))
        } else if (confirm.isNotEmpty() && password != confirm) {
            ProfileDialogHint(stringResource(R.string.auth_passwords_do_not_match))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProfileDialogButton(label = stringResource(R.string.common_cancel), modifier = Modifier.weight(1f), onClick = onDismiss)
            ProfileDialogButton(
                label = if (saving) stringResource(R.string.common_saving) else stringResource(R.string.common_save),
                primary = true,
                enabled = canSave,
                modifier = Modifier.weight(1f),
                onClick = {
                    if (!canSave) return@ProfileDialogButton
                    scope.launch {
                        saving = true
                        onSave(password)
                        saving = false
                    }
                },
            )
        }
    }
}

@Composable
private fun ConfirmSignOutDialog(onDismiss: () -> Unit, onConfirm: () -> Unit) {
    ProfileDialog(title = stringResource(R.string.profile_sign_out_title), onDismiss = onDismiss) {
        Text(
            text = stringResource(R.string.profile_sign_out_body),
            color = LocalAAColors.current.muted,
            fontSize = 14.sp,
            lineHeight = 19.sp,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProfileDialogButton(label = stringResource(R.string.common_cancel), modifier = Modifier.weight(1f), onClick = onDismiss)
            ProfileDialogButton(label = stringResource(R.string.profile_sign_out), primary = true, modifier = Modifier.weight(1f), onClick = onConfirm)
        }
    }
}

@Composable
private fun ProfileDialog(
    title: String,
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalAAColors.current
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 22.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(20.dp))
                .background(colors.raisedSurface)
                .border(1.dp, colors.border, RoundedCornerShape(20.dp))
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                text = title,
                color = colors.ink,
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 24.sp,
            )
            content()
        }
    }
}

@Composable
private fun ProfilePasswordField(value: String, placeholder: String, onValueChange: (String) -> Unit) {
    val colors = LocalAAColors.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(50.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(colors.subtle)
            .border(1.dp, colors.border, RoundedCornerShape(14.dp))
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (value.isEmpty()) {
            Text(text = placeholder, color = colors.faint, fontSize = 15.sp, fontWeight = FontWeight.Medium)
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            textStyle = TextStyle(color = colors.ink, fontSize = 15.sp, fontWeight = FontWeight.Medium),
            visualTransformation = PasswordVisualTransformation(),
            cursorBrush = SolidColor(colors.ink),
        )
    }
}

@Composable
private fun ProfileDialogHint(text: String) {
    Text(
        text = text,
        color = LocalAAColors.current.errorText,
        fontSize = 12.5.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

@Composable
private fun ProfileDialogButton(
    label: String,
    primary: Boolean = false,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(14.dp)
    val content = if (primary) colors.onPrimaryAction else colors.ink
    Box(
        modifier = modifier
            .height(46.dp)
            .clip(shape)
            .background(if (primary) colors.primaryAction.copy(alpha = if (enabled) 1f else 0.42f) else Color.Transparent)
            .then(if (primary) Modifier else Modifier.border(1.dp, colors.border, shape))
            .noRippleClickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = label, color = content, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun String.labelForAppearance(): String = when (this) {
    AAAppearanceMode.Light -> stringResource(R.string.profile_light)
    AAAppearanceMode.Dark -> stringResource(R.string.profile_dark)
    else -> stringResource(R.string.profile_system)
}

@Composable
private fun String.labelForLanguage(): String = when (this) {
    AALanguageMode.English -> stringResource(R.string.profile_english)
    AALanguageMode.SimplifiedChinese -> stringResource(R.string.profile_simplified_chinese)
    else -> stringResource(R.string.profile_language_follow_system)
}

@Composable
private fun String.prettyRole(): String = when (lowercase()) {
    "admin" -> stringResource(R.string.profile_role_admin)
    "member" -> stringResource(R.string.profile_role_member)
    else -> replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
}

private suspend fun Context.avatarDataUrl(uri: Uri): String? = withContext(Dispatchers.IO) {
    val bitmap = contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } ?: return@withContext null
    val scale = minOf(1f, 256f / max(bitmap.width, bitmap.height).toFloat())
    val width = max(1, (bitmap.width * scale).roundToInt())
    val height = max(1, (bitmap.height * scale).roundToInt())
    val scaled = if (width == bitmap.width && height == bitmap.height) {
        bitmap
    } else {
        Bitmap.createScaledBitmap(bitmap, width, height, true)
    }
    val data = ByteArrayOutputStream().use { output ->
        scaled.compress(Bitmap.CompressFormat.PNG, 100, output)
        output.toByteArray()
    }
    if (scaled !== bitmap) scaled.recycle()
    bitmap.recycle()
    "data:image/png;base64,${Base64.encodeToString(data, Base64.NO_WRAP)}"
}

private fun Context.appVersionName(): String {
    return runCatching {
        packageManager.getPackageInfo(packageName, 0).versionName.orEmpty()
    }.getOrDefault("0.1.7.2")
}
