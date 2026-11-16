package com.agentsanywhere.app.ui.screens.devices

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.agentsanywhere.app.BuildConfig
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.e2ee.E2eeClientErrorCodes
import com.agentsanywhere.app.api.e2ee.E2eeErrorCodes
import com.agentsanywhere.app.feature.e2ee.DeviceE2eeStatus
import com.agentsanywhere.app.feature.e2ee.DeviceTransport
import com.agentsanywhere.app.feature.e2ee.E2eePairingError
import com.agentsanywhere.app.feature.e2ee.E2eePairingState
import com.agentsanywhere.app.feature.e2ee.PairedDevice
import com.agentsanywhere.app.feature.e2ee.E2eeClient
import com.agentsanywhere.app.feature.e2ee.pairForState
import com.agentsanywhere.app.ui.designsystem.AABottomSheet
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.auth.QrScannerFrame
import com.agentsanywhere.app.ui.screens.profile.ProfileDialogButton
import com.agentsanywhere.app.ui.screens.profile.ProfileTextField
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.ShieldCheck
import kotlinx.coroutines.launch

/** 设备详情里的「端到端加密」：配对状态、设备指纹、配对入口。 */
@Composable
internal fun DeviceE2eeSection(
    status: DeviceE2eeStatus,
    onPair: () -> Unit,
) {
    val colors = LocalAAColors.current
    val paired = status.paired
    val transport = status.transport
    SectionBlock(
        title = stringResource(R.string.device_e2ee_section),
        action = {
            SmallActionButton(
                icon = Lucide.ShieldCheck,
                label = stringResource(if (paired == null) R.string.device_e2ee_pair_action else R.string.device_e2ee_repair_action),
                danger = false,
                onClick = onPair,
            )
        },
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = when {
                    paired != null -> stringResource(R.string.device_e2ee_paired)
                    transport is DeviceTransport.PairingRequired -> stringResource(R.string.device_e2ee_required_not_paired)
                    else -> stringResource(R.string.device_e2ee_not_paired)
                },
                color = if (paired == null && transport is DeviceTransport.PairingRequired) colors.errorText else colors.ink,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                lineHeight = 20.sp,
            )
            if (paired != null) {
                FingerprintLine(stringResource(R.string.device_e2ee_device_fingerprint), paired.deviceFingerprint)
            }
            FingerprintLine(stringResource(R.string.device_e2ee_client_fingerprint), status.clientFingerprint)
        }
    }
}

@Composable
private fun FingerprintLine(label: String, fingerprint: String) {
    val colors = LocalAAColors.current
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = label, color = colors.muted, fontSize = 11.5.sp, fontWeight = FontWeight.Medium)
        Text(text = fingerprint, color = colors.ink, fontSize = 13.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
    }
}

/** 扫码或粘贴 `aa-pair://` 链接 → 核对设备指纹 → 配对。 */
@Composable
internal fun DeviceE2eePairingSheet(
    deviceId: String,
    client: E2eeClient,
    onDismiss: () -> Unit,
    onPaired: (PairedDevice) -> Unit,
) {
    val context = LocalContext.current
    val colors = LocalAAColors.current
    val scope = rememberCoroutineScope()
    var state by remember(deviceId) { mutableStateOf(E2eePairingState()) }
    var hasCameraPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        hasCameraPermission = granted
    }
    LaunchedEffect(Unit) {
        if (!hasCameraPermission) permissionLauncher.launch(Manifest.permission.CAMERA)
    }
    val busy = state.stage == E2eePairingState.Stage.Pairing

    AABottomSheet(
        title = stringResource(R.string.e2ee_pair_title),
        onDismissRequest = onDismiss,
        dismissEnabled = !busy,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            when (state.stage) {
                E2eePairingState.Stage.Scan -> {
                    QrScannerFrame(
                        hasCameraPermission = hasCameraPermission,
                        isScanning = true,
                        onQrValue = { value -> state = state.linkEntered(value, deviceId) },
                    )
                    SheetBody(stringResource(R.string.e2ee_pair_scan_hint))
                    ProfileTextField(
                        value = state.pastedLink,
                        placeholder = stringResource(R.string.e2ee_pair_paste_placeholder),
                        onValueChange = { state = state.pastedLinkChanged(it) },
                    )
                    ProfileDialogButton(
                        label = stringResource(R.string.e2ee_pair_paste_action),
                        enabled = state.pastedLink.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                        onClick = { state = state.linkEntered(state.pastedLink, deviceId) },
                    )
                }
                E2eePairingState.Stage.Confirm, E2eePairingState.Stage.Pairing -> {
                    SheetBody(stringResource(R.string.e2ee_pair_confirm_body))
                    state.deviceFingerprint?.let { fingerprint ->
                        Text(
                            text = fingerprint,
                            color = colors.ink,
                            fontSize = 17.sp,
                            fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                        ProfileDialogButton(
                            label = stringResource(R.string.common_back),
                            enabled = !busy,
                            modifier = Modifier.weight(1f),
                            onClick = { state = state.restart() },
                        )
                        ProfileDialogButton(
                            label = stringResource(if (busy) R.string.e2ee_pair_in_progress else R.string.e2ee_pair_confirm_action),
                            primary = true,
                            enabled = !busy,
                            loading = busy,
                            modifier = Modifier.weight(1f),
                            onClick = {
                                state = state.started()
                                scope.launch {
                                    state = client.pairForState(state, pairingLabel(), BuildConfig.VERSION_NAME)
                                    state.paired?.let(onPaired)
                                }
                            },
                        )
                    }
                }
                E2eePairingState.Stage.Paired -> {
                    PairedIcon()
                    SheetBody(stringResource(R.string.e2ee_pair_done))
                    state.deviceFingerprint?.let { SheetBody(it, monospace = true) }
                    ProfileDialogButton(
                        label = stringResource(R.string.common_close),
                        primary = true,
                        modifier = Modifier.fillMaxWidth(),
                        onClick = onDismiss,
                    )
                }
            }
            state.error?.let { error ->
                Text(
                    text = stringResource(error.messageRes()),
                    color = colors.errorText,
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    lineHeight = 17.sp,
                )
            }
            if (busy) CircularProgressIndicator(modifier = Modifier.padding(4.dp), strokeWidth = 2.dp, color = colors.ink)
        }
    }
}

