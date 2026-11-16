// A local Anthropic Messages-compatible endpoint for DSH tests. DSH reads
// DEEPSEEK_BASE_URL / DEEPSEEK_API_KEY from its launching environment, so pointing
// `dsh --profile acp` here replaces the paid model with a scripted one.
import { createServer, type Server } from 'node:http'

export interface MockTurn {
  /** Text the assistant streams back, in small deltas. */
  text: string
}

export interface MockMessagesLlm {
  url: string
  requests: { url: string, body: Record<string, unknown> }[]
  /** Holds every reply until `release()` when set; lets a test observe a running turn. */
  gate: Promise<void> | undefined
  hold(): () => void
  close(): Promise<void>
}

export async function startMockMessagesLlm(reply: (body: Record<string, unknown>) => MockTurn = () => ({ text: 'pong' })): Promise<MockMessagesLlm> {
  const requests: MockMessagesLlm['requests'] = []
  const state: { gate: Promise<void> | undefined } = { gate: undefined }
  const server: Server = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => void (async () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push({ url: request.url ?? '', body })
      if (!request.url?.endsWith('/messages')) { response.writeHead(404).end(); return }
      const { text } = reply(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant',
        model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      const parts = text.match(/[\s\S]{1,3}/g) ?? []
      for (const [index, part] of parts.entries()) {
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } })
        if (index === 0 && state.gate) await state.gate
      }
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: parts.length } })
      send('message_stop', { type: 'message_stop' })
      response.end()
    })())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock LLM did not bind')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get gate() { return state.gate },
    hold() {
      let release!: () => void
      state.gate = new Promise(resolve => { release = resolve })
      return () => { state.gate = undefined; release() }
    },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
