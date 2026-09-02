package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.Context
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
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
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.AttachmentImageRequest
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessiondetail.TimelineAttachment
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Download
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import com.valentinilk.shimmer.shimmer
import kotlinx.coroutines.launch
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

internal fun <T> List<T>.updateItemById(
    id: String,
    itemId: (T) -> String,
    transform: (T) -> T,
): List<T> {
    return map { item ->
        if (itemId(item) == id) transform(item) else item
    }
}

internal sealed interface AttachmentPreview {
    data class Local(val attachment: PendingAttachment) : AttachmentPreview
    data class Remote(val attachment: TimelineAttachment) : AttachmentPreview
}

private val AttachmentPreview.stableId: String
    get() = when (this) {
        is AttachmentPreview.Local -> "local:${attachment.id}"
        is AttachmentPreview.Remote -> "remote:${attachment.fileId}"
    }

private val AttachmentPreview.name: String
    get() = when (this) {
        is AttachmentPreview.Local -> attachment.name
        is AttachmentPreview.Remote -> attachment.name
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
        previewModel = attachment.localPreviewUri?.let(Uri::parse),
        name = attachment.name,
        modifier = modifier,
        contentScale = contentScale,
        fallbackColor = fallbackColor,
    )
}

@Composable
internal fun AttachmentPreviewDialog(
    preview: AttachmentPreview,
    sessionImages: List<AttachmentPreview>,
    sessionId: String,
    controller: SessionDetailController,
    toastHostState: SnackbarHostState,
    onDownload: (TimelineAttachment) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalAAColors.current
    val palette = attachmentPreviewPalette(colors.isDark)
    val previewItems = remember(preview, sessionImages) {
        (sessionImages + preview).distinctBy(AttachmentPreview::stableId)
    }
    val initialPage = remember(preview.stableId, previewItems) {
        previewItems.indexOfFirst { it.stableId == preview.stableId }.coerceAtLeast(0)
    }
    val pagerState = rememberPagerState(initialPage = initialPage) { previewItems.size }
    val thumbnailState = rememberLazyListState(initialFirstVisibleItemIndex = initialPage)
    val scope = rememberCoroutineScope()

    LaunchedEffect(pagerState.currentPage) {
        thumbnailState.animateScrollToItem(pagerState.currentPage)
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        FullscreenSystemBars(
            backgroundColor = palette.background,
            useDarkIcons = !colors.isDark,
        )
        val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
        val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(palette.background),
        ) {
            HorizontalPager(
                state = pagerState,
                key = { previewItems[it].stableId },
                modifier = Modifier.fillMaxSize(),
            ) { page ->
                PreviewPage(
                    preview = previewItems[page],
                    sessionId = sessionId,
                    controller = controller,
                    palette = palette,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(
                            start = 12.dp,
                            top = statusTop + 68.dp,
                            end = 12.dp,
                            bottom = navBottom + 104.dp,
                        ),
                )
            }

            Row(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = statusTop + 12.dp, end = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                val current = previewItems.getOrNull(pagerState.currentPage)
                if (current is AttachmentPreview.Remote) {
                    PreviewActionButton(
                        icon = Lucide.Download,
                        contentDescription = stringResource(R.string.session_attachment_save),
                        palette = palette,
                        onClick = { onDownload(current.attachment) },
                    )
                }
                PreviewActionButton(
                    icon = Lucide.X,
                    contentDescription = stringResource(R.string.common_close),
                    palette = palette,
                    onClick = onDismiss,
                )
            }

            LazyRow(
                state = thumbnailState,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .padding(bottom = navBottom + 14.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                itemsIndexed(
                    items = previewItems,
                    key = { _, item -> item.stableId },
                ) { index, item ->
                    PreviewThumbnail(
                        preview = item,
                        selected = index == pagerState.currentPage,
                        sessionId = sessionId,
                        controller = controller,
                        palette = palette,
                        onClick = { scope.launch { pagerState.animateScrollToPage(index) } },
                    )
                }
            }

            AAToastHost(
                hostState = toastHostState,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(
                        top = statusTop + 70.dp,
                        start = 22.dp,
                        end = 22.dp,
                    ),
            )
        }
    }
}

