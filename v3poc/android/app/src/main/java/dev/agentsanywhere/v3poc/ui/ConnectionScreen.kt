package dev.agentsanywhere.v3poc.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3poc.App
import dev.agentsanywhere.v3poc.R
import dev.agentsanywhere.v3poc.model.AccountRequestFailed
import dev.agentsanywhere.v3poc.model.ClientNoLongerAuthorized
import dev.agentsanywhere.v3poc.model.DeviceGrantUnavailable
import dev.agentsanywhere.v3poc.model.MobileConnectionRejected
import dev.agentsanywhere.v3poc.model.PairingInvitationExpired
import dev.agentsanywhere.v3poc.model.DeviceIdentityMismatch
import dev.agentsanywhere.v3poc.model.InvalidServer
import dev.agentsanywhere.v3poc.model.PairingTargetMismatch
import dev.agentsanywhere.v3poc.model.Workspace
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun ConnectionScreen(app: App) {
    var signedIn by remember { mutableStateOf(false) }
    var devices by remember { mutableStateOf<List<Workspace.Device>>(emptyList()) }
    var selected by remember { mutableStateOf(app.revokedDevice) }
    var server by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var showPaste by remember { mutableStateOf(false) }
    var invitation by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf(false) }
    val context = androidx.compose.ui.platform.LocalContext.current
    var busy by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<Int?>(null) }
    var deniedDeviceId by remember { mutableStateOf(app.revokedDevice?.id) }

    val scope = rememberCoroutineScope()
    val account = app.account

    suspend fun refresh(reopen: Boolean) {
        devices = account.cachedPairedDevices()
        val (known, recent) = account.devices()
        devices = known + devices.filter { cached -> known.none { it.id == cached.id } }
        if (reopen) {
            selected = known.firstOrNull { it.id == recent }
            selected?.let { app.open(account.open(it, null)) }
        }
    }

    suspend fun perform(fallback: Int, action: suspend () -> Unit) {
        busy = true
        error = null
        try {
            action()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            if (failure is ClientNoLongerAuthorized) deniedDeviceId = selected?.id
            error = when {
                failure is ClientNoLongerAuthorized -> R.string.connection_no_longer_authorized
                failure is MobileConnectionRejected -> R.string.connection_rejected
                failure is DeviceGrantUnavailable -> R.string.connection_invalid_qr
                failure is PairingInvitationExpired -> R.string.connection_invite_expired
                failure is InvalidServer -> R.string.connection_invalid_server
                failure is PairingTargetMismatch -> R.string.connection_wrong_device
                failure is DeviceIdentityMismatch -> R.string.connection_key_changed
                failure is AccountRequestFailed && failure.status == 401 -> R.string.connection_unauthorized
                else -> fallback
            }
        } finally {
            busy = false
        }
    }

    fun scan(raw: String) {
        if (busy) return
        scope.launch {
            notice = null
            var connected = false
            try {
                perform(R.string.connection_link_failed) {
                    val device = account.connectFromCode(raw.trim()) { notice = context.getString(R.string.connection_waiting) }
                    connected = true
                    signedIn = true
                    notice = if (device == null) context.getString(R.string.connection_signed_in)
                        else context.getString(R.string.connection_paired_to, device.name)
                    deniedDeviceId = null
                    selected = device
                    showPaste = false
                    invitation = ""
                    refresh(false)
                }
            } finally {
                if (!connected) notice = null
                signedIn = account.restore()
                pending = signedIn && account.hasPendingInvitation()
            }
        }
    }

    LaunchedEffect(Unit) {
        perform(R.string.connection_unavailable) {
            signedIn = account.restore()
            val reopen = app.resumeWorkspace
            app.resumeWorkspace = false
            app.revokedDevice = null
            if (signedIn) {
                pending = account.hasPendingInvitation()
                refresh(reopen && !pending)
            }
        }
    }

    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
        Surface(Modifier.fillMaxSize()) {
            Column(
                Modifier.safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(stringResource(
                    when {
                        !signedIn -> R.string.connection_sign_in
                        else -> R.string.connection_devices
                    },
                ), style = MaterialTheme.typography.headlineSmall)
                notice?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
                PairingScanner(enabled = !busy, onScan = ::scan, onError = { error = it })
                TextButton(onClick = { showPaste = !showPaste }, enabled = !busy) { Text(stringResource(R.string.connection_paste_code)) }
                if (showPaste) {
                    OutlinedTextField(invitation, { invitation = it }, Modifier.fillMaxWidth(),
                        label = { Text(stringResource(R.string.connection_invite)) }, singleLine = true, enabled = !busy)
                    Button(onClick = { scan(invitation) }, enabled = !busy && invitation.isNotBlank()) {
                        Text(stringResource(R.string.connection_connect))
                    }
                }
                if (pending) {
                    TextButton(onClick = { scope.launch {
                        perform(R.string.connection_link_failed) {
                            val device = account.finishPairing()
                            selected = device
                            pending = false
                            deniedDeviceId = null
                            notice = context.getString(R.string.connection_paired_to, device.name)
                            refresh(false)
                        }
                    } }, enabled = !busy) { Text(stringResource(R.string.connection_retry_pairing)) }
                }
                if (!signedIn) {
                    OutlinedTextField(server, { server = it }, Modifier.fillMaxWidth(),
                        label = { Text(stringResource(R.string.connection_server)) }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), enabled = !busy)
                    OutlinedTextField(email, { email = it }, Modifier.fillMaxWidth(),
                        label = { Text(stringResource(R.string.connection_email)) }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), enabled = !busy)
                    OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(),
                        label = { Text(stringResource(R.string.connection_password)) }, singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), enabled = !busy)
                    Button(
                        enabled = !busy && server.isNotBlank() && email.isNotBlank() && password.isNotEmpty(),
                        onClick = { scope.launch {
                            perform(R.string.connection_unavailable) {
                                account.signIn(server, email, password)
                                password = ""
                                signedIn = true
                                refresh(reopen = false)
                            }
                        } },
                    ) { Text(stringResource(R.string.connection_sign_in)) }
                } else if (selected == null) {
                    if (devices.isEmpty() && !busy) Text(stringResource(R.string.connection_no_devices))
                    devices.forEach { device ->
                        OutlinedButton(onClick = {
                            selected = device
                            invitation = ""
                            error = null
                        }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(device.name) }
                    }
                    TextButton(onClick = { scope.launch { perform(R.string.connection_unavailable) { refresh(reopen = false) } } },
                        enabled = !busy) { Text(stringResource(R.string.connection_refresh)) }
                    TextButton(onClick = { scope.launch {
                        perform(R.string.connection_unavailable) {
                            try { account.signOut() } finally { signedIn = false; devices = emptyList(); deniedDeviceId = null }
                        }
                    } }, enabled = !busy) { Text(stringResource(R.string.connection_sign_out)) }
                } else {
                    val device = checkNotNull(selected)
                    var hasGrant by remember(device.id) { mutableStateOf(false) }
                    val denied = deniedDeviceId == device.id
                    var confirmation by remember(device.id) { mutableStateOf<Int?>(null) }
                    var success by remember(device.id) { mutableStateOf<Int?>(null) }
                    LaunchedEffect(device.id, busy) {
                        if (!busy) {
                            try { hasGrant = account.hasGrant(device) }
                            catch (cancelled: CancellationException) { throw cancelled }
                            catch (_: Exception) { error = R.string.connection_pair_failed }
                        }
                    }
                    Text(device.name)
                    Button(onClick = { scope.launch {
                        perform(R.string.connection_pair_failed) { app.open(account.open(device, null)) }
                    } }, enabled = !busy && hasGrant && !denied) { Text(stringResource(R.string.connection_open)) }
                    TextButton(onClick = { selected = null; invitation = ""; error = null; notice = null }, enabled = !busy) {
                        Text(stringResource(R.string.connection_devices))
                    }
                    if (hasGrant && !denied) {
                        TextButton(onClick = { confirmation = R.string.connection_revoke }, enabled = !busy) {
                            Text(stringResource(R.string.connection_revoke))
                        }
                    }
                    if (hasGrant || error == R.string.connection_key_changed) {
                        TextButton(onClick = { confirmation = R.string.connection_forget_pairing }, enabled = !busy) {
                            Text(stringResource(R.string.connection_forget_pairing))
                        }
                    }
                    if (denied && error != R.string.connection_no_longer_authorized) {
                        Text(stringResource(R.string.connection_no_longer_authorized))
                    }
                    success?.let { Text(stringResource(it)) }
                    confirmation?.let { action ->
                        val revoke = action == R.string.connection_revoke
                        AlertDialog(
                            onDismissRequest = { confirmation = null },
                            title = { Text(stringResource(action)) },
                            text = { Text(stringResource(when {
                                revoke -> R.string.connection_revoke_detail
                                denied -> R.string.connection_forget_revoked_detail
                                else -> R.string.connection_forget_pairing_detail
                            })) },
                            confirmButton = {
                                TextButton(onClick = {
                                    confirmation = null
                                    scope.launch {
                                        success = null
                                        perform(if (revoke) R.string.connection_revoke_failed else R.string.connection_forget_failed) {
                                            if (revoke) account.revokePairing(device) else account.forgetPairing(device)
                                            invitation = ""
                                            hasGrant = false
                                            deniedDeviceId = null
                                            success = if (revoke) R.string.connection_revoked else R.string.connection_forgotten
                                        }
                                    }
                                }) { Text(stringResource(action)) }
                            },
                            dismissButton = {
                                TextButton(onClick = { confirmation = null }) { Text(stringResource(R.string.connection_cancel)) }
                            },
                        )
                    }
                }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                error?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}
