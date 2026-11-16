package com.agentsanywhere.app.feature.e2ee

import com.agentsanywhere.app.api.RemoteDisplayEnvelope
import com.agentsanywhere.app.api.e2ee.DirectoryKeyGrant
import com.agentsanywhere.app.api.e2ee.DisplaySlot
import com.agentsanywhere.app.api.e2ee.E2eeFormats
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** 展示信封的解密：AD 绑定（设备、会话、slot、keyId）、plain / sealed、打不开时的占位、缓存与重试。 */
class SessionDisplayDecryptorTest {
    private val keyBytes = ByteArray(32) { (it * 7 + 1).toByte() }
    private val grant = DirectoryKeyGrant("dev_1", "dk_2", 2, E2eeFormats.b64url(keyBytes))

    private fun seal(
        fields: JSONObject,
        deviceId: String = "dev_1",
        sessionId: String = "sess_1",
        slot: DisplaySlot = DisplaySlot.Device,
        keyId: String = "dk_2",
        key: ByteArray = keyBytes,
    ) = RemoteDisplayEnvelope(
        mode = RemoteDisplayEnvelope.MODE_SEALED,
        keyId = keyId,
        payload = E2eeFormats.sealDisplay(
            key,
            E2eeFormats.displayEnvelopeAd(deviceId, sessionId, slot, keyId),
            fields.toString().toByteArray(Charsets.UTF_8),
        ),
    )

    private fun decryptor(grantFor: (String) -> DirectoryKeyGrant? = { if (it == "dev_1") grant else null }) =
        SessionDisplayDecryptor(keyFor = grantFor)

    private fun opened(title: String? = null, cwd: String? = null, preview: String? = null) =
        DisplayOpenResult.Opened(DisplayFields(title, cwd, preview))

    @Test
    fun opensASealedEnvelopeBoundToItsDeviceSessionAndSlot() {
        val envelope = seal(JSONObject().put("title", "Fix login").put("cwd", "/work/app").put("preview", "done").put("future", 1))
        assertEquals(opened("Fix login", "/work/app", "done"), decryptor().open("dev_1", "sess_1", DisplaySlot.Device, envelope))
    }

    @Test
    fun theWrongSlotSessionOrDeviceCannotOpenIt() {
        val device = seal(JSONObject().put("title", "native"))
        val user = seal(JSONObject().put("title", "renamed"), slot = DisplaySlot.User)
        val decryptor = decryptor { grant }
        // displayDevice → slot device, displayUser → slot user: swapping them fails authentication.
        assertEquals(DisplayOpenResult.Locked, decryptor.open("dev_1", "sess_1", DisplaySlot.User, device))
        assertEquals(DisplayOpenResult.Locked, decryptor.open("dev_1", "sess_1", DisplaySlot.Device, user))
        assertEquals(opened("renamed"), decryptor.open("dev_1", "sess_1", DisplaySlot.User, user))
        // The Server cannot move an envelope to another session or device.
        assertEquals(DisplayOpenResult.Locked, decryptor.open("dev_1", "sess_2", DisplaySlot.Device, device))
        assertEquals(DisplayOpenResult.Locked, decryptor.open("dev_2", "sess_1", DisplaySlot.Device, device))
    }

    @Test
    fun plainEnvelopesAreReadDirectly() {
        val plain = RemoteDisplayEnvelope("plain", null, JSONObject().put("title", "Visible").put("cwd", "/a").toString())
        assertEquals(opened("Visible", "/a"), decryptor { null }.open("dev_x", "sess_1", DisplaySlot.Device, plain))
        // A malformed plain payload has no fields; it is not an error.
        assertEquals(opened(), decryptor { null }.open("dev_x", "sess_1", DisplaySlot.Device, RemoteDisplayEnvelope("plain", null, "nope")))
    }

