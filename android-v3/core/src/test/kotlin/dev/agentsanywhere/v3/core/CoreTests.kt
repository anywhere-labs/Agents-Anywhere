package dev.agentsanywhere.v3.core

import dev.agentsanywhere.v3.core.bridge.BridgeOutbox
import dev.agentsanywhere.v3.core.mesh.AAException
import dev.agentsanywhere.v3.core.model.ConversationState
import dev.agentsanywhere.v3.core.model.WatchEvent
import dev.agentsanywhere.v3.core.model.groupByAgentAndProject
import dev.agentsanywhere.v3.core.model.SessionSummary
import dev.agentsanywhere.v3.core.pairing.PairingPayload
import dev.agentsanywhere.v3.core.pairing.TrustRecord
import dev.agentsanywhere.v3.core.pairing.TrustStore
import dev.agentsanywhere.v3.core.pairing.keyFingerprint
import dev.agentsanywhere.v3.core.store.ClientIdentity
import dev.agentsanywhere.v3.core.store.MemorySecureStore
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BridgeOutboxTest {
    private fun msg(type: String) = jsonOf("type" to type)

    @Test
    fun queuesUntilReadyThenBatchesInOrder() {
        val box = BridgeOutbox()
        assertFalse(box.enqueue(msg("theme")))
        box.enqueue(msg("locale"))
        assertNull(box.drain(), "nothing before ready")
        box.markReady(jsonOf("type" to "ready", "version" to "1.0", "capabilities" to listOf("conversation", "terminal")))
        assertEquals(listOf("conversation", "terminal"), box.pageCapabilities)
        val batch = box.drainMessage()!!
        assertEquals("batch", batch["type"].str)
        assertEquals(2L, batch["v"].long)
        assertEquals(listOf("theme", "locale"), batch["messages"].arr.map { it["type"].str })
        assertTrue(batch["messages"].arr.all { it["v"].long == 2L })
        assertNull(box.drainMessage())
    }

    @Test
    fun singleMessageIsSentAsIs() {
        val box = BridgeOutbox()
        box.markReady(jsonOf("type" to "ready"))
        assertTrue(box.enqueue(msg("scroll")))
        val script = box.drain()!!
        assertTrue(script.startsWith("window.aa&&window.aa.receive({"))
        assertTrue("\"type\":\"scroll\"" in script)
    }

    @Test
    fun resetHoldsUntilNextReady() {
        val box = BridgeOutbox()
        box.markReady(jsonOf("type" to "ready"))
        box.reset(dropQueued = true)
        box.enqueue(msg("view.conversation"))
        assertFalse(box.hasPending)
        box.markReady(jsonOf("type" to "ready"))
        assertTrue(box.hasPending)
    }

    @Test
    fun scriptEscapesLineSeparators() {
        val s = BridgeOutbox.script(jsonOf("type" to "x", "text" to "a\u2028b"))
        assertFalse('\u2028' in s)
        assertTrue("\\u2028" in s)
    }

    @Test
    fun parsesInbound() {
        assertEquals("ready", BridgeOutbox.parseInbound("""{"v":2,"type":"ready"}""")!!["type"].str)
        assertNull(BridgeOutbox.parseInbound("not json"))
        assertNull(BridgeOutbox.parseInbound("""{"v":2}"""))
    }
}

