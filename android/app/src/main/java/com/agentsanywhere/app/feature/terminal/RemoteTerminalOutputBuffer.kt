package com.agentsanywhere.app.feature.terminal

internal class RemoteTerminalOutputBuffer(
    private val maxDrainBytes: Int = DEFAULT_MAX_DRAIN_BYTES,
) {
    private val lock = Any()
    private val chunks = ArrayDeque<PendingChunk>()
    private var pendingBytes = 0
    private var pendingReset = false
    private var generation = 0L
    private var drainScheduled = false

    fun enqueue(data: ByteArray, resetBeforeAppend: Boolean = false): ScheduleDecision {
        if (data.isEmpty() && !resetBeforeAppend) {
            return ScheduleDecision(generation = currentGeneration(), shouldSchedule = false)
        }
        synchronized(lock) {
            if (resetBeforeAppend) {
                chunks.clear()
                pendingBytes = 0
                pendingReset = true
            }
            if (data.isNotEmpty()) {
                chunks.addLast(PendingChunk(data))
                pendingBytes += data.size
            }
            val shouldSchedule = !drainScheduled
            if (shouldSchedule) {
                drainScheduled = true
            }
            return ScheduleDecision(generation = generation, shouldSchedule = shouldSchedule)
        }
    }

    fun clear(): Long {
        synchronized(lock) {
            chunks.clear()
            pendingBytes = 0
            pendingReset = false
            drainScheduled = false
            generation += 1
            return generation
        }
    }

    fun currentGeneration(): Long {
        synchronized(lock) {
            return generation
        }
    }

    fun isCurrentGeneration(expectedGeneration: Long): Boolean {
        synchronized(lock) {
            return generation == expectedGeneration
        }
    }

    fun drain(generation: Long): DrainBatch? {
        synchronized(lock) {
            if (generation != this.generation) return null
            if (!pendingReset && pendingBytes == 0) return null

            val resetBeforeAppend = pendingReset
            pendingReset = false
            val bytesToRead = minOf(maxDrainBytes, pendingBytes)
            val output = ByteArray(bytesToRead)
            var outputOffset = 0

            while (outputOffset < bytesToRead && chunks.isNotEmpty()) {
                val chunk = chunks.first()
                val bytesToCopy = minOf(bytesToRead - outputOffset, chunk.remaining)
                chunk.data.copyInto(
                    destination = output,
                    destinationOffset = outputOffset,
                    startIndex = chunk.offset,
                    endIndex = chunk.offset + bytesToCopy,
                )
                chunk.offset += bytesToCopy
                outputOffset += bytesToCopy
                pendingBytes -= bytesToCopy
                if (chunk.remaining == 0) {
                    chunks.removeFirst()
                }
            }

            return DrainBatch(
                generation = generation,
                resetBeforeAppend = resetBeforeAppend,
                data = output,
            )
        }
    }

    fun finishDrain(generation: Long): ScheduleDecision {
        synchronized(lock) {
            if (generation != this.generation) {
                return ScheduleDecision(generation = this.generation, shouldSchedule = false)
            }
            val hasMore = pendingReset || pendingBytes > 0
            drainScheduled = hasMore
            return ScheduleDecision(generation = generation, shouldSchedule = hasMore)
        }
    }

    data class ScheduleDecision(
        val generation: Long,
        val shouldSchedule: Boolean,
    )

    data class DrainBatch(
        val generation: Long,
        val resetBeforeAppend: Boolean,
        val data: ByteArray,
    ) {
        val hasData: Boolean
            get() = data.isNotEmpty()
    }

    private data class PendingChunk(
        val data: ByteArray,
        var offset: Int = 0,
    ) {
        val remaining: Int
            get() = data.size - offset
    }

    private companion object {
        private const val DEFAULT_MAX_DRAIN_BYTES = 64 * 1024
    }
}
