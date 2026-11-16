package com.agentsanywhere.app.api.e2ee.noise

/** CipherState（Noise 规范 §5.1）。 */
class CipherState(key: ByteArray? = null) {
    private var key: ByteArray? = null

    /** 下一条消息要用的计数器。 */
    var nonce: ULong = 0u
        private set

    init {
        if (key != null) initializeKey(key)
    }

    fun initializeKey(key: ByteArray) {
        if (key.size != NoiseCrypto.KEYLEN) throw NoiseException("noise: key must be 32 bytes")
        this.key = key.copyOf()
        nonce = 0u
    }

    fun hasKey(): Boolean = key != null

    fun setNonce(value: ULong) {
        if (value == NoiseCrypto.MAX_NONCE) throw NoiseException("noise: nonce out of range")
        nonce = value
    }

    fun encryptWithAd(ad: ByteArray, plaintext: ByteArray): ByteArray {
        val k = key ?: return plaintext.copyOf()
        if (nonce == NoiseCrypto.MAX_NONCE) throw NoiseException("noise: nonce exhausted")
        val out = NoiseCrypto.encrypt(k, nonce, ad, plaintext)
        nonce++
        return out
    }

    fun decryptWithAd(ad: ByteArray, ciphertext: ByteArray): ByteArray {
        val k = key ?: return ciphertext.copyOf()
        if (nonce == NoiseCrypto.MAX_NONCE) throw NoiseException("noise: nonce exhausted")
        if (ciphertext.size < NoiseCrypto.TAGLEN) throw NoiseException("noise: ciphertext shorter than tag")
        // 认证失败时计数器不前进。
        val out = NoiseCrypto.decrypt(k, nonce, ad, ciphertext)
        nonce++
        return out
    }

    /** REKEY：k = ENCRYPT(k, 2^64-1, "", zeros)[0:32]；计数器不变。 */
    fun rekey() {
        val k = key ?: throw NoiseException("noise: rekey without key")
        key = NoiseCrypto.encrypt(k, NoiseCrypto.MAX_NONCE, ByteArray(0), ByteArray(NoiseCrypto.KEYLEN)).copyOf(NoiseCrypto.KEYLEN)
        k.fill(0)
    }

    fun destroy() {
        key?.fill(0)
        key = null
    }
}

/** SymmetricState（Noise 规范 §5.2）。 */
class SymmetricState(protocolName: String) {
    val cipher = CipherState()
    private var ck: ByteArray
    private var h: ByteArray

    init {
        val name = protocolName.toByteArray(Charsets.UTF_8)
        h = if (name.size <= NoiseCrypto.HASHLEN) name.copyOf(NoiseCrypto.HASHLEN) else NoiseCrypto.sha256(name)
        ck = h.copyOf()
    }

    val handshakeHash: ByteArray get() = h.copyOf()

    fun mixKey(ikm: ByteArray) {
        val out = hkdf(ikm, 2)
        ck = out[0]
        cipher.initializeKey(out[1])
    }

    fun mixHash(data: ByteArray) {
        h = NoiseCrypto.sha256(h + data)
    }

    fun mixKeyAndHash(ikm: ByteArray) {
        val out = hkdf(ikm, 3)
        ck = out[0]
        mixHash(out[1])
        cipher.initializeKey(out[2])
    }

    fun encryptAndHash(plaintext: ByteArray): ByteArray {
        val ciphertext = cipher.encryptWithAd(h, plaintext)
        mixHash(ciphertext)
        return ciphertext
    }

    fun decryptAndHash(ciphertext: ByteArray): ByteArray {
        val plaintext = cipher.decryptWithAd(h, ciphertext)
        mixHash(ciphertext)
        return plaintext
    }

    fun split(): Pair<CipherState, CipherState> {
        val out = hkdf(ByteArray(0), 2)
        ck.fill(0)
        cipher.destroy()
        return CipherState(out[0]) to CipherState(out[1])
    }

    private fun hkdf(ikm: ByteArray, outputs: Int): List<ByteArray> {
        val tempKey = NoiseCrypto.hmacSha256(ck, ikm)
        val out1 = NoiseCrypto.hmacSha256(tempKey, byteArrayOf(0x01))
        val out2 = NoiseCrypto.hmacSha256(tempKey, out1 + byteArrayOf(0x02))
        if (outputs == 2) return listOf(out1, out2)
        val out3 = NoiseCrypto.hmacSha256(tempKey, out2 + byteArrayOf(0x03))
        return listOf(out1, out2, out3)
    }
}
