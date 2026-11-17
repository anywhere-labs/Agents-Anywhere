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

  it('answers a notice that is gone with ok: false, and needs the approval capability', async () => {
    await device.start(S)
    expect((await device.request('POST', at('/runtime/notices/nope/respond'), { actionId: 'allow' })).body).toEqual({ ok: false, result: null, error: { code: 'interaction_not_found', message: 'interaction not found' } })
    expect((await device.request('POST', at('/runtime/notices/nope/respond'), {})).status).toBe(422)
    expect((await device.request('POST', at('/runtime/notices/nope/respond'), { actionId: 'allow' }, { server: { takeover: false } })).status).toBe(409)
  })
})

describe('slash commands', () => {
  beforeEach(async () => {
    device.commands.observe('runtime.status', { sessionId: S, status: { event: 'commands.updated', fact: { commands: [{ name: 'review', description: 'Review', inputHint: 'path' }] } } })
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

  it('lists the drives for an empty path on Windows', async () => {
    const windows = await testDevice({ platform: 'win32' })
    try {
      const listed = await windows.request('POST', `/connectors/${DEVICE}/fs/list`, { root: 'C:\\repo', path: '' })
      expect(listed.body).toMatchObject({ ok: true, result: { path: '', targetPath: '' } })
    } finally {
      await windows.close()
    }
  })

  it('starts a download with the Server\'s transfer, and serves preview reads only for a verified token', async () => {
    const transfer = { transferId: 'tr_1', token: 'tk_1', path: '/api/v3/device/transfers/tr_1' }
    expect((await device.request('POST', `/connectors/${DEVICE}/fs/read?root=${encodeURIComponent(device.root)}`, { path: 'notes/a.txt' })).status).toBe(409)
    const read = await device.request('POST', `/connectors/${DEVICE}/fs/read?root=${encodeURIComponent(device.root)}`, { path: 'notes/a.txt' }, { server: { transfer } })
    expect(read.body).toMatchObject({ ok: true, result: { name: 'a.txt', size: 6, transferId: 'tr_1', token: 'tk_1', downloadUrl: `/api/v2/connectors/${DEVICE}/fs/transfers/tr_1?token=tk_1` } })
    expect(device.uploads).toEqual([expect.objectContaining({ transferId: 'tr_1', token: 'tk_1', uploadUrl: '/api/v3/device/transfers/tr_1', path: join(device.root, 'notes', 'a.txt') })])
    expect((await device.request('POST', '/connectors/fs/preview/readText', { previewAccessToken: 'x' })).status).toBe(400)
    const preview = await device.request('POST', '/connectors/fs/preview/readText', { previewAccessToken: 'x', maxBytes: 2 }, { server: { preview: { root: device.root, path: join(device.root, 'notes', 'a.txt') } } })
    expect(preview.body).toMatchObject({ content: 'he', truncated: true })
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
