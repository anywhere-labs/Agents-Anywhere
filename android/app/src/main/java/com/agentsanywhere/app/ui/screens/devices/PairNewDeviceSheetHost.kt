package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.agentsanywhere.app.feature.devices.DeviceSetupCredential
import com.agentsanywhere.app.model.AgentDevice

@Composable
internal fun PairNewDeviceSheetHost(
    open: Boolean,
    devices: List<AgentDevice>,
    onDismiss: () -> Unit,
    onCreateDeviceSetup: suspend (String) -> Result<DeviceSetupCredential>,
    onDeviceCredentialCreated: (DeviceSetupCredential) -> Unit,
    onClaimDevicePairCode: suspend (DeviceSetupCredential, String) -> Result<AgentDevice>,
) {
    var setupCredential by remember(open) { mutableStateOf<DeviceSetupCredential?>(null) }
    val setupDevice = setupCredential?.device?.id?.let { id ->
        devices.firstOrNull { it.id == id } ?: setupCredential?.device
    }

    if (open) {
        DeviceSetupSheet(
            device = setupDevice,
            credential = setupCredential,
            busy = false,
            errorMessage = null,
            mode = DeviceSetupMode.PairNew,
            onDismiss = onDismiss,
            onCreateCredential = onCreateDeviceSetup,
            onCredentialCreated = { credential ->
                setupCredential = credential
                onDeviceCredentialCreated(credential)
            },
            onClaimPairCode = onClaimDevicePairCode,
        )
    }
}
