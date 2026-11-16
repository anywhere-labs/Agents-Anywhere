// 进程级假 ACP Agent（ndjson over stdio）。测试 provider 的发现、启动、环境变量边界时用。
// prompt 的回复是它看到的部分环境变量（JSON），方便断言。
import { createInterface } from 'node:readline'

/** @param {Record<string, unknown>} message */
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const configOptions = process.env.FAKE_NO_MODEL === '1'
  ? []
  : [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'Model 1' }] }]

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {} }, agentInfo: { name: 'fake-process', version: '1' }, authMethods: [] } })
  } else if (message.method === 'session/new') {
    send({ id: message.id, result: { sessionId: 'proc-1', configOptions } })
  } else if (message.method === 'session/prompt') {
    const seen = { HERMES_HOME: process.env.HERMES_HOME ?? null, AA_SECRET: process.env.AA_SECRET ?? null, AGENTS_ANYWHERE_TOKEN: process.env.AGENTS_ANYWHERE_TOKEN ?? null, cwd: process.cwd() }
    send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(seen) } } } })
    send({ id: message.id, result: { stopReason: 'end_turn' } })
  } else if (message.id !== undefined && message.method !== undefined) {
    send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
  }
})
