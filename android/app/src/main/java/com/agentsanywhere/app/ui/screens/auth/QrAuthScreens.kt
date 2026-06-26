package com.agentsanywhere.app.ui.screens.auth

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.mlkit.vision.MlKitAnalyzer
import androidx.camera.view.CameraController.COORDINATE_SYSTEM_VIEW_REFERENCED
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.feature.auth.AuthController
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.auth.QrLoginState
import com.agentsanywhere.app.feature.auth.QrWaitingState
import com.agentsanywhere.app.model.MobileLoginQrPayload
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import com.agentsanywhere.app.ui.designsystem.AuthErrorNotice
import com.agentsanywhere.app.ui.designsystem.BackPill
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Monitor
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun QrLoginScreen(
    navigate: (AppDestination) -> Unit,
    onMobileLoginQrRequested: (MobileLoginQrPayload) -> Unit,
) {
    val colors = LocalAAColors.current
    val context = LocalContext.current
    val isPreview = LocalInspectionMode.current
    val authController = remember(context) {
        AuthController(
            api = AuthApi(),
            sessionStore = AuthSessionStore(context),
        )
    }
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(QrLoginState()) }
    var hasCameraPermission by remember {
        mutableStateOf(
            isPreview || ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
        )
    }
    val permissionLauncher = if (isPreview) {
        null
    } else {
        rememberLauncherForActivityResult(
            contract = ActivityResultContracts.RequestPermission(),
        ) { granted ->
            hasCameraPermission = granted
            if (!granted) {
                state = state.copy(errorMessage = context.getString(R.string.qr_camera_permission_required))
            }
        }
    }
    val navigateBack = { navigate(AppDestination.LoginMethods) }

    BackHandler {
        navigateBack()
    }

    LaunchedEffect(Unit) {
        if (!isPreview && !hasCameraPermission) {
            permissionLauncher?.launch(Manifest.permission.CAMERA)
        }
    }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp)
                .padding(top = 74.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(128.dp),
        ) {
            BackPill(label = stringResource(R.string.common_back), onClick = navigateBack)
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(34.dp),
            ) {
                QrScannerFrame(
                    hasCameraPermission = hasCameraPermission,
                    isScanning = !state.isSubmitting,
                    onQrValue = { qrValue ->
                        if (state.isSubmitting) return@QrScannerFrame
                        state = state.copy(isSubmitting = true, errorMessage = null)
                        scope.launch {
                            authController.requestMobileLoginFromQr(
                                qrValue = qrValue,
                                deviceName = mobileDeviceName(),
                            ).onSuccess { payload ->
                                state = state.copy(isSubmitting = false)
                                onMobileLoginQrRequested(payload)
                            }.onFailure { error ->
                                state = state.copy(
                                    isSubmitting = false,
                                    errorMessage = error.message ?: context.getString(R.string.qr_start_failed),
                                )
                            }
                        }
                    },
                )
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = stringResource(R.string.qr_help_title),
                        color = colors.ink,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        lineHeight = 21.sp,
                        textAlign = TextAlign.Center,
                    )
                    Text(
                        text = stringResource(R.string.qr_help_body),
                        color = colors.muted,
                        fontSize = 14.sp,
                        lineHeight = 20.sp,
                        textAlign = TextAlign.Center,
                    )
                    state.errorMessage?.let { message ->
                        AuthErrorNotice(
                            modifier = Modifier.padding(top = 8.dp),
                            message = message,
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun QrWaitingScreen(
    navigate: (AppDestination) -> Unit,
    mobileLoginQr: MobileLoginQrPayload?,
) {
    val colors = LocalAAColors.current
    val context = LocalContext.current
    val authController = remember(context) {
        AuthController(
            api = AuthApi(),
            sessionStore = AuthSessionStore(context),
        )
    }
    var state by remember(mobileLoginQr) { mutableStateOf(QrWaitingState()) }
    val navigateBack = { navigate(AppDestination.QrLogin) }

    BackHandler {
        navigateBack()
    }

    LaunchedEffect(mobileLoginQr) {
        val payload = mobileLoginQr
        if (payload == null) {
            state = state.copy(errorMessage = context.getString(R.string.qr_scan_first))
            return@LaunchedEffect
        }
        while (true) {
            val statusResult = authController.mobileLoginStatus(payload)
            val status = statusResult.getOrNull()
            if (status == null) {
                state = state.copy(errorMessage = statusResult.exceptionOrNull()?.message ?: context.getString(R.string.qr_status_failed))
                delay(1_600)
                continue
            }

            state = state.copy(status = status.status, errorMessage = null)
            when (status.status) {
                "approved" -> {
                    state = state.copy(isExchanging = true)
                    authController.exchangeMobileLogin(payload)
                        .onSuccess {
                            state = state.copy(isExchanging = false)
                            navigate(AppDestination.Sessions)
                        }
                        .onFailure { error ->
                            state = state.copy(
                                isExchanging = false,
                                errorMessage = error.message ?: context.getString(R.string.qr_complete_failed),
                            )
                        }
                    return@LaunchedEffect
                }
                "rejected", "expired", "consumed" -> return@LaunchedEffect
            }
            delay(1_600)
        }
    }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp)
                .padding(top = 74.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(42.dp),
        ) {
            BackPill(label = stringResource(R.string.common_back), onClick = navigateBack)
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 168.dp),
                contentAlignment = Alignment.Center,
            ) {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(18.dp),
                ) {
                    QrWaitingMonitorIcon()
                    Text(
                        text = qrWaitingTitle(state),
                        color = colors.ink,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Medium,
                        lineHeight = 22.5.sp,
                        textAlign = TextAlign.Center,
                    )
                    state.errorMessage?.let { message ->
                        Text(
                            text = message,
                            color = MaterialTheme.colorScheme.error,
                            fontSize = 12.5.sp,
                            lineHeight = 16.sp,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun QrScannerFrame(
    hasCameraPermission: Boolean,
    isScanning: Boolean,
    onQrValue: (String) -> Unit,
) {
    val colors = LocalAAColors.current

    Box(
        modifier = Modifier
            .size(286.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(colors.raisedSurface),
        contentAlignment = Alignment.Center,
    ) {
        if (hasCameraPermission) {
            QrCameraPreview(
                isScanning = isScanning,
                onQrValue = onQrValue,
            )
        } else {
            Text(
                modifier = Modifier.padding(horizontal = 28.dp),
                text = stringResource(R.string.qr_camera_access_needed),
                color = colors.muted,
                fontSize = 12.5.sp,
                lineHeight = 16.sp,
                textAlign = TextAlign.Center,
            )
        }
        QrScannerOverlay(isScanning = isScanning && hasCameraPermission)
    }
}

@Composable
private fun QrCameraPreview(
    isScanning: Boolean,
    onQrValue: (String) -> Unit,
) {
    if (LocalInspectionMode.current) return

    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentOnQrValue by rememberUpdatedState(onQrValue)
    val emissionGate = remember { QrEmissionGate() }
    val scanner = remember {
        val options = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
        BarcodeScanning.getClient(options)
    }
    val cameraController = remember {
        LifecycleCameraController(context)
    }

    DisposableEffect(scanner, cameraController) {
        onDispose {
            cameraController.unbind()
            scanner.close()
        }
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { viewContext ->
            PreviewView(viewContext).apply {
                scaleType = PreviewView.ScaleType.FILL_CENTER
                controller = cameraController
            }
        },
        update = { previewView ->
            if (isScanning) {
                cameraController.setImageAnalysisAnalyzer(
                    ContextCompat.getMainExecutor(context),
                    MlKitAnalyzer(
                        listOf(scanner),
                        COORDINATE_SYSTEM_VIEW_REFERENCED,
                        ContextCompat.getMainExecutor(context),
                    ) { result ->
                        val qrValue = result
                            ?.getValue(scanner)
                            ?.firstOrNull()
                            ?.rawValue
                        if (qrValue.isNullOrBlank()) {
                            emissionGate.clearVisibleCode()
                        } else if (emissionGate.shouldEmit(qrValue, SystemClock.elapsedRealtime())) {
                            currentOnQrValue(qrValue)
                        }
                    },
                )
            } else {
                cameraController.clearImageAnalysisAnalyzer()
            }
            cameraController.bindToLifecycle(lifecycleOwner)
            previewView.controller = cameraController
        },
    )
}

@Composable
private fun QrScannerOverlay(isScanning: Boolean) {
    val transition = rememberInfiniteTransition(label = "qr-scan-line")
    val scanProgress by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1800, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "qr-scan-progress",
    )

    Canvas(modifier = Modifier.fillMaxSize()) {
        val inset = 26.dp.toPx()
        val length = 22.dp.toPx()
        val strokeWidth = 2.3.dp.toPx()
        val cornerColor = Color.White
        drawLine(cornerColor, Offset(inset, inset), Offset(inset + length, inset), strokeWidth = strokeWidth, cap = StrokeCap.Square)
        drawLine(cornerColor, Offset(inset, inset), Offset(inset, inset + length), strokeWidth = strokeWidth, cap = StrokeCap.Square)
        drawLine(cornerColor, Offset(size.width - inset, inset), Offset(size.width - inset - length, inset), strokeWidth = strokeWidth, cap = StrokeCap.Square)
        drawLine(cornerColor, Offset(size.width - inset, inset), Offset(size.width - inset, inset + length), strokeWidth = strokeWidth, cap = StrokeCap.Square)
        drawLine(cornerColor, Offset(inset, size.height - inset), Offset(inset + length, size.height - inset), strokeWidth = strokeWidth, cap = StrokeCap.Square)
        drawLine(cornerColor, Offset(inset, size.height - inset), Offset(inset, size.height - inset - length), strokeWidth = strokeWidth, cap = StrokeCap.Square)
        drawLine(cornerColor, Offset(size.width - inset, size.height - inset), Offset(size.width - inset - length, size.height - inset), strokeWidth = strokeWidth, cap = StrokeCap.Square)
        drawLine(cornerColor, Offset(size.width - inset, size.height - inset), Offset(size.width - inset, size.height - inset - length), strokeWidth = strokeWidth, cap = StrokeCap.Square)
        if (isScanning) {
            val lineY = inset + ((size.height - inset * 2f) * scanProgress)
            drawLine(
                color = Color(0xFF4F7BFF),
                start = Offset(size.width * 0.24f, lineY),
                end = Offset(size.width * 0.76f, lineY),
                strokeWidth = 1.6.dp.toPx(),
                cap = StrokeCap.Round,
            )
        }
    }
}

@Composable
private fun QrWaitingMonitorIcon() {
    val colors = LocalAAColors.current

    androidx.compose.material3.Icon(
        imageVector = Lucide.Monitor,
        contentDescription = null,
        tint = colors.ink,
        modifier = Modifier.size(width = 64.dp, height = 52.dp),
    )
}

@Composable
private fun qrWaitingTitle(state: QrWaitingState): String {
    return when {
        state.isExchanging -> stringResource(R.string.qr_completing)
        state.status == "rejected" -> stringResource(R.string.qr_rejected)
        state.status == "expired" -> stringResource(R.string.qr_expired)
        state.status == "consumed" -> stringResource(R.string.qr_consumed)
        else -> stringResource(R.string.qr_waiting)
    }
}

private fun mobileDeviceName(): String {
    val manufacturer = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
    val model = Build.MODEL.orEmpty()
    return listOf(manufacturer, model)
        .filter { it.isNotBlank() }
        .joinToString(" ")
        .ifBlank { "Android" }
}

private class QrEmissionGate {
    private var lastVisibleQrValue: String? = null
    private var lastEmissionAtMillis: Long = 0

    fun clearVisibleCode() {
        lastVisibleQrValue = null
    }

    fun shouldEmit(qrValue: String, nowMillis: Long): Boolean {
        val sameVisibleQr = qrValue == lastVisibleQrValue
        if (sameVisibleQr && nowMillis - lastEmissionAtMillis < SameQrRetryDelayMillis) {
            return false
        }
        lastVisibleQrValue = qrValue
        lastEmissionAtMillis = nowMillis
        return true
    }

    companion object {
        private const val SameQrRetryDelayMillis = 1_200L
    }
}

@Preview(name = "QR Login Light", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun QrLoginLightPreview() {
    AgentsAnywhereTheme {
        QrLoginScreen(navigate = {}, onMobileLoginQrRequested = {})
    }
}

@Preview(
    name = "QR Login Dark",
    showBackground = true,
    widthDp = 390,
    heightDp = 844,
    uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES,
)
@Composable
private fun QrLoginDarkPreview() {
    AgentsAnywhereTheme {
        QrLoginScreen(navigate = {}, onMobileLoginQrRequested = {})
    }
}

@Preview(name = "QR Waiting Light", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun QrWaitingLightPreview() {
    AgentsAnywhereTheme {
        QrWaitingScreen(navigate = {}, mobileLoginQr = null)
    }
}

@Preview(
    name = "QR Waiting Dark",
    showBackground = true,
    widthDp = 390,
    heightDp = 844,
    uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES,
)
@Composable
private fun QrWaitingDarkPreview() {
    AgentsAnywhereTheme {
        QrWaitingScreen(navigate = {}, mobileLoginQr = null)
    }
}