@Composable
private fun PreviewPage(
    preview: AttachmentPreview,
    sessionId: String,
    controller: SessionDetailController,
    palette: AttachmentPreviewPalette,
    modifier: Modifier,
) {
    when (preview) {
        is AttachmentPreview.Local -> ZoomableAttachmentImage(
            model = preview.attachment.uri,
            name = preview.name,
            fallbackColor = palette.fallbackText,
            modifier = modifier,
        )
        is AttachmentPreview.Remote -> ZoomableAttachmentImage(
            model = rememberAttachmentImageRequest(sessionId, controller, preview.attachment),
            name = preview.name,
            fallbackColor = palette.fallbackText,
            modifier = modifier,
        )
    }
}

@Composable
private fun PreviewThumbnail(
    preview: AttachmentPreview,
    selected: Boolean,
    sessionId: String,
    controller: SessionDetailController,
    palette: AttachmentPreviewPalette,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(8.dp)
    val selectionModifier = if (selected) {
        Modifier.border(2.dp, palette.selectionBorder, shape)
    } else {
        Modifier
    }
    Box(
        modifier = Modifier
            .size(58.dp)
            .then(selectionModifier)
            .padding(if (selected) 3.dp else 0.dp)
            .clip(shape)
            .background(palette.thumbnailSurface)
            .noRippleClickable(onClick = onClick),
    ) {
        when (preview) {
            is AttachmentPreview.Local -> PendingAttachmentImage(
                attachment = preview.attachment,
                modifier = Modifier.fillMaxSize(),
            )
            is AttachmentPreview.Remote -> RemoteAttachmentImage(
                sessionId = sessionId,
                controller = controller,
                attachment = preview.attachment,
                modifier = Modifier.fillMaxSize(),
                fallbackColor = palette.fallbackText,
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
    previewModel: Any? = null,
    name: String,
    modifier: Modifier,
    contentScale: ContentScale,
    fallbackColor: Color = Color(0xFFA1A1AA),
) {
    val displayModel = model ?: previewModel
    if (displayModel == null) {
        ImageFallback(name = name, fallbackColor = fallbackColor, modifier = modifier)
        return
    }
    SubcomposeAsyncImage(
        model = displayModel,
        contentDescription = name,
        modifier = modifier,
        contentScale = contentScale,
        loading = {
            if (previewModel == null || displayModel == previewModel) {
                ImageLoadingPlaceholder(Modifier.fillMaxSize())
            } else {
                LocalAttachmentPreview(
                    model = previewModel,
                    name = name,
                    contentScale = contentScale,
                    fallbackColor = fallbackColor,
                )
            }
        },
        error = {
            if (previewModel == null || displayModel == previewModel) {
                ImageFallback(
                    name = name,
                    fallbackColor = fallbackColor,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                LocalAttachmentPreview(
                    model = previewModel,
                    name = name,
                    contentScale = contentScale,
                    fallbackColor = fallbackColor,
                )
            }
        },
        success = { SubcomposeAsyncImageContent() },
    )
}

@Composable
private fun LocalAttachmentPreview(
    model: Any,
    name: String,
    contentScale: ContentScale,
    fallbackColor: Color,
) {
    SubcomposeAsyncImage(
        model = model,
        contentDescription = name,
        modifier = Modifier.fillMaxSize(),
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
private fun PreviewActionButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    contentDescription: String,
    palette: AttachmentPreviewPalette,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(46.dp)
            .clip(CircleShape)
            .background(palette.actionSurface)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = palette.actionContent,
            modifier = Modifier.size(22.dp),
        )
    }
}

private data class AttachmentPreviewPalette(
    val background: Color,
    val actionSurface: Color,
    val actionContent: Color,
    val thumbnailSurface: Color,
    val selectionBorder: Color,
    val fallbackText: Color,
)

private fun attachmentPreviewPalette(darkMode: Boolean): AttachmentPreviewPalette {
    return if (darkMode) {
        AttachmentPreviewPalette(
            background = Color.Black,
            actionSurface = Color(0xD93F3F46),
            actionContent = Color(0xFFF4F4F5),
            thumbnailSurface = Color(0xFF27272A),
            selectionBorder = Color(0xFFF4F4F5),
            fallbackText = Color(0xFFA1A1AA),
        )
    } else {
        AttachmentPreviewPalette(
            background = Color(0xFFFDFCFB),
            actionSurface = Color(0xE6E7E5E0),
            actionContent = Color(0xFF4B4B47),
            thumbnailSurface = Color(0xFFF1F0ED),
            selectionBorder = Color(0xFF4B4B47),
            fallbackText = Color(0xFF777777),
        )
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
