package dev.agentsanywhere.v3.model

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.agentsanywhere.v3.bridge.RenderBridge
import dev.agentsanywhere.v3.core.bool
import dev.agentsanywhere.v3.core.cache.CachedConversation
import dev.agentsanywhere.v3.core.jsonOf
import dev.agentsanywhere.v3.core.long
import dev.agentsanywhere.v3.core.mesh.DeviceClient
import dev.agentsanywhere.v3.core.model.Control
import dev.agentsanywhere.v3.core.model.ConversationState
import dev.agentsanywhere.v3.core.model.SendAttachment
import dev.agentsanywhere.v3.core.model.Session
import dev.agentsanywhere.v3.core.model.WatchEvent
import dev.agentsanywhere.v3.core.str
import io.github.t4wefan.meshcall.MeshCallException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** An attachment picked in the composer: uploading, then saved on the device (`aa.v3.Device/save_attachment`). */
data class PendingAttachment(val key: String, val name: String, val mime: String, val size: Long, val path: String? = null, val error: String? = null) {
    val ready: Boolean get() = path != null
}

/**
 * One open conversation: `aa.v3.Sessions/watch` forwarded unchanged to the render bundle (`conversation.event`),
 * a native copy for the composer, approval dock and config pickers, the offline cache (`conversation.cached`), and
 * the page's requests (`load_older`, `answer`, `file.read`, links, copy, haptics).
 */
