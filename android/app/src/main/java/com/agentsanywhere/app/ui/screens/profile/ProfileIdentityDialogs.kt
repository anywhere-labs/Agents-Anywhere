package com.agentsanywhere.app.ui.screens.profile

import android.util.Patterns
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.AuthConfigResponse
import com.agentsanywhere.app.api.AuthMeResponse
import com.agentsanywhere.app.api.EmailCodeResponse
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun NicknameDialog(
    displayName: String,
    onDismiss: () -> Unit,
    onSave: suspend (String) -> Result<AuthMeResponse>,
) {
    var draft by remember { mutableStateOf(displayName) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val fallbackError = stringResource(R.string.profile_update_failed)
    val canSave = draft.trim().length in 1..64 && !busy
    ProfileDialog(title = stringResource(R.string.profile_edit_nickname), onDismiss = { if (!busy) onDismiss() }) {
        ProfileTextField(value = draft, placeholder = stringResource(R.string.profile_nickname), onValueChange = {
            if (!busy) {
                draft = it
                error = null
            }
        })
        error?.let { ProfileDialogHint(it) }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProfileDialogButton(label = stringResource(R.string.common_cancel), enabled = !busy, modifier = Modifier.weight(1f), onClick = onDismiss)
            ProfileDialogButton(
                label = stringResource(if (busy) R.string.common_saving else R.string.common_save),
                primary = true,
                enabled = canSave,
                modifier = Modifier.weight(1f),
                onClick = {
                    scope.launch {
                        busy = true
                        try {
                            onSave(draft.trim()).onFailure { error = it.message ?: fallbackError }
                        } finally {
                            busy = false
                        }
                    }
                },
            )
        }
    }
}

@Composable
internal fun EmailBindingDialog(
    currentEmail: String,
    onDismiss: () -> Unit,
    onLoadConfig: suspend () -> Result<AuthConfigResponse>,
    onSendCode: suspend (String) -> Result<EmailCodeResponse>,
    onSave: suspend (String, String?) -> Result<AuthMeResponse>,
) {
    var email by remember { mutableStateOf(currentEmail) }
    var code by remember { mutableStateOf("") }
    var config by remember { mutableStateOf<AuthConfigResponse?>(null) }
    var configLoading by remember { mutableStateOf(true) }
    var configAttempt by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var cooldown by remember { mutableIntStateOf(0) }
    var codeSent by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val fallbackError = stringResource(R.string.profile_update_failed)
    val validEmail = Patterns.EMAIL_ADDRESS.matcher(email.trim()).matches()
    val verificationRequired = config?.emailVerificationRequired == true
    val canSave = config != null && validEmail && !busy && (!verificationRequired || code.length == 6)

    LaunchedEffect(configAttempt) {
        configLoading = true
        error = null
        try {
            onLoadConfig().onSuccess { config = it }.onFailure { error = it.message ?: fallbackError }
        } finally {
            configLoading = false
        }
    }
    LaunchedEffect(cooldown) {
        if (cooldown > 0) {
            delay(1000)
            cooldown -= 1
        }
    }

    ProfileDialog(title = stringResource(R.string.profile_bind_email), onDismiss = { if (!busy) onDismiss() }) {
        ProfileTextField(value = email, placeholder = stringResource(R.string.profile_email), onValueChange = {
            if (!busy) {
                email = it
                code = ""
                codeSent = false
                error = null
            }
        })
        when {
            configLoading -> Text(stringResource(R.string.profile_loading_email_policy), color = LocalAAColors.current.muted)
            config == null -> ProfileDialogButton(
                label = stringResource(R.string.profile_retry),
                modifier = Modifier.fillMaxWidth(),
                onClick = { configAttempt += 1 },
            )
            verificationRequired -> {
                ProfileTextField(value = code, placeholder = stringResource(R.string.profile_email_code), onValueChange = {
                    if (!busy) code = it.filter(Char::isDigit).take(6)
                })
                ProfileDialogButton(
                    label = if (cooldown > 0) stringResource(R.string.profile_resend_in, cooldown) else stringResource(R.string.profile_send_code),
                    enabled = validEmail && !busy && cooldown == 0,
                    modifier = Modifier.fillMaxWidth(),
                    onClick = {
                        scope.launch {
                            busy = true
                            error = null
                            try {
                                onSendCode(email.trim()).onSuccess {
                                    cooldown = it.retryAfter.coerceAtLeast(1)
                                    codeSent = true
                                }.onFailure { error = it.message ?: fallbackError }
                            } finally {
                                busy = false
                            }
                        }
                    },
                )
                if (codeSent) Text(stringResource(R.string.profile_code_sent), color = LocalAAColors.current.muted)
            }
            else -> Text(stringResource(R.string.profile_email_verification_disabled), color = LocalAAColors.current.muted)
        }
        error?.let { ProfileDialogHint(it) }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProfileDialogButton(label = stringResource(R.string.common_cancel), enabled = !busy, modifier = Modifier.weight(1f), onClick = onDismiss)
            ProfileDialogButton(
                label = stringResource(if (busy) R.string.common_saving else R.string.common_save),
                primary = true,
                enabled = canSave,
                modifier = Modifier.weight(1f),
                onClick = {
                    scope.launch {
                        busy = true
                        error = null
                        try {
                            onSave(email.trim(), code.takeIf { verificationRequired }).onFailure { error = it.message ?: fallbackError }
                        } finally {
                            busy = false
                        }
                    }
                },
            )
        }
    }
}
