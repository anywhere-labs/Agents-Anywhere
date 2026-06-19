package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.Context
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil3.compose.SubcomposeAsyncImage
import coil3.compose.SubcomposeAsyncImageContent
import coil3.network.NetworkHeaders
import coil3.network.httpHeaders
import coil3.request.ImageRequest
import coil3.request.crossfade
import com.agentsanywhere.app.feature.sessiondetail.AttachmentImageRequest
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessiondetail.TimelineAttachment
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.valentinilk.shimmer.shimmer
import me.saket.telephoto.zoomable.coil3.ZoomableAsyncImage

internal data class PendingAttachment(
    val uri: Uri,
    val name: String,
    val mediaType: String,
    val size: Long,
    val id: String = uri.toString(),
    val uploadState: AttachmentUploadState = AttachmentUploadState.Uploading,
    val remote: TimelineAttachment? = null,
    val errorMessage: String? = null,
) {
    val isImage: Boolean
        get() = mediaType.startsWith("image/")
}

internal enum class AttachmentUploadState {
    Uploading,
    Uploaded,
    Failed,
}

internal sealed interface AttachmentPreview {
    data class Local(val attachment: PendingAttachment) : AttachmentPreview
    data class Remote(val attachment: TimelineAttachment) : AttachmentPreview
}

@Composable
internal fun PendingAttachmentImage(
    attachment: PendingAttachment,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Crop,
) {
    AttachmentImage(
        model = attachment.uri,
        name = attachment.name,
        modifier = modifier,
        contentScale = contentScale,
    )
}

@Composable
internal fun RemoteAttachmentImage(
    sessionId: String,
    controller: SessionDetailController,
    attachment: TimelineAttachment,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Crop,
    fallbackColor: Color = Color(0xFFA1A1AA),
) {
    AttachmentImage(
        model = rememberAttachmentImageRequest(sessionId, controller, attachment),
        name = attachment.name,
        modifier = modifier,
        contentScale = contentScale,
        fallbackColor = fallbackColor,
    )
}

@Composable
internal fun AttachmentPreviewDialog(
    preview: AttachmentPreview,
    sessionId: String,
    controller: SessionDetailController,
    onDismiss: () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        FullscreenBlackSystemBars()
        val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
        val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black),
        ) {
            val imageModifier = Modifier
                .fillMaxSize()
                .padding(
                    start = 18.dp,
                    top = statusTop + 18.dp,
                    end = 18.dp,
                    bottom = navBottom + 18.dp,
                )
            when (preview) {
                is AttachmentPreview.Local -> ZoomableAttachmentImage(
                    model = preview.attachment.uri,
                    name = preview.attachment.name,
                    fallbackColor = Color(0xFFE4E4E7),
                    modifier = imageModifier,
                )
                is AttachmentPreview.Remote -> ZoomableAttachmentImage(
                    model = rememberAttachmentImageRequest(sessionId, controller, preview.attachment),
                    name = preview.attachment.name,
                    fallbackColor = Color(0xFFE4E4E7),
                    modifier = imageModifier,
                )
            }
            PreviewCloseButton(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = statusTop + 22.dp, end = 26.dp),
                onClick = onDismiss,
            )
        }
    }
}

internal fun formatBytes(size: Long): String {
    return when {
        size < 1024 -> "$size B"
        size < 1024 * 1024 -> "${(size / 1024.0).formatOneDecimal()} KB"
        else -> "${(size / 1024.0 / 1024.0).formatOneDecimal()} MB"
    }
}

@Composable
private fun AttachmentImage(
    model: Any?,
    name: String,
    modifier: Modifier,
    contentScale: ContentScale,
    fallbackColor: Color = Color(0xFFA1A1AA),
) {
    if (model == null) {
        ImageFallback(name = name, fallbackColor = fallbackColor, modifier = modifier)
        return
    }
    SubcomposeAsyncImage(
        model = model,
        contentDescription = name,
        modifier = modifier,
        contentScale = contentScale,
        loading = { ImageLoadingPlaceholder(Modifier.fillMaxSize()) },
        error = {
            ImageFallback(
                name = name,
                fallbackColor = fallbackColor,
                modifier = Modifier.fillMaxSize(),
            )
        },
        success = { SubcomposeAsyncImageContent() },
    )
}

@Composable
private fun ZoomableAttachmentImage(
    model: Any?,
    name: String,
    fallbackColor: Color,
    modifier: Modifier,
) {
    if (model == null) {
        ImageFallback(
            name = name,
            fallbackColor = fallbackColor,
            modifier = modifier,
        )
        return
    }
    ZoomableAsyncImage(
        model = model,
        contentDescription = name,
        modifier = modifier,
        contentScale = ContentScale.Fit,
    )
}

@Composable
private fun PreviewCloseButton(
    modifier: Modifier,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .size(54.dp)
            .clip(CircleShape)
            .background(Color(0xF2262628))
            .border(1.dp, Color(0x33FFFFFF), CircleShape)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.size(22.dp)) {
            val stroke = 2.4.dp.toPx()
            drawLine(
                color = Color.White,
                start = androidx.compose.ui.geometry.Offset(2.dp.toPx(), 2.dp.toPx()),
                end = androidx.compose.ui.geometry.Offset(size.width - 2.dp.toPx(), size.height - 2.dp.toPx()),
                strokeWidth = stroke,
                cap = StrokeCap.Round,
            )
            drawLine(
                color = Color.White,
                start = androidx.compose.ui.geometry.Offset(size.width - 2.dp.toPx(), 2.dp.toPx()),
                end = androidx.compose.ui.geometry.Offset(2.dp.toPx(), size.height - 2.dp.toPx()),
                strokeWidth = stroke,
                cap = StrokeCap.Round,
            )
        }
    }
}

@Composable
private fun rememberAttachmentImageRequest(
    sessionId: String,
    controller: SessionDetailController,
    attachment: TimelineAttachment,
): ImageRequest? {
    val context = LocalContext.current
    val image = remember(sessionId, attachment.fileId) {
        controller.attachmentImageRequest(sessionId, attachment).getOrNull()
    }
    return remember(context, image) {
        image?.toCoilRequest(context)
    }
}

private fun AttachmentImageRequest.toCoilRequest(context: Context): ImageRequest {
    val headers = NetworkHeaders.Builder()
        .set("Authorization", "Bearer $authorizationToken")
        .build()
    return ImageRequest.Builder(context)
        .data(url)
        .httpHeaders(headers)
        .memoryCacheKey(cacheKey)
        .diskCacheKey(cacheKey)
        .crossfade(true)
        .build()
}

@Composable
private fun ImageLoadingPlaceholder(modifier: Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .shimmer()
            .background(Color(0x2227272A)),
    )
}

@Composable
private fun ImageFallback(
    name: String,
    fallbackColor: Color,
    modifier: Modifier,
) {
    Box(
        modifier = modifier.background(Color(0x22000000)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = name,
            color = fallbackColor,
            fontSize = 12.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(10.dp),
        )
    }
}

private fun Double.formatOneDecimal(): String {
    return String.format("%.1f", this)
}
