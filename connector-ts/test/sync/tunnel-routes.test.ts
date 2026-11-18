// The device's client routes beyond their shapes: the checks, merges and identities moved from the Server.
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEVICE, RUNTIME, settle, testDevice, type TestDevice } from '../support/client-device.js'

let device: TestDevice
const S = 'sess_routes'
const at = (path: string): string => `/sessions/${S}${path}`
const detail = (body: unknown): { code?: string; message?: string } => (body as { detail?: { code?: string; message?: string } }).detail ?? {}
const command = { commandId: 'cm_ctx', inputDigest: 'sha256:aaaa', deadline: '2099-01-01T00:00:00Z' }

beforeEach(async () => {
  device = await testDevice()
})

afterEach(async () => {
  await device.close()
})

describe('messages and steer', () => {
  it('refuses archived and read-only sessions; the Server\'s takeover switch wins over the device copy', async () => {
    await device.start(S)
    const readOnly = await device.request('POST', at('/runtime/messages'), { content: 'x', clientMessageId: 'cm_ro' }, { server: { takeover: false } })
    expect(readOnly.status).toBe(409)
    expect(detail(readOnly.body)).toEqual({ code: 'session_read_only', message: 'session is read-only until takeover is enabled' })
    await device.inbox.handle('sessionSync', { commandId: 'c_off', p: { sessionId: S, takeover: false } } as never)
    expect((await device.request('POST', at('/runtime/messages'), { content: 'x', clientMessageId: 'cm_ro2' })).status).toBe(409)
    const allowed = await device.request('POST', at('/runtime/messages'), { content: 'x', clientMessageId: 'cm_on' }, { server: { takeover: true } })
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200)
    await device.runTurn('x')
    // Archived in the Server's directory: refused even though the device copy is not archived.
    const archivedByServer = await device.request('POST', at('/runtime/messages'), { content: 'x', clientMessageId: 'cm_sarch' }, { server: { takeover: true, archived: true } })
    expect(archivedByServer.status).toBe(409)
    expect(detail(archivedByServer.body)).toEqual({ code: 'session_archived', message: 'session is archived in Agents Anywhere' })
    expect((await device.request('POST', at('/planning'), { command: 'enter_plan', operationId: 'op_arch' }, { server: { takeover: true, archived: true } })).status).toBe(409)
    expect(detail((await device.request('POST', at('/goal'), { action: 'set', objective: 'x', operationId: 'op_garch' }, { server: { takeover: true, archived: true } })).body).code).toBe('goal_control_not_allowed')
    await device.inbox.handle('sessionSync', { commandId: 'c_arch', p: { sessionId: S, takeover: true, archived: true } } as never)
    const archived = await device.request('POST', at('/runtime/messages'), { content: 'x', clientMessageId: 'cm_arch' })
    expect(archived.status).toBe(409)
    expect(detail(archived.body)).toEqual({ code: 'session_archived', message: 'session is archived in Agents Anywhere' })
  })

  it('validates the body and the queue mode', async () => {
    await device.start(S)
    expect((await device.request('POST', at('/runtime/messages'), { clientMessageId: 'cm_x' })).status).toBe(422)
    expect((await device.request('POST', at('/runtime/messages'), { content: 'x', queue: 'later' })).status).toBe(422)
  })

  it('takes the attachments the Server recorded over the body, and refuses one it does not hold', async () => {
    await device.start(S)
    const facts = [{ fileId: 'file_1', name: 'photo.png', mediaType: 'image/png', size: 3, sha256: 'a'.repeat(64) }]
    const missing = await device.request('POST', at('/runtime/messages'), { content: 'see', clientMessageId: 'cm_att0', attachments: [{ fileId: 'file_2', name: 'evil.exe', mediaType: 'application/x-msdownload' }] }, { server: { attachments: facts } })
    expect(missing.status).toBe(404)
    expect(detail(missing.body)).toMatchObject({ code: 'attachment_not_found', message: 'attachment not found: file_2' })
    // Queued behind a running turn, the message keeps its attachments where they can be read back.
    await device.request('POST', at('/runtime/messages'), { content: 'long', clientMessageId: 'cm_long' })
    await device.runTurn('long', true)
    const sent = await device.request('POST', at('/runtime/messages'), { content: 'see', clientMessageId: 'cm_att', queue: 'auto', attachments: [{ fileId: 'file_1', name: 'evil.exe', mediaType: 'application/x-msdownload', size: 999 }] }, { server: { attachments: facts } })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    const queued = (await device.request('GET', at('/runtime/queue'))).body as { items: { attachments: Record<string, unknown>[] }[] }
    expect(queued.items[0]!.attachments).toEqual([expect.objectContaining({ fileId: 'file_1', name: 'photo.png', mediaType: 'image/png', size: 3 })])
  })

  it('steers only into a running turn, with session.steer usable and the attachment types allowed', async () => {
    device.capabilities = { revision: 2, items: [{ id: 'session.send_message', supported: true }, { id: 'session.steer', supported: true }, { id: 'runtime.attachment', supported: true, parameters: { allowedMimeTypes: ['image/png'] } }] }
    await device.start(S)
    const idle = await device.request('POST', at('/runtime/steer'), { content: 'more' })
    expect(idle.status).toBe(409)
    expect(detail(idle.body).message).toBe('session is not running')
    await device.request('POST', at('/runtime/messages'), { content: 'long', clientMessageId: 'cm_long' })
    await device.runTurn('long', true)
    const pdf = [{ fileId: 'f_pdf', name: 'a.pdf', mediaType: 'application/pdf', size: 1, sha256: null }]
    const refused = await device.request('POST', at('/runtime/steer'), { content: 'more', attachments: [{ fileId: 'f_pdf' }] }, { server: { attachments: pdf } })
    expect(refused.status).toBe(409)
    expect(detail(refused.body).message).toBe('attachment type is not supported by this runtime: application/pdf')
    // Without a clientMessageId the device names the steer itself (the use case needs one).
    const steered = await device.request('POST', at('/runtime/steer'), { content: 'more' })
    expect(steered.status, JSON.stringify(steered.body)).toBe(200)
    expect(steered.body).toMatchObject({ ok: true, error: null })
    expect(device.sessions[0]!.calls.some(call => call.method === 'steer')).toBe(true)
    device.capabilities = { revision: 3, items: [{ id: 'session.send_message', supported: true }, { id: 'session.steer', supported: false }] }
  })

  it('refuses steer when the Runtime cannot steer', async () => {
    await device.start(S)
    await device.request('POST', at('/runtime/messages'), { content: 'long', clientMessageId: 'cm_long' })
    await device.runTurn('long', true)
    const refused = await device.request('POST', at('/runtime/steer'), { content: 'more' })
    expect(refused.status).toBe(409)
    expect(detail(refused.body)).toEqual({ code: 'capability_unavailable', message: 'session capability is unavailable: session.steer' })
  })
})

