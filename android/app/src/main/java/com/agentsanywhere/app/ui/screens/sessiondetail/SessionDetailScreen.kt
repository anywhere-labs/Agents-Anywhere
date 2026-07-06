package com.agentsanywhere.app.ui.screens.sessiondetail

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.OpenableColumns
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.core.content.ContextCompat
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.UploadFilePart
import com.agentsanywhere.app.feature.files.FilesController
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailState
import com.agentsanywhere.app.feature.sessiondetail.SessionStreamEvent
import com.agentsanywhere.app.feature.sessiondetail.TimelineApproval
import com.agentsanywhere.app.feature.terminal.RemoteTerminalController
import com.agentsanywhere.app.feature.terminal.RemoteTerminalForegroundService
import com.agentsanywhere.app.feature.terminal.TerminalController
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.ShieldCheck
import com.composables.icons.lucide.X
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionDetailScreen(
    navigate: (AppDestination) -> Unit,
    sessionId: String?,
    initialSession: AgentSession?,
    devices: List<AgentDevice>,
    controller: SessionDetailController,
    filesController: FilesController,
    terminalController: TerminalController,
    composerDraftStore: SessionComposerDraftStore,
    onSessionChanged: (AgentSession) -> Unit = {},
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val haptic = LocalHapticFeedback.current
    val snackbarHostState = remember { SnackbarHostState() }
    val pagerState = rememberPagerState(pageCount = { 2 })
    val restoredComposerDraft = remember(sessionId) {
        composerDraftStore.restore(
            sessionId = sessionId,
            uploadCancelledMessage = context.getString(R.string.session_attachment_upload_failed),
        )
    }
    var draft by remember(sessionId) { mutableStateOf(restoredComposerDraft.text) }
    var forceLatestRequest by remember(sessionId) { mutableStateOf(0) }
    var streamLatestRequest by remember(sessionId) { mutableStateOf(0) }
    var attachments by remember(sessionId) { mutableStateOf(restoredComposerDraft.attachments) }
    var takeoverConfirm by remember(sessionId) { mutableStateOf<Boolean?>(null) }
    var pendingErrorSend by remember(sessionId) { mutableStateOf<String?>(null) }
    var previewImage by remember(sessionId) { mutableStateOf<AttachmentPreview?>(null) }
    var showCamera by remember(sessionId) { mutableStateOf(false) }
    var showDeviceOffline by remember(sessionId) { mutableStateOf(false) }
    var showRuntimeSettings by remember(sessionId) { mutableStateOf(false) }
    var pendingOpenFilePath by remember(sessionId) { mutableStateOf<String?>(null) }
    var terminalVerticalDragActive by remember(sessionId) { mutableStateOf(false) }
    var resolvingApprovalId by remember(sessionId) { mutableStateOf<String?>(null) }
    var resolvingApprovalStatus by remember(sessionId) { mutableStateOf<String?>(null) }
    var composerHeightPx by remember { mutableStateOf(0) }
    var readOnlyComposerTapCount by remember(sessionId) { mutableStateOf(0) }
    val refetchInFlight = remember(sessionId) { AtomicBoolean(false) }
    val olderInFlight = remember(sessionId) { AtomicBoolean(false) }
    val streamOpen = remember(sessionId) { AtomicBoolean(false) }
    val remoteTerminal = remember(sessionId, terminalController) { RemoteTerminalController(terminalController) }

    var appVisible by remember(lifecycleOwner) {
        mutableStateOf(lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
    }
    var state by remember(sessionId) {
        mutableStateOf(
            SessionDetailState(
                session = initialSession?.takeIf { it.id == sessionId },
                messages = emptyList(),
                isLoading = sessionId != null,
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

    fun copyMessageText(text: String) {
        val copyText = text.trimEnd('\r', '\n')
        if (copyText.isBlank()) return
        clipboard.setText(AnnotatedString(copyText))
        showToast(context.getString(R.string.common_copied))
    }

    fun openReferencedFile(path: String) {
        val trimmed = path.trim()
        if (trimmed.isBlank()) return
        pendingOpenFilePath = trimmed
        scope.launch { pagerState.animateScrollToPage(1) }
    }

    fun saveComposerDraft(nextDraft: String, nextAttachments: List<PendingAttachment>) {
        composerDraftStore.save(sessionId, nextDraft, nextAttachments)
    }

    fun setComposerDraft(nextDraft: String) {
        draft = nextDraft
        saveComposerDraft(nextDraft, attachments)
    }

    fun setComposerAttachments(nextAttachments: List<PendingAttachment>) {
        attachments = nextAttachments
        saveComposerDraft(draft, nextAttachments)
    }

    fun clearComposerDraft() {
        draft = ""
        attachments = emptyList()
        composerDraftStore.clear(sessionId)
    }

    fun updateAttachment(id: String, transform: (PendingAttachment) -> PendingAttachment) {
        val nextAttachments = attachments.map { attachment ->
            if (attachment.id == id) transform(attachment) else attachment
        }
        setComposerAttachments(nextAttachments)
    }

    fun uploadPendingAttachment(attachment: PendingAttachment) {
        val id = sessionId ?: return
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
                            errorMessage = error.message ?: context.getString(R.string.session_attachment_upload_failed),
                        )
                    }
                }
        }
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

    suspend fun refetch(showLoading: Boolean) {
        val id = sessionId ?: return
        if (!appVisible) return
        if (!refetchInFlight.compareAndSet(false, true)) return
        if (showLoading) state = state.copy(isLoading = true, loadingOlder = false, errorMessage = null)
        try {
            controller.load(id, devices, state)
                .onSuccess { loaded ->
                    if (!appVisible) return@onSuccess
                    state = state.copy(
                        session = loaded.session ?: state.session,
                        messages = loaded.messages,
                        approvals = loaded.approvals,
                        nextSeq = max(state.nextSeq, loaded.nextSeq),
                        hasMore = loaded.hasMore,
                        isLoading = false,
                        loadingOlder = false,
                        errorMessage = null,
                    )
                    state.session?.let(onSessionChanged)
                }
                .onFailure { error ->
                    if (appVisible) {
                        state = state.copy(
                            isLoading = false,
                            loadingOlder = false,
                            errorMessage = error.message ?: context.getString(R.string.session_load_messages_failed),
                        )
                    }
                }
        } finally {
            refetchInFlight.set(false)
        }
    }

    fun loadOlderMessages() {
        val id = sessionId ?: return
        if (!appVisible || !state.hasMore || state.loadingOlder) return
        if (!olderInFlight.compareAndSet(false, true)) return
        val beforeOrderSeq = state.messages
            .filterNot { it.optimistic }
            .minOfOrNull { it.orderSeq }
        if (beforeOrderSeq == null || beforeOrderSeq <= 1) {
            olderInFlight.set(false)
            state = state.copy(hasMore = false, loadingOlder = false)
            return
        }
        state = state.copy(loadingOlder = true, actionError = null)
        scope.launch {
            try {
                controller.loadOlder(id, beforeOrderSeq, devices)
                    .onSuccess { older ->
                        if (!appVisible) return@onSuccess
                        state = controller.applyOlder(id, state, older)
                        state.session?.let(onSessionChanged)
                    }
                    .onFailure { error ->
                        val message = error.message ?: context.getString(R.string.session_load_messages_failed)
                        state = state.copy(loadingOlder = false, actionError = message)
                        showError(message)
                    }
            } finally {
                olderInFlight.set(false)
            }
        }
    }

    fun sendText(text: String) {
        val id = sessionId ?: return
        val clientMessageId = "opt_${UUID.randomUUID()}"
        val pendingAttachments = attachments
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        scope.launch {
            if (pendingAttachments.any { it.uploadState != AttachmentUploadState.Uploaded || it.remote == null }) {
                showError(context.getString(R.string.session_wait_uploads))
                return@launch
            }
            val uploadedAttachments = pendingAttachments.mapNotNull { it.remote }
            state = controller.addOptimisticMessage(
                sessionId = id,
                state = state,
                text = text,
                clientMessageId = clientMessageId,
                attachments = uploadedAttachments,
            )
            clearComposerDraft()
            unfocusComposer()
            forceLatestRequest += 1
            controller.sendMessage(
                sessionId = id,
                content = text,
                clientMessageId = clientMessageId,
                uploadedAttachments = uploadedAttachments,
            )
                .onSuccess { result ->
                    state = controller.markOptimisticMessage(
                        sessionId = id,
                        state = state,
                        clientMessageId = clientMessageId,
                        status = "running",
                        turnId = result.turnId,
                        attachments = result.attachments,
                    )
                }
                .onFailure { error ->
                    val message = error.message ?: context.getString(R.string.session_send_failed)
                    state = controller.markOptimisticMessage(
                        sessionId = id,
                        state = state,
                        clientMessageId = clientMessageId,
                        status = "failed",
                    ).copy(actionError = message)
                    showError(message)
                }
        }
    }

    fun sendDraft() {
        val text = draft.trim()
        if (text.isEmpty() && attachments.isEmpty()) return
        if (state.session?.status == SessionStatus.Error) {
            pendingErrorSend = text
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
                    state = state.copy(session = session, takeoverInFlight = false)
                    onSessionChanged(session)
                }
                .onFailure { error ->
                    val message = error.message ?: context.getString(R.string.session_takeover_update_failed)
                    state = state.copy(takeoverInFlight = false, actionError = message)
                    showError(message)
                }
        }
    }

    fun loadRuntimeSettings() {
        val id = sessionId ?: return
        val runtime = state.session?.runtime ?: return
        if (state.runtimeSettings.isLoading || state.runtimeSettings.schema != null) return
        state = state.copy(
            runtimeSettings = state.runtimeSettings.copy(isLoading = true, errorMessage = null),
        )
        scope.launch {
            controller.loadRuntimeSettings(id, runtime)
                .onSuccess { runtimeState ->
                    state = state.copy(runtimeSettings = runtimeState)
                }
                .onFailure { error ->
                    val message = error.message ?: context.getString(R.string.session_runtime_load_failed)
                    state = state.copy(
                        runtimeSettings = state.runtimeSettings.copy(
                            isLoading = false,
                            errorMessage = message,
                        ),
                    )
                    showError(message)
                }
        }
    }

    fun patchRuntimeSetting(key: String, value: String?) {
        val id = sessionId ?: return
        if (state.runtimeSettings.savingKey != null) return
        state = state.copy(
            runtimeSettings = state.runtimeSettings.copy(savingKey = key, errorMessage = null),
        )
        scope.launch {
            controller.patchRuntimeSettings(id, mapOf(key to value))
                .onSuccess { result ->
                    val currentSchema = state.runtimeSettings.schema
                    val nextRuntimeSettings = result.settings.copy(schema = currentSchema)
                    val nextSession = state.session?.copy(
                        runtimeSettings = nextRuntimeSettings.settings,
                        runtimeSettingsOverride = nextRuntimeSettings.overrideSettings,
                    )
                    state = state.copy(
                        session = nextSession ?: state.session,
                        runtimeSettings = nextRuntimeSettings,
                    )
                    nextSession?.let(onSessionChanged)
                }
                .onFailure { error ->
                    val message = error.message ?: context.getString(R.string.session_runtime_save_failed)
                    state = state.copy(
                        runtimeSettings = state.runtimeSettings.copy(
                            savingKey = null,
                            errorMessage = message,
                        ),
                    )
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
                .onFailure { error ->
                    val message = error.message ?: context.getString(R.string.session_interrupt_failed)
                    if (message.contains("no active turn", ignoreCase = true)) {
                        state = state.copy(actionError = null)
                        refetch(showLoading = false)
                    } else {
                        state = state.copy(interrupting = false, actionError = message)
                        showError(message)
                    }
                }
        }
    }

    fun resolveApproval(approval: TimelineApproval, status: String) {
        if (resolvingApprovalId != null) return
        resolvingApprovalId = approval.id
        resolvingApprovalStatus = status
        scope.launch {
            controller.resolveApproval(approval.id, status)
                .onSuccess {
                    state = state.copy(approvals = state.approvals.filterNot { it.id == approval.id })
                }
                .onFailure { error ->
                    val message = error.message ?: context.getString(R.string.session_approval_resolve_failed)
                    state = state.copy(actionError = message)
                    showError(message)
                }
            resolvingApprovalId = null
            resolvingApprovalStatus = null
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
            streamOpen.set(false)
            refetchInFlight.set(false)
            olderInFlight.set(false)
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    DisposableEffect(remoteTerminal) {
        onDispose {
            remoteTerminal.closeAndDispose()
        }
    }

    LaunchedEffect(sessionId, initialSession) {
        val session = initialSession
        if (session != null && session.id == sessionId) {
            state = state.copy(
                session = session,
                runtimeSettings = state.runtimeSettings.copy(
                    settings = session.runtimeSettings,
                    overrideSettings = session.runtimeSettingsOverride,
                ),
            )
        }
    }

    LaunchedEffect(showRuntimeSettings, sessionId, state.session?.runtime) {
        if (showRuntimeSettings) loadRuntimeSettings()
    }

    LaunchedEffect(sessionId, appVisible, devices) {
        if (sessionId == null || !appVisible) return@LaunchedEffect
        refetch(showLoading = state.messages.isEmpty())
        while (true) {
            delay(3_000)
            if (!streamOpen.get()) refetch(showLoading = false)
        }
    }

    LaunchedEffect(sessionId, appVisible, devices) {
        val id = sessionId
        if (id == null || !appVisible) return@LaunchedEffect
        controller.streamEvents(id, devices).collect { event ->
            when (event) {
                SessionStreamEvent.Connected -> {
                    streamOpen.set(true)
                    state = state.copy(sseConnected = true)
                }
                SessionStreamEvent.Disconnected -> {
                    streamOpen.set(false)
                    state = state.copy(sseConnected = false)
                }
                is SessionStreamEvent.Failed -> {
                    streamOpen.set(false)
                    state = state.copy(sseConnected = false)
                    if (state.messages.isEmpty()) {
                        state = state.copy(isLoading = false, errorMessage = event.message)
                    }
                }
                is SessionStreamEvent.Delta -> {
                    if (event.value.refetch) {
                        refetch(showLoading = false)
                    } else {
                        state = controller.applyDelta(id, state, event.value)
                        state.session?.let(onSessionChanged)
                        if (event.value.messages.isNotEmpty()) streamLatestRequest += 1
                    }
                }
            }
        }
    }

    val serverBusy = state.session?.status == SessionStatus.Running ||
        state.session?.status == SessionStatus.WaitingApproval
    LaunchedEffect(state.interrupting, serverBusy) {
        if (state.interrupting && !serverBusy) state = state.copy(interrupting = false)
    }

    val pendingApproval = remember(state.approvals) {
        state.approvals
            .filter { it.status == "pending" }
            .minWithOrNull(compareBy<TimelineApproval> { it.updatedSeq }.thenBy { it.id })
    }
    val connectorOnline = state.session?.connectorOnline == true
    val takeoverEnabled = state.session?.takeover == true
    val inputEnabled = takeoverEnabled && connectorOnline
    val attachmentsReady = attachments.all { it.uploadState == AttachmentUploadState.Uploaded }
    val canSend = inputEnabled &&
        !state.sending &&
        attachmentsReady &&
        (draft.isNotBlank() || attachments.isNotEmpty()) &&
        (state.session?.status == SessionStatus.Idle || state.session?.status == SessionStatus.Error)
    val agentLabel = state.session?.runtimeLabel?.takeIf { it.isNotBlank() }
        ?: context.getString(R.string.session_agent_fallback)
    val workingLabel = when {
        state.interrupting -> context.getString(R.string.session_agent_interrupting, agentLabel)
        state.sending ||
            state.session?.status == SessionStatus.Running ||
            state.messages.any { it.optimistic && it.status == "running" } -> {
            context.getString(R.string.session_agent_working, agentLabel)
        }
        else -> null
    }
    val showInterrupt = inputEnabled && (serverBusy || state.interrupting) && draft.isBlank() && attachments.isEmpty()
    val replyTarget = state.session?.runtimeLabel?.takeIf { it.isNotBlank() }
        ?: stringResource(R.string.session_agent_fallback)
    val placeholder = when {
        state.session != null && !connectorOnline -> stringResource(R.string.session_device_offline_placeholder)
        takeoverEnabled -> stringResource(R.string.session_reply_to, replyTarget)
        else -> stringResource(R.string.session_read_only_placeholder)
    }

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
                        .pointerInput(composerHeightPx) {
                            awaitPointerEventScope {
                                while (true) {
                                    val down = awaitPointerEvent(PointerEventPass.Initial)
                                        .changes
                                        .firstOrNull { it.pressed && !it.previousPressed }
                                        ?: continue
                                    if (composerHeightPx > 0 && down.position.y < size.height - composerHeightPx) {
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
                            sessionId == null -> EmptyDetailMessage(stringResource(R.string.session_open_from_list))
                            state.isLoading && state.messages.isEmpty() -> SessionDetailLoadingState(darkMode = darkMode)
                            state.errorMessage != null && state.messages.isEmpty() -> EmptyDetailMessage(state.errorMessage.orEmpty())
                            state.messages.isEmpty() -> SessionWelcomeMessage(darkMode = darkMode)
                            else -> MessageList(
                                messages = state.messages,
                                darkMode = darkMode,
                                sessionId = sessionId.orEmpty(),
                                controller = controller,
                                forceLatestRequest = forceLatestRequest,
                                streamLatestRequest = streamLatestRequest,
                                workingLabel = workingLabel,
                                hasMore = state.hasMore,
                                loadingOlder = state.loadingOlder,
                                onLoadOlder = { loadOlderMessages() },
                                onPreviewAttachment = { previewImage = AttachmentPreview.Remote(it) },
                                onCopyMessage = ::copyMessageText,
                                onOpenFile = ::openReferencedFile,
                            )
                        }
                        ComposerVeil(
                            darkMode = darkMode,
                            modifier = Modifier.align(Alignment.BottomCenter),
                        )
                        MessageComposer(
                            darkMode = darkMode,
                            draft = draft,
                            onDraftChange = ::setComposerDraft,
                            takeoverEnabled = takeoverEnabled,
                            takeoverBusy = state.takeoverInFlight || !connectorOnline,
                            inputEnabled = inputEnabled,
                            canSend = canSend,
                            showInterrupt = showInterrupt,
                            interrupting = state.interrupting,
                            placeholder = placeholder,
                            attachments = attachments,
                            onToggleTakeover = { takeoverConfirm = !takeoverEnabled },
                            onPickPhoto = ::openPhotoPicker,
                            onPickFile = ::openFilePicker,
                            onOpenCamera = ::openCamera,
                            onRemoveAttachment = { remove ->
                                setComposerAttachments(attachments.filterNot { it.id == remove.id })
                            },
                            onPreviewAttachment = { previewImage = AttachmentPreview.Local(it) },
                            onReadOnlyClick = ::handleReadOnlyComposerClick,
                            onSend = ::sendDraft,
                            onInterrupt = ::interrupt,
                            modifier = Modifier
                                .align(Alignment.BottomCenter)
                                .onSizeChanged { composerHeightPx = it.height },
                        )
                        HeaderVeil(
                            darkMode = darkMode,
                            modifier = Modifier.align(Alignment.TopCenter),
                        )
                        SessionDetailHeader(
                            title = state.session?.title ?: stringResource(R.string.session_title_fallback),
                            darkMode = darkMode,
                            onLeftClick = { showRuntimeSettings = true },
                            onRightClick = { scope.launch { pagerState.animateScrollToPage(1) } },
                            modifier = Modifier.align(Alignment.TopCenter),
                        )
                        AAToastHost(
                            hostState = snackbarHostState,
                            modifier = Modifier
                                .align(Alignment.TopCenter)
                                .padding(top = 76.dp, start = 22.dp, end = 22.dp),
                        )
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

    if (showRuntimeSettings) {
        val session = state.session
        if (session == null) {
            showRuntimeSettings = false
        } else {
            SessionRuntimeSettingsSheet(
                session = session,
                state = state.runtimeSettings,
                darkMode = darkMode,
                onDismiss = { showRuntimeSettings = false },
                onPatch = ::patchRuntimeSetting,
            )
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

    pendingErrorSend?.let { text ->
        ErrorSendConfirmDialog(
            onDismiss = { pendingErrorSend = null },
            onConfirm = {
                pendingErrorSend = null
                sendText(text)
            },
        )
    }

    pendingApproval?.let { approval ->
        ApprovalDialog(
            approval = approval,
            resolvingStatus = resolvingApprovalStatus.takeIf { resolvingApprovalId == approval.id },
            onDismiss = {},
            onResolve = { status -> resolveApproval(approval, status) },
        )
    }

    previewImage?.let { preview ->
        AttachmentPreviewDialog(
            preview = preview,
            sessionId = sessionId.orEmpty(),
            controller = controller,
            onDismiss = { previewImage = null },
        )
    }
}

@Composable
private fun DeviceOfflineDialog(
    onDismiss: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val shape = RoundedCornerShape(26.dp)
    val surface = if (darkMode) Color(0xFF18181B) else Color.White

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 22.dp)
                .widthIn(max = 380.dp)
                .shadow(34.dp, shape, ambientColor = Color(0x33000000), spotColor = Color(0x33000000))
                .clip(shape)
                .background(surface)
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
    val darkMode = colors.canvas == Color(0xFF09090B)
    val shape = RoundedCornerShape(26.dp)
    val surface = if (darkMode) Color(0xFF18181B) else Color.White
    val secondaryButton = if (darkMode) Color(0xFF27272A) else Color(0xFFF3F3F3)
    val message = if (enabled) {
        stringResource(R.string.session_enable_takeover_body, agentLabel)
    } else {
        stringResource(R.string.session_disable_takeover_body)
    }

    Dialog(
        onDismissRequest = { if (!busy) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 22.dp)
                .widthIn(max = 380.dp)
                .shadow(34.dp, shape, ambientColor = Color(0x33000000), spotColor = Color(0x33000000))
                .clip(shape)
                .background(surface)
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

@Composable
private fun ErrorSendConfirmDialog(
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.session_send_anyway_title)) },
        text = { Text(stringResource(R.string.session_send_anyway_body)) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(stringResource(R.string.common_send))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.common_cancel))
            }
        },
    )
}

@Composable
private fun ApprovalDialog(
    approval: TimelineApproval,
    resolvingStatus: String?,
    onDismiss: () -> Unit,
    onResolve: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val shape = RoundedCornerShape(26.dp)
    val surface = if (darkMode) Color(0xFF18181B) else Color.White
    val iconSurface = if (darkMode) Color(0xFF2A2316) else Color(0xFFFFF4D6)
    val secondaryButton = if (darkMode) Color(0xFF27272A) else Color(0xFFF3F3F3)
    val busy = resolvingStatus != null
    val description = approval.description
        ?: stringResource(R.string.session_approval_fallback, approval.kind.replace('_', ' '))
    val title = approval.title.ifBlank { stringResource(R.string.session_approval_requested) }
    val hasApprove = "approve" in approval.choices
    val hasApproveForSession = "approve_for_session" in approval.choices
    val hasReject = "reject" in approval.choices

    Dialog(
        onDismissRequest = { if (!busy) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 22.dp)
                .widthIn(max = 392.dp)
                .shadow(34.dp, shape, ambientColor = Color(0x33000000), spotColor = Color(0x33000000))
                .clip(shape)
                .background(surface)
                .border(1.dp, colors.border, shape)
                .padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .height(44.dp)
                        .widthIn(min = 44.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .background(iconSurface),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Lucide.ShieldCheck,
                        contentDescription = null,
                        tint = Color(0xFFEAB308),
                        modifier = Modifier.size(22.dp),
                    )
                }
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Text(
                        text = stringResource(R.string.session_approval_requested),
                        color = colors.muted,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        lineHeight = 14.sp,
                    )
                    Text(
                        text = title,
                        color = colors.ink,
                        fontSize = 21.sp,
                        fontWeight = FontWeight.ExtraBold,
                        lineHeight = 25.sp,
                    )
                }
            }
            Text(
                text = description,
                color = colors.muted,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 21.sp,
            )
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (hasApprove) {
                    ApprovalDialogButton(
                        label = if (resolvingStatus == "approved") {
                            stringResource(R.string.common_working)
                        } else {
                            stringResource(R.string.session_approval_allow)
                        },
                        icon = "check",
                        loading = resolvingStatus == "approved",
                        background = colors.primaryAction.copy(alpha = if (busy) 0.42f else 1f),
                        content = colors.onPrimaryAction,
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                        onClick = { onResolve("approved") },
                    )
                }
                if (hasReject || hasApproveForSession) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        if (hasReject) {
                            ApprovalDialogButton(
                                label = if (resolvingStatus == "rejected") {
                                    stringResource(R.string.common_working)
                                } else {
                                    stringResource(R.string.session_approval_deny)
                                },
                                icon = "reject",
                                loading = resolvingStatus == "rejected",
                                background = secondaryButton,
                                content = colors.ink,
                                enabled = !busy,
                                modifier = Modifier.weight(1f),
                                onClick = { onResolve("rejected") },
                            )
                        }
                        if (hasApproveForSession) {
                            ApprovalDialogButton(
                                label = if (resolvingStatus == "approved_for_session") {
                                    stringResource(R.string.common_working)
                                } else {
                                    stringResource(R.string.session_approval_always_allow)
                                },
                                icon = "session",
                                loading = resolvingStatus == "approved_for_session",
                                background = if (hasApprove) {
                                    secondaryButton
                                } else {
                                    colors.primaryAction.copy(alpha = if (busy) 0.42f else 1f)
                                },
                                content = if (hasApprove) colors.ink else colors.onPrimaryAction,
                                enabled = !busy,
                                modifier = Modifier.weight(1f),
                                onClick = { onResolve("approved_for_session") },
                            )
                        }
                    }
                }
                if (!hasApprove && !hasApproveForSession && !hasReject) {
                    Text(
                        text = stringResource(R.string.session_approval_no_actions),
                        color = colors.errorText,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        lineHeight = 17.sp,
                    )
                }
            }
        }
    }
}

@Composable
private fun ApprovalDialogButton(
    label: String,
    icon: String,
    loading: Boolean,
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
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 12.dp),
        ) {
            if (loading) {
                CircularProgressIndicator(
                    color = content,
                    strokeWidth = 2.dp,
                    modifier = Modifier.size(16.dp),
                )
            } else {
                Icon(
                    imageVector = when (icon) {
                        "reject" -> Lucide.X
                        "session" -> Lucide.ShieldCheck
                        else -> Lucide.Check
                    },
                    contentDescription = null,
                    tint = content.copy(alpha = if (enabled) 1f else 0.55f),
                    modifier = Modifier.size(17.dp),
                )
            }
            Text(
                text = label,
                color = content.copy(alpha = if (enabled) 1f else 0.55f),
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                lineHeight = 18.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
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
    return UploadFilePart(
        name = attachment.name,
        mediaType = attachment.mediaType,
        bytes = bytes,
    )
}

private const val MAX_ATTACHMENT_FILES = 6
private const val MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
