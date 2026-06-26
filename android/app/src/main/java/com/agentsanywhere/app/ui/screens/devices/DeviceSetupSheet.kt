package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceSetupCredential
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Copy
import com.composables.icons.lucide.Hash
import com.composables.icons.lucide.KeyRound
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Terminal
import com.composables.icons.lucide.X
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DeviceSetupSheet(
    device: AgentDevice?,
    credential: DeviceSetupCredential?,
    busy: Boolean,
    errorMessage: String?,
    mode: DeviceSetupMode = DeviceSetupMode.Reconnect,
    onDismiss: () -> Unit,
    onCreateCredential: (suspend (String) -> Result<DeviceSetupCredential>)? = null,
    onCredentialCreated: (DeviceSetupCredential) -> Unit = {},
    onClaimPairCode: suspend (DeviceSetupCredential, String) -> Result<AgentDevice>,
) {
    val context = LocalContext.current
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val palette = setupSheetPalette(darkMode)
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var sheetCredential by remember(credential?.device?.id, credential?.connectorToken) { mutableStateOf(credential) }
    var page by remember(mode, sheetCredential?.device?.id, sheetCredential?.connectorToken) {
        mutableStateOf(if (mode == DeviceSetupMode.PairNew && sheetCredential == null) SetupSheetPage.Create else SetupSheetPage.Choose)
    }
    var pairCode by remember(credential?.device?.id, credential?.connectorToken) { mutableStateOf("") }
    var claimBusy by remember { mutableStateOf(false) }
    var claimError by remember { mutableStateOf<String?>(null) }
    var waitingForOnline by remember { mutableStateOf(false) }
    var createBusy by remember { mutableStateOf(false) }
    var createError by remember { mutableStateOf<String?>(null) }
    var deviceName by remember(mode) { mutableStateOf(defaultDeviceName()) }
    val nameFocusRequester = remember { FocusRequester() }
    var copied by remember(sheetCredential?.connectorToken) { mutableStateOf<String?>(null) }
    val shownDevice = device ?: sheetCredential?.device
    val title = when (mode) {
        DeviceSetupMode.PairNew -> stringResource(R.string.device_setup_pair_new_title)
        DeviceSetupMode.Reconnect -> stringResource(
            R.string.device_setup_reconnect_title,
            shownDevice?.name ?: stringResource(R.string.device_setup_device_fallback),
        )
    }
    val connected = shownDevice?.online == true
    val connectorId = sheetCredential?.device?.id ?: shownDevice?.id.orEmpty()

    LaunchedEffect(credential?.device, credential?.connectorToken) {
        if (credential != null) {
            sheetCredential = credential
        }
    }

    fun copy(label: String, text: String) {
        if (text.isBlank()) return
        clipboard.setText(AnnotatedString(text))
        copied = label
        scope.launch {
            delay(1_500)
            if (copied == label) copied = null
        }
    }

    fun claim() {
        val current = sheetCredential ?: return
        if (claimBusy) return
        claimBusy = true
        claimError = null
        scope.launch {
            onClaimPairCode(current, pairCode)
                .onSuccess { waitingForOnline = true }
                .onFailure { error ->
                    claimError = error.message ?: context.getString(R.string.device_setup_claim_failed)
                    waitingForOnline = false
                }
            claimBusy = false
        }
    }

    fun generateCredential() {
        val create = onCreateCredential ?: return
        if (createBusy) return
        createBusy = true
        createError = null
        scope.launch {
            create(deviceName)
                .onSuccess { created ->
                    sheetCredential = created
                    deviceName = created.device.name
                    onCredentialCreated(created)
                    page = SetupSheetPage.Choose
                }
                .onFailure { error ->
                    createError = error.message ?: context.getString(R.string.device_setup_generate_failed)
                }
            createBusy = false
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = palette.sheet,
        contentColor = palette.title,
        scrimColor = if (darkMode) Color(0x99000000) else Color(0x66000000),
        dragHandle = null,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(start = 22.dp, end = 22.dp, top = 10.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SetupHandle(color = palette.handle)
            SetupHeader(title = title, palette = palette, onDismiss = onDismiss)

            val currentCredential = sheetCredential
            if (mode == DeviceSetupMode.PairNew && page == SetupSheetPage.Create) {
                SetupHint(
                    text = stringResource(R.string.device_setup_name_then_generate),
                    palette = palette,
                )
                SetupDeviceNameField(
                    value = deviceName,
                    enabled = !createBusy,
                    palette = palette,
                    focusRequester = nameFocusRequester,
                    onValueChange = { deviceName = it },
                    onSubmit = { generateCredential() },
                )
                if (createError != null) {
                    SetupErrorText(text = createError.orEmpty(), palette = palette)
                }
                SetupActionRow(
                    primaryLabel = if (createBusy) stringResource(R.string.device_setup_generating) else stringResource(R.string.device_setup_generate_token),
                    primaryEnabled = !createBusy,
                    palette = palette,
                    onCancel = onDismiss,
                    onPrimary = { generateCredential() },
                )
            } else if (busy || currentCredential == null) {
                SetupHint(
                    text = errorMessage ?: stringResource(
                        R.string.device_setup_preparing_credentials,
                        shownDevice?.name ?: stringResource(R.string.device_setup_this_device_fallback),
                    ),
                    palette = palette,
                )
                SetupStatusRow(
                    text = errorMessage ?: stringResource(R.string.device_setup_preparing),
                    error = errorMessage != null,
                    connected = false,
                    palette = palette,
                )
                SetupCloseButton(label = stringResource(R.string.common_close), palette = palette, onClick = onDismiss)
            } else {
                when (page) {
                    SetupSheetPage.Create -> Unit
                    SetupSheetPage.Choose -> {
                        SetupHint(
                            text = stringResource(R.string.device_setup_credentials_ready, currentCredential.device.name),
                            palette = palette,
                        )
                        SetupOptionRow(
                            icon = Lucide.KeyRound,
                            title = stringResource(R.string.device_setup_use_token),
                            description = stringResource(R.string.device_setup_use_token_description),
                            palette = palette,
                            onClick = { page = SetupSheetPage.Token },
                        )
                        SetupOptionRow(
                            icon = Lucide.Terminal,
                            title = stringResource(R.string.device_setup_pair_code),
                            description = stringResource(R.string.device_setup_pair_code_description),
                            palette = palette,
                            onClick = { page = SetupSheetPage.PairCode },
                        )
                        SetupStatusRow(
                            text = if (connected) stringResource(R.string.device_setup_connected) else stringResource(R.string.device_setup_waiting_connection),
                            error = false,
                            connected = connected,
                            palette = palette,
                        )
                        SetupCloseButton(label = if (connected) stringResource(R.string.common_done) else stringResource(R.string.common_close), palette = palette, onClick = onDismiss)
                    }
                    SetupSheetPage.Token -> {
                        SetupBackButton(palette = palette, onClick = { page = SetupSheetPage.Choose })
                        SetupHint(
                            text = stringResource(R.string.device_setup_run_start_command),
                            palette = palette,
                        )
                        val lines = startCommandLines(currentCredential)
                        SetupCommandBlock(
                            label = stringResource(R.string.device_setup_start_connector),
                            lines = lines,
                            copied = copied == "token",
                            palette = palette,
                            onCopy = { copy("token", lines.joinToString(" ")) },
                        )
                        SetupStatusRow(
                            text = if (connected) stringResource(R.string.device_setup_connected) else stringResource(R.string.device_setup_waiting_connection),
                            error = false,
                            connected = connected,
                            palette = palette,
                        )
                        SetupCloseButton(label = if (connected) stringResource(R.string.common_done) else stringResource(R.string.common_close), palette = palette, onClick = onDismiss)
                    }
                    SetupSheetPage.PairCode -> {
                        SetupBackButton(palette = palette, onClick = { page = SetupSheetPage.Choose })
                        SetupHint(
                            text = stringResource(R.string.device_setup_run_pair_command),
                            palette = palette,
                        )
                        val pairCommand = pairCommand(currentCredential.serverUrl)
                        SetupCommandBlock(
                            label = stringResource(R.string.device_setup_pair_command),
                            lines = listOf(pairCommand),
                            copied = copied == "pair",
                            palette = palette,
                            onCopy = { copy("pair", pairCommand) },
                        )
                        SetupPairCodeRow(
                            value = pairCode,
                            busy = claimBusy || waitingForOnline,
                            palette = palette,
                            onValueChange = { pairCode = it.uppercase().take(12) },
                            onClaim = { claim() },
                        )
                        SetupStatusRow(
                            text = claimError ?: when {
                                connected -> stringResource(R.string.device_setup_connected)
                                claimBusy -> stringResource(R.string.device_setup_claiming)
                                waitingForOnline -> stringResource(R.string.device_setup_waiting_device)
                                else -> stringResource(R.string.device_setup_waiting_connection)
                            },
                            error = claimError != null,
                            connected = connected,
                            palette = palette,
                        )
                        SetupCloseButton(label = if (connected) stringResource(R.string.common_done) else stringResource(R.string.common_close), palette = palette, onClick = onDismiss)
                    }
                }
            }
        }
    }
}

@Composable
private fun SetupHandle(color: Color) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .width(40.dp)
                .height(4.dp)
                .clip(CircleShape)
                .background(color),
        )
    }
}

