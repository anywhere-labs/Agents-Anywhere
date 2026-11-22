package dev.agentsanywhere.v3.core.mesh

import dev.agentsanywhere.v3.core.AAJson
import dev.agentsanywhere.v3.core.pairing.PairingPayload
import dev.agentsanywhere.v3.core.pairing.TrustRecord
import dev.agentsanywhere.v3.core.pairing.TrustStore
import dev.agentsanywhere.v3.core.store.ClientIdentity
import io.github.t4wefan.meshcall.DuplexCall
import io.github.t4wefan.meshcall.E2EIdentity
import io.github.t4wefan.meshcall.E2EPairing
import io.github.t4wefan.meshcall.Mesh
import io.github.t4wefan.meshcall.MeshCallException
import io.github.t4wefan.meshcall.MeshOptions
import io.github.t4wefan.meshcall.Router
import io.github.t4wefan.meshcall.UnauthenticatedException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import okhttp3.OkHttpClient
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * One MeshCall tunnel per device (`aa.v3.Control/open_tunnel`), shared by every screen. Normal devices get a plain
 * tunnel; a device this client paired with (or one the control plane marks encrypted) only ever gets an end-to-end
 * tunnel to the key pinned from its QR code, authenticated with this client's own key (Noise IK). Never a plaintext
 * fallback. A tunnel credential's expiry only limits new connections: the Mesh is reused until a call is refused as
 * unauthenticated, then the tunnel is reopened and the call retried once.
 */
