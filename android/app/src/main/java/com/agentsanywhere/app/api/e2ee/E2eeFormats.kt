package com.agentsanywhere.app.api.e2ee

import com.agentsanywhere.app.api.e2ee.noise.NoiseCrypto
import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * e2ee 1.0 的字节格式（contracts/e2ee/1.0/README.md，向量 vectors/aa-formats.json）：
 * 标识、prologue、传输帧（flag + body）、展示信封、分段密文、输入摘要。
 * 移植自 connector-ts/src/channel/formats.ts；原语全部来自 JCA（见 [NoiseCrypto]）。
 */
object E2eeFormats {
    const val VERSION_LABEL = "aa-e2ee/1.0"
    const val NOISE_PAIRING_PROTOCOL = "Noise_XXpsk0_25519_AESGCM_SHA256"
    const val NOISE_RECONNECT_PROTOCOL = "Noise_KK_25519_AESGCM_SHA256"

    const val FRAME_CONTINUE: Byte = 0x00
    const val FRAME_FINAL: Byte = 0x01
    const val FRAME_REKEY: Byte = 0x02

    /** 65535 - 16（tag）- 1（flag）。 */
    const val FRAME_MAX_BODY = NoiseCrypto.MAX_MESSAGE_LEN - NoiseCrypto.TAGLEN - 1
    const val CHANNEL_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
    const val REKEY_INTERVAL_FRAMES = 1L shl 20
    const val REKEY_INTERVAL_MS = 60L * 60L * 1000L
    const val SEALED_SEGMENT_BYTES = 64 * 1024
    private const val GCM_NONCE_BYTES = 12

    private val CHANNEL_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val CLIENT_ID = Regex("^cli_[a-z2-7]{26}$")
    private val random = SecureRandom()

    fun isChannelId(value: String): Boolean = CHANNEL_ID.matches(value)

    fun isClientId(value: String): Boolean = CLIENT_ID.matches(value)

    /** `aa-e2ee/1.0` 与各字段用 NUL 连接后的 UTF-8 字节；字段里不能有 NUL。 */
    fun label(vararg fields: String): ByteArray {
        require(fields.none { '\u0000' in it }) { "binding fields must not contain NUL" }
        return (listOf(VERSION_LABEL) + fields).joinToString("\u0000").toByteArray(Charsets.UTF_8)
    }

    fun clientIdFor(identityPub: ByteArray): String {
        val digest = NoiseCrypto.sha256(label("client-id") + byteArrayOf(0) + identityPub)
        return "cli_" + base32Lower(digest).substring(0, 26)
    }

    /** SHA-256(公钥) 的前 32 个十六进制字符，每 4 个一组。 */
    fun fingerprint(identityPub: ByteArray): String =
        hex(NoiseCrypto.sha256(identityPub)).substring(0, 32).chunked(4).joinToString(" ")

    fun pairingPrologue(deviceId: String, pairingId: String, clientId: String, ch: String): ByteArray =
        label("pair", deviceId, pairingId, clientId, ch)

    fun connectPrologue(deviceId: String, clientId: String, ch: String): ByteArray =
        label("connect", deviceId, clientId, ch)

    fun displayEnvelopeAd(deviceId: String, sessionId: String, slot: DisplaySlot, keyId: String): ByteArray =
        label("display", deviceId, sessionId, slot.wire, keyId)

    fun sealedSegmentAd(purpose: SealedPurpose, objectId: String, index: Int, final: Boolean): ByteArray =
        label(purpose.wire, objectId, index.toString()) + byteArrayOf(0, if (final) 1 else 0)

    // --- base64url / hex ------------------------------------------------------------

    fun b64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun fromB64url(text: String): ByteArray = try {
        Base64.getUrlDecoder().decode(text)
    } catch (error: IllegalArgumentException) {
        throw E2eeFormatException("invalid base64url")
    }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    // --- framing ---------------------------------------------------------------------

