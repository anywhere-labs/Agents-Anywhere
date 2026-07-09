package com.agentsanywhere.app.feature.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteTerminalInputBufferTest {
    @Test
    fun buffersOrdinaryInputUntilScheduledFlush() {
        val scheduled = mutableListOf<() -> Unit>()
        val emitted = mutableListOf<String>()
        val buffer = RemoteTerminalInputBuffer(
            scheduleFlush = { _, flush -> scheduled += flush },
            emit = { emitted += it.decodeToString() },
        )

        buffer.send("a".encodeToByteArray())
        buffer.send("b".encodeToByteArray())

        assertTrue(emitted.isEmpty())
        assertEquals(1, scheduled.size)

        scheduled.single().invoke()

        assertEquals(listOf("ab"), emitted)
    }

    @Test
    fun immediateInputFlushesPendingBytesInTheSamePayload() {
        val scheduled = mutableListOf<() -> Unit>()
        val emitted = mutableListOf<String>()
        val buffer = RemoteTerminalInputBuffer(
            scheduleFlush = { _, flush -> scheduled += flush },
            emit = { emitted += it.decodeToString() },
        )

        buffer.send("l".encodeToByteArray())
        buffer.send("s".encodeToByteArray())
        buffer.send("\r".encodeToByteArray())

        assertEquals(listOf("ls\r"), emitted)

        scheduled.single().invoke()

        assertEquals(listOf("ls\r"), emitted)
    }

    @Test
    fun clearPreventsStaleScheduledFlush() {
        val scheduled = mutableListOf<() -> Unit>()
        val emitted = mutableListOf<String>()
        val buffer = RemoteTerminalInputBuffer(
            scheduleFlush = { _, flush -> scheduled += flush },
            emit = { emitted += it.decodeToString() },
        )

        buffer.send("stale".encodeToByteArray())
        buffer.clear()
        scheduled.single().invoke()

        assertTrue(emitted.isEmpty())
    }
}
