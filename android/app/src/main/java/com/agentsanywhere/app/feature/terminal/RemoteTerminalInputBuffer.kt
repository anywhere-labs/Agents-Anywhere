package com.agentsanywhere.app.feature.terminal

import java.io.ByteArrayOutputStream

internal class RemoteTerminalInputBuffer(
    private val flushDelayMs: Long = DEFAULT_FLUSH_DELAY_MS,
    private val maxBufferedBytes: Int = DEFAULT_MAX_BUFFERED_BYTES,
    private val scheduleFlush: (Long, () -> Unit) -> Unit,
    private val emit: (ByteArray) -> Unit,
) {
    private val lock = Any()
    private val buffer = ByteArrayOutputStream()
    private var flushScheduled = false
    private var generation = 0L

    fun send(bytes: ByteArray, immediate: Boolean = shouldFlushImmediately(bytes)) {
        if (bytes.isEmpty()) return
        if (immediate) {
            val pending = drain()
            emit(if (pending == null) bytes else pending + bytes)
            return
        }

        var flushNow = false
        var scheduledGeneration: Long? = null
        synchronized(lock) {
            buffer.write(bytes, 0, bytes.size)
            if (buffer.size() >= maxBufferedBytes) {
                flushNow = true
            } else if (!flushScheduled) {
                flushScheduled = true
                generation += 1
                scheduledGeneration = generation
            }
        }

        if (flushNow) {
            flush()
        }
        scheduledGeneration?.let { expectedGeneration ->
            scheduleFlush(flushDelayMs) { flush(expectedGeneration) }
        }
    }

    fun flush() {
        drain()?.let(emit)
    }

    fun drainBufferedBytes(): ByteArray? = drain()

    fun clear() {
        synchronized(lock) {
            buffer.reset()
            flushScheduled = false
            generation += 1
        }
    }

    private fun flush(expectedGeneration: Long) {
        drain(expectedGeneration)?.let(emit)
    }

    private fun drain(expectedGeneration: Long? = null): ByteArray? {
        synchronized(lock) {
            if (expectedGeneration != null && expectedGeneration != generation) return null
            if (buffer.size() == 0) {
                if (expectedGeneration == null || expectedGeneration == generation) {
                    flushScheduled = false
                }
                return null
            }
            val bytes = buffer.toByteArray()
            buffer.reset()
            flushScheduled = false
            return bytes
        }
    }

    companion object {
        const val DEFAULT_FLUSH_DELAY_MS = 12L
        private const val DEFAULT_MAX_BUFFERED_BYTES = 4096

        fun shouldFlushImmediately(bytes: ByteArray): Boolean {
            return bytes.any { byte ->
                val value = byte.toInt() and 0xFF
                value < 0x20 || value == 0x7F
            }
        }
    }
}
