package dev.agentsanywhere.v3.model

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.agentsanywhere.v3.core.api.ApiException
import dev.agentsanywhere.v3.core.merge.DeviceListState
import dev.agentsanywhere.v3.core.merge.ResultSource
import dev.agentsanywhere.v3.core.merge.SessionMerger
import dev.agentsanywhere.v3.core.model.DeviceRecord
import dev.agentsanywhere.v3.core.model.DeviceSessionResult
import dev.agentsanywhere.v3.core.model.DeviceStatus
import dev.agentsanywhere.v3.core.model.DevicesEvent
import dev.agentsanywhere.v3.core.model.SessionList
import dev.agentsanywhere.v3.core.model.SessionSummary
import dev.agentsanywhere.v3.core.model.UserView
import dev.agentsanywhere.v3.core.pairing.PairingPayload
import io.github.t4wefan.meshcall.MeshCallException
import io.github.t4wefan.meshcall.UnauthenticatedException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The account-wide state the screens draw: sign-in, devices (`aa.v3.Control/watch_devices`) and the merged
 * cross-device conversation list (control plane `list_sessions` for normal devices, this client's own tunnel for
 * paired encrypted ones; merge rules in [SessionMerger]). Streams run while the app is in the foreground and are
 * cancelled in the background (the sockets are closed; coming back reconnects and gets fresh snapshots).
 * Main thread state; network work runs on IO.
 */
