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

@Composable
fun AppUpdatePromptDialog(
    state: AppUpdateUiState,
    onUpdate: () -> Unit,
    onLater: () -> Unit,
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
                text = stringResource(R.string.update_available_title),
                color = colors.ink,
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 24.sp,
            )
            Text(
                text = stringResource(R.string.update_available_message, release.versionName),
                color = colors.muted,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 20.sp,
            )
            if (state.downloadFailed) {
                Text(
                    text = stringResource(R.string.update_download_failed),
                    color = colors.errorText,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 18.sp,
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                UpdateDialogButton(
                    label = stringResource(R.string.update_later),
                    primary = false,
                    enabled = !state.downloading,
                    modifier = Modifier.weight(1f),
                    onClick = onLater,
                )
                UpdateDialogButton(
                    label = stringResource(if (state.downloading) R.string.update_downloading else R.string.update_now),
                    primary = true,
                    enabled = !state.downloading,
                    modifier = Modifier.weight(1f),
                    onClick = onUpdate,
                )
            }
        }
    }
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
