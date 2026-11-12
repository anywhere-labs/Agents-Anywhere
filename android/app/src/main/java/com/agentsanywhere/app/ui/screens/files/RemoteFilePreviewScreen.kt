package com.agentsanywhere.app.ui.screens.files

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.files.AUTO_PREVIEW_MAX_BYTES
import com.agentsanywhere.app.feature.files.FilePreviewKind
import com.agentsanywhere.app.feature.files.FilePreviewTarget
import com.agentsanywhere.app.feature.files.FilesController
import com.agentsanywhere.app.feature.files.LocalRemoteFile
import com.agentsanywhere.app.feature.files.MAX_INLINE_WORKSPACE_IMAGE_BYTES
import com.agentsanywhere.app.feature.files.MAX_REMOTE_FILE_DOWNLOAD_BYTES
import com.agentsanywhere.app.feature.files.RemoteFileFailure
import com.agentsanywhere.app.feature.files.RemoteFileInfo
import com.agentsanywhere.app.feature.files.fileExtension
import com.agentsanywhere.app.feature.files.filePreviewKind
import com.agentsanywhere.app.feature.files.preview.PreviewLabels
import com.agentsanywhere.app.feature.files.remoteFileFailure
import com.agentsanywhere.app.feature.files.remoteRootForPath
import com.agentsanywhere.app.feature.files.windowsDriveRoot
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.screens.sessiondetail.FullscreenSystemBars
import com.agentsanywhere.app.ui.screens.sessiondetail.formatBytes
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.Copy
import com.composables.icons.lucide.Download
import com.composables.icons.lucide.ExternalLink
import com.composables.icons.lucide.File
import com.composables.icons.lucide.FileWarning
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Share2
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

/** What the content area of the preview page shows. */
internal sealed interface FilePreviewPhase {
    data object Preparing : FilePreviewPhase
    data object Downloading : FilePreviewPhase
    data object Ready : FilePreviewPhase
    data object Unsupported : FilePreviewPhase
    data object LargeFile : FilePreviewPhase
    data class Failed(val message: String) : FilePreviewPhase
}

internal data class FilePreviewUiState(
    val name: String,
    val path: String,
    val size: Long?,
    val mediaType: String,
    val kind: FilePreviewKind,
    val phase: FilePreviewPhase,
    val localFile: java.io.File? = null,
    val downloadedBytes: Long = 0L,
    val downloading: Boolean = false,
    val pendingAction: FileAction? = null,
)

/**
 * Full-screen preview of a file on a work device, opened from a session link
 * or a file browser. Shows the file when the format is supported and always
 * offers Download, Share and Open with. Links inside Markdown documents open
 * further files on top; Back returns to the previous one.
 */
@Composable
internal fun RemoteFilePreviewDialog(
    target: FilePreviewTarget,
    filesController: FilesController,
    onDismiss: () -> Unit,
) {
    var stack by remember(target) { mutableStateOf(listOf(target)) }
    val colors = LocalAAColors.current
    fun back() {
        if (stack.size > 1) stack = stack.dropLast(1) else onDismiss()
    }
    Dialog(
        onDismissRequest = ::back,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        FullscreenSystemBars(backgroundColor = colors.canvas, useDarkIcons = !colors.isDark)
        val current = stack.last()
        key(current, stack.size) {
            RemoteFilePreviewPage(
                target = current,
                filesController = filesController,
                onBack = ::back,
                onOpenRemotePath = { path ->
                    val root = remoteRootForPath(
                        targetPath = path,
                        deviceOs = if (windowsDriveRoot(path) != null) "windows" else null,
                        fallbackRoot = current.root,
                    )
                    stack = stack + FilePreviewTarget(current.connectorId, root, path)
                },
            )
        }
    }
}