describe('command identity', () => {
  it('runs a command under the caller\'s commandId and digest, reports the ack, and replays it', async () => {
    await device.start(S)
    const acks: unknown[] = []
    const context = { command, onCommand: (commandId: string, ack: unknown) => acks.push({ commandId, ack }) }
    const first = await device.request('POST', at('/runtime/messages'), { content: 'once', clientMessageId: 'cm_body' }, context)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(acks).toEqual([{ commandId: 'cm_ctx', ack: expect.objectContaining({ outcome: 'accepted' }) }])
    expect(await device.store.commands.get('cm_ctx')).toMatchObject({ inputDigest: 'sha256:aaaa', outcome: 'accepted' })
    await device.runTurn('once')
    const prompts = device.sessions[0]!.calls.filter(call => call.method === 'prompt').length
    // A repeat replays the receipt: no second prompt.
    expect((await device.request('POST', at('/runtime/messages'), { content: 'once', clientMessageId: 'cm_body' }, context)).status).toBe(200)
    await settle()
    expect(device.sessions[0]!.calls.filter(call => call.method === 'prompt')).toHaveLength(prompts)
    // The same id with other input is a conflict.
    const other = await device.request('POST', at('/runtime/messages'), { content: 'twice' }, { command: { ...command, inputDigest: 'sha256:bbbb' } })
    expect(other.status).toBe(409)
    expect(detail(other.body).code).toBe('command_conflict')
  })

  it('creates the session the Server named', async () => {
    await device.start('sess_named')
    expect(await device.store.sessions.get('sess_named')).not.toBeNull()
  })

  it('creates and starts a session once under the caller\'s commandId, replays it, and passes the planning intent on', async () => {
    const acks: unknown[] = []
    const identity = { commandId: 'cm_plan', inputDigest: 'sha256:plan', deadline: '2099-01-01T00:00:00Z' }
    const context = { command: identity, server: { sessionId: 'sess_plan' }, onCommand: (commandId: string, ack: unknown) => acks.push({ commandId, ack }) }
    const body = { connectorId: DEVICE, runtime: 'opencode', runtimeId: RUNTIME, cwd: device.root, content: 'design the cache', clientMessageId: 'cm_plan', planningIntent: { mode: 'plan', operationId: 'cm_plan' } }
    const created = await device.request('POST', '/sessions/create-and-start', body, context)
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    expect(created.body).toMatchObject({ session: { id: 'sess_plan' }, connectorResult: { sessionId: 'sess_plan', delivery: 'accepted' } })
    expect(acks).toEqual([{ commandId: 'cm_plan', ack: expect.objectContaining({ outcome: 'accepted' }) }])
    expect(await device.store.commands.get('cm_plan')).toMatchObject({ method: 'session.createAndStart', inputDigest: 'sha256:plan', outcome: 'accepted' })
    await settle()
    // One Agent session; the intent reached the use case: this Runtime cannot plan, so the first message is refused
    // instead of being sent as a plain prompt.
    expect(device.sessions).toHaveLength(1)
    expect(device.sessions[0]!.calls.filter(call => call.method === 'prompt')).toEqual([])
    expect(await device.store.deliveries.get('sess_plan', 'cm_plan')).toMatchObject({ state: 'rejected', errorCode: 'planning_unavailable' })
    const calls = JSON.stringify(device.sessions[0]!.calls)
    // A retry replays the receipt: the same session, no second Agent session.
    const again = await device.request('POST', '/sessions/create-and-start', body, context)
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ session: { id: 'sess_plan' } })
    await settle()
    expect(device.sessions).toHaveLength(1)
    expect(JSON.stringify(device.sessions[0]!.calls)).toBe(calls)
  })
})

