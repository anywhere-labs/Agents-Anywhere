package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.RemoteDisplayEnvelope
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.e2ee.DirectoryKeyGrant
import com.agentsanywhere.app.api.e2ee.DisplaySlot
import com.agentsanywhere.app.api.e2ee.E2eeFormats
import com.agentsanywhere.app.api.toProtocolJson
import com.agentsanywhere.app.feature.e2ee.SessionDisplayDecryptor
import com.agentsanywhere.app.model.AgentSession
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** 会话列表里的标题与工作目录：信封解析、标题优先级、占位、普通模式不变。 */
class SessionDisplayTest {
    private val keyBytes = ByteArray(32) { (it + 11).toByte() }
    private val grant = DirectoryKeyGrant("dev_1", "dk_1", 1, E2eeFormats.b64url(keyBytes))
    private val api = SessionsApi()
    private val savedDecryptor = SessionDisplayEnvironment.decryptor
    private val savedLabel = SessionDisplayEnvironment.lockedLabel

    @Before
    fun install() {
        SessionDisplayEnvironment.decryptor = SessionDisplayDecryptor(keyFor = { if (it == "dev_1") grant else null })
        SessionDisplayEnvironment.lockedLabel = "加密中"
    }

    @After
    fun restore() {
        SessionDisplayEnvironment.decryptor = savedDecryptor
        SessionDisplayEnvironment.lockedLabel = savedLabel
    }

    private fun sealed(fields: JSONObject, slot: DisplaySlot, keyId: String = "dk_1", key: ByteArray = keyBytes, sessionId: String = "sess_1") =
        JSONObject().put("mode", "sealed").put("keyId", keyId).put(
            "payload",
            E2eeFormats.sealDisplay(key, E2eeFormats.displayEnvelopeAd("dev_1", sessionId, slot, keyId), fields.toString().toByteArray()),
        )

    private fun plain(fields: JSONObject) = JSONObject().put("mode", "plain").put("payload", fields)

    private fun wire(
        title: String? = null,
        cwd: String? = null,
        displayDevice: JSONObject? = null,
        displayUser: JSONObject? = null,
        status: String = "idle",
    ) = JSONObject()
        .put("id", "sess_1")
        .put("connectorId", "dev_1")
        .put("projectId", JSONObject.NULL)
        .put("connectorStatus", "online")
        .put("runtime", "codex")
        .put("externalSessionId", "ext-123")
        .put("title", title ?: JSONObject.NULL)
        .put("cwd", cwd ?: JSONObject.NULL)
        .put("status", status)
        .put("updatedSeq", 4)
        .apply {
            displayDevice?.let { put("displayDevice", it) }
            displayUser?.let { put("displayUser", it) }
        }

    private fun map(value: JSONObject): AgentSession = api.parseSession(value).toAgentSession(emptyMap())

    @Test
    fun withoutEnvelopesNothingChanges() {
        val session = map(wire(title = "Server title", cwd = "/home/me/app"))
        assertEquals("Server title", session.title)
        assertEquals("/home/me/app", session.cwd)
        assertEquals("app", session.workspaceLabel)
        assertEquals("/home/me/app", session.summary)
        assertFalse(session.encryptedDisplay || session.titleLocked || session.cwdLocked)
        // No title at all still falls back to the runtime's session id.
        assertEquals("ext-123", map(wire()).title)
    }

    @Test
    fun plainEnvelopesComeFirstAndServerFieldsFillTheGaps() {
        val device = plain(JSONObject().put("title", "Native").put("cwd", "/device/path"))
        // The device's envelope wins over the Server's `title`; a rename shows because the Server also writes a
        // plain displayUser when renaming (follow-up of #759).
        val normal = map(wire(title = "Renamed", cwd = "/server/path", displayDevice = device))
        assertEquals("Native", normal.title)
        assertEquals("/device/path", normal.cwd)
        assertFalse(normal.encryptedDisplay)
        assertEquals("Mine", map(wire(title = "Renamed", displayDevice = device, displayUser = plain(JSONObject().put("title", "Mine")))).title)
        // The Server's plaintext only fills what the envelopes leave empty.
        val gaps = map(wire(title = "Server title", cwd = "/server/path", displayDevice = plain(JSONObject().put("preview", "p"))))
        assertEquals("Server title", gaps.title)
        assertEquals("/server/path", gaps.cwd)
        // An unknown mode counts as no envelope.
        val unknown = map(wire(title = "Server title", cwd = "/server/path", displayDevice = JSONObject().put("mode", "future").put("payload", "x")))
        assertEquals("Server title", unknown.title)
        assertEquals("/server/path", unknown.cwd)
        assertFalse(unknown.encryptedDisplay || unknown.titleLocked)
    }

    @Test
    fun titleIsDisplayUserThenDisplayDevice() {
        val device = sealed(JSONObject().put("title", "Native").put("cwd", "/work/app"), DisplaySlot.Device)
        val user = sealed(JSONObject().put("title", "Renamed"), DisplaySlot.User)
        val both = map(wire(displayDevice = device, displayUser = user))
        assertEquals("Renamed", both.title)
        assertEquals("/work/app", both.cwd)
        assertEquals("app", both.workspaceLabel)
        assertTrue(both.encryptedDisplay)
        assertFalse(both.titleLocked || both.cwdLocked)

        assertEquals("Native", map(wire(displayDevice = device)).title)
        // displayUser without a title falls back to the device's title.
        assertEquals("Native", map(wire(displayDevice = device, displayUser = sealed(JSONObject(), DisplaySlot.User))).title)
    }

