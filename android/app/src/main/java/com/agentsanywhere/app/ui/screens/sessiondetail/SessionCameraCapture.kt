package com.agentsanywhere.app.ui.screens.sessiondetail

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import java.io.File

@Composable
internal fun SessionCameraCapture(
    onDismiss: () -> Unit,
    onCaptured: (PendingAttachment) -> Unit,
    onError: (String) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val cameraController = remember {
        LifecycleCameraController(context).apply {
            setEnabledUseCases(CameraController.IMAGE_CAPTURE)
        }
    }
    var lensFacing by remember { mutableIntStateOf(CameraSelector.LENS_FACING_BACK) }
    var capturing by remember { mutableStateOf(false) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        FullscreenBlackSystemBars()
        BackHandler(onBack = onDismiss)
        DisposableEffect(cameraController) {
            onDispose { cameraController.unbind() }
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black),
        ) {
            AndroidView(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 174.dp)
                    .fillMaxWidth()
                    .height(458.dp),
                factory = { viewContext ->
                    PreviewView(viewContext).apply {
                        scaleType = PreviewView.ScaleType.FILL_CENTER
                        controller = cameraController
                    }
                },
                update = { previewView ->
                    cameraController.cameraSelector = CameraSelector.Builder()
                        .requireLensFacing(lensFacing)
                        .build()
                    cameraController.bindToLifecycle(lifecycleOwner)
                    previewView.controller = cameraController
                },
            )
            Box(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(start = 32.dp, bottom = 50.dp)
                    .size(52.dp)
                    .noRippleClickable {
                        lensFacing = if (lensFacing == CameraSelector.LENS_FACING_BACK) {
                            CameraSelector.LENS_FACING_FRONT
                        } else {
                            CameraSelector.LENS_FACING_BACK
                        }
                },
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    painter = painterResource(R.drawable.ic_flip_camera_white),
                    contentDescription = "Flip camera",
                    modifier = Modifier.size(26.dp),
                )
            }
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 50.dp)
                    .size(70.dp)
                    .clip(CircleShape)
                    .background(Color.White)
                    .then(
                        if (!capturing) {
                            Modifier.noRippleClickable {
                                capturing = true
                                val photo = cameraPhotoFile(context.cacheDir)
                                val output = ImageCapture.OutputFileOptions.Builder(photo).build()
                                cameraController.takePicture(
                                    output,
                                    ContextCompat.getMainExecutor(context),
                                    object : ImageCapture.OnImageSavedCallback {
                                        override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                                            capturing = false
                                            onCaptured(
                                                PendingAttachment(
                                                    uri = Uri.fromFile(photo),
                                                    name = photo.name,
                                                    mediaType = "image/jpeg",
                                                    size = photo.length(),
                                                ),
                                            )
                                        }

                                        override fun onError(exception: ImageCaptureException) {
                                            capturing = false
                                            onError(exception.message ?: "Could not capture photo.")
                                        }
                                    },
                                )
                            }
                        } else {
                            Modifier
                        },
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .size(62.dp)
                        .clip(CircleShape)
                        .background(Color(0xFFF7F7F7)),
                )
            }
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 6.dp, bottom = 50.dp)
                    .size(52.dp)
                    .noRippleClickable(onClick = onDismiss),
                contentAlignment = Alignment.Center,
            ) {
                XGlyph(Color.White, sizeDp = 28)
            }
        }
    }
}

private fun cameraPhotoFile(cacheDir: File): File {
    val dir = File(cacheDir, "camera-attachments").apply { mkdirs() }
    return File(dir, "AA_${System.currentTimeMillis()}.jpg")
}
