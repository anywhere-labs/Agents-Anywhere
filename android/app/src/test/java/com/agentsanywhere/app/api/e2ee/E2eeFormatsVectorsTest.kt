package com.agentsanywhere.app.api.e2ee

import com.agentsanywhere.app.api.e2ee.noise.NoiseCrypto
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/** 逐项跑 contracts/e2ee/1.0/vectors/aa-formats.json。 */
class E2eeFormatsVectorsTest {
    private val vectors: JSONObject = generateSequence(File("").absoluteFile) { it.parentFile }
        .map { File(it, "contracts/e2ee/1.0/vectors/aa-formats.json") }
        .first { it.isFile }
        .let { JSONObject(it.readText()) }

    private fun String.hex(): ByteArray = chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    private fun objects(name: String): List<JSONObject> = vectors.getJSONArray(name).let { array -> (0 until array.length()).map(array::getJSONObject) }

    @Test
    fun identities() {
        val identities = objects("identities")
        assertTrue(identities.isNotEmpty())
        for (identity in identities) {
            val pub = identity.getString("identityPub").hex()
            assertEquals(identity.getString("identityPubB64"), E2eeFormats.b64url(pub))
            assertArrayEquals(pub, E2eeFormats.fromB64url(identity.getString("identityPubB64")))
            assertEquals(identity.getString("clientId"), E2eeFormats.clientIdFor(pub))
            assertTrue(E2eeFormats.isClientId(identity.getString("clientId")))
            assertEquals(identity.getString("fingerprint"), E2eeFormats.fingerprint(pub))
        }
    }

    @Test
    fun prologues() {
        for (prologue in objects("prologues")) {
            val fields = prologue.getJSONArray("fields").let { array -> (0 until array.length()).map(array::getString) }
            val bytes = when (prologue.getString("kind")) {
                "pair" -> E2eeFormats.pairingPrologue(fields[0], fields[1], fields[2], fields[3])
                "connect" -> E2eeFormats.connectPrologue(fields[0], fields[1], fields[2])
                else -> error("unknown prologue kind")
            }
            assertEquals(prologue.getString("bytes"), E2eeFormats.hex(bytes))
        }
    }

    @Test
    fun displayEnvelopes() {
        for (envelope in objects("displayEnvelopes")) {
            val slot = DisplaySlot.entries.first { it.wire == envelope.getString("slot") }
            val key = envelope.getString("directoryKey").hex()
            val ad = E2eeFormats.displayEnvelopeAd(envelope.getString("deviceId"), envelope.getString("sessionId"), slot, envelope.getString("keyId"))
            assertEquals(envelope.getString("ad"), E2eeFormats.hex(ad))
            val plaintext = envelope.getString("plaintext")
            val payload = envelope.getString("payload")
            assertEquals(payload, E2eeFormats.sealDisplayWithNonce(key, envelope.getString("nonce").hex(), ad, plaintext.toByteArray()))
            assertEquals(
                plaintext,
                E2eeFormats.openDisplayEnvelope(key, envelope.getString("deviceId"), envelope.getString("sessionId"), slot, envelope.getString("keyId"), payload),
            )
            // A random nonce still opens; the AD binds the row: another slot or session must not open it.
            assertEquals(plaintext, E2eeFormats.openDisplay(key, ad, E2eeFormats.sealDisplay(key, ad, plaintext.toByteArray())).toString(Charsets.UTF_8))
            val otherSlot = if (slot == DisplaySlot.User) DisplaySlot.Device else DisplaySlot.User
            assertFails { E2eeFormats.openDisplayEnvelope(key, envelope.getString("deviceId"), envelope.getString("sessionId"), otherSlot, envelope.getString("keyId"), payload) }
            assertFails { E2eeFormats.openDisplayEnvelope(key, envelope.getString("deviceId"), "sess_other", slot, envelope.getString("keyId"), payload) }
        }
    }

