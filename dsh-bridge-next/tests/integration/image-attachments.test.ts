import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SessionId } from '@deepseek-ai/dsh-session'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { corruptHistory } from '../fixtures/corrupt-history.js'
import { mountAgents, TextAdapter, initialSelections } from '../fixtures/agent-runtime.js'
import { RuntimeRouter } from '../../src/host/dsh-runtime/router.js'
import { RuntimeAttachments, parseAttachments, IMAGE_MIME_TYPES } from '../../src/host/dsh-runtime/attachments.js'
import { NativeRuntime } from '../../src/host/dsh-runtime/native.js'
import { projectHistory } from '../../src/host/dsh-runtime/history.js'
import { nativeSessionId, sessionId } from '../../src/host/dsh-runtime/identity.js'
import { SyncFeed, type SyncBatch } from '../../src/host/dsh-runtime/sync.js'
import { modelSelectionId } from '../../src/host/dsh-runtime/selections.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=', 'base64')

class VisionAdapter extends TextAdapter {
  override async resolveModel(provider: string, model: string) {
    return { ...await super.resolveModel(provider, model), inputModalities: model === 'text-only' ? ['text' as const] : ['text' as const, 'image' as const] }
  }
}

async function until(check: () => boolean) {
  for (let n = 0; n < 500; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), 'expected event was not emitted')
}

async function stage(images: RuntimeAttachments, data = png, fileId = 'file_image') {
  await images.initialize()
  const uploadId = randomUUID().replaceAll('-', '')
  await writeFile(join(images.staging, uploadId), data, { flag: 'wx', mode: 0o600 })
  return { uploadId, fileId, name: 'image.png', mediaType: 'image/png' as const,
    size: data.length, sha256: createHash('sha256').update(data).digest('hex') }
}

test('official image admission, image-only create, retries and cold history preserve AA attachments', { timeout: 40_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-images-'))
  const adapter = new VisionAdapter()
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter), 'img-')
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const router = new RuntimeRouter({ native, query: fixture.ctx.sessionQuery, status: id => native.status(id) }, 'images')
  const batches: SyncBatch[] = [], failures: unknown[] = []
  const feed = new SyncFeed(native, 'images', batch => { batches.push(batch); queueMicrotask(() => feed.ack(batch.batchSeq)) }, error => failures.push(error))
  let reopened: NativeRuntime | undefined
  try {
    const capability = (await native.capabilities()).capabilities.find(item => item.capabilityId === 'runtime.attachment')!
    assert.equal(capability.available, true)
    assert.equal(capability.metadata?.allowedMimeTypes, undefined)
    feed.start()
    const image = await stage(native.attachments)
    const params = { sessionId: 'sess_image', clientMessageId: 'image-message', content: '', cwd: home, agentPreset: 'standard', selections: initialSelections, attachments: [image] }
    const result = await router.request('session.createAndStart', params, new AbortController().signal) as { accepted: boolean }
    assert.equal(result.accepted, true, JSON.stringify(result))
    await until(() => adapter.requests.length === 1)
    const id = SessionId(nativeSessionId('images', 'sess_image'))
    const user = fixture.ctx.sessions.get(id)!.snapshotEvents().find(event => event.type === 'user/message')!
    assert.equal(user.type, 'user/message')
    if (user.type !== 'user/message') throw new Error('missing message')
    const block = user.data.content.find(part => part.type === 'image')!
    assert.equal(block.type, 'image')
    if (block.type !== 'image') throw new Error('missing image')
    assert.ok((await fixture.ctx.attachments.readImage(block.attachment)).data.length > 0)
    const modelMessage = adapter.requests[0]!.messages.find(message => message.role === 'user' && message.content.some(part => part.type === 'image'))
    assert.ok(modelMessage, 'the real agent loop receives an image block')
    await rm(join(native.attachments.staging, image.uploadId))
    assert.equal((await router.request('session.createAndStart', params, new AbortController().signal) as { accepted: boolean }).accepted, true)
    assert.equal(adapter.requests.length, 1, 'lost acknowledgement does not send twice')
    adapter.release?.()
    await until(() => native.status(id) === 'idle')
    const expected = projectHistory(await native.read(id), 'sess_image').find(item => item.role === 'user')!
    assert.equal(expected.content.text, '')
    assert.equal((expected.content.attachments as { fileId: string }[])[0]!.fileId, 'file_image')
    await until(() => JSON.stringify(batches).includes('file_image'))
    assert.deepEqual(failures, [])
    // Reopen Bridge bookkeeping and query the official persisted session after deleting staging.
    await fixture.ctx.sessions.flush(fixture.ctx.sessions.get(id)!)
    reopened = new NativeRuntime(fixture.ctx, join(home, 'agents-anywhere/bridge/create-intents'))
    const cold = projectHistory(await reopened.read(id), 'sess_image').find(item => item.role === 'user')!
    assert.deepEqual(cold, expected)
    assert.equal(JSON.stringify(projectHistory(await reopened.read(id), sessionId('another-account', id))).includes('file_image'), false)
    const image2 = await stage(native.attachments, png, 'file_second')
    assert.equal((await router.request('session.startTurn', { sessionId: 'sess_image', externalSessionId: id,
      clientMessageId: 'followup', content: '看看这张图', attachments: [image2] }, new AbortController().signal) as { accepted: boolean }).accepted, true)
    await until(() => adapter.requests.length === 2)
    adapter.release?.()
    await until(() => native.status(id) === 'idle')
    assert.equal(projectHistory(await native.read(id), 'sess_image').filter(item => item.role === 'user').length, 2)
  } finally {
    feed.close(); router.close(); adapter.release?.(); await reopened?.close()
    await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true })
  }
})

