// Process-level fake ACP Agent (ndjson over stdio) for the end-to-end test (server/tests/test_v3_e2e.py).
// Behaviour depends on the prompt text:
//   contains "#slow": replies with some text, then waits for session/cancel (or 60 seconds);
//   contains "#approve": waits for a native permission response, then echoes the chosen option;
//   contains "#plan": sends a Markdown plan (plan_update), then replies;
//   contains "#later": replies after 3 seconds (a turn that ends while the test has the link down);
//   contains "#bulk <n>": reports n completed tool calls (one timeline item each), then replies;
//   contains "#serve": starts a dev server as its own child process (127.0.0.1, a free port), reports a tool call that
//     printed its URL, then replies "serving <port>";
//   contains "#exit": replies, then the Agent process exits (the device loses its sessions);
//   contains "#big <n>": reports one completed tool call whose content is the n lines "row 0".."row <n-1>" joined by
//     "\n" and a PNG of 2048 bytes of 0x07 (both large enough to go to the device's blob store), then replies;
//   otherwise: replies "echo: <text> [model=<model> permission=<permission>] sessions-in-cwd=<session/new calls in that cwd>",
//   followed by " attachments=<n>" when the prompt carries n non-text blocks (it accepts images).
// After session/new it reports the slash command catalog (available_commands_update).
// When the session's directory holds `.e2e-slow-config` (a number of milliseconds), session/set_config_option answers
// after that delay and appends `<configId>=<value>` to `.e2e-config-calls` there, so a test can count the calls.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
/** @type {Map<string, (result: any) => void>} */
const approvals = new Map()
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

const DEV_SERVER = "require('http').createServer((q, s) => s.end('dev server')).listen(0, '127.0.0.1', function () { console.log(this.address().port) })"
/** @type {import('node:child_process').ChildProcess[]} */
const servers = []

/** Starts a dev server under this process and resolves with its port. */
function serve() {
  const child = spawn(process.execPath, ['-e', DEV_SERVER], { stdio: ['ignore', 'pipe', 'ignore'] })
  servers.push(child)
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    createInterface({ input: child.stdout }).once('line', line => {
      child.stdout.destroy()
      resolve(Number(line))
    })
  })
}

/** @param {unknown} prompt */
function promptText(prompt) {
  return (Array.isArray(prompt) ? prompt : []).filter(block => block?.type === 'text').map(block => String(block.text)).join('\n')
}

/** @param {unknown} prompt */
function attachmentCount(prompt) {
  return (Array.isArray(prompt) ? prompt : []).filter(block => block?.type !== 'text').length
}

/** @param {Record<string, any>} message */
async function prompt(message) {
  const { sessionId } = message.params
  const text = promptText(message.params.prompt)
  const attachments = attachmentCount(message.params.prompt)
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
  if (text.includes('#approve')) {
    const requestId = `approval-${message.id}`
    const selected = await new Promise(resolve => {
      approvals.set(requestId, resolve)
      send({
        id: requestId, method: 'session/request_permission', params: {
          sessionId,
          toolCall: { toolCallId: requestId, title: 'QA permission approval', kind: 'read', status: 'pending' },
          options: [
            { optionId: 'qa-allow', name: 'Allow QA', kind: 'allow_once' },
            { optionId: 'qa-deny', name: 'Deny QA', kind: 'reject_once' },
          ],
        },
      })
    })
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `approval: ${selected?.outcome?.optionId ?? 'cancelled'}` } })
    send({ id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (text.includes('#later')) await new Promise(resolve => setTimeout(resolve, 3000))
  const bulk = /#bulk (\d+)/u.exec(text)
  for (let index = 0; index < Number(bulk?.[1] ?? 0); index++) {
    const output = `step ${index}: ${'lorem ipsum dolor sit amet '.repeat(6)}`
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `bulk-${process.pid}-${message.id}-${index}`, title: `Read file ${index}`, kind: 'read', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }] })
  }
  if (text.includes('#serve')) {
    const port = await serve()
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `serve-${process.pid}-${message.id}`, title: 'npm run dev', kind: 'execute', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `  VITE ready\n  ➜  Local:   http://localhost:${port}/\n` } }] })
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `serving ${port}` } })
    send({ id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  const big = /#big (\d+)/u.exec(text)
  if (big !== null) {
    const lines = Array.from({ length: Number(big[1]) }, (_, index) => `row ${index}`).join('\n')
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `big-${process.pid}-${message.id}`, title: 'Dump the log', kind: 'read', status: 'completed', content: [
      { type: 'content', content: { type: 'text', text: lines } },
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data: Buffer.alloc(2048, 7).toString('base64') } },
    ] })
  }
  if (text.includes('#plan')) {
    update(sessionId, { sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'plan-e2e', content: '# E2E plan\n\n1. Read the code\n2. Fix the bug\n' } })
  }
  const current = Object.fromEntries(configOf(sessionId).map(option => [option.id, option.currentValue]))
  const created = createdIn.get(cwdOf.get(sessionId) ?? '') ?? 0
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text} [model=${current.model} permission=${current.permission}] sessions-in-cwd=${created}${attachments > 0 ? ` attachments=${attachments}` : ''}` } })
  send({ id: message.id, result: { stopReason: 'end_turn' } })
  if (text.includes('#exit')) setTimeout(() => process.exit(0), 50)
}

const stopServers = () => {
  for (const server of servers) server.kill()
}
process.on('exit', stopServers)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopServers()
    process.exit(0)
  })
}

createInterface({ input: process.stdin }).on('close', () => process.exit(0)).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === undefined && approvals.has(message.id)) {
    approvals.get(message.id)?.(message.result)
    approvals.delete(message.id)
    return
  }
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {} } }, agentInfo: { name: 'fake-e2e', version: '1' }, authMethods: [] } })
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
      if (params.cwd) cwdOf.set(params.sessionId, String(params.cwd))
      send({ id: message.id, result: { configOptions: configOf(params.sessionId) } })
      announceCommands(params.sessionId)
      return
    case 'session/set_config_option': {
      const config = configOf(params.sessionId).map(option => (option.id === params.configId ? { ...option, currentValue: params.value } : option))
      configs.set(params.sessionId, config)
      const marker = join(cwdOf.get(params.sessionId) ?? '.', '.e2e-slow-config')
      if (existsSync(marker)) {
        appendFileSync(join(cwdOf.get(params.sessionId) ?? '.', '.e2e-config-calls'), `${params.configId}=${params.value}\n`)
        setTimeout(() => send({ id: message.id, result: { configOptions: config } }), Number(readFileSync(marker, 'utf8')) || 0)
        return
      }
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
