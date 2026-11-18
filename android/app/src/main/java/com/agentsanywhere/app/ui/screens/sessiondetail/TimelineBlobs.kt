package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.AttachmentTransferException
import com.agentsanywhere.app.api.SessionBlobErrors
import com.agentsanywhere.app.feature.sessiondetail.LoadedBlob
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessiondetail.TimelineBlobKind
import com.agentsanywhere.app.feature.sessiondetail.TimelineBlobRef
import com.agentsanywhere.app.feature.sessiondetail.blobKind
import com.agentsanywhere.app.feature.sessiondetail.displayKind
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Copy
import com.composables.icons.lucide.File
import com.composables.icons.lucide.FileText
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import kotlinx.coroutines.launch

private sealed interface BlobRowState {
    data object Idle : BlobRowState
    data object Loading : BlobRowState
    data class Loaded(val blob: LoadedBlob) : BlobRowState
    data class Failed(val message: String) : BlobRowState
}

/** The session whose device blobs the timeline rows load. */
internal class TimelineBlobAccess(val sessionId: String, val controller: SessionDetailController)

internal val LocalTimelineBlobAccess = staticCompositionLocalOf<TimelineBlobAccess?> { null }

/** The large fields of a timeline item that are kept on the device, each with a load action. */
@Composable
internal fun TimelineBlobRefs(
    refs: List<TimelineBlobRef>,
    darkMode: Boolean,
    modifier: Modifier = Modifier,
) {
    if (refs.isEmpty()) return
    val access = LocalTimelineBlobAccess.current ?: return
    val sessionId = access.sessionId
    val controller = access.controller
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        refs.forEach { ref ->
            TimelineBlobRow(ref = ref, sessionId = sessionId, controller = controller, darkMode = darkMode)
        }
    }
}

@Composable
private fun TimelineBlobRow(
    ref: TimelineBlobRef,
    sessionId: String,
    controller: SessionDetailController,
    darkMode: Boolean,
) {
    val context = LocalContext.current
    val colors = LocalAAColors.current
    val scope = rememberCoroutineScope()
    val kind = ref.displayKind()
    var state by remember(sessionId, ref.blobId) {
        mutableStateOf<BlobRowState>(
            controller.cachedBlob(sessionId, ref.blobId)?.let { BlobRowState.Loaded(it) } ?: BlobRowState.Idle,
        )
    }
    var showText by remember(sessionId, ref.blobId) { mutableStateOf(false) }
    var showImage by remember(sessionId, ref.blobId) { mutableStateOf(false) }

    fun present(blob: LoadedBlob) {
        when (blob) {
            is LoadedBlob.Text -> showText = true
            is LoadedBlob.StoredFile -> when (kind) {
                TimelineBlobKind.Image -> showImage = true
                else -> if (!openBlobFile(context, blob)) {
                    state = BlobRowState.Failed(context.getString(R.string.session_blob_open_failed))
                }
            }
        }
    }

    fun activate() {
        when (val current = state) {
            BlobRowState.Loading -> Unit
            is BlobRowState.Loaded -> present(current.blob)
            BlobRowState.Idle, is BlobRowState.Failed -> {
                state = BlobRowState.Loading
                scope.launch {
                    controller.loadBlob(sessionId, ref, context.cacheDir)
                        .onSuccess { blob ->
                            state = BlobRowState.Loaded(blob)
                            // An image shows inline once loaded; text and files open right away.
                            if (kind != TimelineBlobKind.Image) present(blob)
                        }
                        .onFailure { error -> state = BlobRowState.Failed(blobErrorMessage(context, error)) }
                }
            }
        }
    }

    val loadedImage = (state as? BlobRowState.Loaded)?.blob as? LoadedBlob.StoredFile
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (kind == TimelineBlobKind.Image && loadedImage != null) {
            val attachment = remember(loadedImage.file) { loadedImage.toPendingAttachment() }
            PendingAttachmentImage(
                attachment = attachment,
                modifier = Modifier
                    .size(width = 196.dp, height = 142.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .noRippleClickable { showImage = true },
                contentScale = ContentScale.Crop,
            )
        }
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .background(colors.sessionTimelineActivitySurface)
                .noRippleClickable(onClick = ::activate)
                .padding(horizontal = 10.dp, vertical = 7.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = blobIcon(kind),
                contentDescription = null,
                tint = colors.muted,
                modifier = Modifier.size(15.dp),
            )
            Text(
                text = blobRowTitle(ref, kind),
                color = colors.muted,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Text(
                text = when {
                    state == BlobRowState.Loading -> stringResource(R.string.session_blob_loading)
                    kind == TimelineBlobKind.Text -> stringResource(R.string.session_blob_show_full_text)
                    kind == TimelineBlobKind.Image && loadedImage == null -> stringResource(R.string.session_blob_load_image)
                    else -> stringResource(R.string.session_blob_open_file)
                },
                color = colors.ink,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
        }
        (state as? BlobRowState.Failed)?.let { failed ->
            Text(
                text = failed.message,
                color = colors.errorText,
                fontSize = 12.sp,
                lineHeight = 16.sp,
            )
        }
    }

    val loadedText = (state as? BlobRowState.Loaded)?.blob as? LoadedBlob.Text
    if (showText && loadedText != null) {
        BlobFullTextDialog(
            title = ref.label,
            text = loadedText.text,
            mediaType = ref.mediaType,
            darkMode = darkMode,
            onDismiss = { showText = false },
        )
    }
    if (showImage && loadedImage != null) {
        val preview = remember(loadedImage.file) { AttachmentPreview.Local(loadedImage.toPendingAttachment()) }
        AttachmentPreviewDialog(
            preview = preview,
            sessionImages = emptyList(),
            sessionId = sessionId,
            controller = controller,
            toastHostState = remember { SnackbarHostState() },
            onDownload = {},
            onDismiss = { showImage = false },
        )
    }
}

@Composable
private fun blobRowTitle(ref: TimelineBlobRef, kind: TimelineBlobKind): String {
    val name = if (ref.kind == TimelineBlobKind.Image && ref.label == "content") {
        stringResource(R.string.session_blob_image)
    } else {
        ref.label
    }
    val parts = listOfNotNull(
        name,
        ref.mediaType.substringBefore(';').trim().takeIf { kind == TimelineBlobKind.Other && it.isNotBlank() },
        ref.bytes.takeIf { it > 0 }?.let(::formatBytes),
        stringResource(R.string.session_blob_stored_on_device),
    )
    return parts.joinToString(" · ")
}

private fun blobIcon(kind: TimelineBlobKind): ImageVector = when (kind) {
    TimelineBlobKind.Text -> Lucide.FileText
    TimelineBlobKind.Image, TimelineBlobKind.Other -> Lucide.File
}

private fun LoadedBlob.StoredFile.toPendingAttachment(): PendingAttachment = PendingAttachment(
    uri = Uri.fromFile(file),
    name = name,
    mediaType = mediaType,
    size = file.length(),
    uploadState = AttachmentUploadState.Uploaded,
)

/** Hands a cached blob file to another app; false when no app can open it. */
private fun openBlobFile(context: Context, blob: LoadedBlob.StoredFile): Boolean {
    val uri = runCatching {
        FileProvider.getUriForFile(context, "${context.packageName}.attachments", blob.file)
    }.getOrNull() ?: return false
    val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, blob.mediaType.substringBefore(';').trim().ifBlank { "application/octet-stream" })
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    return runCatching { context.startActivity(intent) }.isSuccess
}