class ConversationController(
    private val context: Context,
    private val model: AppModel,
    private val bridge: RenderBridge,
    val deviceId: String,
    val sessionId: String,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val client: DeviceClient = model.graph.device(deviceId)
    private val state = ConversationState(sessionId)

    var session by mutableStateOf<Session?>(null); private set
    var control by mutableStateOf(Control()); private set
    /** "connecting" | "live" | "cached" | "error" */
    var phase by mutableStateOf("connecting"); private set
    var error by mutableStateOf<String?>(null); private set
    var toast by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false); private set
    val attachments = mutableStateListOf<PendingAttachment>()
    /** Set by the screen: open a device file the page asked for. */
    var onOpenFile: (String) -> Unit = {}

    private var watchJob: Job? = null
    private var saveJob: Job? = null
    private var hasLive = false

    val readonly: Boolean get() = model.device(deviceId)?.online != true

    fun start() {
        model.graph.cache.conversation(sessionId)?.let { cached ->
            state.restore(cached)
            publish()
            phase = "cached"
        }
        bridge.onReady = showInPageRef
        bridge.onMessage = pageRef
        showInPage()
        watch()
    }

    fun stop() {
        if (bridge.onReady === showInPageRef) bridge.onReady = {}
        if (bridge.onMessage === pageRef) bridge.onMessage = {}
        saveNow()
        scope.cancel()
    }

    private val showInPageRef: () -> Unit = { showInPage() }
    private val pageRef: (JsonObject) -> Unit = { onPageMessage(it) }

    /** The screen came back on top (a pushed screen took the WebView meanwhile): take the page over again. */
    fun resume() {
        bridge.onReady = showInPageRef
        bridge.onMessage = pageRef
        showInPage()
    }

    /** `view.conversation`, then what we have: the live state as a snapshot event, or the cache marked stale. */
    private fun showInPage() {
        val device = model.device(deviceId)
        bridge.send("view.conversation", "device_id" to deviceId, "session_id" to sessionId, "agent" to (session?.agent ?: ""),
            "readonly" to readonly, "encrypted" to (device?.encrypted == true || model.isPaired(deviceId)),
            "me" to model.user?.let { it.display_name.ifBlank { null } ?: it.email })
        val s = state.session ?: return
        if (hasLive) {
            bridge.send("conversation.event", "session_id" to sessionId, "event" to snapshotEvent(s))
        } else {
            bridge.send("conversation.cached", "session_id" to sessionId, "messages" to state.messages,
                "control" to jsonControl(), "stale" to true)
        }
    }

    private fun snapshotEvent(s: Session): JsonObject = jsonOf(
        "type" to "snapshot",
        "session" to dev.agentsanywhere.v3.core.AAJson.encodeToJsonElement(Session.serializer(), s),
        "messages" to JsonArray(state.messages),
        "has_more" to state.hasMore,
        "control" to jsonControl(),
    )

    private var lastControlRaw: JsonObject? = null
    private fun jsonControl(): JsonObject = lastControlRaw ?: dev.agentsanywhere.v3.core.AAJson.encodeToJsonElement(Control.serializer(), control) as JsonObject

    private fun watch() {
        watchJob?.cancel()
        watchJob = scope.launch {
            var attempt = 0
            while (true) {
                try {
                    client.watch(sessionId).collect { event -> attempt = 0; onEvent(event) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    Log.w(TAG, "watch $sessionId failed: $e")
                    error = e.userMessage()
                    phase = if (state.session != null) "cached" else "error"
                    if (e is MeshCallException && (e.code == "invalid_argument" || e.reason == "session_not_found" || e.code == "permission_denied")) return@launch
                }
                delay((1_000L shl attempt.coerceAtMost(4)).coerceAtMost(15_000))
                attempt++
            }
        }
    }

    private fun onEvent(event: WatchEvent) {
        state.apply(event)
        if (event.type == "snapshot" || event.type == "control") (event.raw["control"] as? JsonObject)?.let { lastControlRaw = it }
        if (event.type == "snapshot") { hasLive = true; phase = "live"; error = null }
        publish()
        bridge.send("conversation.event", "session_id" to sessionId, "event" to event.raw)
        scheduleSave()
    }

    private fun publish() {
        session = state.session
        control = state.control
    }

    private fun scheduleSave() {
        if (saveJob?.isActive == true) return
        saveJob = scope.launch { delay(2_000); saveNow() }
    }

    private fun saveNow() {
        val s = state.session ?: return
        if (!hasLive) return
        model.graph.cache.saveConversation(CachedConversation(deviceId, s, state.messages, state.control, System.currentTimeMillis()))
    }

    // Native controls

    fun send(text: String, delivery: String?) {
        val ready = attachments.filter { it.ready }
        if (text.isBlank() && ready.isEmpty()) return
        val files = ready.map { SendAttachment(it.path!!, it.name, it.mime, it.size) }
        attachments.removeAll(ready)
        scope.launch {
            busy = true
            try {
                val result = withContext(Dispatchers.IO) { client.send(sessionId, text.trim(), delivery, files) }
                when (result.delivered) {
                    "queued" -> toast = "已排队，当前回合结束后发送"
                    "steered" -> toast = "已插话"
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                toast = "发送失败：${e.userMessage()}"
            } finally {
                busy = false
            }
        }
    }

    fun stopTurn() = launchAction("停止失败") { client.stop(sessionId) }

    fun answer(requestId: String, optionId: String) = launchAction("回应失败") { client.answer(sessionId, requestId, optionId) }

    fun setConfig(configId: String, value: String) = launchAction("修改失败") {
        val s = client.setConfig(sessionId, configId, value)
        withContext(Dispatchers.Main) { session = s }
    }

    fun unqueue(clientMsgId: String) = launchAction("撤回失败") { client.unqueue(sessionId, clientMsgId) }

    fun steerQueued(clientMsgId: String) = launchAction("插话失败") { client.steerQueued(sessionId, clientMsgId) }

    private fun launchAction(failure: String, block: suspend () -> Unit) {
        scope.launch {
            try {
                withContext(Dispatchers.IO) { block() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                toast = "$failure：${e.userMessage()}"
            }
        }
    }

    /** Uploads a picked file to the device (≤ 8 MiB over the tunnel; larger files need the cloud drive, not yet here). */
    fun attach(uri: Uri) {
        val resolver = context.contentResolver
        var name = "file"
        var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                name = c.getString(0) ?: name
                size = if (c.isNull(1)) -1 else c.getLong(1)
            }
        }
        val mime = resolver.getType(uri) ?: "application/octet-stream"
        val key = uri.toString() + System.nanoTime()
        if (size > MAX_RPC_BYTES) {
            toast = "文件超过 8 MB，暂不支持经隧道发送"
            return
        }
        attachments += PendingAttachment(key, name, mime, size.coerceAtLeast(0))
        scope.launch {
            try {
                val saved = withContext(Dispatchers.IO) {
                    val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("无法读取文件")
                    if (bytes.size > MAX_RPC_BYTES) error("文件超过 8 MB")
                    client.saveAttachment(name, Base64.encodeToString(bytes, Base64.NO_WRAP), mime, sessionId)
                }
                replace(key) { it.copy(path = saved.path, size = saved.size, name = saved.name.ifEmpty { name }) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                replace(key) { it.copy(error = e.userMessage()) }
            }
        }
    }

    fun removeAttachment(key: String) { attachments.removeAll { it.key == key } }

    private fun replace(key: String, f: (PendingAttachment) -> PendingAttachment) {
        val i = attachments.indexOfFirst { it.key == key }
        if (i >= 0) attachments[i] = f(attachments[i])
    }

    // Page → native

    private fun onPageMessage(m: JsonObject) {
        when (m["type"].str) {
            "load_older" -> scope.launch {
                try {
                    val before = m["before_seq"].long ?: state.oldestSeq
                    val page = withContext(Dispatchers.IO) { client.listMessages(sessionId, before) }
                    state.prepend(page.messages, page.has_more)
                    bridge.send("conversation.older", "session_id" to sessionId, "messages" to page.messages, "has_more" to page.has_more)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    toast = "加载失败：${e.userMessage()}"
                }
            }
            "answer" -> {
                val req = m["request_id"].str; val opt = m["option_id"].str
                if (req != null && opt != null) answer(req, opt)
            }
            "open_link" -> m["url"].str?.let { url ->
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
            "open_file" -> m["path"].str?.let(onOpenFile)
            "file.read" -> readFileForPage(m)
            "copy" -> m["text"].str?.let { text ->
                context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("AA", text))
                toast = "已复制"
            }
            "haptic" -> haptic(m["kind"].str ?: "light")
        }
    }

    var haptic: (String) -> Unit = {}

    private fun readFileForPage(m: JsonObject) {
        val requestId = m["request_id"].str ?: return
        val path = m["path"].str ?: return
        val max = m["max_bytes"].long ?: MAX_RPC_BYTES.toLong()
        scope.launch {
            try {
                val r = withContext(Dispatchers.IO) { client.readFile(path, max) }
                val base64 = if (r.encoding == "base64") r.content else Base64.encodeToString(r.content.toByteArray(), Base64.NO_WRAP)
                bridge.send("file.data", "request_id" to requestId, "ok" to true, "base64" to base64, "mime" to guessMime(path))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                bridge.send("file.data", "request_id" to requestId, "ok" to false, "error" to e.userMessage())
            }
        }
    }

    companion object {
        const val TAG = "AAv3"
        const val MAX_RPC_BYTES = 8 * 1024 * 1024

        fun guessMime(path: String): String = android.webkit.MimeTypeMap.getSingleton()
            .getMimeTypeFromExtension(path.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
    }
}

@Suppress("unused")
private val JsonObject.isDone: Boolean get() = this["done"].bool ?: false