describe('selections', () => {
  it('applies the whole batch as one command and answers the runtime state', async () => {
    await device.start(S)
    const patched = await device.request('PATCH', at('/runtime/selections'), { selections: { model: 'm2', permission: 'auto' } }, { command: { ...command, commandId: 'c_sel' } })
    expect(patched.status, JSON.stringify(patched.body)).toBe(200)
    expect(patched.body).toMatchObject({ ok: true, state: { sessionId: S, selections: { model: 'm2', permission: 'auto' } }, connectorResult: { updated: true } })
    expect(device.sessions[0]!.calls.filter(call => call.method === 'configure')).toHaveLength(2)
    expect(await device.store.commands.get('c_sel')).toMatchObject({ outcome: 'accepted' })
  })

  it('needs the catalog capability of each kind and a selection object', async () => {
    device.capabilities = { revision: 1, items: [{ id: 'session.send_message', supported: true }, { id: 'catalog.model', supported: true }] }
    await device.start(S)
    const refused = await device.request('PATCH', at('/runtime/selections'), { selections: { permission: 'auto' } })
    expect(detail(refused.body)).toEqual({ code: 'capability_unavailable', message: 'session capability is unavailable: catalog.permission' })
    expect((await device.request('PATCH', at('/runtime/selections'), { selections: {} })).status).toBe(422)
    expect((await device.request('PATCH', at('/runtime/selections'), { selections: { model: 3 } })).status).toBe(422)
  })
})