private fun blobErrorMessage(context: Context, error: Throwable): String {
    val code = (error as? ApiException)?.errorCode
    val resource = when {
        code == SessionBlobErrors.NOT_FOUND -> R.string.session_blob_error_not_found
        code == SessionBlobErrors.DEVICE_OFFLINE -> R.string.session_blob_error_offline
        code == SessionBlobErrors.TOO_LARGE -> R.string.session_blob_error_too_large
        code == SessionBlobErrors.INCOMPLETE || code == SessionBlobErrors.UNREADABLE ||
            error is AttachmentTransferException -> R.string.session_blob_error_incomplete
        // An encrypted-mode refusal already carries a localized message.
        error is ApiException && code != null && code.startsWith("e2ee") -> return error.message
        else -> R.string.session_blob_error_generic
    }
    return context.getString(resource)
}

@Composable
private fun BlobFullTextDialog(
    title: String,
    text: String,
    mediaType: String,
    darkMode: Boolean,
    onDismiss: () -> Unit,
) {
    val colors = LocalAAColors.current
    val clipboard = LocalClipboardManager.current
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        FullscreenSystemBars(backgroundColor = colors.canvas, useDarkIcons = !colors.isDark)
        val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
        val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(colors.canvas)
                .padding(top = statusTop + 8.dp, bottom = navBottom + 12.dp, start = 12.dp, end = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.session_blob_full_text_title),
                        color = colors.ink,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = title,
                        color = colors.muted,
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                BlobDialogButton(
                    icon = Lucide.Copy,
                    contentDescription = stringResource(R.string.common_copy),
                    onClick = { clipboard.setText(AnnotatedString(text)) },
                )
                BlobDialogButton(
                    icon = Lucide.X,
                    contentDescription = stringResource(R.string.common_close),
                    onClick = onDismiss,
                )
            }
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                SoraCodeBlock(
                    text = text,
                    languageHint = if (blobKind(mediaType) == TimelineBlobKind.Text && mediaType.contains("json")) "json" else null,
                    darkMode = darkMode,
                    fixedHeight = maxHeight,
                )
            }
        }
    }
}

@Composable
private fun BlobDialogButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(CircleShape)
            .background(colors.subtle)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = colors.ink,
            modifier = Modifier.size(19.dp),
        )
    }
}
