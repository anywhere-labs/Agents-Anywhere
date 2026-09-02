package com.agentsanywhere.app.ui.screens.sessiondetail

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.OpenableColumns
import android.provider.MediaStore
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.AttachmentTransferException
import com.agentsanywhere.app.api.AttachmentTransferFailure
import com.agentsanywhere.app.api.UploadFilePart
import com.agentsanywhere.app.feature.files.FilesController
import com.agentsanywhere.app.feature.realtime.SessionRealtimeController
import com.agentsanywhere.app.feature.sessiondetail.DownloadedAttachment
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessiondetail.SessionMeta
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailState
import com.agentsanywhere.app.feature.sessiondetail.SessionRuntimeStatus
import com.agentsanywhere.app.feature.sessiondetail.SessionTimelineState
import com.agentsanywhere.app.feature.sessiondetail.TimelineAttachment
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessage
import com.agentsanywhere.app.feature.sessiondetail.beginSnapshotLoad
import com.agentsanywhere.app.feature.sessiondetail.cacheDownloadedAttachment
import com.agentsanywhere.app.feature.sessiondetail.completeSnapshotLoad
import com.agentsanywhere.app.feature.sessiondetail.failSnapshotLoad
import com.agentsanywhere.app.feature.sessiondetail.isValidAttachmentMediaType
import com.agentsanywhere.app.feature.sessiondetail.isInternalRuntimeError
import com.agentsanywhere.app.feature.sessiondetail.hasPendingOptimisticSend
import com.agentsanywhere.app.feature.sessiondetail.RuntimeMessageAction
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNotice
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNoticeAction
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNoticeResponseException
import com.agentsanywhere.app.feature.sessiondetail.SESSION_ATTACHMENT_CAPABILITY
import com.agentsanywhere.app.feature.sessiondetail.SESSION_COMMANDS_CAPABILITY
import com.agentsanywhere.app.feature.sessiondetail.SESSION_COMMAND_EXECUTE_CAPABILITY
import com.agentsanywhere.app.feature.sessiondetail.SESSION_INTERRUPT_CAPABILITY
import com.agentsanywhere.app.feature.sessiondetail.SESSION_MODEL_CATALOG_CAPABILITY
import com.agentsanywhere.app.feature.sessiondetail.SESSION_NOTICE_RESPONSE_CAPABILITY
import com.agentsanywhere.app.feature.sessiondetail.SESSION_PERMISSION_CATALOG_CAPABILITY
import com.agentsanywhere.app.feature.sessiondetail.SESSION_SEND_MESSAGE_CAPABILITY
import com.agentsanywhere.app.feature.sessiondetail.SESSION_STEER_CAPABILITY
import com.agentsanywhere.app.feature.sessiondetail.selectionOptions
import com.agentsanywhere.app.feature.sessiondetail.sessionComposerEnabled
import com.agentsanywhere.app.feature.sessiondetail.validatedSelection
import com.agentsanywhere.app.feature.sessions.mergeAuthoritativeSessionMetadata
import com.agentsanywhere.app.feature.sessions.NewSessionCreateOutcome
import com.agentsanywhere.app.feature.sessions.NewSessionCreateDraft
import com.agentsanywhere.app.feature.sessions.NewSessionAttachmentPart
import com.agentsanywhere.app.feature.sessions.NewSessionDraft
import com.agentsanywhere.app.feature.sessions.NewSessionSelections
import com.agentsanywhere.app.feature.sessions.firstMessageRequest
import com.agentsanywhere.app.feature.sessions.NewSessionModelCatalog
import com.agentsanywhere.app.feature.sessions.NewSessionPermissionCatalog
import com.agentsanywhere.app.feature.terminal.RemoteTerminalForegroundService
import com.agentsanywhere.app.feature.terminal.RemoteTerminalPool
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.runtimePermissionLocalizer
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionDetailScreen(
    navigate: (AppDestination) -> Unit,
    sessionId: String?,
    initialSession: AgentSession?,
    preparedSession: NewSessionDraft? = null,
    onCreatePreparedSession: suspend (NewSessionCreateDraft) -> NewSessionCreateOutcome = {
        NewSessionCreateOutcome.Failed(IllegalStateException("Prepared session creation is unavailable."))
    },
    onPreparedSessionCreated: (AgentSession) -> Unit = {},
    onLoadPreparedModelCatalog: suspend (String, String) -> Result<NewSessionModelCatalog> = { _, _ ->
        Result.failure(IllegalStateException("Model catalog is unavailable."))
    },
    onLoadPreparedPermissionCatalog: suspend (String, String) -> Result<NewSessionPermissionCatalog> = { _, _ ->
        Result.failure(IllegalStateException("Permission catalog is unavailable."))
    },
    devices: List<AgentDevice>,
    controller: SessionDetailController,
    realtimeController: SessionRealtimeController,
    filesController: FilesController,
    terminalPool: RemoteTerminalPool,
    composerDraftStore: SessionComposerDraftStore,
    onSessionChanged: (AgentSession) -> Unit = {},
) {
    val colors = LocalAAColors.current
    val darkMode = colors.isDark
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val currentDevices by rememberUpdatedState(devices)
    val currentOnSessionChanged by rememberUpdatedState(onSessionChanged)
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val haptic = LocalHapticFeedback.current
    val snackbarHostState = remember { SnackbarHostState() }
    val pagerState = rememberPagerState(pageCount = { 2 })
    val composerDraftSessionId = sessionId ?: preparedSession?.localSessionId
    val restoredComposerDraft = remember(composerDraftSessionId) {
        composerDraftStore.restore(
            sessionId = composerDraftSessionId,
            uploadCancelledMessage = context.getString(R.string.session_attachment_upload_failed),
        )
    }
    var draft by remember(composerDraftSessionId) { mutableStateOf(restoredComposerDraft.text) }
    var showRuntimeSettings by remember(sessionId) { mutableStateOf(false) }
    var noticeResponseErrors by remember(sessionId) { mutableStateOf(emptyMap<String, String>()) }
    var forceLatestRequest by remember(sessionId) { mutableStateOf(0) }
    var streamLatestRequest by remember(sessionId) { mutableStateOf(0) }
    var attachments by remember(composerDraftSessionId) { mutableStateOf(restoredComposerDraft.attachments) }
    var retryClientMessageId by remember(composerDraftSessionId) { mutableStateOf(restoredComposerDraft.clientMessageId) }
    var retryMessageAction by remember(composerDraftSessionId) { mutableStateOf(restoredComposerDraft.retryAction) }
    var preparedSessionCreating by remember(preparedSession) { mutableStateOf(false) }
    var preparedSelections by remember(preparedSession) { mutableStateOf(preparedSession?.selections ?: NewSessionSelections()) }
    var preparedModelOptions by remember(preparedSession) { mutableStateOf(emptyList<com.agentsanywhere.app.feature.sessiondetail.RuntimeSelectionOption>()) }
    var preparedPermissionCatalog by remember(preparedSession) { mutableStateOf<NewSessionPermissionCatalog?>(null) }
    var preparedModelLoading by remember(preparedSession) { mutableStateOf(false) }
    var preparedPermissionLoading by remember(preparedSession) { mutableStateOf(false) }
    var preparedModelError by remember(preparedSession) { mutableStateOf<String?>(null) }
    var preparedPermissionError by remember(preparedSession) { mutableStateOf<String?>(null) }
    var takeoverConfirm by remember(sessionId) { mutableStateOf<Boolean?>(null) }
    var previewImage by remember(sessionId) { mutableStateOf<AttachmentPreview?>(null) }
    var pendingGallerySave by remember(sessionId) { mutableStateOf<DownloadedAttachment?>(null) }
    var attachmentSaveInFlight by remember(sessionId) { mutableStateOf(false) }
    var showCamera by remember(sessionId) { mutableStateOf(false) }
    var showDeviceOffline by remember(sessionId) { mutableStateOf(false) }
    var pendingOpenFilePath by remember(sessionId) { mutableStateOf<String?>(null) }
    var terminalVerticalDragActive by remember(sessionId) { mutableStateOf(false) }
    var composerHeightPx by remember { mutableStateOf(0) }
    var readOnlyComposerTapCount by remember(sessionId) { mutableStateOf(0) }
    var modelCatalogRefreshKey by remember(sessionId) { mutableStateOf<String?>(null) }
    var permissionCatalogRefreshKey by remember(sessionId) { mutableStateOf<String?>(null) }
    val refetchInFlight = remember(sessionId) { AtomicBoolean(false) }
    val olderInFlight = remember(sessionId) { AtomicBoolean(false) }
    val remoteTerminal = remember(sessionId, terminalPool) { terminalPool.forSession(sessionId) }

    var appVisible by remember(lifecycleOwner) {
        mutableStateOf(lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
    }
    val optimisticSessionId = sessionId ?: preparedSession?.localSessionId
    var state by remember(sessionId, preparedSession?.localSessionId) {
        val optimisticMessages = optimisticSessionId
            ?.let(controller::optimisticMessages)
            .orEmpty()
        mutableStateOf(
            SessionDetailState(
                meta = SessionMeta(
                    session = initialSession?.takeIf { preparedSession != null || it.id == sessionId },
                    isLoading = sessionId != null,
                ),
                timeline = SessionTimelineState(
                    messages = optimisticMessages,
                    isLoading = sessionId != null,
                ),
                sending = optimisticMessages.hasPendingOptimisticSend(),
            ),
        )
    }

    fun showError(message: String) {
        scope.launch {
            snackbarHostState.showSnackbar(
                AAToastVisuals(
                    message = message,
                    isError = true,
                    duration = SnackbarDuration.Long,
                ),
            )
        }
    }

    fun showToast(message: String) {
        scope.launch {
            snackbarHostState.showSnackbar(AAToastVisuals(message = message))
        }
    }

    fun attachmentErrorMessage(error: Throwable, fallback: Int): String {
        val transfer = error as? AttachmentTransferException
        return when (transfer?.failure) {
            AttachmentTransferFailure.InvalidBase64 -> context.getString(R.string.session_attachment_base64_invalid)
            AttachmentTransferFailure.IncompleteUpload -> context.getString(R.string.session_attachment_upload_incomplete)
            AttachmentTransferFailure.SizeMismatch -> context.getString(
                R.string.session_attachment_size_mismatch,
                transfer.attachmentName ?: context.getString(R.string.session_attachment_name_fallback),
            )
            AttachmentTransferFailure.Sha256Mismatch -> context.getString(
                R.string.session_attachment_sha_mismatch,
                transfer.attachmentName ?: context.getString(R.string.session_attachment_name_fallback),
            )
            null -> error.message ?: context.getString(fallback)
        }
    }

    fun copyMessageText(text: String) {
        val copyText = text.trimEnd('\r', '\n')
        if (copyText.isBlank()) return
        clipboard.setText(AnnotatedString(copyText))
        showToast(context.getString(R.string.common_copied))
    }

    fun saveDownloadedImage(downloaded: DownloadedAttachment) {
        scope.launch {
            saveImageToGallery(context, downloaded).onSuccess {
                showToast(context.getString(R.string.session_attachment_saved))
            }.onFailure {
                showError(context.getString(R.string.session_attachment_save_failed))
            }
            attachmentSaveInFlight = false
        }
    }

    val storagePermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val downloaded = pendingGallerySave
        pendingGallerySave = null
        if (granted && downloaded != null) {
            saveDownloadedImage(downloaded)
        } else {
            attachmentSaveInFlight = false
            if (!granted) showError(context.getString(R.string.session_attachment_save_permission_required))
        }
    }

    fun saveAttachment(attachment: TimelineAttachment) {
        val id = sessionId ?: return
        if (attachmentSaveInFlight) return
        attachmentSaveInFlight = true
        scope.launch {
            controller.downloadAttachment(id, attachment)
                .onSuccess { downloaded ->
                    val needsLegacyPermission = Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
                        ContextCompat.checkSelfPermission(
                            context,
                            Manifest.permission.WRITE_EXTERNAL_STORAGE,
                        ) != PackageManager.PERMISSION_GRANTED
                    if (needsLegacyPermission) {
                        pendingGallerySave = downloaded
                        storagePermissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    } else {
                        saveDownloadedImage(downloaded)
                    }
                }
                .onFailure { error ->
                    attachmentSaveInFlight = false
                    showError(attachmentErrorMessage(error, R.string.session_attachment_download_failed))
                }
        }
    }

    fun openReferencedFile(path: String) {
        val trimmed = path.trim()
        if (trimmed.isBlank()) return
        pendingOpenFilePath = trimmed
        scope.launch { pagerState.animateScrollToPage(1) }
    }

    fun openAttachment(attachment: com.agentsanywhere.app.feature.sessiondetail.TimelineAttachment) {
        val id = sessionId ?: return
        scope.launch {
            controller.downloadAttachment(id, attachment)
                .onSuccess { downloaded ->
                    val target = withContext(Dispatchers.IO) {
                        cacheDownloadedAttachment(context.cacheDir, downloaded)
                    }
                    val uri = FileProvider.getUriForFile(
                        context,
                        "${context.packageName}.attachments",
                        target,
                    )
                    val intent = Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, downloaded.mediaType.ifBlank { "application/octet-stream" })
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    runCatching { context.startActivity(intent) }
                        .onFailure { showError(context.getString(R.string.session_attachment_open_failed)) }
                }
                .onFailure { error ->
                    showError(attachmentErrorMessage(error, R.string.session_attachment_download_failed))
                }
        }
    }

    fun saveComposerDraft(
        nextDraft: String,
        nextAttachments: List<PendingAttachment>,
        clientMessageId: String? = retryClientMessageId,
        retryAction: RuntimeMessageAction? = retryMessageAction,
    ) {
        composerDraftStore.save(composerDraftSessionId, nextDraft, nextAttachments, clientMessageId, retryAction)
    }

    fun setComposerDraft(nextDraft: String) {
        draft = nextDraft
        retryClientMessageId = null
        retryMessageAction = null
        saveComposerDraft(nextDraft, attachments, null, null)
    }

    fun setComposerAttachments(nextAttachments: List<PendingAttachment>) {
        attachments = nextAttachments
        retryClientMessageId = null
        retryMessageAction = null
        saveComposerDraft(draft, nextAttachments, null, null)
    }

    fun clearComposerDraft() {
        draft = ""
        attachments = emptyList()
        composerDraftStore.clear(composerDraftSessionId)
        retryClientMessageId = null
        retryMessageAction = null
    }

    fun updateAttachment(id: String, transform: (PendingAttachment) -> PendingAttachment) {
        val nextAttachments = attachments.updateItemById(id, PendingAttachment::id, transform)
        setComposerAttachments(nextAttachments)
    }

    fun uploadPendingAttachment(attachment: PendingAttachment) {
        val id = sessionId
        if (id == null && preparedSession != null) {
            scope.launch {
                val uploadPart = try {
                    withContext(Dispatchers.IO) { context.uploadPart(attachment) }
                } catch (error: Exception) {
                    updateAttachment(attachment.id) {
                        it.copy(
                            uploadState = AttachmentUploadState.Failed,
                            errorMessage = error.message ?: context.getString(R.string.session_attachment_read_failed),
                        )
                    }
                    return@launch
                }
                updateAttachment(attachment.id) {
                    it.copy(
                        uploadState = AttachmentUploadState.Uploaded,
                        remote = uploadPart.toLocalTimelineAttachment(attachment.uri),
                        errorMessage = null,
                    )
                }
            }
            return
        }
        if (id == null) return
        scope.launch {
            val uploadPart = try {
                withContext(Dispatchers.IO) { context.uploadPart(attachment) }
            } catch (error: Exception) {
                updateAttachment(attachment.id) {
                    it.copy(
                        uploadState = AttachmentUploadState.Failed,
                        errorMessage = error.message ?: context.getString(R.string.session_attachment_read_failed),
                    )
                }
                return@launch
            }
            controller.uploadAttachments(id, listOf(uploadPart))
                .onSuccess { uploaded ->
                    val remote = uploaded.firstOrNull()
                    updateAttachment(attachment.id) {
                        if (remote == null) {
                            it.copy(
                                uploadState = AttachmentUploadState.Failed,
                                errorMessage = context.getString(R.string.session_attachment_upload_empty),
                            )
                        } else {
                            it.copy(
                                uploadState = AttachmentUploadState.Uploaded,
                                remote = remote,
                                errorMessage = null,
                            )
                        }
                    }
                }
                .onFailure { error ->
                    updateAttachment(attachment.id) {
                        it.copy(
                            uploadState = AttachmentUploadState.Failed,
                            errorMessage = attachmentErrorMessage(error, R.string.session_attachment_upload_failed),
                        )
                    }
                }
        }
    }

    fun retryPendingAttachment(attachment: PendingAttachment) {
        updateAttachment(attachment.id) {
            it.copy(uploadState = AttachmentUploadState.Uploading, remote = null, errorMessage = null)
        }
        uploadPendingAttachment(attachment)
    }

    fun unfocusComposer() {
        focusManager.clearFocus()
        keyboard?.hide()
    }

    fun handleReadOnlyComposerClick() {
        if (takeoverConfirm != null || state.takeoverInFlight) return
        readOnlyComposerTapCount += 1
        if (readOnlyComposerTapCount >= 2) {
            readOnlyComposerTapCount = 0
            if (state.session?.connectorOnline != true) {
                showDeviceOffline = true
            } else if (state.session?.takeover != true) {
                takeoverConfirm = true
            }
        }
    }

    fun attachPending(picked: List<PendingAttachment>) {
        val remainingSlots = MAX_ATTACHMENT_FILES - attachments.size
        if (remainingSlots <= 0) {
            showError(context.getString(R.string.session_attachment_limit, MAX_ATTACHMENT_FILES))
            return
        }
        if (picked.size > remainingSlots) {
            showError(context.getString(R.string.session_attachment_limit, MAX_ATTACHMENT_FILES))
        }
        val accepted = picked
            .filter { attachment ->
                if (attachment.size > MAX_ATTACHMENT_BYTES) {
                    showError(context.getString(R.string.session_attachment_file_too_large, attachment.name))
                    false
                } else {
                    true
                }
            }
            .take(remainingSlots)
            .map {
                it.copy(
                    uploadState = AttachmentUploadState.Uploading,
                    remote = null,
                    errorMessage = null,
                )
            }
        if (accepted.isEmpty()) return
        setComposerAttachments(attachments + accepted)
        accepted.forEach(::uploadPendingAttachment)
    }

    fun attachPending(attachment: PendingAttachment?) {
        if (attachment == null) {
            showError(context.getString(R.string.session_attachment_read_one_failed))
        } else {
            attachPending(listOf(attachment))
        }
    }

    val photoPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickMultipleVisualMedia(MAX_ATTACHMENT_FILES),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        attachPending(uris.mapNotNull { context.pendingAttachment(it) })
    }
    val filePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        uris.forEach { uri ->
            runCatching {
                context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
        attachPending(uris.mapNotNull { context.pendingAttachment(it) })
    }
    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            showCamera = true
        } else {
            showError(context.getString(R.string.session_camera_permission_required))
        }
    }

    fun openPhotoPicker() {
        try {
            photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        } catch (_: Exception) {
            showError(context.getString(R.string.session_photo_access_required))
        }
    }

    fun openFilePicker() {
        try {
            filePicker.launch(arrayOf("*/*"))
        } catch (_: Exception) {
            showError(context.getString(R.string.session_file_picker_failed))
        }
    }

    fun openCamera() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            showCamera = true
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    suspend fun loadInitialSnapshot() {
        val id = sessionId ?: return
        if (!appVisible) return
        if (!refetchInFlight.compareAndSet(false, true)) return
        val hadInitializedState = state.initialized
        try {
            state = state.beginSnapshotLoad(clearErrors = !hadInitializedState)
            controller.loadInitialSnapshot(id, devices, state).fold(
                onSuccess = { loaded ->
                    if (!appVisible) {
                        state = state.failSnapshotLoad(null)
                    } else {
                        state = controller.mergeSnapshotWithLiveState(id, loaded, state)
                            .completeSnapshotLoad()
                        state.session?.let(onSessionChanged)
                    }
                },
                onFailure = {
                    if (!appVisible) {
                        state = state.failSnapshotLoad(null)
                    } else {
                        val initialLoadError = context.getString(R.string.session_load_messages_failed)
                        state = state.failSnapshotLoad(initialLoadError.takeUnless { hadInitializedState })
                    }
                },
            )
        } finally {
            refetchInFlight.set(false)
        }
    }

    fun loadOlderMessages() {
        val id = sessionId ?: return
        if (!appVisible || !state.hasMore || state.timeline.loadingOlder) return
        if (!olderInFlight.compareAndSet(false, true)) return
        val beforeOrderSeq = state.timeline.orderingItems
            .minOfOrNull { it.orderSeq }
            ?: state.messages.filterNot { it.optimistic }.minOfOrNull { it.orderSeq }
        if (beforeOrderSeq == null || beforeOrderSeq <= 1) {
            olderInFlight.set(false)
            state = state.copy(
                timeline = state.timeline.copy(hasMore = false, loadingOlder = false),
            )
            return
        }
        state = state.copy(
            timeline = state.timeline.copy(loadingOlder = true, historyErrorMessage = null),
            actionError = null,
        )
        scope.launch {
            try {
                controller.loadOlder(id, beforeOrderSeq)
                    .onSuccess { older ->
                        if (!appVisible) return@onSuccess
                        state = controller.applyOlder(id, state, older)
                    }
                    .onFailure { error ->
                        val message = error.message ?: context.getString(R.string.session_load_messages_failed)
                        state = state.copy(
                            timeline = state.timeline.copy(
                                loadingOlder = false,
                                historyErrorMessage = message,
                            ),
                            actionError = message,
                        )
                        showError(message)
                    }
            } finally {
                olderInFlight.set(false)
            }
        }
    }

    fun sendText(text: String) {
        val pending = preparedSession
        if (pending != null) {
            if (preparedSessionCreating) return
            val message = text.trim()
            val pendingAttachments = attachments
            if (message.isBlank() && pendingAttachments.isEmpty()) return
            val clientMessageId = retryClientMessageId ?: "opt_${UUID.randomUUID()}"
            val localSessionId = pending.localSessionId
            preparedSessionCreating = true
            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
            unfocusComposer()
            forceLatestRequest += 1
            scope.launch {
                val inlineAttachments = try {
                    withContext(Dispatchers.IO) {
                        pendingAttachments.map { attachment ->
                            context.uploadPart(attachment).toNewSessionAttachmentPart()
                        }
                    }
                } catch (error: Exception) {
                    preparedSessionCreating = false
                    showError(error.message ?: context.getString(R.string.session_attachment_read_failed))
                    return@launch
                }
                val optimisticAttachments = pendingAttachments.mapNotNull { attachment ->
                    attachment.remote?.copy(
                        localPreviewUri = attachment.uri.toString().takeIf { attachment.isImage },
                    )
                }
                state = controller.addOptimisticMessage(
                    sessionId = localSessionId,
                    state = state,
                    text = message,
                    clientMessageId = clientMessageId,
                    attachments = optimisticAttachments,
                    retryAction = RuntimeMessageAction.Send,
                )
                clearComposerDraft()
                when (
                    val outcome = onCreatePreparedSession(
                        pending.firstMessageRequest(
                            content = message,
                            selections = preparedSelections,
                            attachments = inlineAttachments,
                            clientMessageId = clientMessageId,
                        ),
                    )
                ) {
                    is NewSessionCreateOutcome.Created -> {
                        state = controller.markOptimisticMessage(
                            sessionId = localSessionId,
                            state = state,
                            clientMessageId = clientMessageId,
                            status = "running",
                        )
                        controller.bindOptimisticSession(localSessionId, outcome.session.id)
                        clearComposerDraft()
                        onPreparedSessionCreated(outcome.session)
                    }
                    is NewSessionCreateOutcome.Failed -> {
                        preparedSessionCreating = false
                        draft = message
                        attachments = pendingAttachments
                        retryClientMessageId = clientMessageId
                        retryMessageAction = RuntimeMessageAction.Send
                        saveComposerDraft(message, pendingAttachments, clientMessageId, RuntimeMessageAction.Send)
                        val rawMessage = outcome.error.message
                        val errorMessage = rawMessage
                            ?.takeUnless(::isInternalRuntimeError)
                            ?: context.getString(R.string.new_session_create_failed)
                        state = controller.markOptimisticMessage(
                            sessionId = localSessionId,
                            state = state,
                            clientMessageId = clientMessageId,
                            status = "failed",
                            attachments = optimisticAttachments,
                            errorMessage = errorMessage,
                        ).copy(actionError = errorMessage)
                        showError(errorMessage)
                    }
                }
            }
            return
        }
        val id = sessionId ?: return
        val runtimeId = state.session?.runtimeId ?: state.runtime.runtimeId
        val runtimeType = state.session?.runtimeType ?: state.runtime.runtimeType
        val messageAction = state.capabilities.messageAction(runtimeId, state.effectiveRuntimeStatus(), runtimeType)
        if (messageAction == null) {
            showError(context.getString(R.string.session_steer_unavailable))
            return
        }
        val clientMessageId = retryClientMessageId ?: "opt_${UUID.randomUUID()}"
        val requestAction = retryMessageAction ?: messageAction
        val actionAllowed = when (requestAction) {
            RuntimeMessageAction.Send -> state.capabilities.isUsable(
                SESSION_SEND_MESSAGE_CAPABILITY,
                runtimeId,
                runtimeType,
            )
            RuntimeMessageAction.Steer -> state.capabilities.isUsable(
                SESSION_STEER_CAPABILITY,
                runtimeId,
                runtimeType,
            )
        }
        if (!actionAllowed) {
            showError(context.getString(R.string.session_steer_unavailable))
            return
        }
        val pendingAttachments = attachments
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        scope.launch {
            if (pendingAttachments.any { it.uploadState != AttachmentUploadState.Uploaded || it.remote == null }) {
                showError(context.getString(R.string.session_wait_uploads))
                return@launch
            }
            val uploadedAttachments = pendingAttachments.mapNotNull { it.remote }
            val optimisticAttachments = pendingAttachments.mapNotNull { attachment ->
                attachment.remote?.copy(
                    localPreviewUri = attachment.uri.toString().takeIf { attachment.isImage },
                )
            }
            state = controller.addOptimisticMessage(
                sessionId = id,
                state = state,
                text = text,
                clientMessageId = clientMessageId,
                attachments = optimisticAttachments,
                retryAction = requestAction,
            )
            unfocusComposer()
            forceLatestRequest += 1
            val request = if (requestAction == RuntimeMessageAction.Steer) {
                controller.steer(
                    sessionId = id,
                    content = text,
                    clientMessageId = clientMessageId,
                    uploadedAttachments = uploadedAttachments,
                )
            } else {
                controller.sendMessage(
                    sessionId = id,
                    content = text,
                    clientMessageId = clientMessageId,
                    uploadedAttachments = uploadedAttachments,
                )
            }
            request
                .onSuccess { result ->
                    clearComposerDraft()
                    state = controller.markOptimisticMessage(
                        sessionId = id,
                        state = state,
                        clientMessageId = clientMessageId,
                        status = "running",
                        attachments = optimisticAttachments.ifEmpty { result.attachments },
                    )
                }
                .onFailure { error ->
                    val rawMessage = error.message
                    val message = rawMessage
                        ?.takeUnless(::isInternalRuntimeError)
                        ?: context.getString(R.string.session_send_failed)
                    if (controller.hasServerEcho(state, clientMessageId)) {
                        clearComposerDraft()
                        return@onFailure
                    }
                    retryClientMessageId = clientMessageId
                    retryMessageAction = requestAction
                    saveComposerDraft(text, pendingAttachments, clientMessageId, requestAction)
                    state = controller.markOptimisticMessage(
                        sessionId = id,
                        state = state,
                        clientMessageId = clientMessageId,
                        status = "failed",
                        errorMessage = message,
                    ).copy(actionError = message)
                    showError(message)
                }
        }
    }

    LaunchedEffect(state.messages, retryClientMessageId) {
        val retryId = retryClientMessageId ?: return@LaunchedEffect
        if (controller.hasServerEcho(state, retryId)) clearComposerDraft()
    }

    fun sendDraft() {
        val text = draft.trim()
        if (text.isEmpty() && attachments.isEmpty()) return
        if (preparedSession == null && text.startsWith('/')) {
            val id = sessionId ?: return
            val raw = text.removePrefix("/").trim()
            val commandName = raw.substringBefore(' ').trim()
            val command = state.commands.commands.firstOrNull { candidate ->
                candidate.id.equals(commandName, ignoreCase = true) ||
                    candidate.aliases.any { it.equals(commandName, ignoreCase = true) }
            }
            if (command == null) {
                showError(context.getString(R.string.session_command_unknown))
                return
            }
            if (!command.enabled) {
                showError(command.disabledReason ?: context.getString(R.string.session_command_failed))
                return
            }
            if (state.commandExecuting) return
            val args = raw.substringAfter(' ', "")
                .trim()
                .split(Regex("\\s+"))
                .filter(String::isNotBlank)
            state = state.copy(commandExecuting = true, actionError = null)
            scope.launch {
                controller.executeCommand(id, command.id, args, text)
                    .onSuccess {
                        clearComposerDraft()
                        state = state.copy(commandExecuting = false)
                    }
                    .onFailure { error ->
                        val message = error.message ?: context.getString(R.string.session_command_failed)
                        state = state.copy(commandExecuting = false, actionError = message)
                        showError(message)
                    }
            }
            return
        }
        sendText(text)
    }

    fun applyTakeover(enabled: Boolean) {
        val id = sessionId ?: return
        if (state.takeoverInFlight) return
        state = state.copy(takeoverInFlight = true, actionError = null)
        scope.launch {
            controller.setTakeover(id, enabled, devices)
                .onSuccess { session ->
                    state = state.withSession(session).copy(takeoverInFlight = false)
                    onSessionChanged(session)
                }
                .onFailure { error ->
                    val message = error.message ?: context.getString(R.string.session_takeover_update_failed)
                    state = state.copy(takeoverInFlight = false, actionError = message)
                    showError(message)
                }
        }
    }

    fun interrupt() {
        val id = sessionId ?: return
        if (state.interrupting) return
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        state = state.copy(interrupting = true, actionError = null)
        scope.launch {
            controller.interrupt(id)
                .onSuccess {
                    state = state.copy(interrupting = false)
                }
                .onFailure { error ->
                    val message = error.message ?: context.getString(R.string.session_interrupt_failed)
                    state = state.copy(interrupting = false, actionError = message)
                    showError(message)
                }
        }
    }

    fun loadModelCatalog() {
        val pending = preparedSession
        if (pending != null) {
            if (preparedModelLoading) return
            preparedModelLoading = true
            preparedModelError = null
            scope.launch {
                onLoadPreparedModelCatalog(pending.connectorId, pending.runtimeId)
                    .onSuccess { catalog ->
                        preparedModelOptions = catalog.models.flatMap { model ->
                            val reasoning = model.reasoningItems.filter { it.selectionId.isNotBlank() }
                            if (reasoning.isNotEmpty()) {
                                reasoning.map { item ->
                                    com.agentsanywhere.app.feature.sessiondetail.RuntimeSelectionOption(
                                        selectionId = item.selectionId,
                                        label = listOf(model.displayName, item.displayName)
                                            .filter(String::isNotBlank).joinToString(" · "),
                                        description = item.description ?: model.description,
                                        default = item.default || (model.default && reasoning.first() == item),
                                        enabled = model.enabled && item.enabled,
                                        disabledReason = item.disabledReason ?: model.disabledReason,
                                    )
                                }
                            } else {
                                model.selectionId?.takeIf(String::isNotBlank)?.let { id ->
                                    listOf(
                                        com.agentsanywhere.app.feature.sessiondetail.RuntimeSelectionOption(
                                            selectionId = id,
                                            label = model.displayName.ifBlank { model.id },
                                            description = model.description,
                                            default = model.default,
                                            enabled = model.enabled,
                                            disabledReason = model.disabledReason,
                                        ),
                                    )
                                }.orEmpty()
                            }
                        }.distinctBy { it.selectionId }
                        preparedSelections = preparedSelections.copy(
                            model = preparedModelOptions.validatedSelection(preparedSelections.model),
                        )
                    }
                    .onFailure { preparedModelError = it.message ?: context.getString(R.string.session_runtime_model_catalog_failed) }
                preparedModelLoading = false
            }
            return
        }
        val id = sessionId ?: return
        state = state.copy(catalogs = state.catalogs.beginModel(id))
        val key = state.catalogs.requestKey ?: return
        scope.launch {
            controller.loadSessionModelCatalog(id)
                .onSuccess { catalog ->
                    if (sessionId != id || state.catalogs.requestKey != key) return@onSuccess
                    state = state.copy(catalogs = state.catalogs.applyModel(key, catalog))
                }
                .onFailure { error ->
                    if (sessionId != id || state.catalogs.requestKey != key) return@onFailure
                    state = state.copy(
                        catalogs = state.catalogs.failModel(
                            key,
                            error.message ?: context.getString(R.string.session_runtime_model_catalog_failed),
                        ),
                    )
                }
        }
    }

    fun loadPermissionCatalog() {
        val pending = preparedSession
        if (pending != null) {
            if (preparedPermissionLoading) return
            preparedPermissionLoading = true
            preparedPermissionError = null
            scope.launch {
                onLoadPreparedPermissionCatalog(pending.connectorId, pending.runtimeId)
                    .onSuccess { catalog ->
                        preparedPermissionCatalog = catalog
                        val options = catalog.permissions
                            .filter { it.selectionId.isNotBlank() }
                            .map { permission ->
                                com.agentsanywhere.app.feature.sessiondetail.RuntimeSelectionOption(
                                    selectionId = permission.selectionId,
                                    label = permission.displayName.ifBlank { permission.id },
                                    description = permission.description,
                                    default = permission.default,
                                    enabled = permission.enabled,
                                    disabledReason = permission.disabledReason,
                                )
                            }
                        preparedSelections = preparedSelections.copy(
                            permission = options.validatedSelection(preparedSelections.permission),
                        )
                    }
                    .onFailure { preparedPermissionError = it.message ?: context.getString(R.string.session_runtime_permission_catalog_failed) }
                preparedPermissionLoading = false
            }
            return
        }
        val id = sessionId ?: return
        state = state.copy(catalogs = state.catalogs.beginPermission(id))
        val key = state.catalogs.requestKey ?: return
        scope.launch {
            controller.loadSessionPermissionCatalog(id)
                .onSuccess { catalog ->
                    if (sessionId != id || state.catalogs.requestKey != key) return@onSuccess
                    state = state.copy(catalogs = state.catalogs.applyPermission(key, catalog))
                }
                .onFailure { error ->
                    if (sessionId != id || state.catalogs.requestKey != key) return@onFailure
                    state = state.copy(
                        catalogs = state.catalogs.failPermission(
                            key,
                            error.message ?: context.getString(R.string.session_runtime_permission_catalog_failed),
                        ),
                    )
                }
        }
    }

    fun updateSelection(scopeName: String, selectionId: String) {
        val id = sessionId ?: return
        if (state.selectionUpdating) return
        val selections = state.runtime.selections.toMutableMap().apply { put(scopeName, selectionId) }
        state = state.copy(selectionUpdating = true, actionError = null)
        scope.launch {
            controller.updateSelections(id, selections)
                .onSuccess { observed ->
                    if (observed != null && observed.updatedSeq >= state.runtime.updatedSeq) {
                        state = state.copy(runtime = observed)
                    }
                    state = state.copy(selectionUpdating = false)
                }
                .onFailure { error ->
                    val message = error.message ?: context.getString(R.string.session_selection_update_failed)
                    state = state.copy(selectionUpdating = false, actionError = message)
                    showError(message)
                }
        }
    }

    fun loadCommands(force: Boolean = false) {
        val id = sessionId ?: return
        if (state.commands.isLoading) return
        if (!force && state.commands.isLoaded && !state.commands.stale) return
        state = state.copy(commands = state.commands.begin(id))
        val key = state.commands.requestKey ?: return
        scope.launch {
            controller.loadCommands(id)
                .onSuccess { commands ->
                    if (sessionId != id || state.commands.requestKey != key) return@onSuccess
                    state = state.copy(commands = state.commands.apply(key, commands))
                }
                .onFailure { error ->
                    if (sessionId != id || state.commands.requestKey != key) return@onFailure
                    state = state.copy(
                        commands = state.commands.fail(
                            key,
                            error.message ?: context.getString(R.string.session_commands_load_failed),
                        ),
                    )
                }
        }
    }

    fun respondNotice(
        notice: RuntimeNotice,
        action: RuntimeNoticeAction,
        input: Map<String, Any?>?,
    ) {
        val id = sessionId ?: return
        if (state.respondingNoticeIds.isNotEmpty()) return
        state = state.copy(
            respondingNoticeIds = state.respondingNoticeIds + notice.noticeId,
            actionError = null,
        )
        noticeResponseErrors = noticeResponseErrors - notice.noticeId
        scope.launch {
            controller.respondNotice(id, notice.noticeId, action.actionId, input)
                .onSuccess {
                    state = state.copy(
                        notices = state.notices.copy(
                            notices = state.notices.notices.filterNot { observed ->
                                observed.noticeId == notice.noticeId
                            },
                        ),
                        respondingNoticeIds = state.respondingNoticeIds - notice.noticeId,
                    )
                }
                .onFailure { error ->
                    val responseCode = (error as? RuntimeNoticeResponseException)?.code
                    if (responseCode != null && responseCode in setOf(
                            "not_found",
                            "notice_not_found",
                            "interaction_not_found",
                            "request_not_found",
                            "approval_not_found",
                        )
                    ) {
                        state = state.copy(
                            notices = state.notices.copy(
                                notices = state.notices.notices.filterNot { it.noticeId == notice.noticeId },
                            ),
                            respondingNoticeIds = state.respondingNoticeIds - notice.noticeId,
                        )
                        noticeResponseErrors = noticeResponseErrors - notice.noticeId
                        return@onFailure
                    }
                    val message = error.message ?: context.getString(R.string.session_notice_response_failed)
                    state = state.copy(
                        respondingNoticeIds = state.respondingNoticeIds - notice.noticeId,
                        actionError = message,
                    )
                    noticeResponseErrors = noticeResponseErrors + (notice.noticeId to message)
                    showError(message)
                }
        }
    }

    BackHandler {
        if (pagerState.currentPage == 1) {
            scope.launch { pagerState.animateScrollToPage(0) }
        } else {
            navigate(AppDestination.Sessions)
        }
    }

    DisposableEffect(context, sessionId) {
        if (sessionId != null) {
            RemoteTerminalForegroundService.start(context)
        }
        onDispose {
            if (sessionId != null) {
                RemoteTerminalForegroundService.stop(context)
            }
        }
    }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> appVisible = true
                Lifecycle.Event.ON_STOP -> appVisible = false
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            refetchInFlight.set(false)
            olderInFlight.set(false)
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    LaunchedEffect(sessionId, initialSession) {
        val session = initialSession
        val current = state.session
        if (session != null && (preparedSession != null || session.id == sessionId)) {
            state = state.copy(
                meta = state.meta.copy(
                    session = mergeAuthoritativeSessionMetadata(current, session),
                ),
            )
        }
    }

    LaunchedEffect(sessionId, appVisible) {
        if (sessionId == null || !appVisible) return@LaunchedEffect
        if (!state.initialized) loadInitialSnapshot()
    }

    LaunchedEffect(sessionId, appVisible, state.initialized, realtimeController) {
        if (sessionId == null || !appVisible || !state.initialized) return@LaunchedEffect
        val id = sessionId
        realtimeController.start(
            scope = this,
            sessionId = id,
            cursor = { withContext(Dispatchers.Main.immediate) { state.realtime.cursor } },
            onEvents = { events ->
                if (sessionId != id || !appVisible) return@start
                withContext(Dispatchers.Main.immediate) {
                    val before = state
                    state = controller.applyRealtimeEvents(state, events, currentDevices)
                    if (latestTimelineItemChanged(before.messages, state.messages) || before.notices != state.notices) {
                        streamLatestRequest += 1
                    }
                    if (state.session != before.session) state.session?.let(currentOnSessionChanged)
                }
            },
            onCursorAdvanced = { cursor ->
                withContext(Dispatchers.Main.immediate) {
                    if (sessionId == id) {
                        state = state.copy(
                            realtime = state.realtime.copy(
                                cursor = com.agentsanywhere.app.feature.sessiondetail.laterEventCursor(
                                    state.realtime.cursor,
                                    cursor,
                                ),
                            ),
                        )
                    }
                }
            },
            onSnapshotRequired = { _ ->
                if (sessionId == id && appVisible) {
                    withContext(Dispatchers.Main.immediate) { loadInitialSnapshot() }
                }
            },
            onRuntimeRefreshRequired = { connectionGeneration, refreshGeneration ->
                if (sessionId == id && appVisible) {
                    val requestState = withContext(Dispatchers.Main.immediate) { state }
                    val refreshed = controller.refreshRuntimeLiveDomains(id, requestState)
                    withContext(Dispatchers.Main.immediate) {
                        if (sessionId == id && appVisible &&
                            realtimeController.isCurrentRuntimeRefresh(
                                connectionGeneration,
                                refreshGeneration,
                            )
                        ) {
                            state = controller.mergeRuntimeLiveState(state, requestState, refreshed)
                        }
                    }
                }
            },
            onConnectionChanged = { connected, recovering, attempt, error ->
                scope.launch {
                    if (sessionId != id) return@launch
                    state = state.copy(
                        realtime = state.realtime.copy(
                            connected = connected,
                            recovering = recovering,
                            reconnectAttempt = attempt,
                            lastErrorMessage = error,
                        ),
                    )
                }
            },
        ).join()
    }

    val isPreparedSession = preparedSession != null
    val connectorOnline = if (isPreparedSession) true else state.session?.connectorOnline == true
    val takeoverEnabled = if (isPreparedSession) true else state.session?.takeover == true
    val runtimeId = state.session?.runtimeId ?: state.runtime.runtimeId
    val runtimeType = state.session?.runtimeType ?: state.runtime.runtimeType
    val canUseSendMessage = state.capabilities.isUsable(SESSION_SEND_MESSAGE_CAPABILITY, runtimeId, runtimeType)
    val canUseSteer = state.capabilities.isUsable(SESSION_STEER_CAPABILITY, runtimeId, runtimeType)
    val canUseInterrupt = state.capabilities.isUsable(SESSION_INTERRUPT_CAPABILITY, runtimeId, runtimeType)
    val canRespondToNotice = state.capabilities.isUsable(
        SESSION_NOTICE_RESPONSE_CAPABILITY,
        runtimeId,
        runtimeType,
    )
    val canUseAttachments = if (isPreparedSession) {
        preparedSession?.attachmentsEnabled == true
    } else {
        state.capabilities.isUsable(SESSION_ATTACHMENT_CAPABILITY, runtimeId, runtimeType)
    }
    val canUseCommands = state.capabilities.isUsable(SESSION_COMMANDS_CAPABILITY, runtimeId, runtimeType) ||
        state.capabilities.isUsable(SESSION_COMMAND_EXECUTE_CAPABILITY, runtimeId, runtimeType)
    val capabilityFactsFresh = state.capabilities.isLoaded && state.capabilities.errorMessage == null
    val runtimeStatus = state.effectiveRuntimeStatus()
    val openInteractions = remember(state.notices.notices) {
        state.notices.notices
            .filter(RuntimeNotice::openInteraction)
            .sortedWith(compareBy<RuntimeNotice> { it.updatedSeq }.thenBy { it.noticeId })
    }
    val blockingNotices = remember(openInteractions, sessionId) {
        val id = sessionId.orEmpty()
        openInteractions.filter { it.blocksSession(id) }
    }
    val runtimeBlocksSubmission = runtimeStatus in setOf(
        SessionRuntimeStatus.Waiting,
        SessionRuntimeStatus.Pending,
        SessionRuntimeStatus.Running,
        SessionRuntimeStatus.Stopping,
        SessionRuntimeStatus.WaitingApproval,
        SessionRuntimeStatus.Blocked,
        SessionRuntimeStatus.Disconnected,
    )
    val commandRequested = takeoverEnabled && draft.trimStart().startsWith('/') && attachments.isEmpty()
    val commandQuery = draft.trimStart().removePrefix("/").trim()
    val inputEnabled = if (isPreparedSession) {
        true
    } else {
        sessionComposerEnabled(
            takeoverEnabled = takeoverEnabled,
            capabilityFactsFresh = capabilityFactsFresh,
            canSendMessage = canUseSendMessage,
            canSteer = canUseSteer,
            canUseCommands = canUseCommands,
        )
    }
    val commandMode = commandRequested && inputEnabled
    val attachmentsReady = attachments.all { it.uploadState == AttachmentUploadState.Uploaded }
    val canSend = inputEnabled &&
        !runtimeBlocksSubmission &&
        blockingNotices.isEmpty() &&
        !state.sending &&
        !preparedSessionCreating &&
        !state.commandExecuting &&
        attachmentsReady &&
        (attachments.isEmpty() || canUseAttachments) &&
        (draft.isNotBlank() || attachments.isNotEmpty()) &&
        if (isPreparedSession) true
        else if (commandMode) canUseCommands && state.commands.isLoaded else canUseSendMessage || canUseSteer
    val modelOptions = if (isPreparedSession) preparedModelOptions else remember(state.catalogs.model) {
        state.catalogs.model?.selectionOptions().orEmpty()
    }
    val permissionLocalizer = runtimePermissionLocalizer()
    val permissionOptions = if (isPreparedSession) {
        preparedPermissionCatalog?.permissions
            ?.filter { it.selectionId.isNotBlank() }
            ?.map { permission ->
                val localized = permissionLocalizer.localize(
                    runtime = preparedPermissionCatalog?.runtime.orEmpty(),
                    permissionId = permission.id,
                    label = permission.displayName,
                    description = permission.description,
                    metadata = permission.metadata,
                )
                com.agentsanywhere.app.feature.sessiondetail.RuntimeSelectionOption(
                    selectionId = permission.selectionId,
                    label = localized.label,
                    description = localized.description,
                    default = permission.default,
                    enabled = permission.enabled,
                    disabledReason = permission.disabledReason,
                )
            }
            ?.distinctBy { it.selectionId }
            .orEmpty()
    } else state.catalogs.permission?.let { catalog ->
        val permissions = catalog.permissions.associateBy { it.selectionId }
        catalog.selectionOptions().map { option ->
            val permission = permissions[option.selectionId] ?: return@map option
            val localized = permissionLocalizer.localize(
                runtime = catalog.runtime,
                permissionId = permission.id,
                label = option.label,
                description = option.description,
                metadata = permission.metadata,
            )
            option.copy(label = localized.label, description = localized.description)
        }
    }.orEmpty()
    val modelSelection = modelOptions.validatedSelection(
        if (isPreparedSession) preparedSelections.model else state.runtime.selections["model"],
    )
    val permissionSelection = permissionOptions.validatedSelection(
        if (isPreparedSession) preparedSelections.permission else state.runtime.selections["permission"],
    )
    val modelCapability = state.capabilities.find(SESSION_MODEL_CATALOG_CAPABILITY, runtimeId, runtimeType)
    val permissionCapability = state.capabilities.find(SESSION_PERMISSION_CATALOG_CAPABILITY, runtimeId, runtimeType)
    val commandCapability = state.capabilities.find(SESSION_COMMANDS_CAPABILITY, runtimeId, runtimeType)
        ?: state.capabilities.find(SESSION_COMMAND_EXECUTE_CAPABILITY, runtimeId, runtimeType)
    LaunchedEffect(
        sessionId,
        state.runtime.selections["model"],
        state.catalogs.model?.revision,
        modelCapability?.supported,
        state.catalogs.modelLoading,
        state.catalogs.modelErrorMessage,
    ) {
        val selection = state.runtime.selections["model"]?.takeIf(String::isNotBlank)
        val catalogMissing = state.catalogs.model == null && modelCapability?.supported == true
        val selectionMissing = selection != null && state.catalogs.model != null &&
            modelOptions.none { it.enabled && it.selectionId == selection }
        val refreshKey = when {
            catalogMissing -> "catalog:${state.capabilities.revision}"
            selectionMissing -> "selection:$selection:${state.catalogs.model?.revision}"
            else -> null
        }
        if ((catalogMissing || selectionMissing) && !state.catalogs.modelLoading &&
            state.catalogs.modelErrorMessage == null && modelCatalogRefreshKey != refreshKey
        ) {
            modelCatalogRefreshKey = refreshKey
            loadModelCatalog()
        }
    }
    LaunchedEffect(
        sessionId,
        state.runtime.selections["permission"],
        state.catalogs.permission?.revision,
        permissionCapability?.supported,
        state.catalogs.permissionLoading,
        state.catalogs.permissionErrorMessage,
        state.catalogs.modelLoading,
    ) {
        val selection = state.runtime.selections["permission"]?.takeIf(String::isNotBlank)
        val catalogMissing = state.catalogs.permission == null && permissionCapability?.supported == true
        val selectionMissing = selection != null && state.catalogs.permission != null &&
            permissionOptions.none { it.enabled && it.selectionId == selection }
        val refreshKey = when {
            catalogMissing -> "catalog:${state.capabilities.revision}"
            selectionMissing -> "selection:$selection:${state.catalogs.permission?.revision}"
            else -> null
        }
        if ((catalogMissing || selectionMissing) && !state.catalogs.permissionLoading &&
            state.catalogs.permissionErrorMessage == null && !state.catalogs.modelLoading &&
            permissionCatalogRefreshKey != refreshKey
        ) {
            permissionCatalogRefreshKey = refreshKey
            loadPermissionCatalog()
        }
    }

    LaunchedEffect(sessionId, commandMode, canUseCommands) {
        if (sessionId != null && commandMode && canUseCommands) loadCommands(force = false)
    }
    LaunchedEffect(state.interrupting, canUseInterrupt) {
        if (state.interrupting && !canUseInterrupt) state = state.copy(interrupting = false)
    }
    val agentLabel = state.session?.runtimeLabel?.takeIf { it.isNotBlank() }
        ?: context.getString(R.string.session_agent_fallback)
    val turnInProgress = state.sending ||
        state.interrupting ||
        runtimeStatus in setOf(
            SessionRuntimeStatus.Waiting,
            SessionRuntimeStatus.Pending,
            SessionRuntimeStatus.Running,
            SessionRuntimeStatus.Stopping,
            SessionRuntimeStatus.WaitingApproval,
            SessionRuntimeStatus.Blocked,
        ) || state.messages.any { it.optimistic && it.status == "running" }
    val workingLabel = when {
        state.interrupting -> context.getString(R.string.session_agent_interrupting, agentLabel)
        runtimeStatus in setOf(SessionRuntimeStatus.Waiting, SessionRuntimeStatus.Pending) ->
            context.getString(R.string.session_agent_pending, agentLabel)
        state.sending ||
            runtimeStatus == SessionRuntimeStatus.Running ||
            state.messages.any { it.optimistic && it.status == "running" } -> {
            context.getString(R.string.session_agent_working, agentLabel)
        }
        else -> null
    }
    val showInterrupt = state.interrupting || (
        connectorOnline && canUseInterrupt && runtimeStatus in setOf(
            SessionRuntimeStatus.Waiting,
            SessionRuntimeStatus.Pending,
            SessionRuntimeStatus.Running,
            SessionRuntimeStatus.Stopping,
            SessionRuntimeStatus.WaitingApproval,
            SessionRuntimeStatus.Blocked,
        )
    )
    val replyTarget = state.session?.runtimeLabel?.takeIf { it.isNotBlank() }
        ?: stringResource(R.string.session_agent_fallback)
    val placeholder = when {
        isPreparedSession -> stringResource(R.string.session_reply_to, replyTarget)
        !takeoverEnabled -> stringResource(R.string.session_read_only_placeholder)
        state.session != null && !connectorOnline -> stringResource(R.string.session_device_offline_placeholder)
        blockingNotices.isNotEmpty() -> stringResource(R.string.session_waiting_approval_placeholder)
        state.runtime.errorMessage != null -> state.runtime.errorMessage.orEmpty()
        state.runtime.error?.get("code") == "DSH_CONCURRENT_WRITER_DETECTED" ->
            stringResource(R.string.session_dsh_concurrent_writer)
        runtimeStatus == SessionRuntimeStatus.Unknown -> stringResource(R.string.session_runtime_state_unknown)
        runtimeStatus in setOf(SessionRuntimeStatus.Waiting, SessionRuntimeStatus.Pending) ->
            stringResource(R.string.session_pending_placeholder)
        runtimeStatus in setOf(SessionRuntimeStatus.Running, SessionRuntimeStatus.Stopping) ->
            stringResource(R.string.session_busy_placeholder)
        runtimeStatus in setOf(SessionRuntimeStatus.WaitingApproval, SessionRuntimeStatus.Blocked) ->
            stringResource(R.string.session_waiting_approval_placeholder)
        runtimeStatus == SessionRuntimeStatus.Error -> stringResource(R.string.session_error_placeholder)
        runtimeStatus == SessionRuntimeStatus.Disconnected -> stringResource(R.string.session_device_offline_placeholder)
        !canUseSendMessage && !canUseCommands -> stringResource(R.string.session_send_unavailable)
        inputEnabled -> stringResource(R.string.session_reply_to, replyTarget)
        else -> stringResource(R.string.session_send_unavailable)
    }
    val density = LocalDensity.current
    val imeBottomPx = WindowInsets.ime.getBottom(density)
    val timelineBottomPadding = if (composerHeightPx > 0) {
        with(density) { composerHeightPx.toDp() } + 16.dp
    } else {
        168.dp
    }
    val hasOpenNotifications = state.notices.notices.any(RuntimeNotice::openNotification)

    ScreenScaffold {
        HorizontalPager(
            state = pagerState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            beyondViewportPageCount = 1,
            userScrollEnabled = !terminalVerticalDragActive,
        ) {
            page ->
            if (page == 0) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(colors.canvas)
                        .pointerInput(composerHeightPx, imeBottomPx) {
                            awaitPointerEventScope {
                                while (true) {
                                    val down = awaitPointerEvent(PointerEventPass.Initial)
                                        .changes
                                        .firstOrNull { it.pressed && !it.previousPressed }
                                        ?: continue
                                    if (
                                        composerHeightPx > 0 &&
                                        down.position.y < size.height - composerHeightPx - imeBottomPx
                                    ) {
                                        unfocusComposer()
                                    }
                                }
                            }
                        },
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .fillMaxWidth()
                            .background(colors.canvas),
                    ) {
                        when {
                            sessionId == null && !isPreparedSession -> EmptyDetailMessage(stringResource(R.string.session_open_from_list))
                            state.timeline.isLoading && state.messages.isEmpty() -> {
                                SessionDetailLoadingState()
                            }
                            state.timeline.errorMessage != null && state.messages.isEmpty() -> {
                                EmptyDetailMessage(state.timeline.errorMessage.orEmpty())
                            }
                            state.messages.isEmpty() && openInteractions.isEmpty() && !hasOpenNotifications ->
                                SessionWelcomeMessage()
                            else -> MessageList(
                                messages = state.messages,
                                darkMode = darkMode,
                                sessionId = sessionId.orEmpty(),
                                workspaceRoot = state.session?.cwd,
                                controller = controller,
                                forceLatestRequest = forceLatestRequest,
                                streamLatestRequest = streamLatestRequest,
                                workingLabel = workingLabel,
                                turnInProgress = turnInProgress,
                                notices = state.notices.notices,
                                canRespondToNotices = canRespondToNotice,
                                respondingNoticeIds = state.respondingNoticeIds,
                                noticeResponseErrors = noticeResponseErrors,
                                bottomContentPadding = timelineBottomPadding,
                                hasMore = state.hasMore,
                                loadingOlder = state.timeline.loadingOlder,
                                onLoadOlder = { loadOlderMessages() },
                                onPreviewAttachment = { previewImage = AttachmentPreview.Remote(it) },
                                onOpenAttachment = ::openAttachment,
                                onCopyMessage = ::copyMessageText,
                                onOpenFile = ::openReferencedFile,
                                onRespondNotice = ::respondNotice,
                            )
                        }
                        ComposerVeil(
                            height = timelineBottomPadding + 16.dp,
                            modifier = Modifier.align(Alignment.BottomCenter),
                        )
                        Column(
                            modifier = Modifier
                                .align(Alignment.BottomCenter)
                                .imePadding(),
                        ) {
                            Column(
                                modifier = Modifier.onSizeChanged { composerHeightPx = it.height },
                            ) {
                                BlockingRuntimeNoticeStack(
                                    notices = blockingNotices,
                                    respondingNoticeIds = state.respondingNoticeIds,
                                    responseErrors = noticeResponseErrors,
                                    canRespond = canRespondToNotice,
                                    onRespond = ::respondNotice,
                                )
                                if (commandMode) {
                                    RuntimeCommandSuggestions(
                                        commands = state.commands.commands,
                                        query = commandQuery,
                                        loading = state.commands.isLoading,
                                        errorMessage = state.commands.errorMessage
                                            ?: commandCapability?.takeUnless { it.usable }?.unavailableReason,
                                        onRetry = { loadCommands(force = true) },
                                        onSelect = { command ->
                                            if (command.enabled) {
                                                setComposerDraft("/${command.id}${if (command.acceptsArgs) " " else ""}")
                                            } else {
                                                showError(
                                                    command.disabledReason
                                                        ?: context.getString(R.string.session_command_failed),
                                                )
                                            }
                                        },
                                    )
                                }
                                MessageComposer(
                                    darkMode = darkMode,
                                    draft = if (takeoverEnabled) draft else "",
                                    onDraftChange = ::setComposerDraft,
                                    takeoverEnabled = takeoverEnabled,
                                    takeoverBusy = isPreparedSession || state.takeoverInFlight || !connectorOnline,
                                    inputEnabled = inputEnabled,
                                    attachmentsEnabled = inputEnabled && canUseAttachments && !commandMode,
                                    canSend = canSend,
                                    sending = state.sending,
                                    showInterrupt = showInterrupt,
                                    interrupting = state.interrupting,
                                    placeholder = placeholder,
                                    attachments = if (takeoverEnabled) attachments else emptyList(),
                                    onToggleTakeover = {
                                        if (!isPreparedSession) takeoverConfirm = !takeoverEnabled
                                    },
                                    onPickPhoto = ::openPhotoPicker,
                                    onPickFile = ::openFilePicker,
                                    onOpenCamera = ::openCamera,
                                    onRemoveAttachment = { remove ->
                                        setComposerAttachments(attachments.filterNot { it.id == remove.id })
                                    },
                                    onRetryAttachment = ::retryPendingAttachment,
                                    onPreviewAttachment = { previewImage = AttachmentPreview.Local(it) },
                                    onReadOnlyClick = ::handleReadOnlyComposerClick,
                                    onSend = ::sendDraft,
                                    onInterrupt = ::interrupt,
                                )
                            }
                        }
                        HeaderVeil(
                            darkMode = darkMode,
                            modifier = Modifier.align(Alignment.TopCenter),
                        )
                        SessionDetailHeader(
                            title = state.session?.title ?: stringResource(R.string.session_title_fallback),
                            darkMode = darkMode,
                            onLeftClick = {
                                showRuntimeSettings = true
                                if (state.catalogs.model == null && !state.catalogs.modelLoading) {
                                    loadModelCatalog()
                                }
                                if (state.catalogs.permission == null && !state.catalogs.permissionLoading) {
                                    loadPermissionCatalog()
                                }
                            },
                            onRightClick = { scope.launch { pagerState.animateScrollToPage(1) } },
                            modifier = Modifier.align(Alignment.TopCenter),
                        )
                        if (previewImage == null) {
                            AAToastHost(
                                hostState = snackbarHostState,
                                modifier = Modifier
                                    .align(Alignment.TopCenter)
                                    .padding(top = 76.dp, start = 22.dp, end = 22.dp),
                            )
                        }
                        if (showCamera) {
                            SessionCameraCapture(
                                onDismiss = { showCamera = false },
                                onCaptured = { attachment ->
                                    showCamera = false
                                    attachPending(attachment)
                                },
                                onError = { message -> showError(message) },
                            )
                        }
                    }
                }
            } else {
                SessionAgentFilesScreen(
                    session = state.session,
                    device = devices.firstOrNull { device -> device.id == state.session?.connectorId },
                    filesController = filesController,
                    terminalController = remoteTerminal,
                    darkMode = darkMode,
                    openFilePath = pendingOpenFilePath,
                    onOpenFileRequestConsumed = { consumed ->
                        if (pendingOpenFilePath == consumed) pendingOpenFilePath = null
                    },
                    onTerminalVerticalDragChange = { terminalVerticalDragActive = it },
                    onBack = { scope.launch { pagerState.animateScrollToPage(0) } },
                )
            }
        }
    }

    takeoverConfirm?.let { enabled ->
        TakeoverConfirmDialog(
            enabled = enabled,
            busy = state.takeoverInFlight,
            agentLabel = state.session?.runtimeLabel?.takeIf { it.isNotBlank() }
                ?: stringResource(R.string.session_agent_fallback).lowercase(),
            onDismiss = { if (!state.takeoverInFlight) takeoverConfirm = null },
            onConfirm = {
                takeoverConfirm = null
                applyTakeover(enabled)
            },
        )
    }

    if (showDeviceOffline) {
        DeviceOfflineDialog(onDismiss = { showDeviceOffline = false })
    }

    if (showRuntimeSettings) {
        SessionRuntimeSettingsSheet(
            runtimeLabel = state.session?.runtimeContextLabel.orEmpty(),
            modelOptions = modelOptions,
            permissionOptions = permissionOptions,
            selectedModelId = modelSelection,
            selectedPermissionId = permissionSelection,
            modelLoading = if (isPreparedSession) preparedModelLoading else state.catalogs.modelLoading,
            permissionLoading = if (isPreparedSession) preparedPermissionLoading else state.catalogs.permissionLoading,
            modelErrorMessage = if (isPreparedSession) preparedModelError else state.catalogs.modelErrorMessage,
            permissionErrorMessage = if (isPreparedSession) preparedPermissionError else state.catalogs.permissionErrorMessage,
            busy = if (isPreparedSession) preparedSessionCreating else state.selectionUpdating,
            darkMode = darkMode,
            onDismiss = { if (!state.selectionUpdating) showRuntimeSettings = false },
            onRetryModels = ::loadModelCatalog,
            onRetryPermissions = ::loadPermissionCatalog,
            onSelectModel = {
                val option = modelOptions.firstOrNull { option -> option.selectionId == it }
                if (option?.enabled == true) {
                    if (isPreparedSession) preparedSelections = preparedSelections.copy(model = it)
                    else updateSelection("model", it)
                } else {
                    showError(option?.disabledReason ?: context.getString(R.string.session_selection_update_failed))
                }
            },
            onSelectPermission = {
                val option = permissionOptions.firstOrNull { option -> option.selectionId == it }
                if (option?.enabled == true) {
                    if (isPreparedSession) preparedSelections = preparedSelections.copy(permission = it)
                    else updateSelection("permission", it)
                } else {
                    showError(option?.disabledReason ?: context.getString(R.string.session_selection_update_failed))
                }
            },
        )
    }

    val sessionImagePreviews = remember(state.messages) {
        state.messages
            .flatMap(TimelineMessage::attachments)
            .filter(TimelineAttachment::isImage)
            .distinctBy(TimelineAttachment::fileId)
            .map(AttachmentPreview::Remote)
    }
    previewImage?.let { preview ->
        AttachmentPreviewDialog(
            preview = preview,
            sessionImages = sessionImagePreviews,
            sessionId = sessionId.orEmpty(),
            controller = controller,
            toastHostState = snackbarHostState,
            onDownload = ::saveAttachment,
            onDismiss = { previewImage = null },
        )
    }
}

