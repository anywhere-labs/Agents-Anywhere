package dev.agentsanywhere.v3poc.model

import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.Serializable

internal class MobileConnectionRejected : Exception()

internal class MobileScanProof {
    private fun encode(value: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(value)
    val verifier = encode(ByteArray(32).also(SecureRandom()::nextBytes))
    val challenge = encode(MessageDigest.getInstance("SHA-256").digest(verifier.encodeToByteArray()))
}

@Serializable
internal class MobileConnectionCode(
    val type: String, val version: Int, val webUrl: String, val userId: String,
    val loginToken: String, val expiresAt: String, val encryptedPairing: String? = null,
) {
    fun openInvitation(key: String?): String? {
        val ciphertext = encryptedPairing ?: return null
        val decoder = Base64.getUrlDecoder()
        val sealed = decoder.decode(ciphertext)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(decoder.decode(checkNotNull(key)), "AES"),
            GCMParameterSpec(128, sealed, 0, 12))
        cipher.updateAAD(loginToken.encodeToByteArray())
        return cipher.doFinal(sealed, 12, sealed.size - 12).decodeToString()
    }

    companion object {
        fun parse(raw: String): MobileConnectionCode {
            val code = try { AAJson.decodeFromString(serializer(), raw) }
            catch (_: IllegalArgumentException) { throw DeviceGrantUnavailable() }
            if (code.type != "agents-anywhere.mobile-login" || code.version != (if (code.encryptedPairing == null) 1 else 2) ||
                code.userId.isBlank() || code.loginToken.isBlank()) throw DeviceGrantUnavailable()
            if (!Instant.parse(code.expiresAt).isAfter(Instant.now())) throw PairingInvitationExpired()
            return code
        }
    }
}