@Composable
private fun PairedIcon() {
    androidx.compose.material3.Icon(
        imageVector = Lucide.ShieldCheck,
        contentDescription = null,
        tint = LocalAAColors.current.ink,
        modifier = Modifier.padding(top = 8.dp),
    )
}

@Composable
private fun SheetBody(text: String, monospace: Boolean = false) {
    Text(
        text = text,
        color = LocalAAColors.current.muted,
        fontSize = 13.5.sp,
        lineHeight = 19.sp,
        fontFamily = if (monospace) FontFamily.Monospace else null,
        fontWeight = FontWeight.Medium,
    )
}

private fun E2eePairingError.messageRes(): Int = when (this) {
    E2eePairingError.InvalidLink -> R.string.e2ee_error_invalid_link
    E2eePairingError.WrongDevice -> R.string.e2ee_error_wrong_device
    E2eePairingError.Expired -> R.string.e2ee_error_pairing_expired
    E2eePairingError.DevicePinMismatch -> R.string.e2ee_error_pin_mismatch
    E2eePairingError.NotPaired -> R.string.e2ee_error_not_paired
    E2eePairingError.HandshakeFailed -> R.string.e2ee_error_handshake_failed
    E2eePairingError.Unavailable -> R.string.e2ee_error_unavailable
    E2eePairingError.Timeout -> R.string.e2ee_error_timeout
    E2eePairingError.Failed -> R.string.e2ee_error_failed
}

/** 加密模式下内容请求失败的错误码 → 文案。 */
internal fun e2eeErrorMessageRes(code: String): Int = when (code) {
    E2eeErrorCodes.E2EE_REQUIRED -> R.string.runtime_error_e2ee_required
    E2eeErrorCodes.NOT_PAIRED -> R.string.e2ee_error_not_paired
    E2eeErrorCodes.DEVICE_PIN_MISMATCH -> R.string.e2ee_error_pin_mismatch
    E2eeClientErrorCodes.TIMEOUT -> R.string.e2ee_error_timeout
    E2eeClientErrorCodes.ATTACHMENTS_UNSUPPORTED -> R.string.e2ee_error_attachments_unsupported
    E2eeClientErrorCodes.TERMINAL_UNSUPPORTED -> R.string.e2ee_error_terminal_unsupported
    E2eeClientErrorCodes.FILE_TRANSFER_UNSUPPORTED -> R.string.e2ee_error_file_transfer_unsupported
    E2eeErrorCodes.CONNECTOR_OFFLINE, E2eeErrorCodes.TUNNEL_DISCONNECTED -> R.string.e2ee_error_unavailable
    else -> R.string.e2ee_error_channel_failed
}

/** 设备的授权列表里显示的名字。 */
private fun pairingLabel(): String = listOf(Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }, Build.MODEL.orEmpty())
    .filter { it.isNotBlank() }
    .joinToString(" ")
    .ifBlank { "Android" }