@Composable
private fun RemoteFilePreviewPage(
    target: FilePreviewTarget,
    filesController: FilesController,
    onBack: () -> Unit,
    onOpenRemotePath: (String) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val toastHostState = remember { SnackbarHostState() }
    val performAction = rememberFileActionPerformer(toastHostState)
    val progress = remember { MutableStateFlow(0L) }
    val downloadedBytes by progress.collectAsState()
    var info by remember { mutableStateOf<RemoteFileInfo?>(null) }
    var local by remember { mutableStateOf<LocalRemoteFile?>(null) }
    var phase by remember { mutableStateOf<FilePreviewPhase>(FilePreviewPhase.Preparing) }
    var downloading by remember { mutableStateOf(false) }
    var pendingAction by remember { mutableStateOf<FileAction?>(null) }
    val messages = FilePreviewMessages(
        notFound = stringResource(R.string.file_preview_not_found),
        tooLarge = stringResource(R.string.file_preview_too_large, formatBytes(MAX_REMOTE_FILE_DOWNLOAD_BYTES)),
        offline = stringResource(R.string.file_preview_device_offline),
        fallback = stringResource(R.string.file_preview_failed),
    )

    fun kindOf(file: RemoteFileInfo?): FilePreviewKind = filePreviewKind(file?.name ?: target.name, file?.mediaType)

    fun showError(message: String) {
        scope.launch {
            toastHostState.showSnackbar(AAToastVisuals(message = message, isError = true, timeoutMillis = 3_000L))
        }
    }

    fun download(source: RemoteFileInfo, forPreview: Boolean) {
        if (downloading) return
        downloading = true
        progress.value = 0L
        if (forPreview) phase = FilePreviewPhase.Downloading
        scope.launch {
            filesController.downloadRemoteFile(source, context.cacheDir) { done, _ -> progress.value = done }
                .onSuccess { result ->
                    info = result.info
                    local = result
                    phase = if (kindOf(result.info) == FilePreviewKind.Unsupported) {
                        FilePreviewPhase.Unsupported
                    } else {
                        FilePreviewPhase.Ready
                    }
                    pendingAction?.let { action ->
                        pendingAction = null
                        performAction(action, ActionFile(result.file, result.info.name, result.info.mediaType))
                    }
                }
                .onFailure { error ->
                    pendingAction = null
                    val message = filePreviewErrorMessage(error, messages)
                    if (forPreview) phase = FilePreviewPhase.Failed(message) else showError(message)
                }
            downloading = false
        }
    }

    fun prepare() {
        phase = FilePreviewPhase.Preparing
        scope.launch {
            filesController.prepareRemoteFile(target)
                .onSuccess { prepared ->
                    info = prepared
                    val kind = kindOf(prepared)
                    val cached = filesController.cachedRemoteFile(prepared, context.cacheDir)
                    when {
                        cached != null -> {
                            local = LocalRemoteFile(prepared, cached)
                            phase = if (kind == FilePreviewKind.Unsupported) FilePreviewPhase.Unsupported else FilePreviewPhase.Ready
                        }
                        kind == FilePreviewKind.Unsupported -> phase = FilePreviewPhase.Unsupported
                        prepared.size > AUTO_PREVIEW_MAX_BYTES -> phase = FilePreviewPhase.LargeFile
                        else -> download(prepared, forPreview = true)
                    }
                }
                .onFailure { error -> phase = FilePreviewPhase.Failed(filePreviewErrorMessage(error, messages)) }
        }
    }

    LaunchedEffect(target) { prepare() }

    val current = info
    val state = FilePreviewUiState(
        name = current?.name ?: target.name,
        path = current?.path ?: target.path,
        size = current?.size,
        mediaType = current?.mediaType.orEmpty(),
        kind = kindOf(current),
        phase = phase,
        localFile = local?.file,
        downloadedBytes = downloadedBytes,
        downloading = downloading,
        pendingAction = pendingAction,
    )
    val labels = rememberPreviewLabels()
    val host = remember(target, current?.path, labels) {
        FilePreviewHost(
            remotePath = current?.path ?: target.path,
            labels = labels,
            loadDocumentImage = { path ->
                // Called on a WebView worker thread for images inside Markdown.
                runBlocking {
                    filesController.downloadWorkspaceFile(
                        connectorId = target.connectorId,
                        workspaceRoot = target.root,
                        path = path,
                        cacheDir = context.cacheDir,
                        preferCache = true,
                        maxBytes = MAX_INLINE_WORKSPACE_IMAGE_BYTES,
                    ).getOrNull()?.file
                }
            },
            onOpenRemotePath = onOpenRemotePath,
            onOpenExternalUrl = { url -> openExternalUrl(context, url) },
        )
    }
    FilePreviewScaffold(
        state = state,
        host = host,
        toastHostState = toastHostState,
        onBack = onBack,
        onRetry = ::prepare,
        onDownloadForPreview = { info?.let { download(it, forPreview = true) } },
        onAction = { action ->
            val ready = local
            when {
                ready != null -> performAction(action, ActionFile(ready.file, ready.info.name, ready.info.mediaType))
                phase == FilePreviewPhase.Preparing -> Unit
                else -> {
                    pendingAction = action
                    val source = info
                    if (source == null) prepare() else download(source, forPreview = phase == FilePreviewPhase.LargeFile)
                }
            }
        },
    )
}