    @Test
    fun sealedObjects() {
        for (sealed in objects("sealedObjects")) {
            val purpose = SealedPurpose.entries.first { it.wire == sealed.getString("purpose") }
            val objectId = sealed.getString("objectId")
            val key = sealed.getString("key").hex()
            assertEquals(sealed.getString("keyB64"), E2eeFormats.b64url(key))
            val plaintext = ByteArray(sealed.getInt("plaintextLength")) { ((it * 31 + 7) and 0xff).toByte() }
            val segments = E2eeFormats.sealSegments(purpose, objectId, key, plaintext)
            val expected = sealed.getJSONArray("segments").let { array -> (0 until array.length()).map(array::getJSONObject) }
            assertEquals(expected.size, segments.size)
            expected.forEachIndexed { index, segment ->
                val final = segment.getBoolean("final")
                assertEquals(segment.getInt("index"), index)
                assertEquals(index == expected.lastIndex, final)
                assertEquals(segment.getString("nonce"), E2eeFormats.hex(E2eeFormats.segmentNonce(index)))
                assertEquals(segment.getString("ad"), E2eeFormats.hex(E2eeFormats.sealedSegmentAd(purpose, objectId, index, final)))
                assertEquals(segment.getInt("ciphertextLength"), segments[index].size)
                assertEquals(segment.getString("ciphertextSha256"), E2eeFormats.hex(NoiseCrypto.sha256(segments[index])))
                segment.optString("ciphertext").takeIf { it.isNotEmpty() }?.let { assertEquals(it, E2eeFormats.hex(segments[index])) }
            }
            assertArrayEquals(plaintext, E2eeFormats.openSegments(purpose, objectId, key, segments))
            if (segments.size > 1) {
                // Truncation: dropping the final segment makes the new last one fail its final flag.
                assertFails { E2eeFormats.openSegments(purpose, objectId, key, segments.dropLast(1)) }
                assertFails { E2eeFormats.openSegments(purpose, objectId, key, segments.reversed()) }
            }
        }
    }

    @Test
    fun inputDigests() {
        for (digest in objects("inputDigests")) {
            val key = digest.getString("directoryKey").hex()
            assertEquals(digest.getString("digestKey"), E2eeFormats.hex(E2eeFormats.inputDigestKey(key)))
            assertEquals(digest.getString("inputDigest"), E2eeFormats.inputDigest(key, digest.getString("body").toByteArray(Charsets.UTF_8)))
        }
    }

    @Test
    fun framing() {
        for (case in objects("framing")) {
            val length = case.getInt("messageLength")
            val message = ByteArray(length) { (it % 251).toByte() }
            val frames = E2eeFormats.fragment(message)
            val expected = case.getJSONArray("frames").let { array -> (0 until array.length()).map(array::getJSONObject) }
            assertEquals(expected.size, frames.size)
            expected.forEachIndexed { index, frame ->
                assertEquals(frame.getInt("flag"), frames[index][0].toInt())
                assertEquals(frame.getInt("bodyLength"), frames[index].size - 1)
                assertTrue(frames[index].size - 1 <= E2eeFormats.FRAME_MAX_BODY)
            }
            val reassembler = Reassembler()
            frames.dropLast(1).forEach { assertNull(reassembler.push(it)) }
            val result = reassembler.push(frames.last()) as Reassembler.Result.Message
            assertArrayEquals(message, result.bytes)
        }
        assertEquals(Reassembler.Result.Rekey, Reassembler().push(byteArrayOf(E2eeFormats.FRAME_REKEY)))
        assertFails { Reassembler().apply { push(byteArrayOf(E2eeFormats.FRAME_CONTINUE, 1)) }.push(byteArrayOf(E2eeFormats.FRAME_REKEY)) }
        assertFails { Reassembler().push(byteArrayOf(0x03)) }
        assertFails { E2eeFormats.fragment(ByteArray(E2eeFormats.CHANNEL_MAX_MESSAGE_BYTES + 1)) }
    }

    @Test
    fun pairingUri() {
        val vector = vectors.getJSONObject("pairingUri")
        val expected = vector.getJSONObject("payload")
        val payload = parsePairingUri(vector.getString("uri"))
        assertEquals(expected.getInt("v"), payload.v)
        for (field in listOf("deviceId", "deviceIdentityPub", "pairingId", "psk", "serverUrl", "e2eeMode", "expiresAt")) {
            assertEquals(field, expected.getString(field), payload.toJson().getString(field))
        }
        assertTrue(jsonSimilar(JSONObject(vector.getString("json")), payload.toJson()))
        // The device key in the vector belongs to the second identity: its fingerprint is what the UI shows.
        assertEquals(objects("identities")[1].getString("fingerprint"), payload.deviceFingerprint)
        assertFails { parsePairingUri("https://example.com") }
        assertFails { parsePairingUri("aa-pair://not-json") }
        val badKey = JSONObject(vector.getString("json")).put("psk", "short")
        assertFails { parsePairingUri("aa-pair://" + E2eeFormats.b64url(badKey.toString().toByteArray())) }
    }

    private fun assertFails(block: () -> Unit) {
        try {
            block()
        } catch (_: Exception) {
            return
        }
        fail("expected a failure")
    }
}
