package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.AABottomSheet
import com.agentsanywhere.app.ui.designsystem.AABottomSheetDefaults
import com.agentsanywhere.app.ui.designsystem.AABottomSheetItem
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.KeyRound
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.Trash2
import kotlinx.coroutines.launch

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
    val sheetColors = AABottomSheetDefaults.colors()
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

    AABottomSheet(
        title = if (renaming) stringResource(R.string.device_actions_rename_device) else device.name,
        onDismissRequest = onDismiss,
        dismissEnabled = !renameBusy,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
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
                        .background(sheetColors.selectedContainer)
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
                AABottomSheetItem(icon = Lucide.Pencil, text = stringResource(R.string.device_actions_rename), onClick = { renaming = true })
                AABottomSheetItem(
                    icon = Lucide.KeyRound,
                    text = if (device.online) stringResource(R.string.common_revoke) else stringResource(R.string.device_actions_setup),
                    onClick = onTokenAction,
                )
                AABottomSheetItem(icon = Lucide.Trash2, text = stringResource(R.string.common_delete), danger = true, onClick = onDeleteDevice)
            }
        }
    }
}
