package com.agentsanywhere.app.ui.screens.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.CircleShape
import coil3.compose.AsyncImage
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.AuthMeResponse
import com.agentsanywhere.app.feature.update.AppUpdateUiState
import com.agentsanywhere.app.ui.designsystem.AALanguageMode
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.screens.update.AppUpdateDownloadProgress
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.KeyRound
import com.composables.icons.lucide.LogOut
import com.composables.icons.lucide.Lucide

@Composable
internal fun IdentityCard(
    account: AuthMeResponse,
    serviceLabel: String,
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
                    text = serviceLabel,
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
internal fun AccountDetailPage(
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
internal fun LanguageDetailPage(
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
internal fun UpdateDetailPage(
    state: AppUpdateUiState,
    onUpdate: () -> Unit,
    onCancelDownload: () -> Unit,
) {
    val colors = LocalAAColors.current
    val release = state.release
    if (release != null) {
        ProfileCard {
            Column(
                modifier = Modifier.padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text(
                    text = stringResource(
                        when {
                            state.downloading -> R.string.update_downloading_title
                            state.preparingInstall -> R.string.update_preparing_install
                            state.installing -> R.string.update_installing_title
                            state.installFailed -> R.string.update_install_failed_title
                            else -> R.string.update_available_title
                        },
                    ),
                    color = colors.ink,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold,
                    lineHeight = 22.sp,
                )
                if (state.downloading) {
                    Text(
                        text = stringResource(R.string.update_downloading_version, release.versionName),
                        color = colors.muted,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        lineHeight = 20.sp,
                    )
                    AppUpdateDownloadProgress(state = state)
                } else if (state.installing) {
                    Text(
                        text = stringResource(R.string.update_installing_message),
                        color = colors.muted,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        lineHeight = 20.sp,
                    )
                } else if (!state.preparingInstall) {
                    Text(
                        text = stringResource(R.string.update_available_message, release.versionName),
                        color = colors.muted,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        lineHeight = 20.sp,
                    )
                }
                if (state.downloadFailed) {
                    Text(
                        text = stringResource(R.string.update_download_failed),
                        color = colors.errorText,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        lineHeight = 18.sp,
                    )
                }
                if (state.installFailed) {
                    Text(
                        text = stringResource(R.string.update_install_failed_message),
                        color = colors.errorText,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        lineHeight = 18.sp,
                    )
                }
                when {
                    state.downloading -> ProfileDialogButton(
                        label = stringResource(R.string.update_cancel_download),
                        primary = false,
                        enabled = true,
                        modifier = Modifier.fillMaxWidth(),
                        onClick = onCancelDownload,
                    )
                    state.preparingInstall -> ProfileDialogButton(
                        label = stringResource(R.string.update_preparing_install),
                        primary = true,
                        enabled = false,
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {},
                    )
                    state.installing -> ProfileDialogButton(
                        label = stringResource(R.string.update_waiting_install),
                        primary = true,
                        enabled = false,
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {},
                    )
                    else -> ProfileDialogButton(
                        label = stringResource(
                            when {
                                state.installFailed -> R.string.update_retry_install
                                state.downloadFailed -> R.string.update_retry
                                else -> R.string.update_now
                            },
                        ),
                        primary = true,
                        enabled = true,
                        modifier = Modifier.fillMaxWidth(),
                        onClick = onUpdate,
                    )
                }
            }
        }
        return
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(260.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (state.checking) {
            CircularProgressIndicator(
                modifier = Modifier.size(24.dp),
                color = colors.muted,
                strokeWidth = 2.dp,
            )
        } else {
            Text(
                text = stringResource(
                    if (state.checkFailed) R.string.update_check_failed else R.string.update_up_to_date,
                ),
                color = colors.muted,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 21.sp,
                maxLines = 2,
            )
        }
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