describe('notice answers', () => {
  async function openNotice(kind: 'approval' | 'form', context: Record<string, unknown>): Promise<void> {
    await device.request('POST', at('/runtime/messages'), { content: 'ask', clientMessageId: 'cm_ask' })
    await device.runTurn('ask', true)
    device.sessions[0]!.emit({ type: 'interaction.opened', turnId: 't2', interactionId: 'n1', kind, title: 'Allow?', options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }] })
    await settle()
    const interaction = (await device.store.interactions.get(S, 'n1'))!
    await device.store.interactions.save({ ...interaction, payload: { ...interaction.payload, context } })
  }

  it('answers an approval with the chosen option', async () => {
    await device.start(S)
    await openNotice('approval', { approvalSource: { kind: 'tool' } })
    const answered = await device.request('POST', at('/runtime/notices/n1/respond'), { actionId: 'allow' })
    expect(answered.status, JSON.stringify(answered.body)).toBe(200)
    expect(answered.body).toEqual({ ok: true, result: { status: 'responding' }, error: null })
    expect(device.sessions[0]!.calls.find(call => call.method === 'respond')).toMatchObject({ interactionId: 'n1', answer: { kind: 'option', optionId: 'allow' } })
  })

  it('merges the notice context into a form answer and accepts the v2 inputData', async () => {
    await device.start(S)
    await openNotice('form', { approvalSource: { kind: 'tool', id: 'a' }, path: '/x' })
    const answered = await device.request('POST', at('/runtime/notices/n1/respond'), { actionId: 'accept', inputData: { name: 'v', approvalSource: { id: 'b' } } })
    expect(answered.status, JSON.stringify(answered.body)).toBe(200)
    expect(device.sessions[0]!.calls.find(call => call.method === 'respond')).toMatchObject({ answer: { kind: 'form', action: 'accept', values: { path: '/x', name: 'v', approvalSource: { kind: 'tool', id: 'b' } } } })
  })

  it('lists a failed-turn card and answers its action as an option; a Runtime refusal is ok: false and closes the card', async () => {
    await device.start(S)
    await device.request('POST', at('/runtime/messages'), { content: 'ask', clientMessageId: 'cm_card' })
    await device.runTurn('ask')
    device.sessions[0]!.emit({ type: 'interaction.opened', interactionId: 'dsh_turn_failed_42', kind: 'execution_error', title: 'DSH 本轮执行失败', body: 'boom',
      options: [{ id: 'continue', label: '继续', kind: 'other' }], context: { kind: 'execution_error', outcome: 'failed' }, metadata: { turnEndSeq: 42 } })
    await settle()
    const listed = (await device.request('GET', at('/runtime/notices'))).body as { notices: Record<string, unknown>[] }
    expect(listed.notices).toMatchObject([{ noticeId: 'dsh_turn_failed_42', interactionType: 'execution_error', severity: 'error', status: 'open', blocking: null,
      responseRequired: false, message: 'boom', actions: [{ actionId: 'continue', label: '继续', style: 'primary' }] }])
    device.sessions[0]!.nextRespond = { refused: { code: 'dsh_continue_unavailable', message: '这一轮已无法继续生成，请重新发送消息。' }, closes: true }
    const answered = await device.request('POST', at('/runtime/notices/dsh_turn_failed_42/respond'), { actionId: 'continue' })
    expect(answered.status, JSON.stringify(answered.body)).toBe(200)
    expect(answered.body).toMatchObject({ ok: false, error: { code: 'dsh_continue_unavailable', message: '这一轮已无法继续生成，请重新发送消息。' } })
    expect(device.sessions[0]!.calls.find(call => call.method === 'respond')).toMatchObject({ interactionId: 'dsh_turn_failed_42', answer: { kind: 'option', optionId: 'continue' } })
    expect(((await device.request('GET', at('/runtime/notices'))).body as { notices: unknown[] }).notices).toEqual([])
  })

  it('answers a notice that is gone with ok: false, and needs the approval capability', async () => {
    await device.start(S)
    expect((await device.request('POST', at('/runtime/notices/nope/respond'), { actionId: 'allow' })).body).toEqual({ ok: false, result: null, error: { code: 'interaction_not_found', message: 'interaction not found' } })
    expect((await device.request('POST', at('/runtime/notices/nope/respond'), {})).status).toBe(422)
    expect((await device.request('POST', at('/runtime/notices/nope/respond'), { actionId: 'allow' }, { server: { takeover: false } })).status).toBe(409)
  })
})

describe('slash commands', () => {
  beforeEach(async () => {
    device.commands.observe('runtime.status', { runtimeId: 'rti_1', sessionId: S, status: { event: 'commands.updated', commands: [{ name: 'review', description: 'Review', inputHint: 'path' }] } })
  })

  it('lists the session catalog with query and limit', async () => {
    await device.start(S)
    const listed = await device.request('GET', at('/runtime/commands?query=rev&limit=5'))
    expect((listed.body as { commands: { id: string }[] }).commands.map(item => item.id)).toEqual(['review'])
    expect(((await device.request('GET', at('/runtime/commands?query=zzz'))).body as { commands: unknown[] }).commands).toEqual([])
    expect((await device.request('GET', at('/runtime/commands?limit=0'))).status).toBe(422)
  })

  it('sends a catalog command as a message and reports a missing or mismatched one as a failed result', async () => {
    await device.start(S)
    const sent = await device.request('POST', at('/runtime/commands'), { command: 'review', args: ['src'], operationId: 'op_1' })
    expect(sent.body).toMatchObject({ command: 'review', ok: true, result: { clientMessageId: 'op_1', executionState: 'accepted' } })
    await expect.poll(() => device.sessions[0]!.calls.some(call => call.method === 'prompt' && (call as { input: { text: string } }).input.text === '/review src')).toBe(true)
    await device.runTurn('/review src')
    expect((await device.request('POST', at('/runtime/commands'), { command: 'nope' })).body).toMatchObject({ ok: false, code: 'command_unavailable', result: { executionState: 'completed' } })
    expect((await device.request('POST', at('/runtime/commands'), { command: 'review', raw: '/compact' })).body).toMatchObject({ ok: false, code: 'invalid_command' })
    expect((await device.request('POST', at('/runtime/commands'), { command: '1bad' })).status).toBe(422)
  })

  it('needs session.commands, and session.planning for /plan', async () => {
    await device.start(S)
    expect(detail((await device.request('POST', at('/runtime/commands'), { command: 'plan' })).body).message).toBe('session capability is unavailable: session.planning')
    expect((await device.request('GET', at('/runtime/commands'), undefined, { server: { takeover: false } })).status).toBe(409)
  })
})

