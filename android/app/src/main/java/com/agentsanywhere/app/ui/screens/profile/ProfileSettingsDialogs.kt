package com.agentsanywhere.app.ui.screens.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import kotlinx.coroutines.launch

@Composable
internal fun ChangePasswordDialog(
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
internal fun ConfirmSignOutDialog(onDismiss: () -> Unit, onConfirm: () -> Unit) {
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
                .background(colors.dialogSurface)
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
internal fun ProfileDialogButton(
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
            .background(
                if (primary) {
                    colors.primaryAction.copy(alpha = if (enabled) 1f else 0.42f)
                } else {
                    colors.secondaryActionSurface.copy(alpha = if (enabled) 1f else 0.42f)
                },
            )
            .noRippleClickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = label, color = content, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}
