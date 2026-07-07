package com.agentsanywhere.app.feature.terminal

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.termux.terminal.KeyHandler
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.Base64
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

class RemoteTerminalController(
    private val terminalController: TerminalController,
) : TerminalSessionClient {
    val state = MutableStateFlow(RemoteTerminalState())
    val modifierState = MutableStateFlow(TerminalModifierState())
    val redraws = MutableSharedFlow<Unit>(extraBufferCapacity = 64)
    var onRedraw: (() -> Unit)? = null
    val debugId: String = Integer.toHexString(System.identityHashCode(this))

    private val main = Handler(Looper.getMainLooper())
    private val outputBuffer = RemoteTerminalOutputBuffer()
    private var redrawScheduled = false

    val emulator = TerminalEmulator(
        object : TerminalOutput() {
            override fun write(data: ByteArray, offset: Int, count: Int) {
                inputDiag(
                    "terminalOutput.write bytes=$count status=${state.value.status} socket=${socket != null} " +
                        "pending=${pendingInputSize()} terminal=$terminalId",
                )
                sendBytes(data.copyOfRange(offset, offset + count))
            }

            override fun titleChanged(oldTitle: String?, newTitle: String?) = Unit
            override fun onCopyTextToClipboard(text: String?) = Unit
            override fun onPasteTextFromClipboard() = Unit
            override fun onBell() = Unit
            override fun onColorsChanged() = emitRedraw()
        },
        80,
        24,
        10,
        20,
        5000,
        this,
    )

    private val http = OkHttpClient()
    private val terminalScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sendMutex = Mutex()
    private val groupId = "mobile_${UUID.randomUUID()}"
    private var socket: WebSocket? = null
    private var connectorId: String? = null
    private var terminalId: String? = null
    private var streamUrl: String? = null
    private var reconnectScheduled = false
    private var reconnectAttempts = 0
    private var lastSeenSeq = 0L
    private var lastCols = 80
    private var lastRows = 24
    private var manuallyClosed = false
    private var remoteTerminalGone = false
    private var ctrlLatched = false
    private var altLatched = false
    private var pendingRemoteResizeCols: Int? = null
    private var pendingRemoteResizeRows: Int? = null
    private var remoteResizeGeneration = 0
    private var lastSentRemoteResizeCols: Int? = null
    private var lastSentRemoteResizeRows: Int? = null
    private val inputSeq = AtomicLong(0)
    private val frameSeq = AtomicLong(0)
    private val pendingInput = ArrayDeque<ByteArray>()
    private val pendingInputLock = Any()
    private val echoTraceLock = Any()
    private val pendingEchoTraces = ArrayDeque<InputEchoTrace>()

    val isCtrlLatched: Boolean get() = ctrlLatched
    val isAltLatched: Boolean get() = altLatched

    suspend fun ensureStarted(session: AgentSession) {
        diag(
            "ensure session request session=${session.id} connector=${session.connectorId} " +
                "state=${state.value.status} currentConnector=$connectorId terminal=$terminalId socket=${socket != null}",
        )
        if (terminalId != null && connectorId == session.connectorId) {
            diag("ensure session reuse existing terminal=$terminalId")
            reconnectExistingIfNeeded()
            return
        }
        if (terminalId != null) {
            detach()
            clearLocalScreen()
        } else {
            detach()
        }
        if (session.cwd.isNullOrBlank()) {
            state.value = RemoteTerminalState(status = RemoteTerminalStatus.Error, message = "This session has no workspace.")
            return
        }
        diag("ensure session open begin session=${session.id} connector=${session.connectorId} cols=$lastCols rows=$lastRows")
        state.value = RemoteTerminalState(status = RemoteTerminalStatus.Connecting)
        terminalController.openWorkspaceTerminal(
            session = session,
            cols = lastCols,
            rows = lastRows,
            ephemeralGroupId = groupId,
        )
            .onSuccess { connection ->
                connectorId = connection.connectorId
                terminalId = connection.terminal.terminalId
                streamUrl = connection.streamUrl
                lastSeenSeq = 0L
                reconnectAttempts = 0
                remoteTerminalGone = false
                diag("terminal opened connector=${connection.connectorId} terminal=${connection.terminal.terminalId}")
                connectSocket(connection.streamUrl)
            }
            .onFailure { error ->
                diag("open failed ${error::class.java.simpleName}: ${error.message}")
                state.value = RemoteTerminalState(
                    status = RemoteTerminalStatus.Error,
                    message = error.message ?: "Could not open terminal.",
                )
            }
    }

    suspend fun ensureStarted(device: AgentDevice) {
        diag(
            "ensure device request device=${device.id} online=${device.online} " +
                "state=${state.value.status} currentConnector=$connectorId terminal=$terminalId socket=${socket != null}",
        )
        if (terminalId != null && connectorId == device.id) {
            diag("ensure device reuse existing terminal=$terminalId device=${device.id}")
            reconnectExistingIfNeeded()
            return
        }
        if (terminalId != null) {
            detach()
            clearLocalScreen()
        } else {
            detach()
        }
        if (!device.online) {
            state.value = RemoteTerminalState(status = RemoteTerminalStatus.Error, message = "This device is offline.")
            return
        }
        diag("ensure device open begin device=${device.id} cols=$lastCols rows=$lastRows")
        state.value = RemoteTerminalState(status = RemoteTerminalStatus.Connecting)
        terminalController.openDeviceTerminal(
            connectorId = device.id,
            cols = lastCols,
            rows = lastRows,
            ephemeralGroupId = groupId,
        )
            .onSuccess { connection ->
                connectorId = connection.connectorId
                terminalId = connection.terminal.terminalId
                streamUrl = connection.streamUrl
                lastSeenSeq = 0L
                reconnectAttempts = 0
                remoteTerminalGone = false
                diag("terminal opened connector=${connection.connectorId} terminal=${connection.terminal.terminalId}")
                connectSocket(connection.streamUrl)
            }
            .onFailure { error ->
                diag("open failed ${error::class.java.simpleName}: ${error.message}")
                state.value = RemoteTerminalState(
                    status = RemoteTerminalStatus.Error,
                    message = error.message ?: "Could not open terminal.",
                )
            }
    }

    suspend fun reconnect(session: AgentSession) {
        if (terminalId != null && connectorId == session.connectorId && state.value.status != RemoteTerminalStatus.Exited) {
            reconnectExistingIfNeeded(force = true)
        } else if (terminalId != null && connectorId == session.connectorId) {
            restart(session)
        } else {
            ensureStarted(session)
        }
    }

    suspend fun reconnect(device: AgentDevice) {
        if (terminalId != null && connectorId == device.id && state.value.status != RemoteTerminalStatus.Exited) {
            reconnectExistingIfNeeded(force = true)
        } else if (terminalId != null && connectorId == device.id) {
            restart(device)
        } else {
            ensureStarted(device)
        }
    }

    fun resize(cols: Int, rows: Int, cellWidth: Int, cellHeight: Int) {
        if (cols <= 0 || rows <= 0) return
        if (cols == lastCols && rows == lastRows) return
        lastCols = cols
        lastRows = rows
        main.post {
            emulator.resize(cols, rows, cellWidth, cellHeight)
            emitRedraw()
        }
        scheduleRemoteResize(cols, rows)
    }

    fun updateSize(cols: Int, rows: Int, cellWidth: Int, cellHeight: Int) {
        resize(cols, rows, cellWidth, cellHeight)
    }

    fun write(text: String?) {
        sendRawText(text.orEmpty())
    }

    fun writeCodePoint(prependEscape: Boolean, codePoint: Int) {
        sendCodePoint(codePoint, controlDown = false, altDown = prependEscape)
    }

    fun sendText(text: String) {
        if (text.isEmpty()) return
        val data = when {
            ctrlLatched -> text.firstOrNull()?.let { codePointString(controlCodePoint(it.code)) } ?: text
            altLatched -> "\u001b$text"
            else -> text
        }
        setLatched(ctrl = false, alt = false)
        sendBytes(data.toByteArray(Charsets.UTF_8))
    }

    fun sendRawText(text: String) {
        if (text.isEmpty()) return
        setLatched(ctrl = false, alt = false)
        sendBytes(text.toByteArray(Charsets.UTF_8))
    }

    fun sendCodePoint(codePoint: Int, controlDown: Boolean, altDown: Boolean) {
        if (codePoint < 0 || codePoint > 0x10FFFF || codePoint in 0xD800..0xDFFF) return
        val control = controlDown || ctrlLatched
        val alt = altDown || altLatched
        val mappedCodePoint = if (control) controlCodePoint(codePoint) else codePoint
        setLatched(ctrl = false, alt = false)
        val text = codePointString(mappedCodePoint)
        sendBytes((if (alt) "\u001b$text" else text).toByteArray(Charsets.UTF_8))
    }

    fun sendShortcut(shortcut: TerminalShortcut) {
        when (shortcut) {
            TerminalShortcut.Ctrl -> setLatched(ctrl = !ctrlLatched)
            TerminalShortcut.Alt -> setLatched(alt = !altLatched)
            TerminalShortcut.Slash -> sendCodePoint('/'.code, controlDown = false, altDown = false)
            TerminalShortcut.Dash -> sendCodePoint('-'.code, controlDown = false, altDown = false)
            TerminalShortcut.Tab -> sendRawText("\t")
            TerminalShortcut.Esc -> sendRawText("\u001b")
            else -> sendKeyShortcut(shortcut)
        }
    }

    suspend fun restart(session: AgentSession) {
        close()
        ensureStarted(session)
    }

    suspend fun restart(device: AgentDevice) {
        close()
        ensureStarted(device)
    }

    suspend fun close() {
        val target = detachTerminalForClose()
        clearLocalScreen()
        if (target != null) {
            withContext(Dispatchers.IO) {
                terminalController.closeTerminal(target.connectorId, target.terminalId)
            }
        }
    }

    fun detach() {
        diag("detach requested terminal=$terminalId")
        manuallyClosed = true
        socket?.close(1000, "detached")
        socket = null
        reconnectScheduled = false
        reconnectAttempts = 0
        remoteTerminalGone = false
        cancelPendingRemoteResize()
        setLatched(ctrl = false, alt = false)
        synchronized(pendingInputLock) {
            pendingInput.clear()
        }
        clearEchoTraces()
        if (terminalId != null && state.value.status != RemoteTerminalStatus.Exited) {
            state.value = RemoteTerminalState(status = RemoteTerminalStatus.Closed)
        }
    }

    fun disposeLocal() {
        detach()
        terminalScope.cancel()
    }

    private fun detachTerminalForClose(): TerminalCloseTarget? {
        diag("close requested terminal=$terminalId")
        manuallyClosed = true
        socket?.close(1000, "closed")
        socket = null
        val currentConnectorId = connectorId
        val currentTerminalId = terminalId
        connectorId = null
        terminalId = null
        streamUrl = null
        reconnectScheduled = false
        reconnectAttempts = 0
        remoteTerminalGone = false
        cancelPendingRemoteResize()
        setLatched(ctrl = false, alt = false)
        synchronized(pendingInputLock) {
            pendingInput.clear()
        }
        clearEchoTraces()
        state.value = RemoteTerminalState()
        return if (currentConnectorId != null && currentTerminalId != null) {
            TerminalCloseTarget(currentConnectorId, currentTerminalId)
        } else {
            null
        }
    }

    private fun connectSocket(url: String) {
        manuallyClosed = false
        diag("ws connecting terminal=$terminalId fromSeq=${url.substringAfter("fromSeq=", "0").substringBefore("&")}")
        socket = http.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (socket !== webSocket || manuallyClosed) {
                        webSocket.close(1000, "stale")
                        return
                    }
                    diag("ws open terminal=$terminalId")
                    inputDiag("ws open status=${state.value.status} pending=${pendingInputSize()} terminal=$terminalId")
                    sendRemoteResizeNow(lastCols, lastRows, force = true, reason = "ws-open")
                    flushPendingInput()
                    confirmOpenIfNoStreamFrame(webSocket)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (socket !== webSocket || manuallyClosed) return
                    handleFrame(text)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    diag("ws closed code=$code reason=$reason manual=$manuallyClosed terminal=$terminalId")
                    if (socket !== webSocket) return
                    socket = null
                    if (!manuallyClosed) {
                        scheduleReconnect()
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    diag("ws failure ${t::class.java.simpleName}: ${t.message} manual=$manuallyClosed terminal=$terminalId")
                    if (socket !== webSocket) return
                    socket = null
                    if (!manuallyClosed) {
                        scheduleReconnect()
                    }
                }
            },
        )
    }

    private fun reconnectExistingIfNeeded(force: Boolean = false) {
        val url = streamUrl ?: return
        if (!force && (socket != null || state.value.status == RemoteTerminalStatus.Connecting)) return
        socket?.close(1000, "reconnect")
        socket = null
        manuallyClosed = false
        reconnectScheduled = false
        reconnectAttempts = 0
        remoteTerminalGone = false
        state.value = RemoteTerminalState(status = RemoteTerminalStatus.Connecting)
        connectSocket(url.withFromSeq(lastSeenSeq))
    }

    private fun handleFrame(text: String) {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (json.optString("type")) {
            "replay" -> {
                val seq = if (json.has("seq")) json.optLong("seq", -1L) else -1L
                if (seq > 0 && seq <= lastSeenSeq) return
                if (seq > 0) lastSeenSeq = seq
                val data = runCatching { Base64.getDecoder().decode(json.optString("data")) }.getOrNull() ?: return
                diag("rx replay seq=$seq bytes=${data.size} lastSeen=$lastSeenSeq terminal=$terminalId")
                inputDiag("rx replay seq=$seq bytes=${data.size} status=${state.value.status} pending=${pendingInputSize()} terminal=$terminalId")
                reconnectAttempts = 0
                remoteTerminalGone = false
                state.value = RemoteTerminalState(status = RemoteTerminalStatus.Open)
                enqueueTerminalOutput(data, resetBeforeAppend = true)
            }
            "output" -> {
                val seq = if (json.has("seq")) json.optLong("seq", -1L) else -1L
                if (seq > 0 && seq <= lastSeenSeq) return
                if (seq > 0) lastSeenSeq = seq
                val data = runCatching { Base64.getDecoder().decode(json.optString("data")) }.getOrNull() ?: return
                diag("rx output seq=$seq bytes=${data.size} lastSeen=$lastSeenSeq terminal=$terminalId")
                inputDiag("rx output seq=$seq bytes=${data.size} status=${state.value.status} pending=${pendingInputSize()} terminal=$terminalId")
                traceOutputEcho(seq, data.size)
                reconnectAttempts = 0
                remoteTerminalGone = false
                state.value = RemoteTerminalState(status = RemoteTerminalStatus.Open)
                enqueueTerminalOutput(data)
            }
            "exit" -> {
                diag("rx exit code=${json.opt("exitCode")} reason=${json.optString("reason")} terminal=$terminalId")
                manuallyClosed = true
                socket?.close(1000, "terminal exited")
                socket = null
                state.value = RemoteTerminalState(status = RemoteTerminalStatus.Exited)
            }
            "error" -> {
                diag("rx error ${json.optString("message")} terminal=$terminalId")
                val message = json.optString("message").takeIf { it.isNotBlank() }
                if (message?.contains("terminal not found", ignoreCase = true) == true) {
                    remoteTerminalGone = true
                }
                state.value = RemoteTerminalState(status = RemoteTerminalStatus.Closed)
            }
        }
    }

    private fun confirmOpenIfNoStreamFrame(openSocket: WebSocket) {
        main.postDelayed({
            if (
                socket === openSocket &&
                !manuallyClosed &&
                state.value.status == RemoteTerminalStatus.Connecting &&
                !remoteTerminalGone
            ) {
                inputDiag("confirm open grace elapsed status=${state.value.status} pending=${pendingInputSize()} terminal=$terminalId")
                reconnectAttempts = 0
                state.value = RemoteTerminalState(status = RemoteTerminalStatus.Open)
            }
        }, STREAM_OPEN_GRACE_MS)
    }

    private fun sendBytes(bytes: ByteArray) {
        val localInputSeq = inputSeq.incrementAndGet()
        inputDiag(
            "input#$localInputSeq begin bytes=${bytes.size} status=${state.value.status} socket=${socket != null} " +
                "manual=$manuallyClosed pending=${pendingInputSize()} terminal=$terminalId",
        )
        if (state.value.status != RemoteTerminalStatus.Open) {
            if (terminalId != null && streamUrl != null && !manuallyClosed) {
                synchronized(pendingInputLock) {
                    pendingInput.addLast(bytes)
                }
                diag("input#$localInputSeq queued bytes=${bytes.size} status=${state.value.status} terminal=$terminalId")
                inputDiag(
                    "input#$localInputSeq queued bytes=${bytes.size} status=${state.value.status} socket=${socket != null} " +
                        "pending=${pendingInputSize()} terminal=$terminalId",
                )
                scheduleReconnect()
            } else {
                diag("input#$localInputSeq dropped bytes=${bytes.size} status=${state.value.status} terminal=$terminalId manual=$manuallyClosed")
                inputDiag("input#$localInputSeq dropped bytes=${bytes.size} status=${state.value.status} terminal=$terminalId manual=$manuallyClosed")
            }
            return
        }
        val encoded = Base64.getEncoder().encodeToString(bytes)
        diag("input#$localInputSeq send bytes=${bytes.size} terminal=$terminalId")
        inputDiag("input#$localInputSeq send bytes=${bytes.size} encodedChars=${encoded.length} terminal=$terminalId")
        traceInputAwaitingEcho(localInputSeq, bytes.size)
        sendFrame("input", JSONObject().put("type", "input").put("data", encoded).toString())
    }

    private fun sendFrame(kind: String, frame: String) {
        val targetSocket = socket
        if (targetSocket == null) {
            diag("frame $kind skipped no-socket terminal=$terminalId")
            inputDiag("frame $kind skipped no-socket status=${state.value.status} pending=${pendingInputSize()} terminal=$terminalId")
            return
        }
        val localFrameSeq = frameSeq.incrementAndGet()
        val startedAt = SystemClock.uptimeMillis()
        inputDiag("frame#$localFrameSeq enqueue kind=$kind chars=${frame.length} status=${state.value.status} terminal=$terminalId")
        terminalScope.launch {
            val accepted = sendMutex.withLock {
                if (socket !== targetSocket || manuallyClosed) null else targetSocket.send(frame)
            }
            diag("frame#$localFrameSeq $kind accepted=$accepted terminal=$terminalId")
            inputDiag(
                "frame#$localFrameSeq done kind=$kind accepted=$accepted dt=${SystemClock.uptimeMillis() - startedAt}ms " +
                    "socketSame=${socket === targetSocket} status=${state.value.status} terminal=$terminalId",
            )
            if (accepted == false && !manuallyClosed) {
                main.post {
                    state.value = RemoteTerminalState(status = RemoteTerminalStatus.Closed)
                }
            }
        }
    }

    private fun scheduleReconnect() {
        val originalUrl = streamUrl ?: return
        if (manuallyClosed || terminalId == null) return
        if (reconnectScheduled) return
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            diag("reconnect exhausted terminal=$terminalId lastSeen=$lastSeenSeq")
            if (remoteTerminalGone) {
                forgetRemoteTerminal()
            }
            state.value = RemoteTerminalState(status = RemoteTerminalStatus.Closed)
            return
        }
        reconnectAttempts += 1
        reconnectScheduled = true
        diag("reconnect scheduled attempt=$reconnectAttempts terminal=$terminalId lastSeen=$lastSeenSeq")
        state.value = RemoteTerminalState(status = RemoteTerminalStatus.Closed)
        main.postDelayed({
            reconnectScheduled = false
            if (manuallyClosed || socket != null || terminalId == null || streamUrl != originalUrl) return@postDelayed
            connectSocket(originalUrl.withFromSeq(lastSeenSeq))
        }, RECONNECT_DELAY_MS)
    }

    private fun forgetRemoteTerminal() {
        socket?.close(1000, "forgotten")
        socket = null
        connectorId = null
        terminalId = null
        streamUrl = null
        reconnectScheduled = false
        remoteTerminalGone = false
        cancelPendingRemoteResize()
        outputBuffer.clear()
        synchronized(pendingInputLock) {
            pendingInput.clear()
        }
        clearEchoTraces()
    }

    private fun traceInputAwaitingEcho(inputId: Long, byteCount: Int) {
        val sentAt = SystemClock.uptimeMillis()
        synchronized(echoTraceLock) {
            pendingEchoTraces.addLast(
                InputEchoTrace(
                    inputId = inputId,
                    byteCount = byteCount,
                    sentAt = sentAt,
                    terminalId = terminalId,
                ),
            )
            while (pendingEchoTraces.size > MAX_ECHO_TRACE_INPUTS) {
                pendingEchoTraces.removeFirst()
            }
        }
        inputDiag("echo input#$inputId await-output bytes=$byteCount pendingEcho=${pendingEchoTraceCount()} terminal=$terminalId")
        scheduleEchoWaitLog(inputId, sentAt, ECHO_WAIT_WARN_MS)
        scheduleEchoWaitLog(inputId, sentAt, ECHO_WAIT_SLOW_MS)
    }

    private fun scheduleEchoWaitLog(inputId: Long, sentAt: Long, delayMs: Long) {
        main.postDelayed({
            val trace = synchronized(echoTraceLock) {
                pendingEchoTraces.firstOrNull { it.inputId == inputId && it.sentAt == sentAt }
            } ?: return@postDelayed
            inputDiag(
                "echo input#${trace.inputId} still-waiting dt=${SystemClock.uptimeMillis() - trace.sentAt}ms " +
                    "bytes=${trace.byteCount} pendingEcho=${pendingEchoTraceCount()} terminal=${trace.terminalId}",
            )
        }, delayMs)
    }

    private fun traceOutputEcho(outputSeq: Long, byteCount: Int) {
        val now = SystemClock.uptimeMillis()
        val trace = synchronized(echoTraceLock) {
            if (pendingEchoTraces.isEmpty()) null else pendingEchoTraces.removeFirst()
        }
        if (trace == null) return
        inputDiag(
            "echo input#${trace.inputId} first-output seq=$outputSeq dt=${now - trace.sentAt}ms " +
                "inputBytes=${trace.byteCount} outputBytes=$byteCount pendingEcho=${pendingEchoTraceCount()} terminal=${trace.terminalId}",
        )
    }

    private fun clearEchoTraces() {
        synchronized(echoTraceLock) {
            pendingEchoTraces.clear()
        }
    }

    private fun scheduleRemoteResize(cols: Int, rows: Int) {
        pendingRemoteResizeCols = cols
        pendingRemoteResizeRows = rows
        val generation = ++remoteResizeGeneration
        inputDiag("resize schedule cols=$cols rows=$rows gen=$generation terminal=$terminalId")
        main.postDelayed({
            if (generation != remoteResizeGeneration || manuallyClosed) return@postDelayed
            val pendingCols = pendingRemoteResizeCols ?: return@postDelayed
            val pendingRows = pendingRemoteResizeRows ?: return@postDelayed
            pendingRemoteResizeCols = null
            pendingRemoteResizeRows = null
            sendRemoteResizeNow(pendingCols, pendingRows, force = false, reason = "settled")
        }, REMOTE_RESIZE_DEBOUNCE_MS)
    }

    private fun cancelPendingRemoteResize() {
        remoteResizeGeneration += 1
        pendingRemoteResizeCols = null
        pendingRemoteResizeRows = null
    }

    private fun sendRemoteResizeNow(cols: Int, rows: Int, force: Boolean, reason: String) {
        if (cols <= 0 || rows <= 0) return
        if (socket == null) {
            inputDiag("resize skip no-socket reason=$reason cols=$cols rows=$rows terminal=$terminalId")
            return
        }
        if (!force && cols == lastSentRemoteResizeCols && rows == lastSentRemoteResizeRows) {
            inputDiag("resize skip duplicate reason=$reason cols=$cols rows=$rows terminal=$terminalId")
            return
        }
        lastSentRemoteResizeCols = cols
        lastSentRemoteResizeRows = rows
        inputDiag("resize send reason=$reason cols=$cols rows=$rows force=$force terminal=$terminalId")
        sendFrame("resize", JSONObject().put("type", "resize").put("cols", cols).put("rows", rows).toString())
    }

    private fun flushPendingInput() {
        val queued = synchronized(pendingInputLock) {
            if (pendingInput.isEmpty()) {
                emptyList()
            } else {
                buildList {
                    while (pendingInput.isNotEmpty()) add(pendingInput.removeFirst())
                }
            }
        }
        if (queued.isEmpty()) return
        diag("flush queued inputs count=${queued.size} terminal=$terminalId")
        inputDiag("flush queued inputs count=${queued.size} status=${state.value.status} terminal=$terminalId")
        for (bytes in queued) {
            val encoded = Base64.getEncoder().encodeToString(bytes)
            inputDiag("flush input bytes=${bytes.size} encodedChars=${encoded.length} terminal=$terminalId")
            traceInputAwaitingEcho(inputSeq.incrementAndGet(), bytes.size)
            sendFrame("input", JSONObject().put("type", "input").put("data", encoded).toString())
        }
    }

    private fun String.withFromSeq(seq: Long): String {
        return if (contains("fromSeq=")) {
            replace(Regex("fromSeq=\\d+"), "fromSeq=$seq")
        } else {
            this + (if (contains("?")) "&" else "?") + "fromSeq=$seq"
        }
    }

    fun dispose() {
        terminalScope.cancel()
    }

    private fun sendKeyShortcut(shortcut: TerminalShortcut) {
        val keyCode = when (shortcut) {
            TerminalShortcut.Home -> KeyEvent.KEYCODE_MOVE_HOME
            TerminalShortcut.Up -> KeyEvent.KEYCODE_DPAD_UP
            TerminalShortcut.End -> KeyEvent.KEYCODE_MOVE_END
            TerminalShortcut.PageUp -> KeyEvent.KEYCODE_PAGE_UP
            TerminalShortcut.Left -> KeyEvent.KEYCODE_DPAD_LEFT
            TerminalShortcut.Down -> KeyEvent.KEYCODE_DPAD_DOWN
            TerminalShortcut.Right -> KeyEvent.KEYCODE_DPAD_RIGHT
            TerminalShortcut.PageDown -> KeyEvent.KEYCODE_PAGE_DOWN
            else -> return
        }
        var keyMod = 0
        if (ctrlLatched) keyMod = keyMod or KeyHandler.KEYMOD_CTRL
        if (altLatched) keyMod = keyMod or KeyHandler.KEYMOD_ALT
        setLatched(ctrl = false, alt = false)
        KeyHandler.getCode(
            keyCode,
            keyMod,
            emulator.isCursorKeysApplicationMode,
            emulator.isKeypadApplicationMode,
        )?.let {
            sendBytes(it.toByteArray(Charsets.UTF_8))
        }
    }

    private fun controlCodePoint(codePoint: Int): Int {
        return when (codePoint) {
            in 'a'.code..'z'.code -> codePoint - 'a'.code + 1
            in 'A'.code..'Z'.code -> codePoint - 'A'.code + 1
            ' '.code, '2'.code -> 0
            '['.code, '3'.code -> 27
            '\\'.code, '4'.code -> 28
            ']'.code, '5'.code -> 29
            '^'.code, '6'.code -> 30
            '_'.code, '7'.code, '/'.code -> 31
            else -> codePoint
        }
    }

    private fun codePointString(codePoint: Int): String = String(Character.toChars(codePoint))

    private fun clearLocalScreen() {
        val generation = outputBuffer.clear()
        val data = "\u001b[H\u001b[2J\u001b[3J".toByteArray(Charsets.UTF_8)
        main.post {
            if (!outputBuffer.isCurrentGeneration(generation)) return@post
            emulator.append(data, data.size)
            emitRedraw()
        }
    }

    private fun enqueueTerminalOutput(data: ByteArray, resetBeforeAppend: Boolean = false) {
        val decision = outputBuffer.enqueue(data, resetBeforeAppend = resetBeforeAppend)
        if (decision.shouldSchedule) {
            scheduleOutputDrain(decision.generation)
        }
    }

    private fun scheduleOutputDrain(generation: Long) {
        main.postDelayed({
            drainTerminalOutput(generation)
        }, OUTPUT_DRAIN_DELAY_MS)
    }

    private fun drainTerminalOutput(generation: Long) {
        val batch = outputBuffer.drain(generation)
        if (batch == null) {
            outputBuffer.finishDrain(generation)
            return
        }

        if (batch.resetBeforeAppend) {
            emulator.reset()
        }
        if (batch.hasData) {
            emulator.append(batch.data, batch.data.size)
        }
        if (batch.resetBeforeAppend || batch.hasData) {
            emitRedraw()
        }

        val next = outputBuffer.finishDrain(generation)
        if (next.shouldSchedule) {
            scheduleOutputDrain(next.generation)
        }
    }

    private fun setLatched(ctrl: Boolean = ctrlLatched, alt: Boolean = altLatched) {
        ctrlLatched = ctrl
        altLatched = alt
        modifierState.value = TerminalModifierState(ctrl = ctrl, alt = alt)
    }

    private fun emitRedraw() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { emitRedraw() }
            return
        }
        if (redrawScheduled) return
        redrawScheduled = true
        redraws.tryEmit(Unit)
        onRedraw?.invoke()
        main.post {
            redrawScheduled = false
        }
    }

    private fun pendingInputSize(): Int {
        return synchronized(pendingInputLock) {
            pendingInput.size
        }
    }

    private fun pendingEchoTraceCount(): Int {
        return synchronized(echoTraceLock) {
            pendingEchoTraces.size
        }
    }

    override fun onTextChanged(changedSession: TerminalSession?) = emitRedraw()
    override fun onTitleChanged(changedSession: TerminalSession?) = Unit
    override fun onSessionFinished(finishedSession: TerminalSession?) = Unit
    override fun onCopyTextToClipboard(session: TerminalSession?, text: String?) = Unit
    override fun onPasteTextFromClipboard(session: TerminalSession?) = Unit
    override fun onBell(session: TerminalSession?) = Unit
    override fun onColorsChanged(session: TerminalSession?) = emitRedraw()
    override fun onTerminalCursorStateChange(state: Boolean) = emitRedraw()
    override fun getTerminalCursorStyle(): Int = TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK
    override fun logError(tag: String?, message: String?) = Unit
    override fun logWarn(tag: String?, message: String?) = Unit
    override fun logInfo(tag: String?, message: String?) = Unit
    override fun logDebug(tag: String?, message: String?) = Unit
    override fun logVerbose(tag: String?, message: String?) = Unit
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) = Unit
    override fun logStackTrace(tag: String?, e: Exception?) = Unit

    private fun diag(message: String) {
        Log.d(DIAG_TAG, "ctrl=$debugId $message")
    }

    private fun inputDiag(message: String) {
        if (INPUT_DIAG_ENABLED) {
            Log.d(INPUT_DIAG_TAG, "t=${SystemClock.uptimeMillis()} ctrl=$debugId $message")
        }
    }

    private data class TerminalCloseTarget(
        val connectorId: String,
        val terminalId: String,
    )

    private data class InputEchoTrace(
        val inputId: Long,
        val byteCount: Int,
        val sentAt: Long,
        val terminalId: String?,
    )

    private companion object {
        private const val DIAG_TAG = "AATerminal"
        private const val INPUT_DIAG_TAG = "AATerminalInput"
        private const val INPUT_DIAG_ENABLED = true
        private const val RECONNECT_DELAY_MS = 800L
        private const val STREAM_OPEN_GRACE_MS = 1_200L
        private const val MAX_RECONNECT_ATTEMPTS = 3
        private const val REMOTE_RESIZE_DEBOUNCE_MS = 160L
        private const val OUTPUT_DRAIN_DELAY_MS = 16L
        private const val MAX_ECHO_TRACE_INPUTS = 128
        private const val ECHO_WAIT_WARN_MS = 300L
        private const val ECHO_WAIT_SLOW_MS = 1_000L
    }
}

data class RemoteTerminalState(
    val status: RemoteTerminalStatus = RemoteTerminalStatus.Idle,
    val message: String? = null,
)

data class TerminalModifierState(
    val ctrl: Boolean = false,
    val alt: Boolean = false,
)

enum class RemoteTerminalStatus {
    Idle,
    Connecting,
    Open,
    Closed,
    Exited,
    Error,
}

enum class TerminalShortcut(val label: String, val sequence: String) {
    Esc("ESC", "\u001b"),
    Slash("/", "/"),
    Dash("-", "-"),
    Home("HOME", "\u001b[H"),
    Up("↑", "\u001b[A"),
    End("END", "\u001b[F"),
    PageUp("PGUP", "\u001b[5~"),
    Tab("TAB", "\t"),
    Ctrl("CTRL", ""),
    Alt("ALT", ""),
    Left("←", "\u001b[D"),
    Down("↓", "\u001b[B"),
    Right("→", "\u001b[C"),
    PageDown("PGDN", "\u001b[6~"),
}
