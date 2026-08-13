package com.agentsanywhere.app.feature.realtime

import kotlin.math.min
import kotlin.random.Random

internal fun reconnectDelayMillis(
    attempt: Int,
    randomUnit: Double = Random.nextDouble(),
): Long {
    val exponent = min(attempt.coerceAtLeast(0), 5)
    val base = min(1_000L shl exponent, 30_000L)
    val jitter = (base * 0.25 * randomUnit.coerceIn(0.0, 1.0)).toLong()
    return min(base + jitter, 30_000L)
}
