// ACP 录制与回放（沿用 v2 connector/tests/fixtures/acp-recordings 的格式：每行 {direction, message}）。
// - recordTo：在一条连接上记下双向消息；
// - ReplayAgent：在内存传输的 Agent 一端按录制顺序回放：客户端发出一条（核对方法名），就把紧随其后的
//   incoming 消息依次推回去。用于在没装 Agent 的机器上测方言与事件翻译。

import { JsonRpcPeer, type JsonRpcMessage, type MessageTransport } from './jsonrpc.js'

export interface RecordingEntry {
  readonly direction: 'outgoing' | 'incoming'
  readonly message: JsonRpcMessage
}

export function parseRecording(text: string): RecordingEntry[] {
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as RecordingEntry)
}

/** 记录一条连接上的所有消息。返回停止记录的函数。 */
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
    // 客户端可能发出录制里没有的通知（例如取消）：跳过不核对。
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

/** 给测试用：回放 Agent 的另一端。 */
export function replayPeer(entries: readonly RecordingEntry[], pair: [MessageTransport, MessageTransport]): { peer: JsonRpcPeer; agent: ReplayAgent } {
  const agent = new ReplayAgent(entries, pair[1])
  return { peer: new JsonRpcPeer(pair[0]), agent }
}