/**
 * The preview page itself: header, content for the current phase and the
 * Download / Share / Open with bar. Stateless so it also renders local files.
 */
@Composable
internal fun FilePreviewScaffold(
    state: FilePreviewUiState,
    host: FilePreviewHost,
    toastHostState: SnackbarHostState,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onDownloadForPreview: () -> Unit,
    onAction: (FileAction) -> Unit,
) {
    val colors = LocalAAColors.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    val copiedMessage = stringResource(R.string.common_copied)
    var showSource by remember(state.path) { mutableStateOf(false) }
    val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val navigationBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.canvas),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            Spacer(Modifier.height(statusTop))
            FilePreviewHeader(
                state = state,
                showSource = showSource,
                onBack = onBack,
                onToggleSource = { showSource = it },
                onCopyPath = {
                    clipboard.setText(AnnotatedString(state.path))
                    scope.launch { toastHostState.showSnackbar(AAToastVisuals(message = copiedMessage)) }
                },
            )
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            ) {
                val localFile = state.localFile
                when (val phase = state.phase) {
                    FilePreviewPhase.Preparing -> PreviewProgress(stringResource(R.string.file_preview_preparing))
                    FilePreviewPhase.Downloading -> DownloadProgress(state)
                    FilePreviewPhase.Ready -> if (localFile != null) {
                        FilePreviewBody(
                            file = localFile,
                            name = state.name,
                            kind = state.kind,
                            showSource = showSource,
                            darkMode = colors.isDark,
                            host = host,
                        )
                    }
                    FilePreviewPhase.Unsupported -> FileInfoCard(
                        state = state,
                        icon = Lucide.File,
                        title = stringResource(R.string.file_preview_unsupported_title),
                        body = stringResource(R.string.file_preview_unsupported_body),
                    )
                    FilePreviewPhase.LargeFile -> FileInfoCard(
                        state = state,
                        icon = Lucide.File,
                        title = stringResource(R.string.file_preview_large_title, formatBytes(state.size ?: 0L)),
                        body = stringResource(R.string.file_preview_large_body),
                        actionLabel = stringResource(R.string.file_preview_large_action),
                        onActionClick = onDownloadForPreview,
                    )
                    is FilePreviewPhase.Failed -> FileInfoCard(
                        state = state,
                        icon = Lucide.FileWarning,
                        title = phase.message,
                        body = null,
                        actionLabel = stringResource(R.string.common_retry),
                        onActionClick = onRetry,
                    )
                }
            }
            FileActionBar(
                state = state,
                bottomPadding = navigationBottom,
                onAction = onAction,
            )
        }
        AAToastHost(
            hostState = toastHostState,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(top = statusTop + 64.dp, start = 22.dp, end = 22.dp),
        )
    }
}