@Composable
private fun SetupHeader(
    title: String,
    palette: DeviceSetupPalette,
    onDismiss: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(34.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = title,
            modifier = Modifier.weight(1f),
            color = palette.title,
            fontSize = 21.sp,
            fontWeight = FontWeight.ExtraBold,
            lineHeight = 25.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Box(
            modifier = Modifier
                .size(30.dp)
                .clip(CircleShape)
                .background(palette.closeButton)
                .noRippleClickable(onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Lucide.X,
                contentDescription = stringResource(R.string.device_setup_close_content_description),
                tint = palette.icon,
                modifier = Modifier.size(13.dp),
            )
        }
    }
}

@Composable
private fun SetupHint(text: String, palette: DeviceSetupPalette) {
    Text(
        text = text,
        color = palette.body,
        fontSize = 13.6.sp,
        fontWeight = FontWeight.Medium,
        lineHeight = 19.sp,
    )
}

@Composable
private fun SetupDeviceNameField(
    value: String,
    enabled: Boolean,
    palette: DeviceSetupPalette,
    focusRequester: FocusRequester,
    onValueChange: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(
            text = stringResource(R.string.device_setup_device_name),
            color = palette.faint,
            fontSize = 12.6.sp,
            fontWeight = FontWeight.Bold,
        )
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = true,
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(palette.card)
                .border(1.dp, palette.border, RoundedCornerShape(10.dp))
                .focusRequester(focusRequester)
                .padding(horizontal = 12.dp),
            textStyle = TextStyle(
                color = palette.title,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.SansSerif,
            ),
            cursorBrush = SolidColor(palette.title),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onSubmit() }),
            decorationBox = { innerTextField ->
                Box(
                    modifier = Modifier.fillMaxWidth(),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (value.isBlank()) {
                        Text(
                            text = stringResource(R.string.device_setup_device_name),
                            color = palette.faint,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                    innerTextField()
                }
            },
        )
    }
}