    /** 把一条通道消息切成传输明文 `flag ‖ body`，最后一片标 FINAL；空消息也是一片。 */
    fun fragment(message: ByteArray): List<ByteArray> {
        if (message.size > CHANNEL_MAX_MESSAGE_BYTES) throw E2eeFormatException("channel message too large", tooLarge = true)
        val frames = ArrayList<ByteArray>()
        var offset = 0
        do {
            val end = minOf(offset + FRAME_MAX_BODY, message.size)
            val frame = ByteArray(end - offset + 1)
            frame[0] = if (end >= message.size) FRAME_FINAL else FRAME_CONTINUE
            System.arraycopy(message, offset, frame, 1, end - offset)
            frames += frame
            offset = end
        } while (offset < message.size)
        return frames
    }

    // --- display envelopes -------------------------------------------------------------

    /** `base64url(nonce12 ‖ AES-256-GCM(key, nonce, plaintext, ad))`，每次随机 nonce。 */
    fun sealDisplay(directoryKey: ByteArray, ad: ByteArray, plaintext: ByteArray): String =
        sealDisplayWithNonce(directoryKey, ByteArray(GCM_NONCE_BYTES).also(random::nextBytes), ad, plaintext)

    /** 固定 nonce 的版本，只给测试向量用。 */
    fun sealDisplayWithNonce(directoryKey: ByteArray, nonce: ByteArray, ad: ByteArray, plaintext: ByteArray): String =
        b64url(nonce + gcmEncrypt(directoryKey, nonce, ad, plaintext))

    fun openDisplay(directoryKey: ByteArray, ad: ByteArray, payload: String): ByteArray {
        val bytes = fromB64url(payload)
        if (bytes.size < GCM_NONCE_BYTES + NoiseCrypto.TAGLEN) throw E2eeFormatException("sealed payload too short")
        return gcmDecrypt(directoryKey, bytes.copyOfRange(0, GCM_NONCE_BYTES), ad, bytes.copyOfRange(GCM_NONCE_BYTES, bytes.size))
    }

    /** 解开一个展示信封（`DisplayEnvelope.mode == "sealed"`）。 */
    fun openDisplayEnvelope(
        directoryKey: ByteArray,
        deviceId: String,
        sessionId: String,
        slot: DisplaySlot,
        keyId: String,
        payload: String,
    ): String = openDisplay(directoryKey, displayEnvelopeAd(deviceId, sessionId, slot, keyId), payload).toString(Charsets.UTF_8)

    // --- sealed segments (attachments, shares) ------------------------------------------

    fun segmentNonce(index: Int): ByteArray {
        val nonce = ByteArray(GCM_NONCE_BYTES)
        var value = index.toLong()
        for (position in 11 downTo 4) {
            nonce[position] = (value and 0xff).toByte()
            value = value shr 8
        }
        return nonce
    }

    /** 64 KiB 一段，nonce = 段号，AD 里的 final 防截断；空对象是一个空段。 */
    fun sealSegments(purpose: SealedPurpose, objectId: String, key: ByteArray, plaintext: ByteArray): List<ByteArray> {
        val count = maxOf(1, (plaintext.size + SEALED_SEGMENT_BYTES - 1) / SEALED_SEGMENT_BYTES)
        return (0 until count).map { index ->
            val start = index * SEALED_SEGMENT_BYTES
            val chunk = plaintext.copyOfRange(minOf(start, plaintext.size), minOf(start + SEALED_SEGMENT_BYTES, plaintext.size))
            gcmEncrypt(key, segmentNonce(index), sealedSegmentAd(purpose, objectId, index, index == count - 1), chunk)
        }
    }

    /** [sealSegments] 的逆运算；篡改、换序、截断都会失败。 */
    fun openSegments(purpose: SealedPurpose, objectId: String, key: ByteArray, segments: List<ByteArray>): ByteArray {
        if (segments.isEmpty()) throw E2eeFormatException("no segments")
        val out = ByteArrayOutputStream()
        segments.forEachIndexed { index, segment ->
            out.write(gcmDecrypt(key, segmentNonce(index), sealedSegmentAd(purpose, objectId, index, index == segments.lastIndex), segment))
        }
        return out.toByteArray()
    }

