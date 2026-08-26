package com.agentsanywhere.app.ui.screens.update

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.update.AppUpdateUiState
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import java.util.Locale

@Composable
fun AppUpdatePromptDialog(
    state: AppUpdateUiState,
    onUpdate: () -> Unit,
    onLater: () -> Unit,
    onCancelDownload: () -> Unit,
) {
    val release = state.release ?: return
    if (!state.promptVisible) return
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(20.dp)
    Dialog(
        onDismissRequest = { if (!state.downloading) onLater() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 22.dp)
                .fillMaxWidth()
                .clip(shape)
                .background(colors.raisedSurface)
                .border(1.dp, colors.border, shape)
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = stringResource(
                    when {
                        state.downloading -> R.string.update_downloading_title
                        state.preparingInstall -> R.string.update_preparing_install
                        else -> R.string.update_available_title
                    },
                ),
                color = colors.ink,
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 24.sp,
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
            } else if (state.preparingInstall) {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth(),
                    color = colors.ink,
                    trackColor = colors.subtle,
                )
            } else {
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
            if (state.downloading) {
                UpdateDialogButton(
                    label = stringResource(R.string.update_cancel_download),
                    primary = false,
                    enabled = true,
                    modifier = Modifier.fillMaxWidth(),
                    onClick = onCancelDownload,
                )
            } else if (state.preparingInstall) {
                UpdateDialogButton(
                    label = stringResource(R.string.update_preparing_install),
                    primary = true,
                    enabled = false,
                    modifier = Modifier.fillMaxWidth(),
                    onClick = {},
                )
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    UpdateDialogButton(
                        label = stringResource(R.string.update_later),
                        primary = false,
                        enabled = true,
                        modifier = Modifier.weight(1f),
                        onClick = onLater,
                    )
                    UpdateDialogButton(
                        label = stringResource(if (state.downloadFailed) R.string.update_retry else R.string.update_now),
                        primary = true,
                        enabled = true,
                        modifier = Modifier.weight(1f),
                        onClick = onUpdate,
                    )
                }
            }
        }
    }
}

@Composable
fun AppUpdateDownloadProgress(
    state: AppUpdateUiState,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val totalBytes = state.totalBytes
    val progress = totalBytes?.takeIf { it > 0 }?.let {
        (state.downloadedBytes.toFloat() / it.toFloat()).coerceIn(0f, 1f)
    }
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (progress != null) {
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier.fillMaxWidth(),
                color = colors.ink,
                trackColor = colors.subtle,
            )
        } else {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth(),
                color = colors.ink,
                trackColor = colors.subtle,
            )
        }
        Text(
            text = if (progress != null && totalBytes != null) {
                stringResource(
                    R.string.update_download_progress,
                    (progress * 100).toInt(),
                    formatBytes(state.downloadedBytes),
                    formatBytes(totalBytes),
                )
            } else {
                stringResource(R.string.update_download_progress_unknown, formatBytes(state.downloadedBytes))
            },
            color = colors.muted,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            lineHeight = 16.sp,
        )
    }
}

private fun formatBytes(bytes: Long): String {
    val megabytes = bytes / (1024.0 * 1024.0)
    return String.format(Locale.getDefault(), "%.1f MB", megabytes)
}

@Composable
private fun UpdateDialogButton(
    label: String,
    primary: Boolean,
    enabled: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(14.dp)
    androidx.compose.foundation.layout.Box(
        modifier = modifier
            .height(46.dp)
            .clip(shape)
            .background(if (primary) colors.primaryAction.copy(alpha = if (enabled) 1f else 0.42f) else Color.Transparent)
            .then(if (primary) Modifier else Modifier.border(1.dp, colors.border, shape))
            .noRippleClickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = if (primary) colors.onPrimaryAction else colors.ink,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}
