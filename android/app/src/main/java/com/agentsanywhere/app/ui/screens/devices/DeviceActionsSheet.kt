package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.KeyRound
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.Trash2
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DeviceActionsSheet(
    device: AgentDevice,
    onDismiss: () -> Unit,
    onRenameDevice: suspend (String, String) -> Result<AgentDevice>,
    onTokenAction: () -> Unit,
    onDeleteDevice: () -> Unit,
) {
    val context = LocalContext.current
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val sheet = if (darkMode) Color(0xFF18181B) else Color.White
    val handle = if (darkMode) Color(0xFF3F3F46) else Color(0xFFD8D6D0)
    val focusRequester = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    var renaming by remember(device.id) { mutableStateOf(false) }
    var draftName by remember(device.id, device.name) { mutableStateOf(device.name) }
    var renameBusy by remember { mutableStateOf(false) }
    var renameError by remember { mutableStateOf<String?>(null) }

    fun submitRename() {
        val next = draftName.trim()
        if (renameBusy) return
        if (next.isBlank() || next == device.name) {
            draftName = device.name
            renaming = false
            renameError = null
            return
        }
        renameBusy = true
        renameError = null
        scope.launch {
            onRenameDevice(device.id, next)
                .onSuccess { onDismiss() }
                .onFailure { error -> renameError = error.message ?: context.getString(R.string.device_actions_rename_failed) }
            renameBusy = false
        }
    }

    LaunchedEffect(renaming) {
        if (renaming) focusRequester.requestFocus()
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = sheet,
        contentColor = colors.ink,
        dragHandle = null,
        scrimColor = if (darkMode) Color(0x99000000) else Color(0x66000000),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(start = 22.dp, end = 22.dp, top = 10.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .width(40.dp)
                        .height(4.dp)
                        .clip(CircleShape)
                        .background(handle),
                )
            }
            Text(
                text = if (renaming) stringResource(R.string.device_actions_rename_device) else device.name,
                color = colors.ink,
                fontSize = 22.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 27.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(bottom = 4.dp),
            )
            if (renaming) {
                BasicTextField(
                    value = draftName,
                    onValueChange = {
                        draftName = it
                        renameError = null
                    },
                    enabled = !renameBusy,
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(50.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(if (darkMode) Color(0xFF111113) else Color(0xFFF7F7F5))
                        .border(1.dp, colors.border, RoundedCornerShape(12.dp))
                        .focusRequester(focusRequester)
                        .padding(horizontal = 14.dp),
                    textStyle = TextStyle(
                        color = colors.ink,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.SansSerif,
                    ),
                    cursorBrush = SolidColor(colors.ink),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { submitRename() }),
                    decorationBox = { innerTextField ->
                        Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
                            innerTextField()
                        }
                    },
                )
                renameError?.let { message ->
                    Text(
                        text = message,
                        color = colors.errorText,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        lineHeight = 17.sp,
                    )
                }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SheetTextButton(
                        label = stringResource(R.string.common_cancel),
                        enabled = !renameBusy,
                        primary = false,
                        onClick = {
                            draftName = device.name
                            renaming = false
                            renameError = null
                        },
                    )
                    SheetTextButton(
                        label = if (renameBusy) stringResource(R.string.common_saving) else stringResource(R.string.common_save),
                        enabled = !renameBusy,
                        primary = true,
                        onClick = { submitRename() },
                    )
                }
            } else {
                DeviceActionRow(icon = Lucide.Pencil, label = stringResource(R.string.device_actions_rename), danger = false, onClick = { renaming = true })
                DeviceActionRow(
                    icon = Lucide.KeyRound,
                    label = if (device.online) stringResource(R.string.common_revoke) else stringResource(R.string.device_actions_setup),
                    danger = false,
                    onClick = onTokenAction,
                )
                DeviceActionRow(icon = Lucide.Trash2, label = stringResource(R.string.common_delete), danger = true, onClick = onDeleteDevice)
            }
        }
    }
}

@Composable
private fun DeviceActionRow(
    icon: ImageVector,
    label: String,
    danger: Boolean,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val tint = when {
        danger && darkMode -> Color(0xFFF87171)
        danger -> Color(0xFFB94848)
        else -> colors.ink
    }
    val surface = if (darkMode) Color(0xFF111113) else Color(0xFFF7F7F5)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(surface)
            .noRippleClickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = tint.copy(alpha = if (enabled) 1f else 0.5f),
            modifier = Modifier.size(18.dp),
        )
        Text(
            text = label,
            color = tint.copy(alpha = if (enabled) 1f else 0.5f),
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}