class AppModel(val graph: AppGraph) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    var user by mutableStateOf<UserView?>(graph.auth.user); private set
    val signedIn: Boolean get() = user != null
    val controlUrl: String? get() = graph.auth.auth.value?.control_url

    var devices by mutableStateOf<List<DeviceRecord>>(graph.cache.devices()); private set
    var sessions by mutableStateOf<List<SessionSummary>>(emptyList()); private set
    var deviceStates by mutableStateOf<Map<String, DeviceListState>>(emptyMap()); private set
    /** "connecting" | "online" | "offline" (the control plane stream). */
    var connection by mutableStateOf("connecting"); private set
    var lastError by mutableStateOf<String?>(null)
    val statuses = mutableStateMapOf<String, DeviceStatus>()

    private val merger = SessionMerger(devices.associate { d -> d.id to (graph.cache.sessions(d.id)?.sessions.orEmpty()) })
    private var streams: Job? = null
    private var foreground = false

    init {
        devices.forEach { graph.tunnels.setModeHint(it.id, it.mode_hint); graph.cache.status(it.id)?.let { s -> statuses[it.id] = s } }
        publishSessions()
    }

    fun device(id: String): DeviceRecord? = devices.firstOrNull { it.id == id }
    fun projects(deviceId: String): List<String> = merger.projects(deviceId).ifEmpty { graph.cache.sessions(deviceId)?.projects.orEmpty() }
    fun isPaired(deviceId: String) = graph.tunnels.isPaired(deviceId)

    // Sign-in

    suspend fun signIn(controlUrl: String, email: String, password: String) {
        val auth = withContext(Dispatchers.IO) { graph.auth.signIn(controlUrl, email, password) }
        graph.control.invalidate()
        user = auth.user
        if (foreground) startStreams()
    }

    fun signOut() {
        scope.launch {
            stopStreams()
            withContext(Dispatchers.IO) {
                graph.auth.signOut()
                graph.control.invalidate()
                graph.tunnels.closeAll()
                graph.cache.clear()
            }
            user = null
            devices = emptyList()
            sessions = emptyList()
            deviceStates = emptyMap()
            statuses.clear()
            merger.snapshot().keys.forEach(merger::remove)
        }
    }

    // Lifecycle

    fun onForeground() {
        foreground = true
        if (signedIn) startStreams()
    }

    fun onBackground() {
        foreground = false
        stopStreams()
        scope.launch(Dispatchers.IO) {
            graph.control.invalidate()
            graph.tunnels.disconnectAll()
        }
    }

    private fun stopStreams() {
        streams?.cancel()
        streams = null
    }

    private fun startStreams() {
        if (streams?.isActive == true) return
        streams = scope.launch {
            launch { watchDevices() }
            launch { refreshSessionsLoop() }
        }
    }

    /** `watch_devices`, re-subscribed with backoff after a drop. */
    private suspend fun watchDevices() {
        var attempt = 0
        while (true) {
            try {
                connection = "connecting"
                graph.control.watchDevices().collect { event ->
                    attempt = 0
                    connection = "online"
                    lastError = null
                    applyDevices(event)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (handleAuthFailure(e)) return
                Log.w(TAG, "watch_devices failed: $e")
                connection = "offline"
                lastError = e.userMessage()
            }
            delay(backoff(attempt++))
        }
    }

    private fun applyDevices(event: DevicesEvent) {
        val before = devices.associateBy { it.id }
        devices = when (event) {
            is DevicesEvent.Snapshot -> event.devices
            is DevicesEvent.Upsert -> devices.filter { it.id != event.device.id } + event.device
            is DevicesEvent.Remove -> devices.filter { it.id != event.deviceId }.also { merger.remove(event.deviceId) }
        }.sortedWith(compareByDescending<DeviceRecord> { it.online }.thenBy { it.name.lowercase() })
        devices.forEach { graph.tunnels.setModeHint(it.id, it.mode_hint) }
        graph.cache.saveDevices(devices)
        // A device that came online (or changed) gets its list refreshed.
        val changed = devices.filter { d -> before[d.id]?.let { it.presence != d.presence || it.summary != d.summary } ?: true }
        if (changed.isNotEmpty()) scope.launch { refreshSessions(changed.map { it.id }) }
        publishSessions()
    }

    private suspend fun refreshSessionsLoop() {
        while (true) {
            refreshSessions(null)
            delay(30_000)
        }
    }

    /** Pull to refresh, and every 30 s while in the foreground. */
    suspend fun refreshSessions(deviceIds: List<String>?) {
        if (!signedIn) return
        val local = graph.trust.all().keys
        try {
            graph.control.listSessions(deviceIds).collect { result -> apply(ResultSource.ControlPlane, result, local) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            if (handleAuthFailure(e)) return
            Log.w(TAG, "list_sessions failed: $e")
        }
        // Paired encrypted devices: this client lists them itself over its end-to-end tunnel.
        val encrypted = devices.filter { it.online && it.id in local && (deviceIds == null || it.id in deviceIds) }
        for (d in encrypted) {
            val result = try {
                val list = withContext(Dispatchers.IO) { graph.device(d.id).listSessions() }
                DeviceSessionResult(d.id, "ok", list)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                DeviceSessionResult(d.id, "error", error = dev.agentsanywhere.v3.core.model.DeviceError((e as? MeshCallException)?.reason ?: "error", e.userMessage()))
            }
            apply(ResultSource.ClientTunnel, result, local)
        }
    }

    /** A device page's live `watch_list` feeds the same merge (as the client's own tunnel result). */
    fun applyLocalList(deviceId: String, list: SessionList) {
        apply(ResultSource.ClientTunnel, DeviceSessionResult(deviceId, "ok", list), emptySet())
    }

    private fun apply(source: ResultSource, result: DeviceSessionResult, local: Set<String>) {
        merger.apply(source, result, local)
        if (result.status == "ok" && result.value != null) graph.cache.saveSessions(result.device_id, result.value!!)
        publishSessions()
    }

    private fun publishSessions() {
        sessions = merger.merged()
        deviceStates = merger.deviceStates
    }

    fun sessionsOf(deviceId: String): List<SessionSummary> = sessions.filter { it.device_id == deviceId }

    suspend fun loadStatus(deviceId: String): DeviceStatus {
        val status = withContext(Dispatchers.IO) { graph.device(deviceId).status() }
        statuses[deviceId] = status
        graph.cache.saveStatus(status)
        return status
    }

    // Pairing

    suspend fun pair(uri: String) {
        val payload = PairingPayload.parse(uri)
        val name = device(payload.deviceId)?.name
        withContext(Dispatchers.IO) { graph.tunnels.pair(payload, name) }
        graph.tunnels.setModeHint(payload.deviceId, "encrypted")
        runCatching { loadStatus(payload.deviceId) }
        refreshSessions(listOf(payload.deviceId))
    }

    fun unpair(deviceId: String) {
        graph.tunnels.unpair(deviceId)
        publishSessions()
    }

    /** A refresh token the server refused means the account is signed out. */
    private fun handleAuthFailure(e: Throwable): Boolean {
        val signedOut = (e is ApiException && e.unauthenticated) || (e is UnauthenticatedException && graph.auth.auth.value == null)
        if (signedOut || graph.auth.auth.value == null) {
            user = null
            return true
        }
        return false
    }

    private fun backoff(attempt: Int): Long = (1_000L shl attempt.coerceAtMost(5)).coerceAtMost(30_000)

    companion object { const val TAG = "AAv3" }
}