private fun SessionDetailState.effectiveRuntimeStatus(): SessionRuntimeStatus {
    if (runtime.status != SessionRuntimeStatus.Unknown) return runtime.status
    return when (session?.status) {
        SessionStatus.Idle -> SessionRuntimeStatus.Idle
        SessionStatus.Waiting -> SessionRuntimeStatus.Waiting
        SessionStatus.Pending -> SessionRuntimeStatus.Pending
        SessionStatus.Running -> SessionRuntimeStatus.Running
        SessionStatus.Stopping -> SessionRuntimeStatus.Stopping
        SessionStatus.WaitingApproval -> SessionRuntimeStatus.WaitingApproval
        SessionStatus.Blocked -> SessionRuntimeStatus.Blocked
        SessionStatus.Error -> SessionRuntimeStatus.Error
        SessionStatus.Unknown, null -> SessionRuntimeStatus.Unknown
    }
}

@Composable
private fun DeviceOfflineDialog(
    onDismiss: () -> Unit,
) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(26.dp)

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 22.dp)
                .widthIn(max = 380.dp)
                .shadow(34.dp, shape, ambientColor = colors.appShadow, spotColor = colors.appShadow)
                .clip(shape)
                .background(colors.dialogSurface)
                .border(1.dp, colors.border, shape)
                .padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text(
                text = stringResource(R.string.session_device_offline_title),
                color = colors.ink,
                fontSize = 24.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 29.sp,
            )
            Text(
                text = stringResource(R.string.session_device_offline_body),
                color = colors.muted,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 21.sp,
            )
            TakeoverDialogButton(
                label = stringResource(R.string.common_ok),
                background = colors.primaryAction,
                content = colors.onPrimaryAction,
                enabled = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp),
                onClick = onDismiss,
            )
        }
    }
}

