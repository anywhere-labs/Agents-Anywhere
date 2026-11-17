// ACP recording and replay (the format of the `acp-recordings` test fixtures: one {direction, message} per line).
// - recordTo: records the messages in both directions on a connection;
// - ReplayAgent: replays in recorded order on the Agent end of an in-memory transport: each time the client sends a
//   message (its method name is checked), the incoming messages right after it are pushed back in turn. Used to
//   test dialects and event translation on machines without the Agent installed.

import { JsonRpcPeer, type JsonRpcMessage, type MessageTransport } from './jsonrpc.js'

export interface RecordingEntry {
  readonly direction: 'outgoing' | 'incoming'
  readonly message: JsonRpcMessage
}

export function parseRecording(text: string): RecordingEntry[] {
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as RecordingEntry)
}

/** Records every message on a connection. Returns a function that stops recording. */
export function recordTo(peer: JsonRpcPeer, sink: (entry: RecordingEntry) => void): () => void {
  return peer.tap((direction, message) => sink({ direction, message }))
}

function describe(message: JsonRpcMessage): string {
  if ('method' in message) return `${'id' in message ? 'request' : 'notification'} ${message.method}`
  return `response ${String((message as { id?: unknown }).id)}`
}

export class ReplayAgent {
  private cursor = 0
  readonly mismatches: string[] = []

  constructor(private readonly entries: readonly RecordingEntry[], private readonly transport: MessageTransport) {
    transport.start(message => this.onClientMessage(message), () => undefined)
    queueMicrotask(() => this.flushIncoming())
  }

  get done(): boolean {
    return this.cursor >= this.entries.length
  }

  private onClientMessage(message: JsonRpcMessage): void {
    // The client may send notifications missing from the recording (e.g. cancel): skip them without checking.
    const expected = this.entries[this.cursor]
    if (!expected || expected.direction !== 'outgoing') {
      if ('method' in message && !('id' in message)) return
      this.mismatches.push(`unexpected ${describe(message)} at ${this.cursor}`)
      return
    }
    if (describe(expected.message).split(' ')[0] !== describe(message).split(' ')[0]
      || ('method' in expected.message && 'method' in message && expected.message.method !== message.method)) {
      this.mismatches.push(`expected ${describe(expected.message)}, got ${describe(message)} at ${this.cursor}`)
    }
    this.cursor += 1
    this.flushIncoming()
  }

  private flushIncoming(): void {
    while (this.entries[this.cursor]?.direction === 'incoming') {
      const entry = this.entries[this.cursor]!
      this.cursor += 1
      this.transport.send(entry.message)
    }
  }
}

/** For tests: the other end of the replay Agent. */
export function replayPeer(entries: readonly RecordingEntry[], pair: [MessageTransport, MessageTransport]): { peer: JsonRpcPeer; agent: ReplayAgent } {
  const agent = new ReplayAgent(entries, pair[1])
  return { peer: new JsonRpcPeer(pair[0]), agent }
}