describe('native app commands', () => {
  it('lists the app\'s commands after the catalog and runs them on the device with the Server\'s takeover switch', async () => {
    await device.close()
    const calls: unknown[] = []
    device = await testDevice({
      nativeApps: {
        list: async () => [{ id: 'open-in-desk', title: 'Open in Desk App', description: 'Open it there.', aliases: ['desk'] }],
        execute: async (sessionId, command, args, context) => {
          calls.push({ sessionId, command, args, context })
          return command === 'open-in-desk' ? { ok: false, code: 'confirmation_required', message: 'sure?', result: { executionState: 'completed', confirmation: { planId: 'p1' } } } : null
        },
      },
    })
    device.commands.observe('runtime.status', { runtimeId: 'rti_1', sessionId: S, status: { event: 'commands.updated', commands: [{ name: 'review' }] } })
    await device.start(S)
    const listed = (await device.request('GET', at('/runtime/commands'))).body as { commands: Record<string, unknown>[] }
    expect(listed.commands.map(item => item.id)).toEqual(['review', 'open-in-desk'])
    expect(listed.commands[1]).toMatchObject({ aliases: ['desk'], acceptsArgs: false, argsSchema: null, metadata: { ui: { kind: 'execute', acceptsMultiline: false } } })
    expect((listed.commands[1]!.metadata as { ui: { allowedStatuses: string[] } }).ui.allowedStatuses).toContain('running')
    expect(((await device.request('GET', at('/runtime/commands?query=desk'))).body as { commands: { id: string }[] }).commands.map(item => item.id)).toEqual(['open-in-desk'])
    expect(((await device.request('GET', at('/runtime/commands?limit=1'))).body as { commands: { id: string }[] }).commands.map(item => item.id)).toEqual(['review'])
    const ran = await device.request('POST', at('/runtime/commands'), { command: 'open-in-desk', args: ['--confirm', 'p1'] }, { server: { takeover: true } })
    expect(ran.body).toMatchObject({ command: 'open-in-desk', ok: false, code: 'confirmation_required', message: 'sure?', result: { confirmation: { planId: 'p1' } }, session: null })
    expect(calls).toEqual([{ sessionId: S, command: 'open-in-desk', args: ['--confirm', 'p1'], context: { takeover: true } }])
    // Anything else is still a Runtime command sent as a message.
    expect((await device.request('POST', at('/runtime/commands'), { command: 'review', operationId: 'op_r' })).body).toMatchObject({ ok: true, result: { executionState: 'accepted' } })
  })
})

