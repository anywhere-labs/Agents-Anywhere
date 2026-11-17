package com.agentsanywhere.app.api.e2ee.noise

/** 握手结束后传输用的两个 CipherState。 */
class TransportPair(
    val send: CipherState,
    val receive: CipherState,
    val handshakeHash: ByteArray,
    /** 握手里认证过的对端身份公钥。 */
    val remoteStatic: ByteArray?,
)

/** HandshakeState（Noise 规范 §5.3）。授权判断在上层（Client Trust）。 */
class NoiseHandshake(
    protocolName: String,
    val initiator: Boolean,
    prologue: ByteArray = ByteArray(0),
    private val s: NoiseKeyPair? = null,
    /** 只用于测试向量：固定的临时密钥。 */
    private var e: NoiseKeyPair? = null,
    rs: ByteArray? = null,
    re: ByteArray? = null,
    psks: List<ByteArray> = emptyList(),
) {
    val pattern: HandshakePattern = NoisePatterns.parseProtocolName(protocolName)
    private val symmetric = SymmetricState(protocolName)
    private var rs: ByteArray? = rs?.copyOf()
    private var re: ByteArray? = re?.copyOf()
    private val psks = ArrayDeque(psks.map { it.copyOf() })
    private val pskMode = pattern.messages.any { Token.PSK in it }
    private var index = 0
    private var failed = false
    private var result: TransportPair? = null

    init {
        val pskCount = pattern.messages.sumOf { tokens -> tokens.count { it == Token.PSK } }
        if (psks.size != pskCount) throw NoiseException("noise: ${pattern.name} needs $pskCount psk(s), got ${psks.size}")
        if (psks.any { it.size != 32 }) throw NoiseException("noise: psk must be 32 bytes")
        listOfNotNull(rs, re).forEach { if (it.size != NoiseCrypto.DHLEN) throw NoiseException("noise: public key must be 32 bytes") }
        symmetric.mixHash(prologue)
        mixPreMessage(pattern.initiatorPre, local = initiator)
        mixPreMessage(pattern.responderPre, local = !initiator)
    }

    val isComplete: Boolean get() = index >= pattern.messages.size
    val isMyTurn: Boolean get() = index % 2 == (if (initiator) 0 else 1)
    val handshakeHash: ByteArray get() = symmetric.handshakeHash
    val remoteStatic: ByteArray? get() = rs?.copyOf()

    /** 握手结束后取得传输用的 CipherState；只能取一次。 */
    fun takeTransport(): TransportPair {
        val out = result ?: throw NoiseException("noise: handshake not complete")
        result = null
        return out
    }

    fun writeMessage(payload: ByteArray = ByteArray(0)): ByteArray {
        val tokens = nextTokens(writing = true)
        return guarded {
            val out = java.io.ByteArrayOutputStream()
            for (token in tokens) {
                when (token) {
                    Token.E -> {
                        val ephemeral = e ?: NoiseCrypto.generateKeyPair().also { e = it }
                        out.write(ephemeral.publicKey)
                        symmetric.mixHash(ephemeral.publicKey)
                        if (pskMode) symmetric.mixKey(ephemeral.publicKey)
                    }
                    Token.S -> out.write(symmetric.encryptAndHash(requireS().publicKey))
                    Token.PSK -> symmetric.mixKeyAndHash(psks.removeFirst())
                    else -> symmetric.mixKey(dhFor(token))
                }
            }
            out.write(symmetric.encryptAndHash(payload))
            val message = out.toByteArray()
            if (message.size > NoiseCrypto.MAX_MESSAGE_LEN) throw NoiseException("noise: handshake message too long")
            advance()
            message
        }
    }

    fun readMessage(message: ByteArray): ByteArray {
        val tokens = nextTokens(writing = false)
        return guarded {
            if (message.size > NoiseCrypto.MAX_MESSAGE_LEN) throw NoiseException("noise: handshake message too long")
            var offset = 0
            fun take(length: Int): ByteArray {
                if (offset + length > message.size) throw NoiseException("noise: handshake message truncated")
                return message.copyOfRange(offset, offset + length).also { offset += length }
            }
            for (token in tokens) {
                when (token) {
                    Token.E -> {
                        if (re != null) throw NoiseException("noise: remote ephemeral already set")
                        val remote = take(NoiseCrypto.DHLEN)
                        re = remote
                        symmetric.mixHash(remote)
                        if (pskMode) symmetric.mixKey(remote)
                    }
                    Token.S -> {
                        if (rs != null) throw NoiseException("noise: remote static already set")
                        val length = if (symmetric.cipher.hasKey()) NoiseCrypto.DHLEN + NoiseCrypto.TAGLEN else NoiseCrypto.DHLEN
                        rs = symmetric.decryptAndHash(take(length))
                    }
                    Token.PSK -> symmetric.mixKeyAndHash(psks.removeFirst())
                    else -> symmetric.mixKey(dhFor(token))
                }
            }
            val payload = symmetric.decryptAndHash(message.copyOfRange(offset, message.size))
            advance()
            payload
        }
    }

    private inline fun <T> guarded(block: () -> T): T = try {
        block()
    } catch (error: Exception) {
        failed = true
        throw error
    }

    private fun nextTokens(writing: Boolean): List<Token> {
        if (failed) throw NoiseException("noise: handshake already failed")
        if (index >= pattern.messages.size) throw NoiseException("noise: handshake already complete")
        if (writing != isMyTurn) throw NoiseException(if (writing) "noise: not our turn to write" else "noise: not our turn to read")
        return pattern.messages[index]
    }

    private fun advance() {
        index++
        if (index < pattern.messages.size) return
        val hash = symmetric.handshakeHash
        val (c1, c2) = symmetric.split()
        result = TransportPair(
            send = if (initiator) c1 else c2,
            receive = if (initiator) c2 else c1,
            handshakeHash = hash,
            remoteStatic = rs?.copyOf(),
        )
    }

    private fun mixPreMessage(tokens: List<Token>, local: Boolean) {
        for (token in tokens) {
            val key = when (token) {
                Token.S -> if (local) requireS().publicKey else rs
                Token.E -> if (local) e?.publicKey else re
                else -> throw NoiseException("noise: unexpected pre-message token $token")
            } ?: throw NoiseException("noise: pre-message needs a key for $token")
            symmetric.mixHash(key)
        }
    }

    private fun dhFor(token: Token): ByteArray {
        val (local, remote) = when (token) {
            Token.EE -> e to re
            Token.SS -> s to rs
            Token.ES -> if (initiator) e to rs else s to re
            Token.SE -> if (initiator) s to re else e to rs
            else -> throw NoiseException("noise: not a DH token: $token")
        }
        if (local == null || remote == null) throw NoiseException("noise: missing key for $token")
        val shared = local.dh(remote)
        // 低阶点得到全零共享密钥：三端一律拒绝。
        if (shared.size != NoiseCrypto.DHLEN || shared.all { it == 0.toByte() }) throw NoiseException("noise: invalid DH result")
        return shared
    }

    private fun requireS(): NoiseKeyPair = s ?: throw NoiseException("noise: local static key required")
}