    @Test
    fun anUnreadableEnvelopeShowsThePlaceholderAndNeverTheServerPlaintext() {
        val oldKey = ByteArray(32) { 2 }
        val device = sealed(JSONObject().put("title", "Native").put("cwd", "/work/app"), DisplaySlot.Device, keyId = "dk_0", key = oldKey)
        // Even if a Server sent plaintext next to a sealed envelope, it is not shown.
        val session = map(wire(title = "leaked", cwd = "/leaked", displayDevice = device))
        assertEquals("加密中", session.title)
        assertNull(session.cwd)
        assertEquals("加密中", session.workspaceLabel)
        assertEquals("加密中", session.summary)
        assertTrue(session.titleLocked && session.cwdLocked && session.encryptedDisplay)

        // The user's rename is sealed with an old key: placeholder, not the device's native title.
        val freshDevice = sealed(JSONObject().put("title", "Native").put("cwd", "/work/app"), DisplaySlot.Device)
        val oldUser = sealed(JSONObject().put("title", "Renamed"), DisplaySlot.User, keyId = "dk_0", key = oldKey)
        val mixed = map(wire(displayDevice = freshDevice, displayUser = oldUser))
        assertEquals("加密中", mixed.title)
        assertTrue(mixed.titleLocked)
        assertEquals("/work/app", mixed.cwd)
        assertFalse(mixed.cwdLocked)

        // An envelope sealed for another session (the Server moved it) cannot be opened either.
        val moved = sealed(JSONObject().put("title", "Other"), DisplaySlot.Device, sessionId = "sess_9")
        assertEquals("加密中", map(wire(displayDevice = moved)).title)

        // The device's envelope is locked but the user's rename opens: the rename shows, the directory stays empty.
        val lockedDevice = sealed(JSONObject().put("title", "Native").put("cwd", "/work/app"), DisplaySlot.Device, keyId = "dk_0", key = oldKey)
        val freshUser = sealed(JSONObject().put("title", "Renamed"), DisplaySlot.User)
        val renamed = map(wire(displayDevice = lockedDevice, displayUser = freshUser))
        assertEquals("Renamed", renamed.title)
        assertFalse(renamed.titleLocked)
        assertNull(renamed.cwd)
        assertTrue(renamed.cwdLocked)
    }

    @Test
    fun nextToASealedEnvelopePlainOnesAreIgnored() {
        val device = sealed(JSONObject().put("title", "Native").put("cwd", "/work/app"), DisplaySlot.Device)
        val plainUser = plain(JSONObject().put("title", "From the Server"))
        val session = map(wire(displayDevice = device, displayUser = plainUser))
        assertEquals("Native", session.title)
        assertTrue(session.encryptedDisplay)
        // A plain displayDevice does not stand in for a locked sealed displayUser either.
        val lockedUser = sealed(JSONObject().put("title", "Renamed"), DisplaySlot.User, keyId = "dk_0")
        val locked = map(wire(displayDevice = plain(JSONObject().put("title", "x").put("cwd", "/x")), displayUser = lockedUser))
        assertEquals("加密中", locked.title)
        assertNull(locked.cwd)
    }

    @Test
    fun aSealedEnvelopeWithoutTitleFallsBackToTheRuntimeIdNotTheServer() {
        val device = sealed(JSONObject().put("cwd", "/work/app"), DisplaySlot.Device)
        val session = map(wire(title = "leaked", displayDevice = device))
        assertEquals("ext-123", session.title)
        assertFalse(session.titleLocked)
    }

    @Test
    fun envelopesSurviveTheOnDeviceCache() {
        val device = sealed(JSONObject().put("title", "Native"), DisplaySlot.Device)
        val user = plain(JSONObject().put("title", "Mine"))
        val parsed = api.parseSession(wire(displayDevice = device, displayUser = user))
        assertEquals(RemoteDisplayEnvelope("sealed", "dk_1", device.getString("payload")), parsed.displayDevice)
        assertEquals("plain", parsed.displayUser?.mode)
        assertEquals("Mine", JSONObject(parsed.displayUser!!.payload).getString("title"))

        val stored = parsed.toProtocolJson()
        assertTrue(stored.getJSONObject("displayUser").get("payload") is JSONObject)
        assertEquals(parsed, api.parseSession(stored))
        // Malformed or null envelopes read as absent.
        val broken = api.parseSession(wire().put("displayDevice", JSONObject().put("mode", "sealed")).put("displayUser", JSONObject.NULL))
        assertNull(broken.displayDevice)
        assertNull(broken.displayUser)
    }

    @Test
    fun anObservedUpdateReplacesOnlyAPlaceholderTitle() {
        val locked = map(wire(displayDevice = sealed(JSONObject().put("title", "x"), DisplaySlot.Device, keyId = "dk_0")))
        val readable = map(wire(displayDevice = sealed(JSONObject().put("title", "Native"), DisplaySlot.Device)))
        val merged = mergeObservedSession(locked, readable)
        assertEquals("Native", merged.title)
        assertFalse(merged.titleLocked)
        // A readable title is kept as before (observed updates never rename).
        val kept = mergeObservedSession(readable.copy(title = "Kept"), readable)
        assertEquals("Kept", kept.title)
    }
}
