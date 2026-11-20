package dev.agentsanywhere.v3poc.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.mlkit.vision.MlKitAnalyzer
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import dev.agentsanywhere.v3poc.R
import java.util.concurrent.ExecutionException

@Composable
internal fun PairingScanner(enabled: Boolean, onScan: (String) -> Unit, onError: (Int) -> Unit) {
    val context = LocalContext.current
    var scanning by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scanning = true else onError(R.string.connection_camera_permission)
    }

    OutlinedButton(enabled = enabled, onClick = {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            scanning = true
        } else {
            permission.launch(Manifest.permission.CAMERA)
        }
    }) { Text(stringResource(R.string.connection_scan)) }

    if (scanning) {
        AlertDialog(
            onDismissRequest = { scanning = false },
            title = { Text(stringResource(R.string.connection_scan)) },
            text = {
                CameraPreview(
                    onScan = { value -> scanning = false; onScan(value) },
                    onUnavailable = { scanning = false; onError(R.string.connection_camera_unavailable) },
                )
            },
            confirmButton = {
                TextButton(onClick = { scanning = false }) { Text(stringResource(R.string.connection_cancel)) }
            },
        )
    }
}

@Composable
private fun CameraPreview(onScan: (String) -> Unit, onUnavailable: () -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val controller = remember(context) { LifecycleCameraController(context) }
    val reportScan by rememberUpdatedState(onScan)
    val reportUnavailable by rememberUpdatedState(onUnavailable)

    AndroidView(modifier = Modifier.fillMaxWidth().aspectRatio(1f), factory = {
        PreviewView(it).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            this.controller = controller
        }
    })
    DisposableEffect(controller, owner) {
        val executor = ContextCompat.getMainExecutor(context)
        val options = BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        val scanner = BarcodeScanning.getClient(options)
        var active = true
        controller.setEnabledUseCases(CameraController.IMAGE_ANALYSIS)
        controller.setImageAnalysisAnalyzer(executor, MlKitAnalyzer(
            listOf(scanner), ImageAnalysis.COORDINATE_SYSTEM_ORIGINAL, executor,
        ) { result ->
            val value = result?.getValue(scanner)?.firstOrNull()?.rawValue
            if (active && !value.isNullOrBlank()) {
                active = false
                reportScan(value)
            }
        })
        val ready = controller.initializationFuture
        ready.addListener({
            if (active) {
                try {
                    ready.get()
                    if (!controller.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) {
                        controller.cameraSelector = CameraSelector.DEFAULT_FRONT_CAMERA
                    }
                    controller.bindToLifecycle(owner)
                } catch (_: ExecutionException) {
                    reportUnavailable()
                } catch (_: IllegalStateException) {
                    reportUnavailable()
                } catch (_: IllegalArgumentException) {
                    reportUnavailable()
                } catch (_: SecurityException) {
                    reportUnavailable()
                }
            }
        }, executor)
        onDispose {
            active = false
            controller.clearImageAnalysisAnalyzer()
            controller.unbind()
            scanner.close()
        }
    }
}