class PairingTest {
    private val key = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() })
    private fun uri(vararg overrides: Pair<String, Any?>, extra: Map<String, Any?> = emptyMap()): String {
        val base = linkedMapOf<String, Any?>("v" to 1, "instance_id" to "dev_1", "device_pub" to key, "pairing_id" to "pair_12345678",
            "psk" to key, "expires_at" to "2026-11-23T10:00:00Z")
        overrides.forEach { (k, v) -> if (v == null) base.remove(k) else base[k] = v }
        base.putAll(extra)
        val json = AAJson.encodeToString(JsonObject.serializer(), toJson(base) as JsonObject)
        return PairingPayload.PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())
    }
    private val now = Instant.parse("2026-11-23T09:55:00Z")

    @Test
    fun parsesValidCode() {
        val p = PairingPayload.parse(uri(), now)
        assertEquals("dev_1", p.deviceId)
        assertTrue(p.toString().endsWith("psk=***)"), "psk is not printed")
    }

    @Test
    fun rejectsBadCodes() {
        assertEquals("invalid_pairing_uri", assertFailsWith<AAException> { PairingPayload.parse("https://example.com", now) }.code)
        assertEquals("invalid_pairing_uri", assertFailsWith<AAException> { PairingPayload.parse(uri(extra = mapOf("x" to 1)), now) }.code)
        assertEquals("invalid_pairing_uri", assertFailsWith<AAException> { PairingPayload.parse(uri("psk" to "short"), now) }.code)
        assertEquals("invalid_pairing_uri", assertFailsWith<AAException> { PairingPayload.parse(uri("pairing_id" to "short"), now) }.code)
        assertEquals("pairing_expired", assertFailsWith<AAException> { PairingPayload.parse(uri(), Instant.parse("2026-11-23T10:00:01Z")) }.code)
    }

    @Test
    fun fingerprintIsGroupedHex() {
        val fp = keyFingerprint(key)
        assertEquals(8, fp.split(" ").size)
        assertTrue(fp.matches(Regex("([0-9A-F]{4} ){7}[0-9A-F]{4}")))
    }

    @Test
    fun trustStoreRoundTrip() {
        val store = TrustStore(MemorySecureStore())
        store.put(TrustRecord("dev_1", key, paired_at = "2026-11-23T00:00:00Z"))
        assertNotNull(store.get("dev_1"))
        store.remove("dev_1")
        assertNull(store.get("dev_1"))
    }

    @Test
    fun identityIsStable() {
        val store = MemorySecureStore()
        val a = ClientIdentity.loadOrCreate(store)
        val b = ClientIdentity.loadOrCreate(store)
        assertEquals(a, b)
        assertTrue(a.client_id.startsWith("cli_android_"))
        assertEquals(43, a.public_key.length)
    }
}

class ConversationStateTest {
    private fun event(json: String) = WatchEvent(AAJson.parseToJsonElement(json) as JsonObject)

    @Test
    fun appliesSnapshotThenReplacesById() {
        val s = ConversationState("s1")
        s.apply(event("""{"type":"snapshot","session":{"id":"s1","title":"T","agent":"pi","config":[{"id":"model","name":"Model","current":"a","options":[{"value":"a","name":"A"}]}]},
            "messages":[{"id":"m1","seq":0,"role":"user","parts":[{"type":"text","text":"hi"}]}],"has_more":true,
            "control":{"state":"running","steer":"interrupt","pending":[],"queued":[]}}"""))
        assertEquals("A", s.session!!.config.single().currentName)
        assertTrue(s.control.running)
        assertTrue(s.hasMore)
        s.apply(event("""{"type":"message","message":{"id":"m2","seq":1,"role":"assistant","turn_id":"t","parts":[{"type":"text","text":"hel"}]}}"""))
        s.apply(event("""{"type":"message","message":{"id":"m2","seq":1,"role":"assistant","turn_id":"t","parts":[{"type":"text","text":"hello"}]}}"""))
        assertEquals(listOf("m1", "m2"), s.messages.map { it["id"].str })
        assertEquals("hello", dev.agentsanywhere.v3.core.model.messageText(s.messages.last()))
        s.apply(event("""{"type":"control","control":{"state":"idle","steer":"none","pending":[{"request_id":"r","title":"Run ls","options":[{"id":"o","name":"Allow","kind":"allow_once"}]}],"queued":[]}}"""))
        assertEquals("Run ls", s.control.pending.single().title)
        assertTrue(s.control.pending.single().options.single().allows)
    }

    @Test
    fun unknownFieldsAreIgnored() {
        val s = ConversationState("s1")
        s.apply(event("""{"type":"session","session":{"id":"s1","title":"X","future_field":{"a":1}}}"""))
        assertEquals("X", s.session!!.title)
    }

    @Test
    fun groupsByAgentThenProject() {
        fun s(id: String, agent: String, cwd: String, at: String) = SessionSummary(id = id, agent = agent, cwd = cwd, device_id = "d", updated_at = at)
        val groups = groupByAgentAndProject(listOf(
            s("1", "pi", "/w/a", "2026-11-20T01:00:00Z"),
            s("2", "pi", "/w/b", "2026-11-20T03:00:00Z"),
            s("3", "antigravity", "/w/a", "2026-11-20T02:00:00Z"),
        ))
        assertEquals(listOf("pi", "antigravity"), groups.map { it.agent })
        assertEquals(listOf("b", "a"), groups[0].projects.map { it.name })
    }
}
