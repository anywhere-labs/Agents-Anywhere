package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.BackIconButton
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold

/** Full-page project editor shared by the home shortcut and the new-session picker. */
@Composable
internal fun NewProjectScreen(
    deviceField: NewSessionConfigurationField,
    deviceMenuExpanded: Boolean,
    onToggleDevice: () -> Unit,
    onDismissDevice: () -> Unit,
    onSelectDevice: (String) -> Unit,
    name: String,
    onNameChange: (String) -> Unit,
    creating: Boolean,
    canCreate: Boolean,
    error: String?,
    onBack: () -> Unit,
    onCreate: () -> Unit,
    directoryContent: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalAAColors.current
    val focus = LocalFocusManager.current
    ScreenScaffold {
        Column(Modifier.fillMaxSize().imePadding()) {
            Box(Modifier.fillMaxWidth().height(58.dp).padding(horizontal = 18.dp)) {
                Text(
                    text = stringResource(R.string.new_session_create_project),
                    modifier = Modifier.align(Alignment.Center),
                    color = colors.ink,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.ExtraBold,
                )
                BackIconButton(
                    onClick = onBack,
                    modifier = Modifier.align(Alignment.CenterStart),
                    enabled = !creating,
                )
            }
            Column(
                modifier = Modifier.fillMaxWidth().weight(1f).padding(start = 18.dp, top = 12.dp, end = 18.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                NewSessionConfigurationCard(
                    fields = listOf(deviceField),
                    expanded = NewSessionConfigurationKey.Device.takeIf { deviceMenuExpanded },
                    onToggle = { onToggleDevice() },
                    onDismiss = onDismissDevice,
                    onSelect = { _, id -> onSelectDevice(id) },
                )
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.new_session_project_name), color = colors.inkSoft, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    BasicTextField(
                        value = name,
                        onValueChange = onNameChange,
                        enabled = !creating,
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().height(54.dp)
                            .clip(RoundedCornerShape(18.dp)).background(colors.raisedSurface)
                            .padding(horizontal = 16.dp),
                        textStyle = TextStyle(color = colors.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                        cursorBrush = SolidColor(colors.ink),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
                        decorationBox = { field ->
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.CenterStart) {
                                if (name.isBlank()) Text(stringResource(R.string.new_session_project_name_placeholder), color = colors.faint, fontSize = 15.sp)
                                field()
                            }
                        },
                    )
                }
                directoryContent()
            }
            Column(
                modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 18.dp, end = 18.dp, top = 10.dp, bottom = 10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                error?.let { Text(it, color = colors.errorText, fontSize = 13.sp) }
                StartChatButton(
                    label = stringResource(if (creating) R.string.new_session_project_creating else R.string.new_session_create_project),
                    enabled = canCreate,
                    onClick = onCreate,
                )
            }
        }
    }
}