class DeviceTunnelPool(
    private val control: ControlMesh,
    private val identity: ClientIdentity,
    val trust: TrustStore,
    private val httpClient: OkHttpClient? = null,
) {
    private class Entry(val mesh: Mesh, val encrypted: Boolean)

    private val tunnels = ConcurrentHashMap<String, Entry>()
    private val locks = ConcurrentHashMap<String, Mutex>()
    /** `mode_hint` per device, from the device list. */
    private val modeHints = ConcurrentHashMap<String, String>()

    fun setModeHint(deviceId: String, mode: String) { modeHints[deviceId] = mode }

    fun requiresE2ee(deviceId: String): Boolean = trust.get(deviceId)?.require_e2ee == true || modeHints[deviceId] == "encrypted"

    fun isPaired(deviceId: String): Boolean = trust.get(deviceId) != null

    fun isEncryptedTunnel(deviceId: String): Boolean = tunnels[deviceId]?.encrypted == true

    suspend fun mesh(deviceId: String): Mesh = lock(deviceId).withLock {
        tunnels[deviceId]?.let { return it.mesh }
        val record = trust.get(deviceId)
        val e2e = requiresE2ee(deviceId)
        if (e2e && record == null) throw AAException("e2e_not_paired", "This device is encrypted. Scan its pairing code first.")
        val opened = control.openTunnel(deviceId, record?.device_pub)
        val mesh = if (e2e || record != null) {
            if (!opened.credential.startsWith("mtun_e2e.")) throw AAException("e2e_required_locally", "The control plane offered a plaintext tunnel to an encrypted device; refused.")
            Mesh(Router(toWebSocketUrl(opened.router_url)), MeshOptions(
                tunnel = opened.credential,
                e2eKey = record!!.device_pub,
                e2eIdentity = E2EIdentity(identity.private_key, deviceId),
                httpClient = httpClient,
            ))
        } else {
            Mesh(Router(toWebSocketUrl(opened.router_url)), MeshOptions(tunnel = opened.credential, httpClient = httpClient))
        }
        tunnels[deviceId] = Entry(mesh, e2e || record != null)
        mesh
    }

    fun evict(deviceId: String) {
        tunnels.remove(deviceId)?.mesh?.close()
    }

    fun closeAll() {
        tunnels.values.forEach { it.mesh.close() }
        tunnels.clear()
    }

    /** Background: drop sockets; the next call reconnects (and re-handshakes). */
    fun disconnectAll() = tunnels.values.forEach { it.mesh.close() }

    suspend fun unary(deviceId: String, service: String, method: String, request: JsonElement): JsonElement = try {
        mesh(deviceId).unary(service, method, request)
    } catch (e: UnauthenticatedException) {
        if (e.reason == "e2e_handshake_failed") throw e
        evict(deviceId)
        mesh(deviceId).unary(service, method, request)
    }

    fun stream(deviceId: String, service: String, method: String, request: JsonElement): Flow<JsonElement> = flow {
        var emitted = false
        try {
            mesh(deviceId).serverStream(service, method, request).collect { emitted = true; emit(it) }
        } catch (e: UnauthenticatedException) {
            evict(deviceId)
            if (emitted || e.reason == "e2e_handshake_failed") throw e
            mesh(deviceId).serverStream(service, method, request).collect { emit(it) }
        }
    }

    suspend fun duplex(deviceId: String, service: String, method: String, request: JsonElement): DuplexCall<JsonElement, JsonElement> = try {
        mesh(deviceId).duplex(service, method, request)
    } catch (e: UnauthenticatedException) {
        evict(deviceId)
        mesh(deviceId).duplex(service, method, request)
    }

    /**
     * Pairs with an encrypted device from its QR code: the trust record is saved first (rolled back on failure), the
     * tunnel is opened to the QR's key, and the first handshake is Noise IKpsk2 with the one-time PSK; once the device
     * accepts it, the same Mesh uses IK. `Device/status` confirms the pairing.
     */
    suspend fun pair(payload: PairingPayload, deviceName: String?, now: Instant = Instant.now()): JsonElement = lock(payload.deviceId).withLock {
        val deviceId = payload.deviceId
        val previous = trust.get(deviceId)
        if (previous != null && previous.device_pub != payload.device_pub) {
            throw AAException("device_pub_mismatch", "This code shows a different key than the one paired before. Unpair the device first if it was reinstalled.")
        }
        trust.put(TrustRecord(deviceId, payload.device_pub, true, "verified_app", now.toString(), deviceName))
        tunnels.remove(deviceId)?.mesh?.close()
        try {
            val opened = control.openTunnel(deviceId, payload.device_pub)
            if (!opened.credential.startsWith("mtun_e2e.")) throw AAException("e2e_required_locally", "The control plane offered a plaintext tunnel; refused.")
            val mesh = Mesh(Router(toWebSocketUrl(opened.router_url)), MeshOptions(
                tunnel = opened.credential,
                e2eKey = payload.device_pub,
                e2eIdentity = E2EIdentity(identity.private_key, deviceId, E2EPairing(payload.pairing_id, payload.psk)),
                httpClient = httpClient,
            ))
            mesh.connect()
            val status = mesh.unary(DEVICE, "status", AAJson.parseToJsonElement("{}"))
            tunnels[deviceId] = Entry(mesh, true)
            status
        } catch (e: Throwable) {
            if (previous == null) trust.remove(deviceId) else trust.put(previous)
            throw when (e) {
                is AAException -> e
                is MeshCallException -> {
                    val m = (e.message ?: "").lowercase()
                    when {
                        "expired" in m -> AAException("pairing_expired", "The pairing code expired. Show a new one on the device.")
                        "used" in m || "consumed" in m -> AAException("pairing_used", "This pairing code was already used. Show a new one on the device.")
                        e.code == "unavailable" -> AAException("device_offline", e.message ?: "The device is offline")
                        else -> AAException("e2e_handshake_failed", "The device did not accept this pairing (${e.message}).")
                    }
                }
                else -> e
            }
        }
    }

    fun unpair(deviceId: String) {
        evict(deviceId)
        trust.remove(deviceId)
    }

    private fun lock(deviceId: String) = locks.getOrPut(deviceId) { Mutex() }

    companion object {
        const val SESSIONS = "aa.v3.Sessions"
        const val DEVICE = "aa.v3.Device"
        const val TERMINALS = "aa.v3.Terminals"
    }
}
