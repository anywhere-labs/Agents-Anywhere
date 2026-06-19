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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.core.content.ContextCompat
import com.agentsanywhere.app.api.UploadFilePart
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailState
import com.agentsanywhere.app.feature.sessiondetail.SessionStreamEvent
import com.agentsanywhere.app.feature.sessiondetail.TimelineApproval
import com.agentsanywhere.app.feature.sessiondetail.RemoteTerminalController
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
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
    onSessionChanged: (AgentSession) -> Unit = {},
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val haptic = LocalHapticFeedback.current
    val snackbarHostState = remember { SnackbarHostState() }
    val pagerState = rememberPagerState(pageCount = { 2 })
    var draft by remember(sessionId) { mutableStateOf("") }
    var pinLatestRequest by remember(sessionId) { mutableStateOf(0) }
    var attachments by remember(sessionId) { mutableStateOf(emptyList<PendingAttachment>()) }
    var takeoverConfirm by remember(sessionId) { mutableStateOf<Boolean?>(null) }
    var pendingErrorSend by remember(sessionId) { mutableStateOf<String?>(null) }
    var previewImage by remember(sessionId) { mutableStateOf<AttachmentPreview?>(null) }
    var showCamera by remember(sessionId) { mutableStateOf(false) }
    var showRuntimeSettings by remember(sessionId) { mutableStateOf(false) }
    var composerHeightPx by remember { mutableStateOf(0) }
    var readOnlyComposerTapCount by remember(sessionId) { mutableStateOf(0) }
    val refetchInFlight = remember(sessionId) { AtomicBoolean(false) }
    val streamOpen = remember(sessionId) { AtomicBoolean(false) }
    val remoteTerminal = remember(sessionId) { RemoteTerminalController(controller) }

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

    fun updateAttachment(id: String, transform: (PendingAttachment) -> PendingAttachment) {
        attachments = attachments.map { attachment ->
            if (attachment.id == id) transform(attachment) else attachment
        }
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
                        errorMessage = error.message ?: "Could not read attachment.",
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
                                errorMessage = "Upload returned no file.",
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
                            errorMessage = error.message ?: "Could not upload attachment.",
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
            takeoverConfirm = true
        }
    }

    fun attachPending(picked: List<PendingAttachment>) {
        val remainingSlots = MAX_ATTACHMENT_FILES - attachments.size
        if (remainingSlots <= 0) {
            showError("You can attach up to $MAX_ATTACHMENT_FILES files per message.")
            return
        }
        if (picked.size > remainingSlots) {
            showError("You can attach up to $MAX_ATTACHMENT_FILES files per message.")
        }
        val accepted = picked
            .filter { attachment ->
                if (attachment.size > MAX_ATTACHMENT_BYTES) {
                    showError("${attachment.name} exceeds 25 MB.")
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
        attachments = attachments + accepted
        accepted.forEach(::uploadPendingAttachment)
    }

    fun attachPending(attachment: PendingAttachment?) {
        if (attachment == null) {
            showError("Could not read that attachment.")
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
            showError("Camera permission is required to take a photo.")
        }
    }

    fun openPhotoPicker() {
        try {
            photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        } catch (_: Exception) {
            showError("Please allow photo access to choose images.")
        }
    }

    fun openFilePicker() {
        try {
            filePicker.launch(arrayOf("*/*"))
        } catch (_: Exception) {
            showError("Could not open file picker.")
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
        if (showLoading) state = state.copy(isLoading = true, errorMessage = null)
        try {
            controller.load(id, devices, state)
                .onSuccess { loaded ->
                    if (!appVisible) return@onSuccess
                    state = state.copy(
                        session = loaded.session ?: state.session,
                        messages = loaded.messages,
                        approvals = loaded.approvals,
                        nextSeq = max(state.nextSeq, loaded.nextSeq),
                        isLoading = false,
                        errorMessage = null,
                    )
                    state.session?.let(onSessionChanged)
                }
                .onFailure { error ->
                    if (appVisible) {
                        state = state.copy(
                            isLoading = false,
                            errorMessage = error.message ?: "Could not load messages.",
                        )
                    }
                }
        } finally {
            refetchInFlight.set(false)
        }
    }

    fun sendText(text: String) {
        val id = sessionId ?: return
        val clientMessageId = "opt_${UUID.randomUUID()}"
        val pendingAttachments = attachments
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        scope.launch {
            if (pendingAttachments.any { it.uploadState != AttachmentUploadState.Uploaded || it.remote == null }) {
                showError("Wait for attachments to finish uploading.")
                return@launch
            }
            val uploadedAttachments = pendingAttachments.mapNotNull { it.remote }
            state = controller.addOptimisticMessage(
                state,
                text,
                clientMessageId,
                attachments = uploadedAttachments,
            )
            draft = ""
            attachments = emptyList()
            unfocusComposer()
            pinLatestRequest += 1
            controller.sendMessage(
                sessionId = id,
                content = text,
                clientMessageId = clientMessageId,
                uploadedAttachments = uploadedAttachments,
            )
                .onSuccess { result ->
                    state = controller.markOptimisticMessage(
                        state = state,
                        clientMessageId = clientMessageId,
                        status = "running",
                        turnId = result.turnId,
                        attachments = result.attachments,
                    )
                }
                .onFailure { error ->
                    val message = error.message ?: "Could not send message."
                    state = controller.markOptimisticMessage(state, clientMessageId, "failed")
                        .copy(actionError = message)
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
                    val message = error.message ?: "Could not update takeover."
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
                    val message = error.message ?: "Could not load runtime settings."
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
                        effectiveRunMode = result.effectiveRunMode ?: state.session?.effectiveRunMode,
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
                    val message = error.message ?: "Could not save runtime settings."
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
                    val message = error.message ?: "Could not interrupt this session."
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
        state = state.copy(approvals = state.approvals.filterNot { it.id == approval.id })
        scope.launch {
            controller.resolveApproval(approval.id, status)
                .onFailure { error ->
                    val message = error.message ?: "Could not resolve approval."
                    state = state.copy(actionError = message)
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
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    DisposableEffect(remoteTerminal) {
        onDispose {
            scope.launch {
                remoteTerminal.close()
                remoteTerminal.dispose()
            }
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
                        state = controller.applyDelta(state, event.value)
                        state.session?.let(onSessionChanged)
                        if (event.value.messages.isNotEmpty()) pinLatestRequest += 1
                    }
                }
            }
        }
    }

    val serverBusy = state.session?.status == SessionStatus.Running ||
        state.session?.status == SessionStatus.WaitingApproval
    val isBusy = serverBusy && !state.interrupting
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
    val terminalMode = state.session?.runtime == "claude" && state.session?.effectiveRunMode == "terminal"
    val inputEnabled = takeoverEnabled && connectorOnline && !terminalMode
    val attachmentsReady = attachments.all { it.uploadState == AttachmentUploadState.Uploaded }
    val canSend = inputEnabled &&
        !state.sending &&
        attachmentsReady &&
        (draft.isNotBlank() || attachments.isNotEmpty()) &&
        (state.session?.status == SessionStatus.Idle || state.session?.status == SessionStatus.Error)
    val workingLabel = if (!state.interrupting && (
        state.sending ||
        state.session?.status == SessionStatus.Running ||
        state.messages.any { it.optimistic && it.status == "running" }
    )) {
        "${state.session?.runtimeLabel?.takeIf { it.isNotBlank() } ?: "Agent"} is working"
    } else {
        null
    }
    val showInterrupt = inputEnabled && isBusy && draft.isBlank() && attachments.isEmpty()
    val replyTarget = state.session?.runtimeLabel?.takeIf { it.isNotBlank() } ?: "Agent"
    val placeholder = if (takeoverEnabled) {
        "Reply to $replyTarget"
    } else {
        "Read only, turn on take over to send messages."
    }

    ScreenScaffold {
        HorizontalPager(
            state = pagerState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            beyondViewportPageCount = 1,
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
                            sessionId == null -> EmptyDetailMessage("Open a session from the list.")
                            state.isLoading && state.messages.isEmpty() -> SessionDetailLoadingState(darkMode = darkMode)
                            state.errorMessage != null && state.messages.isEmpty() -> EmptyDetailMessage(state.errorMessage.orEmpty())
                            else -> MessageList(
                                messages = state.messages,
                                darkMode = darkMode,
                                sessionId = sessionId.orEmpty(),
                                controller = controller,
                                pinLatestRequest = pinLatestRequest,
                                workingLabel = workingLabel,
                                onPreviewAttachment = { previewImage = AttachmentPreview.Remote(it) },
                            )
                        }
                        ComposerVeil(
                            darkMode = darkMode,
                            modifier = Modifier.align(Alignment.BottomCenter),
                        )
                        MessageComposer(
                            darkMode = darkMode,
                            draft = draft,
                            onDraftChange = { draft = it },
                            takeoverEnabled = takeoverEnabled,
                            takeoverBusy = state.takeoverInFlight || !connectorOnline,
                            inputEnabled = inputEnabled,
                            canSend = canSend,
                            showInterrupt = showInterrupt,
                            placeholder = placeholder,
                            attachments = attachments,
                            onToggleTakeover = { takeoverConfirm = !takeoverEnabled },
                            onPickPhoto = ::openPhotoPicker,
                            onPickFile = ::openFilePicker,
                            onOpenCamera = ::openCamera,
                            onRemoveAttachment = { remove ->
                                attachments = attachments.filterNot { it.id == remove.id }
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
                            title = state.session?.title ?: "Session",
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
                    controller = controller,
                    terminalController = remoteTerminal,
                    darkMode = darkMode,
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
            agentLabel = state.session?.runtimeLabel?.takeIf { it.isNotBlank() } ?: "agent",
            onDismiss = { if (!state.takeoverInFlight) takeoverConfirm = null },
            onConfirm = {
                takeoverConfirm = null
                applyTakeover(enabled)
            },
        )
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
        "Take over this session from your phone. Messages may not sync to $agentLabel desktop app/CLI right away. Sending while $agentLabel desktop app/CLI is still running may cause unexpected results."
    } else {
        "This session will become read-only. You won't be able to send messages."
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
                text = if (enabled) "Enable takeover?" else "Disable takeover?",
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
                    label = "Cancel",
                    background = secondaryButton,
                    content = colors.ink,
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                    onClick = onDismiss,
                )
                TakeoverDialogButton(
                    label = if (enabled) "Enable" else "Disable",
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
        title = { Text("Send anyway?") },
        text = { Text("This session is in an error state. Sending will try to start a new turn.") },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text("Send")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        },
    )
}

@Composable
private fun ApprovalDialog(
    approval: TimelineApproval,
    onDismiss: () -> Unit,
    onResolve: (String) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(approval.title) },
        text = {
            Text(
                approval.description
                    ?: "Allow this ${approval.kind.replace('_', ' ')} request?",
            )
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.End) {
                if ("reject" in approval.choices) {
                    TextButton(onClick = { onResolve("rejected") }) {
                        Text("Deny")
                    }
                }
                if ("approve_for_session" in approval.choices) {
                    TextButton(onClick = { onResolve("approved_for_session") }) {
                        Text("Always allow")
                    }
                }
                if ("approve" in approval.choices) {
                    TextButton(onClick = { onResolve("approved") }) {
                        Text("Allow")
                    }
                }
            }
        },
    )
}

private fun Context.pendingAttachment(uri: Uri): PendingAttachment? {
    val resolver = contentResolver
    var name = "attachment"
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
    } ?: throw IllegalStateException("Could not read ${attachment.name}.")
    if (bytes.isEmpty()) throw IllegalStateException("${attachment.name} is empty.")
    if (bytes.size > MAX_ATTACHMENT_BYTES) throw IllegalStateException("${attachment.name} exceeds 25 MB.")
    return UploadFilePart(
        name = attachment.name,
        mediaType = attachment.mediaType,
        bytes = bytes,
    )
}

private const val MAX_ATTACHMENT_FILES = 6
private const val MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
