package com.agentsanywhere.app.api.e2ee.noise

import com.southernstorm.noise.protocol.DHState
import com.southernstorm.noise.protocol.Noise
import java.security.MessageDigest
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Noise 套件 25519_AESGCM_SHA256 的原语（S8 结论，见 contracts/e2ee/1.0/README.md）。
 *
 * 不在本仓库实现原语：AES-256-GCM、SHA-256、HMAC-SHA256 用 JCA（Android 上是 Conscrypt/BoringSSL）；
 * X25519 用 Signal 维护的 noise-java（Android 26 没有平台 X25519，API 33 起才有 XDH）。
 */
object NoiseCrypto {
    const val DHLEN = 32
    const val HASHLEN = 32
    const val KEYLEN = 32
    const val TAGLEN = 16
    const val MAX_MESSAGE_LEN = 65535

    internal fun newDh(): DHState = Noise.createDH("25519")

    /** 2^64 - 1，保留给 rekey。 */
    val MAX_NONCE: ULong = ULong.MAX_VALUE

    fun generateKeyPair(): X25519KeyPair {
        val state = NoiseCrypto.newDh()
        state.generateKeyPair()
        val secret = ByteArray(DHLEN)
        state.getPrivateKey(secret, 0)
        state.destroy()
        return X25519KeyPair.fromSecret(secret)
    }

    fun encrypt(key: ByteArray, nonce: ULong, ad: ByteArray, plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAGLEN * 8, nonceBytes(nonce)))
        cipher.updateAAD(ad)
        return cipher.doFinal(plaintext)
    }

    fun decrypt(key: ByteArray, nonce: ULong, ad: ByteArray, ciphertext: ByteArray): ByteArray {
        if (ciphertext.size < TAGLEN) throw NoiseDecryptException()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAGLEN * 8, nonceBytes(nonce)))
        cipher.updateAAD(ad)
        return try {
            cipher.doFinal(ciphertext)
        } catch (_: AEADBadTagException) {
            throw NoiseDecryptException()
        }
    }

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /** AESGCM 的 nonce：4 字节 0 + 8 字节大端计数器（Noise 规范 §12.4）。 */
    private fun nonceBytes(n: ULong): ByteArray {
        val out = ByteArray(12)
        var value = n
        for (index in 11 downTo 4) {
            out[index] = (value and 0xFFu).toByte()
            value = value shr 8
        }
        return out
    }
}

/** 一个 X25519 密钥对。 */
interface NoiseKeyPair {
    val publicKey: ByteArray
    fun dh(remotePublicKey: ByteArray): ByteArray
}

class X25519KeyPair private constructor(private val secret: ByteArray, override val publicKey: ByteArray) : NoiseKeyPair {
    /** 原始私钥的副本（交给 Keystore 封存后应清零）。 */
    fun secretKey(): ByteArray = secret.copyOf()

    override fun dh(remotePublicKey: ByteArray): ByteArray {
        if (remotePublicKey.size != NoiseCrypto.DHLEN) throw NoiseException("noise: public key must be 32 bytes")
        val local = NoiseCrypto.newDh()
        val remote = NoiseCrypto.newDh()
        try {
            local.setPrivateKey(secret, 0)
            remote.setPublicKey(remotePublicKey, 0)
            val shared = ByteArray(NoiseCrypto.DHLEN)
            local.calculate(shared, 0, remote)
            return shared
        } finally {
            local.destroy()
            remote.destroy()
        }
    }

    companion object {
        fun fromSecret(secret: ByteArray): X25519KeyPair {
            if (secret.size != NoiseCrypto.DHLEN) throw NoiseException("noise: private key must be 32 bytes")
            val state = NoiseCrypto.newDh()
            state.setPrivateKey(secret, 0)
            val publicKey = ByteArray(NoiseCrypto.DHLEN)
            state.getPublicKey(publicKey, 0)
            state.destroy()
            return X25519KeyPair(secret.copyOf(), publicKey)
        }
    }
}

open class NoiseException(message: String) : Exception(message)

/** 认证标签不符：密文被篡改、密钥不对，或 psk 不一致。 */
class NoiseDecryptException : NoiseException("noise: decryption failed")
