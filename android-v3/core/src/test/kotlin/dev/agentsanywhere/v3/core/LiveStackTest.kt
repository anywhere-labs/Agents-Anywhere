package dev.agentsanywhere.v3.core

import dev.agentsanywhere.v3.core.api.AuthSession
import dev.agentsanywhere.v3.core.mesh.ControlMesh
import dev.agentsanywhere.v3.core.mesh.DeviceClient
import dev.agentsanywhere.v3.core.mesh.DeviceTunnelPool
import dev.agentsanywhere.v3.core.model.ConversationState
import dev.agentsanywhere.v3.core.model.DevicesEvent
import dev.agentsanywhere.v3.core.model.messageText
import dev.agentsanywhere.v3.core.pairing.TrustStore
import dev.agentsanywhere.v3.core.store.ClientIdentity
import dev.agentsanywhere.v3.core.store.MemorySecureStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * End to end against a running AA v3 stack (control plane + Router + an online normal device with the `pi` agent).
 * Skipped unless AA_V3_CONTROL_URL is set, e.g.
 * `AA_V3_CONTROL_URL=http://127.0.0.1:8790 AA_V3_EMAIL=dev@aa.local AA_V3_PASSWORD=… ./gradlew :core:test --tests '*LiveStackTest*'`.
 * It creates one conversation and sends one message.
 */
class LiveStackTest {
    private val url = System.getenv("AA_V3_CONTROL_URL")

    @Test
    fun signInListDevicesCreateSendAndWatch() {
        if (url.isNullOrBlank()) return
        val agent = System.getenv("AA_V3_AGENT") ?: "pi"
        runBlocking {
            withTimeout(180_000) {
                val secure = MemorySecureStore()
                val identity = ClientIdentity.loadOrCreate(secure)
                val auth = AuthSession(secure, identity)
                auth.signIn(url, System.getenv("AA_V3_EMAIL") ?: "dev@aa.local", System.getenv("AA_V3_PASSWORD") ?: "aa-dev-password")
                val control = ControlMesh(auth)
                val snapshot = control.watchDevices().first() as DevicesEvent.Snapshot
                println("devices: " + snapshot.devices.map { "${it.name} ${it.presence} ${it.mode_hint}" })
                val device = snapshot.devices.first { it.online && !it.encrypted }
                val sessions = control.listSessions(listOf(device.id)).toList()
                println("list_sessions: " + sessions.map { "${it.device_id} ${it.status} ${it.value?.sessions?.size}" })

                val pool = DeviceTunnelPool(control, identity, TrustStore(secure))
                val client = DeviceClient(pool, device.id)
                val status = client.status()
                println("runtimes: " + status.runtimes)
                assertTrue(status.runtimes.any { it.id == agent }, "device has $agent")

                val session = client.create(agent, null, "android-v3 core live test")
                val state = ConversationState(session.id)
                val result = client.send(session.id, "Reply with exactly: pong")
                println("send: $result")
                client.watch(session.id).first { ev ->
                    state.apply(ev)
                    val reply = state.messages.lastOrNull { it["role"].str == "assistant" && messageText(it).isNotBlank() }
                    reply != null && !state.control.running
                }
                val text = state.messages.filter { it["role"].str == "assistant" }.joinToString(" ") { messageText(it) }
                println("reply: $text")
                assertTrue(text.isNotBlank())
                client.delete(session.id)
                pool.closeAll()
                control.invalidate()
            }
        }
    }
}
