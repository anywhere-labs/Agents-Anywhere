package dev.agentsanywhere.v3.core.merge

import dev.agentsanywhere.v3.core.model.DeviceSessionResult
import dev.agentsanywhere.v3.core.model.SessionSummary
import java.time.Instant

/** Where a device's slice came from: the control plane fan-out, or this client's own (encrypted) tunnel. */
enum class ResultSource { ControlPlane, ClientTunnel }

data class DeviceListState(
    /** "ok" | "offline" | "timeout" | "error" | "encrypted" | "cached" */
    val status: String,
    /** True when the sessions shown are a cache (read-only). */
    val stale: Boolean,
    val errorCode: String? = null,
)

/**
 * The cross-device conversation list, merged exactly as every AA v3 client does (contracts/aa-v3/1.0/README.md and
 * fixtures/session-merge.json):
 *  1. a device's `ok` result replaces its whole slice;
 *  2. the control plane's `encrypted` marker never overwrites what this client fetched itself;
 *  3. `offline` / `timeout` / `error` keep the cached slice, marked stale;
 *  4. a locally pinned E2EE device never accepts plaintext from the control plane (`e2e_required_locally`);
 *  5. order: pinned first, then `updated_at` newest first, then `device_id`, then `id` (ASCII).
 */
class SessionMerger(initialCache: Map<String, List<SessionSummary>> = emptyMap()) {
    private val sessions = LinkedHashMap<String, List<SessionSummary>>()
    private val projectsByDevice = LinkedHashMap<String, List<String>>()
    private val states = LinkedHashMap<String, DeviceListState>()

    init {
        for ((device, list) in initialCache) {
            sessions[device] = list
            states[device] = DeviceListState("cached", true)
        }
    }

    val deviceStates: Map<String, DeviceListState> get() = states.toMap()

    fun projects(deviceId: String): List<String> = projectsByDevice[deviceId].orEmpty()

    fun sessions(deviceId: String): List<SessionSummary> = sessions[deviceId].orEmpty()

    /** Applies one device result. [localE2ee]: devices this client pinned (trust records). */
    fun apply(source: ResultSource, result: DeviceSessionResult, localE2ee: Set<String>) {
        val device = result.device_id
        if (source == ResultSource.ControlPlane && device in localE2ee) {
            if (result.status == "encrypted") {
                states.putIfAbsent(device, DeviceListState("encrypted", true))
            } else {
                states[device] = DeviceListState("error", true, "e2e_required_locally")
            }
            return
        }
        when (result.status) {
            "ok" -> {
                sessions[device] = result.value?.sessions.orEmpty()
                projectsByDevice[device] = result.value?.projects.orEmpty()
                states[device] = DeviceListState("ok", false)
            }
            "encrypted" -> states.putIfAbsent(device, DeviceListState("encrypted", true))
            else -> states[device] = DeviceListState(result.status, true, result.error?.code)
        }
    }

    /** Drops a device that was deleted from the account. */
    fun remove(deviceId: String) {
        sessions.remove(deviceId)
        projectsByDevice.remove(deviceId)
        states.remove(deviceId)
    }

    fun merged(): List<SessionSummary> = sessions.values.flatten().sortedWith(ORDER)

    fun snapshot(): Map<String, List<SessionSummary>> = sessions.toMap()

    companion object {
        private fun instant(s: SessionSummary): Long = runCatching { Instant.parse(s.updated_at).toEpochMilli() }.getOrDefault(0L)

        val ORDER: Comparator<SessionSummary> = compareBy<SessionSummary> { if (it.pinned) 0 else 1 }
            .thenByDescending { instant(it) }
            .thenBy { it.device_id }
            .thenBy { it.id }
    }
}
