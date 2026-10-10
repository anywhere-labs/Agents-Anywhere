/**
 * Terminal output coalescer.
 *
 * Port of `feature/terminal/RemoteTerminalOutputBuffer.kt`.
 *
 * Output frames arrive far faster than a screen can be repainted, so bytes are
 * appended to a queue and drained in 64 KiB batches on a 16 ms timer. The
 * `generation` counter is what makes a pending drain safe: `clear()` bumps it,
 * and a drain that wakes up with a stale generation does nothing, so a cleared
 * screen can never be repainted by output that was already in flight.
 *
 * A `replay` frame asks for `resetBeforeAppend`, which drops everything queued
 * and marks the next batch as a reset — the point of a replay is that the
 * server's copy of the screen replaces the local one.
 */

const DEFAULT_MAX_DRAIN_BYTES: number = 64 * 1024;

/** Whether the caller should schedule a drain, and for which generation. */
export class ScheduleDecision {
  generation: number = 0;
  shouldSchedule: boolean = false;

  constructor(generation: number, shouldSchedule: boolean) {
    this.generation = generation;
    this.shouldSchedule = shouldSchedule;
  }
}

/** One drained batch of output. */
export class DrainBatch {
  generation: number = 0;
  resetBeforeAppend: boolean = false;
  data: Uint8Array = new Uint8Array(0);

  constructor(generation: number, resetBeforeAppend: boolean, data: Uint8Array) {
    this.generation = generation;
    this.resetBeforeAppend = resetBeforeAppend;
    this.data = data;
  }

  hasData(): boolean {
    return this.data.length > 0;
  }
}

/** A queued chunk plus how much of it has already been handed out. */
class PendingChunk {
  data: Uint8Array;
  offset: number = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  remaining(): number {
    return this.data.length - this.offset;
  }
}

export class RemoteTerminalOutputBuffer {
  private readonly maxDrainBytes: number;
  private chunks: PendingChunk[] = [];
  private pendingBytes: number = 0;
  private pendingReset: boolean = false;
  private generation: number = 0;
  private drainScheduled: boolean = false;

  constructor(maxDrainBytes: number = DEFAULT_MAX_DRAIN_BYTES) {
    this.maxDrainBytes = maxDrainBytes;
  }

  enqueue(data: Uint8Array, resetBeforeAppend: boolean = false): ScheduleDecision {
    if (data.length === 0 && !resetBeforeAppend) {
      return new ScheduleDecision(this.generation, false);
    }
    if (resetBeforeAppend) {
      this.chunks = [];
      this.pendingBytes = 0;
      this.pendingReset = true;
    }
    if (data.length > 0) {
      this.chunks.push(new PendingChunk(data));
      this.pendingBytes += data.length;
    }
    const shouldSchedule: boolean = !this.drainScheduled;
    if (shouldSchedule) {
      this.drainScheduled = true;
    }
    return new ScheduleDecision(this.generation, shouldSchedule);
  }

  /** Drops everything queued and invalidates in-flight drains. */
  clear(): number {
    this.chunks = [];
    this.pendingBytes = 0;
    this.pendingReset = false;
    this.drainScheduled = false;
    this.generation += 1;
    return this.generation;
  }

  currentGeneration(): number {
    return this.generation;
  }

  isCurrentGeneration(expectedGeneration: number): boolean {
    return this.generation === expectedGeneration;
  }

  /** The next batch, or `null` when this generation has nothing left to give. */
  drain(generation: number): DrainBatch | null {
    if (generation !== this.generation) {
      return null;
    }
    if (!this.pendingReset && this.pendingBytes === 0) {
      return null;
    }
    const resetBeforeAppend: boolean = this.pendingReset;
    this.pendingReset = false;
    const bytesToRead: number = Math.min(this.maxDrainBytes, this.pendingBytes);
    const output: Uint8Array = new Uint8Array(bytesToRead);
    let outputOffset: number = 0;

    while (outputOffset < bytesToRead && this.chunks.length > 0) {
      const chunk: PendingChunk = this.chunks[0];
      const bytesToCopy: number = Math.min(bytesToRead - outputOffset, chunk.remaining());
      output.set(
        chunk.data.subarray(chunk.offset, chunk.offset + bytesToCopy),
        outputOffset,
      );
      chunk.offset += bytesToCopy;
      outputOffset += bytesToCopy;
      this.pendingBytes -= bytesToCopy;
      if (chunk.remaining() === 0) {
        this.chunks.shift();
      }
    }

    return new DrainBatch(generation, resetBeforeAppend, output);
  }

  /** Reports whether another batch is waiting, and re-arms the queue if so. */
  finishDrain(generation: number): ScheduleDecision {
    if (generation !== this.generation) {
      return new ScheduleDecision(this.generation, false);
    }
    const hasMore: boolean = this.pendingReset || this.pendingBytes > 0;
    this.drainScheduled = hasMore;
    return new ScheduleDecision(generation, hasMore);
  }
}
