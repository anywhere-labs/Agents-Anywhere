package com.agentsanywhere.app.ui.screens.devices

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.config.AppConfig
import com.agentsanywhere.app.feature.devices.DevicePairingStatus
import com.agentsanywhere.app.feature.devices.DevicePairingStep
import com.agentsanywhere.app.feature.devices.DeviceSetupCredential
import com.agentsanywhere.app.feature.devices.randomPairingDeviceName
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.BackIconButton
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Desktop pairing steps presented with the Android full-screen page shell. */
@Composable
fun AddDeviceScreen(
    devices: List<AgentDevice>,
    pairingStates: Map<String, DevicePairingStatus>,
    onBack: () -> Unit,
    onComplete: () -> Unit,
    onCreateCredential: suspend (String) -> Result<DeviceSetupCredential>,
    onRenameDevice: suspend (String, String) -> Result<AgentDevice>,
    onClaimPairCode: suspend (DeviceSetupCredential, String) -> Result<AgentDevice>,
    onWaitForDevice: (String) -> Unit,
    onClearPairing: (String) -> Unit,
) {
    val context = LocalContext.current
    val colors = LocalAAColors.current
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val uriHandler = LocalUriHandler.current
    val toastState = remember { SnackbarHostState() }
    var step by remember { mutableStateOf(DevicePairingStep.ConnectionMethod) }
    var name by rememberSaveable { mutableStateOf(randomPairingDeviceName()) }
    var credential by remember { mutableStateOf<DeviceSetupCredential?>(null) }
    var pairCode by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var waitingOnline by remember { mutableStateOf(false) }
    var createdThisFlow by remember { mutableStateOf(false) }
    var showExitConfirmation by remember { mutableStateOf(false) }
    val connectorId = credential?.device?.id
    val online = connectorId != null && (pairingStates[connectorId] == DevicePairingStatus.Online ||
        devices.any { it.id == connectorId && it.online })
    val scrollState = rememberScrollState()

    fun unfocus() {
        focus.clearFocus()
        keyboard?.hide()
    }

    fun showError(message: String) {
        scope.launch {
            toastState.currentSnackbarData?.dismiss()
            toastState.showSnackbar(AAToastVisuals(message = message, isError = true))
        }
    }

    fun leave() {
        if (busy) return
        unfocus()
        if (credential != null && createdThisFlow) showExitConfirmation = true else onBack()
    }

    fun goBack() {
        if (busy) return
        if (step == DevicePairingStep.ConnectionMethod) leave() else {
            unfocus()
            waitingOnline = false
            step = step.previous()
        }
    }

    fun showStep(next: DevicePairingStep) {
        if (busy) return
        unfocus()
        waitingOnline = false
        if (next == DevicePairingStep.Command || next == DevicePairingStep.PairCode) {
            val current = credential
            if (current == null) {
                step = DevicePairingStep.Name
                return
            }
            if (next == DevicePairingStep.Command) {
                onWaitForDevice(current.device.id)
                waitingOnline = true
            }
        }
        step = next
    }

    fun createCredential() {
        val cleanName = name.trim()
        if (busy || cleanName.isBlank()) return
        val previous = credential
        busy = true
        scope.launch {
            try {
                val prepared = when {
                    previous == null -> onCreateCredential(cleanName).getOrThrow()
                    previous.device.name == cleanName -> previous
                    else -> previous.copy(device = onRenameDevice(previous.device.id, cleanName).getOrThrow())
                }
                credential = prepared
                name = prepared.device.name
                if (previous == null) createdThisFlow = true
                unfocus()
                step = DevicePairingStep.CliMethod
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                showError(error.message ?: context.getString(R.string.device_pairing_errors_create_failed))
            } finally {
                busy = false
            }
        }
    }

    fun claimPairCode() {
        val current = credential ?: return
        if (busy || pairCode.length != 6) return
        busy = true
        unfocus()
        scope.launch {
            try {
                onClaimPairCode(current, pairCode).getOrThrow()
                onClearPairing(current.device.id)
                onComplete()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                showError(error.message ?: context.getString(R.string.device_pairing_errors_claim_failed))
            } finally {
                busy = false
            }
        }
    }

    LaunchedEffect(step) { scrollState.scrollTo(0) }
    LaunchedEffect(waitingOnline, online, connectorId) {
        if (waitingOnline && online && connectorId != null) {
            onClearPairing(connectorId)
            unfocus()
            onBack()
        }
    }
    BackHandler(onBack = ::goBack)

    ScreenScaffold {
        Box(Modifier.fillMaxSize().imePadding().navigationBarsPadding().pointerInput(focus, keyboard) {
            detectTapGestures(onTap = { unfocus() })
        }) {
            Column(Modifier.widthIn(max = 640.dp).fillMaxSize().align(Alignment.TopCenter)) {
                Row(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                    BackIconButton(onClick = ::goBack, enabled = !busy)
                    Text(stringResource(R.string.device_setup_page_title), modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                        color = colors.ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
                    if (step == DevicePairingStep.ConnectionMethod) Spacer(Modifier.size(40.dp)) else {
                        IconButton(onClick = ::leave, enabled = !busy, modifier = Modifier.size(40.dp)) {
                            Icon(Lucide.X, stringResource(R.string.common_close), tint = colors.muted, modifier = Modifier.size(21.dp))
                        }
                    }
                }
                Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(scrollState).padding(horizontal = 18.dp, vertical = 18.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp)) {
                    key(step) {
                        DevicePairingStepContent(
                            step = step, name = name, credential = credential, code = pairCode, busy = busy, waitingOnline = waitingOnline,
                            onNameChange = { name = it }, onCodeChange = { pairCode = it }, onStep = ::showStep,
                            onCreate = ::createCredential, onClaim = ::claimPairCode,
                            onCopyError = { showError(context.getString(R.string.device_pairing_errors_copy_failed)) },
                        )
                    }
                }
                Column(Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 10.dp, bottom = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    DevicePairingStepActions(
                        step = step, name = name, code = pairCode, busy = busy, onStep = ::showStep,
                        onCreate = ::createCredential, onClaim = ::claimPairCode, onComplete = onComplete,
                        onDownload = {
                            runCatching { uriHandler.openUri(AppConfig.DESKTOP_DOWNLOAD_URL) }
                                .onFailure { showError(context.getString(R.string.device_pairing_open_download_failed)) }
                        },
                    )
                }
            }
            AAToastHost(toastState, Modifier.align(Alignment.TopCenter).padding(top = 8.dp, start = 18.dp, end = 18.dp))
        }
    }

    if (showExitConfirmation) AlertDialog(
        onDismissRequest = { showExitConfirmation = false },
        containerColor = colors.dialogSurface,
        titleContentColor = colors.ink,
        textContentColor = colors.muted,
        title = { Text(stringResource(R.string.device_pairing_exit_title)) },
        text = { Text(stringResource(if (waitingOnline) R.string.device_pairing_exit_waiting_description else R.string.device_pairing_exit_description, name)) },
        dismissButton = { TextButton(onClick = { showExitConfirmation = false }) {
            Text(stringResource(R.string.device_pairing_continue_pairing), color = colors.ink)
        } },
        confirmButton = { TextButton(onClick = { showExitConfirmation = false; onBack() }) {
            Text(stringResource(R.string.device_pairing_close_anyway), color = colors.ink)
        } },
    )
}
