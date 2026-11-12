import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
}

async function permission(ctx) {
  try {
    const config = JSON.parse(await readFile(process.env.AA_PI_PERMISSIONS_FILE || join(process.env.PI_CODING_AGENT_DIR, 'aa-permissions.json'), 'utf8'))
    return config[ctx.sessionManager.getSessionId()] ?? 'ask'
  } catch { return 'ask' }
}

export default function aaPermissions(pi) {
  // The SDK started this run; do not make the client wait for the first model
  // token or tool call before acknowledging the submitted message.
  pi.on('agent_start', (_event, ctx) => ctx.ui.setStatus('aa-prompt-started', 'started'))
  pi.on('tool_call', async (event, ctx) => {
    const mode = await permission(ctx)
    freeze(event)
    const safeRead = ['read', 'ls', 'find', 'grep'].includes(event.toolName)
    if (safeRead && mode !== 'ask_all') return
    if (mode === 'readonly') return { block: true, reason: 'AA 当前会话为只读模式。' }
    const request = JSON.stringify({ id: event.toolCallId, name: event.toolName, input: event.input })
    let answer = false
    try { answer = await ctx.ui.confirm('AA_TOOL_PERMISSION\n' + request, '') } catch { /* Fail closed if the approval channel is lost. */ }
    if (!answer) return { block: true, reason: '用户拒绝了此操作。' }
  })
  pi.on('user_bash', async (event, ctx) => {
    if (await permission(ctx) === 'readonly') return { result: {
      output: 'AA 当前会话为只读模式，不能执行命令。', exitCode: 1, cancelled: false, truncated: false,
    } }
    const request = JSON.stringify({ id: 'user-bash', name: 'bash', input: { command: event.command } })
    let answer = false
    try { answer = await ctx.ui.confirm('AA_TOOL_PERMISSION\n' + request, '') } catch { /* Fail closed. */ }
    if (!answer) return { result: {
      output: '用户拒绝了此操作。', exitCode: 1, cancelled: false, truncated: false,
    } }
  })
}
