package com.agentsanywhere.app.api

import java.math.BigInteger

private data class UpdateVersion(val release: List<BigInteger>, val pre: List<String>)

private fun parseUpdateVersion(value: String): UpdateVersion? {
    if (value.length > 128) return null
    val match = Regex("""^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)|((?:a|b|rc|dev)\d+))?(?:\+[0-9A-Za-z.-]+)?$""").matchEntire(value.trim()) ?: return null
    val suffix = match.groupValues[2].ifEmpty {
        match.groupValues[3].replace(Regex("""(\D+)(\d+)$"""), "$1.$2")
    }
    return UpdateVersion(match.groupValues[1].split('.').map(::BigInteger), suffix.takeIf(String::isNotEmpty)?.split('.') ?: emptyList())
}

/** Compare release names, including the Server's four numeric segments. */
fun compareUpdateVersions(left: String, right: String): Int? {
    val a = parseUpdateVersion(left) ?: return null
    val b = parseUpdateVersion(right) ?: return null
    for (index in 0 until maxOf(a.release.size, b.release.size)) {
        val compared = (a.release.getOrNull(index) ?: BigInteger.ZERO).compareTo(b.release.getOrNull(index) ?: BigInteger.ZERO)
        if (compared != 0) return compared
    }
    if (a.pre.isEmpty() || b.pre.isEmpty()) return if (a.pre.isNotEmpty()) -1 else if (b.pre.isNotEmpty()) 1 else 0
    for (index in 0 until maxOf(a.pre.size, b.pre.size)) {
        val x = a.pre.getOrNull(index) ?: return -1
        val y = b.pre.getOrNull(index) ?: return 1
        if (x == y) continue
        val xn = x.all(Char::isDigit)
        val yn = y.all(Char::isDigit)
        val compared = when {
            xn && yn -> BigInteger(x).compareTo(BigInteger(y))
            xn != yn -> if (xn) -1 else 1
            else -> x.compareTo(y)
        }
        if (compared != 0) return compared
    }
    return 0
}