@Composable
private fun TakeoverConfirmDialog(
    enabled: Boolean,
    busy: Boolean,
    agentLabel: String,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(26.dp)
    val secondaryButton = colors.subtle
    val message = if (enabled) {
        stringResource(R.string.session_enable_takeover_body, agentLabel)
    } else {
        stringResource(R.string.session_disable_takeover_body, agentLabel)
    }

    Dialog(
        onDismissRequest = { if (!busy) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 22.dp)
                .widthIn(max = 380.dp)
                .shadow(34.dp, shape, ambientColor = colors.appShadow, spotColor = colors.appShadow)
                .clip(shape)
                .background(colors.dialogSurface)
                .border(1.dp, colors.border, shape)
                .padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text(
                text = if (enabled) {
                    stringResource(R.string.session_enable_takeover_title)
                } else {
                    stringResource(R.string.session_disable_takeover_title)
                },
                color = colors.ink,
                fontSize = 24.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 29.sp,
            )
            Text(
                text = message,
                color = colors.muted,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 21.sp,
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TakeoverDialogButton(
                    label = stringResource(R.string.common_cancel),
                    background = secondaryButton,
                    content = colors.ink,
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                    onClick = onDismiss,
                )
                TakeoverDialogButton(
                    label = if (enabled) stringResource(R.string.common_enable) else stringResource(R.string.common_disable),
                    background = colors.primaryAction.copy(alpha = if (busy) 0.38f else 1f),
                    content = colors.onPrimaryAction,
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                    onClick = onConfirm,
                )
            }
        }
    }
}

