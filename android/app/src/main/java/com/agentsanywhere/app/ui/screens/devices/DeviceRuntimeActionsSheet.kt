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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.ui.designsystem.AABottomSheet
import com.agentsanywhere.app.ui.designsystem.AABottomSheetDefaults
import com.agentsanywhere.app.ui.designsystem.AABottomSheetItem
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.SlidersHorizontal
import com.composables.icons.lucide.Trash2
import kotlinx.coroutines.launch

/** Configure, rename or delete one configured Agent. [onRename] returns an error to show, or null. */
@Composable
internal fun DeviceRuntimeActionsSheet(
    runtime: DeviceRuntime,
    online: Boolean,
    validateName: (String) -> String?,
    onDismiss: () -> Unit,
    onConfigure: () -> Unit,
    onRename: suspend (String) -> String?,
    onDelete: () -> Unit,
) {
    val colors = LocalAAColors.current
    val sheetColors = AABottomSheetDefaults.colors()
    val focusRequester = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    var renaming by remember(runtime.id) { mutableStateOf(false) }
    var draftName by remember(runtime.id, runtime.name) { mutableStateOf(runtime.name) }
    var renameBusy by remember { mutableStateOf(false) }
    var renameError by remember { mutableStateOf<String?>(null) }
    val nameRequired = stringResource(R.string.device_agents_name_required)

    fun submitRename() {
        val next = draftName.trim()
        if (renameBusy) return
        if (next == runtime.name) {
            onDismiss()
            return
        }
        renameError = if (next.isEmpty()) nameRequired else validateName(next)
        if (renameError != null) return
        renameBusy = true
        scope.launch {
            val error = onRename(next)
            renameBusy = false
            if (error == null) onDismiss() else renameError = error
        }
    }

    LaunchedEffect(renaming) {
        if (renaming) focusRequester.requestFocus()
    }

    AABottomSheet(
        title = if (renaming) stringResource(R.string.device_agents_rename_title) else runtime.labels.primary,
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
                            draftName = runtime.name
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
                AABottomSheetItem(
                    icon = Lucide.SlidersHorizontal,
                    text = stringResource(R.string.device_agents_configure),
                    enabled = online,
                    supportingText = if (online) null else stringResource(R.string.device_agents_offline),
                    onClick = onConfigure,
                )
                AABottomSheetItem(icon = Lucide.Pencil, text = stringResource(R.string.device_actions_rename), onClick = { renaming = true })
                AABottomSheetItem(
                    icon = Lucide.Trash2,
                    text = stringResource(R.string.device_confirm_delete_runtime_config),
                    danger = true,
                    onClick = onDelete,
                )
            }
        }
    }
}
