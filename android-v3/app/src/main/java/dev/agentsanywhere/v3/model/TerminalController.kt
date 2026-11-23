package dev.agentsanywhere.v3.model

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.agentsanywhere.v3.bridge.RenderBridge
import dev.agentsanywhere.v3.core.jsonOf
import dev.agentsanywhere.v3.core.mesh.DeviceClient
import dev.agentsanywhere.v3.core.str
import io.github.t4wefan.meshcall.DuplexCall
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A terminal in the render bundle: the page asks for `term.attach`, native opens `aa.v3.Terminals/attach` (duplex)
 * over the device tunnel and forwards each output frame as `term.<type>` with its fields unchanged; the page's
 * `term.input` / `term.resize` / `term.claim` / `term.release` go back as input frames. The extra-keys bar sends
 * `term.key`, which the page maps to bytes exactly like the Web client and returns as `term.input`.
 */
class TerminalController(
    private val model: AppModel,
    private val bridge: RenderBridge,
    val deviceId: String,
    val terminalId: String,
    /** This phone just created the terminal: attach as its controller (terminal-proposal §3). */
    private val created: Boolean = false,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val client: DeviceClient = model.graph.device(deviceId)
    private var call: DuplexCall<JsonElement, JsonElement>? = null
    private var attachJob: Job? = null

    /** "attaching" | "attached" | "exited" | "error" */
    var phase by mutableStateOf("attaching"); private set
    var error by mutableStateOf<String?>(null); private set

    private val readyRef: () -> Unit = { show() }
    private val pageRef: (JsonObject) -> Unit = { onPageMessage(it) }

    fun start() {
        bridge.onReady = readyRef
        bridge.onMessage = pageRef
        show()
    }

    fun resume() = start()

    fun stop() {
        if (bridge.onReady === readyRef) bridge.onReady = {}
        if (bridge.onMessage === pageRef) bridge.onMessage = {}
        detach()
        scope.cancel()
    }

    private var info: dev.agentsanywhere.v3.core.model.TerminalInfo? = null

    private fun show() {
        val i = info
        bridge.send("view.terminal", "device_id" to deviceId, "terminal_id" to terminalId, "controller_label" to "Android",
            "attach_mode" to if (created) "control" else null, "cols" to i?.cols, "rows" to i?.rows)
    }

    /** Terminal size for the first frame (view.terminal `cols` / `rows`). */
    fun loadInfo() {
        scope.launch {
            info = runCatching { kotlinx.coroutines.withContext(Dispatchers.IO) { client.listTerminals() } }.getOrNull()?.firstOrNull { it.id == terminalId }
        }
    }

    /** From the extra-keys bar. */
    fun key(key: String, ctrl: Boolean = false, alt: Boolean = false, shift: Boolean = false) {
        bridge.send("term.key", "terminal_id" to terminalId, "key" to key, "ctrl" to ctrl.takeIf { it }, "alt" to alt.takeIf { it }, "shift" to shift.takeIf { it })
    }

    private fun onPageMessage(m: JsonObject) {
        val type = m["type"].str ?: return
        if (!type.startsWith("term.")) return
        when (type) {
            "term.attach" -> attach(m)
            "term.detach" -> detach()
            else -> {
                // term.input / term.resize / term.claim / term.release → input frame {type: input|resize|claim|release, …}
                val frame = JsonObject(m.filterKeys { it != "v" && it != "terminal_id" } + ("type" to JsonPrimitive(type.removePrefix("term."))))
                val c = call ?: return
                scope.launch { runCatching { c.send(frame) }.onFailure { Log.w(TAG, "terminal input failed: $it") } }
            }
        }
    }

    private fun attach(m: JsonObject) {
        detach()
        phase = "attaching"
        val request = JsonObject(buildMap {
            put("id", JsonPrimitive(m["terminal_id"].str ?: terminalId))
            m["mode"]?.let { put("mode", it) }
            m["cols"]?.let { put("cols", it) }
            m["rows"]?.let { put("rows", it) }
            m["resume_seq"]?.let { put("resume_seq", it) }
            m["label"]?.let { put("label", it) }
        })
        attachJob = scope.launch {
            try {
                val c = client.attachTerminal(request)
                call = c
                phase = "attached"
                c.output.collect { frame ->
                    val obj = frame as? JsonObject ?: return@collect
                    val t = obj["type"].str ?: return@collect
                    if (t == "exit") phase = "exited"
                    bridge.send(JsonObject(obj + ("type" to JsonPrimitive("term.$t")) + ("terminal_id" to JsonPrimitive(terminalId))))
                }
                bridge.send(jsonOf("type" to "term.closed", "terminal_id" to terminalId))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                Log.w(TAG, "attach $terminalId failed: $e")
                phase = "error"
                error = e.userMessage()
                // Not found / not allowed: the page should not reconnect. A dropped connection: it re-attaches with resume_seq.
                val fatal = e is io.github.t4wefan.meshcall.MeshCallException && e.code in setOf("invalid_argument", "permission_denied", "unauthenticated")
                bridge.send(jsonOf("type" to "term.closed", "terminal_id" to terminalId, "fatal" to fatal.takeIf { it }))
            } finally {
                call = null
            }
        }
    }

    private fun detach() {
        call?.cancel()
        call = null
        attachJob?.cancel()
        attachJob = null
    }

    companion object { const val TAG = "AAv3" }
}