describe('files and shell', () => {
  it('resolves paths against the root like the Server', async () => {
    const listed = await device.request('POST', `/connectors/${DEVICE}/fs/list`, { root: join(device.root, 'notes'), path: '..' })
    expect(listed.body).toMatchObject({ ok: true, result: { path: device.root }, error: null })
    const empty = await device.request('POST', `/connectors/${DEVICE}/fs/list`, { root: device.root, path: '' })
    expect(empty.body).toMatchObject({ result: { path: device.root } })
    const text = await device.request('POST', `/connectors/${DEVICE}/fs/readText?root=${encodeURIComponent(join(device.root, 'notes', 'deep'))}`, { path: '../a.txt' })
    expect(text.body).toMatchObject({ content: 'hello\n', path: join(device.root, 'notes', 'a.txt') })
    const shell = await device.request('POST', `/connectors/${DEVICE}/shell/exec?root=${encodeURIComponent(device.root)}`, { command: 'pwd', cwd: 'notes', timeoutMs: 5000 })
    expect(shell.body).toMatchObject({ ok: true, result: { cwd: join(device.root, 'notes'), exitCode: 0 } })
    expect((await device.request('POST', `/connectors/${DEVICE}/shell/exec?root=${encodeURIComponent(device.root)}`, { command: 'pwd' })).status).toBe(422)
    const missing = await device.request('POST', `/connectors/${DEVICE}/fs/readText?root=${encodeURIComponent(device.root)}`, { path: 'none.txt' })
    expect(missing.status).toBe(502)
    expect(detail(missing.body).code).toBe('not_found')
  })

  it('runs background shell tasks: start, wait for the output, cancel, and the wait timeout', async () => {
    const tasks = `/connectors/${DEVICE}/shell/tasks`
    const root = `?root=${encodeURIComponent(device.root)}`
    const started = await device.request('POST', `${tasks}${root}`, { command: 'sleep 0.2; echo done; exit 3', cwd: 'notes', timeoutMs: 10_000 })
    expect(started.status).toBe(200)
    const view = started.body as { taskId: string }
    expect(view.taskId).toMatch(/^sht_/u)
    expect(started.body).toMatchObject({ sessionId: `browse_${DEVICE}`, command: 'sleep 0.2; echo done; exit 3', cwd: join(device.root, 'notes'), timeoutMs: 10_000, status: 'running', result: null, error: null, serverTime: expect.any(String) })
    const waited = await device.request('GET', `${tasks}/${view.taskId}/wait?timeoutMs=10000`)
    expect(waited.status).toBe(200)
    expect(waited.body).toMatchObject({ taskId: view.taskId, status: 'completed', result: { stdout: 'done\n', exitCode: 3, timedOut: false }, serverTime: expect.any(String) })
    // The wait took the task.
    const again = await device.request('GET', `${tasks}/${view.taskId}/wait?timeoutMs=10`)
    expect([again.status, detail(again.body).code]).toEqual([404, 'shell_task_not_found'])

    const slow = (await device.request('POST', `${tasks}${root}`, { command: 'sleep 30', timeoutMs: 60_000 })).body as { taskId: string }
    const waiting = device.request('GET', `${tasks}/${slow.taskId}/wait`)
    const cancelled = await device.request('POST', `${tasks}/${slow.taskId}/cancel`)
    expect(cancelled.body).toMatchObject({ taskId: slow.taskId, status: 'cancelled', cancelled: true })
    expect((await waiting).body).toMatchObject({ taskId: slow.taskId, status: 'cancelled' })
    expect((await device.request('POST', `${tasks}/sht_none/cancel`)).status).toBe(404)

    const stuck = (await device.request('POST', `${tasks}${root}`, { command: 'sleep 30', timeoutMs: 60_000 })).body as { taskId: string }
    const timedOut = await device.request('GET', `${tasks}/${stuck.taskId}/wait?timeoutMs=100`)
    expect([timedOut.status, detail(timedOut.body).code]).toEqual([408, 'shell_task_wait_timeout'])
    expect((await device.request('POST', `${tasks}/${stuck.taskId}/cancel`)).status).toBe(404)

    expect((await device.request('POST', `${tasks}${root}`, { command: 'true', timeoutMs: 300_001 })).status).toBe(422)
    expect((await device.request('POST', tasks, { command: 'true', timeoutMs: 1000 })).status).toBe(422)
    expect((await device.request('GET', `${tasks}/x/wait?timeoutMs=0`)).status).toBe(422)
    const badCwd = await device.request('POST', `${tasks}${root}`, { command: 'true', cwd: 'nope', timeoutMs: 1000 })
    expect([badCwd.status, detail(badCwd.body).code]).toEqual([502, 'not_found'])
  })

  it('lists the drives for an empty path on Windows', async () => {
    const windows = await testDevice({ platform: 'win32' })
    try {
      const listed = await windows.request('POST', `/connectors/${DEVICE}/fs/list`, { root: 'C:\\repo', path: '' })
      expect(listed.body).toMatchObject({ ok: true, result: { path: '', targetPath: '' } })
    } finally {
      await windows.close()
    }
  })

  it('starts a download with the Server\'s transfer, and reads the verified file of a preview', async () => {
    const transfer = { transferId: 'tr_1', token: 'tk_1', path: '/api/v3/device/transfers/tr_1' }
    expect((await device.request('POST', `/connectors/${DEVICE}/fs/read?root=${encodeURIComponent(device.root)}`, { path: 'notes/a.txt' })).status).toBe(409)
    const read = await device.request('POST', `/connectors/${DEVICE}/fs/read?root=${encodeURIComponent(device.root)}`, { path: 'notes/a.txt' }, { server: { transfer } })
    expect(read.body).toMatchObject({ ok: true, result: { name: 'a.txt', size: 6, transferId: 'tr_1', token: 'tk_1', downloadUrl: `/api/v2/connectors/${DEVICE}/fs/transfers/tr_1?token=tk_1` } })
    expect(device.uploads).toEqual([expect.objectContaining({ transferId: 'tr_1', token: 'tk_1', uploadUrl: '/api/v3/device/transfers/tr_1', path: join(device.root, 'notes', 'a.txt') })])
    // Preview reads come as `fs/readText` / `fs/read` with the verified file in `server.preview`, which wins over the body.
    const verified = { preview: { root: device.root, path: join(device.root, 'notes', 'a.txt') } }
    const preview = await device.request('POST', `/connectors/${DEVICE}/fs/readText?root=${encodeURIComponent(device.root)}`, { path: 'other.txt', maxBytes: 2 }, { server: verified })
    expect(preview.body).toMatchObject({ content: 'he', truncated: true, path: join(device.root, 'notes', 'a.txt') })
    const previewRead = await device.request('POST', `/connectors/${DEVICE}/fs/read?root=${encodeURIComponent(device.root)}`, { path: 'other.txt' }, { server: { ...verified, transfer: { ...transfer, transferId: 'tr_2' } } })
    expect(previewRead.body).toMatchObject({ ok: true, result: { name: 'a.txt', size: 6, transferId: 'tr_2' } })
    expect((await device.request('POST', '/connectors/fs/preview/readText', { previewAccessToken: 'x' })).status).toBe(404)
  })
})