@Composable
private fun TakeoverDialogButton(
    label: String,
    background: Color,
    content: Color,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .height(50.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(background)
            .noRippleClickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = content.copy(alpha = if (enabled) 1f else 0.55f),
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 19.sp,
        )
    }
}

private fun latestTimelineItemChanged(
    before: List<TimelineMessage>,
    after: List<TimelineMessage>,
): Boolean {
    val previous = before.lastOrNull { !it.optimistic }
    val current = after.lastOrNull { !it.optimistic }
    return previous?.sourceItemId != current?.sourceItemId ||
        previous?.revision != current?.revision ||
        previous?.updatedSeq != current?.updatedSeq
}

private fun Context.pendingAttachment(uri: Uri): PendingAttachment? {
    val resolver = contentResolver
    var name = getString(R.string.session_attachment_name_fallback)
    var size = 0L
    resolver.query(uri, null, null, null, null)?.use { cursor ->
        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (cursor.moveToFirst()) {
            if (nameIndex >= 0) name = cursor.getString(nameIndex) ?: name
            if (sizeIndex >= 0) size = cursor.getLong(sizeIndex)
        }
    }
    return PendingAttachment(
        uri = uri,
        name = name,
        mediaType = resolver.getType(uri).orEmpty(),
        size = size,
        id = "att_${UUID.randomUUID()}",
    )
}

