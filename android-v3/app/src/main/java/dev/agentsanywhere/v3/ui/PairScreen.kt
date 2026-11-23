package dev.agentsanywhere.v3.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import dev.agentsanywhere.v3.core.pairing.PairingPayload
import dev.agentsanywhere.v3.core.pairing.keyFingerprint
import dev.agentsanywhere.v3.design.AAFonts
import dev.agentsanywhere.v3.design.AAText
import dev.agentsanywhere.v3.design.continuousRect
import dev.agentsanywhere.v3.model.userMessage
import kotlinx.coroutines.launch
import java.util.concurrent.Executors

/**
 * Pairing with an encrypted device: scan the `aa-pair://v1/…` QR code it shows (or paste the link). The code pins the
 * device's key; the first handshake is Noise IKpsk2 with the one-time PSK, later ones IK with this phone's key.
 */
@Composable
fun PairScreen(initialUri: String?) {
    val app = LocalApp.current
    val nav = LocalNavigator.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pasted by remember { mutableStateOf(initialUri ?: "") }
    var scanned by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var cameraAllowed by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { cameraAllowed = it }
    LaunchedEffect(Unit) { if (!cameraAllowed) permission.launch(Manifest.permission.CAMERA) }

    val candidate = scanned ?: pasted.trim().takeIf { it.startsWith(PairingPayload.PREFIX) }
    val preview = candidate?.let { runCatching { PairingPayload.parse(it) } }

    fun pair(uri: String) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                app.model.pair(uri)
                val id = PairingPayload.parse(uri).deviceId
                nav.pop()
                nav.push(Route.Device(id))
            } catch (e: Throwable) {
                error = e.userMessage()
                scanned = null
            } finally {
                busy = false
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        NavBar(title = "配对加密设备", onBack = { nav.pop() })
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))) {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 12.dp).fillMaxWidth().aspectRatio(1f).clip(continuousRect(20.dp)).background(Color.Black),
                contentAlignment = Alignment.Center) {
                if (cameraAllowed && scanned == null) {
                    QrScanner { text -> if (text.startsWith(PairingPayload.PREFIX) && scanned == null) scanned = text }
                    Box(Modifier.fillMaxWidth(0.62f).aspectRatio(1f).border(3.dp, Color.White.copy(alpha = 0.9f), continuousRect(24.dp)))
                } else {
                    AAText(if (scanned != null) "已识别配对码" else "需要相机权限才能扫码；也可以在下面粘贴配对链接。",
                        Modifier.padding(24.dp), font = AAFonts.subheadline, color = Color.White, align = androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
            AAText("在工作电脑上打开 Agents Anywhere Desktop 的「安全」页，或运行 Connector 的配对命令，屏幕上会显示配对二维码。二维码只在设备上显示，从不经过服务器。",
                Modifier.padding(horizontal = 32.dp), font = AAFonts.footnote, color = Ios.colors.secondaryText)
            GroupedSection(header = "配对链接") {
                TextFieldRow(pasted, { pasted = it; scanned = null }, "aa-pair://v1/…", mono = true, imeAction = ImeAction.Done, separator = false)
            }
            preview?.let { result ->
                GroupedSection(header = "设备") {
                    result.onSuccess { p ->
                        ListRow(app.model.device(p.deviceId)?.name ?: p.deviceId, subtitle = "设备 ID：${p.deviceId}", symbol = "Monitor")
                        ListRow("设备密钥指纹", subtitle = keyFingerprint(p.device_pub), symbol = "KeyRound", separator = false)
                    }.onFailure { e -> ListRow("无法使用这个配对码", subtitle = e.userMessage(), symbol = "CircleAlert", symbolTint = Ios.colors.red, separator = false) }
                }
            }
            error?.let { GroupedSection { ListRow("配对失败", subtitle = it, symbol = "CircleAlert", symbolTint = Ios.colors.red, separator = false) } }
            Box(Modifier.padding(horizontal = 20.dp, vertical = 20.dp)) {
                ProminentButton("配对", enabled = preview?.isSuccess == true, loading = busy) { candidate?.let(::pair) }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

/** CameraX preview + ML Kit QR detection (bundled model). Reports each decoded text. */
@OptIn(ExperimentalGetImage::class)
@Composable
private fun QrScanner(onText: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val scanner = remember { BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()) }
    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    DisposableEffect(lifecycle) {
        val future = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        future.addListener({
            provider = future.get()
            val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
            val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(executor) { proxy ->
                val media = proxy.image
                if (media == null) { proxy.close(); return@setAnalyzer }
                scanner.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
                    .addOnSuccessListener { codes -> codes.firstNotNullOfOrNull { it.rawValue }?.let { v -> previewView.post { onText(v) } } }
                    .addOnCompleteListener { proxy.close() }
            }
            runCatching {
                provider?.unbindAll()
                provider?.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            provider?.unbindAll()
            scanner.close()
            executor.shutdown()
        }
    }
    AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
}