    /** 每个上传对象一把随机密钥。 */
    fun newObjectKey(): ByteArray = ByteArray(32).also(random::nextBytes)

    // --- input digest --------------------------------------------------------------------

    fun inputDigestKey(directoryKey: ByteArray): ByteArray = NoiseCrypto.hmacSha256(directoryKey, label("input-digest"))

    /** `hmac-sha256:` + base64url(HMAC(HMAC(列表密钥, label("input-digest")), 请求体原始字节))。 */
    fun inputDigest(directoryKey: ByteArray, body: ByteArray): String =
        "hmac-sha256:" + b64url(NoiseCrypto.hmacSha256(inputDigestKey(directoryKey), body))

    // --- helpers ----------------------------------------------------------------------------

    private fun gcmEncrypt(key: ByteArray, nonce: ByteArray, ad: ByteArray, plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(NoiseCrypto.TAGLEN * 8, nonce))
        cipher.updateAAD(ad)
        return cipher.doFinal(plaintext)
    }

    private fun gcmDecrypt(key: ByteArray, nonce: ByteArray, ad: ByteArray, sealed: ByteArray): ByteArray {
        if (sealed.size < NoiseCrypto.TAGLEN) throw E2eeFormatException("ciphertext shorter than tag")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(NoiseCrypto.TAGLEN * 8, nonce))
        cipher.updateAAD(ad)
        return try {
            cipher.doFinal(sealed)
        } catch (_: AEADBadTagException) {
            throw E2eeFormatException("sealed content failed to decrypt")
        }
    }

    private const val BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

    /** RFC 4648 base32，小写，不补齐。 */
    private fun base32Lower(bytes: ByteArray): String {
        val out = StringBuilder()
        var buffer = 0
        var bits = 0
        for (byte in bytes) {
            buffer = (buffer shl 8) or (byte.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                out.append(BASE32_ALPHABET[(buffer shr (bits - 5)) and 0x1f])
                bits -= 5
            }
        }
        if (bits > 0) out.append(BASE32_ALPHABET[(buffer shl (5 - bits)) and 0x1f])
        return out.toString()
    }
}

enum class DisplaySlot(val wire: String) { Device("device"), User("user") }

enum class SealedPurpose(val wire: String) { Attachment("attachment"), Share("share") }

class E2eeFormatException(message: String, val tooLarge: Boolean = false) : Exception(message)

/** 重组分片；一个 FINAL 帧完成一条消息时返回它。 */
class Reassembler {
    sealed interface Result {
        class Message(val bytes: ByteArray) : Result
        data object Rekey : Result
    }

    private val parts = ByteArrayOutputStream()
    private var pending = false

    fun push(plaintext: ByteArray): Result? {
        if (plaintext.isEmpty()) throw E2eeFormatException("empty transport frame")
        val flag = plaintext[0]
        val bodySize = plaintext.size - 1
        if (flag == E2eeFormats.FRAME_REKEY) {
            if (bodySize != 0 || pending) throw E2eeFormatException("rekey frame inside a message")
            return Result.Rekey
        }
        if (flag != E2eeFormats.FRAME_CONTINUE && flag != E2eeFormats.FRAME_FINAL) {
            throw E2eeFormatException("unknown frame flag $flag")
        }
        if (parts.size() + bodySize > E2eeFormats.CHANNEL_MAX_MESSAGE_BYTES) {
            throw E2eeFormatException("channel message too large", tooLarge = true)
        }
        parts.write(plaintext, 1, bodySize)
        pending = true
        if (flag == E2eeFormats.FRAME_CONTINUE) return null
        val bytes = parts.toByteArray()
        parts.reset()
        pending = false
        return Result.Message(bytes)
    }
}
