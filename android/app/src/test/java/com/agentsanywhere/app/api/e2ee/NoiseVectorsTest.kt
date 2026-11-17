package com.agentsanywhere.app.api.e2ee

import com.agentsanywhere.app.api.e2ee.noise.NoiseHandshake
import com.agentsanywhere.app.api.e2ee.noise.TransportPair
import com.agentsanywhere.app.api.e2ee.noise.X25519KeyPair
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 跑 contracts/e2ee/1.0/vectors 下三端共用的 Noise 测试向量。 */
class NoiseVectorsTest {
    private val vectorsDir: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .map { File(it, "contracts/e2ee/1.0/vectors") }
        .first { it.isDirectory }

    private fun load(name: String) = JSONObject(File(vectorsDir, name).readText())

    private fun String.hex(): ByteArray = chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

    private fun party(vector: JSONObject, prefix: String): NoiseHandshake {
        fun opt(name: String) = vector.optString("${prefix}_$name").takeIf { it.isNotEmpty() }
        val psks = vector.optJSONArray("${prefix}_psks") ?: JSONArray()
        return NoiseHandshake(
            protocolName = vector.getString("protocol_name"),
            initiator = prefix == "init",
            prologue = (opt("prologue") ?: "").hex(),
            s = opt("static")?.let { X25519KeyPair.fromSecret(it.hex()) },
            e = opt("ephemeral")?.let { X25519KeyPair.fromSecret(it.hex()) },
            rs = opt("remote_static")?.hex(),
            psks = (0 until psks.length()).map { psks.getString(it).hex() },
        )
    }

    private fun run(vector: JSONObject) {
        val name = vector.getString("protocol_name")
        val initiator = party(vector, "init")
        val responder = party(vector, "resp")
        val handshakeCount = initiator.pattern.messages.size
        var transport: Map<String, TransportPair>? = null
        val messages = vector.getJSONArray("messages")
        for (index in 0 until messages.length()) {
            val message = messages.getJSONObject(index)
            val sender = message.optString("sender").ifEmpty {
                if (initiator.pattern.oneWay || index % 2 == 0) "initiator" else "responder"
            }
            val payload = message.getString("payload").hex()
            if (index < handshakeCount) {
                val (tx, rx) = if (sender == "initiator") initiator to responder else responder to initiator
                val ciphertext = tx.writeMessage(payload)
                assertEquals("$name message $index", message.getString("ciphertext"), ciphertext.hex())
                assertEquals(message.getString("payload"), rx.readMessage(ciphertext).hex())
                if (index == handshakeCount - 1) {
                    val pair = mapOf("initiator" to initiator.takeTransport(), "responder" to responder.takeTransport())
                    assertEquals(pair.getValue("initiator").handshakeHash.hex(), pair.getValue("responder").handshakeHash.hex())
                    vector.optString("handshake_hash").takeIf { it.isNotEmpty() }?.let {
                        assertEquals("$name handshake hash", it, pair.getValue("initiator").handshakeHash.hex())
                    }
                    transport = pair
                }
                continue
            }
            val pair = transport!!
            val tx = pair.getValue(sender)
            val rx = pair.getValue(if (sender == "initiator") "responder" else "initiator")
            if (message.optBoolean("rekey_before")) {
                tx.send.rekey()
                rx.receive.rekey()
            }
            val ciphertext = tx.send.encryptWithAd(ByteArray(0), payload)
            assertEquals("$name transport $index", message.getString("ciphertext"), ciphertext.hex())
            assertEquals(message.getString("payload"), rx.receive.decryptWithAd(ByteArray(0), ciphertext).hex())
        }
    }

    /** 返回读失败的消息序号；没有失败返回 null。 */
    private fun runNegative(negative: JSONObject, bases: Map<String, JSONObject>): Int? {
        val vector = JSONObject(bases.getValue(negative.getString("base")).toString())
        negative.optJSONObject("override")?.let { override -> override.keys().forEach { vector.put(it, override.get(it)) } }
        val messages = vector.getJSONArray("messages")
        negative.optJSONObject("tamper")?.let { tamper ->
            val target = messages.getJSONObject(tamper.getInt("message"))
            val raw = target.getString("ciphertext").hex()
            val byte = tamper.getInt("byte")
            raw[byte] = (raw[byte].toInt() xor 0x01).toByte()
            target.put("ciphertext", raw.hex())
        }
        val replay = negative.optJSONObject("replay")?.getInt("message")
        val initiator = party(vector, "init")
        val responder = party(vector, "resp")
        val handshakeCount = vector.getInt("handshake_messages")
        var transport: Map<String, TransportPair>? = null
        for (index in 0 until messages.length()) {
            val message = messages.getJSONObject(index)
            val sender = message.getString("sender")
            val ciphertext = message.getString("ciphertext").hex()
            try {
                if (index < handshakeCount) {
                    val (tx, rx) = if (sender == "initiator") initiator to responder else responder to initiator
                    tx.writeMessage(message.getString("payload").hex())
                    rx.readMessage(ciphertext)
                    if (index == handshakeCount - 1) {
                        transport = mapOf("initiator" to initiator.takeTransport(), "responder" to responder.takeTransport())
                    }
                } else {
                    val pair = transport!!
                    val rx = pair.getValue(if (sender == "initiator") "responder" else "initiator")
                    if (message.optBoolean("rekey_before")) {
                        pair.getValue(sender).send.rekey()
                        rx.receive.rekey()
                    }
                    rx.receive.decryptWithAd(ByteArray(0), ciphertext)
                    if (replay == index) rx.receive.decryptWithAd(ByteArray(0), ciphertext)
                }
            } catch (_: Exception) {
                return index
            }
        }
        return null
    }

    @Test
    fun officialVectors() {
        val vectors = load("noise-official.json").getJSONArray("vectors")
        assertTrue(vectors.length() > 50)
        for (index in 0 until vectors.length()) run(vectors.getJSONObject(index))
    }

    @Test
    fun aaVectors() {
        val document = load("aa-noise.json")
        val vectors = document.getJSONArray("vectors")
        val bases = (0 until vectors.length()).map { vectors.getJSONObject(it) }.associateBy { it.getString("name") }
        bases.values.forEach(::run)
        val negatives = document.getJSONArray("negative")
        assertTrue(negatives.length() >= 5)
        for (index in 0 until negatives.length()) {
            val negative = negatives.getJSONObject(index)
            assertEquals(negative.getString("name"), negative.getInt("fail_at"), runNegative(negative, bases))
        }
    }
}
