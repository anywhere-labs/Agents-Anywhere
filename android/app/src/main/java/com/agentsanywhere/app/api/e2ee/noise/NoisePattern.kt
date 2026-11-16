package com.agentsanywhere.app.api.e2ee.noise

/** 握手模式（Noise 规范 §7）。AA 只用 XXpsk0 与 KK；其他基本模式只为跑官方测试向量。 */
enum class Token { E, S, EE, ES, SE, SS, PSK }

data class HandshakePattern(
    val name: String,
    val initiatorPre: List<Token>,
    val responderPre: List<Token>,
    val messages: List<List<Token>>,
    val oneWay: Boolean,
)

object NoisePatterns {
    const val SUITE = "25519_AESGCM_SHA256"

    private val E = Token.E
    private val S = Token.S
    private val EE = Token.EE
    private val ES = Token.ES
    private val SE = Token.SE
    private val SS = Token.SS

    private class Base(val pre: Pair<List<Token>, List<Token>>, val messages: List<List<Token>>)

    private val base = mapOf(
        "N" to Base(listOf<Token>() to listOf(S), listOf(listOf(E, ES))),
        "K" to Base(listOf(S) to listOf(S), listOf(listOf(E, ES, SS))),
        "X" to Base(listOf<Token>() to listOf(S), listOf(listOf(E, ES, S, SS))),
        "NN" to Base(listOf<Token>() to listOf(), listOf(listOf(E), listOf(E, EE))),
        "NK" to Base(listOf<Token>() to listOf(S), listOf(listOf(E, ES), listOf(E, EE))),
        "NX" to Base(listOf<Token>() to listOf(), listOf(listOf(E), listOf(E, EE, S, ES))),
        "XN" to Base(listOf<Token>() to listOf(), listOf(listOf(E), listOf(E, EE), listOf(S, SE))),
        "XK" to Base(listOf<Token>() to listOf(S), listOf(listOf(E, ES), listOf(E, EE), listOf(S, SE))),
        "XX" to Base(listOf<Token>() to listOf(), listOf(listOf(E), listOf(E, EE, S, ES), listOf(S, SE))),
        "KN" to Base(listOf(S) to listOf(), listOf(listOf(E), listOf(E, EE, SE))),
        "KK" to Base(listOf(S) to listOf(S), listOf(listOf(E, ES, SS), listOf(E, EE, SE))),
        "KX" to Base(listOf(S) to listOf(), listOf(listOf(E), listOf(E, EE, SE, S, ES))),
        "IN" to Base(listOf<Token>() to listOf(), listOf(listOf(E, S), listOf(E, EE, SE))),
        "IK" to Base(listOf<Token>() to listOf(S), listOf(listOf(E, ES, S, SS), listOf(E, EE, SE))),
        "IX" to Base(listOf<Token>() to listOf(), listOf(listOf(E, S), listOf(E, EE, SE, S, ES))),
    )

    private val patternRegex = Regex("^([NKXI]{1,2})((?:psk\\d)(?:\\+psk\\d)*)?$")

    fun parsePattern(name: String): HandshakePattern {
        val match = patternRegex.matchEntire(name) ?: throw NoiseException("noise: unsupported handshake pattern $name")
        val baseName = match.groupValues[1]
        val spec = base[baseName] ?: throw NoiseException("noise: unsupported handshake pattern $name")
        val messages = spec.messages.map { it.toMutableList() }
        val modifiers = match.groupValues[2].takeIf { it.isNotEmpty() }?.split('+') ?: emptyList()
        for (modifier in modifiers) {
            val index = modifier.removePrefix("psk").toInt()
            when {
                index == 0 -> messages[0].add(0, Token.PSK)
                index <= messages.size -> messages[index - 1].add(Token.PSK)
                else -> throw NoiseException("noise: $modifier is out of range for $baseName")
            }
        }
        return HandshakePattern(name, spec.pre.first, spec.pre.second, messages, baseName.length == 1)
    }

    /** 只接受 `Noise_<pattern>_25519_AESGCM_SHA256`。 */
    fun parseProtocolName(full: String): HandshakePattern {
        val prefix = "Noise_"
        val suffix = "_$SUITE"
        if (!full.startsWith(prefix) || !full.endsWith(suffix)) {
            throw NoiseException("noise: unsupported protocol $full; only $SUITE is implemented")
        }
        return parsePattern(full.substring(prefix.length, full.length - suffix.length))
    }
}