private fun Context.uploadPart(attachment: PendingAttachment): UploadFilePart {
    val bytes = contentResolver.openInputStream(attachment.uri)?.use { input ->
        input.readBytes()
    } ?: throw IllegalStateException(getString(R.string.session_upload_file_read_failed, attachment.name))
    if (bytes.isEmpty()) throw IllegalStateException(getString(R.string.session_upload_file_empty, attachment.name))
    if (bytes.size > MAX_ATTACHMENT_BYTES) {
        throw IllegalStateException(getString(R.string.session_attachment_file_too_large, attachment.name))
    }
    val mediaType = attachment.mediaType.trim().lowercase()
    if (!isValidAttachmentMediaType(mediaType)) {
        throw IllegalStateException(getString(R.string.session_attachment_media_type_invalid, attachment.name))
    }
    return UploadFilePart(
        name = attachment.name,
        mediaType = mediaType,
        bytes = bytes,
    )
}

private fun UploadFilePart.toNewSessionAttachmentPart(): NewSessionAttachmentPart =
    NewSessionAttachmentPart(
        name = name,
        mediaType = mediaType,
        bytes = bytes,
    )

private fun UploadFilePart.toLocalTimelineAttachment(uri: Uri): TimelineAttachment {
    val sha256 = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString(separator = "") { byte -> "%02x".format(byte) }
    return TimelineAttachment(
        fileId = sha256,
        name = name,
        mediaType = mediaType,
        size = bytes.size.toLong(),
        sha256 = sha256,
        localPreviewUri = uri.toString().takeIf { mediaType.startsWith("image/") },
    )
}

