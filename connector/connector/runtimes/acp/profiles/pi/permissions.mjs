import { createHash } from 'node:crypto'
import { readFile, stat, unlink } from 'node:fs/promises'
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

const submitPlan = 'aa_submit_plan'
const reads = ['read', 'ls', 'find', 'grep']

function planMarker(ctx) {
  const dir = process.env.AA_PI_PLANNING_DIR
  if (!dir) return undefined
  const key = createHash('sha256').update(ctx.sessionManager.getSessionId()).digest('hex')
  return join(dir, key)
}

async function isPlanning(ctx) {
  const file = planMarker(ctx)
  if (!file) return false
  try {
    await stat(file)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function result(text) {
  return { content: [{ type: 'text', text }], details: {} }
}

function registerPlanningTool(pi) {
  pi.registerTool({
    name: submitPlan,
    label: 'Submit plan',
    description: 'Submit the complete Markdown plan for human approval during Plan mode.',
    parameters: {
      type: 'object',
      properties: { markdown: { type: 'string' } },
      required: ['markdown'],
      additionalProperties: false,
    },
    async execute(toolCallId, { markdown }, signal, _onUpdate, ctx) {
      if (!(await isPlanning(ctx))) return result('Plan mode is inactive.')
      if (typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown) > 2 * 1024 * 1024) {
        return result('Provide the complete plan as Markdown, up to 2 MiB.')
      }
      const answer = await ctx.ui.input('AA_PLAN_REVIEW\n' + toolCallId, markdown, { signal })
      if (answer === 'approve' && !signal?.aborted) {
        await unlink(planMarker(ctx))
        ctx.ui.setStatus('aa-plan-mode', 'normal')
        return result('The user approved this plan. Implement the reviewed Markdown now, using the current tool permissions.')
      }
      if (answer?.startsWith('revise\n') && !signal?.aborted) {
        return result('Stay in Plan mode. Revise the plan using this user feedback and resubmit it:\n' + answer.slice(7))
      }
      ctx.abort()
      return result('The user did not approve the plan. Plan mode remains active.')
    },
  })

  pi.on('before_agent_start', async (event, ctx) => {
    const planning = await isPlanning(ctx)
    const active = pi.getActiveTools().filter(name => name !== submitPlan)
    if (planning) {
      pi.setActiveTools([...active, submitPlan])
      return {
        systemPrompt: event.systemPrompt + '\n\nPlan mode is active at the start of this turn. Use read-only exploration, then call aa_submit_plan with the full Markdown plan. Implement only after that tool reports user approval.',
      }
    }
    pi.setActiveTools(active)
  })
}

export default function aaPermissions(pi) {
  if (process.env.AA_PI_PLANNING_DIR) registerPlanningTool(pi)

  // The SDK started this run; do not make the client wait for the first model
  // token or tool call before acknowledging the submitted message.
  pi.on('agent_start', (_event, ctx) => ctx.ui.setStatus('aa-prompt-started', 'started'))
  pi.on('tool_call', async (event, ctx) => {
    const mode = await permission(ctx)
    freeze(event)
    const safeRead = reads.includes(event.toolName)
    if (await isPlanning(ctx)) {
      if (event.toolName === submitPlan) return
      if (!safeRead) return { block: true, reason: 'Plan mode blocks implementation until the plan is approved.' }
    } else if (event.toolName === submitPlan) {
      return { block: true, reason: 'Plan mode is inactive.' }
    }
    if (safeRead && mode !== 'ask_all') return
    if (mode === 'readonly') return { block: true, reason: 'AA 当前会话为只读模式。' }
    const request = JSON.stringify({ id: event.toolCallId, name: event.toolName, input: event.input })
    let answer = false
    try { answer = await ctx.ui.confirm('AA_TOOL_PERMISSION\n' + request, '') } catch { /* Fail closed if the approval channel is lost. */ }
    if (!answer) return { block: true, reason: '用户拒绝了此操作。' }
  })
  pi.on('user_bash', async (event, ctx) => {
    if (await isPlanning(ctx) || await permission(ctx) === 'readonly') return { result: {
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