    @Test
    fun missingOrOldKeysAndBadCiphertextShowThePlaceholder() {
        val fields = JSONObject().put("title", "secret")
        // Not paired with this device.
        assertEquals(DisplayOpenResult.Locked, decryptor { null }.open("dev_1", "sess_1", DisplaySlot.Device, seal(fields)))
        // Sealed with an older epoch: only the current key is kept.
        val old = seal(fields, keyId = "dk_1", key = ByteArray(32) { 3 })
        assertEquals(DisplayOpenResult.Locked, decryptor().open("dev_1", "sess_1", DisplaySlot.Device, old))
        // keyId missing.
        assertEquals(DisplayOpenResult.Locked, decryptor().open("dev_1", "sess_1", DisplaySlot.Device, seal(fields).copy(keyId = null)))
        // The right keyId but another key (or tampered ciphertext).
        val wrongKey = seal(fields, key = ByteArray(32) { 5 })
        assertEquals(DisplayOpenResult.Locked, decryptor().open("dev_1", "sess_1", DisplaySlot.Device, wrongKey))
        assertEquals(DisplayOpenResult.Locked, decryptor().open("dev_1", "sess_1", DisplaySlot.Device, seal(fields).copy(payload = "AAAA")))
        // A mode this client does not know.
        assertEquals(DisplayOpenResult.Locked, decryptor().open("dev_1", "sess_1", DisplaySlot.Device, seal(fields).copy(mode = "sealed-v2")))
        // Ciphertext that is not a JSON object.
        val notObject = RemoteDisplayEnvelope(
            "sealed", "dk_2",
            E2eeFormats.sealDisplay(keyBytes, E2eeFormats.displayEnvelopeAd("dev_1", "sess_1", DisplaySlot.Device, "dk_2"), "[1]".toByteArray()),
        )
        assertEquals(DisplayOpenResult.Locked, decryptor().open("dev_1", "sess_1", DisplaySlot.Device, notObject))
    }

    @Test
    fun resultsAreCachedUntilTheDirectoryKeyChanges() {
        var lookups = 0
        var current: DirectoryKeyGrant? = null
        var revision = 0L
        val decryptor = SessionDisplayDecryptor(keyFor = { lookups++; current }, revision = { revision })
        val envelope = seal(JSONObject().put("title", "after pairing"))

        assertEquals(DisplayOpenResult.Locked, decryptor.open("dev_1", "sess_1", DisplaySlot.Device, envelope))
        assertEquals(DisplayOpenResult.Locked, decryptor.open("dev_1", "sess_1", DisplaySlot.Device, envelope))
        assertEquals(1, lookups)

        // Pairing (or `e2ee.directory_key`) bumps the revision: the cache is dropped and the row retried.
        current = grant
        revision = 1
        assertEquals(opened("after pairing"), decryptor.open("dev_1", "sess_1", DisplaySlot.Device, envelope))
        assertEquals(opened("after pairing"), decryptor.open("dev_1", "sess_1", DisplaySlot.Device, envelope))
        assertEquals(2, lookups)

        decryptor.invalidate()
        assertEquals(opened("after pairing"), decryptor.open("dev_1", "sess_1", DisplaySlot.Device, envelope))
        assertEquals(3, lookups)
    }

    @Test
    fun trustStoreRevisionMovesOnPairingRotationAndRevocation() {
        val store = ClientTrustStore(InMemoryTrustStorage(), object : SecretSealer {
            override fun seal(plaintext: ByteArray) = plaintext.copyOf()
            override fun open(sealed: ByteArray) = sealed.copyOf()
        })
        val start = store.directoryKeyRevision.value
        store.savePairing("dev_1", ByteArray(32) { 1 }, "2026-11-17T00:00:00Z", grant)
        assertEquals(start + 1, store.directoryKeyRevision.value)
        store.updateDirectoryKey(grant.copy(keyId = "dk_3", epoch = 3))
        assertEquals(start + 2, store.directoryKeyRevision.value)
        // An older epoch does not replace the current key, and does not count as a change.
        store.updateDirectoryKey(grant.copy(keyId = "dk_1", epoch = 1))
        assertEquals(start + 2, store.directoryKeyRevision.value)
        store.forgetPairing("dev_1")
        assertEquals(start + 3, store.directoryKeyRevision.value)
    }
}