@Composable
private fun FilePreviewHeader(
    state: FilePreviewUiState,
    showSource: Boolean,
    onBack: () -> Unit,
    onToggleSource: (Boolean) -> Unit,
    onCopyPath: () -> Unit,
) {
    val colors = LocalAAColors.current
    val subtitle = listOfNotNull(
        fileExtension(state.name).uppercase().ifBlank { stringResource(R.string.file_preview_file_type) },
        state.size?.let(::formatBytes),
    ).joinToString(" · ")
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(60.dp)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        HeaderIconButton(icon = Lucide.ChevronLeft, contentDescription = stringResource(R.string.common_back), onClick = onBack)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = state.name,
                color = colors.ink,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
            Text(
                text = subtitle,
                color = colors.muted,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (state.kind.hasSourceView() && state.phase == FilePreviewPhase.Ready) {
            SourceToggle(showSource = showSource, onToggle = onToggleSource)
        }
        HeaderIconButton(icon = Lucide.Copy, contentDescription = stringResource(R.string.files_copy_path), onClick = onCopyPath)
    }
}

@Composable
private fun HeaderIconButton(icon: ImageVector, contentDescription: String, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    Box(
        modifier = Modifier
            .size(38.dp)
            .clip(CircleShape)
            .background(colors.subtle)
            .noRippleClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = contentDescription, tint = colors.inkSoft, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun SourceToggle(showSource: Boolean, onToggle: (Boolean) -> Unit) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .height(32.dp)
            .clip(CircleShape)
            .background(colors.subtle)
            .padding(3.dp),
    ) {
        listOf(false to R.string.file_preview_mode_preview, true to R.string.file_preview_mode_source).forEach { (source, label) ->
            val selected = showSource == source
            Box(
                modifier = Modifier
                    .clip(CircleShape)
                    .background(if (selected) colors.raisedSurface else Color.Transparent)
                    .noRippleClickable { onToggle(source) }
                    .padding(horizontal = 10.dp)
                    .heightIn(min = 26.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(label),
                    color = if (selected) colors.ink else colors.muted,
                    fontSize = 12.sp,
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                )
            }
        }
    }
}

@Composable
private fun DownloadProgress(state: FilePreviewUiState) {
    val colors = LocalAAColors.current
    val total = state.size ?: 0L
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 40.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (total > 0) {
            LinearProgressIndicator(
                progress = { (state.downloadedBytes.toFloat() / total).coerceIn(0f, 1f) },
                color = colors.ink,
                trackColor = colors.subtle,
                modifier = Modifier.fillMaxWidth().height(4.dp).clip(CircleShape),
            )
        } else {
            LinearProgressIndicator(color = colors.ink, trackColor = colors.subtle, modifier = Modifier.fillMaxWidth().height(4.dp))
        }
        Text(
            text = if (total > 0) {
                stringResource(R.string.file_preview_downloading, formatBytes(state.downloadedBytes), formatBytes(total))
            } else {
                stringResource(R.string.file_preview_downloading_indeterminate)
            },
            color = colors.muted,
            fontSize = 13.sp,
            modifier = Modifier.padding(top = 14.dp),
        )
    }
}