private suspend fun saveImageToGallery(
    context: Context,
    downloaded: DownloadedAttachment,
): Result<Unit> = withContext(Dispatchers.IO) {
    runCatching {
        val displayName = downloaded.name
            .substringAfterLast('/')
            .substringAfterLast('\\')
            .ifBlank { "agents-anywhere-${System.currentTimeMillis()}.jpg" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
                put(MediaStore.Images.Media.MIME_TYPE, downloaded.mediaType.ifBlank { "image/jpeg" })
                put(
                    MediaStore.Images.Media.RELATIVE_PATH,
                    "${Environment.DIRECTORY_PICTURES}/Agents Anywhere",
                )
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
            val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            val imageUri = resolver.insert(collection, values)
                ?: error("Unable to create gallery image")
            try {
                resolver.openOutputStream(imageUri, "w")?.use { output ->
                    output.write(downloaded.bytes)
                } ?: error("Unable to open gallery image")
                resolver.update(
                    imageUri,
                    ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) },
                    null,
                    null,
                )
            } catch (error: Throwable) {
                resolver.delete(imageUri, null, null)
                throw error
            }
        } else {
            @Suppress("DEPRECATION")
            val pictures = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
            val directory = File(pictures, "Agents Anywhere")
            check(directory.exists() || directory.mkdirs()) { "Unable to create gallery directory" }
            val imageFile = uniqueGalleryFile(directory, displayName)
            imageFile.outputStream().use { output -> output.write(downloaded.bytes) }
            MediaScannerConnection.scanFile(
                context,
                arrayOf(imageFile.absolutePath),
                arrayOf(downloaded.mediaType.ifBlank { "image/jpeg" }),
                null,
            )
        }
        Unit
    }
}

private fun uniqueGalleryFile(directory: File, displayName: String): File {
    val requested = File(directory, displayName)
    if (!requested.exists()) return requested
    val dotIndex = displayName.lastIndexOf('.').takeIf { it > 0 } ?: displayName.length
    val baseName = displayName.substring(0, dotIndex)
    val extension = displayName.substring(dotIndex)
    var suffix = 1
    while (true) {
        val candidate = File(directory, "$baseName ($suffix)$extension")
        if (!candidate.exists()) return candidate
        suffix += 1
    }
}

private const val MAX_ATTACHMENT_FILES = 6
private const val MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
