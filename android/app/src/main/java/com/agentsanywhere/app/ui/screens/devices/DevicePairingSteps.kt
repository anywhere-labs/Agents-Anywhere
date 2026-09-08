package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DevicePairingStep
import com.agentsanywhere.app.feature.devices.DeviceSetupCredential
import com.agentsanywhere.app.feature.devices.devicePairingCommand
import com.agentsanywhere.app.feature.devices.deviceTokenCommand
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.ExternalLink
import com.composables.icons.lucide.Hash
import com.composables.icons.lucide.KeyRound
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MonitorUp
import com.composables.icons.lucide.Terminal

@Composable
internal fun DevicePairingStepContent(
    step: DevicePairingStep,
    name: String,
    credential: DeviceSetupCredential?,
    code: String,
    busy: Boolean,
    waitingOnline: Boolean,
    onNameChange: (String) -> Unit,
    onCodeChange: (String) -> Unit,
    onStep: (DevicePairingStep) -> Unit,
    onCreate: () -> Unit,
    onClaim: () -> Unit,
    onCopyError: () -> Unit,
) {
    when (step) {
        DevicePairingStep.ConnectionMethod -> {
            PairingStepHeading(stringResource(R.string.device_pairing_connection_title), stringResource(R.string.device_pairing_connection_description))
            PairingChoiceCard(Lucide.MonitorUp, stringResource(R.string.device_pairing_desktop_title), stringResource(R.string.device_pairing_desktop_description)) {
                onStep(DevicePairingStep.DesktopInstall)
            }
            PairingChoiceCard(Lucide.Terminal, stringResource(R.string.device_pairing_cli_title), stringResource(R.string.device_pairing_cli_description)) {
                onStep(DevicePairingStep.CliConfirm)
            }
        }
        DevicePairingStep.DesktopInstall -> {
            PairingStepHeading(stringResource(R.string.device_pairing_desktop_install_title), stringResource(R.string.device_pairing_desktop_install_description))
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                PairingInstructionCard(stringResource(R.string.device_pairing_desktop_download_title), stringResource(R.string.device_pairing_desktop_install_step_download))
                PairingInstructionCard(stringResource(R.string.device_pairing_desktop_login_title), stringResource(R.string.device_pairing_desktop_install_step_login))
                PairingInstructionCard(stringResource(R.string.device_pairing_desktop_online_title), stringResource(R.string.device_pairing_desktop_install_step_online))
            }
        }
        DevicePairingStep.CliConfirm -> {
            PairingStepHeading(stringResource(R.string.device_pairing_command_warning_title), stringResource(R.string.device_pairing_command_warning_description))
            PairingBodyText(stringResource(R.string.device_pairing_command_warning_fallback))
        }
        DevicePairingStep.Name -> {
            PairingStepHeading(stringResource(R.string.device_pairing_name_title), stringResource(R.string.device_pairing_name_description))
            PairingNameInput(name, !busy, onNameChange, onCreate)
        }
        DevicePairingStep.CliMethod -> {
            PairingStepHeading(stringResource(R.string.device_pairing_method_title), stringResource(R.string.device_pairing_method_description, name))
            PairingChoiceCard(Lucide.Hash, stringResource(R.string.device_pairing_pair_code_title), stringResource(R.string.device_pairing_pair_code_description)) {
                onStep(DevicePairingStep.PairCode)
            }
            PairingChoiceCard(Lucide.KeyRound, stringResource(R.string.device_pairing_token_title), stringResource(R.string.device_pairing_token_description)) {
                onStep(DevicePairingStep.Command)
            }
        }
        DevicePairingStep.Command -> {
            PairingStepHeading(stringResource(R.string.device_pairing_command_step_title), stringResource(R.string.device_pairing_command_step_description, name))
            credential?.let {
                val command = deviceTokenCommand(it)
                PairingCodeBlock(command, onCopyError)
                PairingBodyText(stringResource(R.string.device_pairing_linux_session_warning))
                PairingCodeBlock("screen -S anywhere\n$command", onCopyError)
                PairingBodyText(stringResource(R.string.device_pairing_linux_detach_hint))
                PairingCodeBlock("screen -r anywhere", onCopyError)
            }
            if (waitingOnline) PairingWaitingIndicator(stringResource(R.string.device_pairing_waiting_online))
        }
        DevicePairingStep.PairCode -> {
            PairingStepHeading(stringResource(R.string.device_pairing_code_step_title), stringResource(R.string.device_pairing_code_step_description, name))
            credential?.let {
                Surface(modifier = Modifier.fillMaxWidth(), color = LocalAAColors.current.raisedSurface,
                    shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, pairingBorder())) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(stringResource(R.string.device_pairing_pair_command), color = LocalAAColors.current.ink,
                            fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        PairingCodeBlock(devicePairingCommand(it.serverUrl), onCopyError)
                        PairingBodyText(stringResource(R.string.device_pairing_pair_command_hint))
                    }
                }
            }
            PairingCodeInput(code, !busy, onCodeChange, onClaim)
            if (busy) PairingWaitingIndicator(stringResource(R.string.device_pairing_confirming))
        }
    }
}

@Composable
internal fun DevicePairingStepActions(
    step: DevicePairingStep,
    name: String,
    code: String,
    busy: Boolean,
    onStep: (DevicePairingStep) -> Unit,
    onDownload: () -> Unit,
    onComplete: () -> Unit,
    onCreate: () -> Unit,
    onClaim: () -> Unit,
) {
    when (step) {
        DevicePairingStep.DesktopInstall -> {
            PairingActionButton(stringResource(R.string.device_pairing_download), onDownload, secondary = true, icon = Lucide.ExternalLink)
            PairingActionButton(stringResource(R.string.common_done), onComplete)
        }
        DevicePairingStep.CliConfirm -> {
            PairingActionButton(stringResource(R.string.device_pairing_command_warning_desktop), { onStep(DevicePairingStep.DesktopInstall) }, secondary = true)
            PairingActionButton(stringResource(R.string.device_pairing_command_warning_confirm), { onStep(DevicePairingStep.Name) })
        }
        DevicePairingStep.Name -> PairingActionButton(stringResource(R.string.common_continue), onCreate, enabled = name.isNotBlank(), loading = busy)
        DevicePairingStep.PairCode -> PairingActionButton(stringResource(R.string.device_pairing_claim), onClaim, enabled = code.length == 6, loading = busy)
        else -> Unit
    }
}