test('unsupported types, forged bytes and unsafe staging never enqueue a user message', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-image-refusal-'))
  const adapter = new VisionAdapter()
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter), 'refuse-')
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const router = new RuntimeRouter({ native, query: fixture.ctx.sessionQuery, status: id => native.status(id) }, 'images')
  try {
    const good = await stage(native.attachments)
    for (const mediaType of ['invalid', '*/*', 'text/plain; charset=utf-8']) {
      assert.throws(() => parseAttachments([{ ...good, mediaType }]), /Invalid attachment media type/)
    }
    assert.throws(() => parseAttachments([{ ...good, uploadId: '../outside' }]), /Invalid/)
    await assert.rejects(native.attachments.prepare([{ ...good, sha256: '0'.repeat(64) }], fixture.ctx.attachments, new AbortController().signal), /content does not match/)
    if (process.platform !== 'win32') {
      const linked = { ...good, uploadId: randomUUID().replaceAll('-', '') }
      await symlink(join(native.attachments.staging, good.uploadId), join(native.attachments.staging, linked.uploadId))
      await assert.rejects(native.attachments.prepare([linked], fixture.ctx.attachments, new AbortController().signal), /symbolic links/)
    }
    const fake = await stage(native.attachments, Buffer.from('not a PNG'), 'file_fake')
    const result = await router.request('session.createAndStart', { sessionId: 'sess_reject', content: 'test',
      clientMessageId: 'refused', cwd: home, agentPreset: 'standard', selections: initialSelections, attachments: [good, fake] }, new AbortController().signal) as { ok: boolean, code: string }
    assert.equal(result.ok, false)
    assert.equal(result.code, 'INVALID_PARAMS')
    const id = SessionId(nativeSessionId('images', 'sess_reject'))
    assert.equal(fixture.ctx.sessions.get(id)?.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'agent/inbox/spliced'), false)
    assert.equal(adapter.requests.length, 0)
    assert.equal((await readFile(join(native.attachments.staging, good.uploadId))).length, png.length)
  } finally { router.close(); adapter.release?.(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('official admission refuses images for a text-only model with an actionable error', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-image-model-'))
  const adapter = new VisionAdapter()
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const router = new RuntimeRouter({ native, query: fixture.ctx.sessionQuery, status: id => native.status(id) }, 'images')
  try {
    const image = await stage(native.attachments)
    const result = await router.request('session.createAndStart', {
      sessionId: 'sess_text_model', content: '', clientMessageId: 'no-vision', cwd: home, agentPreset: 'standard',
      selections: { ...initialSelections, model: modelSelectionId({ provider: 'test', model: 'text-only' }) },
      attachments: [image],
    }, new AbortController().signal) as { ok: boolean, code: string, message: string }
    assert.equal(result.ok, false)
    assert.equal(result.code, 'INVALID_PARAMS')
    assert.match(result.message, /Choose an image-capable model/)
    assert.equal(adapter.requests.length, 0)
    const session = fixture.ctx.sessions.get(SessionId(nativeSessionId('images', 'sess_text_model')))!
    assert.equal(session.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'agent/inbox/spliced'), false)
  } finally { router.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('real Python Connector sends images and text with corrupt history present, including a cold restart', { timeout: 40_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-image-wire-'))
  const adapter = new VisionAdapter()
  const fixture = await nativeRuntime(home, async ctx => { await corruptHistory(ctx, home); await mountAgents(ctx, adapter) })
  const release = setInterval(() => adapter.release?.(), 10)
  try {
    await writeFile(join(home, 'input.png'), png)
    const { stdout } = await promisify(execFile)('uv', ['run', '--frozen', 'python', 'tests/dsh_image_probe.py', home, JSON.stringify(initialSelections)], {
      cwd: new URL('../../../connector/', import.meta.url), timeout: 30_000,
    })
    assert.match(stdout, /DSH image integration passed/)
    assert.equal(adapter.requests.length, 2, 'image retry is deduplicated and the text followup still runs')
    const id = SessionId(nativeSessionId('image-wire', 'sess_python_image'))
    await fixture.ctx.agents.get(id)!.whenIdle()
    await fixture.ctx.sessions.flush(fixture.ctx.sessions.get(id)!)
    await fixture.ctx.fiber.dispose()
    const restarted = await nativeRuntime(home, ctx => mountAgents(ctx, new VisionAdapter()), 'restarted-')
    try {
      assert.equal(restarted.ctx.agents.get(id), undefined)
      await restarted.ctx.agentsAnywhereRuntime.native.inventory()
      const timeline = projectHistory(await restarted.ctx.agentsAnywhereRuntime.native.read(id), 'sess_python_image')
      assert.equal((timeline.find(item => item.role === 'user')!.content.attachments as { fileId: string }[])[0]!.fileId, 'file_wire')
      assert.equal(restarted.ctx.agents.get(id), undefined, 'cold history does not resume the Agent')
    } finally { await restarted.ctx.fiber.dispose() }
  } finally {
    clearInterval(release); adapter.release?.(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true })
  }
})


test('platform files stream into an official new session, mix with images and survive retry and history reload', { timeout: 40_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-files-'))
  const adapter = new VisionAdapter()
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter), 'file-')
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const router = new RuntimeRouter({ native, query: fixture.ctx.sessionQuery, status: id => native.status(id) }, 'files')
  try {
    const content = Buffer.alloc(2 * 1024 * 1024, 65)
    const file = { ...await stage(native.attachments, content, 'file_document'), name: 'notes.txt', mediaType: 'text/plain' }
    const image = await stage(native.attachments)
    const params = { sessionId: 'sess_files', clientMessageId: 'files-message', content: '', cwd: home,
      agentPreset: 'standard', selections: initialSelections, attachments: [file, image] }
    const result = await router.request('session.createAndStart', params, new AbortController().signal) as { accepted: boolean }
    assert.equal(result.accepted, true, JSON.stringify(result))
    await until(() => adapter.requests.length === 1)
    const id = SessionId(nativeSessionId('files', 'sess_files'))
    const users = () => fixture.ctx.sessions.get(id)!.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const event = users()[0]!
    if (event.type !== 'user/message') throw new Error('missing message')
    const block = event.data.content.find(part => part.type === 'file')!
    assert.equal(block.type, 'file')
    if (block.type !== 'file') throw new Error('missing file')
    const chunks: Buffer[] = []
    for await (const chunk of fixture.ctx.attachments.readFileStream(block.attachment)) chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), content)
    assert.ok(event.data.content.some(part => part.type === 'image'))
    await rm(join(native.attachments.staging, file.uploadId))
    await rm(join(native.attachments.staging, image.uploadId))
    const retry = await router.request('session.createAndStart', params, new AbortController().signal) as { accepted: boolean }
    assert.equal(retry.accepted, true, JSON.stringify(retry))
    assert.equal(users().length, 1)
    const projected = projectHistory(await native.read(id), 'sess_files').find(item => item.role === 'user')!
    assert.deepEqual((projected.content.attachments as { fileId: string }[]).map(file => file.fileId), ['file_document', 'file_image'])
    adapter.release?.()
    const corrupt = { ...await stage(native.attachments, content, 'file_corrupt'), mediaType: 'application/pdf', sha256: '0'.repeat(64) }
    await assert.rejects(native.attachments.prepare([corrupt], fixture.ctx.attachments, new AbortController().signal,
      { service: fixture.ctx.fileUploads, sessionId: id }), /Unable to persist attachment/)
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(native.attachments.prepare([corrupt], fixture.ctx.attachments, abort.signal,
      { service: fixture.ctx.fileUploads, sessionId: id }), { name: 'AbortError' })
    assert.equal(users().length, 1)
  } finally { router.close(); adapter.release?.(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
