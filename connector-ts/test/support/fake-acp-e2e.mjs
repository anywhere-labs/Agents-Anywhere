// 端到端测试（server/tests/test_v3_e2e.py）用的进程级假 ACP Agent（ndjson over stdio）。
// 按 prompt 的文字决定行为：
//   含 "#slow"：先回一段文字，然后一直等到 session/cancel（或 60 秒）；
//   含 "#plan"：发一份 Markdown 计划（plan_update）再回复；
//   otherwise: replies "echo: <text> [model=<model> permission=<permission>] sessions-in-cwd=<session/new calls in that cwd>".
// session/new 之后上报斜杠命令目录（available_commands_update）。
import { createInterface } from 'node:readline'

/** @param {Record<string, unknown>} message */
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
/** @param {string} sessionId @param {Record<string, unknown>} update */
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } })

const initialConfig = () => [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'Model 1' }, { value: 'm2', name: 'Model 2' }] },
  { id: 'permission', name: 'Permission', category: 'permission', type: 'select', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask' }, { value: 'auto', name: 'Auto' }] },
]
const COMMANDS = [
  { name: 'review', description: 'Review the working tree', input: { hint: 'path' } },
  { name: 'compact', description: 'Compact the context' },
]

/** @type {Map<string, Record<string, unknown>[]>} */
const configs = new Map()
/** @type {Map<string, () => void>} */
const running = new Map()
let sessions = 0
/** session/new calls per working directory, and the directory of each session. */
/** @type {Map<string, number>} */
const createdIn = new Map()
/** @type {Map<string, string>} */
const cwdOf = new Map()

/** @param {string} sessionId */
function configOf(sessionId) {
  let config = configs.get(sessionId)
  if (config === undefined) {
    config = initialConfig()
    configs.set(sessionId, config)
  }
  return config
}

/** @param {string} sessionId */
function announceCommands(sessionId) {
  setTimeout(() => update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS }), 20)
}

/** @param {unknown} prompt */
function promptText(prompt) {
  return (Array.isArray(prompt) ? prompt : []).filter(block => block?.type === 'text').map(block => String(block.text)).join('\n')
}

/** @param {Record<string, any>} message */
async function prompt(message) {
  const { sessionId } = message.params
  const text = promptText(message.params.prompt)
  if (text.includes('#slow')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working slowly' } })
    const cancelled = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 60_000)
      running.set(sessionId, () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    running.delete(sessionId)
    send({ id: message.id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } })
    return
  }
  if (text.includes('#plan')) {
    update(sessionId, { sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'plan-e2e', content: '# E2E plan\n\n1. Read the code\n2. Fix the bug\n' } })
  }
  const current = Object.fromEntries(configOf(sessionId).map(option => [option.id, option.currentValue]))
  const created = createdIn.get(cwdOf.get(sessionId) ?? '') ?? 0
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text} [model=${current.model} permission=${current.permission}] sessions-in-cwd=${created}` } })
  send({ id: message.id, result: { stopReason: 'end_turn' } })
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {}, sessionCapabilities: { resume: {} } }, agentInfo: { name: 'fake-e2e', version: '1' }, authMethods: [] } })
      return
    case 'session/new': {
      sessions += 1
      const sessionId = `e2e-${process.pid}-${sessions}`
      const cwd = String(params.cwd ?? '')
      createdIn.set(cwd, (createdIn.get(cwd) ?? 0) + 1)
      cwdOf.set(sessionId, cwd)
      send({ id: message.id, result: { sessionId, configOptions: configOf(sessionId) } })
      announceCommands(sessionId)
      return
    }
    case 'session/load':
    case 'session/resume':
      send({ id: message.id, result: { configOptions: configOf(params.sessionId) } })
      announceCommands(params.sessionId)
      return
    case 'session/set_config_option': {
      const config = configOf(params.sessionId).map(option => (option.id === params.configId ? { ...option, currentValue: params.value } : option))
      configs.set(params.sessionId, config)
      send({ id: message.id, result: { configOptions: config } })
      return
    }
    case 'session/prompt':
      void prompt(message)
      return
    case 'session/cancel':
      running.get(params.sessionId)?.()
      return
    default:
      if (message.id !== undefined && message.method !== undefined) send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
  }
})
