package com.agentsanywhere.app.ui.screens.devices

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceSetupCredential
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Copy
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Monitor
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private const val DESKTOP_CONNECTOR_DOWNLOAD_URL = "https://web.agents-anywhere.com/"
private const val STEP_SCROLL_DURATION_MS = 750
private val stepScrollAnimationSpec = tween<Float>(
    durationMillis = STEP_SCROLL_DURATION_MS,
    easing = FastOutSlowInEasing,
)

@Composable
fun AddDeviceScreen(
    devices: List<AgentDevice>,
    onBack: () -> Unit,
    onCreateCredential: suspend (String) -> Result<DeviceSetupCredential>,
    onRenameDevice: suspend (String, String) -> Result<AgentDevice>,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var deviceName by rememberSaveable { mutableStateOf(defaultDeviceName()) }
    var creating by remember { mutableStateOf(false) }
    var setupCredential by remember { mutableStateOf<DeviceSetupCredential?>(null) }
    var selectedPlatform by remember { mutableStateOf<PairingPlatform?>(null) }
    var errorMessage by rememberSaveable { mutableStateOf<String?>(null) }
    val scrollState = rememberScrollState()
    val stepOffsets = remember { mutableStateMapOf<Int, Int>() }
    val stepCount = if (selectedPlatform == PairingPlatform.Desktop) 4 else 3
    val currentStep by remember(stepCount) {
        derivedStateOf {
            (1..stepCount).lastOrNull { step ->
                stepOffsets[step]?.let { offset -> offset <= scrollState.value + 8 } == true
            } ?: 1
        }
    }
    val currentDevice = setupCredential?.let { credential ->
        devices.firstOrNull { it.id == credential.device.id } ?: credential.device
    }
    fun scrollToStep(stepNumber: Int) {
        scope.launch {
            val targetStep = stepNumber.coerceIn(1, stepCount)
            stepOffsets[targetStep]?.let { target ->
                scrollState.animateScrollTo(
                    value = target,
                    animationSpec = stepScrollAnimationSpec,
                )
            }
        }
    }

    fun saveDeviceName() {
        val name = deviceName.trim()
        if (name.isBlank() || creating) return
        val currentCredential = setupCredential
        if (currentCredential != null) {
            if (name == currentCredential.device.name) {
                scrollToStep(2)
                return
            }
            creating = true
            errorMessage = null
            scope.launch {
                onRenameDevice(currentCredential.device.id, name)
                    .onSuccess { renamedDevice ->
                        deviceName = renamedDevice.name
                        setupCredential = currentCredential.copy(device = renamedDevice)
                        scrollToStep(2)
                    }
                    .onFailure { error ->
                        errorMessage = error.message ?: context.getString(R.string.device_actions_rename_failed)
                    }
                creating = false
            }
            return
        }
        creating = true
        errorMessage = null
        scope.launch {
            onCreateCredential(name)
                .onSuccess { credential ->
                    deviceName = credential.device.name
                    setupCredential = credential
                    scrollToStep(2)
                }
                .onFailure { error ->
                    errorMessage = error.message ?: context.getString(R.string.device_setup_generate_failed)
                }
            creating = false
        }
    }

    BackHandler(onBack = onBack)

    ScreenScaffold {
        AddDeviceHeader(onBack = onBack)
        Row(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(start = 16.dp, top = 18.dp, end = 18.dp, bottom = 18.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            DeviceSetupStepRail(
                currentStep = currentStep,
                stepCount = stepCount,
                modifier = Modifier.width(38.dp),
                onStepSelected = ::scrollToStep,
            )

            BoxWithConstraints(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxSize(),
            ) {
                val bottomContentPadding = maxHeight * 0.9f
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(scrollState),
                    verticalArrangement = Arrangement.spacedBy(46.dp),
                ) {
                    StepSection(
                        step = 1,
                        onOffsetChanged = { step, offset -> stepOffsets[step] = offset },
                    ) {
                        NameDeviceStep(
                            deviceName = deviceName,
                            creating = creating,
                            created = setupCredential != null,
                            errorMessage = errorMessage,
                            onDeviceNameChange = {
                                deviceName = it
                                errorMessage = null
                            },
                            onSaveDeviceName = ::saveDeviceName,
                        )
                    }
                    StepSection(
                        step = 2,
                        onOffsetChanged = { step, offset -> stepOffsets[step] = offset },
                    ) {
                        OperatingSystemStep(
                            deviceName = setupCredential?.device?.name ?: deviceName,
                            enabled = setupCredential != null,
                            onSelect = { platform ->
                                selectedPlatform = platform
                                scrollToStep(3)
                            },
                        )
                    }
                    StepSection(
                        step = 3,
                        onOffsetChanged = { step, offset -> stepOffsets[step] = offset },
                    ) {
                        PairingInstructionsSection(
                            credential = setupCredential,
                            platform = selectedPlatform,
                            onDesktopLinkCopied = { scrollToStep(4) },
                        )
                    }
                    if (selectedPlatform == PairingPlatform.Desktop) {
                        StepSection(
                            step = 4,
                            onOffsetChanged = { step, offset -> stepOffsets[step] = offset },
                        ) {
                            CompletePairingSection(
                                credential = setupCredential,
                                online = currentDevice?.online == true,
                                onDone = onBack,
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(bottomContentPadding))
                }
            }
        }
    }
}

@Composable
private fun NameDeviceStep(
    deviceName: String,
    creating: Boolean,
    created: Boolean,
    errorMessage: String?,
    onDeviceNameChange: (String) -> Unit,
    onSaveDeviceName: () -> Unit,
) {
    val colors = LocalAAColors.current
    StepTitle(
        title = stringResource(R.string.device_setup_name_title),
        description = stringResource(R.string.device_setup_name_description),
    )
    Text(
        text = stringResource(R.string.device_setup_device_name),
        color = colors.inkSoft,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(top = 28.dp, bottom = 9.dp),
    )
    BasicTextField(
        value = deviceName,
        onValueChange = onDeviceNameChange,
        enabled = !creating,
        singleLine = true,
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(colors.raisedSurface)
            .border(1.dp, colors.border, RoundedCornerShape(12.dp))
            .padding(horizontal = 14.dp),
        textStyle = TextStyle(
            color = colors.ink,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace,
        ),
        cursorBrush = SolidColor(colors.ink),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onSaveDeviceName() }),
        decorationBox = { innerTextField ->
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (deviceName.isBlank()) {
                    Text(
                        text = stringResource(R.string.device_setup_name_placeholder),
                        color = colors.faint,
                        fontSize = 16.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                innerTextField()
            }
        },
    )
    errorMessage?.let { message ->
        Text(
            text = message,
            color = colors.errorText,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 18.sp,
            modifier = Modifier.padding(top = 10.dp),
        )
    }
    PrimarySetupButton(
        label = when {
            created && creating -> stringResource(R.string.device_setup_saving_name)
            created -> stringResource(R.string.device_setup_save_name)
            else -> stringResource(R.string.device_setup_create_device)
        },
        enabled = deviceName.isNotBlank() && !creating,
        loading = creating,
        modifier = Modifier.padding(top = 28.dp),
        onClick = onSaveDeviceName,
    )
}

@Composable
private fun OperatingSystemStep(
    deviceName: String,
    enabled: Boolean,
    onSelect: (PairingPlatform) -> Unit,
) {
    val darkMode = LocalAAColors.current.canvas.luminance() < 0.5f
    StepTitle(
        title = stringResource(R.string.device_setup_os_title),
        description = stringResource(R.string.device_setup_os_description, deviceName),
    )
    Column(
        modifier = Modifier.padding(top = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        OperatingSystemOption(
            icon = { optionEnabled ->
                val colors = LocalAAColors.current
                Box(
                    modifier = Modifier
                        .size(38.dp)
                        .clip(CircleShape)
                        .background(colors.subtle),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Lucide.Monitor,
                        contentDescription = null,
                        tint = if (optionEnabled) colors.inkSoft else colors.faint,
                        modifier = Modifier.size(18.dp),
                    )
                }
            },
            title = stringResource(R.string.device_setup_os_desktop),
            description = stringResource(R.string.device_setup_os_desktop_description),
            enabled = enabled,
            onClick = { onSelect(PairingPlatform.Desktop) },
        )
        OperatingSystemOption(
            icon = {
                Image(
                    painter = painterResource(
                        if (darkMode) {
                            R.drawable.device_icon_dark_linux_offline_3x
                        } else {
                            R.drawable.device_icon_light_linux_offline_3x
                        },
                    ),
                    contentDescription = null,
                    modifier = Modifier.size(38.dp),
                )
            },
            title = stringResource(R.string.device_setup_os_linux),
            description = stringResource(R.string.device_setup_os_linux_description),
            enabled = enabled,
            onClick = { onSelect(PairingPlatform.Linux) },
        )
    }
}

@Composable
private fun PairingInstructionsSection(
    credential: DeviceSetupCredential?,
    platform: PairingPlatform?,
    onDesktopLinkCopied: () -> Unit,
) {
    if (credential == null || platform == null) {
        StepTitle(
            title = stringResource(R.string.device_setup_pair_title),
            description = stringResource(R.string.device_setup_pair_description),
        )
        return
    }

    when (platform) {
        PairingPlatform.Desktop -> DesktopPairingInstructions(
            onDownloadLinkCopied = onDesktopLinkCopied,
        )
        PairingPlatform.Linux -> LinuxPairingInstructions(
            credential = credential,
        )
    }
}

@Composable
private fun CompletePairingSection(
    credential: DeviceSetupCredential?,
    online: Boolean,
    onDone: () -> Unit,
) {
    if (credential == null) return
    if (online) {
        StepTitle(
            title = stringResource(R.string.device_setup_success_title),
            description = stringResource(R.string.device_setup_success_description, credential.device.name),
        )
        PrimarySetupButton(
            label = stringResource(R.string.common_done),
            enabled = true,
            modifier = Modifier.padding(top = 28.dp),
            onClick = onDone,
        )
        return
    }

    StepTitle(
        title = stringResource(R.string.device_setup_desktop_login_title),
        description = stringResource(
            R.string.device_setup_desktop_login_description,
            credential.device.name,
        ),
    )
}

@Composable
private fun DesktopPairingInstructions(
    onDownloadLinkCopied: () -> Unit,
) {
    val uriHandler = LocalUriHandler.current
    StepTitle(
        title = stringResource(R.string.device_setup_desktop_title),
        description = stringResource(R.string.device_setup_desktop_description),
    )
    Text(
        text = stringResource(R.string.device_setup_download_label),
        color = LocalAAColors.current.inkSoft,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(top = 26.dp, bottom = 9.dp),
    )
    CopyableValueBox(
        value = DESKTOP_CONNECTOR_DOWNLOAD_URL,
        onOpen = { runCatching { uriHandler.openUri(DESKTOP_CONNECTOR_DOWNLOAD_URL) } },
        onCopied = onDownloadLinkCopied,
    )
}

@Composable
private fun LinuxPairingInstructions(
    credential: DeviceSetupCredential,
) {
    val colors = LocalAAColors.current
    StepTitle(
        title = stringResource(R.string.device_setup_command_title),
        description = stringResource(R.string.device_setup_command_description, credential.device.name),
    )
    Text(
        text = stringResource(R.string.device_setup_linux_persistence_hint),
        color = colors.muted,
        fontSize = 13.5.sp,
        fontWeight = FontWeight.Medium,
        lineHeight = 20.sp,
        modifier = Modifier.padding(top = 22.dp, bottom = 12.dp),
    )
    CopyableValueBox(
        value = startCommandLines(credential).joinToString(" "),
    )
}

@Composable
private fun StepTitle(
    title: String,
    description: String,
) {
    val colors = LocalAAColors.current
    Text(
        text = title,
        color = colors.ink,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.Bold,
    )
    Text(
        text = description,
        color = colors.muted,
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.padding(top = 12.dp),
    )
}

@Composable
private fun OperatingSystemOption(
    icon: @Composable (enabled: Boolean) -> Unit,
    title: String,
    description: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 84.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(colors.raisedSurface)
            .border(1.dp, colors.border, RoundedCornerShape(12.dp))
            .noRippleClickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        icon(enabled)
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = title,
                color = if (enabled) colors.ink else colors.faint,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = description,
                color = if (enabled) colors.muted else colors.faint,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 17.sp,
            )
        }
        Icon(
            imageVector = Lucide.ChevronRight,
            contentDescription = null,
            tint = if (enabled) colors.faint else colors.border,
            modifier = Modifier.size(17.dp),
        )
    }
}

