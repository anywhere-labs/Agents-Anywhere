package dev.agentsanywhere.v3poc.model

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.agentsanywhere.v3poc.DebugLaunch
import dev.agentsanywhere.v3poc.LaunchClock
import dev.agentsanywhere.v3poc.bridge.RendererBridge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.util.UUID

/**
 * Owns what the phone shows: the selected session, its cache entry and the renderer. Talks to the computer only through
 * `SessionsClient`; to the renderer only through `RendererBridge`. Main thread only.
 */
class SessionController(
    private val context: Context,
    val account: Workspace.Account,
    val devices: List<Workspace.Device>,
    val projects: List<Workspace.Project>,
    sessions: List<Workspace.Session>,
    private val client: SessionsClient,
    val bridge: RendererBridge,
) {
    data class OpenRequest(val title: String, val detail: String)

    val sessions = mutableStateListOf<Workspace.Session>().apply { addAll(sessions) }
    var selectedId by mutableStateOf<String?>(null); private set
    /** The latest Session / Control of the selected session. Items are not observed here: they go to the renderer. */
    var session by mutableStateOf<JsonObject?>(null); private set
    var control by mutableStateOf<JsonObject?>(null); private set
    /** Live states for the sidebar (cache entries of sessions watched in this run). */
    val activities = mutableStateMapOf<String, SessionActivity>()
    var toast by mutableStateOf<String?>(null); private set
    var toastId by mutableStateOf(0); private set
    var openRequest by mutableStateOf<OpenRequest?>(null)
    /** Haptic requests from the renderer, consumed by the UI (it owns the View for performHapticFeedback). */
    var haptic: (String) -> Unit = {}

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val cache = SessionCache(DebugLaunch.cacheItems ?: 300)
    private var watchJob: Job? = null
    private var toastJob: Job? = null
    private val autoApproved = HashSet<String>()

    init {
        bridge.currentSnapshot = { selectedId?.let { cache.state(it)?.snapshot } }
        bridge.onMessage = ::handleRenderer
    }

    val selectedSummary: Workspace.Session? get() = sessions.firstOrNull { it.id == selectedId }

    fun select(id: String) {
        if (id == selectedId) return
        selectedId = id
        val index = sessions.indexOfFirst { it.id == id }
        if (index >= 0 && sessions[index].unread) sessions[index] = sessions[index].copy(unread = false)
        // Instant from the cache; the watch snapshot replaces it a moment later (and is skipped by the bridge if equal).
        val cached = cache.state(id)
        if (cached != null) {
            publish(cached)
            bridge.show(cached.snapshot)
        } else {
            session = null
            control = null
        }
        watch(id)
    }

    private fun watch(id: String) {
        watchJob?.cancel()
        watchJob = scope.launch {
            while (isActive) {
                client.watch(id).collect { receive(it, id) }
                // The stream dropped: watch again (a real connection would back off).
                delay(1000)
            }
        }
    }

    private fun receive(event: JsonObject, id: String) {
        val state = cache.apply(event, id) ?: return
        activities[id] = state.activity
        if (id != selectedId) return
        when (event["type"].str) {
            // The cache's (bounded) state, not the raw event: the renderer gets at most `maxItems` items; older ones
            // come back through `loadOlder`.
            "snapshot" -> { publish(state); bridge.show(state.snapshot) }
            "session" -> { session = state.session; bridge.enqueue(event) }
            "control" -> { control = state.control; bridge.enqueue(event); scheduleAutoApprove() }
            else -> bridge.enqueue(event)
        }
    }

    // Memory

    private val warnings = ArrayDeque<Long>()

    /**
     * The system is short of memory (`onTrimMemory`). A second warning within 30 s is escalated to `critical` (the
     * first one did not free enough), as on iOS. The renderer drops off-screen DOM and older items; the cache keeps
     * only the session on screen.
     */
    fun memoryPressure(reported: String) {
        val now = android.os.SystemClock.uptimeMillis()
        while (warnings.isNotEmpty() && now - warnings.first() > 30_000) warnings.removeFirst()
        warnings.addLast(now)
        val level = if (reported == "critical" || warnings.size >= 2) "critical" else "warning"
        LaunchClock.log("memory pressure $reported (#${warnings.size} in 30 s) → $level")
        bridge.memoryPressure(level)
        cache.trim(level, selectedId)
        dev.agentsanywhere.v3poc.bridge.StressMetrics.event("cacheTrimmed", mapOf("sessions" to cache.sessionCount, "items" to cache.itemCount))
    }

    private fun publish(state: SessionState) {
        session = state.session
        control = state.control
        state.session["id"].str?.let { activities[it] = state.activity }
        scheduleAutoApprove()
    }

    // What the chrome reads

    val activity: SessionActivity get() = SessionActivity.control(control)
    val isRunning: Boolean get() = control["state"].str == "running"
    val pending: PendingRequest? get() = PendingRequest.from(control["pending"][0])
    val pendingCount: Int get() = control["pending"].arr?.size ?: 0
    val config: List<ConfigOption> get() = session["config"].arr.orEmpty().mapNotNull(ConfigOption::from)
    val usage: Pair<Double, Double>? get() {
        val used = control["usage"]["used"].double ?: return null
        val size = control["usage"]["size"].double ?: return null
        return if (size > 0) used to size else null
    }
    val errorMessage: String? get() = if (control["state"].str == "error") control["error"].str ?: "出错了" else null

    fun activityOf(id: String): SessionActivity =
        activities[id] ?: sessions.firstOrNull { it.id == id }?.let { SessionActivity.summary(it.state) } ?: SessionActivity.Idle

    fun togglePinned(id: String) {
        val i = sessions.indexOfFirst { it.id == id }
        if (i >= 0) sessions[i] = sessions[i].copy(pinned = !sessions[i].pinned)
    }

    // Actions

    fun send(text: String) {
        val id = selectedId ?: return
        val content = text.trim()
        if (content.isEmpty()) return
        bridge.scrollToEnd()
        perform { client.send(id, "c-" + UUID.randomUUID().toString().take(8), content) }
    }

    fun stop() {
        val id = selectedId ?: return
        perform { client.stop(id) }
    }

    fun answer(requestId: String, option: String, withHaptic: Boolean = true) {
        val id = selectedId ?: return
        if (withHaptic) haptic("medium")
        perform { client.answer(id, requestId, option) }
    }

    fun setConfig(configId: String, value: String) {
        val id = selectedId ?: return
        perform { client.setConfig(id, configId, value) }
    }

    fun showToast(text: String) {
        toast = text
        toastId++
        toastJob?.cancel()
        toastJob = scope.launch { delay(2000); toast = null }
    }

    fun dismissToast() { toastJob?.cancel(); toast = null }

    fun copy(text: String) {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("Agents Anywhere", text))
    }

    private fun perform(operation: suspend () -> Unit) {
        scope.launch {
            try { operation() } catch (e: Exception) { showToast(e.message ?: "操作失败") }
        }
    }

    // Renderer → native

    private fun handleRenderer(message: JsonObject) {
        when (message["type"].str) {
            "loadOlder" -> {
                val id = selectedId ?: return
                val before = message["before_seq"].int
                dev.agentsanywhere.v3poc.bridge.StressMetrics.event("loadOlder", mapOf("before" to before))
                scope.launch {
                    val page = runCatching { client.listMessages(id, before, 50) }.getOrNull() ?: return@launch
                    cache.prepend(page.first, page.second, id)
                    if (id == selectedId) bridge.older(page.first, page.second)
                }
            }
            "answer" -> {
                val request = message["request_id"].str
                val option = message["option_id"].str
                if (request != null && option != null) answer(request, option)
            }
            "open" -> {
                val target = message["target"]
                when (target["kind"].str) {
                    "file" -> openRequest = OpenRequest("打开文件", (target["path"].str ?: "") + (target["line"].int?.let { ":$it" } ?: ""))
                    "url" -> openRequest = OpenRequest("打开链接", target["url"].str ?: "")
                }
            }
            "copy" -> {
                copy(message["text"].str ?: "")
                haptic("success")
                showToast("已复制")
            }
            "rewind" -> showToast("演示：回退")
            "fork" -> showToast("演示：分叉")
            "haptic" -> haptic(message["style"].str ?: "light")
            else -> LaunchClock.log("unhandled renderer message $message")
        }
    }

    // Debug

    private fun scheduleAutoApprove() {
        val seconds = DebugLaunch.autoApproveSeconds ?: return
        val request = pending ?: return
        if (!autoApproved.add(request.requestId)) return
        val option = request.options.firstOrNull { !it.isReject }?.id ?: request.options.firstOrNull()?.id ?: ""
        scope.launch {
            delay((seconds * 1000).toLong())
            if (pending?.requestId != request.requestId) return@launch
            LaunchClock.mark("auto-approve ${request.requestId} with $option")
            answer(request.requestId, option, withHaptic = false)
        }
    }
}