describe('terminals', () => {
  it('serves the v1 routes from the same terminals, with the Server\'s labels and scope', async () => {
    const base = `/connectors/${DEVICE}/terminals`
    const first = await device.request('POST', `${base}?root=${encodeURIComponent(device.root)}`, { cols: 80, rows: 24, shell: '/bin/zsh' })
    const second = await device.request('POST', `${base}?root=${encodeURIComponent(device.root)}`, { shell: '/bin/zsh', cwd: 'notes' })
    expect(first.body).toMatchObject({ terminal: { label: 'zsh', root: device.root, cwd: device.root, status: 'running' } })
    expect(second.body).toMatchObject({ terminal: { label: 'zsh 2', cwd: join(device.root, 'notes') } })
    const id = (first.body as { terminal: { terminalId: string } }).terminal.terminalId
    expect(((await device.request('GET', base)).body as { terminals: unknown[] }).terminals).toHaveLength(2)
    expect((await device.request('PATCH', `${base}/${id}`, { label: 'build' })).body).toMatchObject({ terminal: { label: 'build' } })
    expect((await device.request('POST', `${base}/${id}/resize`, { cols: 100, rows: 30 })).body).toMatchObject({ terminal: { cols: 100, rows: 30 } })
    expect((await device.request('DELETE', `${base}/${id}`)).body).toMatchObject({ terminal: { terminalId: id, label: 'build' } })
    expect((await device.request('DELETE', `${base}/${id}`)).status).toBe(404)
    // The v2 routes see the same terminals.
    expect(((await device.request('GET', `/connectors/${DEVICE}/terminals-v2`)).body as { result: { terminals: unknown[] } }).result.terminals).toHaveLength(1)
  })

  it('roots session terminals at the session\'s directory and keeps them to the session', async () => {
    await device.start(S, join(device.root, 'notes'))
    const created = await device.request('POST', at('/terminals'), { cols: 80, rows: 24 })
    expect(created.body).toMatchObject({ terminal: { sessionId: S, root: join(device.root, 'notes'), label: 'Shell' } })
    const id = (created.body as { terminal: { terminalId: string } }).terminal.terminalId
    expect(((await device.request('GET', at('/terminals'))).body as { terminals: unknown[] }).terminals).toHaveLength(1)
    // Not a terminal of the device's browse scope.
    expect((await device.request('PATCH', `/connectors/${DEVICE}/terminals/${id}`, { label: 'x' })).status).toBe(404)
  })

  it('answers a missing terminal with 404 on v2 relay routes', async () => {
    const missing = await device.request('POST', `/connectors/${DEVICE}/terminals-v2/trm_none/write`, { dataBase64: 'aGk=' })
    expect(missing.status).toBe(404)
    expect(detail(missing.body)).toEqual({ code: 'terminal_not_found', message: 'terminal not found' })
  })
})

describe('Runtime catalogs', () => {
  it('serves an instance\'s own catalogs and no commands; an unknown instance is 404', async () => {
    const models = await device.request('GET', `/connectors/${DEVICE}/runtimes/${RUNTIME}/catalogs/model`)
    expect(models.body).toMatchObject({ catalog: { runtime: 'opencode', models: [{ id: 'm1' }, { id: 'm2' }] } })
    expect((await device.request('GET', `/connectors/${DEVICE}/runtimes/${RUNTIME}/commands`)).body).toMatchObject({ commands: [] })
    expect((await device.request('GET', `/connectors/${DEVICE}/runtimes/rt_none/catalogs/permission`)).status).toBe(404)
  })

  it('answers a session catalog of a session not open here as empty', async () => {
    await device.start(S)
    const permissions = await device.request('GET', at('/runtime/catalogs/permission'))
    expect(permissions.body).toMatchObject({ catalog: { runtime: 'opencode', permissions: [] } })
  })
})