@Composable
private fun FileInfoCard(
    state: FilePreviewUiState,
    icon: ImageVector,
    title: String,
    body: String?,
    actionLabel: String? = null,
    onActionClick: () -> Unit = {},
) {
    val colors = LocalAAColors.current
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .size(72.dp)
                .clip(RoundedCornerShape(20.dp))
                .background(colors.subtle),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = colors.inkSoft, modifier = Modifier.size(32.dp))
        }
        Text(
            text = state.name,
            color = colors.ink,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            maxLines = 3,
            overflow = TextOverflow.MiddleEllipsis,
            modifier = Modifier.padding(top = 16.dp),
        )
        Text(
            text = title,
            color = colors.inkSoft,
            fontSize = 14.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 10.dp),
        )
        body?.let {
            Text(
                text = it,
                color = colors.muted,
                fontSize = 13.sp,
                lineHeight = 19.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
        if (state.downloading) {
            val total = state.size ?: 0L
            Text(
                text = if (total > 0) {
                    stringResource(R.string.file_preview_downloading, formatBytes(state.downloadedBytes), formatBytes(total))
                } else {
                    stringResource(R.string.file_preview_downloading_indeterminate)
                },
                color = colors.muted,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 16.dp),
            )
            LinearProgressIndicator(
                progress = { if (total > 0) (state.downloadedBytes.toFloat() / total).coerceIn(0f, 1f) else 0f },
                color = colors.ink,
                trackColor = colors.subtle,
                modifier = Modifier.padding(top = 8.dp).widthIn(max = 240.dp).fillMaxWidth().height(4.dp).clip(CircleShape),
            )
        } else if (actionLabel != null) {
            Box(
                modifier = Modifier
                    .padding(top = 18.dp)
                    .height(40.dp)
                    .clip(CircleShape)
                    .background(colors.primaryAction)
                    .noRippleClickable(onClick = onActionClick)
                    .padding(horizontal = 20.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(actionLabel, color = colors.onPrimaryAction, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun FileActionBar(
    state: FilePreviewUiState,
    bottomPadding: androidx.compose.ui.unit.Dp,
    onAction: (FileAction) -> Unit,
) {
    val colors = LocalAAColors.current
    val enabled = state.phase != FilePreviewPhase.Preparing
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.canvas)
            .border(width = 0.5.dp, color = colors.border.takeIf { it != Color.Transparent } ?: colors.subtle)
            .padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = bottomPadding + 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        listOf(
            Triple(FileAction.Download, Lucide.Download, R.string.file_preview_download),
            Triple(FileAction.Share, Lucide.Share2, R.string.file_preview_share),
            Triple(FileAction.OpenWith, Lucide.ExternalLink, R.string.file_preview_open_with),
        ).forEach { (action, icon, label) ->
            val primary = action == FileAction.Download
            val busy = state.downloading && state.pendingAction == action
            val content = if (primary) colors.onPrimaryAction else colors.inkSoft
            Column(
                modifier = Modifier
                    .weight(1f)
                    .height(58.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(if (primary) colors.primaryAction else colors.subtle)
                    .noRippleClickable(enabled = enabled && !state.downloading) { onAction(action) },
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (busy) {
                    CircularProgressIndicator(color = content, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                } else {
                    Icon(
                        icon,
                        contentDescription = null,
                        tint = content.copy(alpha = if (enabled) 1f else 0.4f),
                        modifier = Modifier.size(19.dp),
                    )
                }
                Text(
                    text = stringResource(label),
                    color = content.copy(alpha = if (enabled) 1f else 0.4f),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 4.dp, start = 4.dp, end = 4.dp),
                )
            }
        }
    }
}

@Composable
internal fun rememberPreviewLabels(): PreviewLabels {
    val context = LocalContext.current
    val chart = stringResource(R.string.file_preview_chart_placeholder)
    val empty = stringResource(R.string.file_preview_empty_document)
    val textOnly = stringResource(R.string.file_preview_text_only_notice)
    val simplified = stringResource(R.string.file_preview_simplified_notice)
    return remember(context, chart, empty, textOnly, simplified) {
        PreviewLabels(
            slide = { context.getString(R.string.file_preview_slide_label, it) },
            chart = chart,
            emptyDocument = empty,
            textOnlyNotice = textOnly,
            simplifiedNotice = simplified,
            rowsTruncated = { context.resources.getQuantityString(R.plurals.file_preview_rows_truncated, it, it) },
            columnsTruncated = { context.resources.getQuantityString(R.plurals.file_preview_columns_truncated, it, it) },
            slidesTruncated = { shown, total -> context.getString(R.string.file_preview_slides_truncated, shown, total) },
        )
    }
}

private data class FilePreviewMessages(
    val notFound: String,
    val tooLarge: String,
    val offline: String,
    val fallback: String,
)

private fun filePreviewErrorMessage(error: Throwable, messages: FilePreviewMessages): String {
    return when (val failure = remoteFileFailure(error)) {
        RemoteFileFailure.NotFound -> messages.notFound
        RemoteFileFailure.TooLarge -> messages.tooLarge
        RemoteFileFailure.DeviceOffline -> messages.offline
        is RemoteFileFailure.Other -> failure.message ?: messages.fallback
    }
}