@Composable
private fun CopyableValueBox(
    value: String,
    onOpen: (() -> Unit)? = null,
    onCopied: (() -> Unit)? = null,
) {
    val colors = LocalAAColors.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var copied by remember(value) { mutableStateOf(false) }

    fun copyValue() {
        clipboard.setText(AnnotatedString(value))
        copied = true
        onCopied?.invoke()
        scope.launch {
            delay(2_000)
            copied = false
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(58.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(colors.subtle)
            .border(1.dp, colors.border, RoundedCornerShape(12.dp)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxSize()
                .then(if (onOpen == null) Modifier else Modifier.noRippleClickable(onClick = onOpen))
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 14.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text(
                text = value,
                color = colors.inkSoft,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
            )
        }
        Box(
            modifier = Modifier
                .size(50.dp)
                .noRippleClickable(onClick = ::copyValue),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = if (copied) Lucide.Check else Lucide.Copy,
                contentDescription = stringResource(R.string.device_setup_copy_value),
                tint = colors.muted,
                modifier = Modifier.size(17.dp),
            )
        }
    }
}

@Composable
private fun PrimarySetupButton(
    label: String,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    loading: Boolean = false,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(50.dp)
            .clip(CircleShape)
            .background(colors.primaryAction.copy(alpha = if (enabled) 1f else 0.42f))
            .noRippleClickable(enabled = enabled, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                color = colors.onPrimaryAction,
                strokeWidth = 2.dp,
            )
            Spacer(modifier = Modifier.width(8.dp))
        }
        Text(
            text = label,
            color = colors.onPrimaryAction,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun AddDeviceHeader(onBack: () -> Unit) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(62.dp)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(colors.subtle)
                .noRippleClickable(onClick = onBack),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Lucide.ChevronLeft,
                contentDescription = stringResource(R.string.common_back),
                tint = colors.inkSoft,
                modifier = Modifier.size(22.dp),
            )
        }
        Text(
            text = stringResource(R.string.device_setup_page_title),
            color = colors.ink,
            fontSize = 22.sp,
            fontWeight = FontWeight.ExtraBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun DeviceSetupStepRail(
    currentStep: Int,
    stepCount: Int,
    modifier: Modifier = Modifier,
    onStepSelected: (Int) -> Unit,
) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        (1..stepCount).forEach { step ->
            SetupStepNumber(
                number = step,
                active = step == currentStep,
                onClick = { onStepSelected(step) },
            )
            if (step < stepCount) {
                SetupStepConnector()
            }
        }
    }
}

@Composable
private fun StepSection(
    step: Int,
    onOffsetChanged: (step: Int, offset: Int) -> Unit,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .onGloballyPositioned { coordinates ->
                onOffsetChanged(step, coordinates.positionInParent().y.roundToInt())
            },
    ) {
        content()
    }
}

@Composable
private fun SetupStepNumber(
    number: Int,
    active: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val background = if (active) colors.primaryAction else colors.subtle
    val foreground = if (active) colors.onPrimaryAction else colors.faint
    Box(
        modifier = Modifier
            .size(34.dp)
            .clip(CircleShape)
            .background(background)
            .then(if (active) Modifier else Modifier.border(1.dp, colors.border, CircleShape))
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = number.toString(),
            color = foreground,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun SetupStepConnector() {
    val colors = LocalAAColors.current
    Box(
        modifier = Modifier
            .width(1.dp)
            .height(54.dp)
            .background(colors.border),
    )
}

private enum class PairingPlatform {
    Desktop,
    Linux,
}