describe('the Agent session behind a session', () => {
  const W = `/runtime-workflows/sessions/${S}`

  it('reads the Agent options without takeover and applies them with it, once per operation', async () => {
    await device.start(S)
    const read = await device.request('GET', `${W}/configuration`, undefined, { server: { takeover: false } })
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    const view = read.body as { configuration: { revision: number; options: { id: string }[] }; ownerGeneration: string; actions: unknown[] }
    expect(view.configuration.options.map(option => option.id)).toEqual(['model', 'permission'])
    expect(view.ownerGeneration).toBe('native-1')
    expect(view.actions).toEqual([])
    const body = { operationId: 'op_cfg', expectedRevision: view.configuration.revision, values: { model: 'm2' } }
    const readOnly = await device.request('POST', `${W}/configuration`, body, { server: { takeover: false } })
    expect(readOnly.status).toBe(409)
    expect(detail(readOnly.body).code).toBe('session_read_only')
    const updated = await device.request('POST', `${W}/configuration`, body)
    expect(updated.status, JSON.stringify(updated.body)).toBe(200)
    expect(updated.body).toMatchObject({ operationId: 'op_cfg', phase: 'completed', configuration: { options: [{ id: 'model', currentValue: 'm2' }, { id: 'permission' }] } })
    const configures = device.sessions[0]!.calls.filter(call => call.method === 'configure').length
    // The operation id is the receipt: a retry replays it.
    expect((await device.request('POST', `${W}/configuration`, body)).body).toEqual(updated.body)
    expect(device.sessions[0]!.calls.filter(call => call.method === 'configure')).toHaveLength(configures)
    const stale = await device.request('POST', `${W}/configuration`, { ...body, operationId: 'op_cfg2' })
    expect(stale.status).toBe(409)
    expect(detail(stale.body).code).toBe('configuration_changed')
  })

  it('answers Agent operations and the session tree the Agent does not offer with 409', async () => {
    await device.start(S)
    const operation = await device.request('POST', `${W}/operations`, { operation: 'resources.get', operationId: 'op_res', expectedGeneration: 'native-1', values: {} }, { server: { takeover: false } })
    expect(operation.status).toBe(409)
    expect(detail(operation.body).code).toBe('agent_capability_unsupported')
    const write = await device.request('POST', `${W}/operations`, { operation: 'session.fork', operationId: 'op_fork', expectedGeneration: 'native-1', values: {} }, { server: { takeover: false } })
    expect(detail(write.body).code).toBe('session_read_only')
    const tree = await device.request('GET', `${W}/tree`)
    expect(tree.status).toBe(409)
    expect(detail(tree.body)).toEqual({ code: 'capability_unavailable', message: 'session capability is unavailable: session.execution_position.read' })
    const position = await device.request('POST', `${W}/position`, { fileEntriesDigest: 'd', sourceEpoch: 'e', positionRevision: 0, leafId: null })
    expect(position.status).toBe(409)
  })

  it('releases the Agent session, then reopens it on recovery', async () => {
    await device.start(S)
    const stale = await device.request('POST', `${W}/close`, { ownerGeneration: 'native-0', closeOperationId: 'x' })
    expect(stale.status).toBe(409)
    expect(detail(stale.body).code).toBe('owner_changed')
    const closed = await device.request('POST', `${W}/close`, { ownerGeneration: 'native-1', closeOperationId: 'x' })
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    expect(closed.body).toEqual({ closed: true })
    expect(device.sessions[0]!.calls.at(-1)).toEqual({ method: 'close' })
    const recovered = await device.request('POST', `${W}/recover`, { operationId: 'op_rec', expectedGeneration: 'native-1' })
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(202)
    expect(recovered.body).toMatchObject({ operationId: 'op_rec', phase: 'completed', state: { sessionId: S } })
    expect(device.sessions).toHaveLength(2)
    expect((await device.request('POST', `${W}/recover`, { operationId: 'op_rec2', expectedGeneration: 'native-1' }, { server: { takeover: false } })).status).toBe(409)
    expect((await device.request('GET', `${W}/unknown`)).status).toBe(404)
  })
})