@Composable
private fun SetupErrorText(text: String, palette: DeviceSetupPalette) {
    Text(
        text = text,
        color = palette.error,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        lineHeight = 17.sp,
    )
}

@Composable
private fun SetupActionRow(
    primaryLabel: String,
    primaryEnabled: Boolean,
    palette: DeviceSetupPalette,
    onCancel: () -> Unit,
    onPrimary: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(42.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .height(42.dp)
                .clip(CircleShape)
                .border(1.dp, palette.border, CircleShape)
                .noRippleClickable(onClick = onCancel),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(R.string.common_cancel),
                color = palette.title,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
            )
        }
        Box(
            modifier = Modifier
                .weight(1f)
                .height(42.dp)
                .clip(CircleShape)
                .background(palette.primary.copy(alpha = if (primaryEnabled) 1f else 0.45f))
                .noRippleClickable(enabled = primaryEnabled, onClick = onPrimary),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = primaryLabel,
                color = palette.onPrimary,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun SetupOptionRow(
    icon: ImageVector,
    title: String,
    description: String,
    palette: DeviceSetupPalette,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(82.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(palette.card)
            .border(1.dp, palette.border, RoundedCornerShape(10.dp))
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(palette.iconBadge),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = palette.title,
                modifier = Modifier.size(17.dp),
            )
        }
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically),
        ) {
            Text(
                text = title,
                color = palette.title,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
            Text(
                text = description,
                color = palette.body,
                fontSize = 12.6.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 17.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(
            imageVector = Lucide.ChevronRight,
            contentDescription = null,
            tint = palette.chevron,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun SetupBackButton(palette: DeviceSetupPalette, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .height(24.dp)
            .width(76.dp)
            .clip(RoundedCornerShape(6.dp))
            .noRippleClickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            imageVector = Lucide.ChevronLeft,
            contentDescription = null,
            tint = palette.body,
            modifier = Modifier.size(14.dp),
        )
        Text(
            text = stringResource(R.string.common_back),
            color = palette.body,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun SetupCommandBlock(
    label: String,
    lines: kotlin.collections.List<String>,
    copied: Boolean,
    palette: DeviceSetupPalette,
    onCopy: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(palette.card)
            .border(1.dp, palette.border, RoundedCornerShape(10.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(24.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "$",
                color = palette.warning,
                fontFamily = FontFamily.Monospace,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = label,
                modifier = Modifier.weight(1f),
                color = palette.faint,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.2.sp,
                fontWeight = FontWeight.Bold,
            )
            Row(
                modifier = Modifier
                    .height(24.dp)
                    .width(78.dp)
                    .clip(RoundedCornerShape(7.dp))
                    .background(palette.copyButton)
                    .border(1.dp, palette.border, RoundedCornerShape(7.dp))
                    .noRippleClickable(onClick = onCopy),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Icon(
                    imageVector = if (copied) Lucide.Check else Lucide.Copy,
                    contentDescription = null,
                    tint = palette.icon,
                    modifier = Modifier.size(13.dp),
                )
                Spacer(Modifier.width(5.dp))
                Text(
                    text = if (copied) stringResource(R.string.common_copied) else stringResource(R.string.common_copy),
                    color = palette.title,
                    fontSize = 12.2.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                )
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            lines.forEachIndexed { index, line ->
                Text(
                    text = line,
                    color = if (index == 0) palette.commandStrong else palette.command,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.2.sp,
                    fontWeight = if (index == 0) FontWeight.Bold else FontWeight.SemiBold,
                    lineHeight = 17.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun SetupPairCodeRow(
    value: String,
    busy: Boolean,
    palette: DeviceSetupPalette,
    onValueChange: (String) -> Unit,
    onClaim: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = !busy,
            singleLine = true,
            modifier = Modifier
                .weight(1f)
                .height(48.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(palette.card)
                .border(1.dp, palette.border, RoundedCornerShape(10.dp))
                .padding(horizontal = 12.dp),
            textStyle = TextStyle(
                color = palette.title,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            ),
            cursorBrush = SolidColor(palette.title),
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Characters,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { onClaim() }),
            decorationBox = { innerTextField ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(
                        imageVector = Lucide.Hash,
                        contentDescription = null,
                        tint = palette.faint,
                        modifier = Modifier.size(15.dp),
                    )
                    Box(modifier = Modifier.weight(1f)) {
                        if (value.isBlank()) {
                            Text(
                                text = stringResource(R.string.device_setup_pair_code_placeholder),
                                color = palette.faint,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                        innerTextField()
                    }
                }
            },
        )
        Box(
            modifier = Modifier
                .width(82.dp)
                .height(48.dp)
                .clip(CircleShape)
                .background(palette.primary.copy(alpha = if (busy) 0.45f else 1f))
                .noRippleClickable(enabled = !busy, onClick = onClaim),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = if (busy) stringResource(R.string.common_wait) else stringResource(R.string.common_claim),
                color = palette.onPrimary,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun SetupStatusRow(
    text: String,
    error: Boolean,
    connected: Boolean,
    palette: DeviceSetupPalette,
) {
    val dot = when {
        error -> palette.error
        connected -> palette.connected
        else -> palette.warning
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(42.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (error) palette.errorSurface else palette.statusSurface)
            .border(1.dp, if (error) palette.errorBorder else palette.statusBorder, RoundedCornerShape(10.dp))
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(dot),
        )
        Text(
            text = text,
            modifier = Modifier.weight(1f),
            color = if (error) palette.error else palette.statusText,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.2.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun SetupCloseButton(
    label: String,
    palette: DeviceSetupPalette,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(40.dp)
            .clip(CircleShape)
            .border(1.dp, palette.border, CircleShape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = palette.title,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

private enum class SetupSheetPage {
    Create,
    Choose,
    Token,
    PairCode,
}

internal enum class DeviceSetupMode {
    Reconnect,
    PairNew,
}

private data class DeviceSetupPalette(
    val sheet: Color,
    val title: Color,
    val body: Color,
    val faint: Color,
    val border: Color,
    val card: Color,
    val iconBadge: Color,
    val closeButton: Color,
    val copyButton: Color,
    val icon: Color,
    val chevron: Color,
    val commandStrong: Color,
    val command: Color,
    val statusSurface: Color,
    val statusBorder: Color,
    val statusText: Color,
    val warning: Color,
    val connected: Color,
    val error: Color,
    val errorSurface: Color,
    val errorBorder: Color,
    val primary: Color,
    val onPrimary: Color,
    val handle: Color,
)

private fun setupSheetPalette(darkMode: Boolean): DeviceSetupPalette {
    return if (darkMode) {
        DeviceSetupPalette(
            sheet = Color(0xFF18181B),
            title = Color(0xFFFAFAFA),
            body = Color(0xFFA1A1AA),
            faint = Color(0xFF71717A),
            border = Color(0xFF2F2F34),
            card = Color(0xFF111113),
            iconBadge = Color(0xFF27272A),
            closeButton = Color(0xFF27272A),
            copyButton = Color(0xFF27272A),
            icon = Color(0xFFD4D4D8),
            chevron = Color(0xFF71717A),
            commandStrong = Color(0xFFE4E4E7),
            command = Color(0xFFA1A1AA),
            statusSurface = Color(0xFF211B16),
            statusBorder = Color(0xFF3A2A1D),
            statusText = Color(0xFFD6B084),
            warning = Color(0xFFD08B51),
            connected = Color(0xFF7DD3A8),
            error = Color(0xFFFCA5A5),
            errorSurface = Color(0xFF2A1214),
            errorBorder = Color(0xFF5F2429),
            primary = Color(0xFFFAFAFA),
            onPrimary = Color(0xFF09090B),
            handle = Color(0xFF3F3F46),
        )
    } else {
        DeviceSetupPalette(
            sheet = Color(0xFFFDFCFB),
            title = Color(0xFF0A0A0B),
            body = Color(0xFF727274),
            faint = Color(0xFFA0A0A2),
            border = Color(0xFFE6E3DE),
            card = Color.White,
            iconBadge = Color(0xFFF4F4F2),
            closeButton = Color(0xFFF4F4F2),
            copyButton = Color(0xFFF4F4F2),
            icon = Color(0xFF4D4D50),
            chevron = Color(0xFFA8A8A8),
            commandStrong = Color(0xFF1C1C1E),
            command = Color(0xFF55565A),
            statusSurface = Color(0xFFFFF8F2),
            statusBorder = Color(0xFFF0E1D1),
            statusText = Color(0xFF6A625A),
            warning = Color(0xFFB77742),
            connected = Color(0xFF2F8F5B),
            error = Color(0xFFB42318),
            errorSurface = Color(0xFFFFF4F4),
            errorBorder = Color(0xFFF4C7C7),
            primary = Color(0xFF0A0A0B),
            onPrimary = Color.White,
            handle = Color(0xFFD8D5CF),
        )
    }
}

private fun startCommandLines(credential: DeviceSetupCredential): kotlin.collections.List<String> {
    return listOf(
        "uvx anywhere-cli start",
        "--server-url ${shellQuote(credential.serverUrl)}",
        "--connector-id ${shellQuote(credential.device.id)}",
        "--connector-token ${shellQuote(credential.connectorToken)}",
    )
}

private fun pairCommand(serverUrl: String): String {
    return "uvx anywhere-cli pair ${shellQuote(serverUrl.pairServerAddress())}"
}

private fun String.pairServerAddress(): String {
    return runCatching {
        val url = java.net.URL(this)
        if (url.protocol == "https") url.host else this
    }.getOrDefault(this)
}

private fun shellQuote(value: String): String {
    if (value.matches(Regex("^[A-Za-z0-9_./:=@%+-]+$"))) return value
    return "'" + value.replace("'", "'\"'\"'") + "'"
}

private val deviceNameAdjectives = listOf(
    "Amber",
    "Bright",
    "Calm",
    "Cedar",
    "Clear",
    "Copper",
    "Delta",
    "Harbor",
    "Ivory",
    "Maple",
    "North",
    "Quiet",
    "River",
    "Silver",
    "Slate",
    "Swift",
)

private val deviceNameNouns = listOf(
    "Desktop",
    "Laptop",
    "Mac",
    "Machine",
    "Node",
    "Studio",
    "Terminal",
    "Workstation",
)

private fun defaultDeviceName(): String {
    return "${deviceNameAdjectives.random()} ${deviceNameNouns.random()}"
}
